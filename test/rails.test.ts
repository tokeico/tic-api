import { describe, expect, test } from "bun:test";
import { bookingRate, mockSend, railFor, RailModeError } from "../src/corredor/rails";
import type { Invoice, Route } from "../src/corredor/rails/adapter";

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
  rail: "pix",
  feePct: 0.7,
  feeUsd: 110.19,
  minutes: 15,
  amountUsd: 15_740.74,
};

const input = { payoutId: "payout-br-1", route, amountUsd: route.amountUsd, payee };

describe("mock rail", () => {
  test("same payout id is byte-identical", async () => {
    const first = await mockSend(input);
    const second = await mockSend(input);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test("tx hash and pix rail ref match the spec shapes", () => {
    const sent = mockSend(input);
    expect(sent.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(sent.railRef).toMatch(/^E[A-Z0-9]{31}$/);
    expect(sent.offrampRef.startsWith("off_")).toBe(true);
  });

  test("different payout ids differ", () => {
    const other = mockSend({ ...input, payoutId: "payout-br-2" });
    expect(JSON.stringify(mockSend(input))).not.toBe(JSON.stringify(other));
  });

  test("settle rate moves off the booking rate", () => {
    const booking = bookingRate(payee, route);
    const sent = mockSend(input);
    expect(booking).toBe(5.4);
    expect(sent.settleRate).not.toBe(booking);
    expect(sent.settledLocal).toBe(Math.round(input.amountUsd * sent.settleRate * 100) / 100);
  });
});

describe("railFor", () => {
  test("defaults to mock when RAIL_MODE is unset", () => {
    const previous = process.env.RAIL_MODE;
    delete process.env.RAIL_MODE;
    try {
      expect(railFor().mode).toBe("mock");
    } finally {
      if (previous === undefined) delete process.env.RAIL_MODE;
      else process.env.RAIL_MODE = previous;
    }
  });

  test("rejects an unknown mode", () => {
    expect(() => railFor("wire")).toThrow(RailModeError);
  });

  test("bridge refuses to pay without an API key", async () => {
    const previous = process.env.BRIDGE_API_KEY;
    delete process.env.BRIDGE_API_KEY;
    try {
      await expect(railFor("bridge").send(input)).rejects.toThrow(/BRIDGE_API_KEY/);
    } finally {
      if (previous === undefined) delete process.env.BRIDGE_API_KEY;
      else process.env.BRIDGE_API_KEY = previous;
    }
  });
});
