// POST /api/invoices: PDF in, planned payout out (ARCHITECTURE §9, PRD 8.1).
//   bytes → sha256 → duplicate check → extraction cache or (text → local model)
//   → invoice + draft payout + "extracted" audit event (one transaction) → plan.

import { eq } from "drizzle-orm";
import type { Invoice, PayoutDetail } from "../contracts";
import { sha256Hex } from "../corredor";
import { db, schema } from "../db";
import { ApiError } from "../http-error";
import { ExtractionError, extractInvoice, pdfText } from "../llm/extract";
import { LlmUnavailableError, type LlmProvider, getProvider } from "../llm/provider";
import { appendAudit } from "./audit-log";
import { planOne } from "./payouts";

export const MAX_PDF_BYTES = 10 * 1024 * 1024;

const { invoices, payouts, extractionCache } = schema;

export interface UploadInput {
  filename: string;
  bytes: Uint8Array;
  provider?: LlmProvider;
}

export async function uploadInvoice({ filename, bytes, provider = getProvider() }: UploadInput): Promise<PayoutDetail> {
  if (bytes.length > MAX_PDF_BYTES) throw new ApiError(400, "too_large", "The PDF is larger than 10 MB.");
  const sha = sha256Hex(bytes);

  const dup = await db.query.invoices.findFirst({ where: eq(invoices.pdfSha256, sha), with: { payout: true } });
  if (dup) throw new ApiError(409, "duplicate_invoice", `This PDF was already uploaded as invoice ${dup.invoiceNumber}${dup.payout ? ` (payout ${dup.payout.id})` : ""}.`);

  let invoice: Invoice;
  let source: "cache" | "llm";
  let model: string;
  const cached = await db.query.extractionCache.findFirst({ where: eq(extractionCache.pdfSha256, sha) });
  if (cached) {
    invoice = cached.invoice;
    source = "cache";
    model = cached.model;
  } else {
    try {
      invoice = await extractInvoice(await pdfText(bytes), provider);
    } catch (err) {
      if (err instanceof ExtractionError) throw new ApiError(err.code === "not_pdf" ? 400 : 422, err.code, err.message);
      if (err instanceof LlmUnavailableError) throw new ApiError(503, "llm_unavailable", `Can't read the invoice: ${err.message}`);
      throw err;
    }
    source = "llm";
    model = provider.model;
    await db.insert(extractionCache).values({ pdfSha256: sha, invoice, model }).onConflictDoNothing();
  }

  const payoutId = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(invoices)
      .values({
        invoiceNumber: invoice.invoiceNumber,
        payeeName: invoice.payeeName,
        payeeCountry: invoice.payeeCountry,
        payeeTaxId: invoice.payeeTaxId,
        amount: invoice.amount,
        currency: invoice.currency,
        dueDate: invoice.dueDate,
        bankIdType: invoice.bankId?.type ?? null,
        bankIdValue: invoice.bankId?.value ?? null,
        description: invoice.description,
        purposeCode: invoice.purposeCode,
        lowConfidence: invoice.lowConfidence,
        source: "upload",
        extractionSource: source,
        pdfSha256: sha,
        pdfFilename: filename.slice(0, 200),
        rawExtraction: invoice,
      })
      .returning({ id: invoices.id });
    const [payout] = await tx.insert(payouts).values({ invoiceId: row!.id }).returning({ id: payouts.id });
    // No identifiers in the log: field names only.
    await appendAudit(tx, {
      payoutId: payout!.id,
      type: "extracted",
      payload: { filename: filename.slice(0, 200), pdfSha256: sha, source, model, lowConfidence: invoice.lowConfidence },
    });
    return payout!.id;
  });

  return planOne(payoutId);
}
