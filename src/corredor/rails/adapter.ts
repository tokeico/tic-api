// One interface per external dependency (ARCHITECTURE §1, §13).
// The API only talks to RailAdapter; mock is the default (RAIL_MODE=mock).

import type { Invoice, RailMode, Route } from "../../contracts";

export interface SendRequest {
  payoutId: string;
  route: Route;
  /** USD value at the booking rate (route.amountUsd). */
  amountUsd: number;
  payee: Invoice;
}

export interface SendResult {
  /** On-chain transaction hash. null for SWIFT wires. */
  txHash: string | null;
  /** Off-ramp provider's reference. null for SWIFT wires. */
  offrampRef: string | null;
  /** Local-rail reference: Pix end-to-end id, SPEI clave de rastreo, UETR... */
  railRef: string;
  /** Amount delivered to the payee, in the invoice currency. */
  settledLocal: number;
  /** Rate used at settlement (invoice currency per USD). */
  settleRate: number;
  /** ISO timestamp of settlement. */
  settledAt: string;
}

export interface RailAdapter {
  mode: RailMode;
  /** True when no real money or sandbox account is involved (UI "Simulated" badge). */
  simulated: boolean;
  send(req: SendRequest): Promise<SendResult>;
}

export class RailNotAvailableError extends Error {
  constructor(public mode: RailMode, reason: string) {
    super(`Rail "${mode}" is not available: ${reason}`);
    this.name = "RailNotAvailableError";
  }
}

export class RailModeError extends Error {
  constructor(mode: string) {
    super(`Unknown RAIL_MODE "${mode}". Expected mock, bridge, or blindpay.`);
    this.name = "RailModeError";
  }
}
