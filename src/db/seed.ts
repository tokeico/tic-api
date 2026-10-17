// Resets the database to the demo state from the spec (PRD §10):
// 4 demo users, the 4 demo invoices with draft payouts, and default settings.
// Everything else is cleared, including the audit log. extraction_cache is
// kept so cached Claude extractions survive a reset.
//
// Usage: bun run db:seed
// Refuses to run against a non-local DATABASE_URL unless SEED_ALLOW_REMOTE=1.
// All names and identifiers are fictional (check digits are valid, though).

import { sql } from "drizzle-orm";
import { client, db } from "./index";
import { invoices, payouts, settings, users, type NewInvoiceRow } from "./schema";
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

const demoInvoices: Omit<NewInvoiceRow, "source" | "extractionSource">[] = [
  {
    // Ready + warning on Oct 17 (Ponte, pending VASP). Sep 30: PagaFX. Oct 30: Sol.
    invoiceNumber: "EP-2026-0412",
    payeeName: "Estúdio Paulista Design Ltda",
    payeeCountry: "BR",
    payeeTaxId: "12345678000195", // CNPJ
    payeeEmail: "financeiro@estudiopaulista.demo",
    amount: 85_000,
    currency: "BRL",
    dueDate: "2026-10-31",
    bankIdType: "pix",
    bankIdValue: "7d9f0a52-3c1e-4b8a-9e6f-2a4c8b1d5e30", // random (EVP) Pix key
    description: "Brand identity and packaging design, Q3 2026",
    purposeCode: "DEMO-SERVICES", // placeholder, not a real BCB code
  },
  {
    // ~USD 64.9k at 18.50: over the $50k policy, so needs a 2nd approver.
    invoiceNumber: "ADN-F-88213",
    payeeName: "Autopartes del Norte S.A. de C.V.",
    payeeCountry: "MX",
    payeeTaxId: "ADN0105149K3", // RFC
    payeeEmail: "cobranza@autopartesdelnorte.demo",
    amount: 1_200_000,
    currency: "MXN",
    dueDate: "2026-11-05",
    bankIdType: "spei",
    bankIdValue: "012580001234567897", // CLABE
    description: "Brake assemblies, PO 4471 (800 units)",
    purposeCode: null,
  },
  {
    // Ready + AR-FX-SPREAD warning. Pampa PSAV (Cueva P2P is blocked).
    invoiceNumber: "LF-0031",
    payeeName: "Lucía Fernández",
    payeeCountry: "AR",
    payeeTaxId: "27312345671", // CUIT
    payeeEmail: "lucia.fernandez@correo.demo",
    amount: 4_000,
    currency: "USD",
    dueDate: "2026-10-25",
    bankIdType: "cvu",
    bankIdValue: "0000003110000123456781", // CVU
    description: "Frontend development, September 2026 (contractor)",
    purposeCode: null,
  },
  {
    // Blocked by VE-OFAC on every route.
    invoiceNumber: "TO-2026-117",
    payeeName: "Transportes Orinoco C.A.",
    payeeCountry: "VE",
    payeeTaxId: "J-30123456-7", // RIF
    payeeEmail: "pagos@transportesorinoco.demo",
    amount: 12_500,
    currency: "USD",
    dueDate: "2026-10-30",
    bankIdType: "swift",
    bankIdValue: "DEMOVECAXXX",
    description: "Freight forwarding, Puerto Cabello to Miami",
    purposeCode: null,
  },
];

const policy: Policy = { secondApproverAboveUsd: 50_000, dailyCapUsd: 150_000 };

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
