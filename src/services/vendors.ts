// Vendor master records (C9): bank details a person verified by calling the
// vendor back on a number from the payer's own records — never one printed on
// the invoice. Plans hold a payout whose invoice bank details don't match the
// verified record until someone re-verifies it here.

import { and, eq } from "drizzle-orm";
import type { BankDetailsCheck, Invoice, LocalRail } from "../contracts";
import { DEMO_INVOICES } from "../corredor";
import { schema } from "../db";
import type { NewVendor } from "../db/schema";
import type { DbOrTx } from "./tx";

/** Tax ids compare normalized: uppercase, no spaces, dots, dashes or slashes. */
export const normalizeTaxId = (v: string): string => v.replace(/[\s.\-/]/g, "").toUpperCase();

/** Bank identifiers: Pix keys are case-insensitive (trim + lowercase); other
 *  rails compare without separators, uppercase. */
export const normalizeBankValue = (type: LocalRail, v: string): string =>
  type === "pix" ? v.trim().toLowerCase() : v.replace(/[\s.\-/]/g, "").toUpperCase();

/**
 * The invoice's bank details vs. the verified vendor record. `unverified`
 * covers "no record" and "not enough to look one up" (missing tax id or bank
 * id); `changed` means a record exists but doesn't match — the classic
 * payment-diversion red flag.
 */
export async function bankDetailsFor(q: DbOrTx, invoice: Invoice): Promise<BankDetailsCheck> {
  const unverified: BankDetailsCheck = { status: "unverified", verifiedBy: null, verifiedAt: null };
  if (!invoice.payeeTaxId || !invoice.bankId) return unverified;
  const row = await q.query.vendors.findFirst({
    where: and(eq(schema.vendors.country, invoice.payeeCountry), eq(schema.vendors.taxId, normalizeTaxId(invoice.payeeTaxId))),
    with: { verifier: true },
  });
  if (!row) return unverified;
  const verifiedBy = row.verifier?.name ?? null;
  const verifiedAt = row.verifiedAt.toISOString();
  const match =
    row.bankIdType === invoice.bankId.type &&
    normalizeBankValue(row.bankIdType, row.bankIdValue) === normalizeBankValue(invoice.bankId.type, invoice.bankId.value);
  return { status: match ? "verified" : "changed", verifiedBy, verifiedAt };
}

/** One verified vendor record per demo invoice that has identifiers (C9 seed). */
export function demoVendorRows(): NewVendor[] {
  const at = new Date();
  return DEMO_INVOICES.filter((d) => d.payeeTaxId !== null && d.bankId !== null).map((d) => ({
    country: d.payeeCountry,
    taxId: normalizeTaxId(d.payeeTaxId!),
    name: d.payeeName,
    bankIdType: d.bankId!.type,
    bankIdValue: d.bankId!.value,
    verifiedBy: null,
    verifiedAt: at,
    verificationNote: "Demo vendor record (seeded)",
    source: "seed",
  }));
}
