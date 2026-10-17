// Audit chain (ARCHITECTURE §12): the chain verifies, editing one payload
// breaks it at that seq, and a forged checkpoint signature fails.
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import {
  GENESIS_MAC,
  chainEvent,
  loadAuditKeys,
  shouldCheckpoint,
  signCheckpoint,
  verifyChain,
  type AuditCheckpoint,
  type AuditKeys,
} from "../src/corredor";
import type { AuditEvent } from "../src/contracts";

function makeKeys(): AuditKeys {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return loadAuditKeys({
    AUDIT_HMAC_KEY: randomBytes(32).toString("hex"),
    AUDIT_SIGNING_KEY: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    AUDIT_PUBLIC_KEY: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  });
}

const TYPES = ["extracted", "screened", "planned", "memo", "approved", "paid", "reconciled"] as const;

function buildLog(keys: AuditKeys, n = 25) {
  const events: AuditEvent[] = [];
  const checkpoints: AuditCheckpoint[] = [];
  for (let seq = 1; seq <= n; seq++) {
    const ev = chainEvent(keys, events.at(-1) ?? null, {
      seq,
      payoutId: `p-${seq % 4}`,
      type: TYPES[seq % TYPES.length]!,
      payload: { step: seq, nested: { amountUsd: 15740.74, ok: true } },
      createdAt: new Date(Date.UTC(2026, 9, 17, 12, 0, seq)).toISOString(),
    });
    events.push(ev);
    if (shouldCheckpoint(ev)) checkpoints.push(signCheckpoint(keys, ev, ev.createdAt));
  }
  return { events, checkpoints };
}

const full = (k: AuditKeys) => ({ hmacKeys: k.hmacKeys, publicKey: k.publicKey });

describe("audit chain", () => {
  test("a clean chain verifies, with signed checkpoints", () => {
    const keys = makeKeys();
    const { events, checkpoints } = buildLog(keys);
    expect(events[0]!.prevMac).toBe(GENESIS_MAC);
    expect(events[0]!.mac).toHaveLength(128);
    const res = verifyChain(events, checkpoints, full(keys));
    expect(res).toMatchObject({ ok: true, count: 25 });
    expect(res.lastSignedSeq).toBe(checkpoints.at(-1)!.seq);
  });

  test("editing one payload breaks the chain at that seq", () => {
    const keys = makeKeys();
    const { events, checkpoints } = buildLog(keys);
    const tampered = events.map((e) => (e.seq === 7 ? { ...e, payload: { ...e.payload, step: 700 } } : e));
    expect(verifyChain(tampered, checkpoints, full(keys))).toMatchObject({ ok: false, brokenAt: 7 });
  });

  test("recomputing MACs without the key doesn't help", () => {
    const keys = makeKeys();
    const attacker = makeKeys(); // different HMAC key
    const { events, checkpoints } = buildLog(keys);
    // Rewrite event 12 and re-chain everything after it with the wrong key.
    const forged: AuditEvent[] = events.slice(0, 11);
    for (const e of events.slice(11)) {
      const payload = e.seq === 12 ? { ...e.payload, step: -1 } : e.payload;
      const re = chainEvent(attacker, forged.at(-1)!, { seq: e.seq, payoutId: e.payoutId, type: e.type, payload, createdAt: e.createdAt });
      forged.push({ ...re, keyId: e.keyId }); // pretend it was the real key
    }
    expect(verifyChain(forged, checkpoints, full(keys))).toMatchObject({ ok: false, brokenAt: 12 });
  });

  test("deleting a row is detected", () => {
    const keys = makeKeys();
    const { events, checkpoints } = buildLog(keys);
    const res = verifyChain(events.filter((e) => e.seq !== 5), checkpoints, full(keys));
    expect(res).toMatchObject({ ok: false, brokenAt: 6 });
  });

  test("truncating the tail is caught by the last checkpoint", () => {
    const keys = makeKeys();
    const { events, checkpoints } = buildLog(keys);
    const last = checkpoints.at(-1)!.seq;
    const res = verifyChain(events.filter((e) => e.seq < last), checkpoints, full(keys));
    expect(res).toMatchObject({ ok: false, brokenAt: last });
  });

  test("a forged checkpoint signature fails", () => {
    const keys = makeKeys();
    const { events, checkpoints } = buildLog(keys);
    const other = makeKeys();
    const forged = checkpoints.map((c, i) => (i === 0 ? signCheckpoint(other, { seq: c.seq, mac: c.headMac }, c.createdAt) : c));
    expect(verifyChain(events, forged, full(keys))).toMatchObject({ ok: false, brokenAt: checkpoints[0]!.seq, reason: expect.stringContaining("signature") });
  });

  test("auditors can verify checkpoints with the public key only", () => {
    const keys = makeKeys();
    const { events, checkpoints } = buildLog(keys);
    expect(verifyChain(events, checkpoints, { publicKey: keys.publicKey }).ok).toBe(true);
  });

  test("rotated keys still verify old rows", () => {
    const oldKeys = makeKeys();
    const { events } = buildLog(oldKeys, 5);
    const oldHex = oldKeys.hmacKeys[oldKeys.currentKeyId]!.toString("hex");
    const newKeys = loadAuditKeys({
      AUDIT_HMAC_KEY: randomBytes(32).toString("hex"),
      AUDIT_HMAC_KEYS_OLD: `${oldKeys.currentKeyId}:${oldHex}`,
    });
    const next = chainEvent(newKeys, events.at(-1)!, { seq: 6, payoutId: null, type: "asof_changed", payload: { asOf: "2026-10-30" }, createdAt: "2026-10-17T12:10:00.000Z" });
    expect(next.keyId).not.toBe(events[0]!.keyId);
    expect(verifyChain([...events, next], [], { hmacKeys: newKeys.hmacKeys }).ok).toBe(true);
  });

  test("key loading errors are explicit", () => {
    expect(() => loadAuditKeys({})).toThrow(/AUDIT_HMAC_KEY/);
    expect(() => loadAuditKeys({ AUDIT_HMAC_KEY: "abcd" })).toThrow(/32 bytes/);
  });
});
