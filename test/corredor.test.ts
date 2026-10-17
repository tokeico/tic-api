import { describe, expect, test } from "bun:test";
import {
  buildJournalEntry,
  createMockRail,
  decideApproval,
  demoInvoice,
  DEMO_INVOICES,
  DEFAULT_POLICY,
  isValidClabe,
  isValidCnpj,
  isValidCuit,
  isValidCvu,
  journalToCsv,
  planPayout,
  quote,
  reconcile,
  reference,
  routeLabel,
  screenPayee,
  toPayoutSummary,
  validateInvoice,
  type PaymentRecord,
} from "../src/corredor";
import { assertBalanced } from "../src/corredor/reconcile";

const fixedNow = () => new Date("2026-10-17T15:00:00.000Z");

describe("quote", () => {
  test("wire plus one route per asset × network × off-ramp", () => {
    const ids = quote(demoInvoice("br"), reference()).map((r) => r.id);
    expect(ids).toEqual(["BR:wire:swift", "BR:usdc-base:br-pagafx", "BR:usdc-base:br-ponte", "BR:usdc-base:br-sol", "BR:usdc-arbitrum:br-sol"]);
    const wire = quote(demoInvoice("br"), reference())[0]!;
    expect(wire).toMatchObject({ feePct: 2.5, minutes: 2880, feeUsd: 393.52, amountUsd: 15740.74 });
    // Stablecoin routes are all-in: off-ramp + 0.10% on-ramp, plus the flat network fee.
    const ponte = quote(demoInvoice("br"), reference()).find((r) => r.id === "BR:usdc-base:br-ponte")!;
    expect(ponte).toMatchObject({ feePct: 0.8, feeUsd: 125.98 });
  });

  test("VE has only the wire", () => {
    expect(quote(demoInvoice("ve"), reference()).map((r) => r.kind)).toEqual(["wire"]);
  });

  test("route labels", () => {
    const p = planPayout({ payoutId: "x", invoice: demoInvoice("br"), asOf: "2026-10-31", screening: { status: "clear" } });
    expect(routeLabel(p.recommended!)).toBe("USDC · Base · Sol VASP · 0.95%");
    expect(toPayoutSummary("x", demoInvoice("br"), p)).toEqual({
      id: "x", payeeName: "Estúdio Paulista Design Ltda", country: "BR", amountLocal: 85000, currency: "BRL",
      amountUsd: 15740.74, status: "ready", warnings: 0,
      recommended: { id: "BR:usdc-base:br-sol", label: "USDC · Base · Sol VASP · 0.95%", feePct: 0.95, minutes: 10 },
    });
  });
});

describe("policy", () => {
  const base = { policy: DEFAULT_POLICY, existing: [], decision: "approved" as const, approvedTodayUsd: 0 };

  test("under $50k: one approval → approved", () => {
    expect(decideApproval({ ...base, status: "ready", amountUsd: 15740.74, approverId: "maria" })).toMatchObject({ ok: true, role: "first", nextStatus: "approved", final: true });
  });

  test("over $50k: first approval waits, second (different person) approves", () => {
    const first = decideApproval({ ...base, status: "awaiting_second_approver", amountUsd: 64864.86, approverId: "maria" });
    expect(first).toMatchObject({ ok: true, role: "first", nextStatus: "awaiting_second_approver", final: false });
    const existing = [{ approverId: "maria", role: "first" as const, decision: "approved" as const }];
    expect(decideApproval({ ...base, existing, status: "awaiting_second_approver", amountUsd: 64864.86, approverId: "maria" })).toMatchObject({ ok: false, code: "same_approver" });
    expect(decideApproval({ ...base, existing, status: "awaiting_second_approver", amountUsd: 64864.86, approverId: "daniel" })).toMatchObject({ ok: true, role: "second", nextStatus: "approved" });
  });

  test("daily cap", () => {
    expect(decideApproval({ ...base, status: "ready", amountUsd: 40000, approverId: "m", approvedTodayUsd: 120000 })).toMatchObject({ ok: false, code: "daily_cap_exceeded" });
  });

  test("blocked / needs_info can't be approved; rejection is final", () => {
    expect(decideApproval({ ...base, status: "blocked", amountUsd: 1, approverId: "m" })).toMatchObject({ ok: false, code: "not_approvable" });
    expect(decideApproval({ ...base, status: "ready", amountUsd: 1, approverId: "m", decision: "rejected" })).toMatchObject({ ok: true, nextStatus: "rejected" });
  });
});

describe("mock rail, reconciliation and journal", () => {
  const { fx } = reference();
  const rail = createMockRail({ fx, now: fixedNow });

  async function pay(key: "br" | "mx" | "ar") {
    const invoice = demoInvoice(key);
    const plan = planPayout({ payoutId: `demo-${key}`, invoice, asOf: "2026-10-17", screening: { status: "clear" } });
    const route = plan.recommended!;
    const sent = await rail.send({ payoutId: plan.payoutId, route, amountUsd: route.amountUsd, payee: invoice });
    const payment: PaymentRecord = { payoutId: plan.payoutId, route, amountUsd: route.amountUsd, feeUsd: route.feeUsd, ...sent };
    return { invoice, plan, route, sent, payment };
  }

  test("mock IDs are realistic and deterministic", async () => {
    const a = await pay("br");
    const b = await pay("br");
    expect(a.sent).toEqual(b.sent);
    expect(a.sent.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a.sent.railRef).toMatch(/^E[0-9A-Z]{31}$/);
    expect(a.sent.offrampRef).toStartWith("BR-PONTE-");
    expect(a.sent.settledLocal).toBe(85000);
    expect(Math.abs(a.sent.settleRate / 5.4 - 1)).toBeLessThanOrEqual(0.005);
    expect(rail.simulated).toBe(true);
  });

  test("a clean payment reconciles as matched", async () => {
    const { invoice, payment } = await pay("br");
    expect(reconcile({ payoutId: "demo-br", invoice, payment })).toEqual({ status: "matched", reasons: [], reason: null });
  });

  test("exceptions: reused tx hash, short settlement, missing refs", async () => {
    const { invoice, payment } = await pay("br");
    const dup = reconcile({ payoutId: "demo-br", invoice, payment, others: [{ payoutId: "other", txHash: payment.txHash, railRef: null }] });
    expect(dup.status).toBe("exception");
    expect(dup.reason).toContain("already matched to payout other");
    const short = reconcile({ payoutId: "demo-br", invoice, payment: { ...payment, settledLocal: 80000 } });
    expect(short.reason).toContain("exceeds the quoted fee");
    expect(reconcile({ payoutId: "demo-br", invoice, payment: { ...payment, txHash: null, railRef: null } }).reasons).toHaveLength(2);
  });

  test("journal entry matches the spec example at an unchanged rate", async () => {
    const { invoice, payment } = await pay("br");
    // Spec §13 example: same booking and settle rate.
    const je = buildJournalEntry({ payoutId: "demo-br", invoice, payment: { ...payment, feeUsd: 133.8, settleRate: 5.4, settledLocal: 85000 }, bookingRate: 5.4, entryDate: "2026-10-17" });
    expect(je.lines.map((l) => [l.account, l.debit, l.credit])).toEqual([
      ["Accounts Payable – Estúdio Paulista Design Ltda", 15740.74, 0],
      ["Bank & network fees", 133.8, 0],
      ["FX gain", 0, 0],
      ["Cash – Operating bank (USD)", 0, 15874.54], // pay-through: no stablecoin held
    ]);
  });

  test("journal entries balance with a simulated FX move, for every demo payout", async () => {
    for (const key of ["br", "mx", "ar"] as const) {
      const { invoice, payment, sent } = await pay(key);
      const bookingRate = invoice.currency === "USD" ? 1 : fx.rates[invoice.currency]!;
      const je = buildJournalEntry({ payoutId: `demo-${key}`, invoice, payment: { ...payment, settledLocal: sent.settledLocal, settleRate: sent.settleRate }, bookingRate, entryDate: "2026-10-17" });
      expect(() => assertBalanced(je.lines)).not.toThrow();
      const fxLine = je.lines.find((l) => l.account.startsWith("FX"))!;
      if (invoice.currency === "USD") expect(fxLine.debit + fxLine.credit).toBe(0);
      else expect(fxLine.debit + fxLine.credit).toBeGreaterThan(0);
    }
  });

  test("CSV export (QuickBooks journal format) escapes and guards formulas", () => {
    const csv = journalToCsv([{
      id: "JE-1", payoutId: "p1", entryDate: "2026-10-17", description: "d", currency: "USD", bookingRate: 1, settleRate: 1,
      lines: [
        { lineNo: 1, account: "Accounts Payable – Foo, Inc", description: '=HYPERLINK("x")', debit: 10, credit: 0 },
        { lineNo: 2, account: "Cash", description: null, debit: 0, credit: 10 },
      ],
    }]);
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("JournalNo,JournalDate,AccountName,Debits,Credits,Description,Name,Currency");
    expect(lines[1]).toBe(`JE-1,2026-10-17,"Accounts Payable – Foo, Inc",10.00,,"'=HYPERLINK(""x"")",p1,USD`);
    expect(lines[2]).toBe("JE-1,2026-10-17,Cash,,10.00,d,p1,USD");
  });

  test("CSV Name column uses the payee name when provided (P10)", () => {
    const csv = journalToCsv([
      {
        payoutId: "p1", name: "Acme SA", entryDate: "2026-10-17", description: "d", currency: "USD", bookingRate: 1, settleRate: 1,
        lines: [{ lineNo: 1, account: "Cash", description: null, debit: 0, credit: 10 }],
      },
    ]);
    expect(csv.trim().split("\r\n")[1]).toBe("CORR-0001,2026-10-17,Cash,,10.00,d,Acme SA,USD");
  });
});

describe("field validation", () => {
  test("demo identifiers have valid check digits", () => {
    expect(isValidClabe("012580001234567897")).toBe(true);
    expect(isValidCnpj("12345678000195")).toBe(true);
    expect(isValidCvu("0000003110000123456781")).toBe(true);
    expect(isValidCuit("27312345671")).toBe(true);
    for (const d of DEMO_INVOICES) expect(validateInvoice(demoInvoice(d.key))).toEqual([]);
  });

  test("alphanumeric CNPJ (issued since July 2026) validates with the Receita Federal example", () => {
    expect(isValidCnpj("12.ABC.345/01DE-35")).toBe(true);
    expect(isValidCnpj("12abc34501de35")).toBe(true);
    expect(isValidCnpj("12.ABC.345/01DE-34")).toBe(false);
    expect(isValidCnpj("12.ABC.345/01DE-3A")).toBe(false); // check digits are always numeric
  });

  test("bad check digits are reported", () => {
    expect(isValidClabe("012580001234567890")).toBe(false);
    expect(isValidCnpj("12345678000190")).toBe(false);
    expect(isValidCvu("0000003110000123456780")).toBe(false);
    expect(isValidCnpj("00000000000000")).toBe(false);
    const issues = validateInvoice({ ...demoInvoice("mx"), bankId: { type: "spei", value: "12345" } });
    expect(issues).toEqual([{ field: "bankId", message: expect.stringContaining("18 digits") }]);
  });
});

describe("OFAC screening (committed SDN snapshot)", () => {
  test("the 0009 migration backfills exactly the demoVendorRows() literals", async () => {
    const { demoVendorRows } = await import("../src/services/vendors");
    const sql = await Bun.file("drizzle/0009_modern_shiva.sql").text();
    const block = sql.match(/INSERT INTO %I\.vendors[\s\S]*?ON CONFLICT \(country, tax_id\) DO NOTHING/);
    expect(block).not.toBeNull();
    const literalRows = [...block![0].matchAll(/\('([A-Z]{2})', '([^']+)', '([^']+)', '([a-z_]+)', '([^']+)', NULL, now\(\), '([^']+)', 'seed'\)/g)].map((m) => ({
      country: m[1],
      taxId: m[2],
      name: m[3],
      bankIdType: m[4],
      bankIdValue: m[5],
      verificationNote: m[6],
    }));
    const expected = demoVendorRows().map(({ country, taxId, name, bankIdType, bankIdValue, verificationNote }) => ({
      country,
      taxId,
      name,
      bankIdType,
      bankIdValue,
      verificationNote,
    }));
    expect(literalRows).toEqual(expected);
  });

  test("demo payees are clear", async () => {
    for (const d of DEMO_INVOICES) expect((await screenPayee(d.payeeName)).status).toBe("clear");
  });

  test("listed names hit, lookalikes are possible matches", async () => {
    expect(await screenPayee("Petróleos de Venezuela S.A.")).toMatchObject({ status: "hit", score: 1, matchedEntryId: "26367" });
    expect(await screenPayee("PDVSA")).toMatchObject({ status: "hit" });
    const look = await screenPayee("Petroleo de Venesuela SA");
    expect(look.status).toBe("possible_match");
    expect(look.match).toContain("PETROLEOS DE VENEZUELA");
  });

  test("the six sanctioned spellings are all non-clear (C5)", async () => {
    for (const name of ["P.D.V.S.A.", "PDVSA", "N. Maduro", "Maduro Moros", "Nicolas Maduro", "Petróleos de Venezuela"]) {
      const r = await screenPayee(name);
      expect(r.status).not.toBe("clear");
    }
  });

  test("ordinary LatAm business names stay clear (no false positives)", async () => {
    const names = [
      "Estúdio Paulista Design Ltda",
      "Autopartes del Norte SA de CV",
      "Transportes Rápidos del Sur",
      "Comercial Andina SRL",
      "J. Silva Consultoria",
      "Farmácia Central do Brasil",
      "Distribuidora Mexicana del Pacífico",
      "Inversiones Caribe Ltda",
      "Servicios Logísticos del Bajío",
      "Alimentos del Valle SA",
      "Constructora Horizonte SAS",
      "Importadora Pacífico Sur",
      "Textiles Andinos EIRL",
      "Grupo Frontera Norte",
      "Panificadora Estrela Ltda",
      "Consultores del Plata SA",
    ];
    for (const name of names) expect((await screenPayee(name)).status).toBe("clear");
  });
});
