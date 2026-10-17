import type { db } from "../db";

/** The transaction handle passed to `db.transaction(async (tx) => ...)`. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Either the pool or a transaction: read helpers accept both. */
export type DbOrTx = typeof db | Tx;
