// Writes the four demo invoices (src/corredor/demo.ts) as PDFs to data/invoices/,
// for the upload demo and the extraction tests. Byte-stable: the same data
// always gives the same file, so extraction caches by sha256 keep working.
//
// Usage: bun run scripts/demo-pdfs.ts [outDir]

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { DEMO_INVOICES, type DemoInvoice } from "../src/corredor";

const outDir = (process.argv[2] ?? new URL("../data/invoices/", import.meta.url).pathname).replace(/\/?$/, "/");
const FIXED = new Date("2026-10-10T12:00:00Z");

const TAX = { BR: "CNPJ", MX: "RFC", AR: "CUIT", VE: "RIF", CO: "NIT" } as const;
const BANK = { pix: "Chave Pix", spei: "CLABE", cvu: "CVU", pse: "PSE", swift: "SWIFT/BIC" } as const;
const CITY = { br: "São Paulo, SP, Brasil", mx: "Monterrey, N.L., México", ar: "Buenos Aires, Argentina", ve: "Caracas, Venezuela" } as const;

const money = (n: number, cur: string) => `${cur} ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function invoicePdf(inv: DemoInvoice): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Invoice ${inv.invoiceNumber}`);
  doc.setAuthor(inv.payeeName);
  doc.setProducer("Corredor demo");
  doc.setCreator("Corredor demo");
  doc.setCreationDate(FIXED);
  doc.setModificationDate(FIXED);
  const page = doc.addPage([595, 842]); // A4
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let y = 790;
  const line = (text: string, opts: { size?: number; b?: boolean; x?: number; gap?: number } = {}) => {
    page.drawText(text, { x: opts.x ?? 50, y, size: opts.size ?? 11, font: opts.b ? bold : font, color: rgb(0.08, 0.12, 0.11) });
    y -= opts.gap ?? (opts.size ?? 11) + 7;
  };

  line(inv.payeeName, { size: 18, b: true });
  line(CITY[inv.key]);
  line(`${TAX[inv.payeeCountry]}: ${inv.payeeTaxId ?? "-"}`);
  line(`Email: ${inv.payeeEmail}`, { gap: 30 });

  line("INVOICE", { size: 22, b: true });
  line(`Invoice number: ${inv.invoiceNumber}`);
  line("Invoice date: 2026-10-10");
  line(`Due date: ${inv.dueDate ?? "on receipt"}`, { gap: 30 });

  line("Bill to", { b: true });
  line("Corredor Demo Imports LLC");
  line("1200 Brickell Ave, Miami, FL 33131, USA", { gap: 30 });

  line("Description", { b: true });
  line(inv.description, { gap: 24 });
  line(`Total due: ${money(inv.amount, inv.currency)}`, { size: 14, b: true, gap: 34 });

  line("Payment details", { b: true });
  if (inv.bankId) line(`${BANK[inv.bankId.type]}: ${inv.bankId.value}`);
  line(`Beneficiary: ${inv.payeeName}`);
  if (inv.purposeCode) line(`FX purpose code: ${inv.purposeCode}`);
  y -= 20;
  line("Thank you for your business.", { size: 10 });
  return doc.save({ useObjectStreams: false });
}

if (import.meta.main) {
  for (const inv of DEMO_INVOICES) {
    const bytes = await invoicePdf(inv);
    await Bun.write(`${outDir}${inv.key}-${inv.invoiceNumber}.pdf`, bytes);
  }
  console.log(`Wrote ${DEMO_INVOICES.length} invoice PDFs to ${outDir}`);
}
