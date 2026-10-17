// POST /api/demo/reset  Wipes the database back to the four demo invoices (drafts)
// and the default demo date. Local databases only unless SEED_ALLOW_REMOTE=1;
// set ALLOW_DEMO_RESET=0 on any deployment that must never expose it.

import { Hono } from "hono";
import { db } from "../db";
import { ApiError } from "../http-error";
import { resetDemo } from "../services/demo";
import { listPayouts } from "../services/payouts";
import { getDemoAsOf } from "../services/settings";

export const demoRoutes = new Hono();

demoRoutes.post("/reset", async (c) => {
  if (process.env.ALLOW_DEMO_RESET === "0") throw new ApiError(403, "demo_reset_disabled", "Demo reset is disabled on this server.");
  try {
    await resetDemo();
  } catch (err) {
    throw new ApiError(403, "demo_reset_refused", err instanceof Error ? err.message : "Reset refused.");
  }
  return c.json({ asOf: await getDemoAsOf(db), payouts: await listPayouts() });
});
