import { describe, expect, test } from "bun:test";
import type { Invoice, Route } from "../src/contracts";
import { createMockRail, getRailAdapter, parseRailMode, RailModeError, RailNotAvailableError, reference } from "../src/corredor";

const payee: Invoice = {
  invoiceNumber: "INV-1",
  payeeName: "Estúdio Paulista Design Ltda",
  payeeCountry: "BR",
  payeeTaxId: "12345678000199",
  amount: 85_000,
  currency: "BRL",
  dueDate: "2026-10-20",
  bankId: { type: "pix", value: "estudio@paulista.com" },
  description: "Design",
  purposeCode: "47197",
  lowConfidence: [],
};

const route: Route = {
  id: "br-ponte",
  kind: "stablecoin",
  asset: "USDC",
  network: "base",
  offramp: null,
  rail: "pix",
  feePct: 0.7,
  feeUsd: 110.19,
  minutes: 15,
  amountUsd: 15_740.74,
};

const input = { payoutId: "payout-br-1", route, amountUsd: route.amountUsd, payee };
const { fx } = reference();
const rail = createMockRail({ fx, now: () => new Date("2026-10-17T15:00:00.000Z") });

describe("mock rail", () => {
  test("same payout id is byte-identical", async () => {
    const first = await rail.send(input);
    const second = await rail.send(input);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test("tx hash and pix rail ref match the spec shapes", async () => {
    const sent = await rail.send(input);
    expect(sent.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(sent.railRef).toMatch(/^E[A-Z0-9]{31}$/);
  });

  test("different payout ids differ", async () => {
    const other = await rail.send({ ...input, payoutId: "payout-br-2" });
    expect(JSON.stringify(await rail.send(input))).not.toBe(JSON.stringify(other));
  });

  test("settle rate moves off the booking rate", async () => {
    const sent = await rail.send(input);
    expect(fx.rates.BRL).toBe(5.4);
    expect(sent.settleRate).not.toBe(5.4);
    expect(sent.settledLocal).toBe(payee.amount);
  });
});

describe("getRailAdapter", () => {
  test("defaults to mock when RAIL_MODE is unset", () => {
    const previous = process.env.RAIL_MODE;
    delete process.env.RAIL_MODE;
    try {
      expect(getRailAdapter(fx).mode).toBe("mock");
    } finally {
      if (previous === undefined) delete process.env.RAIL_MODE;
      else process.env.RAIL_MODE = previous;
    }
  });

  test("rejects an unknown mode", () => {
    expect(() => parseRailMode("wire")).toThrow(RailModeError);
  });

  test("bridge refuses to pay without an API key", async () => {
    const previous = process.env.BRIDGE_API_KEY;
    delete process.env.BRIDGE_API_KEY;
    try {
      const sent = getRailAdapter(fx, "bridge").send(input);
      await expect(sent).rejects.toThrow(RailNotAvailableError);
      await expect(sent).rejects.toThrow(/BRIDGE_API_KEY/);
    } finally {
      if (previous === undefined) delete process.env.BRIDGE_API_KEY;
      else process.env.BRIDGE_API_KEY = previous;
    }
  });
});
