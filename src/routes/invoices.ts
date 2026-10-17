// POST /api/invoices  multipart/form-data, field "file": one invoice PDF.
// → PayoutDetail of the new, already planned payout.

import { Hono } from "hono";
import { ApiError } from "../http-error";
import { MAX_PDF_BYTES, uploadInvoice } from "../services/invoices";

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
