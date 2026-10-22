// Reference data loaded once at startup: the rules pack, the off-ramp
// registry and the FX table. Everything is validated against the contracts
// so a typo in a JSON file fails at boot, not in the middle of the demo.
//
// These live in git, not in Postgres, so the rules engine stays
// deterministic (DATABASE.md, "Schema overview").

import { z } from "zod";
import { Offramp, Rule } from "../contracts";
import offrampsJson from "../../reference/offramps.json";
import fxJson from "../../reference/fx.json";
import rulesJson from "./rules/rules.json";
import { validateCheckParams } from "./rules/checks";

/** Bump when rules.json changes. Stored on every plan (plans.rules_version). */
export const RULES_VERSION = "v1";

export const FxTable = z.object({
  /** Local currency per USD. ARS has `ARS_official` and `ARS_parallel`. */
  rates: z.record(z.string(), z.number().positive()),
  /** Unnegotiated bank wire, all-in. */
  wire: z.object({ feePct: z.number().nonnegative(), minutes: z.number().int().positive() }),
  /** USD → stablecoin on-ramp fee, on every stablecoin route. */
  onramp: z.object({ feePct: z.number().nonnegative() }),
  /** Flat chain fee per transfer, USD. */
  networkFeeUsd: z.record(z.string(), z.number().nonnegative()),
});
export type FxTable = z.infer<typeof FxTable>;

export interface ReferenceData {
  rulesVersion: string;
  rules: Rule[];
  offramps: Offramp[];
  fx: FxTable;
}

/** Parse and check a rules pack. Throws with the offending rule id. */
export function parseRules(raw: unknown): Rule[] {
  const rules = z.array(Rule).parse(raw);
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.id)) throw new Error(`rules.json: duplicate rule id ${rule.id}`);
    seen.add(rule.id);
    if (rule.effectiveFrom && rule.effectiveTo && rule.effectiveTo < rule.effectiveFrom) {
      throw new Error(`rules.json: ${rule.id} ends before it starts`);
    }
    try {
      validateCheckParams(rule.check.fn, rule.check.params);
    } catch (err) {
      throw new Error(`rules.json: ${rule.id} has bad check params: ${(err as Error).message}`);
    }
  }
  return rules;
}

export function parseOfframps(raw: unknown): Offramp[] {
  const list = z.object({ offramps: z.array(Offramp) }).parse(raw).offramps;
  const ids = new Set<string>();
  for (const o of list) {
    if (ids.has(o.id)) throw new Error(`offramps.json: duplicate id ${o.id}`);
    ids.add(o.id);
  }
  return list;
}

export function loadReferenceData(): ReferenceData {
  return {
    rulesVersion: RULES_VERSION,
    rules: parseRules(rulesJson),
    offramps: parseOfframps(offrampsJson),
    fx: FxTable.parse(fxJson),
  };
}
