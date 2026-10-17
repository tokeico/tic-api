// Read-only reference routes for the top bar and the rules badge.
//   GET /api/rules?asOf=   rules in force on a date (default: the demo date)
//   GET /api/screen?name=  ad-hoc OFAC SDN check
//   GET /api/settings      { asOf, railMode, policy }

import { Hono } from "hono";
import { isIsoDate, rulesActiveOn, screenPayee } from "../corredor";
import { db } from "../db";
import { ApiError } from "../http-error";
import { getDemoAsOf, getSettings } from "../services/settings";

export const referenceRoutes = new Hono();

referenceRoutes.get("/rules", async (c) => {
  const asOf = c.req.query("asOf");
  if (asOf !== undefined && !isIsoDate(asOf)) throw new ApiError(400, "invalid_as_of", "asOf must be a real YYYY-MM-DD date.");
  return c.json(rulesActiveOn(asOf ?? (await getDemoAsOf(db))));
});

referenceRoutes.get("/screen", async (c) => {
  const name = c.req.query("name")?.trim();
  if (!name || name.length > 200) throw new ApiError(400, "invalid_name", "name is required (max 200 characters).");
  return c.json(await screenPayee(name));
});

referenceRoutes.get("/settings", async (c) => c.json(await getSettings(db)));
