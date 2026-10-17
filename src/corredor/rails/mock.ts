import { createHash } from "node:crypto";
import type { Invoice, RailAdapter, RailSendInput, Route } from "./adapter";

// Demo booking rates from ARCHITECTURE §7 (data/fx.json). ARS uses the official rate.
const BOOKING_RATES: Record<string, number> = {
  BRL: 5.4,
  MXN: 18.5,
  ARS: 1350,
  USD: 1,
};

const LOCAL_RAIL_CURRENCY: Record<Route["rail"], string | null> = {
  pix: "BRL",
  spei: "MXN",
  cvu: "ARS",
  pse: "COP",
  swift: null,
};

export function bookingRate(payee: Pick<Invoice, "currency">, route: Pick<Route, "rail">): number {
  if (payee.currency !== "USD") return BOOKING_RATES[payee.currency] ?? 1;
  const local = LOCAL_RAIL_CURRENCY[route.rail];
  if (local) return BOOKING_RATES[local] ?? 1;
  return 1;
}

function digest(payoutId: string): string {
  return createHash("sha256").update(payoutId).digest("hex");
}

function round(value: number, digits: number): number {
  const places = 10 ** digits;
  return Math.round(value * places) / places;
}

function railRef(rail: Route["rail"], hex: string): string {
  const upper = hex.toUpperCase();
  switch (rail) {
    case "pix":
      return `E${upper.slice(0, 31)}`;
    case "spei":
      return `SPEI${upper.slice(0, 18)}`;
    case "cvu":
      return `CVU${upper.slice(0, 22)}`;
    case "pse":
      return `PSE${upper.slice(0, 20)}`;
    case "swift":
      return `SWIFT${upper.slice(0, 16)}`;
  }
}

export function mockSend(input: RailSendInput): RailSendResult {
  const hex = digest(input.payoutId);
  const booking = bookingRate(input.payee, input.route);
  // 1.0001–1.0040, derived from the digest so the FX line is never zero.
  const factor = 1 + ((Number.parseInt(hex.slice(0, 2), 16) % 40) + 1) / 10_000;
  const settleRate = round(booking * factor, 6);
  return {
    txHash: `0x${hex}`,
    offrampRef: `off_${hex.slice(0, 16)}`,
    railRef: railRef(input.route.rail, hex),
    settleRate,
    settledLocal: round(input.amountUsd * settleRate, 2),
  };
}

export const mockRail: RailAdapter = {
  mode: "mock",
  send(input) {
    return Promise.resolve(mockSend(input));
  },
};
