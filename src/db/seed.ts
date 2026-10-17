// Resets the database to the demo state from the spec (PRD §10):
// 4 demo users, the 4 demo invoices with draft payouts, and default settings.
// Everything else is cleared, including the audit log. extraction_cache is
// kept so cached Claude extractions survive a reset.
//
// Usage: bun run db:seed
// Refuses to run against a non-local DATABASE_URL unless SEED_ALLOW_REMOTE=1.

import { sql } from "drizzle-orm";
import { client, db } from "./index";
import { invoices, payouts, settings, users, type NewInvoiceRow } from "./schema";
import { DEFAULT_POLICY, DEMO_INVOICES } from "../corredor";
import type { Policy } from "./types";

const host = new URL(process.env.DATABASE_URL!).hostname;
if (!["localhost", "127.0.0.1", "::1", "db"].includes(host) && process.env.SEED_ALLOW_REMOTE !== "1") {
  console.error(`Refusing to wipe non-local database at "${host}". Set SEED_ALLOW_REMOTE=1 to override.`);
  process.exit(1);
}

const demoUsers = [
  { name: "Maria Torres", email: "maria@corredor.demo", role: "controller" },
  { name: "Daniel Reyes", email: "daniel@corredor.demo", role: "approver" },
  { name: "Sam Ortiz", email: "sam@corredor.demo", role: "ap_clerk" },
  { name: "Priya Shah", email: "priya@corredor.demo", role: "auditor" },
] as const;

// The 4 demo invoices live in src/corredor/demo.ts so the seed, the golden
// tests and the fixtures can't drift apart.
const demoInvoices: Omit<NewInvoiceRow, "source" | "extractionSource">[] = DEMO_INVOICES.map(
  ({ key: _key, bankId, ...inv }) => ({ ...inv, bankIdType: bankId?.type ?? null, bankIdValue: bankId?.value ?? null }),
);

const policy: Policy = DEFAULT_POLICY;

await db.transaction(async (tx) => {
  await tx.execute(sql`
    TRUNCATE audit_events, journal_lines, journal_entries, reconciliations,
             payments, approvals, vendor_requests, memos, plans, screenings,
             payouts, invoices, users, settings
    RESTART IDENTITY CASCADE`);

  await tx.insert(users).values([...demoUsers]);

  const rows = await tx
    .insert(invoices)
    .values(demoInvoices.map((i) => ({ ...i, source: "seed" as const, extractionSource: "seed" as const })))
    .returning({ id: invoices.id });
  await tx.insert(payouts).values(rows.map((r) => ({ invoiceId: r.id })));

  await tx.insert(settings).values([
    { key: "policy", value: policy },
    { key: "demo_as_of", value: process.env.DEMO_DEFAULT_AS_OF ?? "2026-10-17" },
    { key: "rules_version", value: "v1" },
  ]);
});

console.log(`Seeded ${demoUsers.length} users, ${demoInvoices.length} invoices/payouts, settings.`);
await client.close();
