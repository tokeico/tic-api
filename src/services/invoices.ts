// POST /api/invoices: PDF in, planned payout out (ARCHITECTURE §9, PRD 8.1).
//   bytes → sha256 → duplicate check → text → injection scan → extraction
//   cache or local model → invoice + draft payout + security hold (if flagged)
//   + "extracted" audit event (one transaction) → plan.
// POST /api/invoices/manual: the same, from fields a person typed in, for
// when the local model is down or the PDF has no text layer.

import { eq } from "drizzle-orm";
import { Invoice, type PayoutDetail } from "../contracts";
import { sha256Hex, validateInvoice } from "../corredor";
import { db, schema } from "../db";
import { ApiError } from "../http-error";
import { maskDigits } from "../llm/agent";
import { ExtractionError, extractInvoice, pdfText } from "../llm/extract";
import { scanInjections } from "../llm/injection";
import { LlmUnavailableError, type LlmProvider, getProvider } from "../llm/provider";
import { appendAudit } from "./audit-log";
import { planOne } from "./payouts";
import { assertNotDuplicate } from "./duplicates";

export const MAX_PDF_BYTES = 10 * 1024 * 1024;

const { invoices, payouts, extractionCache, securityHolds } = schema;

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

  // The text is read even on a cache hit: the injection scan is deterministic
  // and always runs, so a flagged PDF can't slip through a cached extraction.
  let text: string;
  try {
    text = await pdfText(bytes);
  } catch (err) {
    if (err instanceof ExtractionError) throw new ApiError(err.code === "not_pdf" ? 400 : 422, err.code, err.message);
    throw err;
  }
  const findings = scanInjections(text);

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
      invoice = await extractInvoice(text, provider);
    } catch (err) {
      if (err instanceof ExtractionError) throw new ApiError(err.code === "not_pdf" ? 400 : 422, err.code, err.message);
      if (err instanceof LlmUnavailableError) throw new ApiError(503, "llm_unavailable", `Can't read the invoice: ${err.message}`);
      throw err;
    }
    source = "llm";
    model = provider.model;
    await db.insert(extractionCache).values({ pdfSha256: sha, invoice, model }).onConflictDoNothing();
  }
  await assertNotDuplicate(db, invoice);

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
    // Prompt-injection defense: the text is quoted for a person (masked here)
    // and the payout is held until a person clears it. The plan still runs;
    // approval is what the hold gates.
    if (findings.length > 0) {
      const [hold] = await tx.insert(securityHolds).values({ payoutId: payout!.id, findings }).returning({ id: securityHolds.id });
      await appendAudit(tx, {
        payoutId: payout!.id,
        type: "security_flagged",
        payload: { holdId: hold!.id, findings: findings.length, patterns: [...new Set(findings.map((f) => f.pattern))], quotes: findings.map((f) => maskDigits(f.quote)) },
      });
    }
    return payout!.id;
  });

  return planOne(payoutId);
}

/** POST /api/invoices/manual  A person types the invoice in. Same checks as an upload, minus the PDF. */
export async function enterInvoice(input: Omit<Invoice, "lowConfidence">, actorId: string): Promise<PayoutDetail> {
  const parsed = Invoice.safeParse({ ...input, lowConfidence: [] });
  if (!parsed.success) throw new ApiError(422, "invalid_invoice", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const invoice = parsed.data;
  const issues = validateInvoice(invoice);
  const lowConfidence = [...new Set(issues.map((i) => i.field))];

  const payoutId = await db.transaction(async (tx) => {
    await assertNotDuplicate(tx, invoice);
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
        lowConfidence,
        source: "upload",
        extractionSource: "manual",
        rawExtraction: invoice,
      })
      .returning({ id: invoices.id });
    const [payout] = await tx.insert(payouts).values({ invoiceId: row!.id }).returning({ id: payouts.id });
    await appendAudit(tx, {
      payoutId: payout!.id,
      actorId,
      type: "extracted",
      payload: { source: "manual", lowConfidence, issues: issues.map((i) => i.field) },
    });
    return payout!.id;
  });

  return planOne(payoutId);
}
