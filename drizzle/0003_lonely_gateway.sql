CREATE TABLE "audit_checkpoints" (
	"seq" bigint PRIMARY KEY NOT NULL,
	"head_mac" text NOT NULL,
	"signature" text NOT NULL,
	"public_key_id" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "key_id" text DEFAULT '' NOT NULL;