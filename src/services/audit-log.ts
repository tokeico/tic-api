// Persistence for the audit chain (pure logic lives in corredor/audit.ts).
//
// appendAudit() must run inside the same transaction as the change it records,
// so an event exists if and only if the change committed. A transaction-level
// advisory lock serialises writers: the MAC covers the previous MAC, so two
// concurrent appends would fork the chain.

import { asc, desc, eq, sql } from "drizzle-orm";
import type { AuditEvent, AuditEventType, AuditVerifyResult } from "../contracts";
import {
  chainEvent,
  loadAuditKeys,
  shouldCheckpoint,
  signCheckpoint,
  verifyChain,
  type AuditCheckpoint,
  type AuditKeys,
} from "../corredor";
import { db, schema } from "../db";
import type { DbOrTx, Tx } from "./tx";

const AUDIT_LOCK_ID = 727_274_001;

let keys: AuditKeys | null = null;
/** Keys from the environment, loaded once. Throws if AUDIT_HMAC_KEY is missing. */
export function auditKeys(): AuditKeys {
  return (keys ??= loadAuditKeys());
}

/** For tests that swap keys between runs. */
export function resetAuditKeys(next: AuditKeys | null = null): void {
  keys = next;
}

export interface AppendInput {
  payoutId: string | null;
  actorId?: string | null;
  type: AuditEventType;
  /** JSON-safe facts about the event. Keep personal data (bank ids, tax ids) out: the log is immutable. */
  payload: Record<string, unknown>;
}

export async function appendAudit(tx: Tx, input: AppendInput): Promise<AuditEvent> {
  const k = auditKeys();
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${AUDIT_LOCK_ID})`);

  const [last] = await tx
    .select({ seq: schema.auditEvents.seq, mac: schema.auditEvents.mac })
    .from(schema.auditEvents)
    .orderBy(desc(schema.auditEvents.seq))
    .limit(1);
  const next = await tx.execute(sql`SELECT nextval(pg_get_serial_sequence('audit_events', 'seq')) AS seq`);
  const seq = Number((next as unknown as { seq: string | number }[])[0]!.seq);

  const createdAt = new Date().toISOString(); // millisecond precision, matches timestamp(3)
  const ev = chainEvent(k, last ? { seq: Number(last.seq), mac: last.mac } : null, {
    seq,
    payoutId: input.payoutId,
    type: input.type,
    payload: input.payload,
    createdAt,
  });

  await tx
    .insert(schema.auditEvents)
    .overridingSystemValue()
    .values({
      seq: ev.seq,
      payoutId: ev.payoutId,
      actorId: input.actorId ?? null,
      type: ev.type,
      payload: ev.payload,
      prevMac: ev.prevMac,
      mac: ev.mac,
      keyId: ev.keyId,
      createdAt: new Date(ev.createdAt),
    });

  if (k.signingKey && shouldCheckpoint(ev)) {
    const cp = signCheckpoint(k, ev, createdAt);
    await tx.insert(schema.auditCheckpoints).values({
      seq: cp.seq,
      headMac: cp.headMac,
      signature: cp.signature,
      publicKeyId: cp.publicKeyId,
      createdAt: new Date(cp.createdAt),
    });
  }
  return ev;
}

// ---- Reading -----------------------------------------------------------------------

type EventRow = typeof schema.auditEvents.$inferSelect;
export const toAuditEvent = (r: EventRow): AuditEvent => ({
  seq: Number(r.seq),
  payoutId: r.payoutId,
  type: r.type,
  payload: r.payload,
  createdAt: r.createdAt.toISOString(),
  prevMac: r.prevMac,
  mac: r.mac,
  keyId: r.keyId,
});

export async function readAuditEvents(q: DbOrTx = db, opts: { payoutId?: string; newestFirst?: boolean } = {}) {
  const rows = await q
    .select()
    .from(schema.auditEvents)
    .where(opts.payoutId ? eq(schema.auditEvents.payoutId, opts.payoutId) : undefined)
    .orderBy(opts.newestFirst ? desc(schema.auditEvents.seq) : asc(schema.auditEvents.seq));
  return rows.map(toAuditEvent);
}

export async function verifyAuditLog(q: DbOrTx = db): Promise<AuditVerifyResult> {
  const k = auditKeys();
  const [events, cps] = await Promise.all([
    readAuditEvents(q),
    q.select().from(schema.auditCheckpoints).orderBy(asc(schema.auditCheckpoints.seq)),
  ]);
  const checkpoints: AuditCheckpoint[] = cps.map((c) => ({
    seq: Number(c.seq),
    headMac: c.headMac,
    signature: c.signature,
    publicKeyId: c.publicKeyId,
    createdAt: c.createdAt.toISOString(),
  }));
  return verifyChain(events, checkpoints, { hmacKeys: k.hmacKeys, publicKey: k.publicKey });
}
