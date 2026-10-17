// Resets the database to the demo state from the spec (PRD §10):
// 4 demo users, the 4 demo invoices with draft payouts, and default settings.
// Everything else is cleared, including the audit log. extraction_cache is
// kept so cached extractions survive a reset. The logic lives in
// src/services/demo.ts (shared with POST /api/demo/reset).
//
// Usage: bun run db:seed
// Refuses to run against a non-local DATABASE_URL unless SEED_ALLOW_REMOTE=1.

import { resetDemo } from "../services/demo";
import { client } from "./index";

try {
  const n = await resetDemo();
  console.log(`Seeded ${n.users} users, ${n.payouts} invoices/payouts, settings.`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await client.close();
}
