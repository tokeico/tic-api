import { customType } from "drizzle-orm/pg-core";

/**
 * jsonb column for the Bun.SQL driver. Use this instead of drizzle's
 * built-in `jsonb` from "drizzle-orm/pg-core".
 *
 * Drizzle's jsonb calls JSON.stringify before handing the value to the
 * driver, but Bun.SQL serialises jsonb parameters itself. Using both
 * double-encodes the value: it's stored as a JSON *string* ("{\"a\":1}"),
 * so SQL like `plan->'recommended'` returns null. This type passes values
 * through untouched in both directions.
 *
 * Usage: payload: jsonb<MyShape>("payload").notNull()
 */
export const jsonb = <TData>(name: string) =>
  customType<{ data: TData; driverData: TData }>({
    dataType: () => "jsonb",
    toDriver: (value) => value,
    fromDriver: (value) => value,
  })(name);
