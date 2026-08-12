// Independent auditor: intentionally does not import the production financial engine.
const sum = (xs, fn) => xs.reduce((s, x) => s + fn(x), 0);

export function auditCanonical(raw) {
  const errors = [];
  const cycles = raw.cycles || [], discounts = raw.discounts || [], allocations = raw.allocations || [], refunds = raw.refunds || [];
  const lots = raw.cashLots || [], moves = raw.cashMovements || [], ledger = raw.ledger || [], deposits = raw.depositRequests || [];

  const cycleDetails = cycles.map((c) => {
    const discount = sum(discounts.filter((d) => d.cycleId === c.id && d.status === "active"), (d) => d.amountFils);
    const target = c.baseAmountFils - discount;
    const relevant = allocations.filter((a) => a.cycleId === c.id && a.reservationStatus === "active");
    const reserved = sum(relevant, (a) => a.amountFils - sum(refunds.filter((r) => r.allocationId === a.id && r.status === "active"), (r) => r.amountFils));
    const settled = sum(relevant, (a) => Number(a.settledAmountFils ?? (a.settlementStatus === "settled" ? a.amountFils : 0)) - sum(refunds.filter((r) => r.allocationId === a.id && r.status === "active" && r.source === "revenue"), (r) => r.amountFils));
    if (target < 0) errors.push({ code: "NEGATIVE_TARGET", cycleId: c.id, value: target });
    if (reserved > target) errors.push({ code: "CYCLE_OVERPAID", cycleId: c.id, difference: reserved - target });
    if (settled > reserved) errors.push({ code: "SETTLED_OVER_RESERVED", cycleId: c.id, difference: settled - reserved });
    return { cycleId: c.id, targetFils: target, reservedFils: reserved, remainingFils: target - reserved, collectedFils: settled };
  });

  const custodyByEmployee = {};
  const lotDetails = lots.map((lot) => {
    const out = sum(moves.filter((m) => m.cashLotId === lot.id && m.status === "active" && ["deposit", "refund", "transfer_out"].includes(m.type)), (m) => m.amountFils);
    const restored = sum(moves.filter((m) => m.cashLotId === lot.id && m.status === "active" && m.type === "reversal"), (m) => m.amountFils);
    const available = lot.originalAmountFils - out + restored;
    if (available < 0 || available > lot.originalAmountFils) errors.push({ code: "CASH_LOT_OVERUSED", cashLotId: lot.id, available });
    if (available) custodyByEmployee[lot.currentHolder] = (custodyByEmployee[lot.currentHolder] || 0) + available;
    return { cashLotId: lot.id, availableFils: available, holder: lot.currentHolder };
  });
  const receivedNotDepositedFils = sum(lotDetails, (x) => x.availableFils);

  for (const deposit of deposits.filter((x) => x.status === "approved")) {
    if (!Array.isArray(deposit.allocations) || !deposit.allocations.length) errors.push({ code: "APPROVED_DEPOSIT_WITHOUT_ALLOCATION", depositId: deposit.id });
    for (const line of deposit.allocations || []) if (!lots.some((lot) => lot.id === line.cashLotId)) errors.push({ code: "DEPOSIT_UNKNOWN_CASH_LOT", depositId: deposit.id, cashLotId: line.cashLotId });
  }

  const activeRefundKeys = new Set();
  for (const refund of refunds.filter((x) => x.status === "active")) {
    const key = refund.id; if (activeRefundKeys.has(key)) errors.push({ code: "DOUBLE_REFUND", refundId: key }); activeRefundKeys.add(key);
    if (!refund.operationId && !String(refund.id || "").startsWith("refund:")) errors.push({ code: "REFUND_LINEAGE_MISSING", refundId: refund.id });
  }
  for (const collection of [raw.balanceTransfers || [], raw.expenses || [], raw.installments || [], raw.discounts || [], raw.custodyTransfers || []]) {
    for (const entity of collection.filter((x) => x.status === "reversed")) if (!entity.reversalOperationId && !entity.reversedAt) errors.push({ code: "REVERSAL_LINEAGE_MISSING", entityId: entity.id });
  }

  const ledgerByAccount = {};
  for (const e of ledger) {
    const sign = e.direction === "credit" ? 1 : e.direction === "debit" ? -1 : 0;
    if (!sign) errors.push({ code: "LEDGER_DIRECTION", entryId: e.id });
    ledgerByAccount[e.account] = (ledgerByAccount[e.account] || 0) + sign * e.amountFils;
  }
  for (const account of ["company", "revenue", "deduction"]) {
    const actual = raw.balances?.[account] || 0;
    const opening = raw.openingBalances?.[account] || 0;
    const expected = opening + (ledgerByAccount[account] || 0);
    if (actual !== expected) errors.push({ code: "BALANCE_LEDGER_MISMATCH", account, expected, actual, difference: actual - expected });
  }

  const operationIds = new Set();
  for (const e of [...allocations, ...moves, ...ledger]) {
    if (!e.operationId && !e.sourceOperationId) errors.push({ code: "MISSING_OPERATION_LINEAGE", entityId: e.id });
    const identity = e.id;
    if (operationIds.has(identity)) errors.push({ code: "DUPLICATE_ENTITY_ID", entityId: identity });
    operationIds.add(identity);
  }

  for (const movement of moves.filter((x) => x.type === "deposit" && x.status === "active")) {
    const lot = lots.find((x) => x.id === movement.cashLotId); const entries = ledger.filter((entry) => entry.operationId === movement.sourceOperationId && entry.sourceType === "cash_deposit");
    if (lot && !entries.some((entry) => entry.effectiveMonth === lot.collectionMonth)) errors.push({ code: "DEPOSIT_MONTH_ATTRIBUTION_MISMATCH", movementId: movement.id, expectedMonth: lot.collectionMonth });
  }

  return { ok: errors.length === 0, errors, cycleDetails, lotDetails, custodyByEmployee, receivedNotDepositedFils, ledgerByAccount };
}
