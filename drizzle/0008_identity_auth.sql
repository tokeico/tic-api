CREATE SCHEMA "identity";
--> statement-breakpoint
CREATE TABLE "identity"."accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "identity"."api_keys" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"label" text NOT NULL,
	"prefix" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity"."auth_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity"."invitations" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"created_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_role_check" CHECK ("identity"."invitations"."role" IN ('approver', 'ap_clerk', 'auditor'))
);
--> statement-breakpoint
CREATE TABLE "identity"."memberships" (
	"account_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_account_id_workspace_id_pk" PRIMARY KEY("account_id","workspace_id"),
	CONSTRAINT "memberships_role_check" CHECK ("identity"."memberships"."role" IN ('controller', 'approver', 'ap_clerk', 'auditor'))
);
--> statement-breakpoint
CREATE TABLE "identity"."rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity"."sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity"."workspaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"schema_name" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_schema_name_unique" UNIQUE("schema_name")
);
--> statement-breakpoint
ALTER TABLE "identity"."api_keys" ADD CONSTRAINT "api_keys_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "identity"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."api_keys" ADD CONSTRAINT "api_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "identity"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."auth_events" ADD CONSTRAINT "auth_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "identity"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."invitations" ADD CONSTRAINT "invitations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "identity"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."invitations" ADD CONSTRAINT "invitations_created_by_accounts_id_fk" FOREIGN KEY ("created_by") REFERENCES "identity"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."memberships" ADD CONSTRAINT "memberships_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "identity"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."memberships" ADD CONSTRAINT "memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "identity"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."sessions" ADD CONSTRAINT "sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "identity"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."sessions" ADD CONSTRAINT "sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "identity"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."workspaces" ADD CONSTRAINT "workspaces_owner_id_accounts_id_fk" FOREIGN KEY ("owner_id") REFERENCES "identity"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_account_idx" ON "identity"."api_keys" USING btree ("account_id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_user_uq" ON "identity"."memberships" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "sessions_account_idx" ON "identity"."sessions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "sessions_expiry_idx" ON "identity"."sessions" USING btree ("expires_at");