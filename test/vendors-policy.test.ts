import { afterEach, expect, test } from "bun:test";
import { demoVendorRows } from "../src/services/vendors";
import { clampPolicy, policyCeilings } from "../src/services/settings";

test("migration 0009 backfills exactly the seeded demo vendor records", async () => {
  const sql = await Bun.file(new URL("../drizzle/0009_modern_shiva.sql", import.meta.url)).text();
  for (const r of demoVendorRows()) {
    const literal = "(" + [r.country, r.taxId, r.name, r.bankIdType, r.bankIdValue].map((v) => "'" + v + "'").join(", ") + ", NULL";
    expect(sql.split(literal).length - 1).toBe(2); // tenant schemas + seeded public
  }
  expect(sql.match(/'Demo vendor record \(seeded\)'/g)?.length).toBe(demoVendorRows().length * 2);
});

afterEach(() => {
  delete process.env.POLICY_MAX_DAILY_CAP_USD;
  delete process.env.POLICY_MAX_SECOND_APPROVER_USD;
});

test("a stored policy above the hard ceilings is clamped on read", () => {
  expect(policyCeilings()).toEqual({ secondApproverAboveUsd: 100_000, dailyCapUsd: 1_000_000 });
  expect(clampPolicy({ secondApproverAboveUsd: 10_000_000, dailyCapUsd: 10_000_000 })).toEqual({ secondApproverAboveUsd: 100_000, dailyCapUsd: 1_000_000 });
  expect(clampPolicy({ secondApproverAboveUsd: 50_000, dailyCapUsd: 150_000 })).toEqual({ secondApproverAboveUsd: 50_000, dailyCapUsd: 150_000 });
  process.env.POLICY_MAX_DAILY_CAP_USD = "200000";
  expect(clampPolicy({ secondApproverAboveUsd: 50_000, dailyCapUsd: 10_000_000 }).dailyCapUsd).toBe(200_000);
});
