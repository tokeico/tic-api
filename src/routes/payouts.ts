// /api/payouts/* and /api/plan-all. Thin HTTP wrapper: parse, call the
// service (src/services/payouts.ts), return the contract shape.
// Errors are ApiError → { error: { code, message } } (see index.ts).

import { Hono, type Context } from "hono";
import { z } from "zod";
import { ApproveRequest, BankVerificationRequest, InvoicePatch, OfframpType, SanctionsReviewRequest, ScreeningReviewRequest, SecurityReviewRequest } from "../contracts";
import { isIsoDate } from "../corredor";
import { ApiError } from "../http-error";
import * as svc from "../services/payouts";
import { writeMemo } from "../services/memo";
import { REMITTANCE_LANGUAGES, remittanceAdvice, type RemittanceLanguage } from "../services/remittance";
import { getDemoAsOf } from "../services/settings";
import { db } from "../db";
import { requirePrincipal } from "../security/middleware";

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

// ?detail=1 returns full PayoutDetail rows (plans, memos, approvals...) in one request.
payoutRoutes.get("/", async (c) => c.json(c.req.query("detail") ? await svc.listPayoutDetails() : await svc.listPayouts()));

/**
 * POST /api/payouts/batch  { action, ids, acknowledgedWarnings? }  One action on many payouts (P6).
 * Each payout goes through exactly the same checks as the single endpoint, one
 * at a time, so the daily cap, two-person rule and holds still apply per payout.
 * A failure on one doesn't stop the others; every result is reported.
 */
const BatchRequest = z.object({
  action: z.enum(["approve", "pay", "reconcile"]),
  ids: z.array(z.string().uuid()).min(1).max(100),
  acknowledgedWarnings: z.record(z.string(), z.array(z.string())).optional(), // per payout id, for approve
});

payoutRoutes.post("/batch", async (c) => {
  const req = await body(c, BatchRequest);
  const me = requirePrincipal().userId;
  const results: { id: string; ok: boolean; status?: string; error?: { code: string; message: string } }[] = [];
  for (const id of [...new Set(req.ids)]) {
    try {
      const d =
        req.action === "approve"
          ? await svc.approve(id, { approver: me, decision: "approved", acknowledgedWarnings: req.acknowledgedWarnings?.[id] ?? [] })
          : req.action === "pay"
            ? await svc.pay(id, me)
            : await svc.reconcilePayout(id, me);
      results.push({ id, ok: true, status: d.status });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      results.push({ id, ok: false, error: { code: err.code, message: err.message } });
    }
  }
  return c.json({ results });
});

payoutRoutes.get("/:id", async (c) => c.json(await svc.getPayout(c.req.param("id"))));

/** GET /api/payouts/:id/remittance?lang=pt|es|en  Payment advice for the supplier (P11). Prepared, not sent. */
payoutRoutes.get("/:id/remittance", async (c) => {
  const lang = c.req.query("lang");
  if (lang !== undefined && !(REMITTANCE_LANGUAGES as readonly string[]).includes(lang)) throw new ApiError(400, "invalid_lang", "lang must be pt, es or en.");
  return c.json(await remittanceAdvice(c.req.param("id"), requirePrincipal().workspaceName, lang as RemittanceLanguage | undefined));
});

const WithBy = z.object({ by: z.string().min(1).optional() }); // who acted (name, email or id), recorded in the audit log

/** Like body(), for endpoints where the body is optional: an empty body means no fields. */
async function optionalBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  const text = await c.req.text();
  if (!text.trim()) return schema.parse({});
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, "invalid_body", parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return parsed.data;
}

payoutRoutes.patch("/:id", async (c) => {
  const { by, ...patch } = await body(c, InvoicePatch.extend({ by: WithBy.shape.by }));
  return c.json(await svc.editInvoice(c.req.param("id"), patch, requirePrincipal().userId));
});

/** GET /api/payouts/:id/preview?asOf=  Dry run: the plan on another date. Stores nothing. */
payoutRoutes.get("/:id/preview", async (c) => {
  const asOf = asOfParam(c);
  if (!asOf) throw new ApiError(400, "invalid_as_of", "asOf is required.");
  // ?registry=br-ponte:vasp_authorized,... asks "what if this registry update were approved?"
  const registry: Record<string, OfframpType> = {};
  for (const pair of (c.req.query("registry") ?? "").split(",").filter(Boolean)) {
    const [id, type] = pair.split(":");
    const parsed = OfframpType.safeParse(type);
    if (!id || !parsed.success) throw new ApiError(400, "invalid_registry", `Bad registry entry "${pair}". Use offrampId:type.`);
    registry[id] = parsed.data;
  }
  return c.json(await svc.previewPlan(c.req.param("id"), asOf, registry));
});

/** GET /api/payouts/:id/replay?n=100  Recompute the plan n times: the determinism proof. */
payoutRoutes.get("/:id/replay", async (c) => {
  const n = Number(c.req.query("n") ?? 100);
  if (!Number.isInteger(n) || n < 1 || n > 1000) throw new ApiError(400, "invalid_n", "n must be a whole number from 1 to 1000.");
  return c.json(await svc.replayPlan(c.req.param("id"), n));
});

payoutRoutes.post("/:id/plan", async (c) => c.json(await svc.planOne(c.req.param("id"), asOfParam(c))));

payoutRoutes.post("/:id/screening-review", async (c) =>
  c.json(await svc.reviewScreening(c.req.param("id"), { ...await body(c, ScreeningReviewRequest), reviewer: requirePrincipal().userId })),
);

/** POST /api/payouts/:id/sanctions-review  A compliance person releases the VE-OFAC hold (or confirms it). */
payoutRoutes.post("/:id/sanctions-review", async (c) =>
  c.json(await svc.reviewSanctions(c.req.param("id"), { ...await body(c, SanctionsReviewRequest), reviewer: requirePrincipal().userId })),
);

/** POST /api/payouts/:id/security-review  A person clears the security hold or keeps the payout held. */
payoutRoutes.post("/:id/security-review", async (c) =>
  c.json(await svc.reviewSecurityHold(c.req.param("id"), { ...await body(c, SecurityReviewRequest), reviewer: requirePrincipal().userId })),
);

payoutRoutes.post("/:id/approve", async (c) => c.json(await svc.approve(c.req.param("id"), { ...await body(c, ApproveRequest), approver: requirePrincipal().userId })));

/** POST /api/payouts/:id/bank-verification  Call-back check on the vendor's bank details (C9). */
payoutRoutes.post("/:id/bank-verification", async (c) =>
  c.json(await svc.verifyBankDetails(c.req.param("id"), await body(c, BankVerificationRequest), requirePrincipal().userId)),
);

payoutRoutes.post("/:id/pay", async (c) => {
  await optionalBody(c, WithBy);
  return c.json(await svc.pay(c.req.param("id"), requirePrincipal().userId));
});

payoutRoutes.post("/:id/reconcile", async (c) => {
  await optionalBody(c, WithBy);
  return c.json(await svc.reconcilePayout(c.req.param("id"), requirePrincipal().userId));
});

/** POST /api/plan-all?asOf=  The as-of slider. Without asOf it re-plans on the current demo date. */
export const planAllRoute = new Hono();

planAllRoute.post("/", async (c) => c.json(await svc.planAll(asOfParam(c) ?? (await getDemoAsOf(db)))));

/** POST /api/payouts/:id/memo  The local model writes the memo for the current plan (citations checked). */
payoutRoutes.post("/:id/memo", async (c) => c.json(await writeMemo(c.req.param("id"))));
