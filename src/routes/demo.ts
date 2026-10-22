// POST /api/demo/reset  Wipes the database back to the four demo invoices (drafts)
// and the default demo date. Local databases only unless SEED_ALLOW_REMOTE=1;
// set ALLOW_DEMO_RESET=0 on any deployment that must never expose it.

import { Hono } from "hono";
import { fileURLToPath } from "node:url";
import { loadSdnList, screenName } from "../corredor";
import { DemoScreening } from "../contracts";
import { db } from "../db";
import { ApiError } from "../http-error";
import { resetDemo } from "../services/demo";
import { listPayouts } from "../services/payouts";
import { getDemoAsOf } from "../services/settings";

export const demoRoutes = new Hono();

let presentationList: ReturnType<typeof loadSdnList> | null = null;

demoRoutes.get("/screen", async (c) => {
  const name = c.req.query("name")?.trim();
  if (!name || name.length > 200) throw new ApiError(400, "invalid_name", "name is required (max 200 characters).");
  const list = await (presentationList ??= loadSdnList(fileURLToPath(new URL("../../reference/presentation/", import.meta.url))).catch((err) => {
    presentationList = null;
    throw err;
  }));
  return c.json(DemoScreening.parse({ ...screenName(name, list), simulated: true }));
});

demoRoutes.post("/reset", async (c) => {
  if (process.env.ALLOW_DEMO_RESET === "0") throw new ApiError(403, "demo_reset_disabled", "Demo reset is disabled on this server.");
  try {
    await resetDemo();
  } catch (err) {
    throw new ApiError(403, "demo_reset_refused", err instanceof Error ? err.message : "Reset refused.");
  }
  return c.json({ asOf: await getDemoAsOf(db), payouts: await listPayouts() });
});
