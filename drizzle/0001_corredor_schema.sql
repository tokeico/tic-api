CREATE TYPE "public"."approval_decision" AS ENUM('approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."approval_role" AS ENUM('first', 'second');--> statement-breakpoint
CREATE TYPE "public"."audit_event_type" AS ENUM('extracted', 'edited', 'screened', 'screening_reviewed', 'planned', 'memo', 'approved', 'rejected', 'paid', 'reconciled', 'asof_changed');--> statement-breakpoint
CREATE TYPE "public"."country" AS ENUM('BR', 'MX', 'AR', 'CO', 'VE');--> statement-breakpoint
CREATE TYPE "public"."extraction_source" AS ENUM('claude', 'cache', 'manual', 'seed');--> statement-breakpoint
CREATE TYPE "public"."invoice_source" AS ENUM('upload', 'seed');--> statement-breakpoint
CREATE TYPE "public"."local_rail" AS ENUM('pix', 'spei', 'cvu', 'pse', 'swift');--> statement-breakpoint
CREATE TYPE "public"."memo_generator" AS ENUM('claude', 'template');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'submitted', 'settled', 'failed');--> statement-breakpoint
CREATE TYPE "public"."payout_status" AS ENUM('draft', 'needs_info', 'blocked', 'awaiting_second_approver', 'ready', 'approved', 'rejected', 'paid', 'booked');--> statement-breakpoint
CREATE TYPE "public"."rail_mode" AS ENUM('mock', 'bridge', 'blindpay');--> statement-breakpoint
CREATE TYPE "public"."reconciliation_status" AS ENUM('matched', 'exception');--> statement-breakpoint
CREATE TYPE "public"."screening_review_decision" AS ENUM('cleared', 'confirmed_hit');--> statement-breakpoint
CREATE TYPE "public"."screening_status" AS ENUM('clear', 'possible_match', 'hit');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('controller', 'approver', 'ap_clerk', 'auditor');--> statement-breakpoint
CREATE TYPE "public"."vendor_request_status" AS ENUM('draft', 'sent', 'resolved');--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payout_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"approver_id" uuid NOT NULL,
	"role" "approval_role" NOT NULL,
	"decision" "approval_decision" NOT NULL,
	"amount_usd" numeric(18, 2) NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_events_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"payout_id" uuid,
	"actor_id" uuid,
	"type" "audit_event_type" NOT NULL,
	"payload" jsonb NOT NULL,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "extraction_cache" (
	"pdf_sha256" text PRIMARY KEY NOT NULL,
	"invoice" jsonb NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_number" text NOT NULL,
	"payee_name" text NOT NULL,
	"payee_country" "country" NOT NULL,
	"payee_tax_id" text,
	"payee_email" text,
	"amount" numeric(18, 2) NOT NULL,
	"currency" text NOT NULL,
	"due_date" date,
	"bank_id_type" "local_rail",
	"bank_id_value" text,
	"description" text DEFAULT '' NOT NULL,
	"purpose_code" text,
	"low_confidence" text[] DEFAULT '{}'::text[] NOT NULL,
	"source" "invoice_source" DEFAULT 'upload' NOT NULL,
	"extraction_source" "extraction_source" NOT NULL,
	"pdf_sha256" text,
	"pdf_filename" text,
	"raw_extraction" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_amount_positive" CHECK ("invoices"."amount" > 0),
	CONSTRAINT "invoices_currency_iso" CHECK ("invoices"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "invoices_bank_id_pair" CHECK (("invoices"."bank_id_type" IS NULL) = ("invoices"."bank_id_value" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payout_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"entry_date" date NOT NULL,
	"description" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"booking_rate" numeric(18, 8) NOT NULL,
	"settle_rate" numeric(18, 8) NOT NULL,
	"exported_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_entries_payment_id_unique" UNIQUE("payment_id")
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"account" text NOT NULL,
	"description" text,
	"debit" numeric(18, 2) DEFAULT 0 NOT NULL,
	"credit" numeric(18, 2) DEFAULT 0 NOT NULL,
	CONSTRAINT "journal_lines_one_side" CHECK ("journal_lines"."debit" >= 0 AND "journal_lines"."credit" >= 0 AND ("journal_lines"."debit" = 0 OR "journal_lines"."credit" = 0))
);
--> statement-breakpoint
CREATE TABLE "memos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"plan_hash" text NOT NULL,
	"summary" text NOT NULL,
	"route_rationale" text NOT NULL,
	"cited_rule_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"warnings" text[] DEFAULT '{}'::text[] NOT NULL,
	"human_checks" text[] DEFAULT '{}'::text[] NOT NULL,
	"generated_by" "memo_generator" NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payout_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"route_id" text NOT NULL,
	"route" jsonb NOT NULL,
	"rail_mode" "rail_mode" NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"amount_usd" numeric(18, 2) NOT NULL,
	"fee_usd" numeric(18, 2) NOT NULL,
	"local_currency" text NOT NULL,
	"settled_local" numeric(18, 2),
	"settle_rate" numeric(18, 8),
	"tx_hash" text,
	"offramp_ref" text,
	"rail_ref" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"status" "payout_status" DEFAULT 'draft' NOT NULL,
	"as_of" date,
	"amount_usd" numeric(18, 2),
	"recommended_route_id" text,
	"has_warnings" boolean DEFAULT false NOT NULL,
	"approved_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"booked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payouts_invoice_id_unique" UNIQUE("invoice_id")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payout_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"rules_version" text NOT NULL,
	"status" "payout_status" NOT NULL,
	"screening_status" "screening_status" NOT NULL,
	"recommended_route_id" text,
	"recommended" jsonb,
	"evaluations" jsonb NOT NULL,
	"reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"plan" jsonb NOT NULL,
	"plan_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payout_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"status" "reconciliation_status" NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliations_payment_id_unique" UNIQUE("payment_id")
);
--> statement-breakpoint
CREATE TABLE "screenings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payout_id" uuid NOT NULL,
	"payee_name" text NOT NULL,
	"status" "screening_status" NOT NULL,
	"matched_name" text,
	"matched_entry_id" text,
	"score" numeric(5, 4),
	"list_version" text NOT NULL,
	"review_decision" "screening_review_decision",
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "screenings_score_range" CHECK ("screenings"."score" IS NULL OR ("screenings"."score" >= 0 AND "screenings"."score" <= 1))
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendor_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payout_id" uuid NOT NULL,
	"missing_fields" text[] NOT NULL,
	"to_email" text,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"status" "vendor_request_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Hand-edited: 0000's example "users" table (serial id, always empty) can't be
-- cast to uuid, so it is dropped and recreated with the final shape.
DROP TABLE "users";--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"role" "user_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memos" ADD CONSTRAINT "memos_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screenings" ADD CONSTRAINT "screenings_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screenings" ADD CONSTRAINT "screenings_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_requests" ADD CONSTRAINT "vendor_requests_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_payout_role_uq" ON "approvals" USING btree ("payout_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_payout_approver_uq" ON "approvals" USING btree ("payout_id","approver_id");--> statement-breakpoint
CREATE INDEX "approvals_created_idx" ON "approvals" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_events_payout_idx" ON "audit_events" USING btree ("payout_id","seq");--> statement-breakpoint
CREATE INDEX "invoices_pdf_sha256_idx" ON "invoices" USING btree ("pdf_sha256");--> statement-breakpoint
CREATE INDEX "journal_entries_date_idx" ON "journal_entries" USING btree ("entry_date");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_lines_entry_line_uq" ON "journal_lines" USING btree ("entry_id","line_no");--> statement-breakpoint
CREATE INDEX "memos_plan_idx" ON "memos" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "memos_plan_hash_idx" ON "memos" USING btree ("plan_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_one_active_per_payout_uq" ON "payments" USING btree ("payout_id") WHERE "payments"."status" <> 'failed';--> statement-breakpoint
CREATE INDEX "payments_tx_hash_idx" ON "payments" USING btree ("tx_hash");--> statement-breakpoint
CREATE INDEX "payouts_status_idx" ON "payouts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "plans_payout_created_idx" ON "plans" USING btree ("payout_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "plans_plan_hash_idx" ON "plans" USING btree ("plan_hash");--> statement-breakpoint
CREATE INDEX "screenings_payout_idx" ON "screenings" USING btree ("payout_id","created_at");--> statement-breakpoint
CREATE INDEX "vendor_requests_payout_idx" ON "vendor_requests" USING btree ("payout_id");