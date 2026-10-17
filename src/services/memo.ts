// POST /api/payouts/:id/memo: the local model writes the memo for the payout's
// current plan (ARCHITECTURE §8). It explains; it never decides.
//
// Citation guard, in code: the memo may cite only rules that appear in the
// plan's checks for the chosen route. A memo that cites anything else is
// rejected and retried once with the reason; if it fails again the template
// memo stays. The memo is stored per plan (same plan hash → same memo).

import { desc, eq } from "drizzle-orm";
import { Memo, type PayoutDetail } from "../contracts";
import { templateMemo } from "../corredor";
import { db, schema } from "../db";
import { ApiError, notFound } from "../http-error";
import { maskDigits } from "../llm/agent";
import { LlmUnavailableError, type LlmProvider, getProvider } from "../llm/provider";
import { appendAudit } from "./audit-log";
import { getPayout, isUuid, rowToInvoice } from "./payouts";

const { plans, memos, payouts, securityHolds } = schema;

const MEMO_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    routeRationale: { type: "string" },
    warnings: { type: "array", items: { type: "string" } },
    humanChecks: { type: "array", items: { type: "string" } },
    citedRuleIds: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "routeRationale", "warnings", "humanChecks", "citedRuleIds"],
};

const SYSTEM = `You write the approval memo for one supplier payout, for a controller who must approve it.
The rules engine has ALREADY decided. You explain its decision; you never change it, question it, or suggest a way around a block.
Write in plain English, short sentences:
- summary: one sentence: what is being paid, to whom, how much (copy the amount text exactly), and the decision.
- routeRationale: 2-3 sentences: why this route (cheapest compliant), which cheaper routes are blocked and by which rule, and the saving against a SWIFT wire if given.
- warnings: one line per warning, starting with the rule id.
- humanChecks: 1-3 concrete things a person should verify before approving.
- citedRuleIds: the rule ids you relied on. Use ONLY ids from "rulesChecked". Never invent a rule id.
Never write out bank account numbers or tax ids.
Never say the payout is approved, paid or rejected: only people decide that, and they haven't yet.`;

const DECISION: Record<string, string> = {
  ready: "compliant route found; waiting for a person to approve (NOT approved yet)",
  awaiting_second_approver: "compliant route found; needs two different approvers (NOT approved yet)",
  needs_info: "on hold: must not be paid until required fields arrive",
  blocked: "blocked: must NOT be paid; every route is blocked",
};
export async function writeMemo(id: string, provider: LlmProvider = getProvider()): Promise<PayoutDetail> {
  if (!isUuid(id)) throw notFound();
  const payout = await db.query.payouts.findFirst({ where: eq(payouts.id, id), with: { invoice: true } });
  if (!payout?.invoice) throw notFound();
  const planRow = await db.query.plans.findFirst({ where: eq(plans.payoutId, id), orderBy: [desc(plans.createdAt)], with: { memos: true } });
  if (!planRow) throw new ApiError(409, "no_plan", "This payout hasn't been planned yet.");
  if (planRow.memos.some((m) => m.generatedBy === "llm")) return getPayout(id); // already written for this exact plan

  const plan = planRow.plan;
  const invoice = rowToInvoice(payout.invoice);
  const holdRow = await db.query.securityHolds.findFirst({ where: eq(securityHolds.payoutId, id), orderBy: [desc(securityHolds.createdAt)] });
  const onHold = holdRow?.status === "active";
  const amountUsd = payout.amountUsd ?? plan.evaluations[0]?.route.amountUsd ?? 0;
  const target = plan.evaluations.find((e) => e.route.id === plan.recommended?.id) ?? plan.evaluations.find((e) => e.route.kind === "wire");
  const allowed = new Set((target?.results ?? []).map((r) => r.ruleId));
  const template = templateMemo({ invoice, plan, amountUsd });

  // Everything the model needs, nothing it doesn't (no identifiers).
  const facts = {
    payee: invoice.payeeName,
    country: invoice.payeeCountry,
    amount: `${invoice.currency} ${invoice.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}${invoice.currency === "USD" ? "" : ` (USD ${amountUsd.toLocaleString("en-US", { minimumFractionDigits: 2 })})`}`,
    description: invoice.description,
    asOf: plan.asOf,
    decision: onHold
      ? "on security hold: instruction-like text in the invoice was flagged and a person must review it before anything else; must NOT be paid yet"
      : DECISION[plan.status] ?? plan.status,
    securityHold: onHold ? `${holdRow!.findings.length} instruction-like line(s) were found in the invoice text and quoted for a person. The payout cannot be approved until someone clears the hold.` : undefined,
    recommendedRoute: plan.recommended ? template.routeRationale.split(" is the ")[0] : "none: every route is blocked",
    rulesChecked: (target?.results ?? []).map((r) => ({ id: r.ruleId, title: r.title, outcome: r.outcome, message: r.message.slice(0, 300) })),
    otherRoutes: plan.evaluations
      .filter((e) => e.route.id !== target?.route.id)
      .map((e) => ({ fee: `${e.route.feePct}%`, provider: e.route.offramp?.name ?? "SWIFT wire", compliant: e.compliant, blockedBy: e.results.filter((r) => r.outcome === "block").map((r) => r.ruleId) })),
    reasons: plan.reasons,
    templateRationale: template.routeRationale, // a correct, plain baseline to improve on
  };

  let feedback = "";
  let memo: Memo | null = null;
  for (let attempt = 0; attempt < 2 && !memo; attempt++) {
    let raw: unknown;
    try {
      raw = await provider.json(SYSTEM, `Payout facts (JSON):\n${JSON.stringify(facts)}${feedback}`, MEMO_SCHEMA);
    } catch (err) {
      if (err instanceof LlmUnavailableError) throw new ApiError(503, "llm_unavailable", err.message);
      throw err;
    }
    const parsed = Memo.safeParse(raw);
    if (!parsed.success || !parsed.data.summary.trim()) {
      feedback = "\n\nYour previous answer didn't match the format. Fill every field.";
      continue;
    }
    const bad = parsed.data.citedRuleIds.filter((r) => !allowed.has(r));
    const mentionedBad = [...`${parsed.data.summary} ${parsed.data.routeRationale} ${parsed.data.warnings.join(" ")}`.matchAll(/\b(?:BR|MX|AR|VE|CO)-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/g)].map((m) => m[0]).filter((r) => !allowed.has(r));
    // Decision guard: the memo can't claim a human decision or a payment that hasn't happened.
    const prose = `${parsed.data.summary} ${parsed.data.routeRationale}`.toLowerCase();
    const claimsPay = /\b(is being paid|will be paid|has been paid|is paid|are paying|we are paying|paying)\b/.test(prose);
    const claimsApproval = /\b(approved|has been approved)\b/.test(prose) && !/not (yet )?approved|needs? (two )?approv|waiting for/.test(prose);
    if ((plan.status === "blocked" || plan.status === "needs_info" || onHold) && claimsPay) {
      feedback = "\n\nRejected: the payout is blocked or on hold, so it is NOT being paid. Say it must not be paid, and why.";
      continue;
    }
    if (claimsApproval) {
      feedback = "\n\nRejected: nobody has approved this payout yet. Don't say it is approved.";
      continue;
    }
    if (bad.length || mentionedBad.length) {
      feedback = `\n\nRejected: you cited ${[...new Set([...bad, ...mentionedBad])].join(", ")}, which ${bad.length + mentionedBad.length > 1 ? "are" : "is"} not in rulesChecked. Cite only: ${[...allowed].join(", ")}.`;
      continue;
    }
    memo = {
      summary: maskDigits(parsed.data.summary),
      routeRationale: maskDigits(parsed.data.routeRationale),
      warnings: parsed.data.warnings.map(maskDigits),
      humanChecks: parsed.data.humanChecks.map(maskDigits),
      citedRuleIds: [...new Set(parsed.data.citedRuleIds.length ? parsed.data.citedRuleIds : [...allowed])],
    };
  }
  if (!memo) throw new ApiError(422, "memo_guard_failed", "The model's memo cited rules that aren't in the plan twice, so the template memo stays.");

  await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(memos)
      .values({ planId: planRow.id, planHash: planRow.planHash, ...memo, generatedBy: "llm", model: provider.model })
      .returning({ id: memos.id });
    await appendAudit(tx, { payoutId: id, type: "memo", payload: { planId: planRow.id, memoId: row!.id, model: provider.model, citedRuleIds: memo!.citedRuleIds } });
  });
  return getPayout(id);
}
