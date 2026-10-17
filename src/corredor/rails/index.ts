import { RailMode } from "../../contracts";
import type { FxTable } from "../data";
import { RailModeError, type RailAdapter } from "./adapter";
import { createSandboxRail } from "./bridge";
import { createMockRail } from "./mock";

export * from "./adapter";
export { createMockRail, mockRailRef, mockRateMove } from "./mock";
export { bridgeRail, createSandboxRail } from "./bridge";
export { blindpayRail } from "./blindpay";

/** RAIL_MODE value → mode. Unset or blank means "mock"; anything unknown throws. */
export function parseRailMode(raw: string | undefined): RailMode {
  const selected = raw?.trim() || "mock";
  const parsed = RailMode.safeParse(selected);
  if (!parsed.success) throw new RailModeError(selected);
  return parsed.data;
}

/** Adapter for a mode (default: RAIL_MODE env, else "mock"). */
export function getRailAdapter(fx: FxTable, mode: RailMode = parseRailMode(process.env.RAIL_MODE)): RailAdapter {
  return mode === "mock" ? createMockRail({ fx }) : createSandboxRail(mode);
}
