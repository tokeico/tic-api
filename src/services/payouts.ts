// Payout workflow: load, plan, edit, approve, pay, reconcile.
//
//   draft ─plan─► needs_info | blocked | awaiting_second_approver | ready
//   ready / awaiting_second_approver ─approve─► approved ─pay─► paid ─reconcile─► booked
//                                    └reject──► rejected
//
// Rules of the road:
// - The rules engine decides (corredor/*). This file only stores what it says
//   and enforces the workflow around it.
// - Every state change and its audit event commit in one transaction.
// - A payout with any approval is frozen: re-planning could change the route
//   the approver signed off on. Plan, edit and the slider skip it.

import { and, asc, count, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import {
  Invoice,
  type InvoicePatch,
  type Memo,
  type OfframpType,
  type PayoutDetail,
  type PayoutStatus,
  type PayoutSummary,
  type Plan,
  type Policy,
  type Reroute,
  type ApproveRequest,
  type BankVerificationRequest,
  type PayoutChecks,
  type ReplayResult,
  type SanctionsReviewRequest,
  type ScreeningReviewRequest,
  type SecurityReviewRequest,
} from "../contracts";
import {
  UnknownCurrencyError,
  decideApproval,
  diffPlans,
  getRailAdapter,
  buildJournalEntry,
  planHash,
  planPayout,
  rateFor,
  reconcile,
  reference,
  templateMemo,
  screenPayee,
  toPayoutSummary,
  validateInvoice,
  warningCount,
  RailModeError,
  RailNotAvailableError,
  type SanctionsInput,
  type ScreeningInput,
} from "../corredor";
import { currentPrincipal, db, schema } from "../db";
import { ApiError, notFound } from "../http-error";
import { appendAudit } from "./audit-log";
import { bankDetailsFor, normalizeTaxId } from "./vendors";
import { getDemoAsOf, getSettings, planOptions, setDemoAsOf } from "./settings";
import { Settings, type SettingsPatch, type SettingsUpdate } from "../contracts";
import type { DbOrTx, Tx } from "./tx";

const { payouts, plans, screenings, sanctionsReviews, securityHolds, approvals, payments, reconciliations, journalEntries, journalLines, users, vendors } = schema;

/** Statuses the engine may still change. Anything later is a human decision. */
const REPLANNABLE: PayoutStatus[] = ["draft", "needs_info", "blocked", "awaiting_second_approver", "ready"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APPROVER_ROLES = ["controller", "approver"] as const;
const EDITOR_ROLES = ["controller", "approver", "ap_clerk"] as const;

export const isUuid = (s: string) => UUID.test(s);

// ---- Row ↔ contract mapping -------------------------------------------------------

type InvoiceRow = typeof schema.invoices.$inferSelect;

export function rowToInvoice(row: InvoiceRow): Invoice {
  return {
    invoiceNumber: row.invoiceNumber,
    payeeName: row.payeeName,
    payeeCountry: row.payeeCountry,
    payeeTaxId: row.payeeTaxId,
    amount: row.amount,
    currency: row.currency,
    dueDate: row.dueDate,
    bankId: row.bankIdType && row.bankIdValue ? { type: row.bankIdType, value: row.bankIdValue } : null,
    description: row.description,
    purposeCode: row.purposeCode,
    lowConfidence: row.lowConfidence,
  };
}

function loadFull(q: DbOrTx, id: string) {
  return q.query.payouts.findFirst({
    where: eq(payouts.id, id),
    with: {
      invoice: true,
      plans: { orderBy: [desc(plans.createdAt)], limit: 1, with: { memos: true } },
      approvals: { orderBy: [asc(approvals.createdAt)], with: { approver: true } },
      payments: { orderBy: [desc(payments.createdAt)], with: { reconciliation: true } },
      journalEntries: { with: { lines: true } },
      sanctionsReviews: { orderBy: [desc(sanctionsReviews.createdAt)], limit: 1, with: { reviewer: true } },
      securityHolds: { orderBy: [desc(securityHolds.createdAt)], limit: 1, with: { reviewer: true } },
    },
  });
}
type FullPayout = NonNullable<Awaited<ReturnType<typeof loadFull>>>;

function toSummary(
  p: {
    id: string;
    status: PayoutStatus;
    amountUsd: number | null;
    invoice: InvoiceRow | null;
    plans: { plan: Plan }[];
    securityHolds?: { status: string }[];
  },
): PayoutSummary {
  if (!p.invoice) throw new Error(`payout ${p.id} has no invoice`);
  return {
    ...toPayoutSummary(p.id, rowToInvoice(p.invoice), p.plans[0]?.plan ?? null, {
      status: p.status,
      amountUsd: p.amountUsd ?? undefined,
    }),
    ...(p.securityHolds?.[0] && p.securityHolds[0].status !== "cleared" ? { onSecurityHold: true } : {}),
  };
}

function toMemo(memos: FullPayout["plans"][number]["memos"]): Memo | null {
  const m = [...memos].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  return m
    ? {
        summary: m.summary,
        routeRationale: m.routeRationale,
        citedRuleIds: m.citedRuleIds,
        warnings: m.warnings,
        humanChecks: m.humanChecks,
        generatedBy: m.generatedBy === "template" ? ("template" as const) : ("llm" as const),
      }
    : null;
}

async function toDetail(q: DbOrTx, p: FullPayout): Promise<PayoutDetail> {
  const planRow = p.plans[0] ?? null;
  const pay = p.payments.find((x) => x.status !== "failed");
  const entry = p.journalEntries[0];
  const review = p.sanctionsReviews[0];
  const hold = p.securityHolds[0];
  // U1: honest check status — only report checks that actually ran.
  const checks: PayoutChecks = {
    injectionScan: hold ? "flagged" : p.invoice!.source === "upload" ? "passed" : "not_run",
    bankDetails: planRow?.plan.bankDetails?.status ?? (await bankDetailsFor(q, rowToInvoice(p.invoice!))).status,
    duplicatePdf: p.invoice!.source === "upload" && p.invoice!.pdfSha256 !== null ? "passed" : "not_run",
  };
  return {
    checks,
    ...toSummary(p),
    invoice: rowToInvoice(p.invoice!),
    plan: planRow?.plan ?? null,
    fingerprint: planRow ? planRow.planHash.slice(0, 16) : null,
    ...(review
      ? {
          sanctionsReview: {
            decision: review.decision,
            licenseRef: review.licenseRef,
            by: review.reviewer.name,
            at: review.createdAt.toISOString(),
            note: review.note,
          },
        }
      : {}),
    ...(hold
      ? {
          securityHold: {
            findings: hold.findings,
            status: hold.status,
            reviewedBy: hold.reviewer ? hold.reviewer.name : null,
            reviewedAt: hold.reviewedAt ? hold.reviewedAt.toISOString() : null,
            reviewNote: hold.reviewNote,
            flaggedAt: hold.createdAt.toISOString(),
          },
        }
      : {}),
    // A stored (model-written) memo wins; otherwise the deterministic template, built from the plan.
    memo: planRow
      ? (toMemo(planRow.memos) ??
        { ...templateMemo({ invoice: rowToInvoice(p.invoice!), plan: planRow.plan, amountUsd: p.amountUsd ?? planRow.plan.evaluations[0]?.route.amountUsd ?? 0 }), generatedBy: "template" as const })
      : null,
    approvals: p.approvals
      .filter((a) => a.decision === "approved")
      .map((a) => ({
        approver: a.approver.name,
        approverId: a.approverId,
        role: a.role,
        at: a.createdAt.toISOString(),
        ...(a.acknowledgedWarnings.length > 0 ? { acknowledgedWarnings: a.acknowledgedWarnings } : {}),
      })),
    ...(pay
      ? { payment: { txHash: pay.txHash, offrampRef: pay.offrampRef, railRef: pay.railRef ?? "", railMode: pay.railMode } }
      : {}),
    ...(entry
      ? {
          journal: {
            id: entry.id,
            payoutId: p.id,
            entryDate: entry.entryDate,
            description: entry.description,
            currency: "USD" as const,
            bookingRate: entry.bookingRate,
            settleRate: entry.settleRate,
            lines: [...entry.lines]
              .sort((a, b) => a.lineNo - b.lineNo)
              .map((l) => ({ lineNo: l.lineNo, account: l.account, description: l.description, debit: l.debit, credit: l.credit })),
          },
        }
      : {}),
  };
}

// ---- Reads ------------------------------------------------------------------------

export async function listPayouts(q: DbOrTx = db): Promise<PayoutSummary[]> {
  const rows = await q.query.payouts.findMany({
    orderBy: [asc(payouts.createdAt), asc(payouts.id)],
    with: {
      invoice: true,
      plans: { orderBy: [desc(plans.createdAt)], limit: 1 },
      securityHolds: { orderBy: [desc(securityHolds.createdAt)], limit: 1 },
    },
  });
  return rows.map(toSummary);
}

export async function listPayoutDetails(q: DbOrTx = db): Promise<PayoutDetail[]> {
  const rows = await q.query.payouts.findMany({
    orderBy: [asc(payouts.createdAt), asc(payouts.id)],
    with: {
      invoice: true,
      plans: { orderBy: [desc(plans.createdAt)], limit: 1, with: { memos: true } },
      approvals: { orderBy: [asc(approvals.createdAt)], with: { approver: true } },
      payments: { orderBy: [desc(payments.createdAt)], with: { reconciliation: true } },
      journalEntries: { with: { lines: true } },
      sanctionsReviews: { orderBy: [desc(sanctionsReviews.createdAt)], limit: 1, with: { reviewer: true } },
      securityHolds: { orderBy: [desc(securityHolds.createdAt)], limit: 1, with: { reviewer: true } },
    },
  });
  return Promise.all(rows.map((r) => toDetail(q, r as FullPayout)));
}

/** Everything the engine needs for one payout, read once. */
async function planContext(id: string) {
  if (!isUuid(id)) throw notFound();
  const payout = await db.query.payouts.findFirst({ where: eq(payouts.id, id), with: { invoice: true } });
  if (!payout?.invoice) throw notFound();
  const invoice = rowToInvoice(payout.invoice);
  const latest = await db.query.screenings.findFirst({ where: eq(screenings.payoutId, id), orderBy: [desc(screenings.createdAt)] });
  const screening: ScreeningInput =
    latest && latest.payeeName === invoice.payeeName
      ? {
          status: latest.status,
          ...(latest.matchedName ? { match: latest.matchedName } : {}),
          ...(latest.score !== null ? { score: latest.score } : {}),
          reviewDecision: latest.reviewDecision,
        }
      : await screenPayee(invoice.payeeName).then((r) => ({
          status: r.status,
          ...(r.match ? { match: r.match } : {}),
          ...(r.score !== undefined ? { score: r.score } : {}),
        }));
  return { invoice, screening, sanctions: await sanctionsReviewFor(db, id, invoice), bankDetails: await bankDetailsFor(db, invoice), settings: await getSettings(db) };
}

/**
 * The recorded sanctions sign-off as the engine sees it. A review covers the
 * payee as named and the bank details as reviewed: if either changed since,
 * it no longer applies and the policy hold is back in force.
 */
/** The latest sanctions review row, only when it still applies to the invoice as it stands. */
async function sanctionsReviewRow(q: DbOrTx, payoutId: string, invoice: Invoice): Promise<(typeof sanctionsReviews.$inferSelect & { reviewer: typeof users.$inferSelect }) | null> {
  const row = await q.query.sanctionsReviews.findFirst({
    where: eq(sanctionsReviews.payoutId, payoutId),
    orderBy: [desc(sanctionsReviews.createdAt)],
    with: { reviewer: true },
  });
  if (!row) return null;
  if (row.payeeName !== invoice.payeeName || (row.bankIdValue ?? null) !== (invoice.bankId?.value ?? null)) return null;
  return row;
}

async function sanctionsReviewFor(q: DbOrTx, payoutId: string, invoice: Invoice): Promise<SanctionsInput | null> {
  const row = await sanctionsReviewRow(q, payoutId, invoice);
  if (!row) return null;
  return { decision: row.decision, licenseRef: row.licenseRef, by: row.reviewer.name };
}

function enginePlan(id: string, ctx: Awaited<ReturnType<typeof planContext>>, asOf: string, hypothetical: Record<string, OfframpType> = {}): Plan {
  // `hypothetical` lets the radar ask "what if this registry update were approved?".
  const options = { ...planOptions(ctx.settings), registry: { ...ctx.settings.registry, ...hypothetical } };
  try {
    return planPayout({ payoutId: id, invoice: ctx.invoice, asOf, screening: ctx.screening, sanctions: ctx.sanctions, bankDetails: ctx.bankDetails, policy: ctx.settings.policy, options });
  } catch (err) {
    if (err instanceof UnknownCurrencyError) throw new ApiError(422, "unsupported_currency", err.message);
    throw err;
  }
}

/**
 * What would this payout's plan be on another date? Nothing is stored and
 * nothing is audited: this backs "what changes on Oct 31?" (dry run).
 */
export async function previewPlan(id: string, asOf: string, hypothetical: Record<string, OfframpType> = {}): Promise<Plan> {
  return enginePlan(id, await planContext(id), asOf, hypothetical);
}

/** GET /api/payouts/:id/replay: the determinism proof ("Replay 100×"). Reads only. */
export async function replayPlan(id: string, n: number): Promise<ReplayResult> {
  const ctx = await planContext(id);
  const stored = await db.query.plans.findFirst({ where: eq(plans.payoutId, id), orderBy: [desc(plans.createdAt)] });
  if (!stored) throw new ApiError(409, "no_plan", "This payout hasn't been planned yet.");
  const t0 = performance.now();
  let first = "";
  let identical = 0;
  for (let i = 0; i < n; i++) {
    const hash = planHash(enginePlan(id, ctx, stored.asOf));
    if (i === 0) first = hash;
    if (hash === first) identical++;
  }
  return { n, identical, matchesStored: first === stored.planHash, fingerprint: first.slice(0, 16), ms: Math.round((performance.now() - t0) * 10) / 10 };
}

export async function getPayout(id: string, q: DbOrTx = db): Promise<PayoutDetail> {
  if (!isUuid(id)) throw notFound();
  const row = await loadFull(q, id);
  if (!row?.invoice) throw notFound();
  return toDetail(q, row);
}

// ---- Locking and guards -----------------------------------------------------------

/** Lock the payout row for the rest of the transaction. */
async function lock(tx: Tx, id: string) {
  if (!isUuid(id)) throw notFound();
  const [row] = await tx.select().from(payouts).where(eq(payouts.id, id)).for("update");
  if (!row) throw notFound();
  return row;
}

async function assertReplannable(tx: Tx, payout: typeof payouts.$inferSelect, what: string) {
  if (!REPLANNABLE.includes(payout.status)) {
    throw new ApiError(409, "plan_locked", `A payout in status "${payout.status}" can't be ${what}.`);
  }
  const [{ n }] = await tx.select({ n: count() }).from(approvals).where(eq(approvals.payoutId, payout.id));
  if (n > 0) {
    throw new ApiError(409, "plan_locked", `This payout already has an approval decision, so it can't be ${what}.`);
  }
}

async function resolveUser(tx: Tx, ref: string, allowed: readonly string[], action: string) {
  ref = currentPrincipal()?.userId ?? ref;
  const byId = isUuid(ref) ? await tx.query.users.findFirst({ where: eq(users.id, ref) }) : undefined;
  const user =
    byId ??
    (await tx.query.users.findFirst({ where: sql`lower(${users.name}) = lower(${ref}) OR lower(${users.email}) = lower(${ref})` }));
  if (!user) throw new ApiError(404, "user_not_found", `No user "${ref}".`);
  if (!allowed.includes(user.role)) {
    throw new ApiError(403, "not_authorized", `${user.name} (${user.role}) can't ${action}.`);
  }
  return user;
}

// ---- Planning ---------------------------------------------------------------------

async function screeningFor(tx: Tx, payoutId: string, invoice: Invoice, actorId: string | null): Promise<ScreeningInput> {
  const latest = await tx.query.screenings.findFirst({
    where: eq(screenings.payoutId, payoutId),
    orderBy: [desc(screenings.createdAt)],
  });
  if (latest && latest.payeeName === invoice.payeeName) {
    return {
      status: latest.status,
      ...(latest.matchedName ? { match: latest.matchedName } : {}),
      ...(latest.score !== null ? { score: latest.score } : {}),
      reviewDecision: latest.reviewDecision,
    };
  }
  // First plan, or the payee name changed: screen again (a review applies to one name only).
  const res = await screenPayee(invoice.payeeName);
  await tx.insert(screenings).values({
    payoutId,
    payeeName: invoice.payeeName,
    status: res.status,
    matchedName: res.match ?? null,
    matchedEntryId: res.matchedEntryId ?? null,
    score: res.score ?? null,
    listVersion: res.listVersion,
  });
  await appendAudit(tx, {
    payoutId,
    actorId,
    type: "screened",
    payload: { status: res.status, listVersion: res.listVersion, ...(res.match ? { match: res.match, score: res.score } : {}) },
  });
  return { status: res.status, ...(res.match ? { match: res.match } : {}), ...(res.score !== undefined ? { score: res.score } : {}) };
}

interface Planned {
  plan: Plan;
  previous: Plan | null;
}

/** Run the engine for one payout and store the result. The caller holds the lock. */
async function planAndStore(tx: Tx, payout: typeof payouts.$inferSelect, asOf: string, settings: Settings, actorId: string | null): Promise<Planned> {
  const invoiceRow = await tx.query.invoices.findFirst({ where: eq(schema.invoices.id, payout.invoiceId) });
  if (!invoiceRow) throw new Error(`payout ${payout.id} has no invoice`);
  const invoice = rowToInvoice(invoiceRow);

  const screening = await screeningFor(tx, payout.id, invoice, actorId);
  const sanctions = await sanctionsReviewFor(tx, payout.id, invoice);
  const bankDetails = await bankDetailsFor(tx, invoice);
  let plan: Plan;
  try {
    plan = planPayout({ payoutId: payout.id, invoice, asOf, screening, sanctions, bankDetails, policy: settings.policy, options: planOptions(settings) });
  } catch (err) {
    if (err instanceof UnknownCurrencyError) throw new ApiError(422, "unsupported_currency", err.message);
    throw err;
  }

  const prevRow = await tx.query.plans.findFirst({ where: eq(plans.payoutId, payout.id), orderBy: [desc(plans.createdAt)] });
  const hash = planHash(plan);
  if (prevRow?.planHash !== hash) {
    await tx.insert(plans).values({
      payoutId: payout.id,
      asOf,
      rulesVersion: plan.rulesVersion,
      status: plan.status,
      screeningStatus: plan.screening.status,
      recommendedRouteId: plan.recommended?.id ?? null,
      recommended: plan.recommended,
      evaluations: plan.evaluations,
      reasons: plan.reasons,
      plan,
      planHash: hash,
    });
    await appendAudit(tx, {
      payoutId: payout.id,
      actorId,
      type: "planned",
      payload: {
        asOf,
        status: plan.status,
        recommendedRouteId: plan.recommended?.id ?? null,
        rulesVersion: plan.rulesVersion,
        planHash: hash,
      },
    });
  }
  // The denormalised inbox columns always follow the latest plan.
  await tx
    .update(payouts)
    .set({
      status: plan.status,
      asOf,
      amountUsd: plan.evaluations[0]?.route.amountUsd ?? null,
      recommendedRouteId: plan.recommended?.id ?? null,
      hasWarnings: warningCount(plan) > 0,
    })
    .where(eq(payouts.id, payout.id));
  return { plan, previous: prevRow?.plan ?? null };
}

/** POST /api/payouts/:id/plan */
export async function planOne(id: string, asOfParam?: string): Promise<PayoutDetail> {
  await db.transaction(async (tx) => {
    const payout = await lock(tx, id);
    await assertReplannable(tx, payout, "re-planned");
    const settings = await getSettings(tx);
    await planAndStore(tx, payout, asOfParam ?? payout.asOf ?? settings.asOf, settings, null);
  });
  return getPayout(id);
}

/** POST /api/plan-all: the slider. Moves the demo clock and re-plans every open payout. */
export async function planAll(asOf: string): Promise<{ payouts: PayoutSummary[]; reroutes: Reroute[] }> {
  const reroutes: Reroute[] = [];
  await db.transaction(async (tx) => {
    const settings = await getSettings(tx);
    const from = await getDemoAsOf(tx);
    const ids = await tx.select({ id: payouts.id }).from(payouts).orderBy(asc(payouts.createdAt), asc(payouts.id));
    let replanned = 0;
    for (const { id } of ids) {
      const payout = await lock(tx, id);
      try {
        await assertReplannable(tx, payout, "re-planned");
      } catch (err) {
        if (err instanceof ApiError && err.code === "plan_locked") continue; // decided: leave as is
        throw err;
      }
      const { plan, previous } = await planAndStore(tx, payout, asOf, settings, null);
      replanned++;
      const change = previous ? diffPlans(previous, plan) : null;
      if (change) reroutes.push(change);
    }
    if (from !== asOf) {
      await setDemoAsOf(tx, asOf);
      await appendAudit(tx, { payoutId: null, type: "asof_changed", payload: { from, to: asOf, replanned, reroutes: reroutes.length } });
    }
  });
  return { payouts: await listPayouts(), reroutes };
}

/** PATCH /api/payouts/:id */
export async function editInvoice(id: string, patch: InvoicePatch, by?: string): Promise<PayoutDetail> {
  await db.transaction(async (tx) => {
    const payout = await lock(tx, id);
    await assertReplannable(tx, payout, "edited");
    const actor = by ? await resolveUser(tx, by, EDITOR_ROLES, "edit invoices") : null;
    const row = await tx.query.invoices.findFirst({ where: eq(schema.invoices.id, payout.invoiceId) });
    if (!row) throw new Error(`payout ${id} has no invoice`);

    const current = rowToInvoice(row);
    const edited = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined) as (keyof InvoicePatch)[];
    const merged = Invoice.safeParse({ ...current, ...patch });
    if (!merged.success) {
      throw new ApiError(422, "invalid_invoice", merged.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    }
    // Editing clears "the model wasn't sure"; a failed checksum puts a field back.
    const issues = validateInvoice(merged.data);
    const lowConfidence = [
      ...new Set([...current.lowConfidence.filter((f) => !edited.includes(f as keyof InvoicePatch)), ...issues.map((i) => i.field)]),
    ];
    const inv = merged.data;
    await tx
      .update(schema.invoices)
      .set({
        invoiceNumber: inv.invoiceNumber,
        payeeName: inv.payeeName,
        payeeCountry: inv.payeeCountry,
        payeeTaxId: inv.payeeTaxId,
        amount: inv.amount,
        currency: inv.currency,
        dueDate: inv.dueDate,
        bankIdType: inv.bankId?.type ?? null,
        bankIdValue: inv.bankId?.value ?? null,
        description: inv.description,
        purposeCode: inv.purposeCode,
        lowConfidence,
      })
      .where(eq(schema.invoices.id, row.id));
    // Field names only: bank and tax ids don't belong in an immutable log.
    await appendAudit(tx, { payoutId: id, actorId: actor?.id ?? null, type: "edited", payload: { fields: edited, issues: issues.map((i) => i.field), ...(actor ? { by: actor.name } : {}) } });

    const settings = await getSettings(tx);
    await planAndStore(tx, payout, payout.asOf ?? settings.asOf, settings, null);
  });
  return getPayout(id);
}

// ---- Screening review ---------------------------------------------------------------

/** POST /api/payouts/:id/screening-review */
export async function reviewScreening(id: string, req: ScreeningReviewRequest): Promise<PayoutDetail> {
  await db.transaction(async (tx) => {
    const payout = await lock(tx, id);
    await assertReplannable(tx, payout, "reviewed");
    const reviewer = await resolveUser(tx, req.reviewer, APPROVER_ROLES, "review sanctions screenings");
    const latest = await tx.query.screenings.findFirst({ where: eq(screenings.payoutId, id), orderBy: [desc(screenings.createdAt)] });
    if (!latest) throw new ApiError(409, "not_screened", "This payout hasn't been screened yet. Plan it first.");
    if (latest.status === "clear") throw new ApiError(409, "nothing_to_review", "The screening was clear; there is nothing to review.");

    await tx
      .update(screenings)
      .set({ reviewDecision: req.decision, reviewedBy: reviewer.id, reviewedAt: new Date(), reviewNote: req.note })
      .where(eq(screenings.id, latest.id));
    await appendAudit(tx, {
      payoutId: id,
      actorId: reviewer.id,
      type: "screening_reviewed",
      payload: { decision: req.decision, screeningStatus: latest.status, match: latest.matchedName, by: reviewer.name },
    });
    const settings = await getSettings(tx);
    await planAndStore(tx, payout, payout.asOf ?? settings.asOf, settings, reviewer.id);
  });
  return getPayout(id);
}

// ---- Sanctions policy hold (VE-OFAC) ------------------------------------------

/**
 * POST /api/payouts/:id/sanctions-review. A compliance person releases the
 * sanctions policy hold (VE-OFAC, `liftedBy: "sanctions_signoff"`) or confirms
 * it, after checking what OFAC requires: that the payee, its owners and the
 * receiving bank aren't blocked, or are covered by a general license. The
 * sign-off records what it covered; a release becomes a warning naming the
 * reviewer, never a silent pass. Editing the payee name or bank details puts
 * the hold back (see sanctionsReviewFor).
 */
export async function reviewSanctions(id: string, req: SanctionsReviewRequest): Promise<PayoutDetail> {
  await db.transaction(async (tx) => {
    const payout = await lock(tx, id);
    await assertReplannable(tx, payout, "reviewed");
    const reviewer = await resolveUser(tx, req.reviewer, APPROVER_ROLES, "review sanctions holds");
    const invoiceRow = await tx.query.invoices.findFirst({ where: eq(schema.invoices.id, payout.invoiceId) });
    if (!invoiceRow) throw new Error(`payout ${id} has no invoice`);
    const invoice = rowToInvoice(invoiceRow);
    const planRow = await tx.query.plans.findFirst({ where: eq(plans.payoutId, id), orderBy: [desc(plans.createdAt)] });
    if (!planRow) throw new ApiError(409, "no_plan", "This payout hasn't been planned yet.");
    const liftable = new Set(reference().rules.filter((r) => r.liftedBy === "sanctions_signoff").map((r) => r.id));
    const onHold = planRow.plan.evaluations.some((e) => e.results.some((r) => r.outcome === "block" && liftable.has(r.ruleId)));
    if (!onHold) throw new ApiError(409, "no_sanctions_hold", "This payout isn't on a sanctions policy hold.");

    const [row] = await tx
      .insert(sanctionsReviews)
      .values({
        payoutId: id,
        decision: req.decision,
        licenseRef: req.licenseRef ?? null,
        note: req.note,
        reviewedBy: reviewer.id,
        payeeName: invoice.payeeName,
        bankIdValue: invoice.bankId?.value ?? null,
      })
      .returning({ id: sanctionsReviews.id });
    await appendAudit(tx, {
      payoutId: id,
      actorId: reviewer.id,
      type: "sanctions_reviewed",
      payload: { decision: req.decision, licenseRef: req.licenseRef ?? null, by: reviewer.name, note: req.note, statusBefore: payout.status, reviewId: row!.id },
    });
    const settings = await getSettings(tx);
    await planAndStore(tx, payout, payout.asOf ?? settings.asOf, settings, reviewer.id);
  });
  return getPayout(id);
}

// ---- Security hold (prompt-injection defense) ---------------------------------------

/** Refuse to approve or pay while a security hold gates the payout
 *  (both "active" and "confirmed_suspicious"; only a person's "cleared" lifts
 *  it). Rejections stay possible: refusing a payment is never unsafe. */
async function assertNoSecurityHold(tx: Tx, payoutId: string, decision?: "approved" | "rejected"): Promise<void> {
  const hold = await tx.query.securityHolds.findFirst({
    where: eq(securityHolds.payoutId, payoutId),
    orderBy: [desc(securityHolds.createdAt)],
  });
  if (hold && hold.status !== "cleared" && decision !== "rejected") {
    const n = hold.findings.length;
    throw new ApiError(409, "security_hold", `Instruction-like text in this invoice was flagged (${n} line${n === 1 ? "" : "s"}). A person must review it first: see the Security hold card.`);
  }
}

/**
 * POST /api/payouts/:id/security-review. A person clears the security hold
 * ("the flagged lines are just text") or keeps the payout held as suspicious.
 * Only people decide this: the agent can flag and quote, never clear.
 */
export async function reviewSecurityHold(id: string, req: SecurityReviewRequest): Promise<PayoutDetail> {
  await db.transaction(async (tx) => {
    const payout = await lock(tx, id);
    const reviewer = await resolveUser(tx, req.reviewer, APPROVER_ROLES, "review security holds");
    const hold = await tx.query.securityHolds.findFirst({
      where: eq(securityHolds.payoutId, id),
      orderBy: [desc(securityHolds.createdAt)],
    });
    if (!hold || hold.status !== "active") throw new ApiError(409, "no_security_hold", "This payout isn't on a security hold.");
    await tx
      .update(securityHolds)
      .set({ status: req.decision === "cleared" ? "cleared" : "confirmed_suspicious", reviewedBy: reviewer.id, reviewedAt: new Date(), reviewNote: req.note })
      .where(eq(securityHolds.id, hold.id));
    await appendAudit(tx, {
      payoutId: id,
      actorId: reviewer.id,
      type: "security_reviewed",
      payload: { decision: req.decision, by: reviewer.name, note: req.note, holdId: hold.id, findings: hold.findings.length },
    });
  });
  return getPayout(id);
}

// ---- Approval ---------------------------------------------------------------------

const startOfUtcDay = () => new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");

/** POST /api/payouts/:id/approve */
export async function approve(id: string, req: ApproveRequest): Promise<PayoutDetail> {
  try {
    await db.transaction(async (tx) => {
      const payout = await lock(tx, id);
      await assertNoSecurityHold(tx, id, req.decision); // the security hold gates approval; rejection stays possible
      const approver = await resolveUser(tx, req.approver, APPROVER_ROLES, "approve payouts");
      const planRow = await tx.query.plans.findFirst({ where: eq(plans.payoutId, id), orderBy: [desc(plans.createdAt)] });
      if (!planRow) throw new ApiError(409, "no_plan", "This payout hasn't been planned yet.");

      const existing = await tx.select().from(approvals).where(eq(approvals.payoutId, id)).orderBy(asc(approvals.createdAt));
      // USD approved today on other payouts, for the daily cap. Each payout's first approval carries its amount.
      const [{ total }] = await tx
        .select({ total: sql<string | null>`sum(${approvals.amountUsd})` })
        .from(approvals)
        .innerJoin(payouts, eq(payouts.id, approvals.payoutId))
        .where(
          and(
            eq(approvals.role, "first"),
            eq(approvals.decision, "approved"),
            gte(approvals.createdAt, startOfUtcDay()),
            ne(approvals.payoutId, id),
            ne(payouts.status, "rejected"),
          ),
        );
      const settings = await getSettings(tx);
      const amountUsd = payout.amountUsd ?? planRow.plan.recommended?.amountUsd ?? 0;

      const decision = decideApproval({
        status: payout.status,
        amountUsd,
        policy: settings.policy,
        existing: existing.map((a) => ({ approverId: a.approverId, role: a.role, decision: a.decision })),
        approverId: approver.id,
        decision: req.decision,
        approvedTodayUsd: Number(total ?? 0),
      });
      if (!decision.ok) throw new ApiError(409, decision.code, decision.message);
      if (planRow.plan.recommended === null) throw new ApiError(409, "no_route", "There is no compliant route to approve.");

      const invoiceRow = await tx.query.invoices.findFirst({ where: eq(schema.invoices.id, payout.invoiceId) });
      if (!invoiceRow) throw new Error(`payout ${id} has no invoice`);
      const invoice = rowToInvoice(invoiceRow);

      if (req.decision === "approved") {
        // C6 segregation of duties: the person who cleared the sanctions
        // checks can't also approve. Rejections are always allowed.
        const latestScreening = await tx.query.screenings.findFirst({ where: eq(screenings.payoutId, id), orderBy: [desc(screenings.createdAt)] });
        const clearedByApprover =
          latestScreening !== undefined &&
          latestScreening.payeeName === invoice.payeeName &&
          latestScreening.reviewDecision === "cleared" &&
          latestScreening.reviewedBy === approver.id;
        const review = await sanctionsReviewRow(tx, id, invoice);
        const releasedByApprover = review !== null && review.decision === "released" && review.reviewedBy === approver.id;
        if (clearedByApprover || releasedByApprover) {
          throw new ApiError(409, "reviewer_cannot_approve", "You cleared the sanctions check on this payout, so a different person must approve it.");
        }
        // P5: warnings on the recommended route must be explicitly acknowledged.
        const recEval = planRow.plan.evaluations.find((e) => e.route.id === planRow.plan.recommended!.id);
        const warnIds = recEval ? recEval.results.filter((r) => r.outcome === "warn").map((r) => r.ruleId) : [];
        const unacknowledged = warnIds.filter((r) => !req.acknowledgedWarnings.includes(r));
        if (unacknowledged.length > 0) {
          throw new ApiError(409, "warnings_not_acknowledged", `Acknowledge these warnings before approving: ${unacknowledged.join(", ")}.`);
        }
        // P3 + C9, re-checked here rather than trusting the stored plan.
        const bankIssue = validateInvoice(invoice).find((i) => i.field === "bankId");
        if (bankIssue) throw new ApiError(409, "invalid_bank_id", `Bank identifier failed its check: ${bankIssue.message}`);
        const bank = await bankDetailsFor(tx, invoice);
        if (bank.status !== "verified") {
          throw new ApiError(409, "bank_details_unverified", "The vendor's bank details aren't verified. Record a call-back verification before approving.");
        }
      }

      await tx.insert(approvals).values({
        payoutId: id,
        planId: planRow.id,
        approverId: approver.id,
        role: decision.role,
        decision: req.decision,
        amountUsd,
        comment: req.comment ?? null,
        acknowledgedWarnings: req.decision === "approved" ? req.acknowledgedWarnings : [],
      });
      await tx
        .update(payouts)
        .set({ status: decision.nextStatus, ...(decision.nextStatus === "approved" ? { approvedAt: new Date() } : {}) })
        .where(eq(payouts.id, id));
      await appendAudit(tx, {
        payoutId: id,
        actorId: approver.id,
        type: req.decision === "approved" ? "approved" : "rejected",
        payload: { planId: planRow.id, role: decision.role, nextStatus: decision.nextStatus, amountUsd, comment: req.comment ?? null, acknowledgedWarnings: req.decision === "approved" ? req.acknowledgedWarnings : [], by: approver.name },
      });
    });
  } catch (err) {
    throw mapUniqueViolation(err);
  }
  return getPayout(id);
}

/** The unique indexes are the last line of defence against double-clicks and races. */
function mapUniqueViolation(err: unknown): unknown {
  const e = err as { code?: string; errno?: string; message?: string };
  if (e?.code === "23505" || e?.errno === "23505") {
    return new ApiError(409, "already_decided", "That decision was already recorded for this payout.");
  }
  return err;
}

// ---- Payment ----------------------------------------------------------------------

/**
 * POST /api/payouts/:id/pay
 *
 * The rail call happens inside the transaction, with the payout row locked, so
 * two clicks can't both send. If the call fails the transaction rolls back and
 * the payout stays "approved". If it succeeds but the commit fails, a retry is
 * safe on real rails because the payout id is the idempotency key.
 */
export async function pay(id: string, by?: string): Promise<PayoutDetail> {
  let recheckFailure: string | null = null;
  try {
    await db.transaction(async (tx) => {
      const payout = await lock(tx, id);
      await assertNoSecurityHold(tx, id); // belt and braces: a held payout can't be approved to be paid
      const actor = by ? await resolveUser(tx, by, APPROVER_ROLES, "send payments") : null;
      if (payout.status !== "approved") {
        throw new ApiError(409, "not_approved", `A payout in status "${payout.status}" can't be paid. It must be approved first.`);
      }
      const planRow = await tx.query.plans.findFirst({ where: eq(plans.payoutId, id), orderBy: [desc(plans.createdAt)] });
      const route = planRow?.recommended;
      if (!planRow || !route) throw new ApiError(409, "no_route", "Payout has no recommended route to pay.");
      const invoiceRow = await tx.query.invoices.findFirst({ where: eq(schema.invoices.id, payout.invoiceId) });
      if (!invoiceRow) throw new Error(`payout ${id} has no invoice`);
      const payee = rowToInvoice(invoiceRow);
      const amountUsd = payout.amountUsd ?? route.amountUsd;

      // C8: re-check before money moves — rules, screening and bank details as
      // they stand on the demo clock's date, not when approval happened.
      const settings = await getSettings(tx);
      const asOf = settings.asOf;
      const fresh = await screenPayee(payee.payeeName);
      const latestScreening = await tx.query.screenings.findFirst({ where: eq(screenings.payoutId, id), orderBy: [desc(screenings.createdAt)] });
      const sameName = latestScreening?.payeeName === payee.payeeName;
      const screeningOk =
        fresh.status === "clear" ||
        (sameName && latestScreening!.reviewDecision === "cleared" && latestScreening!.matchedEntryId === fresh.matchedEntryId);
      const recheck = planPayout({
        payoutId: id,
        invoice: payee,
        asOf,
        screening: {
          status: fresh.status,
          ...(fresh.match ? { match: fresh.match } : {}),
          ...(fresh.score !== undefined ? { score: fresh.score } : {}),
          reviewDecision: sameName ? latestScreening!.reviewDecision : null,
        },
        sanctions: await sanctionsReviewFor(tx, id, payee),
        bankDetails: await bankDetailsFor(tx, payee),
        policy: settings.policy,
        options: planOptions(settings),
      });
      const existingApprovals = await tx.select().from(approvals).where(eq(approvals.payoutId, id)).orderBy(asc(approvals.createdAt));
      const reasons: string[] = [];
      const freshEval = recheck.evaluations.find((e) => e.route.id === route.id);
      if (freshEval === undefined || !freshEval.compliant) reasons.push(`route ${route.id} is no longer compliant on ${asOf}`);
      if (recheck.status === "blocked" || recheck.status === "needs_info") reasons.push(`the plan re-check gives status "${recheck.status}"`);
      if (!screeningOk) reasons.push("the payee no longer passes sanctions screening");
      const acknowledged = new Set(existingApprovals.flatMap((a) => a.acknowledgedWarnings));
      const newWarnings = freshEval === undefined ? [] : freshEval.results.filter((r) => r.outcome === "warn" && !acknowledged.has(r.ruleId)).map((r) => r.ruleId);
      if (newWarnings.length > 0) reasons.push(`new warnings need a fresh acknowledgment: ${newWarnings.join(", ")}`);

      if (reasons.length > 0) {
        // Approvals were given against a different picture: void them (the
        // audit event is the record) and leave the payout re-plannable.
        const screeningDiffers =
          latestScreening === undefined ||
          latestScreening.payeeName !== payee.payeeName ||
          latestScreening.status !== fresh.status ||
          (latestScreening.matchedName ?? null) !== (fresh.match ?? null) ||
          (latestScreening.matchedEntryId ?? null) !== (fresh.matchedEntryId ?? null) ||
          (latestScreening.score ?? null) !== (fresh.score ?? null);
        if (screeningDiffers) {
          await tx.insert(screenings).values({
            payoutId: id,
            payeeName: payee.payeeName,
            status: fresh.status,
            matchedName: fresh.match ?? null,
            matchedEntryId: fresh.matchedEntryId ?? null,
            score: fresh.score ?? null,
            listVersion: fresh.listVersion,
          });
          await appendAudit(tx, {
            payoutId: id,
            actorId: actor?.id ?? null,
            type: "screened",
            payload: { status: fresh.status, listVersion: fresh.listVersion, ...(fresh.match ? { match: fresh.match, score: fresh.score } : {}), recheck: true },
          });
        }
        await appendAudit(tx, {
          payoutId: id,
          actorId: actor?.id ?? null,
          type: "approval_voided",
          payload: {
            reasons,
            asOf,
            routeId: route.id,
            approvals: existingApprovals.map((a) => ({ approverId: a.approverId, role: a.role, planId: a.planId, amountUsd: a.amountUsd, at: a.createdAt.toISOString() })),
          },
        });
        await tx.delete(approvals).where(eq(approvals.payoutId, id));
        await tx.update(payouts).set({ approvedAt: null }).where(eq(payouts.id, id));
        await planAndStore(tx, payout, asOf, settings, actor?.id ?? null);
        recheckFailure = `The pay re-check failed: ${reasons.join("; ")}. Approvals were voided; review and approve again.`;
        return;
      }

      // The daily cap also guards payments actually sent today (UTC), not just approvals.
      const [{ sentToday }] = await tx
        .select({ sentToday: sql<string | null>`sum(${payments.amountUsd})` })
        .from(payments)
        .where(and(ne(payments.status, "failed"), gte(payments.createdAt, startOfUtcDay())));
      if (Number(sentToday ?? 0) + amountUsd > settings.policy.dailyCapUsd) {
        throw new ApiError(409, "daily_cap_exceeded", `Paying USD ${amountUsd} would bring today's payments over the USD ${settings.policy.dailyCapUsd} daily cap.`);
      }

      let sent;
      let mode;
      try {
        const rail = getRailAdapter(reference().fx);
        mode = rail.mode;
        sent = await rail.send({ payoutId: id, route, amountUsd, payee });
      } catch (err) {
        if (err instanceof RailNotAvailableError || err instanceof RailModeError) throw new ApiError(503, "rail_unavailable", err.message);
        throw new ApiError(502, "rail_error", err instanceof Error ? err.message : "The payment rail failed");
      }

      const [payment] = await tx
        .insert(payments)
        .values({
          payoutId: id,
          planId: planRow.id,
          routeId: route.id,
          route,
          railMode: mode,
          status: "settled",
          amountUsd,
          feeUsd: route.feeUsd,
          localCurrency: payee.currency,
          settledLocal: sent.settledLocal,
          settleRate: sent.settleRate,
          txHash: sent.txHash,
          offrampRef: sent.offrampRef,
          railRef: sent.railRef,
          settledAt: new Date(sent.settledAt),
        })
        .returning({ id: payments.id });
      await tx.update(payouts).set({ status: "paid", paidAt: new Date() }).where(eq(payouts.id, id));
      await appendAudit(tx, {
        payoutId: id,
        actorId: actor?.id ?? null,
        type: "paid",
        payload: {
          ...(actor ? { by: actor.name } : {}),
          paymentId: payment!.id,
          routeId: route.id,
          railMode: mode,
          amountUsd,
          txHash: sent.txHash,
          offrampRef: sent.offrampRef,
          railRef: sent.railRef,
        },
      });
    });
  } catch (err) {
    throw mapUniqueViolation(err);
  }
  if (recheckFailure) throw new ApiError(409, "pay_recheck_failed", recheckFailure);
  return getPayout(id);
}

// ---- Vendor bank-detail call-back verification (C9) -----------------------------------

/**
 * POST /api/payouts/:id/bank-verification. The reviewer (controller/approver)
 * records that they called the vendor back on a number from their own records
 * and confirmed the bank details. The person who last changed the bank details
 * can't also vouch for them. The audit event carries no bank or tax values.
 */
export async function verifyBankDetails(id: string, req: BankVerificationRequest, reviewerRef: string): Promise<PayoutDetail> {
  await db.transaction(async (tx) => {
    const payout = await lock(tx, id);
    await assertReplannable(tx, payout, "verified");
    const reviewer = await resolveUser(tx, reviewerRef, APPROVER_ROLES, "verify bank details");
    const invoiceRow = await tx.query.invoices.findFirst({ where: eq(schema.invoices.id, payout.invoiceId) });
    if (!invoiceRow) throw new Error(`payout ${id} has no invoice`);
    const invoice = rowToInvoice(invoiceRow);
    const bankOk = invoice.bankId !== null && !validateInvoice(invoice).some((i) => i.field === "bankId");
    if (!bankOk || invoice.payeeTaxId === null) {
      throw new ApiError(409, "cannot_verify", "The invoice needs a valid bank identifier and a tax id before its bank details can be verified.");
    }

    // The person who last changed the bank details can't also vouch for them.
    const edits = await tx
      .select({ actorId: schema.auditEvents.actorId, payload: schema.auditEvents.payload })
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.payoutId, id), eq(schema.auditEvents.type, "edited")))
      .orderBy(desc(schema.auditEvents.seq));
    const lastBankEdit = edits.find((e) => Array.isArray(e.payload.fields) && (e.payload.fields as unknown[]).includes("bankId"));
    if (lastBankEdit?.actorId === reviewer.id) {
      throw new ApiError(409, "same_person", "You changed the bank details on this invoice, so a different person must verify them.");
    }

    const previous = await bankDetailsFor(tx, invoice);
    const [vendor] = await tx
      .insert(vendors)
      .values({
        country: invoice.payeeCountry,
        taxId: normalizeTaxId(invoice.payeeTaxId),
        name: invoice.payeeName,
        bankIdType: invoice.bankId!.type,
        bankIdValue: invoice.bankId!.value,
        verifiedBy: reviewer.id,
        verifiedAt: new Date(),
        verificationNote: req.note,
        source: "callback",
      })
      .onConflictDoUpdate({
        target: [vendors.country, vendors.taxId],
        set: {
          name: invoice.payeeName,
          bankIdType: invoice.bankId!.type,
          bankIdValue: invoice.bankId!.value,
          verifiedBy: reviewer.id,
          verifiedAt: new Date(),
          verificationNote: req.note,
          source: "callback",
        },
      })
      .returning({ id: vendors.id });
    await appendAudit(tx, {
      payoutId: id,
      actorId: reviewer.id,
      type: "bank_verified",
      payload: { vendorId: vendor!.id, bankIdType: invoice.bankId!.type, previous: previous.status, by: reviewer.name, note: req.note },
    });
    const settings = await getSettings(tx);
    await planAndStore(tx, payout, payout.asOf ?? settings.asOf, settings, reviewer.id);
  });
  return getPayout(id);
}

// ---- Reconciliation and booking -------------------------------------------------------

/** POST /api/payouts/:id/reconcile. A mismatch is recorded and reported as a 409; fix it and call again. */
export async function reconcilePayout(id: string, by?: string): Promise<PayoutDetail> {
  let exception: string | null = null;
  await db.transaction(async (tx) => {
    const payout = await lock(tx, id);
    const actor = by ? await resolveUser(tx, by, APPROVER_ROLES, "reconcile payments") : null;
    if (payout.status !== "paid") {
      throw new ApiError(409, "not_paid", `A payout in status "${payout.status}" can't be reconciled. It must be paid first.`);
    }
    const payment = await tx.query.payments.findFirst({
      where: and(eq(payments.payoutId, id), ne(payments.status, "failed")),
    });
    if (!payment) throw new ApiError(409, "no_payment", "No payment found for this payout.");
    const invoiceRow = await tx.query.invoices.findFirst({ where: eq(schema.invoices.id, payout.invoiceId) });
    if (!invoiceRow) throw new Error(`payout ${id} has no invoice`);
    const invoice = rowToInvoice(invoiceRow);

    const others = await tx
      .select({ payoutId: payments.payoutId, txHash: payments.txHash, railRef: payments.railRef })
      .from(payments)
      .where(and(ne(payments.payoutId, id), ne(payments.status, "failed")));

    const result = reconcile({
      payoutId: id,
      invoice,
      payment: {
        payoutId: payment.payoutId,
        route: payment.route,
        amountUsd: payment.amountUsd,
        feeUsd: payment.feeUsd,
        txHash: payment.txHash,
        offrampRef: payment.offrampRef,
        railRef: payment.railRef,
        settledLocal: payment.settledLocal,
        settleRate: payment.settleRate,
      },
      others,
    });

    const [rec] = await tx
      .insert(reconciliations)
      .values({ payoutId: id, paymentId: payment.id, status: result.status, reason: result.reason })
      .onConflictDoUpdate({ target: reconciliations.paymentId, set: { status: result.status, reason: result.reason, createdAt: new Date() } })
      .returning({ id: reconciliations.id });

    if (result.status === "exception" || payment.settledLocal === null || payment.settleRate === null) {
      exception = result.reason ?? "Settlement data is missing.";
      await appendAudit(tx, { payoutId: id, actorId: actor?.id ?? null, type: "reconciled", payload: { status: "exception", reasons: result.reasons, paymentId: payment.id, ...(actor ? { by: actor.name } : {}) } });
      return; // stays "paid"; the exception row is kept
    }

    const entry = buildJournalEntry({
      payoutId: id,
      invoice,
      payment: {
        payoutId: payment.payoutId,
        route: payment.route,
        amountUsd: payment.amountUsd,
        feeUsd: payment.feeUsd,
        txHash: payment.txHash,
        offrampRef: payment.offrampRef,
        railRef: payment.railRef,
        settledLocal: payment.settledLocal,
        settleRate: payment.settleRate,
      },
      bookingRate: rateFor(invoice.currency, reference().fx),
      entryDate: (payment.settledAt ?? new Date()).toISOString().slice(0, 10),
    });
    const [header] = await tx
      .insert(journalEntries)
      .values({
        payoutId: id,
        paymentId: payment.id,
        entryDate: entry.entryDate,
        description: entry.description,
        currency: entry.currency,
        bookingRate: entry.bookingRate,
        settleRate: entry.settleRate,
      })
      .returning({ id: journalEntries.id });
    await tx.insert(journalLines).values(entry.lines.map((l) => ({ entryId: header!.id, ...l })));
    await tx.update(payouts).set({ status: "booked", bookedAt: new Date() }).where(eq(payouts.id, id));
    await appendAudit(tx, {
      payoutId: id,
      actorId: actor?.id ?? null,
      type: "reconciled",
      payload: { status: "matched", paymentId: payment.id, reconciliationId: rec!.id, journalEntryId: header!.id, ...(actor ? { by: actor.name } : {}) },
    });
  });
  if (exception) throw new ApiError(409, "reconciliation_exception", exception);
  return getPayout(id);
}

// ---- Settings ---------------------------------------------------------------------

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Hard ceilings on the policy a workspace may set (C4). Looser than this and
 * the request is refused outright — overridable per deployment via env.
 */
function assertPolicyCeilings(policy: Policy): void {
  const maxDaily = Number(process.env.POLICY_MAX_DAILY_CAP_USD ?? 1_000_000);
  const maxSecond = Number(process.env.POLICY_MAX_SECOND_APPROVER_USD ?? 100_000);
  if (policy.dailyCapUsd > maxDaily || policy.secondApproverAboveUsd > maxSecond) {
    throw new ApiError(
      422,
      "policy_above_ceiling",
      `Policy exceeds the hard ceilings: daily cap at most USD ${maxDaily}, second-approver threshold at most USD ${maxSecond}.`,
    );
  }
}

/** A patch that raises either limit is "loosening" — even if the other drops. */
const loosensPolicy = (next: Policy, current: Policy): boolean =>
  next.secondApproverAboveUsd > current.secondApproverAboveUsd || next.dailyCapUsd > current.dailyCapUsd;

/**
 * PUT /api/settings. Each field that actually changes is stored and written to
 * the audit log (one `settings_changed` event per setting), then every open
 * payout is re-planned so statuses and routes follow ("ready" becomes
 * "awaiting second approver" when the threshold drops below the amount, a
 * disabled provider loses its routes, an approved registry update can lift a
 * block). Payouts that already have an approval are frozen and keep their plan.
 * The reroutes the change caused come back so the UI can say why.
 *
 * C4 two-person rule: a policy change that LOOSENS a limit is not applied; it
 * is stored as `pending_policy` (audited `settings_change_requested`) until a
 * different person confirms it via POST /api/settings/pending-policy/confirm.
 */
export async function updateSettings(patch: SettingsPatch): Promise<SettingsUpdate> {
  const known = new Set(reference().offramps.map((o) => o.id));
  for (const id of [...(patch.disabledOfframps ?? []), ...Object.keys(patch.registry ?? {})]) {
    if (!known.has(id)) throw new ApiError(400, "unknown_offramp", `No off-ramp "${id}" in the registry.`);
  }
  if (patch.policy) assertPolicyCeilings(patch.policy);

  const changed = await db.transaction(async (tx) => {
    const actor = patch.by ? await resolveUser(tx, patch.by, APPROVER_ROLES, "change settings") : null;
    const current = await getSettings(tx);
    const changes: { key: string; setting: string; from: unknown; to: unknown }[] = [];
    if (patch.objective && patch.objective !== current.objective) changes.push({ key: "objective", setting: "objective", from: current.objective, to: patch.objective });
    if (patch.disabledOfframps) {
      const next = [...new Set(patch.disabledOfframps)].sort();
      if (!sameJson(next, [...current.disabledOfframps].sort())) changes.push({ key: "disabled_offramps", setting: "disabled_offramps", from: current.disabledOfframps, to: next });
    }
    if (patch.registry && !sameJson(patch.registry, current.registry)) changes.push({ key: "registry", setting: "registry", from: current.registry, to: patch.registry });

    for (const c of changes) {
      await tx
        .insert(schema.settings)
        .values({ key: c.key, value: c.to })
        .onConflictDoUpdate({ target: schema.settings.key, set: { value: c.to } });
      await appendAudit(tx, { payoutId: null, actorId: actor?.id ?? null, type: "settings_changed", payload: { setting: c.setting, from: c.from, to: c.to, ...(actor ? { by: actor.name } : {}) } });
    }

    if (patch.policy && !sameJson(patch.policy, current.policy)) {
      if (loosensPolicy(patch.policy, current.policy)) {
        if (!actor) throw new ApiError(401, "unauthorized", "Sign in to request a policy change.");
        const pending = { policy: patch.policy, requestedById: actor.id, requestedBy: actor.name, requestedAt: new Date().toISOString() };
        await tx
          .insert(schema.settings)
          .values({ key: "pending_policy", value: pending })
          .onConflictDoUpdate({ target: schema.settings.key, set: { value: pending } });
        await appendAudit(tx, {
          payoutId: null,
          actorId: actor.id,
          type: "settings_change_requested",
          payload: { setting: "policy", from: current.policy, to: patch.policy, by: actor.name },
        });
      } else {
        await tx
          .insert(schema.settings)
          .values({ key: "policy", value: patch.policy })
          .onConflictDoUpdate({ target: schema.settings.key, set: { value: patch.policy } });
        await appendAudit(tx, {
          payoutId: null,
          actorId: actor?.id ?? null,
          type: "settings_changed",
          payload: { setting: "policy", from: current.policy, to: patch.policy, ...(actor ? { by: actor.name } : {}) },
        });
        changes.push({ key: "policy", setting: "policy", from: current.policy, to: patch.policy });
      }
    }
    return changes.length > 0;
  });
  const reroutes = changed ? (await planAll(await getDemoAsOf(db))).reroutes : [];
  return { ...(await getSettings(db)), reroutes };
}

const PENDING_POLICY = Settings.shape.pendingPolicy;
type PendingPolicy = NonNullable<Settings["pendingPolicy"]>;

async function readPendingPolicy(tx: DbOrTx): Promise<PendingPolicy | null> {
  const row = await tx.query.settings.findFirst({ where: eq(schema.settings.key, "pending_policy") });
  const parsed = PENDING_POLICY.safeParse(row?.value ?? null);
  return parsed.success ? parsed.data : null;
}

/**
 * POST /api/settings/pending-policy/confirm. A second person (controller or
 * approver, not the requester) applies the pending loosening: the ceilings are
 * re-checked, the policy is stored and audited, and open payouts are re-planned.
 */
export async function confirmPendingPolicy(by: string): Promise<SettingsUpdate> {
  await db.transaction(async (tx) => {
    const actor = await resolveUser(tx, by, APPROVER_ROLES, "confirm a policy change");
    const pending = await readPendingPolicy(tx);
    if (pending === null) throw new ApiError(409, "no_pending_policy", "There is no policy change waiting for confirmation.");
    if (pending.requestedById === actor.id) {
      throw new ApiError(409, "same_person", "The person who requested this policy change can't confirm it.");
    }
    assertPolicyCeilings(pending.policy);
    const current = await getSettings(tx);
    await tx
      .insert(schema.settings)
      .values({ key: "policy", value: pending.policy })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: pending.policy } });
    await tx.delete(schema.settings).where(eq(schema.settings.key, "pending_policy"));
    await appendAudit(tx, {
      payoutId: null,
      actorId: actor.id,
      type: "settings_changed",
      payload: { setting: "policy", from: current.policy, to: pending.policy, requestedBy: pending.requestedBy, by: actor.name },
    });
  });
  const { reroutes } = await planAll(await getDemoAsOf(db));
  return { ...(await getSettings(db)), reroutes };
}

/** DELETE /api/settings/pending-policy. A controller withdraws the request. */
export async function cancelPendingPolicy(by: string): Promise<Settings> {
  await db.transaction(async (tx) => {
    const actor = await resolveUser(tx, by, ["controller"], "cancel a policy change");
    const pending = await readPendingPolicy(tx);
    if (pending === null) throw new ApiError(409, "no_pending_policy", "There is no pending policy change to cancel.");
    await tx.delete(schema.settings).where(eq(schema.settings.key, "pending_policy"));
    await appendAudit(tx, {
      payoutId: null,
      actorId: actor.id,
      type: "settings_change_cancelled",
      payload: { setting: "policy", to: pending.policy, requestedBy: pending.requestedBy, by: actor.name },
    });
  });
  return getSettings(db);
}
