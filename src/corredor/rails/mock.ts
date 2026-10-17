// Deterministic mock rail. IDs are derived from the payout id, so paying the
// same payout twice in a demo gives the same references. A small simulated
// rate move makes the journal's FX line non-zero.
// No money moves. The UI must show the "Simulated" badge (rail_mode = mock).

import type { LocalRail } from "../../contracts";
import type { FxTable } from "../data";
import { rateFor } from "../quote";
import { sha256Hex } from "../util";
import type { RailAdapter, SendRequest, SendResult } from "./adapter";

const ALNUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Deterministic pseudo-random bytes from a seed (sha256 counter mode). */
function bytes(seed: string, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; out.length < n; i++) {
    const h = sha256Hex(`${seed}:${i}`);
    for (let j = 0; j < h.length && out.length < n; j += 2) out.push(parseInt(h.slice(j, j + 2), 16));
  }
  return out;
}

const alnum = (seed: string, n: number) => bytes(seed, n).map((b) => ALNUM[b % 36]).join("");
const digits = (seed: string, n: number) => bytes(seed, n).map((b) => String(b % 10)).join("");

/** Local-rail reference shaped like the real thing. */
export function mockRailRef(rail: LocalRail, payoutId: string): string {
  switch (rail) {
    case "pix": // Pix end-to-end id: "E" + 31 alphanumerics
      return `E${alnum(`${payoutId}:pix`, 31)}`;
    case "spei": // SPEI clave de rastreo (up to 30 chars)
      return `CORR${alnum(`${payoutId}:spei`, 20)}`;
    case "cvu": // Coelsa transfer id
      return `COELSA-${digits(`${payoutId}:cvu`, 16)}`;
    case "pse":
      return `PSE${digits(`${payoutId}:pse`, 14)}`;
    case "swift": { // UETR (UUID v4 shape)
      const h = sha256Hex(`${payoutId}:uetr`);
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
    }
  }
}

/** Simulated move between booking and settlement: -0.50% .. +0.50%. */
export function mockRateMove(payoutId: string): number {
  const [hi, lo] = bytes(`${payoutId}:fx`, 2) as [number, number];
  return (((hi << 8) | lo) / 65535 - 0.5) / 100;
}

export interface MockRailOptions {
  fx: FxTable;
  /** Clock for settledAt. Injected so tests are deterministic. */
  now?: () => Date;
}

export function createMockRail({ fx, now = () => new Date() }: MockRailOptions): RailAdapter {
  return {
    mode: "mock",
    simulated: true,
    async send({ payoutId, route, payee }: SendRequest): Promise<SendResult> {
      const bookingRate = rateFor(payee.currency, fx);
      // USD-denominated invoices carry no FX exposure.
      const settleRate =
        payee.currency === "USD" ? 1 : Math.round(bookingRate * (1 + mockRateMove(payoutId)) * 1e6) / 1e6;
      const stablecoin = route.kind === "stablecoin";
      return {
        txHash: stablecoin ? `0x${sha256Hex(payoutId)}` : null,
        offrampRef: stablecoin && route.offramp ? `${route.offramp.id.toUpperCase()}-${alnum(`${payoutId}:offramp`, 12)}` : null,
        railRef: mockRailRef(route.rail, payoutId),
        // Payout APIs deliver the exact destination amount; the USD cost moves with the rate.
        settledLocal: payee.amount,
        settleRate,
        settledAt: now().toISOString(),
      };
    },
  };
}
