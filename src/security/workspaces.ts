import { sql } from "drizzle-orm";
import type { adminDb } from "../db";
import { DEFAULT_POLICY, DEMO_INVOICES } from "../corredor";
import { invoices, payouts, settings, users } from "../db/schema";

type Transaction = Parameters<Parameters<typeof adminDb.transaction>[0]>[0];
const tables = ["users", "invoices", "extraction_cache", "payouts", "screenings", "sanctions_reviews", "security_holds", "plans", "memos", "vendor_requests", "approvals", "payments", "reconciliations", "journal_entries", "journal_lines", "audit_events", "audit_checkpoints", "settings"];
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

export async function provisionWorkspace(tx: Transaction, schemaName: string) {
  if (!/^w_[a-f0-9]{32}$/.test(schemaName)) throw new Error("Invalid workspace schema.");
  const quoted = identifier(schemaName);
  await tx.execute(sql.raw(`CREATE SCHEMA ${quoted}`));
  await tx.execute(sql.raw(`REVOKE ALL ON SCHEMA ${quoted} FROM PUBLIC`));
  for (const table of tables) {
    await tx.execute(sql.raw(`CREATE TABLE ${quoted}.${identifier(table)} (LIKE public.${identifier(table)} INCLUDING ALL)`));
  }
  await tx.execute(sql`SELECT set_config('search_path', ${`${schemaName}, pg_catalog`}, true)`);
  const foreignKeys = await tx.execute(sql`
    SELECT c.conname AS name, r.relname AS table_name, pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'`);
  for (const fk of foreignKeys as unknown as { name: string; table_name: string; definition: string }[]) {
    if (!tables.includes(fk.table_name)) continue;
    const definition = fk.definition.replace(/REFERENCES (?:(?:"public"|public)\.)?/g, `REFERENCES ${quoted}.`);
    await tx.execute(sql.raw(`ALTER TABLE ${quoted}.${identifier(fk.table_name)} ADD CONSTRAINT ${identifier(fk.name)} ${definition}`));
  }
  for (const table of ["audit_events", "audit_checkpoints"]) {
    await tx.execute(sql.raw(`CREATE TRIGGER ${table}_append_only BEFORE UPDATE OR DELETE ON ${quoted}.${identifier(table)} FOR EACH ROW EXECUTE FUNCTION public.audit_events_reject_change()`));
  }
}

export async function seedWorkspace(tx: Transaction, schemaName: string, owner: { id: string; name: string; email: string }) {
  if (!/^w_[a-f0-9]{32}$/.test(schemaName)) throw new Error("Invalid workspace schema.");
  await tx.execute(sql`SELECT set_config('search_path', ${`${schemaName}, pg_catalog`}, true)`);
  await tx.insert(users).values({ ...owner, role: "controller" });
  const base = Date.now();
  const rows = await tx.insert(invoices).values(DEMO_INVOICES.map(({ key: _key, bankId, ...invoice }, i) => ({
    ...invoice, bankIdType: bankId?.type ?? null, bankIdValue: bankId?.value ?? null,
    source: "seed" as const, extractionSource: "seed" as const, createdAt: new Date(base + i),
  }))).returning({ id: invoices.id, createdAt: invoices.createdAt });
  await tx.insert(payouts).values(rows.map((row) => ({ invoiceId: row.id, createdAt: row.createdAt })));
  await tx.insert(settings).values([
    { key: "policy", value: DEFAULT_POLICY },
    { key: "demo_as_of", value: process.env.DEMO_DEFAULT_AS_OF ?? "2026-10-17" },
    { key: "rules_version", value: "v1" },
  ]);
}
