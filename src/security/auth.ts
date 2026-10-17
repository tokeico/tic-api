import { randomBytes, createHash } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { adminDb, schema } from "../db";
import { ApiError } from "../http-error";
import type { Principal, MemberRole } from "./principal";
import { provisionWorkspace, seedWorkspace } from "./workspaces";

const { authAccounts: accounts, authWorkspaces: workspaces, authMemberships: members, authSessions: sessions, authApiKeys: keys, authInvitations: invitations, authRateLimits: limits, authEvents: events } = schema;
export const WEB_ORIGIN = new URL(process.env.WEB_ORIGIN ?? "http://localhost:8080").origin;
export const SECURE_COOKIE = process.env.NODE_ENV === "production" || WEB_ORIGIN.startsWith("https://");
export const SESSION_COOKIE = SECURE_COOKIE ? "__Host-corredor_session" : "corredor_session";
export const SESSION_SECONDS = 60 * 60 * 24 * 7;
/** Local demo login: created only by scripts/demo-admin.ts, which refuses non-local databases. */
export const DEMO_ADMIN_USERNAME = "admin";
export const DEMO_ADMIN_EMAIL = "admin@corredor.demo";
export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
export const newToken = (prefix: string) => prefix + randomBytes(32).toString("base64url");
const passwordOptions = { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 } as const;
const dummyHash = Bun.password.hash(randomBytes(32).toString("hex"), passwordOptions);
const schemaIdentifier = (value: string) => {
  if (!/^w_[a-f0-9]{32}$/.test(value)) throw new Error("Invalid workspace schema.");
  return sql.raw(`"${value}"`);
};

export async function rateLimit(subject: string, maximum: number, windowMs: number) {
  const now = new Date();
  const until = new Date(now.getTime() + windowMs);
  const [row] = await adminDb.insert(limits).values({ key: tokenHash(subject), count: 1, expiresAt: until })
    .onConflictDoUpdate({
      target: limits.key,
      set: {
        count: sql`CASE WHEN ${limits.expiresAt} <= ${now} THEN 1 ELSE ${limits.count} + 1 END`,
        expiresAt: sql`CASE WHEN ${limits.expiresAt} <= ${now} THEN ${until} ELSE ${limits.expiresAt} END`,
      },
    }).returning();
  if (row!.count > maximum) throw new ApiError(429, "rate_limited", "Too many requests. Please try again later.");
}

export async function principalFor(token: string, credential: Principal["credential"]): Promise<Principal | null> {
  if (token.length > 100 || !/^(?:cs_|ck_)[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const table = credential === "session" ? sessions : keys;
  const [row] = await adminDb.select({
    account: accounts, workspace: workspaces, member: members,
  }).from(table)
    .innerJoin(accounts, eq(table.accountId, accounts.id))
    .innerJoin(workspaces, eq(table.workspaceId, workspaces.id))
    .innerJoin(members, and(eq(members.accountId, accounts.id), eq(members.workspaceId, workspaces.id)))
    .where(and(eq(table.tokenHash, tokenHash(token)), gt(table.expiresAt, new Date()), credential === "apiKey" ? isNull(keys.revokedAt) : undefined)).limit(1);
  if (!row) return null;
  return {
    accountId: row.account.id, userId: row.member.userId, name: row.account.name, email: row.account.email,
    role: row.member.role, workspaceId: row.workspace.id, workspaceName: row.workspace.name,
    schemaName: row.workspace.schemaName, owner: row.workspace.ownerId === row.account.id,
    credential, tokenHash: tokenHash(token),
  };
}

export function publicUser(p: Principal) {
  return { id: p.accountId, memberId: p.userId, name: p.name, email: p.email, role: p.role, workspace: { id: p.workspaceId, name: p.workspaceName, owner: p.owner } };
}

export async function issueSession(accountId: string, workspaceId: string) {
  const token = newToken("cs_");
  await adminDb.insert(sessions).values({ tokenHash: tokenHash(token), accountId, workspaceId, expiresAt: new Date(Date.now() + SESSION_SECONDS * 1000) });
  return token;
}

export async function signUp(input: { name: string; email: string; password: string; invitation?: string; workspaceName?: string }) {
  const passwordHash = await Bun.password.hash(input.password, passwordOptions);
  return adminDb.transaction(async (tx) => {
    if (await tx.query.authAccounts.findFirst({ where: eq(accounts.email, input.email) })) {
      throw new ApiError(409, "account_unavailable", "Could not create an account with these details. Try signing in.");
    }
    const [account] = await tx.insert(accounts).values({ name: input.name, email: input.email, passwordHash }).returning();
    let workspaceId: string;
    if (input.invitation) {
      const [invite] = await tx.select().from(invitations).where(and(eq(invitations.tokenHash, tokenHash(input.invitation)), isNull(invitations.usedAt), gt(invitations.expiresAt, new Date()))).for("update");
      if (!invite || invite.email !== account!.email) throw new ApiError(400, "invalid_invitation", "This invitation is invalid, expired, or belongs to a different email.");
      const workspace = await tx.query.authWorkspaces.findFirst({ where: eq(workspaces.id, invite.workspaceId) });
      if (!workspace) throw new ApiError(400, "invalid_invitation", "This invitation is no longer available.");
      const userId = crypto.randomUUID();
      await tx.execute(sql`INSERT INTO ${schemaIdentifier(workspace.schemaName)}.users (id, name, email, role) VALUES (${userId}, ${account!.name}, ${account!.email}, ${invite.role}::public.user_role)`);
      await tx.insert(members).values({ accountId: account!.id, workspaceId: workspace.id, userId, role: invite.role });
      await tx.update(invitations).set({ usedAt: new Date() }).where(eq(invitations.tokenHash, invite.tokenHash));
      workspaceId = workspace.id;
    } else {
      workspaceId = crypto.randomUUID();
      const schemaName = `w_${workspaceId.replaceAll("-", "")}`;
      await tx.insert(workspaces).values({ id: workspaceId, name: input.workspaceName ?? `${account!.name}'s workspace`, schemaName, ownerId: account!.id });
      await provisionWorkspace(tx, schemaName);
      const userId = crypto.randomUUID();
      await seedWorkspace(tx, schemaName, { id: userId, name: account!.name, email: account!.email });
      await tx.insert(members).values({ accountId: account!.id, workspaceId, userId, role: "controller" });
    }
    await tx.insert(events).values({ accountId: account!.id, action: "signup" });
    return { accountId: account!.id, workspaceId };
  });
}

export async function signIn(email: string, password: string, invitation?: string) {
  const account = await adminDb.query.authAccounts.findFirst({ where: eq(accounts.email, email) });
  const verified = await Bun.password.verify(password, account?.passwordHash ?? await dummyHash);
  if (!account || !verified) {
    await adminDb.insert(events).values({ action: "signin_failed" });
    throw new ApiError(401, "invalid_credentials", "Invalid email or password.");
  }
  if (invitation) {
    const joined = await adminDb.transaction(async (tx) => {
      const [invite] = await tx.select().from(invitations).where(and(eq(invitations.tokenHash, tokenHash(invitation)), isNull(invitations.usedAt), gt(invitations.expiresAt, new Date()))).for("update");
      if (!invite || invite.email !== account.email) throw new ApiError(400, "invalid_invitation", "This invitation is invalid, expired, or belongs to a different email.");
      const workspace = await tx.query.authWorkspaces.findFirst({ where: eq(workspaces.id, invite.workspaceId) });
      if (!workspace) throw new ApiError(400, "invalid_invitation", "This invitation is no longer available.");
      const membership = await tx.query.authMemberships.findFirst({ where: and(eq(members.accountId, account.id), eq(members.workspaceId, workspace.id)) });
      if (!membership) {
        const userId = crypto.randomUUID();
        await tx.execute(sql`INSERT INTO ${schemaIdentifier(workspace.schemaName)}.users (id, name, email, role) VALUES (${userId}, ${account.name}, ${account.email}, ${invite.role}::public.user_role)`);
        await tx.insert(members).values({ accountId: account.id, workspaceId: workspace.id, userId, role: invite.role });
      }
      await tx.update(invitations).set({ usedAt: new Date() }).where(eq(invitations.tokenHash, invite.tokenHash));
      await tx.insert(events).values({ accountId: account.id, action: "invitation_accepted" });
      return { accountId: account.id, workspaceId: workspace.id };
    });
    return joined;
  }
  const membership = await adminDb.query.authMemberships.findFirst({ where: eq(members.accountId, account.id) });
  if (!membership) throw new ApiError(401, "invalid_credentials", "Invalid email or password.");
  await adminDb.insert(events).values({ accountId: account.id, action: "signin" });
  return { accountId: account.id, workspaceId: membership.workspaceId };
}

export async function createInvitation(p: Principal, email: string, role: Exclude<MemberRole, "controller">) {
  if (!p.owner || p.credential !== "session") throw new ApiError(403, "not_authorized", "Only the signed-in workspace owner can invite members.");
  const token = newToken("ci_");
  const expiresAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  await adminDb.insert(invitations).values({ tokenHash: tokenHash(token), workspaceId: p.workspaceId, email, role, createdBy: p.accountId, expiresAt });
  return { invitation: token, expiresAt: expiresAt.toISOString() };
}
