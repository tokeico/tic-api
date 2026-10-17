// Booked payout history for a workspace's books (/ledger) and Inbox: Jul–Oct
// 2026, fictional vendors in BR, MX and AR. Every row goes through the real
// engine, mock rail and journal builder, so plans, payments, reconciliations
// and journal entries are exactly what a booked payout would have. Audit
// events and approval rows are not written: the chain stays as it is, and the
// app's daily cap (which sums every approval on record) stays free for today.
// The caller sets the workspace search_path.

import { and, eq, notInArray } from "drizzle-orm";
import type { Invoice } from "../contracts";
import {
  buildJournalEntry,
  createMockRail,
  DEMO_INVOICES,
  planHash,
  planPayout,
  rateFor,
  reconcile,
  reference,
  screenPayee,
} from "../corredor";
import { schema } from "../db";
import type { Tx } from "./tx";

type Vendor = Omit<Invoice, "invoiceNumber" | "amount" | "dueDate" | "description" | "lowConfidence"> & {
  prefix: string;
  /** Typical invoice size in local currency; each invoice varies around it. */
  typical: number;
  work: string[];
};

const VENDORS: Vendor[] = [
  { prefix: "EP", payeeName: "Estúdio Paulista Design Ltda", payeeCountry: "BR", payeeTaxId: "12345678000195", currency: "BRL", typical: 62_000, bankId: { type: "pix", value: "7d9f0a52-3c1e-4b8a-9e6f-2a4c8b1d5e30" }, purposeCode: "46978", work: ["Brand identity retainer", "Packaging design sprint", "Campaign art direction"] },
  { prefix: "PDL", payeeName: "Ponte Digital Ltda", payeeCountry: "BR", payeeTaxId: "45678912000150", currency: "BRL", typical: 118_000, bankId: { type: "pix", value: "financeiro@pontedigital.demo" }, purposeCode: "46978", work: ["Platform engineering", "QA and release support", "Data pipeline build"] },
  { prefix: "CAB", payeeName: "Cafezal Brasil Logística Ltda", payeeCountry: "BR", payeeTaxId: "98765432000110", currency: "BRL", typical: 41_000, bankId: { type: "pix", value: "+5511987654321" }, purposeCode: "46978", work: ["Warehousing, São Paulo", "Last-mile delivery", "Customs brokerage"] },
  { prefix: "ADN", payeeName: "Autopartes del Norte S.A. de C.V.", payeeCountry: "MX", payeeTaxId: "ADN0105149K3", currency: "MXN", typical: 610_000, bankId: { type: "spei", value: "012180001234567899" }, purposeCode: null, work: ["Brake assemblies, lot", "Suspension parts, lot", "Tooling and molds"] },
  { prefix: "TQS", payeeName: "Tequila Software S. de R.L.", payeeCountry: "MX", payeeTaxId: "TSO170312AB1", currency: "MXN", typical: 285_000, bankId: { type: "spei", value: "002180700123456788" }, purposeCode: null, work: ["Mobile app development", "Support retainer", "Cloud migration"] },
  { prefix: "LOG", payeeName: "Logística Bajío S.A. de C.V.", payeeCountry: "MX", payeeTaxId: "LBA9811235Q7", currency: "MXN", typical: 190_000, bankId: { type: "spei", value: "014180655012345674" }, purposeCode: null, work: ["Cross-dock services", "Freight, Querétaro–Laredo", "Pallet storage"] },
  { prefix: "LF", payeeName: "Lucía Fernández", payeeCountry: "AR", payeeTaxId: "27304567891", currency: "USD", typical: 4_200, bankId: { type: "cvu", value: "0000003110001234567898" }, purposeCode: null, work: ["Product design, monthly", "UX research sprint"] },
  { prefix: "PSA", payeeName: "Pampa Studio S.A.", payeeCountry: "AR", payeeTaxId: "30712345674", currency: "USD", typical: 11_500, bankId: { type: "cvu", value: "0000003110009876543216" }, purposeCode: null, work: ["Motion design", "3D product renders"] },
];

/** Deterministic pseudo-random numbers so re-runs produce the same books. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Replace this workspace's history (every seed invoice except the four live demo ones). */
export async function seedHistory(tx: Tx): Promise<number> {
  const rand = rng(561);
  const r = reference();
  const keep = DEMO_INVOICES.map((i) => i.invoiceNumber);
  let booked = 0;
  // One sanctions screen per vendor, not per invoice: keeps sign-up fast.
  const screened = new Map<string, Awaited<ReturnType<typeof screenPayee>>>();
  // Re-runs replace the history: every seed invoice except the four live demo ones.
  await tx.delete(schema.invoices).where(and(eq(schema.invoices.source, "seed"), notInArray(schema.invoices.invoiceNumber, keep)));

  // Business days Jul 1 – Oct 16, a few payouts each.
  const start = Date.UTC(2026, 6, 1);
  const end = Date.UTC(2026, 9, 16);
  let n = 0;
  for (let t = start; t <= end; t += 86_400_000) {
    const day = new Date(t);
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
    if (rand() > 0.42) continue;
    const v = VENDORS[Math.floor(rand() * VENDORS.length)]!;
    const amount = Math.round((v.typical * (0.6 + rand() * 0.8)) / 10) * 10;
    const asOf = iso(day);
    const seq = String(1000 + n).padStart(4, "0");
    const { prefix, typical: _t, work, ...payee } = v;
    const invoice: Invoice = {
      ...payee,
      invoiceNumber: `${prefix}-2026-${seq}`,
      amount,
      dueDate: iso(new Date(t + 14 * 86_400_000)),
      description: `${work[Math.floor(rand() * work.length)]}, ${day.toLocaleString("en-US", { month: "long", timeZone: "UTC" })} 2026`,
      lowConfidence: [],
    };

    const created = new Date(Date.now() + 1000 + n); // after the demo invoices, so the tour still finds them first
    const { bankId, ...row } = invoice;
    const [inv] = await tx
      .insert(schema.invoices)
      .values({ ...row, bankIdType: bankId?.type ?? null, bankIdValue: bankId?.value ?? null, source: "seed", extractionSource: "seed", createdAt: created })
      .returning({ id: schema.invoices.id });
    const [payout] = await tx.insert(schema.payouts).values({ invoiceId: inv!.id, createdAt: created }).returning({ id: schema.payouts.id });
    let screening = screened.get(invoice.payeeName);
    if (!screening) {
      screening = await screenPayee(invoice.payeeName);
      screened.set(invoice.payeeName, screening);
    }
    const plan = planPayout({ payoutId: payout!.id, invoice, asOf, screening });
    const route = plan.recommended;
    if (plan.status !== "ready" || !route || route.amountUsd >= 50_000) {
      await tx.delete(schema.invoices).where(eq(schema.invoices.id, inv!.id));
          continue;
    }
    n++;

    const approvedAt = new Date(t + (9 + rand() * 6) * 3_600_000);
    const settledAt = new Date(approvedAt.getTime() + (route.minutes + 5) * 60_000);
    const [planRow] = await tx
      .insert(schema.plans)
      .values({
        payoutId: payout!.id,
        asOf,
        rulesVersion: plan.rulesVersion,
        status: plan.status,
        screeningStatus: plan.screening.status,
        recommendedRouteId: route.id,
        recommended: route,
        evaluations: plan.evaluations,
        reasons: plan.reasons,
        plan,
        planHash: planHash(plan),
        createdAt: new Date(approvedAt.getTime() - 3_600_000),
      })
      .returning({ id: schema.plans.id });
    // No approval rows: the app's daily cap sums every approval on record, so
    // back-dated ones would fill today's cap. approvedAt on the payout keeps the date.

    const sent = await createMockRail({ fx: r.fx, now: () => settledAt }).send({ payoutId: payout!.id, route, amountUsd: route.amountUsd, payee: invoice });
    const [payment] = await tx
      .insert(schema.payments)
      .values({
        payoutId: payout!.id,
        planId: planRow!.id,
        routeId: route.id,
        route,
        railMode: "mock",
        status: "settled",
        amountUsd: route.amountUsd,
        feeUsd: route.feeUsd,
        localCurrency: invoice.currency,
        settledLocal: sent.settledLocal,
        settleRate: sent.settleRate,
        txHash: sent.txHash,
        offrampRef: sent.offrampRef,
        railRef: sent.railRef,
        createdAt: approvedAt,
        settledAt,
      })
      .returning({ id: schema.payments.id });

    const record = { payoutId: payout!.id, route, amountUsd: route.amountUsd, feeUsd: route.feeUsd, txHash: sent.txHash, offrampRef: sent.offrampRef, railRef: sent.railRef, settledLocal: sent.settledLocal, settleRate: sent.settleRate };
    const match = reconcile({ payoutId: payout!.id, invoice, payment: record, others: [] });
    await tx.insert(schema.reconciliations).values({ payoutId: payout!.id, paymentId: payment!.id, status: match.status, reason: match.reason, createdAt: settledAt });
    if (match.status !== "matched") continue; // shows in the books as an exception, like a real one

    const entry = buildJournalEntry({ payoutId: payout!.id, invoice, payment: record, bookingRate: rateFor(invoice.currency, r.fx), entryDate: iso(settledAt) });
    const [header] = await tx
      .insert(schema.journalEntries)
      .values({ payoutId: payout!.id, paymentId: payment!.id, entryDate: entry.entryDate, description: entry.description, currency: entry.currency, bookingRate: entry.bookingRate, settleRate: entry.settleRate, createdAt: settledAt })
      .returning({ id: schema.journalEntries.id });
    await tx.insert(schema.journalLines).values(entry.lines.map((l) => ({ entryId: header!.id, ...l })));
    await tx
      .update(schema.payouts)
      .set({ status: "booked", asOf, amountUsd: route.amountUsd, recommendedRouteId: route.id, approvedAt, paidAt: settledAt, bookedAt: settledAt })
      .where(eq(schema.payouts.id, payout!.id));
    booked++;
  }  return booked;
}
