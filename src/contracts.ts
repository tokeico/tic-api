// Corredor API contracts: zod schemas + TypeScript types shared with tic-web.
//
// SOURCE OF TRUTH. tic-web keeps a copy at src/lib/contracts.ts. Copy this
// file over whenever it changes and tell the team (DECISIONS D18). Keep it
// self-contained: the only import allowed is zod.
//
// Shapes follow ARCHITECTURE §5 and FRONTEND §5. Dates are "YYYY-MM-DD"
// strings, timestamps are ISO 8601 strings, money is a plain number.

import { z } from "zod";

// ---- Primitives --------------------------------------------------------------

export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
export type IsoDate = z.infer<typeof IsoDate>;

export const Country = z.enum(["BR", "MX", "AR", "CO", "VE"]);
export type Country = z.infer<typeof Country>;

export const LocalRail = z.enum(["pix", "spei", "cvu", "pse", "swift"]);
export type LocalRail = z.infer<typeof LocalRail>;

export const Asset = z.enum(["USDC", "USDT"]);
export type Asset = z.infer<typeof Asset>;

export const Network = z.enum(["base", "arbitrum", "tron"]);
export type Network = z.infer<typeof Network>;

export const OfframpType = z.enum([
  "vasp_authorized",
  "vasp_pending",
  "vasp_unfiled", // operating, but has not filed for BCB authorization (deadline 2026-10-30)
  "efx",
  "bank",
  "nonbank_licensed",
  "psav_registered",
  "p2p_unregistered",
]);
export type OfframpType = z.infer<typeof OfframpType>;

// ---- Invoice -----------------------------------------------------------------

export const BankId = z.object({ type: LocalRail, value: z.string() });
export type BankId = z.infer<typeof BankId>;

/** What extraction produces and a human can edit before planning. */
export const Invoice = z.object({
  invoiceNumber: z.string(),
  payeeName: z.string(),
  payeeCountry: Country,
  payeeTaxId: z.string().nullable(), // CNPJ / RFC / CUIT / RIF
  amount: z.number().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/, "ISO 4217 code, e.g. BRL"),
  dueDate: IsoDate.nullable(),
  bankId: BankId.nullable(), // Pix key, CLABE, CVU...
  description: z.string(),
  purposeCode: z.string().nullable(), // Brazil FX purpose code
  lowConfidence: z.array(z.string()), // field names the model was unsure about
});
export type Invoice = z.infer<typeof Invoice>;

/** PATCH /api/payouts/:id body. Editing a field clears it from lowConfidence. */
export const InvoicePatch = Invoice.omit({ lowConfidence: true }).partial();
export type InvoicePatch = z.infer<typeof InvoicePatch>;

// ---- Routes and rules -----------------------------------------------------------

export const Offramp = z.object({
  id: z.string(),
  name: z.string(),
  country: Country,
  type: OfframpType,
  feePct: z.number().nonnegative(),
  assets: z.array(Asset).min(1),
  networks: z.array(Network).min(1),
  rail: LocalRail,
  minutes: z.number().int().positive(),
});
export type Offramp = z.infer<typeof Offramp>;

/** GET /api/offramps row: a provider from the registry, as it stands after approved registry updates. */
export const OfframpListing = Offramp.extend({
  enabled: z.boolean(), // false when a person switched it off in Customize
});
export type OfframpListing = z.infer<typeof OfframpListing>;

export const Route = z.object({
  id: z.string(), // e.g. "BR:usdc-base:br-sol", "BR:wire:swift"
  kind: z.enum(["wire", "stablecoin"]),
  asset: Asset.nullable(),
  network: Network.nullable(),
  offramp: Offramp.nullable(), // null for wire
  rail: LocalRail,
  feePct: z.number(),
  feeUsd: z.number(),
  minutes: z.number(),
  amountUsd: z.number(),
});
export type Route = z.infer<typeof Route>;

export const Outcome = z.enum(["pass", "warn", "block", "require_fields"]);
export type Outcome = z.infer<typeof Outcome>;

export const Source = z.object({ name: z.string(), url: z.url() });
export type Source = z.infer<typeof Source>;

export const CheckFn = z.enum(["always", "offrampTypeIn", "amountUsdAbove", "requireFields", "fxSpreadAbove"]);
export type CheckFn = z.infer<typeof CheckFn>;

/** One row of rules.json. */
export const Rule = z.object({
  id: z.string(),
  corridor: Country,
  title: z.string(),
  effectiveFrom: IsoDate.nullable(),
  effectiveTo: IsoDate.nullable(), // inclusive
  appliesTo: z.enum(["stablecoin", "wire", "any"]),
  check: z.object({ fn: CheckFn, params: z.record(z.string(), z.unknown()) }),
  outcome: Outcome.exclude(["pass"]),
  message: z.string(),
  source: Source,
  /**
   * Marks a block as a policy hold that a human can lift in the app. Only
   * "sanctions_signoff" exists today (VE-OFAC): a compliance reviewer records
   * what OFAC requires — nobody blocked is involved, or a general license
   * covers it — and the hold becomes a warning naming the sign-off.
   */
  liftedBy: z.enum(["sanctions_signoff"]).optional(),
});
export type Rule = z.infer<typeof Rule>;

export const RuleResult = z.object({
  ruleId: z.string(),
  title: z.string(),
  outcome: Outcome,
  message: z.string(),
  source: Source,
  effectiveFrom: IsoDate.nullable(),
  missingFields: z.array(z.string()).optional(),
});
export type RuleResult = z.infer<typeof RuleResult>;

export const RouteEvaluation = z.object({
  route: Route,
  results: z.array(RuleResult),
  compliant: z.boolean(),
});
export type RouteEvaluation = z.infer<typeof RouteEvaluation>;

// ---- Plan --------------------------------------------------------------------

export const PayoutStatus = z.enum([
  "draft", // created, not planned yet
  "needs_info",
  "blocked",
  "awaiting_second_approver",
  "ready",
  "approved",
  "rejected",
  "paid",
  "booked",
]);
export type PayoutStatus = z.infer<typeof PayoutStatus>;

export const ScreeningStatus = z.enum(["clear", "possible_match", "hit"]);
export type ScreeningStatus = z.infer<typeof ScreeningStatus>;

export const Screening = z.object({
  status: ScreeningStatus,
  match: z.string().optional(), // matched SDN name
  score: z.number().optional(), // 0..1
});
export type Screening = z.infer<typeof Screening>;

export const DemoScreening = Screening.extend({
  simulated: z.literal(true),
  listVersion: z.string(),
  matchedEntryId: z.string().optional(),
  programs: z.array(z.string()).optional(),
});
export type DemoScreening = z.infer<typeof DemoScreening>;

/** Output of the rules engine. Deterministic: same inputs + asOf → same JSON. */
export const Plan = z.object({
  payoutId: z.string(),
  asOf: IsoDate,
  rulesVersion: z.string(),
  screening: Screening,
  evaluations: z.array(RouteEvaluation), // every candidate route, ranked
  recommended: Route.nullable(), // cheapest compliant
  status: PayoutStatus,
  reasons: z.array(z.string()), // human-readable, from rule messages
});
export type Plan = z.infer<typeof Plan>;

/** A recommended-route change between two plans (slider "why" toast). */
export const Reroute = z.object({
  payoutId: z.string(),
  from: z.string().nullable(), // route id
  to: z.string().nullable(), // route id
  ruleId: z.string().nullable(), // rule that caused the change, if one did
  reason: z.string(), // e.g. "BR-561-EFX took effect: eFX providers can't settle with foreign counterparties in virtual assets"
});
export type Reroute = z.infer<typeof Reroute>;

// ---- Memo --------------------------------------------------------------------

/** LLM (or template) explanation of a Plan. Explains, never decides. */
export const Memo = z.object({
  summary: z.string(),
  routeRationale: z.string(),
  citedRuleIds: z.array(z.string()),
  warnings: z.array(z.string()),
  humanChecks: z.array(z.string()),
  vendorEmail: z.string().optional(),
  generatedBy: z.enum(["template", "llm"]).optional(), // template = built from the plan; llm = written by the model, citations checked
});
export type Memo = z.infer<typeof Memo>;

// ---- Policy and approvals ---------------------------------------------------------

export const Policy = z.object({
  secondApproverAboveUsd: z.number().nonnegative(),
  dailyCapUsd: z.number().nonnegative(),
});
export type Policy = z.infer<typeof Policy>;

export const ApproveRequest = z.object({
  approver: z.string().min(1), // user id (a name or email also works; controller / approver roles only)
  decision: z.enum(["approved", "rejected"]).default("approved"),
  comment: z.string().optional(),
});
export type ApproveRequest = z.infer<typeof ApproveRequest>;

/** POST /api/payouts/:id/screening-review. A possible match or hit blocks the payout until a person records this. */
export const ScreeningReviewRequest = z.object({
  reviewer: z.string().min(1), // user id, name or email (controller / approver only)
  decision: z.enum(["cleared", "confirmed_hit"]),
  note: z.string().min(1, "explain why"),
});
export type ScreeningReviewRequest = z.infer<typeof ScreeningReviewRequest>;

/**
 * POST /api/payouts/:id/sanctions-review. Releases a sanctions policy hold
 * (VE-OFAC, `liftedBy: "sanctions_signoff"`) or confirms it. A release covers
 * the payee as named and the bank details as reviewed: editing either puts
 * the hold back on the next plan.
 */
export const SanctionsReviewRequest = z.object({
  reviewer: z.string().min(1), // user id, name or email (controller / approver only)
  decision: z.enum(["released", "confirmed_blocked"]),
  /** OFAC general license relied on, e.g. "GL 57". Optional: the release can rest on "nobody blocked is involved". */
  licenseRef: z.string().trim().min(1).max(60).optional(),
  note: z.string().trim().min(1, "say what was checked"),
});
export type SanctionsReviewRequest = z.infer<typeof SanctionsReviewRequest>;

// ---- Security hold (prompt-injection defense) -------------------------------------

/** One instruction-like line found in an invoice's text. The quote is evidence: the person reads exactly what it says. */
export const SecurityFinding = z.object({
  pattern: z.string(), // scanner pattern name, e.g. "instruction-override"
  quote: z.string(),
});
export type SecurityFinding = z.infer<typeof SecurityFinding>;

export const SecurityHold = z.object({
  findings: z.array(SecurityFinding),
  status: z.enum(["active", "cleared", "confirmed_suspicious"]),
  reviewedBy: z.string().nullable().optional(), // name, when a person has decided
  reviewedAt: z.string().nullable().optional(),
  reviewNote: z.string().nullable().optional(),
  flaggedAt: z.string(),
});
export type SecurityHold = z.infer<typeof SecurityHold>;

/** POST /api/payouts/:id/security-review. A person clears the security hold or keeps the payout held. */
export const SecurityReviewRequest = z.object({
  reviewer: z.string().min(1), // user id, name or email (controller / approver only)
  decision: z.enum(["cleared", "confirmed_suspicious"]),
  note: z.string().trim().min(1, "say why"),
});
export type SecurityReviewRequest = z.infer<typeof SecurityReviewRequest>;

// ---- Rails, reconciliation and books -------------------------------------------------

export const RailMode = z.enum(["mock", "bridge", "blindpay"]);
export type RailMode = z.infer<typeof RailMode>;

export const JournalLine = z.object({
  lineNo: z.number().int().positive(),
  account: z.string(),
  description: z.string().nullable(),
  debit: z.number().nonnegative(),
  credit: z.number().nonnegative(),
});
export type JournalLine = z.infer<typeof JournalLine>;

export const JournalEntry = z.object({
  id: z.string().optional(),
  payoutId: z.string(),
  entryDate: IsoDate,
  description: z.string(),
  currency: z.literal("USD"),
  bookingRate: z.number(), // local per USD when the invoice was booked
  settleRate: z.number(), // local per USD at settlement
  lines: z.array(JournalLine),
});
export type JournalEntry = z.infer<typeof JournalEntry>;

export const ReconciliationStatus = z.enum(["matched", "exception"]);
export type ReconciliationStatus = z.infer<typeof ReconciliationStatus>;

/** GET /api/ledger row: a booked journal entry plus its payee and reconciliation result. */
export const LedgerEntry = JournalEntry.extend({
  id: z.string(),
  payeeName: z.string(),
  invoiceNumber: z.string(),
  routeLabel: z.string(), // "USDC · Base · Sol VASP · 0.85%"
  match: z.object({
    status: ReconciliationStatus,
    reason: z.string().nullable(), // set when status = exception
    txHash: z.string().nullable(), // what the invoice was matched to...
    railRef: z.string().nullable(), // ...on-chain, and on the local rail
    rail: LocalRail,
  }),
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;

// ---- Audit -------------------------------------------------------------------

export const AuditEventType = z.enum([
  "extracted",
  "edited",
  "screened",
  "screening_reviewed",
  "planned",
  "memo",
  "approved",
  "rejected",
  "paid",
  "reconciled",
  "asof_changed",
  "settings_changed",
  "sanctions_reviewed",
  "security_flagged",
  "security_reviewed",
]);
export type AuditEventType = z.infer<typeof AuditEventType>;

export const AuditEvent = z.object({
  seq: z.number().int().positive(),
  payoutId: z.string().nullable(),
  type: AuditEventType,
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string(), // ISO 8601, millisecond precision
  prevMac: z.string(),
  mac: z.string(),
  keyId: z.string(),
});
export type AuditEvent = z.infer<typeof AuditEvent>;

export const AuditVerifyResult = z.object({
  ok: z.boolean(),
  count: z.number().int(),
  brokenAt: z.number().int().optional(), // first bad seq
  reason: z.string().optional(),
  lastSignedSeq: z.number().int().nullable(),
});
export type AuditVerifyResult = z.infer<typeof AuditVerifyResult>;

// ---- Frontend-facing shapes (FRONTEND §5) ---------------------------------------------

export const RouteSummary = z.object({
  id: z.string(),
  label: z.string(), // "USDC · Base · Sol VASP · 0.85%"
  feePct: z.number(),
  minutes: z.number(),
});
export type RouteSummary = z.infer<typeof RouteSummary>;

export const PayoutSummary = z.object({
  id: z.string(),
  payeeName: z.string(),
  country: Country,
  amountLocal: z.number(),
  currency: z.string(),
  amountUsd: z.number(),
  status: PayoutStatus,
  warnings: z.number().int(),
  recommended: RouteSummary.nullable(),
  /** True while an active security hold gates approval (the pill reads "Security hold"). */
  onSecurityHold: z.boolean().optional(),
});
export type PayoutSummary = z.infer<typeof PayoutSummary>;

export const PayoutDetail = PayoutSummary.extend({
  invoice: Invoice,
  plan: Plan.nullable(), // null while status = draft
  memo: Memo.nullable(),
  approvals: z.array(z.object({ approver: z.string(), approverId: z.string().uuid().optional(), role: z.enum(["first", "second"]), at: z.string() })),
  /** Latest compliance sign-off on the sanctions policy hold, once one exists. */
  sanctionsReview: z
    .object({
      decision: z.enum(["released", "confirmed_blocked"]),
      licenseRef: z.string().nullable(),
      by: z.string(),
      at: z.string(),
      note: z.string(),
    })
    .nullable()
    .optional(),
  /** Latest security hold (flagged instruction-like text), once one exists. */
  securityHold: SecurityHold.nullable().optional(),
  /** First 16 hex chars of the plan's sha256: same inputs and date always give the same one. */
  fingerprint: z.string().nullable().optional(),
  payment: z
    .object({
      txHash: z.string().nullable(),
      offrampRef: z.string().nullable(),
      railRef: z.string(),
      railMode: RailMode,
    })
    .optional(),
  journal: JournalEntry.optional(),
});
export type PayoutDetail = z.infer<typeof PayoutDetail>;

/** GET /api/payouts/:id/replay: recompute the plan n times and compare. */
export const ReplayResult = z.object({
  n: z.number().int(),
  identical: z.number().int(), // how many recomputations matched the first byte for byte
  matchesStored: z.boolean(), // and whether that equals the plan on file
  fingerprint: z.string(),
  ms: z.number(),
});
export type ReplayResult = z.infer<typeof ReplayResult>;

export const PlanAllResponse = z.object({
  payouts: z.array(PayoutSummary),
  reroutes: z.array(Reroute),
});
export type PlanAllResponse = z.infer<typeof PlanAllResponse>;

/** How the engine picks among routes that pass every rule. It can never pick a blocked one. */
export const Objective = z.enum(["cheapest", "fastest", "safest"]);
export type Objective = z.infer<typeof Objective>;

export const Settings = z.object({
  asOf: IsoDate,
  railMode: RailMode,
  policy: Policy,
  objective: Objective,
  disabledOfframps: z.array(z.string()), // off-ramp ids switched off by a person
  registry: z.record(z.string(), OfframpType), // provider-registry updates a person approved, by off-ramp id
});
export type Settings = z.infer<typeof Settings>;

/** PUT /api/settings. Every field is optional; each one that changes is written to the audit log. */
export const SettingsPatch = z.object({
  policy: Policy.optional(),
  objective: Objective.optional(),
  disabledOfframps: z.array(z.string()).optional(),
  registry: z.record(z.string(), OfframpType).optional(),
  by: z.string().min(1).optional(), // user id, name or email (controller / approver), recorded in the audit log
});
export type SettingsPatch = z.infer<typeof SettingsPatch>;

/** PUT /api/settings response: the new settings plus any reroutes they caused. */
export const SettingsUpdate = Settings.extend({ reroutes: z.array(Reroute) });
export type SettingsUpdate = z.infer<typeof SettingsUpdate>;

// ---- Agent (local LLM) ---------------------------------------------------------

/** One turn of the conversation, as the UI keeps it. */
export const AgentTurn = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(8000),
});
export type AgentTurn = z.infer<typeof AgentTurn>;

/** POST /api/agent/chat */
export const AgentChatRequest = z.object({
  messages: z.array(AgentTurn).min(1).max(40), // last one is the user's question
  asOf: IsoDate.optional(), // the UI's as-of date (defaults to the demo date)
});
export type AgentChatRequest = z.infer<typeof AgentChatRequest>;

export const AgentActionKind = z.enum(["approve", "pay", "reconcile", "email", "asof"]);
export type AgentActionKind = z.infer<typeof AgentActionKind>;

/** Something the agent prepared for a person to confirm. It never runs on its own. */
export const AgentProposal = z.object({
  kind: AgentActionKind,
  payoutId: z.string().nullable(),
  risk: z.enum(["High", "Medium", "Low"]),
  title: z.string(),
  why: z.string(),
  cites: z.array(z.string()),
  body: z.string().optional(), // email draft
  asOf: IsoDate.optional(), // for kind "asof"
});
export type AgentProposal = z.infer<typeof AgentProposal>;

export const AgentReply = z.object({
  text: z.string(),
  tools: z.array(z.string()), // the tool calls it made, e.g. get_payout("Estúdio Paulista")
  cites: z.array(z.string()), // rule ids it cited that exist in the pack
  removedCites: z.array(z.string()), // ids it made up: removed by the citation guard
  actions: z.array(AgentProposal),
  model: z.string(),
  ms: z.number(),
});
export type AgentReply = z.infer<typeof AgentReply>;

/** GET /api/agent/status */
export const AgentStatus = z.object({
  available: z.boolean(), // Ollama is running and the model is pulled
  model: z.string(),
  provider: z.string(),
});
export type AgentStatus = z.infer<typeof AgentStatus>;

export const Health = z.object({
  db: z.boolean(),
  llm: z.boolean(), // the local model is reachable and pulled
  model: z.string().nullable(),
});
export type Health = z.infer<typeof Health>;

export const ApiError = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type ApiError = z.infer<typeof ApiError>;
