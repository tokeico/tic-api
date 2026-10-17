import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { railFor } from "../corredor/rails";
import type { Invoice } from "../corredor/rails/adapter";
import type { Route } from "../db/types";
import { db } from "../db";
import { payments, payouts, plans, type InvoiceRow } from "../db/schema";

export const payoutRoutes = new Hono();

class PaymentConflict extends Error {}

function error(code: string, message: string) {
  return { error: { code, message } };
}

function invoiceForRail(row: InvoiceRow): Invoice {
  return {
    invoiceNumber: row.invoiceNumber,
    payeeName: row.payeeName,
    payeeCountry: row.payeeCountry,
    payeeTaxId: row.payeeTaxId,
    amount: row.amount,
    currency: row.currency,
    dueDate: row.dueDate,
    bankId:
      row.bankIdType && row.bankIdValue
        ? { type: row.bankIdType, value: row.bankIdValue }
        : null,
    description: row.description,
    purposeCode: row.purposeCode,
    lowConfidence: row.lowConfidence,
  };
}

function warningCount(recommendedId: string | null, evaluations: { route: Route; results: { outcome: string }[] }[]) {
  if (!recommendedId) return 0;
  const row = evaluations.find((e) => e.route.id === recommendedId);
  return row?.results.filter((r) => r.outcome === "warn").length ?? 0;
}

function recommendedSummary(route: Route | null) {
  if (!route) return null;
  const offramp = route.offramp?.name ?? route.id;
  const label = [route.asset, route.network, offramp].filter(Boolean).join(" · ");
  return { id: route.id, label, feePct: route.feePct, minutes: route.minutes };
}

payoutRoutes.post("/:id/pay", async (c) => {
  const id = c.req.param("id");
  const payout = await db.query.payouts.findFirst({
    where: eq(payouts.id, id),
    with: { invoice: true },
  });
  if (!payout?.invoice) return c.json(error("not_found", "Payout not found"), 404);

  const planRow = await db.query.plans.findFirst({
    where: eq(plans.payoutId, payout.id),
    orderBy: desc(plans.createdAt),
    with: { memos: true },
  });

  const recommended = planRow?.recommended ?? null;
  if (payout.status !== "approved" || !recommended) {
    return c.json(
      error("not_approved", "Payout must be approved and have a recommended route before it can be paid"),
      409,
    );
  }

  if (!planRow) {
    return c.json(error("no_plan", "Payout has no plan to pay against"), 409);
  }

  const amountUsd = payout.amountUsd ?? recommended.amountUsd;
  if (typeof amountUsd !== "number") {
    return c.json(error("no_amount", "Payout is missing amountUsd"), 400);
  }

  const rail = railFor();
  const payee = invoiceForRail(payout.invoice);
  const sent = await rail.send({
    payoutId: payout.id,
    route: recommended,
    amountUsd,
    payee,
  });

  const now = new Date();

  try {
    await db.transaction(async (tx) => {
      const updated = await tx
        .update(payouts)
        .set({ status: "paid", paidAt: now })
        .where(and(eq(payouts.id, payout.id), eq(payouts.status, "approved")))
        .returning({ id: payouts.id });
      if (updated.length === 0) throw new PaymentConflict();

      await tx.insert(payments).values({
        payoutId: payout.id,
        planId: planRow.id,
        routeId: recommended.id,
        route: recommended,
        railMode: rail.mode,
        status: "settled",
        amountUsd,
        feeUsd: recommended.feeUsd,
        localCurrency: payee.currency,
        settledLocal: sent.settledLocal,
        settleRate: sent.settleRate,
        txHash: sent.txHash,
        offrampRef: sent.offrampRef,
        railRef: sent.railRef,
        settledAt: now,
      });
    });
  } catch (err) {
    if (err instanceof PaymentConflict) {
      return c.json(
        error("not_approved", "Payout must be approved and have a recommended route before it can be paid"),
        409,
      );
    }
    throw err;
  }

  const memoRow =
    planRow.memos.length > 0
      ? [...planRow.memos].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
      : null;
  const evaluations = planRow.evaluations;

  return c.json({
    id: payout.id,
    payeeName: payee.payeeName,
    country: payee.payeeCountry,
    amountLocal: payee.amount,
    currency: payee.currency,
    amountUsd,
    status: "paid",
    warnings: warningCount(recommended.id, evaluations),
    recommended: recommendedSummary(recommended),
    invoice: payee,
    plan: planRow.plan,
    memo: memoRow
      ? {
          summary: memoRow.summary,
          routeRationale: memoRow.routeRationale,
          citedRuleIds: memoRow.citedRuleIds,
          warnings: memoRow.warnings,
          humanChecks: memoRow.humanChecks,
        }
      : null,
    approvals: [],
    payment: {
      txHash: sent.txHash,
      offrampRef: sent.offrampRef,
      railRef: sent.railRef,
      railMode: rail.mode,
    },
  });
});
