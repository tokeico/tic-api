// Template memo: the deterministic fallback that explains a Plan in plain
// language (ARCHITECTURE §8). The local model may write a nicer one live; this
// is what you get when it is down, and it can never disagree with the engine
// because it is built from the engine's own output. It explains, never decides.

import type { Invoice, Memo, Plan, RouteEvaluation } from "../contracts";
import { fmtMoney, fmtUsd } from "./util";

const lowerFirst = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

export interface MemoInput {
  invoice: Invoice;
  plan: Plan;
  /** USD value of the payout (policy amount). */
  amountUsd: number;
  /** Routing preference in force when the plan was made. */
  objective?: "cheapest" | "fastest" | "safest";
  /** Fields a person already reviewed, so low-confidence nags go away. */
  reviewed?: boolean;
}

const OBJECTIVE_WORD = { cheapest: "cheapest", fastest: "fastest", safest: "lowest-warning" } as const;

const prettyDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

const fieldLabel = (f: string) => (f === "bankId" ? "bank identifier" : f === "payeeTaxId" ? "tax ID" : f);

export function templateMemo({ invoice, plan, amountUsd, objective = "cheapest", reviewed = false }: MemoInput): Memo {
  const date = prettyDate(plan.asOf);
  const rec = plan.recommended;
  const wire = plan.evaluations.find((e) => e.route.kind === "wire");
  const local = fmtMoney(invoice.amount, invoice.currency);
  const money = invoice.currency === "USD" ? local : `${local} (${fmtUsd(amountUsd)})`;

  let summary: string;
  let routeRationale: string;
  if (rec) {
    summary = `Pay ${invoice.payeeName} ${money} for ${lowerFirst(invoice.description.replace(/\.$/, ""))}.`;
    routeRationale = `${routeText(plan.evaluations, rec.id)} is the ${OBJECTIVE_WORD[objective]} route that passes every active rule as of ${date}.`;
    for (const e of plan.evaluations) {
      if (e.route.kind !== "stablecoin" || e.compliant || e.route.feePct >= rec.feePct || !e.route.offramp) continue;
      const blocker = e.results.find((r) => r.outcome === "block" || r.outcome === "require_fields");
      if (blocker) routeRationale += ` ${e.route.offramp.name} (${e.route.feePct.toFixed(2)}%) is cheaper but blocked by ${blocker.ruleId}.`;
    }
    if (rec.kind !== "wire" && wire) {
      routeRationale += ` Against a SWIFT wire it saves ${fmtUsd(amountUsd * ((wire.route.feePct - rec.feePct) / 100))} and about two days.`;
    }
  } else if (plan.status === "needs_info") {
    summary = `Hold ${invoice.payeeName} (${local}) until the missing fields arrive.`;
    routeRationale = `No route can be used: ${plan.reasons.join(" ")}`;
  } else {
    summary = `Do not pay ${invoice.payeeName} (${local}). Every route is blocked as of ${date}.`;
    routeRationale =
      invoice.payeeCountry === "VE"
        ? "VE-OFAC blocks the wire and any stablecoin route until a named general license is recorded and a person signs off."
        : plan.reasons.length > 0
          ? plan.reasons.join(" ")
          : "Every candidate route fails at least one active rule.";
  }

  const target = plan.evaluations.find((e) => e.route.id === rec?.id) ?? wire;
  const results = target?.results ?? [];
  const warnings = results.filter((r) => r.outcome === "warn").map((r) => `${r.ruleId}: ${r.message}`);

  const humanChecks: string[] = [];
  if (invoice.payeeCountry === "BR") humanChecks.push("Confirm the purpose code matches the vendor's FX contract.");
  if (rec?.offramp?.type === "vasp_pending") {
    humanChecks.push(`${rec.offramp.name}'s authorization is still pending: confirm its status before paying.`);
  }
  if (invoice.payeeCountry === "MX") humanChecks.push("Second approver: confirm the CLABE against the vendor master file.");
  if (invoice.payeeCountry === "AR") humanChecks.push("Confirm the contractor accepts settlement at the rate shown.");
  if (invoice.payeeCountry === "VE") humanChecks.push("Record a named OFAC general license, or decline the payment.");
  if (!reviewed) for (const f of invoice.lowConfidence) humanChecks.push(`Re-check the ${fieldLabel(f)}: extraction confidence was low.`);

  return {
    summary,
    routeRationale,
    citedRuleIds: results.map((r) => r.ruleId),
    warnings,
    humanChecks,
  };
}

function routeText(evals: RouteEvaluation[], routeId: string): string {
  const r = evals.find((e) => e.route.id === routeId)?.route;
  if (!r) return routeId;
  if (r.kind === "wire") return `SWIFT wire (${r.feePct.toFixed(2)}%)`;
  const net = r.network ? r.network.charAt(0).toUpperCase() + r.network.slice(1) : "";
  return `${r.asset} · ${net} · ${r.offramp?.name} · ${r.feePct.toFixed(2)}%`;
}
