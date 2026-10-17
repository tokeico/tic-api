// The rules engine: plan(input) → Plan.
//
// AI reads and explains, code decides, a human approves. This file is the
// "code decides" part. It is a pure function with no I/O, no clock and no
// randomness, so the same inputs and as-of date always give byte-identical
// JSON (test/rules.test.ts proves it).

import type {
  BankDetailsCheck,
  Invoice,
  Objective,
  Plan,
  PayoutStatus,
  Policy,
  Reroute,
  Route,
  RouteEvaluation,
  Rule,
  RuleResult,
  Screening,
} from "../../contracts";
import type { FxTable } from "../data";
import { NETWORK_PREFERENCE } from "../quote";
import { assertIsoDate, fmtUsd } from "../util";
import { validateInvoice } from "../validate";
import { runCheck } from "./checks";

/** Screening result as the engine sees it, plus any human review. */
export interface ScreeningInput extends Screening {
  /** Set once a compliance reviewer has looked at a possible_match / hit. */
  reviewDecision?: "cleared" | "confirmed_hit" | null;
}

/** A compliance sign-off on a sanctions policy hold, as the engine sees it. */
export interface SanctionsInput {
  decision: "released" | "confirmed_blocked";
  /** OFAC general license relied on, e.g. "GL 57"; null rests on "nobody blocked is involved". */
  licenseRef: string | null;
  /** Reviewer's name: the rule message quotes it, so the plan explains who signed off. */
  by: string;
}

export interface PlanInput {
  payoutId: string;
  invoice: Invoice;
  asOf: string; // YYYY-MM-DD
  routes: Route[]; // from quote()
  screening: ScreeningInput;
  /** Recorded sanctions sign-off on this payout, if any (see applySanctionsReview). */
  sanctions?: SanctionsInput | null;
  rules: Rule[];
  rulesVersion: string;
  fx: FxTable;
  policy: Policy;
  /** Routing preference among compliant routes (default cheapest). */
  objective?: Objective;
  /** Verified-vendor bank-detail check (C9). Absent = not checked (tests, previews). */
  bankDetails?: BankDetailsCheck;
}

// ---- Rule selection -----------------------------------------------------------

/** effectiveFrom and effectiveTo are both inclusive; null means open-ended. */
export function isActive(rule: Rule, asOf: string): boolean {
  return (rule.effectiveFrom === null || asOf >= rule.effectiveFrom) &&
    (rule.effectiveTo === null || asOf <= rule.effectiveTo);
}

/** Rules in force on `asOf`, optionally for one corridor (GET /api/rules). */
export function activeRules(rules: Rule[], asOf: string, corridor?: string): Rule[] {
  assertIsoDate(asOf, "asOf");
  return rules.filter((r) => isActive(r, asOf) && (corridor === undefined || r.corridor === corridor));
}

function appliesTo(rule: Rule, route: Route): boolean {
  return rule.appliesTo === "any" || rule.appliesTo === route.kind;
}

// ---- Evaluation ---------------------------------------------------------------

/** Run every applicable rule against one route. `rules` must already be the
 *  active rules for the invoice's corridor. Results keep rules.json order. */
export function evaluateRoute(route: Route, invoice: Invoice, rules: Rule[], fx: FxTable): RouteEvaluation {
  const results: RuleResult[] = [];
  for (const rule of rules) {
    if (!appliesTo(rule, route)) continue;
    const out = runCheck(rule.check.fn, rule.check.params, { invoice, route, fx });
    const result: RuleResult = {
      ruleId: rule.id,
      title: rule.title,
      outcome: out.hit ? rule.outcome : "pass",
      message: out.hit && out.detail ? `${rule.message} ${out.detail}` : rule.message,
      source: rule.source,
      effectiveFrom: rule.effectiveFrom,
    };
    if (out.hit && out.missing && out.missing.length > 0) result.missingFields = out.missing;
    results.push(result);
  }
  return { route, results, compliant: !results.some((r) => r.outcome === "block") };
}

const networkRank = (r: Route): number =>
  r.network === null ? NETWORK_PREFERENCE.length : NETWORK_PREFERENCE.indexOf(r.network);

/** Cheapest first; ties by speed, preferred network, then id (total order). */
export function compareCost(a: Route, b: Route): number {
  return a.feeUsd - b.feeUsd || a.minutes - b.minutes || networkRank(a) - networkRank(b) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Compliant routes first, each group cheapest first. */
export function rankEvaluations(evals: RouteEvaluation[]): RouteEvaluation[] {
  return [...evals].sort((a, b) => Number(b.compliant) - Number(a.compliant) || compareCost(a.route, b.route));
}

const warnCount = (e: RouteEvaluation): number => e.results.filter((r) => r.outcome === "warn").length;

/**
 * Among compliant routes, a stablecoin route if there is one (the wire is the
 * fallback), chosen by the routing preference. `ranked` is already cheapest
 * first, so "cheapest" is the first one. The preference never sees a blocked route.
 */
export function pickRecommended(ranked: RouteEvaluation[], objective: Objective = "cheapest"): RouteEvaluation | null {
  const compliant = ranked.filter((e) => e.compliant);
  const coins = compliant.filter((e) => e.route.kind === "stablecoin");
  if (coins.length > 0) {
    if (objective === "fastest") return [...coins].sort((a, b) => a.route.minutes - b.route.minutes || compareCost(a.route, b.route))[0]!;
    if (objective === "safest") return [...coins].sort((a, b) => warnCount(a) - warnCount(b) || compareCost(a.route, b.route))[0]!;
    return coins[0]!;
  }
  return compliant.find((e) => e.route.kind === "wire") ?? null;
}

/**
 * A compliance sign-off on a policy-hold rule (`liftedBy: "sanctions_signoff"`).
 * A release turns the block into a warning naming the sign-off, so the
 * checklist and the memo still show why the hold was lifted and by whom; a
 * confirmation keeps the block and records who confirmed it. Rules stay data:
 * only rules marked `liftedBy` change behaviour.
 */
function applySanctionsReview(evaluations: RouteEvaluation[], rules: Rule[], review: SanctionsInput): RouteEvaluation[] {
  const signoffRules = new Set(rules.filter((r) => r.liftedBy === "sanctions_signoff").map((r) => r.id));
  if (signoffRules.size === 0) return evaluations;
  return evaluations.map((e) => {
    const results = e.results.map((r) => {
      if (r.outcome !== "block" || !signoffRules.has(r.ruleId)) return r;
      if (review.decision === "released") {
        const gl = review.licenseRef ? ` under OFAC general license ${review.licenseRef}` : "";
        return {
          ...r,
          outcome: "warn" as const,
          message: `${r.message} Compliance sign-off recorded by ${review.by}${gl}: the payee, its owners and the receiving bank were reviewed.`,
        };
      }
      return { ...r, message: `${r.message} Confirmed by compliance review (${review.by}): a blocked person or bank is involved. Do not pay.` };
    });
    return { ...e, results, compliant: !results.some((r) => r.outcome === "block") };
  });
}

// ---- Plan ----------------------------------------------------------------------

const ref = (r: RuleResult) => `${r.ruleId}: ${r.message}`;

export function plan(input: PlanInput): Plan {
  const { payoutId, invoice, asOf, routes, screening, policy, fx } = input;
  assertIsoDate(asOf, "asOf");

  const rules = activeRules(input.rules, asOf, invoice.payeeCountry);
  let evaluations = routes.map((route) => evaluateRoute(route, invoice, rules, fx));
  if (input.sanctions) evaluations = applySanctionsReview(evaluations, rules, input.sanctions);
  const ranked = rankEvaluations(evaluations);
  const best = pickRecommended(ranked, input.objective);
  const recommended = best?.route ?? null;
  const amountUsd = routes[0]?.amountUsd ?? 0;

  const reasons: string[] = [];
  let status: PayoutStatus;

  const screeningBlocks =
    screening.status !== "clear" && screening.reviewDecision !== "cleared";

  if (screeningBlocks) {
    status = "blocked";
    const what = screening.status === "hit" ? "Sanctions hit" : "Possible sanctions match";
    const detail = screening.match
      ? ` against OFAC SDN entry "${screening.match}"${screening.score !== undefined ? ` (score ${screening.score.toFixed(2)})` : ""}`
      : "";
    reasons.push(
      screening.reviewDecision === "confirmed_hit"
        ? `${what}${detail}, confirmed by compliance review. Do not pay.`
        : `${what}${detail}. Blocked until a compliance reviewer clears it.`,
    );
  }

  if (best === null) {
    status = "blocked";
    if (routes.length === 0) reasons.push(`No candidate routes for ${invoice.payeeCountry}.`);
    // Every distinct blocking rule, in ranked-route order, once each.
    const seen = new Set<string>();
    for (const e of ranked) {
      for (const r of e.results) {
        if (r.outcome === "block" && !seen.has(r.ruleId)) {
          seen.add(r.ruleId);
          reasons.push(ref(r));
        }
      }
    }
  } else {
    const results = best.results;
    const missing = [...new Set(results.flatMap((r) => (r.outcome === "require_fields" ? (r.missingFields ?? []) : [])))];
    const bankIssues = validateInvoice(invoice).filter((i) => i.field === "bankId");
    if (invoice.bankId === null || bankIssues.length > 0) missing.push("bankId");

    for (const r of results) {
      if (r.outcome === "require_fields") reasons.push(`${ref(r)} Missing: ${r.missingFields?.join(", ")}.`);
    }
    if (invoice.bankId === null) reasons.push("Payee bank identifier (Pix key / CLABE / CVU / account) is missing.");
    for (const i of bankIssues) reasons.push(`Bank identifier failed its check: ${i.message}`);
    for (const r of results) if (r.outcome === "warn") reasons.push(ref(r));

    // C9: bank details that don't match the verified vendor record hold the
    // payout until a person calls the vendor back and re-verifies.
    const bankHold = input.bankDetails !== undefined && input.bankDetails.status !== "verified";
    if (bankHold) {
      reasons.push(
        input.bankDetails!.status === "changed"
          ? "Bank details differ from the verified vendor record. Call the vendor back on a number from your records (not the invoice) and record the verification before approving."
          : "No verified bank details on file for this vendor. Call the vendor back on a number from your records (not the invoice) and record the verification before approving.",
      );
    }

    const needsSecond = amountUsd > policy.secondApproverAboveUsd;
    if (needsSecond) {
      reasons.push(
        `${fmtUsd(amountUsd)} is over the ${fmtUsd(policy.secondApproverAboveUsd)} policy limit: a second approver is required.`,
      );
    }

    status = screeningBlocks
      ? "blocked"
      : missing.length > 0
        ? "needs_info"
        : bankHold
          ? "blocked"
          : needsSecond
            ? "awaiting_second_approver"
            : "ready";
  }

  return {
    payoutId,
    asOf,
    rulesVersion: input.rulesVersion,
    screening: {
      status: screening.status,
      ...(screening.match !== undefined ? { match: screening.match } : {}),
      ...(screening.score !== undefined ? { score: screening.score } : {}),
    },
    evaluations: ranked,
    recommended,
    status: status!,
    reasons,
    ...(input.bankDetails !== undefined ? { bankDetails: input.bankDetails } : {}),
  };
}

/** Number of warnings on the recommended route (inbox badge). */
export function warningCount(p: Plan): number {
  if (!p.recommended) return 0;
  const e = p.evaluations.find((x) => x.route.id === p.recommended!.id);
  return e ? e.results.filter((r) => r.outcome === "warn").length : 0;
}

// ---- Reroutes (the slider's "why" tooltip) ---------------------------------------

const blockersOf = (p: Plan, routeId: string): RuleResult[] =>
  p.evaluations.find((e) => e.route.id === routeId)?.results.filter((r) => r.outcome === "block") ?? [];

/**
 * Explain why the recommended route changed between two plans for the same
 * payout. Returns null when it didn't change.
 *  - The old route is now blocked → the rule that blocks it "took effect".
 *  - Otherwise the new route used to be blocked → that rule "no longer applies".
 */
export function diffPlans(prev: Plan, next: Plan): Reroute | null {
  const from = prev.recommended?.id ?? null;
  const to = next.recommended?.id ?? null;
  if (from === to) return null;

  if (from !== null) {
    const before = new Set(blockersOf(prev, from).map((r) => r.ruleId));
    const now = blockersOf(next, from).find((r) => !before.has(r.ruleId));
    if (now) {
      return { payoutId: next.payoutId, from, to, ruleId: now.ruleId, reason: `${now.ruleId} took effect: ${now.title}` };
    }
  }
  if (to !== null) {
    const nowIds = new Set(blockersOf(next, to).map((r) => r.ruleId));
    const lifted = blockersOf(prev, to).find((r) => !nowIds.has(r.ruleId));
    if (lifted) {
      return {
        payoutId: next.payoutId,
        from,
        to,
        ruleId: lifted.ruleId,
        reason: `${lifted.ruleId} not in effect on ${next.asOf}: ${lifted.title}`,
      };
    }
  }
  return { payoutId: next.payoutId, from, to, ruleId: null, reason: "Route options changed (invoice or provider data)." };
}
