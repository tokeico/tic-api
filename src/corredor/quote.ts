// Candidate routes for an invoice: one SWIFT wire plus every stablecoin
// route (asset × network × off-ramp) registered for the payee's country.
// Pure: same invoice + registry + FX → same routes in the same order.

import type { Invoice, Network, Offramp, Route } from "../contracts";
import type { FxTable } from "./data";
import { round2 } from "./util";

export class UnknownCurrencyError extends Error {
  constructor(public currency: string) {
    super(`No FX rate for ${currency}. Add it to data/fx.json or fix the invoice currency.`);
    this.name = "UnknownCurrencyError";
  }
}

/** Local currency per USD. ARS uses the official rate. */
export function rateFor(currency: string, fx: FxTable): number {
  if (currency === "USD") return 1;
  const rate = fx.rates[currency] ?? fx.rates[`${currency}_official`];
  if (rate === undefined) throw new UnknownCurrencyError(currency);
  return rate;
}

export function toUsd(amount: number, currency: string, fx: FxTable): number {
  return round2(amount / rateFor(currency, fx));
}

/** Preferred network when two routes cost the same (cheapest gas first). */
export const NETWORK_PREFERENCE: Network[] = ["base", "arbitrum", "tron"];

export function wireRoute(invoice: Invoice, amountUsd: number, fx: FxTable): Route {
  return {
    id: `${invoice.payeeCountry}:wire:swift`,
    kind: "wire",
    asset: null,
    network: null,
    offramp: null,
    rail: "swift",
    feePct: fx.wire.feePct,
    feeUsd: round2((amountUsd * fx.wire.feePct) / 100),
    minutes: fx.wire.minutes,
    amountUsd,
  };
}

export function stablecoinRoutes(invoice: Invoice, amountUsd: number, offramps: Offramp[]): Route[] {
  const routes: Route[] = [];
  for (const o of offramps) {
    if (o.country !== invoice.payeeCountry) continue;
    for (const asset of o.assets) {
      for (const network of o.networks) {
        routes.push({
          id: `${invoice.payeeCountry}:${asset.toLowerCase()}-${network}:${o.id}`,
          kind: "stablecoin",
          asset,
          network,
          offramp: o,
          rail: o.rail,
          feePct: o.feePct,
          feeUsd: round2((amountUsd * o.feePct) / 100),
          minutes: o.minutes,
          amountUsd,
        });
      }
    }
  }
  return routes;
}

/** Wire first, then stablecoin routes in registry order. */
export function quote(invoice: Invoice, ref: { offramps: Offramp[]; fx: FxTable }): Route[] {
  const amountUsd = toUsd(invoice.amount, invoice.currency, ref.fx);
  return [wireRoute(invoice, amountUsd, ref.fx), ...stablecoinRoutes(invoice, amountUsd, ref.offramps)];
}
