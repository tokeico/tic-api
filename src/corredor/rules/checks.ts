// Check functions referenced by name from rules.json ("check.fn").
// Each one is pure: (ctx, params) → whether the rule's outcome applies.
// Params are validated with zod when the rules pack loads.

import { z } from "zod";
import { Invoice, OfframpType, type CheckFn, type Route } from "../../contracts";
import type { FxTable } from "../data";
import { fmtNum } from "../util";

export interface CheckContext {
  invoice: Invoice;
  route: Route;
  fx: FxTable;
}

export interface CheckOutput {
  /** True when the rule's outcome (block / warn / require_fields) applies. */
  hit: boolean;
  /** For requireFields: the invoice fields that are missing. */
  missing?: string[];
  /** Extra facts appended to the rule message, e.g. both FX rates. */
  detail?: string;
}

const invoiceFields = Invoice.keyof();

const paramSchemas = {
  always: z.object({}).strict(),
  offrampTypeIn: z.object({ types: z.array(OfframpType).min(1) }).strict(),
  amountUsdAbove: z
    .object({ limit: z.number().nonnegative(), offrampTypes: z.array(OfframpType).optional() })
    .strict(),
  requireFields: z.object({ fields: z.array(invoiceFields).min(1) }).strict(),
  fxSpreadAbove: z.object({ pct: z.number().nonnegative(), pair: z.string().regex(/^[A-Z]{3}$/) }).strict(),
} satisfies Record<CheckFn, z.ZodType>;

type Params<F extends CheckFn> = z.infer<(typeof paramSchemas)[F]>;

export function validateCheckParams(fn: CheckFn, params: unknown): void {
  paramSchemas[fn].parse(params);
}

const isBlank = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === "string" && v.trim() === "");

export const checks: { [F in CheckFn]: (ctx: CheckContext, params: Params<F>) => CheckOutput } = {
  always: () => ({ hit: true }),

  offrampTypeIn: ({ route }, { types }) => ({
    hit: route.offramp !== null && types.includes(route.offramp.type),
  }),

  amountUsdAbove: ({ route }, { limit, offrampTypes }) => {
    const typeMatches =
      !offrampTypes || (route.offramp !== null && offrampTypes.includes(route.offramp.type));
    return {
      hit: typeMatches && route.amountUsd > limit,
      detail: typeMatches && route.amountUsd > limit ? `Amount is USD ${fmtNum(route.amountUsd)}.` : undefined,
    };
  },

  requireFields: ({ invoice }, { fields }) => {
    const missing = fields.filter((f) => isBlank(invoice[f]));
    return { hit: missing.length > 0, missing };
  },

  fxSpreadAbove: ({ invoice, fx }, { pct, pair }) => {
    // Only meaningful when the invoice is denominated in the parallel-market currency.
    if (invoice.currency !== pair) return { hit: false };
    const official = fx.rates[`${pair}_official`];
    const parallel = fx.rates[`${pair}_parallel`];
    if (official === undefined || parallel === undefined) return { hit: false };
    const spread = (Math.abs(parallel - official) / official) * 100;
    const hit = spread > pct;
    return {
      hit,
      detail: hit
        ? `Official ${fmtNum(official)} vs. market (USDT) ${fmtNum(parallel)} ${pair}/USD (${spread.toFixed(1)}% gap).`
        : undefined,
    };
  },
};

export function runCheck(fn: CheckFn, params: Record<string, unknown>, ctx: CheckContext): CheckOutput {
  // Params were validated at load time; the cast only bridges the generic.
  return (checks[fn] as (c: CheckContext, p: Record<string, unknown>) => CheckOutput)(ctx, params);
}
