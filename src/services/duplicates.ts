// Duplicate invoices: the same supplier (country + tax id) and invoice number
// twice. Upload, manual entry and edits all check it, so the same bill can't be
// paid twice because it arrived as two different files.

import { eq } from "drizzle-orm";
import type { Invoice } from "../contracts";
import { schema } from "../db";
import { ApiError } from "../http-error";
import type { DbOrTx } from "./tx";
import { normalizeTaxId } from "./vendors";

const { invoices } = schema;

const normalizeInvoiceNumber = (v: string): string => v.replace(/[\s.\-/#]/g, "").toUpperCase();

/**
 * Another live invoice from the same supplier (country + tax id) with the same
 * invoice number. Catches the same bill arriving twice as different files, or
 * typed in by hand after a PDF upload. Rejected payouts don't count.
 */
export async function findDuplicateInvoice(
  q: DbOrTx,
  invoice: Pick<Invoice, "payeeCountry" | "payeeTaxId" | "invoiceNumber">,
  excludeInvoiceId?: string,
): Promise<{ invoiceNumber: string; payoutId: string | null } | null> {
  if (!invoice.payeeTaxId || !invoice.invoiceNumber.trim()) return null;
  const taxId = normalizeTaxId(invoice.payeeTaxId);
  const number = normalizeInvoiceNumber(invoice.invoiceNumber);
  const rows = await q.query.invoices.findMany({ where: eq(invoices.payeeCountry, invoice.payeeCountry), with: { payout: true } });
  const dup = rows.find(
    (r) =>
      r.id !== excludeInvoiceId &&
      r.payeeTaxId !== null &&
      normalizeTaxId(r.payeeTaxId) === taxId &&
      normalizeInvoiceNumber(r.invoiceNumber) === number &&
      r.payout?.status !== "rejected",
  );
  return dup ? { invoiceNumber: dup.invoiceNumber, payoutId: dup.payout?.id ?? null } : null;
}

export async function assertNotDuplicate(q: DbOrTx, invoice: Pick<Invoice, "payeeCountry" | "payeeTaxId" | "invoiceNumber">, excludeInvoiceId?: string): Promise<void> {
  const dup = await findDuplicateInvoice(q, invoice, excludeInvoiceId);
  if (dup) {
    throw new ApiError(
      409,
      "duplicate_invoice",
      `Invoice ${dup.invoiceNumber} from this supplier (same tax ID) is already in the inbox${dup.payoutId ? ` (payout ${dup.payoutId})` : ""}.`,
    );
  }
}

