// /api/payouts/* and /api/plan-all. Thin HTTP wrapper: parse, call the
// service (src/services/payouts.ts), return the contract shape.
// Errors are ApiError → { error: { code, message } } (see index.ts).

import { Hono, type Context } from "hono";
import type { z } from "zod";
import { ApproveRequest, InvoicePatch, ScreeningReviewRequest } from "../contracts";
import { isIsoDate } from "../corredor";
import { ApiError } from "../http-error";
import * as svc from "../services/payouts";
import { getDemoAsOf } from "../services/settings";
import { db } from "../db";

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(400, "invalid_body", parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  }
  return parsed.data;
}

function asOfParam(c: Context): string | undefined {
  const asOf = c.req.query("asOf");
  if (asOf === undefined) return undefined;
  if (!isIsoDate(asOf)) throw new ApiError(400, "invalid_as_of", "asOf must be a real YYYY-MM-DD date.");
  return asOf;
}

export const payoutRoutes = new Hono();

payoutRoutes.get("/", async (c) => c.json(await svc.listPayouts()));

payoutRoutes.get("/:id", async (c) => c.json(await svc.getPayout(c.req.param("id"))));

payoutRoutes.patch("/:id", async (c) => c.json(await svc.editInvoice(c.req.param("id"), await body(c, InvoicePatch))));

payoutRoutes.post("/:id/plan", async (c) => c.json(await svc.planOne(c.req.param("id"), asOfParam(c))));

payoutRoutes.post("/:id/screening-review", async (c) =>
  c.json(await svc.reviewScreening(c.req.param("id"), await body(c, ScreeningReviewRequest))),
);

payoutRoutes.post("/:id/approve", async (c) => c.json(await svc.approve(c.req.param("id"), await body(c, ApproveRequest))));

payoutRoutes.post("/:id/pay", async (c) => c.json(await svc.pay(c.req.param("id"))));

payoutRoutes.post("/:id/reconcile", async (c) => c.json(await svc.reconcilePayout(c.req.param("id"))));

/** POST /api/plan-all?asOf=  The as-of slider. Without asOf it re-plans on the current demo date. */
export const planAllRoute = new Hono();

planAllRoute.post("/", async (c) => c.json(await svc.planAll(asOfParam(c) ?? (await getDemoAsOf(db)))));
