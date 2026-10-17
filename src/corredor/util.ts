// Small pure helpers shared by the corredor core.
import { createHash } from "node:crypto";

/** Round to cents. Uses integer math so 1.005 → 1.01 behaves predictably. */
export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Number → integer cents. */
export const toCents = (n: number): number => Math.round((n + Number.EPSILON) * 100);

/** Integer cents → number with 2 decimals. */
export const fromCents = (c: number): number => c / 100;

const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const numFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** "$15,740.74" */
export const fmtUsd = (n: number): string => usdFmt.format(n);

/** "1,350" / "8.15" */
export const fmtNum = (n: number): string => numFmt.format(n);

/** "BRL 85,000.00" */
export const fmtMoney = (n: number, currency: string): string =>
  `${currency} ${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)}`;

/**
 * Canonical JSON: object keys sorted, no whitespace, `undefined` properties
 * dropped. The same value always gives the same bytes, which is what plan
 * hashes and the audit chain need.
 */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`canonicalJSON: non-finite number ${value}`);
    }
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sortKeys);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined) out[key] = sortKeys(v);
  }
  return out;
}

export const sha256Hex = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date in YYYY-MM-DD form. */
export function isIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function assertIsoDate(s: string, what = "date"): void {
  if (!isIsoDate(s)) throw new Error(`${what} must be a YYYY-MM-DD date, got "${s}"`);
}
