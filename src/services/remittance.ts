// Remittance advice (P11): what the supplier needs to match the incoming
// domestic transfer to their invoice. The money arrives from the off-ramp's
// local account, not from the US payer, so the notice names the payer, the
// invoice and the local-rail reference (Pix end-to-end id, SPEI clave de
// rastreo, CVU transfer id). Prepared for sending; there's no mail provider,
// so nothing here sends anything.

import { desc, eq } from "drizzle-orm";
import type { Invoice } from "../contracts";
import { db, schema } from "../db";
import { ApiError } from "../http-error";
import { getPayout } from "./payouts";

export const REMITTANCE_LANGUAGES = ["pt", "es", "en"] as const;
export type RemittanceLanguage = (typeof REMITTANCE_LANGUAGES)[number];

export interface RemittanceAdvice {
  payoutId: string;
  language: RemittanceLanguage;
  subject: string;
  body: string;
  /** The local-rail reference the supplier's bank shows on the incoming transfer. */
  reference: string;
  rail: string;
  sent: false;
}

/** The payee's language by country: Portuguese for Brazil, Spanish elsewhere in LatAm. */
export const defaultLanguage = (country: Invoice["payeeCountry"]): RemittanceLanguage => (country === "BR" ? "pt" : "es");

const RAIL_REF_LABEL: Record<RemittanceLanguage, Record<string, string>> = {
  pt: { pix: "ID fim a fim do Pix (E2E)", spei: "Clave de rastreo SPEI", cvu: "ID da transferência", swift: "Referência SWIFT (UETR)" },
  es: { pix: "ID de extremo a extremo de Pix", spei: "Clave de rastreo SPEI", cvu: "ID de transferencia (Coelsa)", swift: "Referencia SWIFT (UETR)" },
  en: { pix: "Pix end-to-end ID", spei: "SPEI tracking key (clave de rastreo)", cvu: "Transfer ID (Coelsa)", swift: "SWIFT reference (UETR)" },
};

function money(amount: number, currency: string, lang: RemittanceLanguage): string {
  const locale = lang === "pt" ? "pt-BR" : lang === "es" ? "es-MX" : "en-US";
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount);
}

export async function remittanceAdvice(id: string, payerName: string, lang?: RemittanceLanguage): Promise<RemittanceAdvice> {
  const p = await getPayout(id);
  if (!p.payment || (p.status !== "paid" && p.status !== "booked")) {
    throw new ApiError(409, "not_paid", `A payout in status "${p.status}" has no payment to advise yet.`);
  }
  const row = await db.query.payments.findFirst({ where: eq(schema.payments.payoutId, id), orderBy: [desc(schema.payments.createdAt)] });
  const paidOn = (row?.settledAt ?? row?.createdAt ?? new Date()).toISOString().slice(0, 10);
  const language = lang ?? defaultLanguage(p.invoice.payeeCountry);
  const rail = p.plan?.recommended?.rail ?? "swift";
  const refLabel = RAIL_REF_LABEL[language][rail] ?? RAIL_REF_LABEL[language].swift!;
  const amount = money(p.invoice.amount, p.invoice.currency, language);
  const inv = p.invoice.invoiceNumber;
  const viaProvider = p.plan?.recommended?.offramp?.name;

  const text: Record<RemittanceLanguage, { subject: string; lines: string[] }> = {
    pt: {
      subject: `Aviso de pagamento: fatura ${inv}`,
      lines: [
        `Olá, ${p.invoice.payeeName}.`,
        ``,
        `${payerName} pagou a fatura ${inv}.`,
        `Valor: ${amount} (as tarifas foram pagas por nós)`,
        `Data do pagamento: ${paidOn}`,
        `${refLabel}: ${p.payment.railRef}`,
        viaProvider ? `O crédito chega pela conta local de ${viaProvider}, que fez a liquidação em nosso nome.` : ``,
        ``,
        `Se precisar do registro da operação de câmbio para a sua contabilidade, responda a esta mensagem.`,
      ],
    },
    es: {
      subject: `Aviso de pago: factura ${inv}`,
      lines: [
        `Hola, ${p.invoice.payeeName}:`,
        ``,
        `${payerName} pagó la factura ${inv}.`,
        `Importe: ${amount} (las comisiones corren por nuestra cuenta)`,
        `Fecha de pago: ${paidOn}`,
        `${refLabel}: ${p.payment.railRef}`,
        viaProvider ? `El abono llega desde la cuenta local de ${viaProvider}, que liquidó el pago por cuenta nuestra.` : ``,
        ``,
        `Si necesitan datos adicionales para su complemento de pago o su contabilidad, respondan a este mensaje.`,
      ],
    },
    en: {
      subject: `Payment advice: invoice ${inv}`,
      lines: [
        `Hello ${p.invoice.payeeName},`,
        ``,
        `${payerName} has paid invoice ${inv}.`,
        `Amount: ${amount} (we paid the fees)`,
        `Payment date: ${paidOn}`,
        `${refLabel}: ${p.payment.railRef}`,
        viaProvider ? `The credit arrives from ${viaProvider}'s local account, which settled the payment on our behalf.` : ``,
        ``,
        `Reply to this message if your accountant needs the FX record.`,
      ],
    },
  };
  const t = text[language];
  return {
    payoutId: id,
    language,
    subject: t.subject,
    body: t.lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n"),
    reference: p.payment.railRef,
    rail,
    sent: false,
  };
}
