import { check, index, integer, pgSchema, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { MemberRole } from "../security/principal";

const identity = pgSchema("identity");
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const authAccounts = identity.table("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: createdAt(),
});

export const authWorkspaces = identity.table("workspaces", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  schemaName: text("schema_name").notNull().unique(),
  ownerId: uuid("owner_id").notNull().references(() => authAccounts.id),
  createdAt: createdAt(),
});

export const authMemberships = identity.table("memberships", {
  accountId: uuid("account_id").notNull().references(() => authAccounts.id),
  workspaceId: uuid("workspace_id").notNull().references(() => authWorkspaces.id),
  userId: uuid("user_id").notNull(),
  role: text("role").$type<MemberRole>().notNull(),
  createdAt: createdAt(),
}, (t) => [
  primaryKey({ columns: [t.accountId, t.workspaceId] }),
  uniqueIndex("memberships_user_uq").on(t.workspaceId, t.userId),
  check("memberships_role_check", sql`${t.role} IN ('controller', 'approver', 'ap_clerk', 'auditor')`),
]);

export const authSessions = identity.table("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  accountId: uuid("account_id").notNull().references(() => authAccounts.id),
  workspaceId: uuid("workspace_id").notNull().references(() => authWorkspaces.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
}, (t) => [index("sessions_account_idx").on(t.accountId), index("sessions_expiry_idx").on(t.expiresAt)]);

export const authApiKeys = identity.table("api_keys", {
  tokenHash: text("token_hash").primaryKey(),
  accountId: uuid("account_id").notNull().references(() => authAccounts.id),
  workspaceId: uuid("workspace_id").notNull().references(() => authWorkspaces.id),
  label: text("label").notNull(),
  prefix: text("prefix").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index("api_keys_account_idx").on(t.accountId, t.workspaceId)]);

export const authInvitations = identity.table("invitations", {
  tokenHash: text("token_hash").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => authWorkspaces.id),
  email: text("email").notNull(),
  role: text("role").$type<MemberRole>().notNull(),
  createdBy: uuid("created_by").notNull().references(() => authAccounts.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [check("invitations_role_check", sql`${t.role} IN ('approver', 'ap_clerk', 'auditor')`)]);

export const authRateLimits = identity.table("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const authEvents = identity.table("auth_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").references(() => authAccounts.id),
  action: text("action").notNull(),
  createdAt: createdAt(),
});
