// Backfills booked payout history (src/services/demo-history.ts) into every
// workspace, so any account's books (/ledger) show it. New sign-ups and an
// in-app "Reset demo" get it automatically; this is for accounts made before.
//
// Usage: bun run db:demo-ledger     (safe to re-run; replaces its own rows)
// Local databases only.

import { sql } from "drizzle-orm";
import { adminDb, client, schema } from "../src/db";
import { seedHistory } from "../src/services/demo-history";

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1", "db"];

try {
  const host = new URL(process.env.DATABASE_URL!).hostname;
  if (!LOCAL_HOSTS.includes(host)) throw new Error(`Refusing to write demo books to non-local database at "${host}".`);
  const workspaces = await adminDb.select().from(schema.authWorkspaces);
  for (const w of workspaces) {
    if (!/^w_[a-f0-9]{32}$/.test(w.schemaName)) continue;
    const booked = await adminDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('search_path', ${`${w.schemaName}, pg_catalog`}, true)`);
      return seedHistory(tx);
    });
    console.log(`${w.name}: ${booked} booked payouts`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await client.close();
}
