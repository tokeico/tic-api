import { describe, expect, test } from "bun:test";
import type { PayoutDetail } from "../src/contracts";
import { demoInvoice, planPayout, reference } from "../src/corredor";
import { resolvePayout, runTool } from "../src/llm/agent";

const invoice = demoInvoice("br");
const payout: PayoutDetail = {
  id: "demo-br",
  payeeName: invoice.payeeName,
  country: "BR",
  amountLocal: invoice.amount,
  currency: invoice.currency,
  amountUsd: 15740.74,
  status: "ready",
  warnings: 1,
  recommended: null,
  invoice,
  plan: planPayout({ payoutId: "demo-br", invoice, asOf: "2026-10-17", screening: { status: "clear" } }),
  memo: null,
  approvals: [],
};

const context = (all: PayoutDetail[] = [payout]) => ({
  asOf: "2026-10-17",
  rules: reference().rules,
  payouts: async () => all,
  proposals: [],
});

describe("agent payout lookup", () => {
  test("get_payout recovers the model's Estúdia typo and returns the actual route", async () => {
    const result = JSON.parse(await runTool("get_payout", { payout: "Estúdia Paulista Design Ltda" }, context()));
    expect(result.payout).toBe("Estúdio Paulista Design Ltda");
    expect(result.id).toBe(payout.id);
    expect(result.route).toContain("Ponte Digital");
    expect(result.rulesOnRecommendedRoute.some((r: { rule: string }) => r.rule === "BR-VASP-UNFILED-WARN")).toBe(true);
  });

  test("read-only lookup tolerates one missing or extra character", async () => {
    for (const name of ["Estúdi Paulista Design Ltda", "Estúdioo Paulista Design Ltda"]) {
      const result = JSON.parse(await runTool("get_payout", { payout: name }, context()));
      expect(result.id).toBe(payout.id);
    }
  });

  test("exact identifiers and accent-insensitive partial names still resolve", () => {
    for (const ref of [payout.id, invoice.invoiceNumber, "BR", "estudio", "Paulista"]) {
      expect(resolvePayout(ref, [payout])?.id).toBe(payout.id);
    }
  });

  test("action proposals never use typo correction", async () => {
    for (const name of ["Estúdia Paulista Design Ltda", "Estúdioo Paulista Design Ltda"]) {
      expect(resolvePayout(name, [payout])).toBeUndefined();
      const ctx = context();
      await expect(runTool("propose_action", {
        kind: "approve",
        payout: name,
        title: "Approve Brazil",
        why: "Ready",
      }, ctx)).rejects.toThrow();
      expect(ctx.proposals).toEqual([]);
    }
  });

  test("duplicate payees require an invoice or payout id, not the first match", async () => {
    const second = { ...payout, id: "second-br", invoice: { ...invoice, invoiceNumber: "OTHER-1" } };
    const all = [payout, second];
    for (const ref of [payout.payeeName, "Paulista", "BR", "Estúdia Paulista Design Ltda"]) {
      await expect(runTool("get_payout", { payout: ref }, context(all))).rejects.toThrow();
    }
    expect(resolvePayout("OTHER-1", all)?.id).toBe(second.id);
    expect(resolvePayout(payout.id, all)?.id).toBe(payout.id);
  });

  test("equally close names are not guessed and exact names take precedence", async () => {
    const second = { ...payout, id: "other-br", payeeName: "Estúdie Paulista Design Ltda" };
    await expect(runTool("get_payout", { payout: "Estúdia Paulista Design Ltda" }, context([payout, second]))).rejects.toThrow();
    expect(resolvePayout(payout.payeeName, [second, payout])?.id).toBe(payout.id);
  });

  test("unrelated and short inputs do not pick a payout", async () => {
    for (const ref of ["", "x", "Estádia Paulista Design Ltda", "Another supplier", "demo-bx"]) {
      await expect(runTool("get_payout", { payout: ref }, context())).rejects.toThrow();
    }
  });

  test("list_payouts includes stable ids for the next tool call", async () => {
    const result = JSON.parse(await runTool("list_payouts", {}, context()));
    expect(result.payouts[0].id).toBe(payout.id);
  });
});
