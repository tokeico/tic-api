// Corredor database schema. Read DATABASE.md before changing anything here.
//
// What lives where:
// - Postgres (this file) records what happened: invoices, payouts, plan runs,
//   memos, approvals, payments, reconciliation, the journal and the audit chain.
// - Versioned files in git hold the reference data: the rules pack
//   (rules.json), the off-ramp registry (offramps.json), FX rates (fx.json)
//   and the OFAC SDN list. The rules engine must stay deterministic, so it
//   reads those files rather than the DB. Plans store the rules version and a
//   snapshot of each route, so history stays readable after the files change.
//
// JSON columns use ./jsonb (NOT drizzle's built-in jsonb, which double-encodes
// under Bun.SQL).
//
// Conventions: uuid primary keys (audit_events uses a sequence instead),
// snake_case columns, timestamptz everywhere, business dates as YYYY-MM-DD
// strings (`date` columns), money as numeric (read back as JS numbers).

import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  APPROVAL_DECISIONS,
  APPROVAL_ROLES,
  AUDIT_EVENT_TYPES,
  COUNTRIES,
  EXTRACTION_SOURCES,
  INVOICE_SOURCES,
  LOCAL_RAILS,
  MEMO_GENERATORS,
  PAYMENT_STATUSES,
  PAYOUT_STATUSES,
  RAIL_MODES,
  RECONCILIATION_STATUSES,
  SANCTIONS_REVIEW_DECISIONS,
  SCREENING_REVIEW_DECISIONS,
  SCREENING_STATUSES,
  SECURITY_HOLD_STATUSES,
  USER_ROLES,
  VENDOR_REQUEST_STATUSES,
  type ExtractedInvoice,
  type Plan,
  type Route,
  type RouteEvaluation,
  type SecurityFinding,
} from "./types";
import { jsonb } from "./jsonb";
export * from "./auth-schema";

// ---- Enums -----------------------------------------------------------------

export const countryEnum = pgEnum("country", COUNTRIES);
export const localRailEnum = pgEnum("local_rail", LOCAL_RAILS);
export const payoutStatusEnum = pgEnum("payout_status", PAYOUT_STATUSES);
export const screeningStatusEnum = pgEnum("screening_status", SCREENING_STATUSES);
export const screeningReviewDecisionEnum = pgEnum("screening_review_decision", SCREENING_REVIEW_DECISIONS);
export const sanctionsReviewDecisionEnum = pgEnum("sanctions_review_decision", SANCTIONS_REVIEW_DECISIONS);
export const securityHoldStatusEnum = pgEnum("security_hold_status", SECURITY_HOLD_STATUSES);
export const userRoleEnum = pgEnum("user_role", USER_ROLES);
export const approvalRoleEnum = pgEnum("approval_role", APPROVAL_ROLES);
export const approvalDecisionEnum = pgEnum("approval_decision", APPROVAL_DECISIONS);
export const railModeEnum = pgEnum("rail_mode", RAIL_MODES);
export const paymentStatusEnum = pgEnum("payment_status", PAYMENT_STATUSES);
export const reconciliationStatusEnum = pgEnum("reconciliation_status", RECONCILIATION_STATUSES);
export const invoiceSourceEnum = pgEnum("invoice_source", INVOICE_SOURCES);
export const extractionSourceEnum = pgEnum("extraction_source", EXTRACTION_SOURCES);
export const memoGeneratorEnum = pgEnum("memo_generator", MEMO_GENERATORS);
export const vendorRequestStatusEnum = pgEnum("vendor_request_status", VENDOR_REQUEST_STATUSES);
export const auditEventTypeEnum = pgEnum("audit_event_type", AUDIT_EVENT_TYPES);

// ---- Column helpers --------------------------------------------------------

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
/** Fiat or stablecoin amount, 2 decimals. */
const money = (name: string) => numeric(name, { precision: 18, scale: 2, mode: "number" });
/** FX rate (local currency per USD), 8 decimals. */
const rate = (name: string) => numeric(name, { precision: 18, scale: 8, mode: "number" });

// ---- Users -----------------------------------------------------------------

/** People who act in the app: approvers, AP clerks, auditors. No auth in v1. */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  role: userRoleEnum("role").notNull(),
  createdAt: createdAt(),
});

// ---- Vendors -----------------------------------------------------------------

/** Master vendor record (C9): the bank details a person verified by calling
 *  the vendor back on a number from their own records — never one printed on
 *  the invoice. Plans hold a payout whose invoice bank details don't match
 *  this record until someone re-verifies. Keyed by (country, normalized tax id). */
export const vendors = pgTable(
  "vendors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    country: countryEnum("country").notNull(),
    /** Normalized: uppercase, whitespace, dots, slashes and dashes stripped. */
    taxId: text("tax_id").notNull(),
    name: text("name").notNull(),
    bankIdType: localRailEnum("bank_id_type").notNull(),
    bankIdValue: text("bank_id_value").notNull(),
    /** Who recorded the call-back verification; null for seeded records. */
    verifiedBy: uuid("verified_by").references(() => users.id),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
    verificationNote: text("verification_note").notNull(),
    source: text("source").notNull().default("callback"), // "seed" | "callback"
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("vendors_country_tax_id_uq").on(t.country, t.taxId),
    check("vendors_source", sql`${t.source} IN ('seed', 'callback')`),
  ],
);

// ---- Invoices --------------------------------------------------------------

/** Invoice facts as extracted by Claude, editable by a human before planning. */
export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceNumber: text("invoice_number").notNull(),
    payeeName: text("payee_name").notNull(),
    payeeCountry: countryEnum("payee_country").notNull(),
    payeeTaxId: text("payee_tax_id"), // CNPJ / RFC / CUIT / RIF
    payeeEmail: text("payee_email"), // for vendor "missing info" emails
    amount: money("amount").notNull(), // in `currency`
    currency: text("currency").notNull(), // ISO 4217: BRL, MXN, USD...
    dueDate: date("due_date", { mode: "string" }),
    bankIdType: localRailEnum("bank_id_type"), // Pix key / CLABE / CVU...
    bankIdValue: text("bank_id_value"),
    description: text("description").notNull().default(""),
    purposeCode: text("purpose_code"), // Brazil FX purpose code
    lowConfidence: text("low_confidence").array().notNull().default(sql`'{}'::text[]`),
    source: invoiceSourceEnum("source").notNull().default("upload"),
    extractionSource: extractionSourceEnum("extraction_source").notNull(),
    pdfSha256: text("pdf_sha256"),
    pdfFilename: text("pdf_filename"),
    /** Raw model output before human edits, kept as evidence. */
    rawExtraction: jsonb<ExtractedInvoice>("raw_extraction"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("invoices_pdf_sha256_idx").on(t.pdfSha256),
    check("invoices_amount_positive", sql`${t.amount} > 0`),
    check("invoices_currency_iso", sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      "invoices_bank_id_pair",
      sql`(${t.bankIdType} IS NULL) = (${t.bankIdValue} IS NULL)`,
    ),
  ],
);

/** Claude extraction results keyed by PDF hash, so demo PDFs return instantly.
 *  The seed script deliberately does NOT clear this table. */
export const extractionCache = pgTable("extraction_cache", {
  pdfSha256: text("pdf_sha256").primaryKey(),
  invoice: jsonb<ExtractedInvoice>("invoice").notNull(),
  model: text("model").notNull(),
  createdAt: createdAt(),
});

// ---- Payouts ---------------------------------------------------------------

/** One payout per invoice: the unit that gets planned, approved, paid and
 *  booked. The current plan's results are denormalised here for the inbox. */
export const payouts = pgTable(
  "payouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .unique()
      .references(() => invoices.id, { onDelete: "cascade" }),
    status: payoutStatusEnum("status").notNull().default("draft"),
    /** As-of date of the latest plan. */
    asOf: date("as_of", { mode: "string" }),
    /** USD value from the latest plan (drives policy: 2nd approver, daily cap). */
    amountUsd: money("amount_usd"),
    recommendedRouteId: text("recommended_route_id"),
    hasWarnings: boolean("has_warnings").notNull().default(false),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    bookedAt: timestamp("booked_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("payouts_status_idx").on(t.status)],
);

// ---- Screening -------------------------------------------------------------

/** OFAC SDN fuzzy-match result. A possible_match or hit blocks the payout
 *  until a human records a review decision. */
export const screenings = pgTable(
  "screenings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    payoutId: uuid("payout_id")
      .notNull()
      .references(() => payouts.id, { onDelete: "cascade" }),
    payeeName: text("payee_name").notNull(), // name as screened
    status: screeningStatusEnum("status").notNull(),
    matchedName: text("matched_name"),
    matchedEntryId: text("matched_entry_id"), // SDN ent_num
    score: numeric("score", { precision: 5, scale: 4, mode: "number" }), // 0..1
    listVersion: text("list_version").notNull(), // e.g. SDN snapshot date
    reviewDecision: screeningReviewDecisionEnum("review_decision"),
    reviewedBy: uuid("reviewed_by").references(() => users.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNote: text("review_note"),
    createdAt: createdAt(),
  },
  (t) => [
    index("screenings_payout_idx").on(t.payoutId, t.createdAt),
    check("screenings_score_range", sql`${t.score} IS NULL OR (${t.score} >= 0 AND ${t.score} <= 1)`),
  ],
);

/** Compliance sign-off on a sanctions policy hold (VE-OFAC, rules with
 *  `liftedBy: "sanctions_signoff"`). A release covers the payee as named and
 *  the bank details as reviewed: if either changes, the next plan treats the
 *  hold as back in force (the engine re-checks against these snapshots). */
export const sanctionsReviews = pgTable(
  "sanctions_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    payoutId: uuid("payout_id")
      .notNull()
      .references(() => payouts.id, { onDelete: "cascade" }),
    decision: sanctionsReviewDecisionEnum("decision").notNull(),
    licenseRef: text("license_ref"), // OFAC general license relied on, e.g. "GL 57"
    note: text("note").notNull(), // what the reviewer checked
    reviewedBy: uuid("reviewed_by")
      .notNull()
      .references(() => users.id),
    /** Snapshots of what was reviewed; a mismatch re-arms the hold. */
    payeeName: text("payee_name").notNull(),
    bankIdValue: text("bank_id_value"),
    createdAt: createdAt(),
  },
  (t) => [index("sanctions_reviews_payout_idx").on(t.payoutId, t.createdAt)],
);

/** Prompt-injection defense: instruction-like lines found in an uploaded
 *  invoice's text. `active` blocks approval until a person records a review;
 *  `cleared` releases it, `confirmed_suspicious` keeps the payout held. */
export const securityHolds = pgTable(
  "security_holds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    payoutId: uuid("payout_id")
      .notNull()
      .references(() => payouts.id, { onDelete: "cascade" }),
    findings: jsonb<SecurityFinding[]>("findings").notNull(),
    status: securityHoldStatusEnum("status").notNull().default("active"),
    reviewedBy: uuid("reviewed_by").references(() => users.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNote: text("review_note"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("security_holds_payout_idx").on(t.payoutId, t.createdAt)],
);

// ---- Plans and memos ---------------------------------------------------------

/** Every rules-engine run (each slider move creates one per open payout).
 *  The latest row per payout is the current plan; older rows explain changes
 *  ("BR-561-EFX took effect"). */
export const plans = pgTable(
  "plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    payoutId: uuid("payout_id")
      .notNull()
      .references(() => payouts.id, { onDelete: "cascade" }),
    asOf: date("as_of", { mode: "string" }).notNull(),
    rulesVersion: text("rules_version").notNull(), // e.g. "v1"
    status: payoutStatusEnum("status").notNull(),
    screeningStatus: screeningStatusEnum("screening_status").notNull(),
    recommendedRouteId: text("recommended_route_id"),
    recommended: jsonb<Route | null>("recommended"),
    evaluations: jsonb<RouteEvaluation[]>("evaluations").notNull(),
    reasons: text("reasons").array().notNull().default(sql`'{}'::text[]`),
    /** Full Plan object exactly as returned by the engine. */
    plan: jsonb<Plan>("plan").notNull(),
    /** sha256 of the canonical Plan JSON. Same inputs + as-of give the same
     *  hash, so a memo can be reused instead of calling Claude again. */
    planHash: text("plan_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("plans_payout_created_idx").on(t.payoutId, t.createdAt.desc()),
    index("plans_plan_hash_idx").on(t.planHash),
  ],
);

/** Claude's (or the fallback template's) explanation of a plan. It never
 *  decides anything: cited rule ids must exist in the plan. */
export const memos = pgTable(
  "memos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    planHash: text("plan_hash").notNull(),
    summary: text("summary").notNull(),
    routeRationale: text("route_rationale").notNull(),
    citedRuleIds: text("cited_rule_ids").array().notNull().default(sql`'{}'::text[]`),
    warnings: text("warnings").array().notNull().default(sql`'{}'::text[]`),
    humanChecks: text("human_checks").array().notNull().default(sql`'{}'::text[]`),
    generatedBy: memoGeneratorEnum("generated_by").notNull(),
    model: text("model"), // null when generatedBy = template
    createdAt: createdAt(),
  },
  (t) => [
    index("memos_plan_idx").on(t.planId),
    index("memos_plan_hash_idx").on(t.planHash),
  ],
);

/** P1: email drafted to the vendor when required data is missing. */
export const vendorRequests = pgTable(
  "vendor_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    payoutId: uuid("payout_id")
      .notNull()
      .references(() => payouts.id, { onDelete: "cascade" }),
    missingFields: text("missing_fields").array().notNull(),
    toEmail: text("to_email"),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    status: vendorRequestStatusEnum("status").notNull().default("draft"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("vendor_requests_payout_idx").on(t.payoutId)],
);

// ---- Approvals -------------------------------------------------------------

/** Approve/reject decisions. Payouts over policy.secondApproverAboveUsd need a
 *  `second` approval from a different person (enforced by the unique index). */
export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    payoutId: uuid("payout_id")
      .notNull()
      .references(() => payouts.id, { onDelete: "cascade" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id), // the exact plan the person saw
    approverId: uuid("approver_id")
      .notNull()
      .references(() => users.id),
    role: approvalRoleEnum("role").notNull(),
    decision: approvalDecisionEnum("decision").notNull(),
    amountUsd: money("amount_usd").notNull(), // snapshot, for the daily cap
    comment: text("comment"),
    /** Warning rule ids the approver saw and accepted (P5). */
    acknowledgedWarnings: text("acknowledged_warnings").array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("approvals_payout_role_uq").on(t.payoutId, t.role),
    uniqueIndex("approvals_payout_approver_uq").on(t.payoutId, t.approverId),
    index("approvals_created_idx").on(t.createdAt),
  ],
);

// ---- Payments --------------------------------------------------------------

/** Result of RailAdapter.send(). At most one non-failed payment per payout. */
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    payoutId: uuid("payout_id")
      .notNull()
      .references(() => payouts.id, { onDelete: "cascade" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id),
    routeId: text("route_id").notNull(),
    route: jsonb<Route>("route").notNull(), // snapshot of what was paid
    railMode: railModeEnum("rail_mode").notNull(),
    status: paymentStatusEnum("status").notNull().default("pending"),
    amountUsd: money("amount_usd").notNull(),
    feeUsd: money("fee_usd").notNull(),
    localCurrency: text("local_currency").notNull(),
    settledLocal: money("settled_local"),
    settleRate: rate("settle_rate"),
    txHash: text("tx_hash"),
    offrampRef: text("offramp_ref"),
    railRef: text("rail_ref"), // e.g. Pix end-to-end id
    error: text("error"),
    createdAt: createdAt(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("payments_one_active_per_payout_uq")
      .on(t.payoutId)
      .where(sql`${t.status} <> 'failed'`),
    index("payments_tx_hash_idx").on(t.txHash),
  ],
);

// ---- Reconciliation and books ----------------------------------------------------

/** invoice ↔ tx hash ↔ local rail reference match. */
export const reconciliations = pgTable("reconciliations", {
  id: uuid("id").primaryKey().defaultRandom(),
  payoutId: uuid("payout_id")
    .notNull()
    .references(() => payouts.id, { onDelete: "cascade" }),
  paymentId: uuid("payment_id")
    .notNull()
    .unique()
    .references(() => payments.id, { onDelete: "cascade" }),
  status: reconciliationStatusEnum("status").notNull(),
  reason: text("reason"), // required when status = exception
  createdAt: createdAt(),
});

/** Journal entry header (one per reconciled payment). Amounts in USD. */
export const journalEntries = pgTable(
  "journal_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    payoutId: uuid("payout_id")
      .notNull()
      .references(() => payouts.id, { onDelete: "cascade" }),
    paymentId: uuid("payment_id")
      .notNull()
      .unique()
      .references(() => payments.id, { onDelete: "cascade" }),
    entryDate: date("entry_date", { mode: "string" }).notNull(),
    description: text("description").notNull(),
    currency: text("currency").notNull().default("USD"),
    bookingRate: rate("booking_rate").notNull(),
    settleRate: rate("settle_rate").notNull(),
    exportedAt: timestamp("exported_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("journal_entries_date_idx").on(t.entryDate)],
);

/** Journal lines. Each line is either a debit or a credit. The app must make
 *  each entry balance (sum of debits = sum of credits). */
export const journalLines = pgTable(
  "journal_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => journalEntries.id, { onDelete: "cascade" }),
    lineNo: integer("line_no").notNull(),
    account: text("account").notNull(), // "Accounts Payable", "Cash – USDC (Base)", "FX gain"...
    description: text("description"),
    debit: money("debit").notNull().default(0),
    credit: money("credit").notNull().default(0),
  },
  (t) => [
    uniqueIndex("journal_lines_entry_line_uq").on(t.entryId, t.lineNo),
    check(
      "journal_lines_one_side",
      sql`${t.debit} >= 0 AND ${t.credit} >= 0 AND (${t.debit} = 0 OR ${t.credit} = 0)`,
    ),
  ],
);

// ---- Audit -----------------------------------------------------------------

/** Append-only, keyed hash chain (ARCHITECTURE §12, src/corredor/audit.ts).
 *  mac = HMAC-SHA-512(key, prevMac + canonicalJSON({seq, payoutId, type, payload, createdAt, keyId}))
 *  A trigger (migration 0002) rejects UPDATE and DELETE. created_at has
 *  millisecond precision so it round-trips through JS Date exactly; set it
 *  in the app before MAC'ing, don't rely on the default. `seq` comes from the
 *  identity sequence but is read first (appendAudit), because it is part of
 *  the MAC. The DB columns keep their original names (`prev_hash`, `hash`)
 *  because renaming needs a destructive migration; they hold the MACs. */
export const auditEvents = pgTable(
  "audit_events",
  {
    seq: bigint("seq", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    payoutId: uuid("payout_id").references(() => payouts.id, { onDelete: "set null" }),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    type: auditEventTypeEnum("type").notNull(),
    payload: jsonb<Record<string, unknown>>("payload").notNull(),
    prevMac: text("prev_hash").notNull(), // GENESIS_MAC (128 zeros) for the first event
    mac: text("hash").notNull().unique(),
    keyId: text("key_id").notNull().default(""), // HMAC key id, for rotation
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [index("audit_events_payout_idx").on(t.payoutId, t.seq)],
);

/** Ed25519-signed checkpoints over the head MAC (every 10 events and when a
 *  payout is booked). Auditors verify them with the public key alone. */
export const auditCheckpoints = pgTable("audit_checkpoints", {
  seq: bigint("seq", { mode: "number" }).primaryKey(),
  headMac: text("head_mac").notNull(),
  signature: text("signature").notNull(), // base64
  publicKeyId: text("public_key_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull(),
});

// ---- Settings --------------------------------------------------------------

/** Key/value app settings. Known keys: "policy" (Policy), "demo_as_of"
 *  (YYYY-MM-DD string), "rules_version" (string). */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb<unknown>("value").notNull(),
  updatedAt: updatedAt(),
});

// ---- Relations (for db.query.* with `with: {...}`) ---------------------------

export const usersRelations = relations(users, ({ many }) => ({
  approvals: many(approvals),
}));

export const vendorsRelations = relations(vendors, ({ one }) => ({
  verifier: one(users, { fields: [vendors.verifiedBy], references: [users.id] }),
}));

export const invoicesRelations = relations(invoices, ({ one }) => ({
  payout: one(payouts),
}));

export const payoutsRelations = relations(payouts, ({ one, many }) => ({
  invoice: one(invoices, { fields: [payouts.invoiceId], references: [invoices.id] }),
  screenings: many(screenings),
  sanctionsReviews: many(sanctionsReviews),
  securityHolds: many(securityHolds),
  plans: many(plans),
  vendorRequests: many(vendorRequests),
  approvals: many(approvals),
  payments: many(payments),
  reconciliations: many(reconciliations),
  journalEntries: many(journalEntries),
  auditEvents: many(auditEvents),
}));

export const screeningsRelations = relations(screenings, ({ one }) => ({
  payout: one(payouts, { fields: [screenings.payoutId], references: [payouts.id] }),
  reviewer: one(users, { fields: [screenings.reviewedBy], references: [users.id] }),
}));

export const sanctionsReviewsRelations = relations(sanctionsReviews, ({ one }) => ({
  payout: one(payouts, { fields: [sanctionsReviews.payoutId], references: [payouts.id] }),
  reviewer: one(users, { fields: [sanctionsReviews.reviewedBy], references: [users.id] }),
}));

export const securityHoldsRelations = relations(securityHolds, ({ one }) => ({
  payout: one(payouts, { fields: [securityHolds.payoutId], references: [payouts.id] }),
  reviewer: one(users, { fields: [securityHolds.reviewedBy], references: [users.id] }),
}));

export const plansRelations = relations(plans, ({ one, many }) => ({
  payout: one(payouts, { fields: [plans.payoutId], references: [payouts.id] }),
  memos: many(memos),
}));

export const memosRelations = relations(memos, ({ one }) => ({
  plan: one(plans, { fields: [memos.planId], references: [plans.id] }),
}));

export const vendorRequestsRelations = relations(vendorRequests, ({ one }) => ({
  payout: one(payouts, { fields: [vendorRequests.payoutId], references: [payouts.id] }),
}));

export const approvalsRelations = relations(approvals, ({ one }) => ({
  payout: one(payouts, { fields: [approvals.payoutId], references: [payouts.id] }),
  plan: one(plans, { fields: [approvals.planId], references: [plans.id] }),
  approver: one(users, { fields: [approvals.approverId], references: [users.id] }),
}));

export const paymentsRelations = relations(payments, ({ one }) => ({
  payout: one(payouts, { fields: [payments.payoutId], references: [payouts.id] }),
  plan: one(plans, { fields: [payments.planId], references: [plans.id] }),
  reconciliation: one(reconciliations),
  journalEntry: one(journalEntries),
}));

export const reconciliationsRelations = relations(reconciliations, ({ one }) => ({
  payout: one(payouts, { fields: [reconciliations.payoutId], references: [payouts.id] }),
  payment: one(payments, { fields: [reconciliations.paymentId], references: [payments.id] }),
}));

export const journalEntriesRelations = relations(journalEntries, ({ one, many }) => ({
  payout: one(payouts, { fields: [journalEntries.payoutId], references: [payouts.id] }),
  payment: one(payments, { fields: [journalEntries.paymentId], references: [payments.id] }),
  lines: many(journalLines),
}));

export const journalLinesRelations = relations(journalLines, ({ one }) => ({
  entry: one(journalEntries, { fields: [journalLines.entryId], references: [journalEntries.id] }),
}));

export const auditEventsRelations = relations(auditEvents, ({ one }) => ({
  payout: one(payouts, { fields: [auditEvents.payoutId], references: [payouts.id] }),
  actor: one(users, { fields: [auditEvents.actorId], references: [users.id] }),
}));

// ---- Row types -------------------------------------------------------------

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Vendor = typeof vendors.$inferSelect;
export type NewVendor = typeof vendors.$inferInsert;
export type InvoiceRow = typeof invoices.$inferSelect;
export type NewInvoiceRow = typeof invoices.$inferInsert;
export type Payout = typeof payouts.$inferSelect;
export type NewPayout = typeof payouts.$inferInsert;
export type Screening = typeof screenings.$inferSelect;
export type SanctionsReview = typeof sanctionsReviews.$inferSelect;
export type SecurityHold = typeof securityHolds.$inferSelect;
export type PlanRow = typeof plans.$inferSelect;
export type MemoRow = typeof memos.$inferSelect;
export type VendorRequest = typeof vendorRequests.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type Reconciliation = typeof reconciliations.$inferSelect;
export type JournalEntry = typeof journalEntries.$inferSelect;
export type JournalLine = typeof journalLines.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type AuditCheckpointRow = typeof auditCheckpoints.$inferSelect;
export type Setting = typeof settings.$inferSelect;
