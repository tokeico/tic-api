// GET /api/ledger      LedgerEntry[]
// GET /api/ledger.csv  QuickBooks journal import
// GET /api/audit       AuditEvent[], newest first
// GET /api/audit/verify  every MAC and checkpoint signature → AuditVerifyResult

import { Hono } from "hono";
import { ApiError } from "../http-error";
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

// ?tamper=<seq> edits that event in memory before verifying (nothing is written): the audit-page demo.
ledgerRoutes.get("/audit/verify", async (c) => {
  const raw = c.req.query("tamper");
  if (raw === undefined) return c.json(await verifyAuditLog());
  const seq = Number(raw);
  if (!Number.isInteger(seq) || seq < 1) throw new ApiError(400, "invalid_tamper", "tamper must be an event number.");
  return c.json(await verifyAuditLog(undefined, { tamperSeq: seq }));
});
