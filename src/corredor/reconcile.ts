// Reconciliation (invoice ↔ tx hash ↔ local-rail reference) and the journal
// entry that books the payout (PRD 8.8, ARCHITECTURE §13). All amounts in USD,
// computed in integer cents so every entry balances exactly.

import type { Invoice, JournalEntry, JournalLine, ReconciliationStatus, Route } from "../contracts";
import { fmtMoney, fmtNum, fmtUsd, fromCents, toCents } from "./util";

/** What the API stored after RailAdapter.send(). */
export interface PaymentRecord {
  payoutId: string;
  route: Route;
  amountUsd: number;
  feeUsd: number;
  txHash: string | null;
  offrampRef: string | null;
  railRef: string | null;
  settledLocal: number | null;
  settleRate: number | null;
}

/** References already used by other payouts' payments (1:1 check). */
export interface KnownRef {
  payoutId: string;
  txHash: string | null;
  railRef: string | null;
}

export interface ReconcileInput {
  payoutId: string;
  invoice: Invoice;
  payment: PaymentRecord;
  others?: KnownRef[];
}

export interface ReconcileResult {
  status: ReconciliationStatus;
  /** Every problem found. Empty when matched. */
  reasons: string[];
  /** reasons joined, for reconciliations.reason. null when matched. */
  reason: string | null;
}

export function reconcile({ payoutId, invoice, payment, others = [] }: ReconcileInput): ReconcileResult {
  const reasons: string[] = [];

  if (payment.payoutId !== payoutId) reasons.push(`Payment belongs to payout ${payment.payoutId}, not ${payoutId}.`);
  if (payment.route.kind === "stablecoin" && !payment.txHash) reasons.push("Stablecoin payment has no transaction hash.");
  if (!payment.railRef) reasons.push("No local-rail reference from the off-ramp.");

  for (const o of others) {
    if (o.payoutId === payoutId) continue;
    if (payment.txHash && o.txHash === payment.txHash) reasons.push(`Transaction hash is already matched to payout ${o.payoutId}.`);
    if (payment.railRef && o.railRef === payment.railRef) reasons.push(`Rail reference is already matched to payout ${o.payoutId}.`);
  }

  if (payment.settledLocal === null || payment.settleRate === null) {
    reasons.push("Settlement amount or rate is missing.");
  } else {
    // Amounts must agree within the quoted fee.
    const diffUsd = Math.abs(payment.settledLocal - invoice.amount) / payment.settleRate;
    if (toCents(diffUsd) > toCents(payment.feeUsd)) {
      reasons.push(
        `Settled ${fmtMoney(payment.settledLocal, invoice.currency)} vs. invoiced ${fmtMoney(invoice.amount, invoice.currency)}: ` +
          `difference ${fmtUsd(diffUsd)} exceeds the quoted fee ${fmtUsd(payment.feeUsd)}.`,
      );
    }
  }

  return reasons.length === 0
    ? { status: "matched", reasons, reason: null }
    : { status: "exception", reasons, reason: reasons.join(" ") };
}

const NETWORK_LABEL: Record<string, string> = { base: "Base", arbitrum: "Arbitrum", tron: "Tron" };

/** Pay-through: USD leaves the operating bank account and the coin only passes
 *  through the on-ramp and off-ramp, so the company never holds stablecoins on
 *  its balance sheet. The chain leg goes in the line description instead. */
export function cashAccount(_route: Route): string {
  return "Cash – Operating bank (USD)";
}

function cashDescription(route: Route, txHash: string | null, railRef: string | null): string | null {
  if (route.kind === "stablecoin" && route.asset && route.network) {
    return `Pay-through via ${route.asset} on ${NETWORK_LABEL[route.network] ?? route.network}${txHash ? `, tx ${txHash}` : ""}`;
  }
  return txHash ?? railRef ?? null;
}

export interface JournalInput {
  payoutId: string;
  invoice: Invoice;
  payment: PaymentRecord & { settledLocal: number; settleRate: number };
  /** Invoice currency per USD when the AP was booked (from fx.json). */
  bookingRate: number;
  entryDate: string; // YYYY-MM-DD
}

/**
 *   Dr Accounts Payable – payee   invoice at the booking rate
 *   Dr Bank & network fees        quoted route fee
 *   Dr FX loss / Cr FX gain       settle-rate cost minus booked AP
 *   Cr Cash – Operating bank (USD) USD actually sent (settled cost + fee); pay-through, no coin held
 */
export function buildJournalEntry({ payoutId, invoice, payment, bookingRate, entryDate }: JournalInput): JournalEntry {
  const ap = toCents(invoice.amount / bookingRate);
  const fee = toCents(payment.feeUsd);
  const sent = toCents(payment.settledLocal / payment.settleRate);
  const fx = sent - ap; // > 0: it cost more USD than booked → loss
  const cash = sent + fee;

  const local = fmtMoney(invoice.amount, invoice.currency);
  const lines: JournalLine[] = [
    {
      lineNo: 1,
      account: `Accounts Payable – ${invoice.payeeName}`,
      description: invoice.currency === "USD" ? `Invoice ${invoice.invoiceNumber}` : `Invoice ${invoice.invoiceNumber}, ${local} @ ${fmtNum(bookingRate)} booking`,
      debit: fromCents(ap),
      credit: 0,
    },
    {
      lineNo: 2,
      account: "Bank & network fees",
      description: `${payment.route.feePct}% route fee (${payment.route.id})`,
      debit: fromCents(fee),
      credit: 0,
    },
    {
      lineNo: 3,
      account: fx > 0 ? "FX loss" : "FX gain",
      description: `Booking ${fmtNum(bookingRate)} vs. settle ${fmtNum(payment.settleRate)}`,
      debit: fx > 0 ? fromCents(fx) : 0,
      credit: fx < 0 ? fromCents(-fx) : 0,
    },
    {
      lineNo: 4,
      account: cashAccount(payment.route),
      description: cashDescription(payment.route, payment.txHash, payment.railRef),
      debit: 0,
      credit: fromCents(cash),
    },
  ];

  assertBalanced(lines);
  return {
    payoutId,
    entryDate,
    description: `Payout to ${invoice.payeeName}, invoice ${invoice.invoiceNumber}`,
    currency: "USD",
    bookingRate,
    settleRate: payment.settleRate,
    lines,
  };
}

export function assertBalanced(lines: JournalLine[]): void {
  const dr = lines.reduce((s, l) => s + toCents(l.debit), 0);
  const cr = lines.reduce((s, l) => s + toCents(l.credit), 0);
  if (dr !== cr) throw new Error(`Journal entry doesn't balance: debits ${fromCents(dr)} ≠ credits ${fromCents(cr)}`);
  for (const l of lines) {
    if (l.debit < 0 || l.credit < 0 || (l.debit > 0 && l.credit > 0)) {
      throw new Error(`Journal line ${l.lineNo} must be a debit or a credit, not both`);
    }
  }
}

// ---- Export ---------------------------------------------------------------------------

const csvCell = (v: string | number | null): string => {
  const s = v === null ? "" : String(v);
  // Quote when needed; neutralise spreadsheet formula injection.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** QuickBooks Online journal-entry import format (one row per line). Name is the payee when the caller has it. */
export function journalToCsv(entries: (JournalEntry & { id?: string; name?: string })[]): string {
  const header = ["JournalNo", "JournalDate", "AccountName", "Debits", "Credits", "Description", "Name", "Currency"];
  const rows = [header.join(",")];
  entries.forEach((e, i) => {
    const no = e.id ?? `CORR-${String(i + 1).padStart(4, "0")}`;
    const name = e.name ?? e.payoutId;
    for (const l of e.lines) {
      rows.push(
        [no, e.entryDate, l.account, l.debit ? l.debit.toFixed(2) : "", l.credit ? l.credit.toFixed(2) : "", l.description ?? e.description, name, e.currency]
          .map(csvCell)
          .join(","),
      );
    }
  });
  return rows.join("\r\n") + "\r\n";
}
