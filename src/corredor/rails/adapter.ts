// Rail adapter types align with src/db/types.ts (Architecture §5).

import type { Country, ExtractedInvoice, LocalRail, Route } from "../../db/types";

export type RailMode = "mock" | "bridge" | "blindpay";

export type Invoice = ExtractedInvoice;

export type { Country, LocalRail, Route };

export type RailSendInput = {
  payoutId: string;
  route: Route;
  amountUsd: number;
  payee: Invoice;
};

export type RailSendResult = {
  txHash: string;
  offrampRef: string;
  railRef: string;
  settledLocal: number;
  settleRate: number;
};

export interface RailAdapter {
  mode: RailMode;
  send(input: RailSendInput): Promise<RailSendResult>;
}
