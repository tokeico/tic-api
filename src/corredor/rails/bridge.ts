// Bridge / BlindPay sandbox adapters (P1, DECISIONS D14). Only used when
// RAIL_MODE selects them. Without credentials they fail loudly instead of
// silently falling back, so the UI never shows a mock payment as real.

import type { RailMode } from "../../contracts";
import { RailNotAvailableError, type RailAdapter, type SendResult } from "./adapter";
import { blindpayRail } from "./blindpay";

const BRIDGE_API_URL = process.env.BRIDGE_API_URL ?? "https://api.bridge.xyz/v0/transfers";

type BridgeTransfer = {
  id?: string;
  source_tx_hash?: string;
  destination_tx_hash?: string;
  updated_at?: string;
  receipt?: {
    destination_tx_hash?: string;
    exchange_rate?: string;
    final_amount?: string;
    url?: string;
  };
};

function mapTransfer(body: BridgeTransfer, amountUsd: number): SendResult {
  const txHash = body.receipt?.destination_tx_hash ?? body.destination_tx_hash ?? body.source_tx_hash;
  const offrampRef = body.id;
  if (!txHash || !offrampRef) {
    throw new Error("Bridge sandbox response is missing a transfer id or transaction hash");
  }
  const settleRate = body.receipt?.exchange_rate ? Number(body.receipt.exchange_rate) : 1;
  const settledLocal = body.receipt?.final_amount
    ? Number(body.receipt.final_amount)
    : Math.round(amountUsd * settleRate * 100) / 100;
  return {
    txHash,
    offrampRef,
    railRef: body.receipt?.url ?? offrampRef,
    settledLocal,
    settleRate,
    settledAt: body.updated_at ?? new Date().toISOString(),
  };
}

export const bridgeRail: RailAdapter = {
  mode: "bridge",
  simulated: false,
  async send(input) {
    const apiKey = process.env.BRIDGE_API_KEY;
    if (!apiKey) throw new RailNotAvailableError("bridge", "BRIDGE_API_KEY is not set; use RAIL_MODE=mock or provide a sandbox key");

    const response = await fetch(BRIDGE_API_URL, {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "content-type": "application/json",
        "idempotency-key": input.payoutId,
      },
      body: JSON.stringify({
        amount: input.amountUsd.toFixed(2),
        client_reference_id: input.payoutId,
        source: {
          payment_rail: input.route.network ?? "base",
          currency: (input.route.asset ?? "usdc").toLowerCase(),
        },
        destination: {
          payment_rail: input.route.rail,
          currency: input.payee.currency.toLowerCase(),
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Bridge sandbox ${response.status}: ${detail}`);
    }

    return mapTransfer((await response.json()) as BridgeTransfer, input.amountUsd);
  },
};

export function createSandboxRail(mode: Exclude<RailMode, "mock">): RailAdapter {
  return mode === "bridge" ? bridgeRail : blindpayRail;
}
