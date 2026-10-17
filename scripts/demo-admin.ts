// Local demo login: an owner account (admin / admin) whose workspace is
// seeded with the demo invoices, exactly like a fresh signup.
// POST /api/auth/signin accepts the bare username "admin" for this email.
//
// Usage: bun run db:demo-admin     (safe to re-run; resets the password)
// Local databases only, with no override: a known password must never exist
// on a shared or deployed database.

import { eq } from "drizzle-orm";
import { adminDb, client, schema } from "../src/db";
import { DEMO_ADMIN_EMAIL, signUp } from "../src/security/auth";

const DEMO_ADMIN = { name: "Admin", email: DEMO_ADMIN_EMAIL, password: "admin", workspaceName: "Corredor demo" };
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1", "db"];

try {
  const host = new URL(process.env.DATABASE_URL!).hostname;
  if (!LOCAL_HOSTS.includes(host)) throw new Error(`Refusing to create the demo login on non-local database at "${host}".`);
  const existing = await adminDb.query.authAccounts.findFirst({ where: eq(schema.authAccounts.email, DEMO_ADMIN.email) });
  if (existing) {
    const passwordHash = await Bun.password.hash(DEMO_ADMIN.password, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 });
    await adminDb.update(schema.authAccounts).set({ passwordHash }).where(eq(schema.authAccounts.id, existing.id));
    console.log(`Demo login exists; password reset. Sign in with admin / ${DEMO_ADMIN.password}.`);
  } else {
    await signUp(DEMO_ADMIN);
    console.log(`Demo login created. Sign in with admin / ${DEMO_ADMIN.password}.`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await client.close();
}
