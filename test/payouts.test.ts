// Integration test for /api/payouts and /api/plan-all against a real Postgres.
// Runs only when TEST_DATABASE_URL points at a database whose name ends in
// "_test" (it wipes and reseeds it). See .env.example for the one-time setup.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";

const url = process.env.TEST_DATABASE_URL;
const enabled = Boolean(url && /_test$/.test(new URL(url).pathname.slice(1)));
const suite = enabled ? describe : describe.skip;
if (!enabled) console.warn("payouts.test.ts skipped: set TEST_DATABASE_URL to a *_test database");

type Json = Record<string, any>;
let app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> };
let dbmod: typeof import("../src/db");
let audit: typeof import("../src/services/audit-log");

const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> => {
  const res = await app.request(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Json };
};
const get = (p: string) => call("GET", p);
const post = (p: string, b?: unknown) => call("POST", p, b);

let ids: Record<"br" | "mx" | "ar" | "ve", string>;

suite("payouts API (Postgres)", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url!;
    process.env.RAIL_MODE = "mock";
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    process.env.AUDIT_HMAC_KEY = randomBytes(32).toString("hex");
    process.env.AUDIT_SIGNING_KEY = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    process.env.AUDIT_PUBLIC_KEY = publicKey.export({ format: "der", type: "spki" }).toString("base64");

    const seed = Bun.spawnSync(["bun", "run", "src/db/seed.ts"], { env: { ...process.env, DATABASE_URL: url! }, stdout: "pipe", stderr: "pipe" });
    if (seed.exitCode !== 0) throw new Error(`seed failed: ${seed.stderr.toString()}`);

    dbmod = await import("../src/db");
    audit = await import("../src/services/audit-log");
    audit.resetAuditKeys();
    app = (await import("../src/index")).app;
  });
  afterAll(async () => {
    await dbmod?.client.close();
  });

  const summary = (list: Json[], id: string) => list.find((p) => p.id === id)!;

  test("lists the four demo payouts in PRD order, all draft", async () => {
    const { status, json } = await get("/api/payouts");
    expect(status).toBe(200);
    expect(json.map((p: Json) => p.country)).toEqual(["BR", "MX", "AR", "VE"]);
    expect(json.every((p: Json) => p.status === "draft" && p.recommended === null)).toBe(true);
    ids = { br: json[0].id, mx: json[1].id, ar: json[2].id, ve: json[3].id };
  });

  test("plan-all on Oct 17 gives the PRD §10 statuses", async () => {
    const { status, json } = await post("/api/plan-all?asOf=2026-10-17");
    expect(status).toBe(200);
    expect(json.reroutes).toEqual([]); // first plan: nothing to compare with
    const by = (id: string) => summary(json.payouts, id);
    expect(by(ids.br)).toMatchObject({ status: "ready", warnings: 1, recommended: { id: "BR:usdc-base:br-ponte" } });
    expect(by(ids.mx)).toMatchObject({ status: "awaiting_second_approver", recommended: { id: "MX:usdc-base:mx-puente" } });
    expect(by(ids.ar)).toMatchObject({ status: "ready", warnings: 1, recommended: { id: "AR:usdt-tron:ar-pampa" } });
    expect(by(ids.ve)).toMatchObject({ status: "blocked", recommended: null });
  });

  test("moving the date reroutes Brazil and names the rule", async () => {
    const reroute = async (asOf: string) => (await post(`/api/plan-all?asOf=${asOf}`)).json.reroutes as Json[];
    expect(await reroute("2026-09-30")).toMatchObject([{ payoutId: ids.br, to: "BR:usdc-base:br-pagafx", ruleId: "BR-561-EFX" }]);
    expect(await reroute("2026-10-01")).toMatchObject([{ payoutId: ids.br, to: "BR:usdc-base:br-ponte", ruleId: "BR-561-EFX" }]);
    expect(await reroute("2026-10-30")).toMatchObject([{ payoutId: ids.br, to: "BR:usdc-base:br-sol", ruleId: "BR-VASP-AUTH" }]);
    expect(await reroute("2026-10-30")).toEqual([]); // same date again: no change
    await reroute("2026-10-17");
    expect((await get(`/api/payouts/${ids.br}`)).json.plan.asOf).toBe("2026-10-17");
  });

  test("detail has the plan, invoice and no payment yet", async () => {
    const { status, json } = await get(`/api/payouts/${ids.br}`);
    expect(status).toBe(200);
    expect(json).toMatchObject({ id: ids.br, status: "ready", currency: "BRL", amountLocal: 85000, approvals: [] });
    expect(json.plan.evaluations.length).toBeGreaterThan(1);
    expect(json.payment).toBeUndefined();
    expect(json.journal).toBeUndefined();
  });

  test("input errors", async () => {
    expect((await get("/api/payouts/not-a-uuid")).status).toBe(404);
    expect((await get("/api/payouts/00000000-0000-4000-8000-000000000000")).json.error.code).toBe("not_found");
    expect((await post("/api/plan-all?asOf=2026-13-45")).json.error.code).toBe("invalid_as_of");
    expect((await post(`/api/payouts/${ids.br}/approve`, "{nope")).json.error.code).toBe("invalid_json");
    expect((await post(`/api/payouts/${ids.br}/approve`, {})).json.error.code).toBe("invalid_body");
    expect((await post(`/api/payouts/${ids.br}/approve`, { approver: "Nobody Here" })).json.error.code).toBe("user_not_found");
    expect((await post(`/api/payouts/${ids.br}/approve`, { approver: "sam@corredor.demo" })).json.error.code).toBe("not_authorized");
    expect((await get("/api/nope")).json.error.code).toBe("not_found");
  });

  test("a blocked payout can't be approved or paid", async () => {
    expect((await post(`/api/payouts/${ids.ve}/approve`, { approver: "Maria Torres" })).json.error.code).toBe("not_approvable");
    expect((await post(`/api/payouts/${ids.br}/pay`)).json.error.code).toBe("not_approved");
  });

  test("daily cap is enforced across payouts", async () => {
    const { db, schema } = dbmod;
    const { eq } = await import("drizzle-orm");
    const setCap = (dailyCapUsd: number) =>
      db.update(schema.settings).set({ value: { secondApproverAboveUsd: 50_000, dailyCapUsd } }).where(eq(schema.settings.key, "policy"));
    await setCap(17_000); // Brazil ~$15.7k fits, then Argentina ($4,000) would reach ~$19.7k
    expect((await post(`/api/payouts/${ids.br}/approve`, { approver: "Maria Torres", comment: "ok" })).status).toBe(200);
    const ar = await post(`/api/payouts/${ids.ar}/approve`, { approver: "Maria Torres" });
    expect(ar.status).toBe(409);
    expect(ar.json.error.code).toBe("daily_cap_exceeded");
    await setCap(150_000);
  });

  test("approvals: 2nd approver over $50k, different person, then approved", async () => {
    const first = await post(`/api/payouts/${ids.mx}/approve`, { approver: "Maria Torres" });
    expect(first.json).toMatchObject({ status: "awaiting_second_approver", approvals: [{ approver: "Maria Torres", role: "first" }] });
    const same = await post(`/api/payouts/${ids.mx}/approve`, { approver: "maria@corredor.demo" });
    expect(same.json.error.code).toBe("same_approver");
    const second = await post(`/api/payouts/${ids.mx}/approve`, { approver: "Daniel Reyes" });
    expect(second.json).toMatchObject({ status: "approved" });
    expect(second.json.approvals.map((a: Json) => a.role)).toEqual(["first", "second"]);
    expect((await post(`/api/payouts/${ids.mx}/approve`, { approver: "Daniel Reyes" })).status).toBe(409);
  });

  test("an approved payout is frozen: no edits, no re-plan, the slider skips it", async () => {
    expect((await call("PATCH", `/api/payouts/${ids.br}`, { description: "changed" })).json.error.code).toBe("plan_locked");
    expect((await post(`/api/payouts/${ids.br}/plan`)).json.error.code).toBe("plan_locked");
    const before = (await get(`/api/payouts/${ids.br}`)).json.plan;
    const moved = await post("/api/plan-all?asOf=2026-10-30");
    expect(moved.json.reroutes).toEqual([]);
    expect((await get(`/api/payouts/${ids.br}`)).json.plan).toEqual(before);
    await post("/api/plan-all?asOf=2026-10-17");
  });

  test("pay → reconcile books a balanced journal entry", async () => {
    expect((await post(`/api/payouts/${ids.br}/reconcile`)).json.error.code).toBe("not_paid");
    const paid = await post(`/api/payouts/${ids.br}/pay`);
    expect(paid.status).toBe(200);
    expect(paid.json.status).toBe("paid");
    expect(paid.json.payment).toMatchObject({ railMode: "mock", txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    expect(paid.json.payment.railRef).toMatch(/^E[0-9A-Z]{31}$/); // Pix end-to-end id
    expect((await post(`/api/payouts/${ids.br}/pay`)).json.error.code).toBe("not_approved"); // no double send

    const booked = await post(`/api/payouts/${ids.br}/reconcile`);
    expect(booked.status).toBe(200);
    expect(booked.json.status).toBe("booked");
    const lines = booked.json.journal.lines as Json[];
    const sum = (k: string) => Math.round(lines.reduce((s, l) => s + l[k], 0) * 100);
    expect(sum("debit")).toBe(sum("credit"));
    expect(lines.map((l) => l.account)).toContain("Bank & network fees");
    expect(lines.some((l) => /^FX (gain|loss)$/.test(l.account))).toBe(true);
    expect(booked.json.journal.bookingRate).toBe(5.4);
    expect((await post(`/api/payouts/${ids.br}/reconcile`)).json.error.code).toBe("not_paid");

    // Mexico: SPEI reference, no FX exposure assumptions beyond the mock move.
    const mx = await post(`/api/payouts/${ids.mx}/pay`);
    expect(mx.json.payment.railRef).toMatch(/^CORR/);
    expect((await post(`/api/payouts/${ids.mx}/reconcile`)).json.status).toBe("booked");
  });

  test("editing an invoice re-plans, re-screens and flags bad checksums", async () => {
    const badCvu = await call("PATCH", `/api/payouts/${ids.ar}`, { bankId: { type: "cvu", value: "0000003110000123456780" } });
    expect(badCvu.status).toBe(200);
    expect(badCvu.json.invoice.lowConfidence).toContain("bankId"); // checksum failed → "check this"
    const fixed = await call("PATCH", `/api/payouts/${ids.ar}`, { bankId: { type: "cvu", value: "0000003110000123456781" } });
    expect(fixed.json.invoice.lowConfidence).not.toContain("bankId");
    expect((await call("PATCH", `/api/payouts/${ids.ar}`, { amount: -5 })).json.error.code).toBe("invalid_body");
    expect((await call("PATCH", `/api/payouts/${ids.ar}`, { payeeCountry: "ZZ" })).json.error.code).toBe("invalid_body");

    const changed = await call("PATCH", `/api/payouts/${ids.ar}`, { amount: 90_000 });
    expect(changed.json).toMatchObject({ amountUsd: 90_000, status: "awaiting_second_approver" }); // over $50k now

    // A sanctioned name blocks until a person reviews it.
    const hit = await call("PATCH", `/api/payouts/${ids.ar}`, { payeeName: "Petróleos de Venezuela S.A." });
    expect(hit.json.status).toBe("blocked");
    expect(hit.json.plan.screening.status).toBe("hit");
    expect((await post(`/api/payouts/${ids.ar}/screening-review`, { reviewer: "Sam Ortiz", decision: "cleared", note: "x" })).json.error.code).toBe("not_authorized");
    expect((await post(`/api/payouts/${ids.ar}/screening-review`, { reviewer: "Priya Shah", decision: "cleared", note: "x" })).status).toBe(403);
    const confirmed = await post(`/api/payouts/${ids.ar}/screening-review`, { reviewer: "Daniel Reyes", decision: "confirmed_hit", note: "Matches SDN 26367" });
    expect(confirmed.json.status).toBe("blocked");

    const back = await call("PATCH", `/api/payouts/${ids.ar}`, { payeeName: "Lucía Fernández", amount: 4000 });
    expect(back.json).toMatchObject({ status: "ready" }); // name changed → screened afresh → clear
    expect((await post(`/api/payouts/${ids.ar}/screening-review`, { reviewer: "Daniel Reyes", decision: "cleared", note: "x" })).json.error.code).toBe("nothing_to_review");
  });

  test("audit chain: every step was logged and the whole chain verifies", async () => {
    const events = await audit.readAuditEvents(dbmod.db, { payoutId: ids.br });
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["screened", "planned", "approved", "paid", "reconciled"]));
    expect(events.some((e) => JSON.stringify(e.payload).includes("7d9f0a52"))).toBe(false); // no bank ids in the log
    const all = await audit.readAuditEvents(dbmod.db);
    expect(all.some((e) => e.type === "asof_changed")).toBe(true);
    expect(all.some((e) => e.type === "screening_reviewed")).toBe(true);
    const res = await audit.verifyAuditLog(dbmod.db);
    expect(res).toMatchObject({ ok: true, count: all.length });
    expect(res.lastSignedSeq).not.toBeNull(); // checkpoints were signed (every 10 events and on booking)
  });

  test("the audit log can't be rewritten", async () => {
    const { sql } = await import("drizzle-orm");
    await expect((async () => dbmod.db.execute(sql`UPDATE audit_events SET payload = '{}'::jsonb`))()).rejects.toThrow();
    await expect((async () => dbmod.db.execute(sql`DELETE FROM audit_events`))()).rejects.toThrow();
  });
});
