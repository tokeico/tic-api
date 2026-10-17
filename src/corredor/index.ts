// corredor-core: the deterministic compliance brain behind the API.
//
//   quote ──► screen ──► RULES ENGINE(asOf) ──► policy ──► rail ──► reconcile ──► journal
//                                                                  audit chain on every step
//
// Everything here is plain TypeScript over data. The LLM (src/llm) only
// extracts invoices and explains plans; it never decides. Route handlers
// should import from "./corredor" rather than reaching into submodules.

import type { Invoice, Plan, Policy, Reroute } from "../contracts";
import { loadReferenceData, type ReferenceData } from "./data";
import { DEFAULT_POLICY } from "./policy";
import { quote } from "./quote";
import { activeRules, diffPlans, plan, type ScreeningInput } from "./rules/engine";
import { loadSdnList, screenName, type ScreeningResult, type SdnList } from "./screen";
import { canonicalJSON, sha256Hex } from "./util";

export * from "./data";
export * from "./quote";
export * from "./rules/checks";
export * from "./rules/engine";
export * from "./screen";
export * from "./policy";
export * from "./rails";
export * from "./reconcile";
export * from "./audit";
export * from "./validate";
export * from "./present";
export * from "./demo";
export { canonicalJSON, sha256Hex, round2, isIsoDate } from "./util";

// ---- Loaded-once reference data -------------------------------------------------------

let ref: ReferenceData | null = null;

/** Rules pack, off-ramp registry and FX table (validated, loaded once). */
export function reference(): ReferenceData {
  return (ref ??= loadReferenceData());
}

let sdn: Promise<SdnList> | null = null;

/** The OFAC SDN snapshot (parsed once, ~40k names incl. aliases). */
export function sdnList(): Promise<SdnList> {
  return (sdn ??= loadSdnList().catch((err) => {
    sdn = null; // let the next call retry
    throw err;
  }));
}

export async function screenPayee(payeeName: string): Promise<ScreeningResult> {
  return screenName(payeeName, await sdnList());
}

// ---- Planning ------------------------------------------------------------------------

export interface PlanPayoutInput {
  payoutId: string;
  invoice: Invoice;
  asOf: string;
  /** Latest screening for this payee (screen once, store it, reuse it on re-plans). */
  screening: ScreeningInput;
  policy?: Policy;
}

/** quote + rules engine with the loaded reference data. Synchronous and pure. */
export function planPayout({ payoutId, invoice, asOf, screening, policy = DEFAULT_POLICY }: PlanPayoutInput): Plan {
  const r = reference();
  return plan({
    payoutId,
    invoice,
    asOf,
    screening,
    policy,
    routes: quote(invoice, r),
    rules: r.rules,
    rulesVersion: r.rulesVersion,
    fx: r.fx,
  });
}

export interface ReplanItem extends Omit<PlanPayoutInput, "asOf" | "policy"> {
  /** The payout's current plan, to detect reroutes. */
  previous: Plan | null;
}

/** Re-plan every open payout on a new as-of date (POST /api/plan-all). */
export function replanAll(items: ReplanItem[], asOf: string, policy: Policy = DEFAULT_POLICY): { plans: Plan[]; reroutes: Reroute[] } {
  const plans: Plan[] = [];
  const reroutes: Reroute[] = [];
  for (const item of items) {
    const next = planPayout({ ...item, asOf, policy });
    plans.push(next);
    if (item.previous) {
      const change = diffPlans(item.previous, next);
      if (change) reroutes.push(change);
    }
  }
  return { plans, reroutes };
}

/** sha256 of the canonical plan JSON (plans.plan_hash, memo reuse key). */
export function planHash(p: Plan): string {
  return sha256Hex(canonicalJSON(p));
}

/** Rules in force on a date (GET /api/rules?asOf=). */
export function rulesActiveOn(asOf: string, corridor?: string) {
  return activeRules(reference().rules, asOf, corridor);
}
