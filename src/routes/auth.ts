import { Hono, type Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { adminDb, schema } from "../db";
import { ApiError } from "../http-error";
import { createInvitation, issueSession, newToken, principalFor, publicUser, rateLimit, SECURE_COOKIE, SESSION_COOKIE, SESSION_SECONDS, signIn, signUp, tokenHash } from "../security/auth";
import { requirePrincipal } from "../security/middleware";

const email = z.string().trim().toLowerCase().email().max(254);
const credentials = z.object({ email, password: z.string().min(1).max(128), invitation: z.string().regex(/^ci_[A-Za-z0-9_-]{43}$/).optional() });
const registration = credentials.extend({
  name: z.string().trim().min(1).max(80),
  password: z.string().min(15, "Use at least 15 characters.").max(128),
  invitation: z.string().regex(/^ci_[A-Za-z0-9_-]{43}$/).optional(),
  workspaceName: z.string().trim().min(1).max(80).optional(),
});
const cookieOptions = { httpOnly: true, secure: SECURE_COOKIE, sameSite: "Lax" as const, path: "/", maxAge: SESSION_SECONDS };

async function body<S extends z.ZodType>(c: Context, shape: S): Promise<z.infer<S>> {
  let value: unknown;
  try { value = await c.req.json(); } catch { throw new ApiError(400, "invalid_json", "Send a JSON request body."); }
  const parsed = shape.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "invalid_body", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return parsed.data;
}

async function establishSession(c: Context, account: { accountId: string; workspaceId: string }) {
  const token = await issueSession(account.accountId, account.workspaceId);
  const principal = await principalFor(token, "session");
  if (!principal) throw new Error("Could not establish the session.");
  setCookie(c, SESSION_COOKIE, token, cookieOptions);
  c.header("Cache-Control", "no-store");
  return { user: publicUser(principal) };
}

export const authRoutes = new Hono();
authRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});

authRoutes.post("/signup", async (c) => {
  const input = await body(c, registration);
  await rateLimit(`signup:email:${input.email}`, 5, 15 * 60_000);
  const account = await signUp(input);
  return c.json(await establishSession(c, account), 201);
});

authRoutes.post("/signin", async (c) => {
  const input = await body(c, credentials);
  await rateLimit(`signin:email:${input.email}`, 10, 15 * 60_000);
  return c.json(await establishSession(c, await signIn(input.email, input.password, input.invitation)));
});

authRoutes.get("/me", (c) => c.json({ user: publicUser(requirePrincipal()) }));

authRoutes.post("/signout", async (c) => {
  const p = requirePrincipal();
  if (p.credential !== "session") throw new ApiError(403, "session_required", "Sign out from a browser session.");
  await adminDb.update(schema.authSessions).set({ expiresAt: new Date() }).where(eq(schema.authSessions.tokenHash, p.tokenHash));
  await adminDb.insert(schema.authEvents).values({ accountId: p.accountId, action: "signout" });
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: SECURE_COOKIE, httpOnly: true, sameSite: "Lax" });
  return c.json({ ok: true });
});

authRoutes.get("/members", async (c) => {
  const p = requirePrincipal();
  const rows = await adminDb.select({ id: schema.authAccounts.id, name: schema.authAccounts.name, email: schema.authAccounts.email, role: schema.authMemberships.role })
    .from(schema.authMemberships).innerJoin(schema.authAccounts, eq(schema.authMemberships.accountId, schema.authAccounts.id))
    .where(eq(schema.authMemberships.workspaceId, p.workspaceId));
  return c.json(rows);
});

authRoutes.post("/invitations", async (c) => {
  const input = await body(c, z.object({ email, role: z.enum(["approver", "ap_clerk", "auditor"]) }));
  return c.json(await createInvitation(requirePrincipal(), input.email, input.role), 201);
});

authRoutes.get("/keys", async (c) => {
  const p = requirePrincipal();
  if (p.credential !== "session") throw new ApiError(403, "session_required", "Manage API keys from a signed-in browser.");
  return c.json(await adminDb.select({ id: schema.authApiKeys.tokenHash, label: schema.authApiKeys.label, prefix: schema.authApiKeys.prefix, expiresAt: schema.authApiKeys.expiresAt, revokedAt: schema.authApiKeys.revokedAt, createdAt: schema.authApiKeys.createdAt })
    .from(schema.authApiKeys).where(and(eq(schema.authApiKeys.accountId, p.accountId), eq(schema.authApiKeys.workspaceId, p.workspaceId))));
});

authRoutes.post("/keys", async (c) => {
  const p = requirePrincipal();
  if (p.credential !== "session") throw new ApiError(403, "session_required", "Create API keys from a signed-in browser.");
  const { label } = await body(c, z.object({ label: z.string().trim().min(1).max(80) }));
  const token = newToken("ck_");
  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
  await adminDb.insert(schema.authApiKeys).values({ tokenHash: tokenHash(token), accountId: p.accountId, workspaceId: p.workspaceId, label, prefix: `${token.slice(0, 7)}…${token.slice(-4)}`, expiresAt });
  return c.json({ token, expiresAt: expiresAt.toISOString(), readOnly: true }, 201);
});

authRoutes.post("/keys/:id/revoke", async (c) => {
  const p = requirePrincipal();
  if (p.credential !== "session") throw new ApiError(403, "session_required", "Revoke API keys from a signed-in browser.");
  if (!/^[a-f0-9]{64}$/.test(c.req.param("id"))) throw new ApiError(404, "not_found", "API key not found.");
  const rows = await adminDb.update(schema.authApiKeys).set({ revokedAt: new Date() })
    .where(and(eq(schema.authApiKeys.tokenHash, c.req.param("id")), eq(schema.authApiKeys.accountId, p.accountId), eq(schema.authApiKeys.workspaceId, p.workspaceId))).returning({ id: schema.authApiKeys.tokenHash });
  if (!rows.length) throw new ApiError(404, "not_found", "API key not found.");
  return c.json({ ok: true });
});
