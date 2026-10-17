// App settings from the `settings` table (policy, demo clock) plus the rail mode.
import { eq } from "drizzle-orm";
import { IsoDate, Policy, type Settings } from "../contracts";
import { DEFAULT_POLICY, parseRailMode } from "../corredor";
import { schema } from "../db";
import type { DbOrTx } from "./tx";

export const DEFAULT_AS_OF = () => process.env.DEMO_DEFAULT_AS_OF ?? "2026-10-17";

export async function getSettings(q: DbOrTx): Promise<Settings> {
  const rows = await q.select().from(schema.settings);
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const asOf = IsoDate.safeParse(byKey.get("demo_as_of"));
  const policy = Policy.safeParse(byKey.get("policy"));
  return {
    asOf: asOf.success ? asOf.data : DEFAULT_AS_OF(),
    railMode: parseRailMode(process.env.RAIL_MODE),
    policy: policy.success ? policy.data : DEFAULT_POLICY,
  };
}

export async function setDemoAsOf(q: DbOrTx, asOf: string): Promise<void> {
  await q
    .insert(schema.settings)
    .values({ key: "demo_as_of", value: asOf })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: asOf } });
}

export async function getDemoAsOf(q: DbOrTx): Promise<string> {
  const row = await q.query.settings.findFirst({ where: eq(schema.settings.key, "demo_as_of") });
  const parsed = IsoDate.safeParse(row?.value);
  return parsed.success ? parsed.data : DEFAULT_AS_OF();
}
