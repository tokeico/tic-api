// The books: every journal entry with its payee and reconciliation result
// (FRONTEND §3.4). Entries are written by reconcilePayout (services/payouts.ts).

import { asc } from "drizzle-orm";
import type { LedgerEntry } from "../contracts";
import { journalToCsv } from "../corredor";
import { db, schema } from "../db";
import type { DbOrTx } from "./tx";

const { journalEntries, journalLines } = schema;

/** Every booked entry, oldest first. */
export async function listLedger(q: DbOrTx = db): Promise<LedgerEntry[]> {
  const rows = await q.query.journalEntries.findMany({
    orderBy: [asc(journalEntries.entryDate), asc(journalEntries.createdAt)],
    with: {
      lines: { orderBy: [asc(journalLines.lineNo)] },
      payment: { with: { reconciliation: true } },
      payout: { with: { invoice: true } },
    },
  });
  return rows.map((r) => {
    const rec = r.payment?.reconciliation;
    return {
      id: r.id,
      payoutId: r.payoutId,
      payeeName: r.payout.invoice?.payeeName ?? "",
      entryDate: r.entryDate,
      description: r.description,
      currency: "USD" as const,
      bookingRate: r.bookingRate,
      settleRate: r.settleRate,
      lines: r.lines.map((l) => ({ lineNo: l.lineNo, account: l.account, description: l.description, debit: l.debit, credit: l.credit })),
      match: rec ? { status: rec.status, reason: rec.reason } : { status: "exception" as const, reason: "No reconciliation record" },
    };
  });
}

/** QuickBooks journal import CSV. Entry ids are dropped so JournalNo reads CORR-0001, CORR-0002… */
export async function ledgerCsv(q: DbOrTx = db): Promise<string> {
  return journalToCsv((await listLedger(q)).map(({ id: _id, payeeName: _p, match: _m, ...entry }) => entry));
}
