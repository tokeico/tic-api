// Read-only reference routes for the top bar and the rules badge.
//   GET /api/rules?asOf=   rules in force on a date (default: the demo date)
//   GET /api/screen?name=  ad-hoc OFAC SDN check
//   GET /api/settings      { asOf, railMode, policy }

import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { SettingsPatch } from "../contracts";
import { isIsoDate, reference, rulesActiveOn, screenPayee } from "../corredor";
import { db } from "../db";
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
  return c.json(await updateSettings(parsed.data));
});

/** GET /api/health  Pre-demo checklist: database up, local model reachable. */
referenceRoutes.get("/health", async (c) => {
  let dbOk = false;
  try {
    await db.execute(sql`select 1`);
    dbOk = true;
  } catch {}
  const model = process.env.LLM_MODEL ?? null;
  let ollama = false;
  const url = process.env.OLLAMA_URL;
  if (url) {
    try {
      ollama = (await fetch(`${url.replace(/\/$/, "")}/api/tags`, { signal: AbortSignal.timeout(800) })).ok;
    } catch {}
  }
  return c.json({ db: dbOk, ollama, model: ollama ? model : null });
});

/** GET /api/offramps  The provider registry with approved updates applied and each provider's on/off switch. */
referenceRoutes.get("/offramps", async (c) => {
  const { disabledOfframps, registry } = await getSettings(db);
  return c.json(
    reference().offramps.map((o) => ({ ...o, type: registry[o.id] ?? o.type, enabled: !disabledOfframps.includes(o.id) })),
  );
});
