// GET /api/ledger      LedgerEntry[]
// GET /api/ledger.csv  QuickBooks journal import
// GET /api/audit       AuditEvent[], newest first
// GET /api/audit/verify  every MAC and checkpoint signature → AuditVerifyResult

import { Hono } from "hono";
import { readAuditEvents, verifyAuditLog } from "../services/audit-log";
import { ledgerCsv, listLedger } from "../services/ledger";

export const ledgerRoutes = new Hono();

ledgerRoutes.get("/ledger", async (c) => c.json(await listLedger()));

ledgerRoutes.get("/ledger.csv", async (c) =>
  c.body(await ledgerCsv(), 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="corredor-ledger-${new Date().toISOString().slice(0, 10)}.csv"`,
  }),
);

ledgerRoutes.get("/audit", async (c) => c.json(await readAuditEvents(undefined, { newestFirst: true })));

ledgerRoutes.get("/audit/verify", async (c) => c.json(await verifyAuditLog()));
