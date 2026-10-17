// The Corredor agent: the local model reads payouts and the rules engine's results,
// explains them with sources, and prepares actions. It decides nothing.
//
// Guardrails, enforced here in code (not just asked for in the prompt):
// - Tools are read-only, plus propose_action, which only returns a proposal
//   for a person to confirm. There is no tool that approves, pays or changes
//   a rule, so the model can't do those things whatever it says.
// - Proposals are checked against the payout's real status before they reach
//   the queue (no "pay" for an unapproved payout).
// - Bank and tax identifiers are masked to the last four digits in every tool
//   result, and any long digit run in the final text is masked again.
// - Citation guard: rule ids in the answer must exist in the pack; made-up
//   ones are marked and reported.

import type { AgentProposal, AgentReply, AgentTurn, PayoutDetail, Rule } from "../contracts";
import { AgentActionKind, IsoDate } from "../contracts";
import { isActive, reference, routeLabel, warningCount } from "../corredor";
import { listPayoutDetails, previewPlan } from "../services/payouts";
import { getDemoAsOf, getSettings } from "../services/settings";
import { db } from "../db";
import { type ChatMessage, type LlmProvider, type ToolSpec, getProvider } from "./provider";

const MAX_ROUNDS = 6;
const RULE_ID = /\b(?:BR|MX|AR|VE|CO)-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/g;

// ---- Masking -------------------------------------------------------------------------

export const maskId = (v: string | null | undefined): string | null => {
  if (!v) return null;
  const tail = v.replace(/[^0-9A-Za-z]/g, "").slice(-4);
  return `ending ${tail}`;
};

/** Mask any run of 8+ digits (account numbers, CLABEs, CVUs, CNPJs) to its last four. */
export const maskDigits = (text: string) =>
  text.replace(/\d[\d .\-/]{6,}\d/g, (m) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(m.trim())) return m; // a date, not an account
    const digits = m.replace(/\D/g, "");
    return digits.length >= 8 ? `••••${digits.slice(-4)}` : m;
  });

// ---- Compact views for the model ---------------------------------------------------------

const money = (n: number, cur: string) => `${cur} ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const short = (s: string, n = 220) => (s.length > n ? `${s.slice(0, n)}…` : s);

const STATUS_TEXT: Record<PayoutDetail["status"], string> = {
  draft: "not planned yet",
  needs_info: "needs information before it can be approved",
  blocked: "blocked: cannot be approved or paid",
  awaiting_second_approver: "waiting for approval (two different approvers needed)",
  ready: "ready for approval (one approver needed)",
  approved: "approved, ready to pay",
  rejected: "rejected, will not be paid",
  paid: "paid, ready to reconcile",
  booked: "booked in the ledger, done",
};

const usd = (n: number) => `USD ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function summary(p: PayoutDetail) {
  const warnings = p.plan ? (p.plan.evaluations.find((e) => e.route.id === p.plan!.recommended?.id)?.results ?? []).filter((r) => r.outcome === "warn").map((r) => r.ruleId) : [];
  return {
    payout: p.payeeName,
    country: p.country,
    invoice: p.invoice.invoiceNumber,
    amount: p.currency === "USD" ? usd(p.amountLocal) : `${money(p.amountLocal, p.currency)} (${usd(p.amountUsd)})`,
    status: STATUS_TEXT[p.status],
    route: p.plan?.recommended ? routeLabel(p.plan.recommended) : "none (no compliant route)",
    ...(p.status === "blocked" || p.status === "needs_info" ? { why: short(p.plan?.reasons[0] ?? "", 160) } : {}),
    warnings,
    approvedBy: p.approvals.map((a) => a.approver),
  };
}

function detail(p: PayoutDetail) {
  const plan = p.plan;
  const rec = plan?.evaluations.find((e) => e.route.id === plan.recommended?.id);
  return {
    ...summary(p),
    id: p.id,
    invoiceFields: {
      dueDate: p.invoice.dueDate,
      description: p.invoice.description,
      purposeCode: p.invoice.purposeCode,
      taxId: maskId(p.invoice.payeeTaxId),
      bank: p.invoice.bankId ? `${p.invoice.bankId.type} ${maskId(p.invoice.bankId.value)}` : null,
      lowConfidenceFields: p.invoice.lowConfidence,
    },
    planAsOf: plan?.asOf ?? null,
    screening: plan?.screening ?? null,
    reasons: plan?.reasons.map((r) => short(r)) ?? [],
    routes: (plan?.evaluations ?? []).map((e) => ({
      route: routeLabel(e.route),
      feeUsd: e.route.feeUsd,
      minutes: e.route.minutes,
      compliant: e.compliant,
      blockedBy: e.results.filter((r) => r.outcome === "block" || r.outcome === "require_fields").map((r) => `${r.ruleId}: ${r.title}`),
    })),
    rulesOnRecommendedRoute: (rec?.results ?? []).map((r) => ({ rule: r.ruleId, title: r.title, outcome: OUTCOME[r.outcome], message: short(r.message) })),
    memo: p.memo ? { summary: p.memo.summary, rationale: p.memo.routeRationale, humanChecks: p.memo.humanChecks } : null,
    paid: p.payment ? { railMode: p.payment.railMode } : null,
    fingerprint: p.fingerprint ?? null,
  };
}

const OUTCOME = {
  pass: "passes (does not block this route)",
  warn: "WARNING (route allowed, a person must acknowledge it)",
  block: "BLOCKS this route",
  require_fields: "BLOCKS until required fields are provided",
} as const;

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Find a payout by id, country code, invoice number or (part of) the payee's name. */
export function resolvePayout(ref: unknown, all: PayoutDetail[]): PayoutDetail | undefined {
  if (typeof ref !== "string" || !ref.trim()) return undefined;
  const r = ref.trim();
  return (
    all.find((p) => p.id === r) ??
    all.find((p) => p.country === r.toUpperCase()) ??
    all.find((p) => p.invoice.invoiceNumber.toLowerCase() === r.toLowerCase()) ??
    all.find((p) => fold(p.payeeName).includes(fold(r))) ??
    all.find((p) => fold(r).includes(fold(p.payeeName.split(" ")[0]!)))
  );
}

// ---- Tools ------------------------------------------------------------------------------

const PAYOUT = { type: "string", description: "Payee name (or part of it), country code (BR, MX, AR, VE), invoice number or payout id." };

export const TOOLS: ToolSpec[] = [
  { name: "list_payouts", description: "Every payout with its status, recommended route, warnings and approvals.", parameters: { type: "object", properties: {} } },
  {
    name: "get_payout",
    description: "One payout in detail: invoice fields (identifiers masked), every candidate route and what blocks it, the rules checked on the recommended route, the memo and approvals.",
    parameters: { type: "object", properties: { payout: PAYOUT }, required: ["payout"] },
  },
  {
    name: "preview_plan",
    description: "Dry run: what the rules engine would decide for this payout on another as-of date. Changes nothing.",
    parameters: { type: "object", properties: { payout: PAYOUT, as_of: { type: "string", description: "YYYY-MM-DD" } }, required: ["payout", "as_of"] },
  },
  {
    name: "list_rules",
    description: "The rules pack: id, country, title, effective dates, outcome and source. By default only the rules in force on the current as-of date.",
    parameters: { type: "object", properties: { all: { type: "boolean", description: "true for the whole pack, including rules not yet or no longer in force" } } },
  },
  { name: "get_policy", description: "Approval policy (second-approver threshold, daily cap), routing preference and provider switches.", parameters: { type: "object", properties: {} } },
  {
    name: "propose_action",
    description:
      "Queue an action for a person to confirm. You cannot perform any action yourself. Kinds: approve (payout must be ready or awaiting a second approver), pay (must be approved), reconcile (must be paid), email (a draft to the vendor; give email_body), asof (move the demo clock; give as_of).",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: AgentActionKind.options },
        payout: PAYOUT,
        title: { type: "string", description: "Short card title, e.g. 'Approve Estúdio Paulista'" },
        why: { type: "string", description: "One or two sentences: why a person should do this" },
        email_body: { type: "string", description: "For kind=email: the full email, starting with 'Subject:'. Mask account numbers to the last four digits." },
        as_of: { type: "string", description: "For kind=asof: YYYY-MM-DD" },
        cites: { type: "array", items: { type: "string" }, description: "Rule ids that justify it" },
      },
      required: ["kind", "title", "why"],
    },
  },
];

const RISK: Record<AgentActionKind, AgentProposal["risk"]> = { approve: "High", pay: "High", reconcile: "Medium", email: "Medium", asof: "Low" };

interface Ctx {
  asOf: string;
  rules: Rule[];
  payouts: () => Promise<PayoutDetail[]>;
  proposals: AgentProposal[];
}

/** Run one tool. Errors come back as text so the model can correct itself. */
export async function runTool(name: string, args: Record<string, unknown>, c: Ctx): Promise<string> {
  const all = await c.payouts();
  const need = () => {
    const p = resolvePayout(args.payout, all);
    if (!p) throw new Error(args.payout ? `No payout matches "${String(args.payout)}". Known payees: ${all.map((x) => x.payeeName).join("; ")}.` : `The "payout" field is required: name one payee (${all.map((x) => x.payeeName).join("; ")}). Call propose_action once per payout.`);
    return p;
  };
  switch (name) {
    case "list_payouts":
      return JSON.stringify({ asOf: c.asOf, count: all.length, payouts: all.map(summary) });
    case "get_payout":
      return JSON.stringify(detail(need()));
    case "preview_plan": {
      const p = need();
      const asOf = IsoDate.safeParse(args.as_of);
      if (!asOf.success) throw new Error("as_of must be a YYYY-MM-DD date.");
      const plan = await previewPlan(p.id, asOf.data);
      return JSON.stringify({
        payout: p.payeeName,
        asOf: plan.asOf,
        status: plan.status,
        recommended: plan.recommended ? routeLabel(plan.recommended) : null,
        currentRecommended: p.plan?.recommended ? routeLabel(p.plan.recommended) : null,
        frozen: p.approvals.length > 0 || ["approved", "paid", "booked", "rejected"].includes(p.status),
        routes: plan.evaluations.map((e) => ({ route: routeLabel(e.route), compliant: e.compliant, blockedBy: e.results.filter((r) => r.outcome === "block").map((r) => r.ruleId) })),
        reasons: plan.reasons.map((r) => short(r)),
      });
    }
    case "list_rules": {
      const rules = args.all ? c.rules : c.rules.filter((r) => isActive(r, c.asOf));
      return JSON.stringify(rules.map((r) => ({ id: r.id, country: r.corridor, title: r.title, from: r.effectiveFrom, to: r.effectiveTo, outcome: r.outcome, source: r.source.name })));
    }
    case "get_policy": {
      const s = await getSettings(db);
      return JSON.stringify({ policy: s.policy, routingPreference: s.objective, disabledProviders: s.disabledOfframps, registryUpdates: s.registry, rail: s.railMode });
    }
    case "propose_action": {
      const kind = AgentActionKind.safeParse(args.kind);
      if (!kind.success) throw new Error(`kind must be one of ${AgentActionKind.options.join(", ")}.`);
      const k = kind.data;
      let payoutId: string | null = null;
      let asOf: string | undefined;
      if (k === "asof") {
        const d = IsoDate.safeParse(args.as_of);
        if (!d.success) throw new Error("as_of (YYYY-MM-DD) is required for kind=asof.");
        asOf = d.data;
      } else {
        const p = need();
        payoutId = p.id;
        const ok =
          (k === "approve" && (p.status === "ready" || p.status === "awaiting_second_approver")) ||
          (k === "pay" && p.status === "approved" && !p.payment) ||
          (k === "reconcile" && p.status === "paid") ||
          k === "email";
        if (!ok) throw new Error(`Can't propose ${k} for ${p.payeeName}: its status is ${p.status}.`);
      }
      const body = typeof args.email_body === "string" ? maskDigits(args.email_body) : undefined;
      if (k === "email" && !body) throw new Error("email_body is required for kind=email.");
      if (c.proposals.some((x) => x.kind === k && x.payoutId === payoutId)) return "Already queued.";
      const known = new Set(c.rules.map((r) => r.id));
      c.proposals.push({
        kind: k,
        payoutId,
        risk: RISK[k],
        title: String(args.title ?? k).slice(0, 120),
        why: String(args.why ?? "").slice(0, 400),
        cites: Array.isArray(args.cites) ? args.cites.filter((x): x is string => typeof x === "string" && known.has(x)) : [],
        ...(body ? { body } : {}),
        ...(asOf ? { asOf } : {}),
      });
      return "Queued for a person to confirm. Nothing has happened yet.";
    }
    default:
      throw new Error(`Unknown tool ${name}.`);
  }
}

// ---- Prompt and loop --------------------------------------------------------------------

export function systemPrompt(asOf: string): string {
  return `You are the Corredor agent, inside an accounts-payable app that pays suppliers in Latin America (Brazil, Mexico, Argentina, Venezuela) in stablecoins. You help Maria Lopez, a controller.

How the app works: AI reads and explains, code decides, a person approves. A deterministic rules engine decides which routes are compliant on a given as-of date, using a rules pack where every rule has an id (like BR-561-EFX), effective dates and a source. People approve (two different people above the threshold), pay on a simulated rail and reconcile.

Your job: answer questions about payouts, routes, rules, savings and next steps, using the tools. Always look things up with a tool before stating a fact about a payout or a rule; never invent numbers, routes, statuses or rule ids.

Rules you must follow:
- You decide nothing and you can't act. Never say you approved, paid, booked, rejected or changed anything. When a step makes sense, call propose_action; a person confirms it in the queue.
- The rules engine's decision is final. Explain it; don't second-guess it or suggest getting around a block.
- Cite the rule ids that support what you say, exactly as the tools give them. Describe a rule only with its title and message from the tool result; do not guess what a rule means.
- A rule that "passes" did not block the route; say it was checked, not that the route "complies with" it. A WARNING means the route is allowed but a person must acknowledge it.
- Copy names, amounts and counts exactly from the tool results (list_payouts gives "count"). Use the status text as given.
- To prepare something for several payouts, call list_payouts, then call propose_action once per qualifying payout, naming it in the "payout" field. After proposing, say what is now waiting in the queue.
- Never write out bank account numbers, CLABEs, CVUs, Pix keys or tax ids in full. Use "ending 1234".
- The rail is simulated and the providers are fictional demo data; say so if it matters.
- The current as-of date is ${asOf}. "Today" means that date.

Style: short and plain. Lead with the answer, then a few bullets if useful. No headings, no markdown tables.`;
}

export interface AskOptions {
  turns: AgentTurn[];
  asOf?: string;
  provider?: LlmProvider;
}

export async function askAgent({ turns, asOf: asOfIn, provider = getProvider() }: AskOptions): Promise<AgentReply> {
  const started = performance.now();
  const asOf = asOfIn ?? (await getDemoAsOf(db));
  const rules = reference().rules;
  let cached: PayoutDetail[] | null = null;
  const ctx: Ctx = { asOf, rules, proposals: [], payouts: async () => (cached ??= await listPayoutDetails()) };

  const messages: ChatMessage[] = turns.map((t) => (t.role === "user" ? { role: "user", content: t.content } : { role: "assistant", content: t.content }));
  const toolLog: string[] = [];
  let text = "";

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await provider.chat(systemPrompt(asOf), messages, TOOLS);
    if (!res.toolCalls.length) {
      text = res.content;
      break;
    }
    messages.push({ role: "assistant", content: res.content, toolCalls: res.toolCalls });
    for (const call of res.toolCalls) {
      const shown = [call.args.payout, call.args.as_of, call.args.kind].filter((v) => typeof v === "string").map((v) => JSON.stringify(v)).join(", ");
      toolLog.push(`${call.name}(${shown})`);
      let out: string;
      try {
        out = await runTool(call.name, call.args, ctx);
      } catch (err) {
        out = `Error: ${(err as Error).message}`;
      }
      messages.push({ role: "tool", content: out, toolCallId: call.id, name: call.name });
    }
    if (round === MAX_ROUNDS - 1) text = res.content || "I ran out of steps before finishing. Try a narrower question.";
  }

  // Citation guard: keep real rule ids, mark made-up ones.
  const known = new Set(rules.map((r) => r.id));
  const mentioned = [...new Set(text.match(RULE_ID) ?? [])];
  const removed = mentioned.filter((id) => !known.has(id));
  for (const id of removed) text = text.replaceAll(id, `${id} [not in the rules pack]`);

  return {
    text: maskDigits(text.trim()) || "(no answer)",
    tools: toolLog,
    cites: mentioned.filter((id) => known.has(id)),
    removedCites: removed,
    actions: ctx.proposals,
    model: provider.model,
    ms: Math.round(performance.now() - started),
  };
}
