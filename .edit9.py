path = "/home/ve/hackathon/tic-api/src/services/payouts.ts"
src = open(path).read()

o = """  type ApproveRequest,
  type ReplayResult,"""
n = """  type ApproveRequest,
  type BankVerificationRequest,
  type PayoutChecks,
  type ReplayResult,"""
assert src.count(o) == 1
src = src.replace(o, n)

o = """import { appendAudit } from "./audit-log";"""
n = """import { appendAudit } from "./audit-log";
import { bankDetailsFor, normalizeTaxId } from "./vendors";"""
assert src.count(o) == 1
src = src.replace(o, n)

o = """const { payouts, plans, screenings, sanctionsReviews, securityHolds, approvals, payments, reconciliations, journalEntries, journalLines, users } = schema;"""
n = """const { payouts, plans, screenings, sanctionsReviews, securityHolds, approvals, payments, reconciliations, journalEntries, journalLines, users, vendors } = schema;"""
assert src.count(o) == 1
src = src.replace(o, n)

# toDetail → async, adds checks + acknowledgedWarnings on approvals
o = """function toDetail(p: FullPayout): PayoutDetail {
  const planRow = p.plans[0] ?? null;
  const pay = p.payments.find((x) => x.status !== "failed");
  const entry = p.journalEntries[0];
  const review = p.sanctionsReviews[0];
  const hold = p.securityHolds[0];
  return {"""
n = """async function toDetail(q: DbOrTx, p: FullPayout): Promise<PayoutDetail> {
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
    checks,"""
assert src.count(o) == 1
src = src.replace(o, n)

o = """    approvals: p.approvals
      .filter((a) => a.decision === "approved")
      .map((a) => ({ approver: a.approver.name, approverId: a.approverId, role: a.role, at: a.createdAt.toISOString() })),"""
n = """    approvals: p.approvals
      .filter((a) => a.decision === "approved")
      .map((a) => ({
        approver: a.approver.name,
        approverId: a.approverId,
        role: a.role,
        at: a.createdAt.toISOString(),
        ...(a.acknowledgedWarnings.length > 0 ? { acknowledgedWarnings: a.acknowledgedWarnings } : {}),
      })),"""
assert src.count(o) == 1
src = src.replace(o, n)

o = """  return rows.map((r) => toDetail(r as FullPayout));"""
n = """  return Promise.all(rows.map((r) => toDetail(q, r as FullPayout)));"""
assert src.count(o) == 1
src = src.replace(o, n)

# planContext: include the vendor bank-detail check
o = """  return { invoice, screening, sanctions: await sanctionsReviewFor(db, id, invoice), settings: await getSettings(db) };"""
n = """  return { invoice, screening, sanctions: await sanctionsReviewFor(db, id, invoice), bankDetails: await bankDetailsFor(db, invoice), settings: await getSettings(db) };"""
assert src.count(o) == 1
src = src.replace(o, n)

# sanctionsReviewFor refactor: row-level helper + mapping
o = """async function sanctionsReviewFor(q: DbOrTx, payoutId: string, invoice: Invoice): Promise<SanctionsInput | null> {
  const row = await q.query.sanctionsReviews.findFirst({
    where: eq(sanctionsReviews.payoutId, payoutId),
    orderBy: [desc(sanctionsReviews.createdAt)],
    with: { reviewer: true },
  });
  if (!row) return null;
  if (row.payeeName !== invoice.payeeName || (row.bankIdValue ?? null) !== (invoice.bankId?.value ?? null)) return null;
  return { decision: row.decision, licenseRef: row.licenseRef, by: row.reviewer.name };
}"""
n = """/** The latest sanctions review row, only when it still applies to the invoice as it stands. */
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
}"""
assert src.count(o) == 1
src = src.replace(o, n)

# enginePlan passes bankDetails
o = """    return planPayout({ payoutId: id, invoice: ctx.invoice, asOf, screening: ctx.screening, sanctions: ctx.sanctions, policy: ctx.settings.policy, options });"""
n = """    return planPayout({ payoutId: id, invoice: ctx.invoice, asOf, screening: ctx.screening, sanctions: ctx.sanctions, bankDetails: ctx.bankDetails, policy: ctx.settings.policy, options });"""
assert src.count(o) == 1
src = src.replace(o, n)

# planAndStore passes bankDetails
o = """  const screening = await screeningFor(tx, payout.id, invoice, actorId);
  const sanctions = await sanctionsReviewFor(tx, payout.id, invoice);
  let plan: Plan;
  try {
    plan = planPayout({ payoutId: payout.id, invoice, asOf, screening, sanctions, policy: settings.policy, options: planOptions(settings) });"""
n = """  const screening = await screeningFor(tx, payout.id, invoice, actorId);
  const sanctions = await sanctionsReviewFor(tx, payout.id, invoice);
  const bankDetails = await bankDetailsFor(tx, invoice);
  let plan: Plan;
  try {
    plan = planPayout({ payoutId: payout.id, invoice, asOf, screening, sanctions, bankDetails, policy: settings.policy, options: planOptions(settings) });"""
assert src.count(o) == 1
src = src.replace(o, n)

# getPayout uses async toDetail
o = """  const row = await loadFull(q, id);
  if (!row?.invoice) throw notFound();
  return toDetail(row);
}"""
n = """  const row = await loadFull(q, id);
  if (!row?.invoice) throw notFound();
  return toDetail(q, row);
}"""
assert src.count(o) == 1
src = src.replace(o, n)

open(path, "w").write(src)
print("payouts.ts part 1 done")
