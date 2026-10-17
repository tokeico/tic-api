// Shared enum values and JSON shapes for the Corredor data model.
// Mirrors "Core types" (spec, Architecture §5). The `as const` arrays feed
// both the Postgres enums in schema.ts and the TypeScript unions below, so
// add a value here and then run `bun run db:generate`.

export const COUNTRIES = ["BR", "MX", "AR", "CO", "VE"] as const;
export type Country = (typeof COUNTRIES)[number];

export const LOCAL_RAILS = ["pix", "spei", "cvu", "pse", "swift"] as const;
export type LocalRail = (typeof LOCAL_RAILS)[number];

export const ASSETS = ["USDC", "USDT"] as const;
export type Asset = (typeof ASSETS)[number];

export const NETWORKS = ["base", "arbitrum", "tron"] as const;
export type Network = (typeof NETWORKS)[number];

export const OFFRAMP_TYPES = [
  "vasp_authorized",
  "vasp_pending",
  "vasp_unfiled",
  "efx",
  "bank",
  "nonbank_licensed",
  "psav_registered",
  "p2p_unregistered",
] as const;
export type OfframpType = (typeof OFFRAMP_TYPES)[number];

// Spec statuses plus `draft` (created, not planned yet) and `rejected`.
export const PAYOUT_STATUSES = [
  "draft",
  "needs_info",
  "blocked",
  "awaiting_second_approver",
  "ready",
  "approved",
  "rejected",
  "paid",
  "booked",
] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export const SCREENING_STATUSES = ["clear", "possible_match", "hit"] as const;
export type ScreeningStatus = (typeof SCREENING_STATUSES)[number];

export const SCREENING_REVIEW_DECISIONS = ["cleared", "confirmed_hit"] as const;
export type ScreeningReviewDecision = (typeof SCREENING_REVIEW_DECISIONS)[number];

export const USER_ROLES = ["controller", "approver", "ap_clerk", "auditor"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const APPROVAL_ROLES = ["first", "second"] as const;
export type ApprovalRole = (typeof APPROVAL_ROLES)[number];

export const APPROVAL_DECISIONS = ["approved", "rejected"] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export const RAIL_MODES = ["mock", "bridge", "blindpay"] as const;
export type RailMode = (typeof RAIL_MODES)[number];

export const PAYMENT_STATUSES = ["pending", "submitted", "settled", "failed"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const RECONCILIATION_STATUSES = ["matched", "exception"] as const;
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

export const INVOICE_SOURCES = ["upload", "seed"] as const;
export type InvoiceSource = (typeof INVOICE_SOURCES)[number];

export const EXTRACTION_SOURCES = ["claude", "cache", "manual", "seed"] as const;
export type ExtractionSource = (typeof EXTRACTION_SOURCES)[number];

export const MEMO_GENERATORS = ["claude", "template"] as const;
export type MemoGenerator = (typeof MEMO_GENERATORS)[number];

export const VENDOR_REQUEST_STATUSES = ["draft", "sent", "resolved"] as const;
export type VendorRequestStatus = (typeof VENDOR_REQUEST_STATUSES)[number];

export const AUDIT_EVENT_TYPES = [
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
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

// ---- JSON shapes stored in jsonb columns -----------------------------------
// Defined once in src/contracts.ts (shared with tic-web). Re-exported here so
// schema.ts keeps a single import site.

export type {
  Invoice as ExtractedInvoice,
  Offramp,
  Route,
  Outcome as RuleOutcome,
  RuleResult,
  RouteEvaluation,
  Plan,
  Policy,
} from "../contracts";
