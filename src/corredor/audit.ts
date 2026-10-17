// Tamper-evident audit log (ARCHITECTURE §12, DECISIONS D13).
//
// 1. Keyed chain:  mac_n = HMAC-SHA-512(key, mac_{n-1} ‖ canonicalJSON(event_n))
//    The key lives in secrets (AUDIT_HMAC_KEY), never in the DB, so someone
//    with DB write access can't rewrite a row and recompute the chain.
// 2. Signed checkpoints: every CHECKPOINT_EVERY events, and when a payout is
//    booked, the head MAC is signed with Ed25519 (AUDIT_SIGNING_KEY). Auditors
//    verify with the public key alone. Checkpoints also catch a truncated tail.
// 3. Key ids on every row allow rotation.
//
// Pure functions over rows. Persistence (insert with a known seq inside a
// transaction) is the route layer's job.

import { createHmac, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import type { AuditEvent, AuditEventType, AuditVerifyResult } from "../contracts";
import { canonicalJSON, sha256Hex } from "./util";

/** prev_mac of the first event: 128 hex zeros (SHA-512 width). */
export const GENESIS_MAC = "0".repeat(128);
export const CHECKPOINT_EVERY = 10;

export interface AuditKeys {
  /** HMAC keys by key id. `currentKeyId` signs new events; others verify old ones. */
  hmacKeys: Record<string, Buffer>;
  currentKeyId: string;
  signingKey: KeyObject | null;
  publicKey: KeyObject | null;
  publicKeyId: string | null;
}

/** An event before it's chained. createdAt must be an ISO string with ms precision. */
export interface NewAuditEvent {
  seq: number;
  payoutId: string | null;
  type: AuditEventType;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface AuditCheckpoint {
  seq: number;
  headMac: string;
  signature: string; // base64 Ed25519 signature over the head MAC bytes
  publicKeyId: string;
  createdAt: string;
}

// ---- Keys -------------------------------------------------------------------------

const decodeSecret = (s: string): Buffer => (/^[0-9a-f]+$/i.test(s) && s.length % 2 === 0 ? Buffer.from(s, "hex") : Buffer.from(s, "base64"));

/** Short public fingerprint of a key (sha256 prefix). */
export const keyFingerprint = (bytes: Uint8Array): string => sha256Hex(bytes).slice(0, 16);

export function parsePrivateKey(s: string): KeyObject {
  return s.includes("BEGIN") ? createPrivateKey(s) : createPrivateKey({ key: Buffer.from(s, "base64"), format: "der", type: "pkcs8" });
}

export function parsePublicKey(s: string): KeyObject {
  return s.includes("BEGIN") ? createPublicKey(s) : createPublicKey({ key: Buffer.from(s, "base64"), format: "der", type: "spki" });
}

export function publicKeyId(pub: KeyObject): string {
  return keyFingerprint(pub.export({ format: "der", type: "spki" }));
}

/**
 * Read keys from the environment:
 *   AUDIT_HMAC_KEY      hex or base64, ≥ 32 bytes          (required)
 *   AUDIT_HMAC_KEYS_OLD "id:key,id:key" for rotated keys   (optional)
 *   AUDIT_SIGNING_KEY   Ed25519 PKCS#8, PEM or base64 DER  (optional; no checkpoints without it)
 *   AUDIT_PUBLIC_KEY    Ed25519 SPKI, PEM or base64 DER    (optional; derived from the signing key)
 * Generate them with `bun run scripts/keys.ts`.
 */
export function loadAuditKeys(env: Record<string, string | undefined> = process.env): AuditKeys {
  const raw = env.AUDIT_HMAC_KEY;
  if (!raw) throw new Error("AUDIT_HMAC_KEY is not set. Run `bun run scripts/keys.ts` and add the output to .env");
  const key = decodeSecret(raw);
  if (key.length < 32) throw new Error("AUDIT_HMAC_KEY must be at least 32 bytes (256 bits)");
  const currentKeyId = `h-${keyFingerprint(key)}`;
  const hmacKeys: Record<string, Buffer> = { [currentKeyId]: key };
  for (const pair of (env.AUDIT_HMAC_KEYS_OLD ?? "").split(",").filter(Boolean)) {
    const [id, k] = pair.split(":");
    if (id && k) hmacKeys[id] = decodeSecret(k);
  }
  const signingKey = env.AUDIT_SIGNING_KEY ? parsePrivateKey(env.AUDIT_SIGNING_KEY) : null;
  const publicKey = env.AUDIT_PUBLIC_KEY ? parsePublicKey(env.AUDIT_PUBLIC_KEY) : signingKey ? createPublicKey(signingKey) : null;
  return { hmacKeys, currentKeyId, signingKey, publicKey, publicKeyId: publicKey ? publicKeyId(publicKey) : null };
}

// ---- Chain ---------------------------------------------------------------------------

/** The exact bytes that get MAC'd. keyId is included so it can't be swapped. */
export function eventBytes(ev: NewAuditEvent, keyId: string): string {
  return canonicalJSON({ seq: ev.seq, payoutId: ev.payoutId, type: ev.type, payload: ev.payload, createdAt: ev.createdAt, keyId });
}

export function computeMac(key: Buffer, prevMac: string, ev: NewAuditEvent, keyId: string): string {
  return createHmac("sha512", key).update(prevMac).update(eventBytes(ev, keyId)).digest("hex");
}

/** Chain a new event onto `prev` (null for the first event). */
export function chainEvent(keys: AuditKeys, prev: Pick<AuditEvent, "seq" | "mac"> | null, ev: NewAuditEvent): AuditEvent {
  if (prev && ev.seq <= prev.seq) throw new Error(`audit seq must increase (${ev.seq} after ${prev.seq})`);
  if (Number.isNaN(Date.parse(ev.createdAt))) throw new Error(`audit createdAt is not a timestamp: ${ev.createdAt}`);
  const prevMac = prev?.mac ?? GENESIS_MAC;
  const keyId = keys.currentKeyId;
  return { ...ev, prevMac, mac: computeMac(keys.hmacKeys[keyId]!, prevMac, ev, keyId), keyId };
}

/** Sign a checkpoint every CHECKPOINT_EVERY events and whenever a payout is booked. */
export function shouldCheckpoint(ev: Pick<AuditEvent, "seq" | "type">): boolean {
  return ev.seq % CHECKPOINT_EVERY === 0 || ev.type === "reconciled"; // reconciled = booked
}

export function signCheckpoint(keys: AuditKeys, head: Pick<AuditEvent, "seq" | "mac">, createdAt: string): AuditCheckpoint {
  if (!keys.signingKey || !keys.publicKeyId) throw new Error("AUDIT_SIGNING_KEY is not set; can't sign checkpoints");
  const signature = sign(null, Buffer.from(head.mac, "hex"), keys.signingKey).toString("base64");
  return { seq: head.seq, headMac: head.mac, signature, publicKeyId: keys.publicKeyId, createdAt };
}

export function verifyCheckpointSignature(cp: AuditCheckpoint, publicKey: KeyObject): boolean {
  try {
    return verify(null, Buffer.from(cp.headMac, "hex"), publicKey, Buffer.from(cp.signature, "base64"));
  } catch {
    return false;
  }
}

// ---- Verify --------------------------------------------------------------------------

export interface VerifyKeys {
  hmacKeys?: Record<string, Buffer>; // omit for public-key-only (auditor) verification
  publicKey?: KeyObject | null;
}

/**
 * Recompute the whole chain and check every checkpoint.
 * - With HMAC keys: every MAC and every prev link.
 * - With the public key: every checkpoint signature, and that it matches the row at its seq.
 * `events` and `checkpoints` may come in any order.
 */
export function verifyChain(events: AuditEvent[], checkpoints: AuditCheckpoint[], keys: VerifyKeys): AuditVerifyResult {
  const evs = [...events].sort((a, b) => a.seq - b.seq);
  const bySeq = new Map(evs.map((e) => [e.seq, e]));
  const fail = (brokenAt: number, reason: string, lastSignedSeq: number | null): AuditVerifyResult => ({
    ok: false, count: evs.length, brokenAt, reason, lastSignedSeq,
  });

  let prevMac = GENESIS_MAC;
  for (const e of evs) {
    if (e.prevMac !== prevMac) return fail(e.seq, "prev_mac doesn't match the previous event (row removed, reordered or edited)", null);
    if (keys.hmacKeys) {
      const key = keys.hmacKeys[e.keyId];
      if (!key) return fail(e.seq, `unknown HMAC key id ${e.keyId}`, null);
      if (computeMac(key, e.prevMac, e, e.keyId) !== e.mac) return fail(e.seq, "MAC mismatch (event content was changed)", null);
    }
    prevMac = e.mac;
  }

  let lastSignedSeq: number | null = null;
  for (const cp of [...checkpoints].sort((a, b) => a.seq - b.seq)) {
    const row = bySeq.get(cp.seq);
    if (!row) return fail(cp.seq, "checkpoint points at a missing event (log truncated?)", lastSignedSeq);
    if (row.mac !== cp.headMac) return fail(cp.seq, "checkpoint head doesn't match the event MAC", lastSignedSeq);
    if (keys.publicKey) {
      if (!verifyCheckpointSignature(cp, keys.publicKey)) return fail(cp.seq, "checkpoint signature is invalid", lastSignedSeq);
    }
    lastSignedSeq = cp.seq;
  }

  return { ok: true, count: evs.length, lastSignedSeq };
}
