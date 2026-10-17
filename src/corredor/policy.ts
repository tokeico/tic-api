// Approval mandate (Agent Passport-lite, PRD 8.6):
// - payouts over policy.secondApproverAboveUsd need a second, different approver
// - policy.dailyCapUsd caps the USD approved per day across payouts
// Pure: the caller passes in the existing approvals and today's approved total.

import type { PayoutStatus, Policy } from "../contracts";
import { fmtUsd, round2 } from "./util";

export const DEFAULT_POLICY: Policy = { secondApproverAboveUsd: 50_000, dailyCapUsd: 150_000 };

export type ApprovalRole = "first" | "second";

export interface ApprovalRecord {
  approverId: string;
  role: ApprovalRole;
  decision: "approved" | "rejected";
}

export interface ApprovalInput {
  /** Status of the payout right now (from its latest plan / workflow). */
  status: PayoutStatus;
  amountUsd: number;
  policy: Policy;
  existing: ApprovalRecord[];
  approverId: string;
  decision: "approved" | "rejected";
  /** USD already approved today on other payouts (for the daily cap). */
  approvedTodayUsd: number;
}

export type ApprovalDecision =
  | { ok: true; role: ApprovalRole; nextStatus: PayoutStatus; final: boolean }
  | { ok: false; code: "not_approvable" | "already_decided" | "same_approver" | "daily_cap_exceeded"; message: string };

export function requiresSecondApprover(amountUsd: number, policy: Policy): boolean {
  return amountUsd > policy.secondApproverAboveUsd;
}

export function requiredApprovals(amountUsd: number, policy: Policy): 1 | 2 {
  return requiresSecondApprover(amountUsd, policy) ? 2 : 1;
}

export function decideApproval(input: ApprovalInput): ApprovalDecision {
  const { status, amountUsd, policy, existing, approverId, decision } = input;

  if (status !== "ready" && status !== "awaiting_second_approver") {
    return { ok: false, code: "not_approvable", message: `A payout in status "${status}" can't be approved or rejected.` };
  }
  if (existing.some((a) => a.decision === "rejected")) {
    return { ok: false, code: "already_decided", message: "This payout was already rejected." };
  }
  const needed = requiredApprovals(amountUsd, policy);
  if (existing.length >= needed) {
    return { ok: false, code: "already_decided", message: "This payout already has all the approvals it needs." };
  }
  if (existing.some((a) => a.approverId === approverId)) {
    return { ok: false, code: "same_approver", message: "The second approver must be a different person." };
  }

  const role: ApprovalRole = existing.length === 0 ? "first" : "second";
  if (decision === "rejected") return { ok: true, role, nextStatus: "rejected", final: true };

  const final = existing.length + 1 >= needed;
  const projected = round2(input.approvedTodayUsd + amountUsd);
  if (projected > policy.dailyCapUsd) {
    return {
      ok: false,
      code: "daily_cap_exceeded",
      message: `Approving ${fmtUsd(amountUsd)} would bring today's total to ${fmtUsd(projected)}, over the ${fmtUsd(policy.dailyCapUsd)} daily cap.`,
    };
  }
  return { ok: true, role, nextStatus: final ? "approved" : "awaiting_second_approver", final };
}
