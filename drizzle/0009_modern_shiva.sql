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
CREATE UNIQUE INDEX "vendors_country_tax_id_uq" ON "vendors" USING btree ("country","tax_id");--> statement-breakpoint
-- Workspace schemas (w_<32hex>) are cloned from public at provisioning time; root
-- migrations don't reach them, so upgrade every existing tenant in place.
DO $$
DECLARE
  s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^w_[a-f0-9]{32}$' LOOP
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I.vendors (LIKE public.vendors INCLUDING ALL)', s);
    EXECUTE format('ALTER TABLE %I.vendors ADD CONSTRAINT vendors_verified_by_users_id_fk FOREIGN KEY (verified_by) REFERENCES %I.users(id) ON DELETE no action ON UPDATE no action', s, s);
    EXECUTE format('ALTER TABLE %I.approvals ADD COLUMN IF NOT EXISTS acknowledged_warnings text[] NOT NULL DEFAULT ''{}''', s);
    EXECUTE format($v$INSERT INTO %I.vendors (country, tax_id, name, bank_id_type, bank_id_value, verified_by, verified_at, verification_note, source) VALUES
      ('BR', '12345678000195', 'Estúdio Paulista Design Ltda', 'pix', '7d9f0a52-3c1e-4b8a-9e6f-2a4c8b1d5e30', NULL, now(), 'Demo vendor record (seeded)', 'seed'),
      ('MX', 'ADN0105149K3', 'Autopartes del Norte S.A. de C.V.', 'spei', '012580001234567897', NULL, now(), 'Demo vendor record (seeded)', 'seed'),
      ('AR', '27312345671', 'Lucía Fernández', 'cvu', '0000003110000123456781', NULL, now(), 'Demo vendor record (seeded)', 'seed'),
      ('VE', 'J301234567', 'Transportes Orinoco C.A.', 'swift', 'DEMOVECAXXX', NULL, now(), 'Demo vendor record (seeded)', 'seed')
      ON CONFLICT (country, tax_id) DO NOTHING$v$, s);
  END LOOP;
  -- public holds demo data only when it was seeded; a clean install skips this.
  IF EXISTS (SELECT 1 FROM public.invoices WHERE source = 'seed' LIMIT 1) THEN
    EXECUTE format($v$INSERT INTO %I.vendors (country, tax_id, name, bank_id_type, bank_id_value, verified_by, verified_at, verification_note, source) VALUES
      ('BR', '12345678000195', 'Estúdio Paulista Design Ltda', 'pix', '7d9f0a52-3c1e-4b8a-9e6f-2a4c8b1d5e30', NULL, now(), 'Demo vendor record (seeded)', 'seed'),
      ('MX', 'ADN0105149K3', 'Autopartes del Norte S.A. de C.V.', 'spei', '012580001234567897', NULL, now(), 'Demo vendor record (seeded)', 'seed'),
      ('AR', '27312345671', 'Lucía Fernández', 'cvu', '0000003110000123456781', NULL, now(), 'Demo vendor record (seeded)', 'seed'),
      ('VE', 'J301234567', 'Transportes Orinoco C.A.', 'swift', 'DEMOVECAXXX', NULL, now(), 'Demo vendor record (seeded)', 'seed')
      ON CONFLICT (country, tax_id) DO NOTHING$v$, 'public');
  END IF;
END $$;
