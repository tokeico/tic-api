// The four demo invoices from PRD §10. All names and identifiers are
// fictional (check digits are valid, though). Used by db:seed, the golden
// tests and scripts/fixtures.ts, so they can't drift apart.

import type { Invoice } from "../contracts";

export interface DemoInvoice extends Invoice {
  /** Stable key for fixtures and tests (DB rows get uuids). */
  key: "br" | "mx" | "ar" | "ve";
  payeeEmail: string;
}

export const DEMO_INVOICES: DemoInvoice[] = [
  {
    // Ready + warning on Oct 17 (Ponte, hasn't filed for BCB authorization). Sep 30: PagaFX. Oct 31: Sol.
    key: "br",
    invoiceNumber: "EP-2026-0412",
    payeeName: "Estúdio Paulista Design Ltda",
    payeeCountry: "BR",
    payeeTaxId: "12345678000195", // CNPJ
    payeeEmail: "financeiro@estudiopaulista.demo",
    amount: 85_000,
    currency: "BRL",
    dueDate: "2026-10-31",
    bankId: { type: "pix", value: "7d9f0a52-3c1e-4b8a-9e6f-2a4c8b1d5e30" }, // random (EVP) Pix key
    description: "Brand identity and packaging design, Q3 2026",
    purposeCode: "46978", // BCB Res. 277 Annex III "Serviço de negócio" (payments up to US$50k)
    lowConfidence: [],
  },
  {
    // ~USD 64.9k at 18.50: over the $50k policy, so needs a 2nd approver.
    key: "mx",
    invoiceNumber: "ADN-F-88213",
    payeeName: "Autopartes del Norte S.A. de C.V.",
    payeeCountry: "MX",
    payeeTaxId: "ADN0105149K3", // RFC
    payeeEmail: "cobranza@autopartesdelnorte.demo",
    amount: 1_200_000,
    currency: "MXN",
    dueDate: "2026-11-05",
    bankId: { type: "spei", value: "012580001234567897" }, // CLABE
    description: "Brake assemblies, PO 4471 (800 units)",
    purposeCode: null,
    lowConfidence: [],
  },
  {
    // Ready + AR-FX-SPREAD warning. Pampa PSAV (Cueva P2P is blocked).
    key: "ar",
    invoiceNumber: "LF-0031",
    payeeName: "Lucía Fernández",
    payeeCountry: "AR",
    payeeTaxId: "27312345671", // CUIT
    payeeEmail: "lucia.fernandez@correo.demo",
    amount: 4_000,
    currency: "USD",
    dueDate: "2026-10-25",
    bankId: { type: "cvu", value: "0000003110000123456781" }, // CVU
    description: "Frontend development, September 2026 (contractor)",
    purposeCode: null,
    lowConfidence: [],
  },
  {
    // Blocked by VE-OFAC on every route.
    key: "ve",
    invoiceNumber: "TO-2026-117",
    payeeName: "Transportes Orinoco C.A.",
    payeeCountry: "VE",
    payeeTaxId: "J-30123456-7", // RIF
    payeeEmail: "pagos@transportesorinoco.demo",
    amount: 12_500,
    currency: "USD",
    dueDate: "2026-10-30",
    bankId: { type: "swift", value: "DEMOVECAXXX" },
    description: "Freight forwarding, Puerto Cabello to Miami",
    purposeCode: null,
    lowConfidence: [],
  },
];

/** Strip the demo-only fields to get a contract Invoice. */
export function demoInvoice(key: DemoInvoice["key"]): Invoice {
  const d = DEMO_INVOICES.find((i) => i.key === key);
  if (!d) throw new Error(`no demo invoice ${key}`);
  const { key: _k, payeeEmail: _e, ...invoice } = d;
  return invoice;
}

/** Dates the slider demo uses (PRD §10, ARCHITECTURE §14). */
export const DEMO_DATES = ["2026-09-30", "2026-10-01", "2026-10-17", "2026-10-31"] as const;
