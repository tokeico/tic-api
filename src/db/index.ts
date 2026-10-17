import { SQL } from "bun";
import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import type { Principal } from "../security/principal";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set (copy .env.example to .env)");
}

export const client = new SQL(url);
export const adminDb = drizzle({ client, schema });
type Transaction = Parameters<Parameters<typeof adminDb.transaction>[0]>[0];
const context = new AsyncLocalStorage<{ transaction: Transaction; principal: Principal | null }>();

export const currentPrincipal = () => context.getStore()?.principal ?? null;

export const db = new Proxy(adminDb, {
  get(_target, key) {
    const transaction = context.getStore()?.transaction;
    if (!transaction) throw new Error("A workspace database context is required.");
    const value = Reflect.get(transaction, key, transaction);
    return typeof value === "function" ? value.bind(transaction) : value;
  },
});

export function withWorkspace<T>(principal: Principal, callback: () => Promise<T>): Promise<T> {
  if (!/^w_[a-f0-9]{32}$/.test(principal.schemaName)) throw new Error("Invalid workspace schema.");
  return adminDb.transaction(async (transaction) => {
    await transaction.execute(sql`SELECT set_config('search_path', ${`${principal.schemaName}, pg_catalog`}, true)`);
    return context.run({ transaction, principal }, callback);
  });
}

export function withLegacyDatabase<T>(callback: () => Promise<T>): Promise<T> {
  return adminDb.transaction(async (transaction) => {
    await transaction.execute(sql`SELECT set_config('search_path', 'public, pg_catalog', true)`);
    return context.run({ transaction, principal: null }, callback);
  });
}

export { schema };
