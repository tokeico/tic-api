// Demo data: the 4 invoices, 4 users and default settings from the spec
// (PRD §10). Used by `bun run db:seed` and by POST /api/demo/reset, so a
// presenter can reset between rehearsals without a terminal.

import { sql } from "drizzle-orm";
import { DEFAULT_POLICY, DEMO_INVOICES } from "../corredor";
import { currentPrincipal, db, schema } from "../db";
import { ApiError } from "../http-error";
import { DEFAULT_AS_OF } from "./settings";

const { invoices, payouts, settings, users } = schema;

export const DEMO_USERS = [
  { name: "Maria Lopez", email: "maria@corredor.demo", role: "controller" },
  { name: "Daniel Ortiz", email: "daniel@corredor.demo", role: "approver" },
  { name: "Sam Ortiz", email: "sam@corredor.demo", role: "ap_clerk" },
  { name: "Priya Shah", email: "priya@corredor.demo", role: "auditor" },
] as const;

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1", "db"];

/** Wiping is only allowed on a local database unless someone opts in explicitly. */
export function assertResetAllowed(): void {
  const host = new URL(process.env.DATABASE_URL!).hostname;
  const optedIn = process.env.SEED_ALLOW_REMOTE === "1";
  if (!LOCAL_HOSTS.includes(host) && !optedIn) {
    throw new Error(`Refusing to wipe non-local database at "${host}". Set SEED_ALLOW_REMOTE=1 to override.`);
  }
}

/**
 * Wipe everything (including the audit log) and load the demo state: draft
 * payouts, no plans yet. extraction_cache is kept so cached extractions
 * survive a reset.
 */
export async function resetDemo(): Promise<{ users: number; payouts: number }> {
  const principal = currentPrincipal();
  if (principal) {
    if (!principal.owner || principal.credential !== "session") throw new ApiError(403, "not_authorized", "Only the signed-in workspace owner can reset this demo.");
    if ((process.env.RAIL_MODE ?? "mock") !== "mock") throw new ApiError(403, "demo_only", "Reset is available only on the simulated payment rail.");
  } else {
    assertResetAllowed();
  }
  // The 4 demo invoices live in src/corredor/demo.ts so the seed, the golden
  // tests and the fixtures can't drift apart.
  const demoInvoices = DEMO_INVOICES.map(({ key: _key, bankId, ...inv }) => ({
    ...inv,
    bankIdType: bankId?.type ?? null,
    bankIdValue: bankId?.value ?? null,
  }));

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      TRUNCATE audit_events, audit_checkpoints, journal_lines, journal_entries, reconciliations,
               payments, approvals, vendor_requests, memos, plans, screenings,
               sanctions_reviews, security_holds,
               payouts, invoices, ${principal ? sql.raw("") : sql.raw("users,")} settings
      RESTART IDENTITY CASCADE`);

    if (!principal) await tx.insert(users).values([...DEMO_USERS]);

    // now() is the transaction start, so give each row its own millisecond:
    // the inbox lists payouts in the PRD §10 order (BR, MX, AR, VE).
    const base = Date.now();
    const rows = await tx
      .insert(invoices)
      .values(demoInvoices.map((i, n) => ({ ...i, source: "seed" as const, extractionSource: "seed" as const, createdAt: new Date(base + n) })))
      .returning({ id: invoices.id, invoiceNumber: invoices.invoiceNumber });
    const order = new Map(demoInvoices.map((i, n) => [i.invoiceNumber, n]));
    await tx.insert(payouts).values(rows.map((r) => ({ invoiceId: r.id, createdAt: new Date(base + order.get(r.invoiceNumber)!) })));

    await tx.insert(settings).values([
      { key: "policy", value: DEFAULT_POLICY },
      { key: "demo_as_of", value: DEFAULT_AS_OF() },
      { key: "rules_version", value: "v1" },
    ]);
  });
  const memberCount = principal ? (await db.select({ id: users.id }).from(users)).length : DEMO_USERS.length;
  return { users: memberCount, payouts: demoInvoices.length };
}
