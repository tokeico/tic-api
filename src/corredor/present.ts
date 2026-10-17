// Turn engine output into the frontend-facing shapes (FRONTEND §5).

import type { Invoice, PayoutStatus, PayoutSummary, Plan, Route, RouteSummary } from "../contracts";
import { warningCount } from "./rules/engine";

const NETWORK_LABEL: Record<string, string> = { base: "Base", arbitrum: "Arbitrum", tron: "Tron" };

/** "USDC · Base · Sol VASP · 0.85%" / "SWIFT wire · 4.5%" */
export function routeLabel(r: Route): string {
  if (r.kind === "wire") return `SWIFT wire · ${r.feePct}%`;
  return [r.asset, r.network ? NETWORK_LABEL[r.network] : null, r.offramp?.name, `${r.feePct}%`].filter(Boolean).join(" · ");
}

export function routeSummary(r: Route): RouteSummary {
  return { id: r.id, label: routeLabel(r), feePct: r.feePct, minutes: r.minutes };
}

/**
 * Inbox row. `status` overrides the plan's status once the workflow has
 * moved on (approved, paid, booked...). `amountUsd` is used when there's no plan yet.
 */
export function toPayoutSummary(
  payoutId: string,
  invoice: Invoice,
  plan: Plan | null,
  opts: { status?: PayoutStatus; amountUsd?: number } = {},
): PayoutSummary {
  const amountUsd = plan?.evaluations[0]?.route.amountUsd ?? opts.amountUsd ?? 0;
  return {
    id: payoutId,
    payeeName: invoice.payeeName,
    country: invoice.payeeCountry,
    amountLocal: invoice.amount,
    currency: invoice.currency,
    amountUsd,
    status: opts.status ?? plan?.status ?? "draft",
    warnings: plan ? warningCount(plan) : 0,
    recommended: plan?.recommended ? routeSummary(plan.recommended) : null,
  };
}
