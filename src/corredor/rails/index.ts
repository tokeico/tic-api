import type { RailAdapter } from "./adapter";
import { blindpayRail } from "./blindpay";
import { bridgeRail } from "./bridge";
import { mockRail } from "./mock";

export class RailModeError extends Error {
  constructor(mode: string) {
    super(`Unknown RAIL_MODE "${mode}". Expected mock, bridge, or blindpay.`);
    this.name = "RailModeError";
  }
}

export function railFor(mode: string | undefined = process.env.RAIL_MODE): RailAdapter {
  const selected = mode?.trim() ? mode.trim() : "mock";
  switch (selected) {
    case "mock":
      return mockRail;
    case "bridge":
      return bridgeRail;
    case "blindpay":
      return blindpayRail;
    default:
      throw new RailModeError(selected);
  }
}

export type { Invoice, RailAdapter, RailMode, RailSendInput, RailSendResult, Route } from "./adapter";
export { bookingRate, mockRail, mockSend } from "./mock";
export { bridgeRail } from "./bridge";
export { blindpayRail } from "./blindpay";
