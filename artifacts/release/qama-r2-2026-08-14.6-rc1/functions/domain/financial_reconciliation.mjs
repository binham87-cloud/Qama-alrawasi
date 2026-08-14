/**
 * R2 canonical reconciliation.
 * Reconstructs KPI/balance/custody truth from events. Never invents history.
 */
import {
  assertStateInvariants,
  cycleProjection,
  custodyProjection,
  ledgerReplay,
  requireNonNegative,
} from "./financial_engine.mjs";
import { monthlyOperationalProjection } from "./canonical_selectors.mjs";

function sum(items, field) {
  return (items || []).reduce((total, item) => total + Number(item[field] || 0), 0);
}

function push(exceptions, exception) {
  exceptions.push({ severity: exception.severity || "fail", ...exception });
}

export function reconcileCanonicalState(state, monthKey, asOfDate = "2026-08-14") {
  const exceptions = [];
  try {
    assertStateInvariants(state);
  } catch (error) {
    push(exceptions, { code: "STATE_INVARIANT", message: String(error.message || error) });
  }

  const opening = { company: 0, revenue: 0, deduction: 0, ...(state.openingBalances || {}) };
  let replayed = opening;
  try {
    replayed = ledgerReplay(opening, state.ledger || []);
  } catch (error) {
    push(exceptions, { code: "LEDGER_REPLAY_FAILED", message: String(error.message || error) });
  }
  const balances = { company: 0, revenue: 0, deduction: 0, ...(state.balances || {}) };
  for (const account of ["company", "revenue", "deduction"]) {
    if (Number(balances[account] || 0) !== Number(replayed[account] || 0)) {
      push(exceptions, {
        code: "BALANCE_LEDGER_MISMATCH",
        account,
        storedFils: Number(balances[account] || 0),
        replayedFils: Number(replayed[account] || 0),
      });
    }
    try {
      requireNonNegative(Number(balances[account] || 0), `NEGATIVE_BALANCE:${account}`);
    } catch (error) {
      push(exceptions, { code: "NEGATIVE_BALANCE", account, message: String(error.message || error) });
    }
  }

  const ids = new Set();
  for (const list of [
    state.paymentIntents, state.collectionEvents, state.collectionReversals, state.unallocatedPayments,
    state.allocations, state.cashLots, state.cashMovements, state.depositRequests, state.custodyTransfers,
    state.discounts, state.evictions, state.refunds, state.expenses, state.balanceTransfers,
    state.adjustments, state.installments, state.ledger, state.audit, state.dailyBookings, state.cycles,
  ]) {
    for (const entity of list || []) {
      if (!entity?.id) {
        push(exceptions, { code: "ENTITY_ID_MISSING", entityType: list === state.cycles ? "cycle" : "entity" });
        continue;
      }
      if (ids.has(entity.id)) push(exceptions, { code: "DUPLICATE_ENTITY_ID", id: entity.id });
      ids.add(entity.id);
    }
  }

  const opIds = new Set();
  for (const event of state.collectionEvents || []) {
    const key = String(event.idempotencyKey || event.operationId || "");
    if (!key) continue;
    if (opIds.has(key) && event.status === "active") {
      push(exceptions, { code: "DUPLICATE_IDEMPOTENCY_KEY", key });
    }
    opIds.add(key);
    if (event.method === "bank" && event.custodianId) {
      push(exceptions, { code: "BANK_HAS_CUSTODIAN", eventId: event.id });
    }
    if (event.method === "cash" && event.status === "active" && !event.custodianId && !event.collectorId) {
      push(exceptions, { code: "CASH_HOLDER_MISSING", eventId: event.id });
    }
    if (!["cash", "bank"].includes(String(event.method || ""))) {
      push(exceptions, { code: "UNKNOWN_COLLECTION_METHOD", eventId: event.id, method: event.method });
    }
  }

  const custody = custodyProjection(state);
  const bankLots = (state.cashLots || []).filter((lot) => {
    const payment = (state.paymentIntents || []).find((p) => p.id === lot.originPaymentId);
    return payment?.method === "bank";
  });
  if (bankLots.length) {
    push(exceptions, { code: "BANK_CASH_LOT", lotIds: bankLots.map((x) => x.id) });
  }

  const projection = monthlyOperationalProjection(state, monthKey, asOfDate);
  if (Number(projection.cards.receivedNotDepositedFils || 0) !== Number(custody.totalFils || 0)
    && !projection.openingState
    && projection.compatibilitySource !== "legacy_month") {
    // Opening overlays may add aggregate unattributed holding; live lots must still equal live cashDetails.
    const liveHolding = sum((projection.details.receivedNotDeposited || []).filter((x) => x.cashLotId && !String(x.cashLotId).startsWith("opening:")), "amountFils");
    if (liveHolding !== custody.totalFils) {
      push(exceptions, {
        code: "CUSTODY_PROJECTION_MISMATCH",
        custodyFils: custody.totalFils,
        projectedFils: projection.cards.receivedNotDepositedFils,
        liveHoldingFils: liveHolding,
      });
    }
  }

  for (const cycle of (state.cycles || []).filter((c) => c.reportingMonth === monthKey)) {
    const view = cycleProjection(cycle, state);
    const remaining = view.targetFils - view.tenantReceivedReservedFils;
    if (remaining !== view.remainingCollectibleFils) {
      push(exceptions, { code: "REMAINING_MISMATCH", cycleId: cycle.id, remaining, projected: view.remainingCollectibleFils });
    }
    if (remaining < 0) {
      push(exceptions, { code: "NEGATIVE_REMAINING_HIDDEN", cycleId: cycle.id, remaining });
    }
  }

  const collectedFromEvents = sum(
    (projection.details.collected || []).filter((x) => x.collectionEventId || x.allocationId),
    "amountFils",
  );
  if (projection.compatibilitySource == null && collectedFromEvents !== projection.cards.collectedFils
    && !projection.openingState) {
    push(exceptions, {
      code: "COLLECTED_DETAIL_MISMATCH",
      cards: projection.cards.collectedFils,
      details: collectedFromEvents,
    });
  }

  for (const exception of projection.reconciliationExceptions || []) {
    push(exceptions, { code: exception.code, ...exception, severity: exception.classification === "E" ? "review" : "info" });
  }

  const fails = exceptions.filter((x) => x.severity === "fail");
  return {
    ok: fails.length === 0,
    monthKey,
    asOfDate,
    balances: { stored: balances, replayed },
    custody,
    cards: projection.cards,
    compatibilitySource: projection.compatibilitySource || null,
    exceptions,
  };
}

export function assertReconciled(state, monthKey, asOfDate) {
  const result = reconcileCanonicalState(state, monthKey, asOfDate);
  if (!result.ok) {
    const first = result.exceptions.find((x) => x.severity === "fail");
    throw new Error(`RECONCILIATION_FAILED:${first?.code || "UNKNOWN"}`);
  }
  return result;
}
