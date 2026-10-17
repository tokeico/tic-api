// Read-only reference routes for the top bar and the rules badge.
//   GET /api/rules?asOf=   rules in force on a date (default: the demo date)
//   GET /api/screen?name=  ad-hoc OFAC SDN check
//   GET /api/settings      { asOf, railMode, policy }

import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { SettingsPatch } from "../contracts";
import { getProvider } from "../llm/provider";
import { isIsoDate, reference, rulesActiveOn, screenPayee } from "../corredor";
import { adminDb, db } from "../db";
import { requirePrincipal } from "../security/middleware";
import { ApiError } from "../http-error";
import { updateSettings } from "../services/payouts";
import { getDemoAsOf, getSettings } from "../services/settings";

export const referenceRoutes = new Hono();

referenceRoutes.get("/rules", async (c) => {
  const asOf = c.req.query("asOf");
  if (asOf !== undefined && !isIsoDate(asOf)) throw new ApiError(400, "invalid_as_of", "asOf must be a real YYYY-MM-DD date.");
  // ?all=1 lists the whole pack (Customize page); otherwise only what is in force on the date.
  if (c.req.query("all")) return c.json(reference().rules);
  return c.json(rulesActiveOn(asOf ?? (await getDemoAsOf(db))));
});

referenceRoutes.get("/screen", async (c) => {
  const name = c.req.query("name")?.trim();
  if (!name || name.length > 200) throw new ApiError(400, "invalid_name", "name is required (max 200 characters).");
  return c.json(await screenPayee(name));
});

referenceRoutes.get("/settings", async (c) => c.json(await getSettings(db)));

/** PUT /api/settings  { policy?, objective?, disabledOfframps?, registry?, by? }  Changes settings and re-plans open payouts. */
referenceRoutes.put("/settings", async (c) => {
  const principal = requirePrincipal();
  if (principal.role !== "controller") throw new ApiError(403, "not_authorized", "Only a workspace controller can change policy or providers.");
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON.");
  }
  const parsed = SettingsPatch.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(400, "invalid_body", parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  }
  return c.json(await updateSettings({ ...parsed.data, by: principal.userId }));
});

/** GET /api/health  Pre-demo checklist: database up, local model reachable and pulled. */
referenceRoutes.get("/health", async (c) => {
  let dbOk = false;
  try {
    await adminDb.execute(sql`select 1`);
    dbOk = true;
  } catch {}
  const llm = getProvider();
  return c.json({ db: dbOk, llm: await llm.available(), model: llm.model });
});

/** GET /api/offramps  The provider registry with approved updates applied and each provider's on/off switch. */
referenceRoutes.get("/offramps", async (c) => {
  const { disabledOfframps, registry } = await getSettings(db);
  return c.json(
    reference().offramps.map((o) => ({ ...o, type: registry[o.id] ?? o.type, enabled: !disabledOfframps.includes(o.id) })),
  );
});
