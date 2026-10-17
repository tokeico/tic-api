// POST /api/invoices  multipart/form-data, field "file": one invoice PDF.
// POST /api/invoices/manual  JSON invoice fields, typed in by a person.
// → PayoutDetail of the new, already planned payout.

import { Hono } from "hono";
import { InvoicePatch } from "../contracts";
import { ApiError } from "../http-error";
import { requirePrincipal } from "../security/middleware";
import { EDITOR_ROLES } from "../services/payouts";
import { enterInvoice, MAX_PDF_BYTES, uploadInvoice } from "../services/invoices";

export const invoiceRoutes = new Hono();

invoiceRoutes.post("/", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.parseBody();
  } catch {
    throw new ApiError(400, "invalid_body", 'Send multipart/form-data with the PDF in a "file" field.');
  }
  const file = body.file;
  if (!(file instanceof File)) throw new ApiError(400, "invalid_body", 'Send multipart/form-data with the PDF in a "file" field.');
  if (file.size > MAX_PDF_BYTES) throw new ApiError(400, "too_large", "The PDF is larger than 10 MB.");
  const detail = await uploadInvoice({ filename: file.name || "invoice.pdf", bytes: new Uint8Array(await file.arrayBuffer()) });
  return c.json(detail, 201);
});

invoiceRoutes.post("/manual", async (c) => {
  const principal = requirePrincipal();
  if (!(EDITOR_ROLES as readonly string[]).includes(principal.role)) throw new ApiError(403, "not_authorized", `${principal.name} (${principal.role}) can't enter invoices.`);
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON.");
  }
  const parsed = InvoicePatch.required({ invoiceNumber: true, payeeName: true, payeeCountry: true, amount: true, currency: true }).safeParse(raw);
  if (!parsed.success) throw new ApiError(400, "invalid_body", parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  const f = parsed.data;
  const detail = await enterInvoice(
    {
      invoiceNumber: f.invoiceNumber,
      payeeName: f.payeeName,
      payeeCountry: f.payeeCountry,
      payeeTaxId: f.payeeTaxId ?? null,
      amount: f.amount,
      currency: f.currency,
      dueDate: f.dueDate ?? null,
      bankId: f.bankId ?? null,
      description: f.description ?? "",
      purposeCode: f.purposeCode ?? null,
    },
    principal.userId,
  );
  return c.json(detail, 201);
});
