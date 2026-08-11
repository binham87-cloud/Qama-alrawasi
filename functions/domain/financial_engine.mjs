export const SCHEMA_VERSION = 3;

export const ROLES = Object.freeze({
  MANAGER: new Set(["owner", "manager"]),
  EMPLOYEE: new Set(["employee"]),
});

export function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error("INVALID_MONEY");
  const fils = Math.round(n * 100);
  if (!Number.isSafeInteger(fils)) throw new Error("INVALID_MONEY");
  return fils;
}

export function amount(fils) {
  if (!Number.isSafeInteger(fils)) throw new Error("INVALID_FILS");
  return fils / 100;
}

export function requirePositive(fils) {
  if (!Number.isSafeInteger(fils) || fils <= 0) throw new Error("AMOUNT_MUST_BE_POSITIVE");
  return fils;
}

export function requireNonNegative(fils, code = "NEGATIVE_VALUE") {
  if (!Number.isSafeInteger(fils) || fils < 0) throw new Error(code);
  return fils;
}

export function requireId(value, code = "INVALID_ID") {
  const s = String(value || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{5,127}$/.test(s)) throw new Error(code);
  return s;
}

export function monthOf(isoDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(isoDate || ""))) throw new Error("INVALID_DATE");
  return String(isoDate).slice(0, 7).replace("-", "_");
}

export function stableEntryId(operationId, line) {
  return `led:${requireId(operationId)}:${String(line).padStart(2, "0")}`;
}

export function effectiveTarget(cycle, discounts = []) {
  const base = requireNonNegative(cycle.baseAmountFils);
  const discount = discounts
    .filter((x) => x.cycleId === cycle.id && x.status === "active")
    .reduce((sum, x) => sum + requireNonNegative(x.amountFils), 0);
  if (discount > base) throw new Error("DISCOUNT_EXCEEDS_TARGET");
  return base - discount;
}

function refundedForAllocation(allocationId, refunds = [], source = null) {
  return refunds.filter((x) => x.allocationId === allocationId && x.status === "active" && (!source || x.source === source)).reduce((sum, x) => sum + requirePositive(x.amountFils), 0);
}

export function reservedForCycle(cycleId, allocations = [], refunds = []) {
  return allocations
    .filter((x) => x.cycleId === cycleId && x.reservationStatus === "active")
    .reduce((sum, x) => sum + requirePositive(x.amountFils) - refundedForAllocation(x.id, refunds), 0);
}

export function settledForCycle(cycleId, allocations = [], refunds = []) {
  return allocations
    .filter((x) => x.cycleId === cycleId && x.reservationStatus === "active")
    .reduce((sum, x) => sum + requireNonNegative(x.settledAmountFils ?? (x.settlementStatus === "settled" ? x.amountFils : 0)) - refundedForAllocation(x.id, refunds, "revenue"), 0);
}

export function cycleProjection(cycle, state) {
  const targetFils = effectiveTarget(cycle, state.discounts || []);
  const reservedFils = reservedForCycle(cycle.id, state.allocations || [], state.refunds || []);
  const collectedFils = settledForCycle(cycle.id, state.allocations || [], state.refunds || []);
  if (reservedFils > targetFils) throw new Error("CYCLE_OVERPAYMENT");
  if (collectedFils > reservedFils) throw new Error("SETTLED_EXCEEDS_RESERVED");
  const remainingCollectibleFils = targetFils - reservedFils;
  return { targetFils, tenantReceivedReservedFils: reservedFils, remainingCollectibleFils, collectedFils };
}

export function cashLotAvailable(lot, movements = []) {
  const consumed = movements
    .filter((x) => x.cashLotId === lot.id && ["deposit", "refund", "transfer_out"].includes(x.type) && x.status === "active")
    .reduce((sum, x) => sum + requirePositive(x.amountFils), 0);
  const restored = movements
    .filter((x) => x.cashLotId === lot.id && ["reversal", "deposit_reversal"].includes(x.type) && x.status === "active")
    .reduce((sum, x) => sum + requirePositive(x.amountFils), 0);
  const available = requireNonNegative(lot.originalAmountFils) - consumed + restored;
  if (available < 0 || available > lot.originalAmountFils) throw new Error("CASH_LOT_INVARIANT");
  return available;
}

export function custodyProjection(state) {
  const byHolder = new Map();
  let totalFils = 0;
  for (const lot of state.cashLots || []) {
    const available = cashLotAvailable(lot, state.cashMovements || []);
    if (!available) continue;
    const holder = String(lot.currentHolder || "");
    if (!holder) throw new Error("CASH_HOLDER_MISSING");
    byHolder.set(holder, (byHolder.get(holder) || 0) + available);
    totalFils += available;
  }
  return { totalFils, byHolder: Object.fromEntries(byHolder) };
}

export function cardProjection(state, monthKey) {
  const cycles = (state.cycles || []).filter((x) => x.reportingMonth === monthKey && !["cancelled_eviction", "cancelled_daily", "pending_payment_daily"].includes(x.status));
  const targetDetails = cycles.map((cycle) => ({ cycleId: cycle.id, ...cycleProjection(cycle, state) }));
  const targetFils = targetDetails.reduce((s, x) => s + x.targetFils, 0);
  const collectedDetails = (state.allocations || []).filter((x) => x.collectionMonth === monthKey && x.reservationStatus === "active").map((x) => ({ ...x, collectedFils: requireNonNegative(x.settledAmountFils ?? (x.settlementStatus === "settled" ? x.amountFils : 0)) - refundedForAllocation(x.id, state.refunds || [], "revenue") })).filter((x) => x.collectedFils > 0);
  const collectedFils = collectedDetails.reduce((s, x) => s + x.collectedFils, 0);
  const custody = custodyProjection(state);
  return { targetFils, targetDetails, collectedFils, collectedDetails, receivedNotDepositedFils: custody.totalFils, custodyByEmployee: custody.byHolder };
}

export function activeCollectionAmount(event, state) {
  if (!event || event.status !== "active" || event.approvalState !== "approved") return 0;
  const reversed = (state.collectionReversals || []).filter((x) => x.collectionEventId === event.id && x.status === "active").reduce((s, x) => s + requirePositive(x.amountFils), 0);
  const refunded = (state.refunds || []).filter((x) => x.paymentId === event.paymentId && x.status === "active").reduce((s, x) => s + requirePositive(x.amountFils), 0);
  const net = requirePositive(event.amountFils) - reversed - refunded;
  if (net < 0) throw new Error("COLLECTION_REVERSAL_EXCEEDS_EVENT");
  return net;
}

export function ledgerReplay(openingBalances, ledger = []) {
  const balances = { company: 0, revenue: 0, deduction: 0, ...(openingBalances || {}) };
  for (const entry of ledger) {
    if (!Object.hasOwn(balances, entry.account)) throw new Error("UNKNOWN_ACCOUNT");
    const amountFils = requirePositive(entry.amountFils);
    balances[entry.account] += entry.direction === "credit" ? amountFils : entry.direction === "debit" ? -amountFils : (() => { throw new Error("INVALID_LEDGER_DIRECTION"); })();
    if (balances[entry.account] < 0) throw new Error(`NEGATIVE_BALANCE:${entry.account}`);
  }
  return balances;
}

export function assertStateInvariants(state) {
  for (const account of ["company", "revenue", "deduction"]) requireNonNegative(state.balances?.[account] ?? 0, `NEGATIVE_BALANCE:${account}`);
  for (const cycle of state.cycles || []) cycleProjection(cycle, state);
  for (const lot of state.cashLots || []) cashLotAvailable(lot, state.cashMovements || []);
  const ids = new Set();
  for (const list of [state.paymentIntents, state.collectionEvents, state.collectionReversals, state.unallocatedPayments, state.allocations, state.cashLots, state.cashMovements, state.depositRequests, state.custodyTransfers, state.discounts, state.evictions, state.refunds, state.expenses, state.balanceTransfers, state.adjustments, state.installments, state.reconstructionPlans, state.monthAuthorities, state.ledger, state.audit]) {
    for (const entity of list || []) { if (!entity.id) throw new Error("ENTITY_ID_MISSING"); if (ids.has(entity.id)) throw new Error(`DUPLICATE_ENTITY_ID:${entity.id}`); ids.add(entity.id); }
  }
  for (const event of state.collectionEvents || []) activeCollectionAmount(event, state);
  for (const item of state.unallocatedPayments || []) {
    requirePositive(item.amountFils);
    if (item.state !== "unresolved") throw new Error("UNALLOCATED_PAYMENT_STATE_INVALID");
  }
  for (const allocation of state.allocations || []) {
    const settled = requireNonNegative(allocation.settledAmountFils ?? (allocation.settlementStatus === "settled" ? allocation.amountFils : 0));
    const refunded = refundedForAllocation(allocation.id, state.refunds || []);
    if (settled > allocation.amountFils) throw new Error("SETTLED_EXCEEDS_ALLOCATION");
    if (refunded > allocation.amountFils) throw new Error("REFUND_EXCEEDS_PAYMENT");
  }
  return true;
}

export function assertOperationIdentity(operation, operationId, payloadHash) {
  if (!operation) return "new";
  if (operation.payloadHash !== payloadHash) throw new Error("IDEMPOTENCY_PAYLOAD_MISMATCH");
  if (operation.status === "completed") return "replay";
  throw new Error("OPERATION_IN_PROGRESS");
}

export function assertManager(actor) {
  if (!actor?.active || !ROLES.MANAGER.has(actor.role)) throw new Error("MANAGER_REQUIRED");
}

export function assertEmployeeOrManager(actor) {
  if (!actor?.active || !(ROLES.MANAGER.has(actor.role) || ROLES.EMPLOYEE.has(actor.role))) throw new Error("STAFF_REQUIRED");
}

export function assertMonthAllowsOriginLinked(monthState, originExists) {
  if (!monthState || monthState.status === "open" || monthState.status === "reopened") return;
  if (!originExists) throw new Error("MONTH_CLOSED_NEW_OPERATION_DENIED");
}

export function nextCycleDue(anchorDate, sequence) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchorDate) || !Number.isInteger(sequence) || sequence < 0) throw new Error("INVALID_CYCLE");
  const [y, m, d] = anchorDate.split("-").map(Number);
  const targetMonth = m - 1 + sequence + 1;
  const ty = y + Math.floor(targetMonth / 12);
  const tm = ((targetMonth % 12) + 12) % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return `${ty}-${String(tm + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}
