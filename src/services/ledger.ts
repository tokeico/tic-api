// The books: every journal entry with its payee and reconciliation result
// (FRONTEND §3.4). Entries are written by reconcilePayout (services/payouts.ts).

import { asc } from "drizzle-orm";
import type { LedgerEntry } from "../contracts";
import { journalToCsv, routeLabel } from "../corredor";
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
      invoiceNumber: r.payout.invoice?.invoiceNumber ?? "",
      routeLabel: r.payment ? routeLabel(r.payment.route) : "",
      entryDate: r.entryDate,
      description: r.description,
      currency: "USD" as const,
      bookingRate: r.bookingRate,
      settleRate: r.settleRate,
      lines: r.lines.map((l) => ({ lineNo: l.lineNo, account: l.account, description: l.description, debit: l.debit, credit: l.credit })),
      match: {
        status: rec?.status ?? ("exception" as const),
        reason: rec ? rec.reason : "No reconciliation record",
        txHash: r.payment?.txHash ?? null,
        railRef: r.payment?.railRef ?? null,
        rail: r.payment?.route.rail ?? ("swift" as const),
      },
    };
  });
}

/** QuickBooks journal import CSV. Entry ids are dropped so JournalNo reads CORR-0001, CORR-0002… */
export async function ledgerCsv(q: DbOrTx = db): Promise<string> {
  return journalToCsv(
    (await listLedger(q)).map(({ id: _id, payeeName, invoiceNumber: _n, routeLabel: _r, match: _m, ...entry }) => ({ ...entry, name: payeeName })),
  );
}
