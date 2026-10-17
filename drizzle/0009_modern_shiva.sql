ALTER TYPE "public"."audit_event_type" ADD VALUE 'bank_verified';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'approval_voided';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'settings_change_requested';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'settings_change_cancelled';--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"country" "country" NOT NULL,
	"tax_id" text NOT NULL,
	"name" text NOT NULL,
	"bank_id_type" "local_rail" NOT NULL,
	"bank_id_value" text NOT NULL,
	"verified_by" uuid,
	"verified_at" timestamp with time zone NOT NULL,
	"verification_note" text NOT NULL,
	"source" text DEFAULT 'callback' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendors_source" CHECK ("vendors"."source" IN ('seed', 'callback'))
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "acknowledged_warnings" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vendors_country_tax_id_uq" ON "vendors" USING btree ("country","tax_id");