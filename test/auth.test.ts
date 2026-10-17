import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";

const url = process.env.TEST_AUTH_DATABASE_URL;
const enabled = Boolean(url && /_test$/.test(new URL(url).pathname));
const suite = enabled ? describe : describe.skip;
if (!enabled) console.warn("auth.test.ts skipped: set TEST_AUTH_DATABASE_URL to a migrated *_test database");

let app: typeof import("../src/index").app;
let database: typeof import("../src/db");
let security: typeof import("../src/security/auth");
const suffix = crypto.randomUUID();
const password = `Testing-only passphrase ${crypto.randomUUID()}`;
const owner = { name: `Test Owner ${suffix}`, email: `owner-${suffix}@example.test`, password, workspaceName: "Auth isolation test" };
const other = { name: `Other Owner ${suffix}`, email: `other-${suffix}@example.test`, password, workspaceName: "Other isolated workspace" };
let cookie = "";
let otherCookie = "";
let ownerUser: Record<string, any>;
let ownPayouts: Record<string, any>[];
let otherPayouts: Record<string, any>[];
let apiKey = "";
let apiKeyId = "";
let approverCookie = "";
let approverName = "";

async function call(path: string, options: { method?: string; body?: unknown; cookie?: string; key?: string; origin?: string } = {}) {
  const response = await app.request(path, {
    method: options.method ?? "GET",
    headers: {
      origin: options.origin ?? "http://localhost:8080",
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.key ? { authorization: `Bearer ${options.key}` } : {}),
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(path === "/mcp" ? { accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json().catch(() => null), cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "", headers: response.headers };
}

suite("database authentication and workspace isolation", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url!;
    process.env.RAIL_MODE = "mock";
    process.env.WEB_ORIGIN = "http://localhost:8080";
    const pair = generateKeyPairSync("ed25519");
    process.env.AUDIT_HMAC_KEY = randomBytes(32).toString("hex");
    process.env.AUDIT_SIGNING_KEY = pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    process.env.AUDIT_PUBLIC_KEY = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    database = await import("../src/db");
    security = await import("../src/security/auth");
    app = (await import("../src/index")).app;
  });
  afterAll(async () => { await database?.client.close(); });

  test("private API and MCP calls reject missing authentication", async () => {
    for (const path of ["/api/payouts", "/api/settings", "/api/audit", "/api/ledger", "/api/auth/me", "/mcp"]) {
      expect((await call(path)).status).toBe(401);
    }
  });

  test("sign-up checks origin and password requirements", async () => {
    expect((await call("/api/auth/signup", { method: "POST", body: owner, origin: "https://untrusted.example.test" })).status).toBe(403);
    expect((await call("/api/auth/signup", { method: "POST", body: { ...owner, password: "short" } })).status).toBe(400);
  });

  test("sign-up persists a real account, a private workspace and an HTTP-only session", async () => {
    const response = await call("/api/auth/signup", { method: "POST", body: owner });
    expect(response.status).toBe(201);
    cookie = response.cookie;
    ownerUser = response.body.user;
    expect(Boolean(cookie)).toBe(true);
    expect(response.headers.get("set-cookie")?.includes("HttpOnly")).toBe(true);
    expect(response.headers.get("set-cookie")?.includes("SameSite=Lax")).toBe(true);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.body.user.email).toBe(owner.email);
    expect(response.body.user.role).toBe("controller");
    expect("passwordHash" in response.body.user || "schemaName" in response.body.user || "tokenHash" in response.body.user).toBe(false);
    const account = await database.adminDb.query.authAccounts.findFirst({ where: eq(database.schema.authAccounts.email, owner.email) });
    expect(account?.passwordHash.startsWith("$argon2id$")).toBe(true);
    expect(account?.passwordHash === password).toBe(false);
    const session = await database.adminDb.query.authSessions.findFirst({ where: eq(database.schema.authSessions.tokenHash, security.tokenHash(cookie.split("=")[1]!)) });
    expect(Boolean(session)).toBe(true);
    expect((await call("/api/auth/me", { cookie })).body.user.id).toBe(ownerUser.id);
    expect((await call("/api/auth/signup", { method: "POST", body: owner })).status).toBe(409);
    const payouts = await call("/api/payouts", { cookie });
    expect(payouts.status).toBe(200);
    ownPayouts = payouts.body;
    expect(ownPayouts.map((p) => p.country)).toEqual(["BR", "MX", "AR", "VE"]);
    const members = await call("/api/auth/members", { cookie });
    expect(members.body.length).toBe(1);
    expect(members.body[0].name).toBe(owner.name);
  });

  test("another account cannot list or resolve the first account's payouts", async () => {
    const created = await call("/api/auth/signup", { method: "POST", body: other });
    expect(created.status).toBe(201);
    otherCookie = created.cookie;
    expect(created.body.user.workspace.id === ownerUser.workspace.id).toBe(false);
    otherPayouts = (await call("/api/payouts", { cookie: otherCookie })).body;
    expect(otherPayouts.some((row) => ownPayouts.some((p) => p.id === row.id))).toBe(false);
    expect((await call(`/api/payouts/${ownPayouts[0]!.id}`, { cookie: otherCookie })).status).toBe(404);
    const reads = await Promise.all(Array.from({ length: 8 }, (_, i) => call("/api/payouts", { cookie: i % 2 ? cookie : otherCookie })));
    for (let i = 0; i < reads.length; i++) expect(reads[i]!.body.map((p: Record<string, any>) => p.id)).toEqual((i % 2 ? ownPayouts : otherPayouts).map((p) => p.id));
  });

  test("bad credentials are rejected and sign-in issues a new persistent session", async () => {
    const wrong = await call("/api/auth/signin", { method: "POST", body: { email: owner.email, password: "wrong password" } });
    const unknown = await call("/api/auth/signin", { method: "POST", body: { email: `unknown-${suffix}@example.test`, password: "wrong password" } });
    expect(wrong.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
    const signedIn = await call("/api/auth/signin", { method: "POST", body: { email: owner.email.toUpperCase(), password } });
    expect(signedIn.status).toBe(200);
    expect(signedIn.cookie === cookie).toBe(false);
    expect((await call("/api/auth/me", { cookie: signedIn.cookie })).body.user.id).toBe(ownerUser.id);
    cookie = signedIn.cookie;
  });

  test("cookie writes reject cross-origin requests and the server records the real actor", async () => {
    expect((await call("/api/plan-all", { method: "POST", cookie, origin: "https://untrusted.example.test" })).status).toBe(403);
    expect((await call("/api/plan-all?asOf=2026-10-17", { method: "POST", cookie })).status).toBe(200);
    const approved = await call(`/api/payouts/${ownPayouts[1]!.id}/approve`, { method: "POST", cookie, body: { approver: "A spoofed identity", comment: "Reviewed this test payout" } });
    expect(approved.status).toBe(200);
    expect(approved.body.approvals[0].approver).toBe(owner.name);
    expect((await call(`/api/payouts/${ownPayouts[1]!.id}/approve`, { method: "POST", cookie, body: { approver: "Another spoofed identity" } })).status).toBe(409);
  });

  test("an invitation creates a different real approver in the same workspace", async () => {
    const email = `approver-${suffix}@example.test`;
    const invitation = await call("/api/auth/invitations", { method: "POST", cookie, body: { email, role: "approver" } });
    expect(invitation.status).toBe(201);
    expect((await call("/api/auth/invitations", { method: "POST", cookie, body: { email, role: "controller" } })).status).toBe(400);
    approverName = `Test Approver ${suffix}`;
    const registered = await call("/api/auth/signup", { method: "POST", body: { name: approverName, email, password, invitation: invitation.body.invitation } });
    expect(registered.status).toBe(201);
    approverCookie = registered.cookie;
    expect(registered.body.user.workspace.id).toBe(ownerUser.workspace.id);
    expect(registered.body.user.role).toBe("approver");
    const second = await call(`/api/payouts/${ownPayouts[1]!.id}/approve`, { method: "POST", cookie: approverCookie, body: { approver: owner.name } });
    expect(second.status).toBe(200);
    expect(second.body.status).toBe("approved");
    expect(second.body.approvals.map((a: Record<string, any>) => a.approver)).toEqual([owner.name, approverName]);
    expect((await call("/api/auth/invitations", { method: "POST", cookie: approverCookie, body: { email: "another@example.test", role: "approver" } })).status).toBe(403);
  });

  test("API keys are persisted hashed, workspace-bound and read-only", async () => {
    const created = await call("/api/auth/keys", { method: "POST", cookie, body: { label: "Auth integration test" } });
    expect(created.status).toBe(201);
    apiKey = created.body.token;
    expect(apiKey.startsWith("ck_")).toBe(true);
    const keys = await call("/api/auth/keys", { cookie });
    apiKeyId = keys.body[0].id;
    expect(JSON.stringify(keys.body).includes(apiKey)).toBe(false);
    expect((await call("/api/payouts", { key: apiKey })).status).toBe(200);
    expect((await call(`/api/payouts/${otherPayouts[0]!.id}`, { key: apiKey })).status).toBe(404);
    for (const path of ["/api/plan-all", `/api/payouts/${ownPayouts[0]!.id}/pay`, "/api/auth/keys", "/api/demo/reset"]) expect((await call(path, { method: "POST", key: apiKey, body: {} })).status).toBe(403);
  });

  test("MCP exposes only read-only tools and preserves workspace isolation", async () => {
    const rpc = (method: string, params?: unknown) => call("/mcp", { method: "POST", key: apiKey, body: { jsonrpc: "2.0", id: 1, method, params } });
    const initialized = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "auth-isolation-test", version: "1.0.0" } });
    expect(initialized.status).toBe(200);
    expect(initialized.body.result.serverInfo.name).toBe("corredor");
    const listed = await rpc("tools/list", {});
    expect(listed.status).toBe(200);
    const tools = listed.body.result.tools;
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((t: Record<string, any>) => t.annotations.readOnlyHint && !t.annotations.destructiveHint)).toBe(true);
    expect(tools.some((t: Record<string, any>) => /^(?:approve|pay|clear|edit|reset)/.test(t.name))).toBe(false);
    const own = await rpc("tools/call", { name: "get_payout", arguments: { id: ownPayouts[0]!.id } });
    expect(JSON.parse(own.body.result.content[0].text).id).toBe(ownPayouts[0]!.id);
    const denied = await rpc("tools/call", { name: "get_payout", arguments: { id: otherPayouts[0]!.id } });
    expect(denied.body.result.isError).toBe(true);
  });

  test("revoking a key and signing out invalidate the stored credentials", async () => {
    expect((await call(`/api/auth/keys/${apiKeyId}/revoke`, { method: "POST", cookie })).status).toBe(200);
    expect((await call("/api/payouts", { key: apiKey })).status).toBe(401);
    expect((await call("/api/auth/signout", { method: "POST", cookie })).status).toBe(200);
    expect((await call("/api/auth/me", { cookie })).status).toBe(401);
    expect((await call("/api/auth/me", { cookie: approverCookie })).status).toBe(200);
  });
});
