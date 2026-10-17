CREATE TYPE "public"."sanctions_review_decision" AS ENUM('released', 'confirmed_blocked');--> statement-breakpoint
CREATE TYPE "public"."security_hold_status" AS ENUM('active', 'cleared', 'confirmed_suspicious');--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'sanctions_reviewed';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'security_flagged';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'security_reviewed';--> statement-breakpoint
CREATE TABLE "sanctions_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payout_id" uuid NOT NULL,
	"decision" "sanctions_review_decision" NOT NULL,
	"license_ref" text,
	"note" text NOT NULL,
	"reviewed_by" uuid NOT NULL,
	"payee_name" text NOT NULL,
	"bank_id_value" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payout_id" uuid NOT NULL,
	"findings" jsonb NOT NULL,
	"status" "security_hold_status" DEFAULT 'active' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sanctions_reviews" ADD CONSTRAINT "sanctions_reviews_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sanctions_reviews" ADD CONSTRAINT "sanctions_reviews_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_holds" ADD CONSTRAINT "security_holds_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_holds" ADD CONSTRAINT "security_holds_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sanctions_reviews_payout_idx" ON "sanctions_reviews" USING btree ("payout_id","created_at");--> statement-breakpoint
CREATE INDEX "security_holds_payout_idx" ON "security_holds" USING btree ("payout_id","created_at");