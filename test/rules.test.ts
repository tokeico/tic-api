// Golden tests for the rules engine (ARCHITECTURE §14). These double as a
// demo talking point: "the same inputs and date always give the same plan".
import { describe, expect, test } from "bun:test";
import {
  DEMO_DATES,
  canonicalJSON,
  demoInvoice,
  diffPlans,
  parseRules,
  planHash,
  planPayout,
  reference,
  replanAll,
  rulesActiveOn,
  warningCount,
  type ScreeningInput,
} from "../src/corredor";
import type { Invoice, Plan } from "../src/contracts";

const clear: ScreeningInput = { status: "clear" };
const planFor = (key: "br" | "mx" | "ar" | "ve", asOf: string, invoice: Invoice = demoInvoice(key)) =>
  planPayout({ payoutId: `demo-${key}`, invoice, asOf, screening: clear });

const recommendedOfframp = (p: Plan) => p.recommended?.offramp?.id ?? null;
const resultFor = (p: Plan, ruleId: string) =>
  p.evaluations.find((e) => e.route.id === p.recommended?.id)?.results.find((r) => r.ruleId === ruleId);

describe("golden: demo invoices across the slider dates", () => {
  test("BR reroutes PagaFX → Ponte → Ponte → Sol", () => {
    const got = DEMO_DATES.map((d) => recommendedOfframp(planFor("br", d)));
    expect(got).toEqual(["br-pagafx", "br-ponte", "br-ponte", "br-sol"]);
  });

  test("BR statuses and warnings per date", () => {
    const [sep30, oct1, oct17, oct31] = DEMO_DATES.map((d) => planFor("br", d));
    expect(sep30!.status).toBe("ready");
    expect(warningCount(sep30!)).toBe(0);
    for (const p of [oct1!, oct17!]) {
      expect(p.status).toBe("ready");
      expect(resultFor(p, "BR-VASP-UNFILED-WARN")?.outcome).toBe("warn");
    }
    expect(oct31!.status).toBe("ready");
    expect(warningCount(oct31!)).toBe(0);
    expect(oct31!.recommended?.id).toBe("BR:usdc-base:br-sol"); // Base preferred over Arbitrum at equal cost
  });

  test("BR on Oct 17: PagaFX blocked by BR-561-EFX, purpose code satisfied, USD amount", () => {
    const p = planFor("br", "2026-10-17");
    const pagafx = p.evaluations.find((e) => e.route.offramp?.id === "br-pagafx")!;
    expect(pagafx.compliant).toBe(false);
    expect(pagafx.results.find((r) => r.outcome === "block")?.ruleId).toBe("BR-561-EFX");
    expect(resultFor(p, "BR-521-FX")?.outcome).toBe("pass");
    expect(p.recommended?.amountUsd).toBe(15_740.74);
    expect(p.recommended?.feeUsd).toBe(110.19); // 0.70%
  });

  test("MX is always Puente and awaiting a second approver", () => {
    for (const d of DEMO_DATES) {
      const p = planFor("mx", d);
      expect(recommendedOfframp(p)).toBe("mx-puente");
      expect(p.status).toBe("awaiting_second_approver");
      const azul = p.evaluations.find((e) => e.route.offramp?.id === "mx-bancoazul")!;
      expect(azul.results.find((r) => r.outcome === "block")?.ruleId).toBe("MX-BANK-CRYPTO");
    }
  });

  test("AR is Pampa with an AR-FX-SPREAD warning showing both rates", () => {
    for (const d of DEMO_DATES) {
      const p = planFor("ar", d);
      expect(recommendedOfframp(p)).toBe("ar-pampa");
      expect(p.status).toBe("ready");
      const spread = resultFor(p, "AR-FX-SPREAD")!;
      expect(spread.outcome).toBe("warn");
      expect(spread.message).toContain("1,518");
      expect(spread.message).toContain("1,619");
      const cueva = p.evaluations.find((e) => e.route.offramp?.id === "ar-cueva")!;
      expect(cueva.compliant).toBe(false);
    }
  });

  test("VE is blocked on every route with no recommendation", () => {
    for (const d of DEMO_DATES) {
      const p = planFor("ve", d);
      expect(p.status).toBe("blocked");
      expect(p.recommended).toBeNull();
      expect(p.evaluations.every((e) => !e.compliant)).toBe(true);
      expect(p.reasons.some((r) => r.startsWith("VE-OFAC"))).toBe(true);
    }
  });

  test("determinism: 100 runs give byte-identical JSON", () => {
    for (const key of ["br", "mx", "ar", "ve"] as const) {
      const first = JSON.stringify(planFor(key, "2026-10-17"));
      for (let i = 0; i < 100; i++) expect(JSON.stringify(planFor(key, "2026-10-17"))).toBe(first);
      expect(planHash(planFor(key, "2026-10-17"))).toBe(planHash(JSON.parse(first)));
    }
  });
});

describe("reroutes (slider toast)", () => {
  const br = (d: string) => planFor("br", d);

  test("Sep 30 → Oct 1 names BR-561-EFX", () => {
    const r = diffPlans(br("2026-09-30"), br("2026-10-01"))!;
    expect(r).toMatchObject({ from: "BR:usdc-base:br-pagafx", to: "BR:usdc-base:br-ponte", ruleId: "BR-561-EFX" });
    expect(r.reason).toContain("took effect");
  });

  test("Oct 30 is still a valid filing day: Ponte stays, with a warning", () => {
    expect(diffPlans(br("2026-10-17"), br("2026-10-30"))).toBeNull();
    expect(resultFor(br("2026-10-30"), "BR-VASP-UNFILED-WARN")?.outcome).toBe("warn");
  });

  test("Oct 17 → Oct 31 names BR-VASP-AUTH", () => {
    expect(diffPlans(br("2026-10-17"), br("2026-10-31"))).toMatchObject({ to: "BR:usdc-base:br-sol", ruleId: "BR-VASP-AUTH" });
  });

  test("dragging back explains which rule isn't in effect yet", () => {
    const r = diffPlans(br("2026-10-31"), br("2026-10-17"))!;
    expect(r).toMatchObject({ from: "BR:usdc-base:br-sol", to: "BR:usdc-base:br-ponte", ruleId: "BR-VASP-AUTH" });
    expect(r.reason).toContain("not in effect on 2026-10-17");
    expect(diffPlans(br("2026-10-01"), br("2026-09-30"))?.ruleId).toBe("BR-561-EFX");
  });

  test("no change → null; replanAll only reports real reroutes", () => {
    expect(diffPlans(br("2026-10-01"), br("2026-10-17"))).toBeNull();
    const items = (["br", "mx", "ar", "ve"] as const).map((k) => ({
      payoutId: `demo-${k}`,
      invoice: demoInvoice(k),
      screening: clear,
      previous: planFor(k, "2026-09-30"),
    }));
    const { plans, reroutes } = replanAll(items, "2026-10-01");
    expect(plans).toHaveLength(4);
    expect(reroutes).toEqual([expect.objectContaining({ payoutId: "demo-br", ruleId: "BR-561-EFX" })]);
  });
});

describe("engine edge cases", () => {
  test("missing BR purpose code → needs_info naming the field", () => {
    const p = planFor("br", "2026-10-17", { ...demoInvoice("br"), purposeCode: null });
    expect(p.status).toBe("needs_info");
    expect(resultFor(p, "BR-521-FX")).toMatchObject({ outcome: "require_fields", missingFields: ["purposeCode"] });
  });

  test("missing bank identifier → needs_info", () => {
    expect(planFor("ar", "2026-10-17", { ...demoInvoice("ar"), bankId: null }).status).toBe("needs_info");
  });

  test("BR above the USD 100k cap after Oct 1 falls back to the wire", () => {
    const p = planFor("br", "2026-10-17", { ...demoInvoice("br"), amount: 600_000 });
    expect(p.recommended?.kind).toBe("wire");
    const sol = p.evaluations.find((e) => e.route.offramp?.id === "br-sol")!;
    expect(sol.results.find((r) => r.outcome === "block")?.ruleId).toBe("BR-521-CAP");
    expect(p.status).toBe("awaiting_second_approver"); // ~$111k
  });

  test("screening possible_match blocks until a reviewer clears it", () => {
    const invoice = demoInvoice("ar");
    const flagged = planPayout({ payoutId: "x", invoice, asOf: "2026-10-17", screening: { status: "possible_match", match: "X", score: 0.9 } });
    expect(flagged.status).toBe("blocked");
    expect(flagged.recommended?.offramp?.id).toBe("ar-pampa"); // the route is still shown
    expect(flagged.reasons[0]).toContain("Possible sanctions match");
    const cleared = planPayout({
      payoutId: "x", invoice, asOf: "2026-10-17",
      screening: { status: "possible_match", match: "X", score: 0.9, reviewDecision: "cleared" },
    });
    expect(cleared.status).toBe("ready");
  });

  test("evaluations are ranked compliant-first then cheapest", () => {
    const p = planFor("br", "2026-10-17");
    const flags = p.evaluations.map((e) => e.compliant);
    expect(flags).toEqual([...flags].sort((a, b) => Number(b) - Number(a)));
    expect(p.evaluations[0]!.route.id).toBe(p.recommended!.id);
  });

  test("rejects malformed as-of dates", () => {
    expect(() => planFor("br", "2026-13-01")).toThrow();
    expect(() => planFor("br", "17/10/2026")).toThrow();
  });

  test("unknown currency throws a clear error", () => {
    expect(() => planFor("br", "2026-10-17", { ...demoInvoice("br"), currency: "EUR" })).toThrow(/No FX rate for EUR/);
  });
});

describe("rules pack", () => {
  test("the pack has the 11 rules verified against primary sources", () => {
    const ids = reference().rules.map((r) => r.id);
    expect(ids).toEqual([
      "BR-521-FX", "BR-521-CAP", "BR-561-EFX", "BR-VASP-PENDING-WARN", "BR-VASP-UNFILED-WARN", "BR-VASP-AUTH", "BR-VASP-ART91",
      "MX-BANK-CRYPTO", "AR-PSAV", "AR-FX-SPREAD", "VE-OFAC",
    ]);
    for (const r of reference().rules) expect(r.source.url).toStartWith("https://");
  });

  test("active rules change on the effective dates (BR)", () => {
    const ids = (d: string) => rulesActiveOn(d, "BR").map((r) => r.id);
    expect(ids("2026-09-30")).not.toContain("BR-561-EFX");
    expect(ids("2026-10-01")).toContain("BR-561-EFX");
    // Oct 30 is the deadline to FILE for authorization (Res. 520 art. 88 I; IN 704 art. 9), so a
    // provider that never filed is blocked from Oct 31. Pending applicants may keep operating.
    expect(ids("2026-10-30")).toContain("BR-VASP-UNFILED-WARN");
    expect(ids("2026-10-30")).not.toContain("BR-VASP-AUTH");
    expect(ids("2026-10-31")).not.toContain("BR-VASP-UNFILED-WARN");
    expect(ids("2026-10-31")).toContain("BR-VASP-AUTH");
    expect(ids("2027-06-01")).toContain("BR-VASP-PENDING-WARN");
    expect(ids("2026-11-05")).not.toContain("BR-VASP-ART91");
    expect(ids("2026-11-06")).toContain("BR-VASP-ART91");
  });

  test("bad rules fail at load time", () => {
    const good = reference().rules[0]!;
    expect(() => parseRules([good, good])).toThrow(/duplicate/);
    expect(() => parseRules([{ ...good, check: { fn: "requireFields", params: { fields: ["nope"] } } }])).toThrow(/bad check params/);
    expect(() => parseRules([{ ...good, check: { fn: "doMagic", params: {} } }])).toThrow();
  });

  test("canonicalJSON sorts keys", () => {
    expect(canonicalJSON({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] }, u: undefined })).toBe('{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
  });
});
