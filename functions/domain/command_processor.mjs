import crypto from "node:crypto";
import {
  assertEmployeeOrManager, assertManager, assertMonthAllowsOriginLinked, assertOperationIdentity,
  cashLotAvailable, cycleProjection, monthOf, requireId, requirePositive, requireNonNegative, stableEntryId,
  assertStateInvariants,
} from "./financial_engine.mjs";
import { assertCashAllocationStillValid, validateConfirmedCashAllocation } from "./cash_allocation.mjs";
import { attachReconstructionLineage, prepareReconstructionCommand, reconstructionCompletenessAudit } from "./reconstruction.mjs";
import { toReportingMonthKey } from "./month_keys.mjs";
import { compatibleCycleId, resolveActiveTenancy, resolveLegacyRentableSpace } from "./legacy_rental_resolver.mjs";

const clone = (x) => structuredClone(x);
const nowIso = (ctx) => ctx.now || new Date().toISOString();
const hash = (x) => crypto.createHash("sha256").update(JSON.stringify(x)).digest("hex");

export function blankState() {
  return {
    cycles: [], allocations: [], paymentIntents: [], collectionEvents: [], collectionReversals: [], unallocatedPayments: [], cashLots: [], cashMovements: [],
    depositRequests: [], custodyTransfers: [], discounts: [], evictions: [], refunds: [],
    expenses: [], externalRevenues: [], ownerProfitDistributions: [], balanceTransfers: [], adjustments: [],
    installmentObligations: [], installments: [], legacyFinancialCorrections: [],
    dailyBookings: [], cycleCorrections: [],
    balances: { company: 0, revenue: 0, deduction: 0 }, ledger: [], audit: [],
    monthStates: [], operations: [], requests: [], reconstructionPlans: [], monthAuthorities: [],
    rentableSpaces: [], tenants: [], tenancies: [], units: [], properties: [],
    canonicalControl: null, systemConfig: {}, financialTruthVersion: 2, cleanStartInventory: null,
  };
}

function get(arr, id, code = "NOT_FOUND") {
  const v = arr.find((x) => x.id === id);
  if (!v) throw new Error(code);
  return v;
}

function audit(state, ctx, action, entityType, entityId, before = null, after = null) {
  state.audit.push({ id: `audit:${ctx.operationId}:${action}`, operationId: ctx.operationId, action, entityType, entityId, actorId: ctx.actor.id, at: nowIso(ctx), before, after });
}

function ledger(state, ctx, lines) {
  lines.forEach((line, index) => state.ledger.push({ id: stableEntryId(ctx.operationId, index), operationId: ctx.operationId, ...line, postedAt: nowIso(ctx) }));
}

function changeBalance(state, account, delta) {
  if (!Object.hasOwn(state.balances, account)) throw new Error("UNKNOWN_ACCOUNT");
  const next = state.balances[account] + delta;
  if (!Number.isSafeInteger(next) || next < 0) throw new Error("INSUFFICIENT_BALANCE");
  state.balances[account] = next;
}

function operationStart(state, ctx, command) {
  requireId(ctx.operationId, "INVALID_OPERATION_ID");
  const payloadHash = ctx.payloadHash || hash({ command, payload: ctx.payload });
  const existing = state.operations.find((x) => x.id === ctx.operationId);
  const mode = assertOperationIdentity(existing, ctx.operationId, payloadHash);
  if (mode === "replay") return { replay: true, result: clone(existing.result) };
  state.operations.push({ id: ctx.operationId, payloadHash, command, actorId: ctx.actor.id, status: "in_progress", startedAt: nowIso(ctx) });
  return { replay: false, payloadHash };
}

function operationComplete(state, ctx, result) {
  const op = get(state.operations, ctx.operationId, "OPERATION_NOT_FOUND");
  op.status = "completed"; op.completedAt = nowIso(ctx); op.result = clone(result);
  return result;
}

function monthState(state, monthKey) {
  return state.monthStates.find((x) => x.id === monthKey) || { id: monthKey, status: "open", closeVersion: 0, history: [] };
}

function ensureCompatibleCycle(state, ctx) {
  assertEmployeeOrManager(ctx.actor);
  const p = ctx.payload || {};
  const reportingMonth = toReportingMonthKey(String(p.reportingMonth || p.monthKey || ""), "auto");
  const legacyUnitId = String(p.legacyUnitId || p.unitId || "").trim();
  const partitionId = p.partitionId == null || p.partitionId === "" ? null : String(p.partitionId);
  const spaceType = partitionId == null ? "full_unit" : "partition";
  const resolved = resolveLegacyRentableSpace({
    spaces: state.rentableSpaces || [],
    units: state.units || [],
    legacyUnitId,
    partitionId,
    spaceType: p.spaceType || spaceType,
  });
  if (!resolved.ok) throw new Error(resolved.code);
  const space = resolved.space;
  const cycleId = compatibleCycleId(space.id, reportingMonth);
  const existing = (state.cycles || []).find((x) => x.id === cycleId);
  if (existing) {
    if (!String(existing.status || "").startsWith("open") && existing.status !== "open_not_due") {
      throw new Error("CYCLE_NOT_OPEN");
    }
    return { cycleId: existing.id, spaceId: space.id, created: false, tenancyId: existing.tenancyId || null };
  }

  const amountFils = Number(p.contractualAmountFils ?? p.baseAmountFils ?? p.rentFils);
  if (!Number.isSafeInteger(amountFils) || amountFils <= 0) throw new Error("CONTRACTUAL_AMOUNT_INVALID");
  const dueDate = String(p.dueDate || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) throw new Error("DUE_DATE_INVALID");
  const startDate = String(p.startDate || dueDate).trim();
  const tenantName = String(p.tenantName || p.tenant || "").trim() || `ساكن غير محدد — ${space.name || space.id}`;
  const phone = String(p.tenantPhone || p.phone || "").trim();

  let tenancyId = `tenancy:${space.id}`;
  let tenantId = `tenant:${space.id}`;
  const tenancyResolve = resolveActiveTenancy({ tenancies: state.tenancies || [], spaceId: space.id, tenantName });
  if (tenancyResolve.ok) {
    tenancyId = tenancyResolve.tenancy.id;
    tenantId = tenancyResolve.tenancy.tenantId || tenantId;
  } else if (tenancyResolve.code === "AMBIGUOUS_TENANCY") {
    throw new Error("AMBIGUOUS_TENANCY");
  } else {
    state.tenants = state.tenants || [];
    state.tenancies = state.tenancies || [];
    if (!state.tenants.some((x) => x.id === tenantId)) {
      state.tenants.push({
        id: tenantId, name: tenantName, phone,
        identityStatus: String(p.tenantName || p.tenant || "").trim() ? "confirmed" : "unresolved",
        createdBy: ctx.actor.id, createdAt: nowIso(ctx),
        origin: "legacy_compatibility",
      });
    }
    if (!state.tenancies.some((x) => x.id === tenancyId)) {
      state.tenancies.push({
        id: tenancyId, spaceId: space.id, unitId: space.unitId || null, propertyId: space.propertyId || null,
        tenantId, startDate, status: "active",
        createdBy: ctx.actor.id, createdAt: nowIso(ctx), origin: "legacy_compatibility",
      });
    }
  }

  // Acknowledge proven month paid_amount without fabricating payment entities.
  let legacyOpeningReservedFils = requireNonNegative(Number(p.legacyOpeningReservedFils || 0));
  const legacyStatus = String(p.legacyStatus || "").trim();
  if (!legacyOpeningReservedFils && legacyStatus === "collected") legacyOpeningReservedFils = amountFils;
  if (legacyOpeningReservedFils > amountFils) legacyOpeningReservedFils = amountFils;

  const cycle = {
    id: cycleId, tenancyId, tenantId, tenant: tenantName,
    propertyId: space.propertyId || null, unitId: space.unitId || null, spaceId: space.id,
    partitionId: partitionId == null ? (space.partitionId == null ? null : String(space.partitionId)) : partitionId,
    legacyUnitId, legacyPartitionId: partitionId,
    baseAmountFils: amountFils, reportingMonth, dueDate,
    status: "open", financialVersion: 0,
    origin: "legacy_compatibility",
    legacyOpeningReservedFils,
    createdBy: ctx.actor.id, createdAt: nowIso(ctx), operationId: ctx.operationId,
  };
  state.cycles.push(cycle);
  audit(state, ctx, "compatible_cycle_materialized", "rental_cycle", cycleId, null, {
    spaceId: space.id, reportingMonth, legacyOpeningReservedFils, inventedPayments: 0,
  });
  return { cycleId, spaceId: space.id, created: true, tenancyId };
}

function resolveCycleForCollection(state, ctx) {
  const p = ctx.payload || {};
  if (p.cycleId) return String(p.cycleId);
  if (p.legacyUnitId || (p.unitId && (p.reportingMonth || p.monthKey || p.contractualAmountFils || p.rentFils))) {
    return ensureCompatibleCycle(state, ctx).cycleId;
  }
  throw new Error("CYCLE_NOT_FOUND");
}

function createCashReceipt(state, ctx) {
  assertEmployeeOrManager(ctx.actor);
  const p = ctx.payload;
  const cycleId = resolveCycleForCollection(state, ctx);
  const cycle = get(state.cycles, cycleId, "CYCLE_NOT_FOUND");
  if (!String(cycle.status).startsWith("open")) throw new Error("CYCLE_NOT_OPEN");
  const amountFils = requirePositive(p.amountFils);
  const view = cycleProjection(cycle, state);
  if (amountFils > view.remainingCollectibleFils && !(Number(state.financialTruthVersion || 2) >= 3 && p.acceptUnallocatedOverpayment === true)) throw new Error(`OVERPAYMENT:${view.remainingCollectibleFils}`);
  const allocatedFils = Math.min(amountFils, view.remainingCollectibleFils);
  const unallocatedFils = amountFils - allocatedFils;
  const paymentDate = String(p.paymentDate);
  const collectionMonth = monthOf(paymentDate);
  assertMonthAllowsOriginLinked(monthState(state, collectionMonth), false);
  const paymentId = `pay:${ctx.operationId}`;
  state.paymentIntents.push({ id: paymentId, cycleId: cycle.id, method: "cash", amountFils, paymentDate, collectionMonth, createdBy: ctx.actor.id, collectedBy: ctx.actor.id, status: "received_pending_deposit", operationId: ctx.operationId, createdAt: nowIso(ctx) });
  const eventId = `collection:${ctx.operationId}`;
  state.collectionEvents.push({ id: eventId, paymentId, idempotencyKey: ctx.operationId, cycleId: cycle.id, tenancyId: cycle.tenancyId || null, tenantId: cycle.tenantId || null, unitId: cycle.unitId || null, amountFils, method: "cash", effectiveAt: paymentDate, collectionMonth, collectorId: ctx.actor.id, custodianId: ctx.actor.id, approvalState: "approved", status: "active", createdBy: ctx.actor.id, createdAt: nowIso(ctx), approvedBy: ctx.actor.id, approvedAt: nowIso(ctx), operationId: ctx.operationId });
  if (allocatedFils > 0) state.allocations.push({ id: `alloc:${ctx.operationId}`, paymentId, collectionEventId: eventId, cycleId: cycle.id, amountFils: allocatedFils, collectionMonth, reservationStatus: "active", settlementStatus: "undeposited", operationId: ctx.operationId });
  if (unallocatedFils > 0) state.unallocatedPayments.push({ id: `unallocated:${ctx.operationId}`, collectionEventId: eventId, paymentId, amountFils: unallocatedFils, state: "unresolved", reason: "overpayment", permittedResolution: ["tenant_credit", "refund", "correction", "approved_reallocation"], createdBy: ctx.actor.id, createdAt: nowIso(ctx), operationId: ctx.operationId });
  state.cashLots.push({ id: `lot:${ctx.operationId}`, originPaymentId: paymentId, cycleId: cycle.id, tenant: cycle.tenant || null, unitId: cycle.unitId || null, originalAmountFils: amountFils, currentHolder: ctx.actor.id, paymentDate, collectionMonth, status: "held", version: 1 });
  cycle.financialVersion = Number(cycle.financialVersion || 0) + 1;
  audit(state, ctx, "cash_received", "payment", paymentId, null, { amountFils, cycleId: cycle.id, holder: ctx.actor.id });
  return { paymentId, collectionEventId: eventId, cycleId: cycle.id, collectedFils: amountFils, reservedFils: allocatedFils, unallocatedFils, remainingCollectibleFils: view.remainingCollectibleFils - allocatedFils };
}

function createBankPayment(state, ctx) {
  assertEmployeeOrManager(ctx.actor);
  const p = ctx.payload;
  const cycleId = resolveCycleForCollection(state, ctx);
  const cycle = get(state.cycles, cycleId, "CYCLE_NOT_FOUND");
  const amountFils = requirePositive(p.amountFils); const paymentDate = String(p.paymentDate); const collectionMonth = monthOf(paymentDate);
  const paymentId = `pay:${ctx.operationId}`;
  state.paymentIntents.push({ id: paymentId, cycleId: cycle.id, method: "bank", amountFils, paymentDate, collectionMonth, bankReference: String(p.bankReference || ""), createdBy: ctx.actor.id, status: "pending", operationId: ctx.operationId, createdAt: nowIso(ctx) });
  audit(state, ctx, "bank_payment_submitted", "payment", paymentId, null, { amountFils, cycleId: cycle.id });
  return { paymentId, cycleId: cycle.id, status: "pending" };
}

function approveBankPayment(state, ctx) {
  assertManager(ctx.actor);
  const payment = get(state.paymentIntents, ctx.payload.paymentId, "PAYMENT_NOT_FOUND");
  if (payment.method !== "bank" || payment.status !== "pending") throw new Error("PAYMENT_NOT_PENDING");
  const cycle = get(state.cycles, payment.cycleId, "CYCLE_NOT_FOUND");
  const view = cycleProjection(cycle, state);
  if (payment.amountFils > view.remainingCollectibleFils && !(Number(state.financialTruthVersion || 2) >= 3 && ctx.payload.acceptUnallocatedOverpayment === true)) throw new Error(`OVERPAYMENT:${view.remainingCollectibleFils}`);
  const allocatedFils = Math.min(payment.amountFils, view.remainingCollectibleFils);
  const unallocatedFils = payment.amountFils - allocatedFils;
  assertMonthAllowsOriginLinked(monthState(state, payment.collectionMonth), true);
  const before = clone(payment); payment.status = "approved"; payment.approvedBy = ctx.actor.id; payment.approvedAt = nowIso(ctx);
  if (cycle.status === "pending_payment_daily") cycle.status = "closed_paid_daily";
  const eventId = `collection:${ctx.operationId}`;
  state.collectionEvents.push({ id: eventId, paymentId: payment.id, idempotencyKey: ctx.operationId, cycleId: cycle.id, tenancyId: cycle.tenancyId || null, tenantId: cycle.tenantId || null, unitId: cycle.unitId || null, amountFils: payment.amountFils, method: "bank", effectiveAt: payment.paymentDate, collectionMonth: payment.collectionMonth, collectorId: payment.createdBy, custodianId: null, approvalState: "approved", status: "active", createdBy: payment.createdBy, createdAt: payment.createdAt, approvedBy: ctx.actor.id, approvedAt: nowIso(ctx), operationId: ctx.operationId });
  if (allocatedFils > 0) state.allocations.push({ id: `alloc:${ctx.operationId}`, paymentId: payment.id, collectionEventId: eventId, cycleId: cycle.id, amountFils: allocatedFils, collectionMonth: payment.collectionMonth, reservationStatus: "active", settlementStatus: "settled", settledAmountFils: allocatedFils, settledAt: nowIso(ctx), operationId: ctx.operationId });
  if (unallocatedFils > 0) state.unallocatedPayments.push({ id: `unallocated:${ctx.operationId}`, collectionEventId: eventId, paymentId: payment.id, amountFils: unallocatedFils, state: "unresolved", reason: "overpayment", permittedResolution: ["tenant_credit", "refund", "correction", "approved_reallocation"], createdBy: payment.createdBy, createdAt: nowIso(ctx), operationId: ctx.operationId });
  cycle.financialVersion = Number(cycle.financialVersion || 0) + 1;
  changeBalance(state, "revenue", payment.amountFils);
  ledger(state, ctx, [{ account: "revenue", direction: "credit", amountFils: payment.amountFils, effectiveMonth: payment.collectionMonth, sourceType: "bank_payment", sourceId: payment.id }]);
  audit(state, ctx, "bank_payment_approved", "payment", payment.id, before, payment);
  return { paymentId: payment.id, collectionEventId: eventId, collectedFils: payment.amountFils, depositedFils: payment.amountFils, reservedFils: allocatedFils, unallocatedFils, remainingCollectibleFils: view.remainingCollectibleFils - allocatedFils };
}

function createDailyBooking(state, ctx) {
  assertEmployeeOrManager(ctx.actor); const amountFils = requirePositive(ctx.payload.amountFils); const method = ctx.payload.method; if (!["cash", "bank"].includes(method)) throw new Error("INVALID_PAYMENT_METHOD");
  const paymentDate = String(ctx.payload.paymentDate); const collectionMonth = monthOf(paymentDate); const cycleId = `cycle:${ctx.operationId}`; const bookingId = `booking:${ctx.operationId}`;
  state.cycles.push({ id: cycleId, tenancyId: ctx.payload.tenancyId, unitId: ctx.payload.unitId, tenant: ctx.payload.tenant, baseAmountFils: amountFils, reportingMonth: collectionMonth, dueDate: paymentDate, cycleType: "daily", status: method === "cash" ? "open_daily" : "pending_payment_daily", financialVersion: 0, createdAt: nowIso(ctx) });
  state.dailyBookings.push({ id: bookingId, cycleId, unitId: ctx.payload.unitId, tenant: ctx.payload.tenant, amountFils, paymentMethod: method, paymentDate, collectionMonth, status: method === "cash" ? "paid" : "pending_payment", housingAllowed: method === "cash", createdBy: ctx.actor.id, createdAt: nowIso(ctx) });
  const result = method === "cash"
    ? createCashReceipt(state, { ...ctx, payload: { cycleId, amountFils, paymentDate } })
    : createBankPayment(state, { ...ctx, payload: { cycleId, amountFils, paymentDate } });
  if (method === "cash") state.cycles.find((x) => x.id === cycleId).status = "closed_paid_daily";
  return { bookingId, cycleId, paymentId: result.paymentId, status: state.dailyBookings.at(-1).status, housingAllowed: state.dailyBookings.at(-1).housingAllowed };
}

function refundDailyBooking(state, ctx) {
  assertManager(ctx.actor); const booking = get(state.dailyBookings, ctx.payload.bookingId, "BOOKING_NOT_FOUND"); if (booking.status === "cancelled_refunded") throw new Error("BOOKING_ALREADY_REFUNDED");
  const payment = state.paymentIntents.find((x) => x.cycleId === booking.cycleId); if (!payment) throw new Error("PAYMENT_NOT_FOUND"); const before = clone(booking);
  const result = cancelPayment(state, { ...ctx, payload: { paymentId: payment.id, reason: ctx.payload.reason || "daily_booking_cancelled" } });
  booking.status = "cancelled_refunded"; booking.housingAllowed = false; booking.refundId = result.refundId || null; booking.cancelledAt = nowIso(ctx); booking.cancelledBy = ctx.actor.id;
  const cycle = get(state.cycles, booking.cycleId); cycle.status = "cancelled_daily"; cycle.cancelledTargetFils = cycle.baseAmountFils;
  audit(state, ctx, "daily_booking_refunded", "daily_booking", booking.id, before, booking); return { bookingId: booking.id, status: booking.status, refundedFils: result.amountFils };
}

function createDepositRequest(state, ctx) {
  assertEmployeeOrManager(ctx.actor);
  const requestedAmountFils = ctx.payload.amountFils ?? (ctx.payload.allocations || []).reduce((sum, x) => sum + Number(x.amountFils || 0), 0);
  const { lines, snapshots } = validateConfirmedCashAllocation(state, ctx.actor.id, ctx.payload.allocations, requestedAmountFils);
  const id = `dep:${ctx.operationId}`;
  const attributionMonths=[...new Set(lines.map((line)=>get(state.cashLots,line.cashLotId).collectionMonth).filter(Boolean))];
  state.depositRequests.push({ id, createdBy: ctx.actor.id, createdByUid: ctx.actor.uid || null, requestedAmountFils, allocations: lines, allocationSnapshots: snapshots, allocationConfirmedBy: ctx.actor.id, allocationConfirmedAt: nowIso(ctx), status: "pending", version: 1, monthKey: ctx.payload.monthKey || null, attributionMonths, createdAt: nowIso(ctx), depositDate: ctx.payload.depositDate });
  audit(state, ctx, "deposit_submitted", "deposit", id, null, { allocations: lines });
  return { depositRequestId: id, status: "pending" };
}

function editDepositRequest(state, ctx) {
  assertEmployeeOrManager(ctx.actor); const request = get(state.depositRequests, ctx.payload.depositRequestId, "DEPOSIT_NOT_FOUND");
  if (request.createdBy !== ctx.actor.id || !["pending", "rejected", "withdrawn"].includes(request.status)) throw new Error("DEPOSIT_NOT_EDITABLE");
  if (Number(ctx.payload.expectedVersion) !== Number(request.version)) throw new Error("STALE_DEPOSIT_REQUEST");
  const requestedAmountFils = ctx.payload.amountFils ?? (ctx.payload.allocations || []).reduce((sum, x) => sum + Number(x.amountFils || 0), 0);
  const { lines, snapshots } = validateConfirmedCashAllocation(state, ctx.actor.id, ctx.payload.allocations, requestedAmountFils);
  const before = clone(request); request.requestedAmountFils = requestedAmountFils; request.allocations = lines; request.allocationSnapshots = snapshots; request.allocationConfirmedBy = ctx.actor.id; request.allocationConfirmedAt = nowIso(ctx); request.depositDate = ctx.payload.depositDate || request.depositDate; request.status = "pending"; request.version += 1; request.updatedAt = nowIso(ctx); request.resubmittedAt = before.status === "rejected" ? nowIso(ctx) : request.resubmittedAt;
  request.history = [...(request.history || []), { action: before.status === "rejected" ? "resubmit" : "edit", by: ctx.actor.id, at: nowIso(ctx), beforeVersion: before.version, afterVersion: request.version }];
  audit(state, ctx, "deposit_edited", "deposit", request.id, before, request); return { depositRequestId: request.id, status: request.status, version: request.version };
}

function rejectDeposit(state, ctx) {
  assertManager(ctx.actor); const request = get(state.depositRequests, ctx.payload.depositRequestId, "DEPOSIT_NOT_FOUND"); const reason = String(ctx.payload.reason || "").trim();
  if (request.status !== "pending") throw new Error("DEPOSIT_NOT_PENDING"); if (!reason) throw new Error("REASON_REQUIRED");
  const before = clone(request); request.status = "rejected"; request.rejectedBy = ctx.actor.id; request.rejectedAt = nowIso(ctx); request.rejectionReason = reason; request.version += 1; request.history = [...(request.history || []), { action: "reject", by: ctx.actor.id, at: nowIso(ctx), reason }];
  audit(state, ctx, "deposit_rejected", "deposit", request.id, before, request); return { depositRequestId: request.id, status: "rejected" };
}

function withdrawDeposit(state, ctx) {
  assertEmployeeOrManager(ctx.actor); const request = get(state.depositRequests, ctx.payload.depositRequestId, "DEPOSIT_NOT_FOUND");
  if (request.createdBy !== ctx.actor.id || request.status !== "pending") throw new Error("DEPOSIT_NOT_WITHDRAWABLE");
  const before = clone(request); request.status = "withdrawn"; request.withdrawnAt = nowIso(ctx); request.version += 1; request.history = [...(request.history || []), { action: "withdraw", by: ctx.actor.id, at: nowIso(ctx) }];
  audit(state, ctx, "deposit_withdrawn", "deposit", request.id, before, request); return { depositRequestId: request.id, status: "withdrawn" };
}

function approveDeposit(state, ctx) {
  assertManager(ctx.actor);
  const request = get(state.depositRequests, ctx.payload.depositRequestId, "DEPOSIT_NOT_FOUND");
  if (request.status !== "pending") throw new Error("DEPOSIT_NOT_PENDING");
  assertCashAllocationStillValid(state, request.allocations, request.allocationSnapshots, request.createdBy);
  const before = clone(request); let totalFils = 0;
  for (const line of request.allocations) {
    const lot = get(state.cashLots, line.cashLotId, "CASH_LOT_NOT_FOUND");
    if (line.amountFils > cashLotAvailable(lot, state.cashMovements)) throw new Error("STALE_CASH_ALLOCATION");
    const alloc = state.allocations.find((x) => x.paymentId === lot.originPaymentId);
    const alreadySettled = state.cashMovements.filter((x) => x.cashLotId === lot.id && x.type === "deposit" && x.status === "active").reduce((s, x) => s + x.amountFils, 0);
    state.cashMovements.push({ id: `cashmove:${ctx.operationId}:${state.cashMovements.length}`, cashLotId: lot.id, type: "deposit", status: "active", amountFils: line.amountFils, fromHolder: lot.currentHolder, sourceOperationId: ctx.operationId, at: nowIso(ctx) });
    const settledAfter = alreadySettled + line.amountFils;
    if (alloc) {
      alloc.settledAmountFils = Math.min(settledAfter, alloc.amountFils);
      alloc.settlementStatus = alloc.settledAmountFils === alloc.amountFils ? "settled" : "partially_settled";
      alloc.settledAt = nowIso(ctx);
    }
    totalFils += line.amountFils;
  }
  request.status = "approved"; request.approvedBy = ctx.actor.id; request.approvedAt = nowIso(ctx);
  changeBalance(state, "revenue", totalFils);
  const grouped = new Map();
  for (const line of request.allocations) {
    const lot = get(state.cashLots, line.cashLotId); grouped.set(lot.collectionMonth, (grouped.get(lot.collectionMonth) || 0) + line.amountFils);
  }
  ledger(state, ctx, [...grouped].map(([effectiveMonth, amountFils]) => ({ account: "revenue", direction: "credit", amountFils, effectiveMonth, sourceType: "cash_deposit", sourceId: request.id })));
  audit(state, ctx, "deposit_approved", "deposit", request.id, before, request);
  return { depositRequestId: request.id, depositedFils: totalFils };
}

function createCustodyTransfer(state, ctx) {
  assertEmployeeOrManager(ctx.actor);
  if (ctx.payload.to === ctx.actor.id) throw new Error("INVALID_TRANSFER");
  const requestedAmountFils = ctx.payload.amountFils ?? (ctx.payload.allocations || []).reduce((sum, x) => sum + Number(x.amountFils || 0), 0);
  const { lines, snapshots } = validateConfirmedCashAllocation(state, ctx.actor.id, ctx.payload.allocations, requestedAmountFils);
  const id = `xfer:${ctx.operationId}`;
  const attributionMonths=[...new Set(lines.map((line)=>get(state.cashLots,line.cashLotId).collectionMonth).filter(Boolean))];
  state.custodyTransfers.push({ id, from: ctx.actor.id, to: ctx.payload.to, requestedAmountFils, allocations: lines, allocationSnapshots: snapshots, allocationConfirmedBy: ctx.actor.id, allocationConfirmedAt: nowIso(ctx), status: "pending", monthKey: ctx.payload.monthKey || null, attributionMonths, createdAt: nowIso(ctx), version: 1 });
  audit(state, ctx, "custody_transfer_submitted", "custody_transfer", id, null, { to: ctx.payload.to, allocations: lines });
  return { transferId: id, status: "pending" };
}

function rejectCustodyTransfer(state, ctx) {
  assertEmployeeOrManager(ctx.actor); const transfer = get(state.custodyTransfers, ctx.payload.transferId, "TRANSFER_NOT_FOUND"); const reason = String(ctx.payload.reason || "").trim();
  if (transfer.status !== "pending" || transfer.to !== ctx.actor.id) throw new Error("TRANSFER_NOT_REJECTABLE"); if (!reason) throw new Error("REASON_REQUIRED");
  const before = clone(transfer); transfer.status = "rejected"; transfer.rejectedBy = ctx.actor.id; transfer.rejectedAt = nowIso(ctx); transfer.rejectionReason = reason; transfer.version += 1; transfer.history = [...(transfer.history || []), { action: "reject", by: ctx.actor.id, at: nowIso(ctx), reason }];
  audit(state, ctx, "custody_transfer_rejected", "custody_transfer", transfer.id, before, transfer); return { transferId: transfer.id, status: "rejected" };
}

function confirmCustodyTransfer(state, ctx) {
  assertEmployeeOrManager(ctx.actor);
  const transfer = get(state.custodyTransfers, ctx.payload.transferId, "TRANSFER_NOT_FOUND");
  if (transfer.status !== "pending" || transfer.to !== ctx.actor.id) throw new Error("TRANSFER_NOT_CONFIRMABLE");
  try { assertCashAllocationStillValid(state, transfer.allocations, transfer.allocationSnapshots, transfer.from); }
  catch (error) { if (error.message === "STALE_CASH_ALLOCATION") throw error; throw new Error("STALE_CASH_ALLOCATION"); }
  for (const line of transfer.allocations) {
    const oldLot = get(state.cashLots, line.cashLotId); const available = cashLotAvailable(oldLot, state.cashMovements);
    state.cashMovements.push({ id: `cashmove:${ctx.operationId}:out:${oldLot.id}`, cashLotId: oldLot.id, type: "transfer_out", status: "active", amountFils: line.amountFils, fromHolder: transfer.from, toHolder: transfer.to, sourceOperationId: ctx.operationId, at: nowIso(ctx) });
    state.cashLots.push({ ...clone(oldLot), id: `lot:${ctx.operationId}:${oldLot.id}`, originalAmountFils: line.amountFils, currentHolder: transfer.to, parentLotId: oldLot.id, status: "held", version: 1 });
    if (line.amountFils === available) oldLot.status = "transferred";
  }
  transfer.status = "confirmed"; transfer.confirmedAt = nowIso(ctx); transfer.confirmedBy = ctx.actor.id;
  audit(state, ctx, "custody_transfer_confirmed", "custody_transfer", transfer.id, null, transfer);
  return { transferId: transfer.id, status: "confirmed" };
}

function reverseCustodyTransfer(state, ctx) {
  assertManager(ctx.actor); const transfer = get(state.custodyTransfers, ctx.payload.transferId, "TRANSFER_NOT_FOUND");
  if (transfer.status !== "confirmed") throw new Error("TRANSFER_NOT_REVERSIBLE");
  const children = [];
  for (const line of transfer.allocations) {
    const child = state.cashLots.find((x) => x.parentLotId === line.cashLotId && x.currentHolder === transfer.to && x.originalAmountFils === line.amountFils && x.status === "held");
    if (!child || cashLotAvailable(child, state.cashMovements) !== line.amountFils) throw new Error("TRANSFER_FUNDS_ALREADY_USED");
    children.push(child);
  }
  const before = clone(transfer);
  children.forEach((child, index) => {
    state.cashMovements.push({ id: `cashmove:${ctx.operationId}:out:${index}`, cashLotId: child.id, type: "transfer_out", status: "active", amountFils: child.originalAmountFils, fromHolder: transfer.to, toHolder: transfer.from, sourceOperationId: ctx.operationId, reversalOf: transfer.id, at: nowIso(ctx) });
    state.cashLots.push({ ...clone(child), id: `lot:${ctx.operationId}:${index}`, currentHolder: transfer.from, parentLotId: child.id, status: "held", version: 1 });
    child.status = "transferred_reversal";
  });
  transfer.status = "reversed"; transfer.reversedBy = ctx.actor.id; transfer.reversedAt = nowIso(ctx); transfer.reversalOperationId = ctx.operationId; transfer.version += 1;
  audit(state, ctx, "custody_transfer_reversed", "custody_transfer", transfer.id, before, transfer); return { transferId: transfer.id, status: "reversed" };
}

function requestDiscount(state, ctx) {
  assertEmployeeOrManager(ctx.actor); const cycle = get(state.cycles, ctx.payload.cycleId, "CYCLE_NOT_FOUND"); const amountFils = requirePositive(ctx.payload.amountFils); const reason = String(ctx.payload.reason || "").trim(); if (!reason) throw new Error("REASON_REQUIRED");
  const view = cycleProjection(cycle, state); if (amountFils > view.remainingCollectibleFils) throw new Error("DISCOUNT_BELOW_RESERVED");
  const id = `discount:${ctx.operationId}`; state.discounts.push({ id, cycleId: cycle.id, amountFils, reason, status: "pending", requestedBy: ctx.actor.id, requestedAt: nowIso(ctx), version: 1 });
  audit(state, ctx, "discount_requested", "discount", id, null, state.discounts.at(-1)); return { discountId: id, status: "pending" };
}

function approveDiscountRequest(state, ctx) {
  assertManager(ctx.actor); const discount = get(state.discounts, ctx.payload.discountId, "DISCOUNT_NOT_FOUND"); if (discount.status !== "pending") throw new Error("DISCOUNT_NOT_PENDING");
  const cycle = get(state.cycles, discount.cycleId, "CYCLE_NOT_FOUND"); const beforeView = cycleProjection(cycle, state); if (discount.amountFils > beforeView.remainingCollectibleFils) throw new Error("STALE_DISCOUNT_REQUEST");
  const before = clone(discount); discount.status = "active"; discount.approvedBy = ctx.actor.id; discount.approvedAt = nowIso(ctx); discount.version += 1;
  cycle.financialVersion = Number(cycle.financialVersion || 0) + 1;
  audit(state, ctx, "discount_approved", "discount", discount.id, before, discount); return { discountId: discount.id, effectiveTargetFils: cycleProjection(cycle, state).targetFils };
}

function approveDiscount(state, ctx) {
  assertManager(ctx.actor); const cycle = get(state.cycles, ctx.payload.cycleId, "CYCLE_NOT_FOUND"); const amountFils = requirePositive(ctx.payload.amountFils);
  const before = cycleProjection(cycle, state); if (amountFils > before.remainingCollectibleFils) throw new Error("DISCOUNT_BELOW_RESERVED");
  const id = `discount:${ctx.operationId}`; state.discounts.push({ id, cycleId: cycle.id, amountFils, status: "active", reason: ctx.payload.reason, approvedBy: ctx.actor.id, approvedAt: nowIso(ctx) });
  cycle.financialVersion = Number(cycle.financialVersion || 0) + 1;
  audit(state, ctx, "discount_approved", "discount", id, null, state.discounts.at(-1)); return { discountId: id, effectiveTargetFils: before.targetFils - amountFils };
}

function reverseDiscount(state, ctx) {
  assertManager(ctx.actor); const discount = get(state.discounts, ctx.payload.discountId, "DISCOUNT_NOT_FOUND");
  if (discount.status !== "active") throw new Error("DISCOUNT_ALREADY_REVERSED");
  const cycle = get(state.cycles, discount.cycleId, "CYCLE_NOT_FOUND"); const before = clone(discount);
  discount.status = "reversed"; discount.reversedBy = ctx.actor.id; discount.reversedAt = nowIso(ctx); discount.reversalOperationId = ctx.operationId;
  cycle.financialVersion = Number(cycle.financialVersion || 0) + 1;
  audit(state, ctx, "discount_reversed", "discount", discount.id, before, discount);
  return { discountId: discount.id, effectiveTargetFils: cycleProjection(cycle, state).targetFils };
}

function approveEviction(state, ctx) {
  assertManager(ctx.actor); const cycle = get(state.cycles, ctx.payload.cycleId, "CYCLE_NOT_FOUND");
  if (!String(cycle.status).startsWith("open")) throw new Error("CYCLE_NOT_OPEN");
  if (ctx.payload.expectedFinancialVersion !== cycle.financialVersion) throw new Error("STALE_EVICTION_REQUEST");
  const view = cycleProjection(cycle, state); const before = clone(cycle); const id = `eviction:${ctx.operationId}`;
  if (view.tenantReceivedReservedFils === 0) {
    cycle.status = "cancelled_eviction"; cycle.cancelledTargetFils = view.targetFils; cycle.uncollectedAtEvictionFils = 0;
  } else {
    cycle.status = "closed_eviction_partial"; cycle.uncollectedAtEvictionFils = view.remainingCollectibleFils; cycle.cancelledTargetFils = 0;
  }
  cycle.evictedAt = nowIso(ctx); cycle.evictedBy = ctx.actor.id; cycle.financialVersion = (cycle.financialVersion || 0) + 1;
  state.evictions.push({ id, cycleId: cycle.id, reason: ctx.payload.reason, status: "approved", approvedBy: ctx.actor.id, approvedAt: nowIso(ctx), before, after: clone(cycle) });
  audit(state, ctx, "eviction_approved", "cycle", cycle.id, before, cycle);
  return { evictionId: id, cycleStatus: cycle.status, cancelledTargetFils: cycle.cancelledTargetFils, uncollectedAtEvictionFils: cycle.uncollectedAtEvictionFils };
}

function requestEviction(state, ctx) {
  assertEmployeeOrManager(ctx.actor); const cycle = get(state.cycles, ctx.payload.cycleId, "CYCLE_NOT_FOUND"); if (!String(cycle.status).startsWith("open")) throw new Error("CYCLE_NOT_OPEN");
  const reason = String(ctx.payload.reason || "").trim(); if (!reason) throw new Error("REASON_REQUIRED"); const id = `eviction:${ctx.operationId}`;
  state.evictions.push({ id, cycleId: cycle.id, reason, status: "pending", requestedBy: ctx.actor.id, requestedAt: nowIso(ctx), expectedFinancialVersion: Number(cycle.financialVersion || 0), version: 1 });
  audit(state, ctx, "eviction_requested", "eviction", id, null, state.evictions.at(-1)); return { evictionId: id, status: "pending" };
}

function approveEvictionRequest(state, ctx) {
  assertManager(ctx.actor); const request = get(state.evictions, ctx.payload.evictionId, "EVICTION_NOT_FOUND"); if (request.status !== "pending") throw new Error("EVICTION_NOT_PENDING");
  const cycle = get(state.cycles, request.cycleId, "CYCLE_NOT_FOUND"); if (Number(cycle.financialVersion || 0) !== Number(request.expectedFinancialVersion)) throw new Error("STALE_EVICTION_REQUEST");
  const view = cycleProjection(cycle, state); const beforeCycle = clone(cycle); const beforeRequest = clone(request);
  if (view.tenantReceivedReservedFils === 0) { cycle.status = "cancelled_eviction"; cycle.cancelledTargetFils = view.targetFils; cycle.uncollectedAtEvictionFils = 0; }
  else { cycle.status = "closed_eviction_partial"; cycle.uncollectedAtEvictionFils = view.remainingCollectibleFils; cycle.cancelledTargetFils = 0; }
  cycle.evictedAt = nowIso(ctx); cycle.evictedBy = ctx.actor.id; cycle.financialVersion = Number(cycle.financialVersion || 0) + 1;
  request.status = "approved"; request.approvedBy = ctx.actor.id; request.approvedAt = nowIso(ctx); request.beforeCycle = beforeCycle; request.afterCycle = clone(cycle); request.version += 1;
  audit(state, ctx, "eviction_approved", "eviction", request.id, beforeRequest, request); return { evictionId: request.id, cycleStatus: cycle.status, cancelledTargetFils: cycle.cancelledTargetFils, uncollectedAtEvictionFils: cycle.uncollectedAtEvictionFils };
}

function correctPayment(state, ctx) {
  assertManager(ctx.actor); const alloc = get(state.allocations, ctx.payload.allocationId, "ALLOCATION_NOT_FOUND"); const payment = get(state.paymentIntents, alloc.paymentId, "PAYMENT_NOT_FOUND");
  if (alloc.reservationStatus !== "active" || ["cancelled", "reversed"].includes(payment.status)) throw new Error("STALE_PAYMENT_CORRECTION");
  const before = { allocation: clone(alloc), payment: clone(payment) }; const correction = { id: `correction:${ctx.operationId}`, paymentId: payment.id, allocationId: alloc.id, reason: String(ctx.payload.reason || "").trim(), before, status: "applied", approvedBy: ctx.actor.id, approvedAt: nowIso(ctx) }; if (!correction.reason) throw new Error("REASON_REQUIRED");
  if (ctx.payload.newCycleId && ctx.payload.newCycleId !== alloc.cycleId) {
    const sourceCycle = get(state.cycles, alloc.cycleId, "SOURCE_CYCLE_NOT_FOUND"); const targetCycle = get(state.cycles, ctx.payload.newCycleId, "TARGET_CYCLE_NOT_FOUND"); const targetView = cycleProjection(targetCycle, state); if (alloc.amountFils > targetView.remainingCollectibleFils) throw new Error(`OVERPAYMENT:${targetView.remainingCollectibleFils}`);
    alloc.cycleId = targetCycle.id; payment.cycleId = targetCycle.id;
    sourceCycle.financialVersion = Number(sourceCycle.financialVersion || 0) + 1; targetCycle.financialVersion = Number(targetCycle.financialVersion || 0) + 1;
  }
  if (ctx.payload.paymentDate) { payment.paymentDate = String(ctx.payload.paymentDate); payment.collectionMonth = monthOf(payment.paymentDate); alloc.collectionMonth = payment.collectionMonth; }
  correction.after = { allocation: clone(alloc), payment: clone(payment) }; state.cycleCorrections.push(correction);
  audit(state, ctx, "payment_corrected", "payment", payment.id, before, correction.after); return { correctionId: correction.id, paymentId: payment.id, cycleId: alloc.cycleId, collectionMonth: alloc.collectionMonth };
}

function cancelPayment(state, ctx) {
  assertManager(ctx.actor); const payment = get(state.paymentIntents, ctx.payload.paymentId, "PAYMENT_NOT_FOUND"); const reason = String(ctx.payload.reason || "").trim(); if (!reason) throw new Error("REASON_REQUIRED"); if (["cancelled", "reversed"].includes(payment.status)) throw new Error("PAYMENT_ALREADY_CANCELLED");
  if (payment.method === "bank" && payment.status === "pending") { const before = clone(payment); payment.status = "cancelled"; payment.cancelledBy = ctx.actor.id; payment.cancelledAt = nowIso(ctx); payment.cancelReason = reason; audit(state, ctx, "payment_cancelled", "payment", payment.id, before, payment); return { paymentId: payment.id, status: "cancelled", amountFils: 0 }; }
  const alloc = state.allocations.find((x) => x.paymentId === payment.id && x.reservationStatus === "active"); if (!alloc) throw new Error("ALLOCATION_NOT_FOUND");
  const refundable = alloc.amountFils - state.refunds.filter((x) => x.allocationId === alloc.id && x.status === "active").reduce((s, x) => s + x.amountFils, 0); if (refundable <= 0) throw new Error("NOTHING_REFUNDABLE");
  const result = refundPayment(state, { ...ctx, payload: { allocationId: alloc.id, amountFils: refundable } }); payment.status = "cancelled"; payment.cancelReason = reason; payment.cancelledBy = ctx.actor.id; payment.cancelledAt = nowIso(ctx); return { paymentId: payment.id, status: "cancelled", refundId: result.refundId, amountFils: refundable };
}

function refundPayment(state, ctx) {
  assertManager(ctx.actor); const alloc = get(state.allocations, ctx.payload.allocationId, "ALLOCATION_NOT_FOUND"); const amountFils = requirePositive(ctx.payload.amountFils);
  const prior = state.refunds.filter((x) => x.allocationId === alloc.id && x.status === "active").reduce((s, x) => s + x.amountFils, 0);
  if (prior + amountFils > alloc.amountFils) throw new Error("REFUND_EXCEEDS_PAYMENT");
  const payment = get(state.paymentIntents, alloc.paymentId, "PAYMENT_NOT_FOUND");
  const settledFils = Number(alloc.settledAmountFils ?? (alloc.settlementStatus === "settled" ? alloc.amountFils : 0));
  const priorRevenueRefund = state.refunds.filter((x) => x.allocationId === alloc.id && x.status === "active" && x.source === "revenue").reduce((s, x) => s + x.amountFils, 0);
  const priorCustodyRefund = state.refunds.filter((x) => x.allocationId === alloc.id && x.status === "active" && x.source === "custody").reduce((s, x) => s + x.amountFils, 0);
  const revenueRefundable = settledFils - priorRevenueRefund; const custodyRefundable = alloc.amountFils - settledFils - priorCustodyRefund;
  let source = ctx.payload.source;
  if (!source) { if (revenueRefundable > 0 && custodyRefundable > 0) throw new Error("REFUND_SOURCE_REQUIRED"); source = revenueRefundable > 0 ? "revenue" : "custody"; }
  if (source === "revenue") {
    if (amountFils > revenueRefundable) throw new Error("REFUND_EXCEEDS_DEPOSITED_AMOUNT");
    changeBalance(state, "revenue", -amountFils);
    ledger(state, ctx, [{ account: "revenue", direction: "debit", amountFils, effectiveMonth: alloc.collectionMonth, sourceType: "refund", sourceId: alloc.id }]);
  } else if (source === "custody") {
    if (amountFils > custodyRefundable) throw new Error("REFUND_EXCEEDS_UNDEPOSITED_AMOUNT");
    const lot = get(state.cashLots, ctx.payload.cashLotId || `lot:${payment.operationId}`, "CASH_LOT_NOT_FOUND");
    if (amountFils > cashLotAvailable(lot, state.cashMovements)) throw new Error("CASH_LOT_INSUFFICIENT");
    state.cashMovements.push({ id: `cashmove:${ctx.operationId}`, cashLotId: lot.id, type: "refund", status: "active", amountFils, fromHolder: lot.currentHolder, sourceOperationId: ctx.operationId, at: nowIso(ctx) });
  } else throw new Error("INVALID_REFUND_SOURCE");
  const cycle = get(state.cycles, alloc.cycleId, "CYCLE_NOT_FOUND"); cycle.financialVersion = Number(cycle.financialVersion || 0) + 1;
  if (prior + amountFils === alloc.amountFils) alloc.reservationStatus = "reversed";
  const id = `refund:${ctx.operationId}`; state.refunds.push({ id, allocationId: alloc.id, paymentId: payment.id, source, cashLotId: source === "custody" ? (ctx.payload.cashLotId || `lot:${payment.operationId}`) : null, amountFils, status: "active", approvedBy: ctx.actor.id, approvedAt: nowIso(ctx) });
  audit(state, ctx, "payment_refunded", "refund", id, null, state.refunds.at(-1)); return { refundId: id, amountFils };
}

function transferBalance(state, ctx) {
  assertManager(ctx.actor); const { source, destination } = ctx.payload; const amountFils = requirePositive(ctx.payload.amountFils); if (source === destination) throw new Error("SAME_ACCOUNT");
  if (source === "company" && destination === "deduction") throw new Error("USE_INSTALLMENT_RESERVE_TRANSFER_COMMAND");
  changeBalance(state, source, -amountFils); changeBalance(state, destination, amountFils);
  const id = `balxfer:${ctx.operationId}`; state.balanceTransfers.push({ id, source, destination, amountFils, reason: ctx.payload.reason, status: "active", createdBy: ctx.actor.id, createdAt: nowIso(ctx) });
  ledger(state, ctx, [{ account: source, direction: "debit", amountFils, sourceType: "balance_transfer", sourceId: id }, { account: destination, direction: "credit", amountFils, sourceType: "balance_transfer", sourceId: id }]);
  audit(state, ctx, "balance_transferred", "balance_transfer", id, null, state.balanceTransfers.at(-1)); return { transferId: id };
}

function reverseBalanceTransfer(state, ctx) {
  assertManager(ctx.actor); const transfer = get(state.balanceTransfers, ctx.payload.transferId, "BALANCE_TRANSFER_NOT_FOUND"); if (transfer.status !== "active") throw new Error("BALANCE_TRANSFER_ALREADY_REVERSED");
  if (transfer.transferType === "installment_reserve_internal") throw new Error("USE_INSTALLMENT_RESERVE_REVERSAL_COMMAND");
  const before = clone(transfer); changeBalance(state, transfer.destination, -transfer.amountFils); changeBalance(state, transfer.source, transfer.amountFils); transfer.status = "reversed"; transfer.reversedBy = ctx.actor.id; transfer.reversedAt = nowIso(ctx); transfer.reversalOperationId = ctx.operationId;
  ledger(state, ctx, [{ account: transfer.destination, direction: "debit", amountFils: transfer.amountFils, sourceType: "balance_transfer_reversal", sourceId: transfer.id }, { account: transfer.source, direction: "credit", amountFils: transfer.amountFils, sourceType: "balance_transfer_reversal", sourceId: transfer.id }]);
  audit(state, ctx, "balance_transfer_reversed", "balance_transfer", transfer.id, before, transfer); return { transferId: transfer.id, status: "reversed" };
}

function createInstallmentReserveTransfer(state, ctx) {
  assertManager(ctx.actor);
  const amountFils = requirePositive(ctx.payload.amountFils);
  const reason = String(ctx.payload.reason || "").trim();
  if (!reason) throw new Error("REASON_REQUIRED");
  const effectiveDate = String(ctx.payload.effectiveDate || nowIso(ctx).slice(0, 10));
  const effectiveMonth = monthOf(effectiveDate);
  changeBalance(state, "company", -amountFils);
  changeBalance(state, "deduction", amountFils);
  const id = `reserve-transfer:${ctx.operationId}`;
  const event = {
    id, transferType: "installment_reserve_internal", source: "company", destination: "deduction",
    amountFils, effectiveDate, effectiveMonth, reason, status: "active",
    incomeEffectFils: 0, expenseEffectFils: 0, netEffectFils: 0, liquidityEffectFils: 0,
    createdBy: ctx.actor.id, createdAt: nowIso(ctx), operationId: ctx.operationId,
  };
  state.balanceTransfers.push(event);
  ledger(state, ctx, [
    { account: "company", direction: "debit", amountFils, effectiveMonth, sourceType: "installment_reserve_internal_transfer", sourceId: id },
    { account: "deduction", direction: "credit", amountFils, effectiveMonth, sourceType: "installment_reserve_internal_transfer", sourceId: id },
  ]);
  audit(state, ctx, "installment_reserve_transferred", "balance_transfer", id, null, event);
  return { transferId: id, transferType: event.transferType, amountFils, effectiveMonth };
}

function reverseInstallmentReserveTransfer(state, ctx) {
  assertManager(ctx.actor);
  const transfer = get(state.balanceTransfers, ctx.payload.transferId, "INSTALLMENT_RESERVE_TRANSFER_NOT_FOUND");
  if (transfer.transferType !== "installment_reserve_internal") throw new Error("NOT_INSTALLMENT_RESERVE_TRANSFER");
  if (transfer.status !== "active") throw new Error("INSTALLMENT_RESERVE_TRANSFER_ALREADY_REVERSED");
  const before = clone(transfer);
  changeBalance(state, "deduction", -transfer.amountFils);
  changeBalance(state, "company", transfer.amountFils);
  transfer.status = "reversed";
  transfer.reversedBy = ctx.actor.id;
  transfer.reversedAt = nowIso(ctx);
  transfer.reversalOperationId = ctx.operationId;
  ledger(state, ctx, [
    { account: "deduction", direction: "debit", amountFils: transfer.amountFils, effectiveMonth: transfer.effectiveMonth, sourceType: "installment_reserve_internal_transfer_reversal", sourceId: transfer.id },
    { account: "company", direction: "credit", amountFils: transfer.amountFils, effectiveMonth: transfer.effectiveMonth, sourceType: "installment_reserve_internal_transfer_reversal", sourceId: transfer.id },
  ]);
  audit(state, ctx, "installment_reserve_transfer_reversed", "balance_transfer", transfer.id, before, transfer);
  return { transferId: transfer.id, status: "reversed", reversalOperationId: ctx.operationId };
}

function executeExpense(state, ctx) {
  assertManager(ctx.actor); const account = ctx.payload.account; const amountFils = requirePositive(ctx.payload.amountFils); const reason = String(ctx.payload.reason || "").trim(); if (!reason) throw new Error("REASON_REQUIRED");
  changeBalance(state, account, -amountFils); const id = `expense:${ctx.operationId}`;
  const category = expenseCategory(ctx.payload); const subject = expenseSubject(ctx.payload, category);
  state.expenses.push({ id, account, amountFils, reason, category, subject, status: "active", approvedBy: ctx.actor.id, approvedAt: nowIso(ctx), approvedMonth: ctx.payload.monthKey || monthOf(nowIso(ctx).slice(0,10)) });
  ledger(state, ctx, [{ account, direction: "debit", amountFils, sourceType: "expense", sourceId: id }]); audit(state, ctx, "expense_approved", "expense", id, null, state.expenses.at(-1)); return { expenseId: id };
}

const EXPENSE_CATEGORIES = Object.freeze(["operating", "unitMaintenance", "facilityMaintenance"]);
function expenseCategory(payload) {
  const raw = String(payload?.category || "operating");
  if (!EXPENSE_CATEGORIES.includes(raw)) throw new Error("EXPENSE_CATEGORY_INVALID");
  return raw;
}
function expenseSubject(payload, category) {
  const subject = String(payload?.subject || "").trim();
  if (category !== "operating" && !subject) throw new Error("EXPENSE_SUBJECT_REQUIRED");
  return subject || null;
}

function requestExpense(state, ctx) {
  assertEmployeeOrManager(ctx.actor); const amountFils = requirePositive(ctx.payload.amountFils); const reason = String(ctx.payload.reason || "").trim(); if (!reason) throw new Error("REASON_REQUIRED"); const id = `expense:${ctx.operationId}`;
  const category = expenseCategory(ctx.payload); const subject = expenseSubject(ctx.payload, category);
  state.expenses.push({ id, amountFils, reason, category, subject, status: "pending", requestedBy: ctx.actor.id, requestedByUid: ctx.actor.uid || null, requestedAt: nowIso(ctx), monthKey: ctx.payload.monthKey || monthOf(nowIso(ctx).slice(0,10)), version: 1 });
  audit(state, ctx, "expense_requested", "expense", id, null, state.expenses.at(-1)); return { expenseId: id, status: "pending" };
}

function approveExpense(state, ctx) {
  assertManager(ctx.actor); const expense = get(state.expenses, ctx.payload.expenseId, "EXPENSE_NOT_FOUND"); if (expense.status !== "pending") throw new Error("EXPENSE_NOT_PENDING"); const account = ctx.payload.account;
  const before = clone(expense); changeBalance(state, account, -expense.amountFils); expense.account = account; expense.status = "active"; expense.approvedBy = ctx.actor.id; expense.approvedAt = nowIso(ctx); expense.approvedMonth = expense.monthKey || ctx.payload.monthKey || monthOf(nowIso(ctx).slice(0,10)); expense.version += 1;
  ledger(state, ctx, [{ account, direction: "debit", amountFils: expense.amountFils, sourceType: "expense", sourceId: expense.id }]); audit(state, ctx, "expense_approved", "expense", expense.id, before, expense); return { expenseId: expense.id, status: "active", account };
}

function reverseExpense(state, ctx) {
  assertManager(ctx.actor); const expense = get(state.expenses, ctx.payload.expenseId, "EXPENSE_NOT_FOUND"); if (expense.status !== "active") throw new Error("EXPENSE_ALREADY_REVERSED");
  const before = clone(expense); changeBalance(state, expense.account, expense.amountFils); expense.status = "reversed"; expense.reversedBy = ctx.actor.id; expense.reversedAt = nowIso(ctx);
  ledger(state, ctx, [{ account: expense.account, direction: "credit", amountFils: expense.amountFils, sourceType: "expense_reversal", sourceId: expense.id }]); audit(state, ctx, "expense_reversed", "expense", expense.id, before, expense); return { expenseId: expense.id, status: "reversed" };
}

function recordExternalRevenue(state, ctx) {
  assertManager(ctx.actor);
  const amountFils = requirePositive(ctx.payload.amountFils);
  const date = String(ctx.payload.date || "").trim();
  const source = String(ctx.payload.source || "").trim();
  const reason = String(ctx.payload.reason || ctx.payload.description || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("INVALID_DATE");
  if (!source) throw new Error("SOURCE_REQUIRED");
  if (!reason) throw new Error("REASON_REQUIRED");
  // This command deliberately has no tenant/cycle fields. Tenant money must
  // use the cash-lot or bank-payment workflows and cannot be reclassified.
  for (const key of ["tenantId", "tenancyId", "cycleId", "unitId", "paymentId", "cashLotId"]) {
    if (ctx.payload[key] != null && String(ctx.payload[key]).trim()) throw new Error("TENANT_REVENUE_WORKFLOW_REQUIRED");
  }
  const id = `external-revenue:${ctx.operationId}`;
  changeBalance(state, "revenue", amountFils);
  const event = { id, amountFils, date, effectiveMonth: monthOf(date), source, reason, status: "active", createdBy: ctx.actor.id, createdAt: nowIso(ctx), operationId: ctx.operationId };
  state.externalRevenues.push(event);
  ledger(state, ctx, [{ account: "revenue", direction: "credit", amountFils, effectiveMonth: event.effectiveMonth, sourceType: "external_revenue", sourceId: id }]);
  audit(state, ctx, "external_revenue_recorded", "external_revenue", id, null, event);
  return { externalRevenueId: id, amountFils, effectiveMonth: event.effectiveMonth };
}

function reverseExternalRevenue(state, ctx) {
  assertManager(ctx.actor);
  const event = get(state.externalRevenues, ctx.payload.externalRevenueId, "EXTERNAL_REVENUE_NOT_FOUND");
  const reason = String(ctx.payload.reason || "").trim();
  if (!reason) throw new Error("REASON_REQUIRED");
  if (event.status !== "active") throw new Error("EXTERNAL_REVENUE_ALREADY_REVERSED");
  const before = clone(event);
  changeBalance(state, "revenue", -event.amountFils);
  event.status = "reversed"; event.reversedBy = ctx.actor.id; event.reversedAt = nowIso(ctx);
  event.reversalReason = reason; event.reversalOperationId = ctx.operationId;
  ledger(state, ctx, [{ account: "revenue", direction: "debit", amountFils: event.amountFils, effectiveMonth: event.effectiveMonth, sourceType: "external_revenue_reversal", sourceId: event.id }]);
  audit(state, ctx, "external_revenue_reversed", "external_revenue", event.id, before, event);
  return { externalRevenueId: event.id, status: "reversed", amountFils: event.amountFils };
}

function createOwnerProfitDistribution(state, ctx) {
  assertManager(ctx.actor);
  const amountFils = requirePositive(ctx.payload.amountFils);
  const sourceAccount = String(ctx.payload.sourceAccount || "");
  const date = String(ctx.payload.date || "").trim();
  const reason = String(ctx.payload.reason || ctx.payload.description || "").trim();
  if (!Object.hasOwn(state.balances, sourceAccount)) throw new Error("UNKNOWN_ACCOUNT");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("INVALID_DATE");
  if (!reason) throw new Error("REASON_REQUIRED");
  assertMonthAllowsOriginLinked(monthState(state, monthOf(date)), false);
  const id = `owner-profit-distribution:${ctx.operationId}`;
  changeBalance(state, sourceAccount, -amountFils);
  const event = { id, amountFils, sourceAccount, date, effectiveMonth: monthOf(date), reason, status: "active", createdBy: ctx.actor.id, createdAt: nowIso(ctx), operationId: ctx.operationId };
  state.ownerProfitDistributions.push(event);
  ledger(state, ctx, [{ account: sourceAccount, direction: "debit", amountFils, effectiveMonth: event.effectiveMonth, sourceType: "owner_profit_distribution", sourceId: id }]);
  audit(state, ctx, "owner_profit_distribution_created", "owner_profit_distribution", id, null, event);
  return { ownerProfitDistributionId: id, amountFils, sourceAccount };
}

function reverseOwnerProfitDistribution(state, ctx) {
  assertManager(ctx.actor);
  const event = get(state.ownerProfitDistributions, ctx.payload.ownerProfitDistributionId, "OWNER_PROFIT_DISTRIBUTION_NOT_FOUND");
  const reason = String(ctx.payload.reason || "").trim();
  if (!reason) throw new Error("REASON_REQUIRED");
  if (event.status !== "active") throw new Error("OWNER_PROFIT_DISTRIBUTION_ALREADY_REVERSED");
  const before = clone(event);
  changeBalance(state, event.sourceAccount, event.amountFils);
  event.status = "reversed"; event.reversedBy = ctx.actor.id; event.reversedAt = nowIso(ctx); event.reversalReason = reason; event.reversalOperationId = ctx.operationId;
  ledger(state, ctx, [{ account: event.sourceAccount, direction: "credit", amountFils: event.amountFils, effectiveMonth: event.effectiveMonth, sourceType: "owner_profit_distribution_reversal", sourceId: event.id }]);
  audit(state, ctx, "owner_profit_distribution_reversed", "owner_profit_distribution", event.id, before, event);
  return { ownerProfitDistributionId: event.id, status: "reversed" };
}

function adjustInstallmentObligation(state, ctx) {
  assertManager(ctx.actor);
  const id = requireId(ctx.payload.obligationId, "INVALID_OBLIGATION_ID");
  const reason = String(ctx.payload.reason || "").trim();
  if (!reason) throw new Error("REASON_REQUIRED");
  const obligation = get(state.installmentObligations, id, "INSTALLMENT_OBLIGATION_NOT_FOUND");
  if (Number(ctx.payload.expectedVersion) !== Number(obligation.version || 0)) throw new Error("STALE_INSTALLMENT_OBLIGATION");
  const before = clone(obligation);
  const nextAmount = ctx.payload.amountFils == null ? obligation.amountFils : requirePositive(ctx.payload.amountFils);
  const paidFils = state.installments.filter((x) => x.obligationId === id && x.status === "paid").reduce((s, x) => s + Number(x.amountFils || 0), 0);
  if (nextAmount < paidFils) throw new Error("INSTALLMENT_OBLIGATION_BELOW_PAID");
  const nextDueDate = ctx.payload.dueDate == null ? obligation.dueDate : String(ctx.payload.dueDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDueDate)) throw new Error("INVALID_DATE");
  obligation.amountFils = nextAmount; obligation.dueDate = nextDueDate;
  obligation.effectiveMonth = monthOf(nextDueDate);
  if (ctx.payload.description != null) obligation.description = String(ctx.payload.description);
  if (ctx.payload.reference != null) obligation.reference = String(ctx.payload.reference);
  obligation.version = Number(obligation.version || 0) + 1; obligation.updatedBy = ctx.actor.id; obligation.updatedAt = nowIso(ctx);
  const correctionId = `installment-obligation-adjustment:${ctx.operationId}`;
  state.cycleCorrections.push({ id: correctionId, correctionType: "installment_obligation_adjustment", obligationId: id, before, after: clone(obligation), reason, actorId: ctx.actor.id, at: nowIso(ctx), effectiveMonth: monthOf(nextDueDate) });
  audit(state, ctx, "installment_obligation_adjusted", "installment_obligation", id, before, obligation);
  return { obligationId: id, version: obligation.version, amountFils: nextAmount, paidFils, remainingFils: nextAmount - paidFils };
}

function createLegacyFinancialCorrection(state, ctx) {
  assertManager(ctx.actor);
  const legacyRecordReference = String(ctx.payload.legacyRecordReference || "").trim();
  const correctionType = String(ctx.payload.correctionType || "").trim();
  const reason = String(ctx.payload.reason || "").trim();
  const direction = String(ctx.payload.direction || "none");
  const amountFils = direction === "none" ? 0 : requirePositive(ctx.payload.amountFils);
  const account = direction === "none" ? null : String(ctx.payload.account || "");
  const effectiveMonth = String(ctx.payload.effectiveMonth || "");
  if (!legacyRecordReference) throw new Error("LEGACY_REFERENCE_REQUIRED");
  if (!correctionType) throw new Error("CORRECTION_TYPE_REQUIRED");
  if (!reason) throw new Error("REASON_REQUIRED");
  if (direction !== "none" && !Object.hasOwn(state.balances, account)) throw new Error("UNKNOWN_ACCOUNT");
  if (!["increase", "decrease", "none"].includes(direction)) throw new Error("INVALID_DIRECTION");
  if (!/^\d{4}_\d{1,2}$/.test(effectiveMonth)) throw new Error("MONTH_KEY_INVALID");
  const delta = direction === "increase" ? amountFils : direction === "decrease" ? -amountFils : 0;
  if (delta) changeBalance(state, account, delta);
  const id = `legacy-financial-correction:${ctx.operationId}`;
  const event = { id, legacyRecordReference, legacyRecordHash: ctx.payload.legacyRecordHash || null, correctionType, beforeReferenceValue: ctx.payload.beforeReferenceValue ?? null, afterValue: ctx.payload.afterValue ?? null, amountFils, account, direction, reason, confidence: String(ctx.payload.confidence || "UNVERIFIED"), sourceClassification: ctx.payload.managerAsserted ? "MANAGER_ASSERTED" : "LEGACY_EVIDENCE", historicalConfidencePreserved: true, status: "active", effectiveMonth, actorId: ctx.actor.id, createdAt: nowIso(ctx), operationId: ctx.operationId };
  state.legacyFinancialCorrections.push(event);
  if (delta) ledger(state, ctx, [{ account, direction: delta > 0 ? "credit" : "debit", amountFils, effectiveMonth: event.effectiveMonth, sourceType: "legacy_financial_correction", sourceId: id }]);
  audit(state, ctx, "legacy_financial_correction_created", "legacy_financial_correction", id, null, event);
  return { legacyFinancialCorrectionId: id, amountFils, account, direction };
}

function adjustBalance(state, ctx) {
  assertManager(ctx.actor); const account = ctx.payload.account; const amountFils = requirePositive(ctx.payload.amountFils); const direction = ctx.payload.direction; const reason = String(ctx.payload.reason || "").trim(); if (!reason) throw new Error("REASON_REQUIRED"); if (!["increase", "decrease"].includes(direction)) throw new Error("INVALID_DIRECTION");
  const delta = direction === "increase" ? amountFils : -amountFils; changeBalance(state, account, delta); const id = `adjustment:${ctx.operationId}`;
  state.adjustments.push({ id, account, amountFils, direction, reason, status: "active", createdBy: ctx.actor.id, createdAt: nowIso(ctx) });
  ledger(state, ctx, [{ account, direction: delta > 0 ? "credit" : "debit", amountFils, sourceType: "balance_adjustment", sourceId: id }]); audit(state, ctx, "balance_adjusted", "adjustment", id, null, state.adjustments.at(-1)); return { adjustmentId: id };
}

function reverseAdjustment(state, ctx) {
  assertManager(ctx.actor); const adjustment = get(state.adjustments, ctx.payload.adjustmentId, "ADJUSTMENT_NOT_FOUND"); if (adjustment.status !== "active") throw new Error("ADJUSTMENT_ALREADY_REVERSED");
  const before = clone(adjustment); const delta = adjustment.direction === "increase" ? -adjustment.amountFils : adjustment.amountFils; changeBalance(state, adjustment.account, delta); adjustment.status = "reversed"; adjustment.reversedBy = ctx.actor.id; adjustment.reversedAt = nowIso(ctx); adjustment.reversalOperationId = ctx.operationId;
  ledger(state, ctx, [{ account: adjustment.account, direction: delta > 0 ? "credit" : "debit", amountFils: adjustment.amountFils, sourceType: "adjustment_reversal", sourceId: adjustment.id }]); audit(state, ctx, "adjustment_reversed", "adjustment", adjustment.id, before, adjustment); return { adjustmentId: adjustment.id, status: "reversed" };
}

function payInstallment(state, ctx) {
  if (Number(state.financialTruthVersion || 2) >= 3) throw new Error("USE_BANK_INSTALLMENT_PAYMENT_COMMAND");
  assertManager(ctx.actor); const account = ctx.payload.account; const amountFils = requirePositive(ctx.payload.amountFils); const obligationId = requireId(ctx.payload.obligationId, "INVALID_OBLIGATION_ID");
  if (state.installments.some((x) => x.obligationId === obligationId && x.status === "paid")) throw new Error("INSTALLMENT_ALREADY_PAID");
  changeBalance(state, account, -amountFils); const id = `installment:${ctx.operationId}`;
  const effectiveMonth = ctx.payload.effectiveMonth || monthOf(nowIso(ctx).slice(0,10));
  state.installments.push({ id, obligationId, account, amountFils, effectiveMonth, status: "paid", paidBy: ctx.actor.id, paidAt: nowIso(ctx) });
  ledger(state, ctx, [{ account, direction: "debit", amountFils, effectiveMonth, sourceType: "installment", sourceId: id }]); audit(state, ctx, "installment_paid", "installment", id, null, state.installments.at(-1)); return { installmentId: id };
}

function reverseInstallment(state, ctx) {
  assertManager(ctx.actor); const installment = get(state.installments, ctx.payload.installmentId, "INSTALLMENT_NOT_FOUND"); if (installment.status !== "paid") throw new Error("INSTALLMENT_ALREADY_REVERSED");
  const before = clone(installment); changeBalance(state, installment.account, installment.amountFils); installment.status = "reversed"; installment.reversedBy = ctx.actor.id; installment.reversedAt = nowIso(ctx); installment.reversalOperationId = ctx.operationId;
  ledger(state, ctx, [{ account: installment.account, direction: "credit", amountFils: installment.amountFils, sourceType: "installment_reversal", sourceId: installment.id }]); audit(state, ctx, "installment_reversed", "installment", installment.id, before, installment); return { installmentId: installment.id, status: "reversed" };
}

function createBankInstallmentPayment(state, ctx) {
  assertManager(ctx.actor);
  const amountFils = requirePositive(ctx.payload.amountFils);
  const effectiveDate = String(ctx.payload.effectiveDate || nowIso(ctx).slice(0, 10));
  const effectiveMonth = monthOf(effectiveDate);
  const reference = String(ctx.payload.reference || "").trim();
  if (!reference) throw new Error("REFERENCE_REQUIRED");
  changeBalance(state, "deduction", -amountFils);
  const id = `bank-installment:${ctx.operationId}`;
  const event = {
    id, paymentType: "BANK_INSTALLMENT", classification: "bank_installment",
    sourceAccount: "deduction", beneficiaryType: "bank", amountFils,
    effectiveDate, effectiveMonth, reference, obligationId: ctx.payload.obligationId || null,
    status: "paid", incomeEffectFils: 0, expenseEffectFils: 0, netEffectFils: 0,
    liquidityEffectFils: -amountFils, paidBy: ctx.actor.id, paidAt: nowIso(ctx),
    operationId: ctx.operationId,
  };
  state.installments.push(event);
  ledger(state, ctx, [{ account: "deduction", direction: "debit", amountFils, effectiveMonth, sourceType: "bank_installment", sourceId: id }]);
  audit(state, ctx, "bank_installment_paid", "bank_installment", id, null, event);
  return { bankInstallmentId: id, paymentType: event.paymentType, amountFils, effectiveMonth };
}

function reverseBankInstallmentPayment(state, ctx) {
  assertManager(ctx.actor);
  const event = get(state.installments, ctx.payload.bankInstallmentId, "BANK_INSTALLMENT_NOT_FOUND");
  if (event.paymentType !== "BANK_INSTALLMENT" || event.sourceAccount !== "deduction") throw new Error("NOT_BANK_INSTALLMENT");
  if (event.status !== "paid") throw new Error("BANK_INSTALLMENT_ALREADY_REVERSED");
  const reason = String(ctx.payload.reason || "").trim();
  if (!reason) throw new Error("REASON_REQUIRED");
  const before = clone(event);
  changeBalance(state, "deduction", event.amountFils);
  event.status = "reversed";
  event.reversedBy = ctx.actor.id;
  event.reversedAt = nowIso(ctx);
  event.reversalReason = reason;
  event.reversalOperationId = ctx.operationId;
  ledger(state, ctx, [{ account: "deduction", direction: "credit", amountFils: event.amountFils, effectiveMonth: event.effectiveMonth, sourceType: "bank_installment_reversal", sourceId: event.id }]);
  audit(state, ctx, "bank_installment_reversed", "bank_installment", event.id, before, event);
  return { bankInstallmentId: event.id, status: "reversed", reversalOperationId: ctx.operationId };
}

function closeMonth(state, ctx, force) {
  assertManager(ctx.actor); const key = ctx.payload.monthKey; let ms = state.monthStates.find((x) => x.id === key); if (!ms) { ms = { id: key, status: "open", closeVersion: 0, history: [] }; state.monthStates.push(ms); }
  if (!["open", "reopened"].includes(ms.status)) throw new Error("MONTH_NOT_OPEN");
  const pending = [...state.depositRequests, ...state.paymentIntents, ...state.custodyTransfers, ...state.requests].filter((x) => x.status === "pending" && (x.collectionMonth === key || x.monthKey === key));
  if (pending.length && !force) throw new Error(`MONTH_CLOSE_BLOCKED:${pending.map((x) => x.id).join(",")}`);
  ms.closeVersion += 1; ms.status = force ? "force_closed" : "closed"; const event = { version: ms.closeVersion, action: force ? "force_close" : "close", by: ctx.actor.id, at: nowIso(ctx), pendingSnapshot: pending.map((x) => x.id) }; ms.history.push(event);
  audit(state, ctx, event.action, "month", key, null, event); return { monthKey: key, status: ms.status, closeVersion: ms.closeVersion, pending: event.pendingSnapshot };
}

function reopenMonth(state, ctx) {
  assertManager(ctx.actor); const ms = get(state.monthStates, ctx.payload.monthKey, "MONTH_NOT_FOUND"); if (!["closed", "force_closed"].includes(ms.status)) throw new Error("MONTH_NOT_CLOSED"); if (!String(ctx.payload.reason || "").trim()) throw new Error("REASON_REQUIRED");
  ms.status = "reopened"; const event = { version: ms.closeVersion, action: "reopen", by: ctx.actor.id, at: nowIso(ctx), reason: ctx.payload.reason }; ms.history.push(event); audit(state, ctx, "month_reopened", "month", ms.id, null, event); return { monthKey: ms.id, status: ms.status };
}

function createReconstructionPlan(state,ctx){
  assertManager(ctx.actor);
  const monthKey=String(ctx.payload.monthKey||"");
  if(!/^\d{4}_\d{1,2}$/.test(monthKey))throw new Error("MONTH_KEY_INVALID");
  if((state.reconstructionPlans||[]).some(x=>x.monthKey===monthKey&&["DRAFT","ACTIVE"].includes(x.status)))throw new Error("RECONSTRUCTION_PLAN_EXISTS");
  const legacySnapshotHash=String(ctx.payload.legacySnapshotHash||"");
  if(!/^[a-f0-9]{64}$/.test(legacySnapshotHash))throw new Error("SOURCE_HASH_REQUIRED");
  const id=`reconstruction:${ctx.operationId}`;
  const reviewedObligations=(ctx.payload.reviewedObligations||[]).map(raw=>normalizeReviewedObligation(raw));
  if(new Set(reviewedObligations.map(x=>x.obligationId)).size!==reviewedObligations.length||new Set(reviewedObligations.map(x=>x.cycleId)).size!==reviewedObligations.length)throw new Error("DUPLICATE_RECONSTRUCTION_OBLIGATION");
  const requiredStructuralConfirmations=reviewedObligations.flatMap(x=>[`${x.obligationId}:tenant_identity`,`${x.obligationId}:due_date`]);
  const plan={id,monthKey,status:"DRAFT",authority:"CANONICAL_RECONSTRUCTION",legacyProjectionEffect:"evidence_only_zero",legacySnapshotHash,structuralSourceHash:String(ctx.payload.structuralSourceHash||legacySnapshotHash),reviewedObligations,requiredStructuralConfirmations,structuralConfirmations:[],structuralReviewStatus:requiredStructuralConfirmations.length?"PENDING":"APPROVED",preActivationApproved:false,freezeVerified:false,finalSourceHash:null,createdBy:ctx.actor.id,createdAt:nowIso(ctx),operationId:ctx.operationId};
  state.reconstructionPlans.push(plan);
  state.monthAuthorities.push({id:monthKey,monthKey,authority:"CANONICAL_RECONSTRUCTION",status:"STAGED",reconstructionPlanId:id,legacyProjectionEffect:"evidence_only_zero",activated:false});
  audit(state,ctx,"reconstruction_plan_created","reconstruction_plan",id,null,plan);
  return {reconstructionPlanId:id,status:plan.status,monthKey};
}

function normalizeReviewedObligation(raw){
  const obligationId=String(raw.obligationId||raw.id||"").trim();const cycleId=String(raw.cycleId||obligationId).trim();
  if(!obligationId||!cycleId)throw new Error("RECONSTRUCTION_OBLIGATION_ID_REQUIRED");
  const amountFils=Number(raw.contractualAmountFils);if(!Number.isSafeInteger(amountFils)||amountFils<0)throw new Error("CONTRACTUAL_AMOUNT_INVALID");
  const sourceReference=String(raw.sourceReference||"").trim();if(!sourceReference)throw new Error("STRUCTURAL_SOURCE_REFERENCE_REQUIRED");
  return {obligationId,cycleId,unitId:String(raw.unitId||""),partitionId:raw.partitionId==null?null:String(raw.partitionId),contractualAmountFils:amountFils,sourceReference,sourceRecordHash:String(raw.sourceRecordHash||""),sourceTenantIdentity:raw.sourceTenantIdentity?String(raw.sourceTenantIdentity):null,sourceDueDate:raw.sourceDueDate?String(raw.sourceDueDate):null,confirmedTenantIdentity:null,confirmedDueDate:null,tenantConfirmationStatus:"REQUIRED",dueDateConfirmationStatus:"REQUIRED",structuralStatus:"NEEDS_TENANT_AND_DUE_DATE_CONFIRMATION",planItemStatus:"REVIEWED"};
}

function addReconstructionObligation(state,ctx){
  assertManager(ctx.actor);const plan=get(state.reconstructionPlans,ctx.payload.reconstructionPlanId,"RECONSTRUCTION_PLAN_NOT_FOUND");
  if(plan.status!=="DRAFT")throw new Error("RECONSTRUCTION_PLAN_NOT_EDITABLE");
  const obligation=normalizeReviewedObligation(ctx.payload.obligation||ctx.payload);
  if((plan.reviewedObligations||[]).some(x=>x.obligationId===obligation.obligationId||x.cycleId===obligation.cycleId))throw new Error("DUPLICATE_RECONSTRUCTION_OBLIGATION");
  plan.reviewedObligations.push(obligation);plan.requiredStructuralConfirmations.push(`${obligation.obligationId}:tenant_identity`,`${obligation.obligationId}:due_date`);plan.structuralReviewStatus="PENDING";
  audit(state,ctx,"reconstruction_obligation_added","reconstruction_plan",plan.id,null,obligation);
  return {reconstructionPlanId:plan.id,obligationId:obligation.obligationId,cycleId:obligation.cycleId,status:obligation.structuralStatus};
}

function cancelReconstructionObligation(state,ctx){
  assertManager(ctx.actor);const plan=get(state.reconstructionPlans,ctx.payload.reconstructionPlanId,"RECONSTRUCTION_PLAN_NOT_FOUND");
  if(plan.status!=="DRAFT")throw new Error("RECONSTRUCTION_PLAN_NOT_EDITABLE");
  const obligation=(plan.reviewedObligations||[]).find(x=>x.obligationId===String(ctx.payload.obligationId||""));if(!obligation)throw new Error("RECONSTRUCTION_OBLIGATION_NOT_FOUND");
  if((state.cycles||[]).some(x=>x.id===obligation.cycleId&&!String(x.status||"").startsWith("cancelled")))throw new Error("MATERIALIZED_CYCLE_REQUIRES_CANONICAL_CANCELLATION");
  const before=clone(obligation);obligation.planItemStatus="CANCELLED";obligation.structuralStatus="CANCELLED";obligation.cancelledBy=ctx.actor.id;obligation.cancelledAt=nowIso(ctx);obligation.cancellationReason=String(ctx.payload.reason||"").trim();if(!obligation.cancellationReason)throw new Error("REASON_REQUIRED");
  const activeRequirements=(plan.reviewedObligations||[]).filter(x=>!["CANCELLED","HISTORICAL_EXCEPTION"].includes(x.planItemStatus)&&x.structuralStatus!=="CANCELLED").flatMap(x=>[`${x.obligationId}:tenant_identity`,`${x.obligationId}:due_date`]);plan.structuralReviewStatus=activeRequirements.every(id=>plan.structuralConfirmations.some(x=>x.itemId===id))?"APPROVED":"PENDING";
  audit(state,ctx,"reconstruction_obligation_cancelled","reconstruction_plan",plan.id,before,obligation);return {reconstructionPlanId:plan.id,obligationId:obligation.obligationId,status:"CANCELLED"};
}

function historicalExceptionTarget(plan,payload){
  const itemType=String(payload.itemType||"obligation");
  const itemId=String(payload.itemId||payload.obligationId||"").trim();
  if(!itemId)throw new Error("HISTORICAL_EXCEPTION_ITEM_REQUIRED");
  if(itemType==="obligation"){
    const item=(plan.reviewedObligations||[]).find(x=>x.obligationId===itemId);
    if(!item)throw new Error("RECONSTRUCTION_OBLIGATION_NOT_FOUND");
    return {itemType,item,itemId,evidenceReference:String(item.sourceReference||"").trim(),evidenceHash:String(item.sourceRecordHash||"").trim()};
  }
  if(itemType==="financial_candidate"){
    const item=(plan.historicalFinancialCandidates||[]).find(x=>String(x.id||x.candidateId)===itemId);
    if(!item)throw new Error("HISTORICAL_FINANCIAL_CANDIDATE_NOT_FOUND");
    return {itemType,item,itemId,evidenceReference:String(item.sourceReference||"").trim(),evidenceHash:String(item.sourceRecordHash||"").trim()};
  }
  throw new Error("HISTORICAL_EXCEPTION_ITEM_TYPE_INVALID");
}

function classifyHistoricalException(state,ctx){
  assertManager(ctx.actor);
  const plan=get(state.reconstructionPlans,ctx.payload.reconstructionPlanId,"RECONSTRUCTION_PLAN_NOT_FOUND");
  if(plan.status!=="DRAFT")throw new Error("RECONSTRUCTION_PLAN_NOT_EDITABLE");
  const target=historicalExceptionTarget(plan,ctx.payload);
  if(!target.evidenceReference)throw new Error("HISTORICAL_EXCEPTION_EVIDENCE_REFERENCE_REQUIRED");
  const reason=String(ctx.payload.reason||"").trim();if(!reason)throw new Error("HISTORICAL_EXCEPTION_REASON_REQUIRED");
  if(target.item.materializedCycleId||target.item.canonicalEventId)throw new Error("CANONICAL_REPRESENTATION_ALREADY_EXISTS");
  if(target.item.historicalException?.status==="HISTORICAL_EXCEPTION")throw new Error("HISTORICAL_EXCEPTION_ALREADY_DECIDED");
  const before=clone(target.item);
  const decision={status:"HISTORICAL_EXCEPTION",reason,decidedBy:ctx.actor.id,decidedAt:nowIso(ctx),reconstructionPlanId:plan.id,itemType:target.itemType,itemId:target.itemId,evidenceReference:target.evidenceReference,evidenceHash:target.evidenceHash||null,decisionOperationId:ctx.operationId,projectionEffect:"none",immutableEvidence:true};
  target.item.historicalException=decision;
  target.item.resolutionStatus="HISTORICAL_EXCEPTION";
  if(target.itemType==="obligation")target.item.planItemStatus="HISTORICAL_EXCEPTION";
  plan.historicalExceptionDecisions=plan.historicalExceptionDecisions||[];
  plan.historicalExceptionDecisions.push(decision);
  const activeRequirements=(plan.reviewedObligations||[]).filter(x=>!["CANCELLED","HISTORICAL_EXCEPTION"].includes(x.planItemStatus)&&x.structuralStatus!=="CANCELLED").flatMap(x=>[`${x.obligationId}:tenant_identity`,`${x.obligationId}:due_date`]);
  plan.structuralReviewStatus=activeRequirements.every(id=>(plan.structuralConfirmations||[]).some(x=>x.itemId===id))?"APPROVED":"PENDING";
  audit(state,ctx,"historical_exception_classified",target.itemType,target.itemId,before,target.item);
  return {reconstructionPlanId:plan.id,itemType:target.itemType,itemId:target.itemId,status:"HISTORICAL_EXCEPTION",projectionEffect:"none"};
}

function removeHistoricalException(state,ctx){
  assertManager(ctx.actor);
  const plan=get(state.reconstructionPlans,ctx.payload.reconstructionPlanId,"RECONSTRUCTION_PLAN_NOT_FOUND");
  if(plan.status!=="DRAFT")throw new Error("RECONSTRUCTION_PLAN_NOT_EDITABLE");
  const target=historicalExceptionTarget(plan,ctx.payload);
  if(target.item.historicalException?.status!=="HISTORICAL_EXCEPTION")throw new Error("HISTORICAL_EXCEPTION_NOT_FOUND");
  const reason=String(ctx.payload.reason||"").trim();if(!reason)throw new Error("HISTORICAL_EXCEPTION_REMOVAL_REASON_REQUIRED");
  const before=clone(target.item),prior=clone(target.item.historicalException);
  target.item.historicalException=null;
  target.item.resolutionStatus="UNRESOLVED";
  if(target.itemType==="obligation")target.item.planItemStatus=target.item.materializedCycleId?"MATERIALIZED":"REVIEWED";
  const removal={status:"HISTORICAL_EXCEPTION_REMOVED",reason,removedBy:ctx.actor.id,removedAt:nowIso(ctx),reconstructionPlanId:plan.id,itemType:target.itemType,itemId:target.itemId,evidenceReference:target.evidenceReference,priorDecisionOperationId:prior.decisionOperationId,operationId:ctx.operationId};
  plan.historicalExceptionDecisions=plan.historicalExceptionDecisions||[];
  plan.historicalExceptionDecisions.push(removal);
  const activeRequirements=(plan.reviewedObligations||[]).filter(x=>!["CANCELLED","HISTORICAL_EXCEPTION"].includes(x.planItemStatus)&&x.structuralStatus!=="CANCELLED").flatMap(x=>[`${x.obligationId}:tenant_identity`,`${x.obligationId}:due_date`]);
  plan.structuralReviewStatus=activeRequirements.every(id=>(plan.structuralConfirmations||[]).some(x=>x.itemId===id))?"APPROVED":"PENDING";
  audit(state,ctx,"historical_exception_removed",target.itemType,target.itemId,before,target.item);
  return {reconstructionPlanId:plan.id,itemType:target.itemType,itemId:target.itemId,status:"UNRESOLVED"};
}

function linkReconstructionObligationStructure(state,ctx){
  assertManager(ctx.actor);const plan=get(state.reconstructionPlans,ctx.payload.reconstructionPlanId,"RECONSTRUCTION_PLAN_NOT_FOUND");
  if(plan.status!=="DRAFT")throw new Error("RECONSTRUCTION_PLAN_NOT_EDITABLE");
  const obligation=(plan.reviewedObligations||[]).find(x=>x.obligationId===String(ctx.payload.obligationId||""));if(!obligation)throw new Error("RECONSTRUCTION_OBLIGATION_NOT_FOUND");
  if(obligation.planItemStatus==="CANCELLED")throw new Error("RECONSTRUCTION_OBLIGATION_CANCELLED");
  const before=clone(obligation);for(const key of ["propertyId","unitId","spaceId","tenantId","tenancyId"]){const value=String(ctx.payload[key]||"").trim();if(!value)throw new Error(`CANONICAL_${key.toUpperCase()}_REQUIRED`);obligation[`canonical${key[0].toUpperCase()}${key.slice(1)}`]=value;}
  obligation.canonicalStructureStatus="LINKED";obligation.canonicalStructureLinkedBy=ctx.actor.id;obligation.canonicalStructureLinkedAt=nowIso(ctx);obligation.canonicalStructureSourceReference=String(ctx.payload.sourceReference||"").trim();if(!obligation.canonicalStructureSourceReference)throw new Error("STRUCTURAL_SOURCE_REFERENCE_REQUIRED");
  audit(state,ctx,"reconstruction_structure_linked","reconstruction_plan",plan.id,before,obligation);return {reconstructionPlanId:plan.id,obligationId:obligation.obligationId,status:"LINKED"};
}

function materializeReconstructionCycles(state,ctx){
  assertManager(ctx.actor);const plan=get(state.reconstructionPlans,ctx.payload.reconstructionPlanId,"RECONSTRUCTION_PLAN_NOT_FOUND");
  if(plan.status!=="DRAFT")throw new Error("RECONSTRUCTION_PLAN_NOT_EDITABLE");
  const materialized=[],skipped=[],blocked=[];
  for(const obligation of plan.reviewedObligations||[]){
    if(obligation.planItemStatus==="CANCELLED"||obligation.structuralStatus==="CANCELLED"){skipped.push({obligationId:obligation.obligationId,reason:"CANCELLED"});continue;}
    if(obligation.planItemStatus==="HISTORICAL_EXCEPTION"||obligation.historicalException?.status==="HISTORICAL_EXCEPTION"){skipped.push({obligationId:obligation.obligationId,reason:"HISTORICAL_EXCEPTION"});continue;}
    if(obligation.structuralStatus!=="READY_FOR_RECONSTRUCTION"){blocked.push({obligationId:obligation.obligationId,reason:"STRUCTURAL_CONFIRMATION_REQUIRED"});continue;}
    if(obligation.canonicalStructureStatus!=="LINKED"){blocked.push({obligationId:obligation.obligationId,reason:"CANONICAL_STRUCTURE_LINK_REQUIRED"});continue;}
    const existing=(state.cycles||[]).find(x=>x.id===obligation.cycleId);
    if(existing){if(existing.reconstructionPlanId===plan.id&&existing.sourceObligationId===obligation.obligationId){skipped.push({obligationId:obligation.obligationId,cycleId:existing.id,reason:"ALREADY_MATERIALIZED"});continue;}throw new Error(`CANONICAL_CYCLE_CONFLICT:${obligation.cycleId}`);}
    const cycle={id:obligation.cycleId,propertyId:obligation.canonicalPropertyId,unitId:obligation.canonicalUnitId,spaceId:obligation.canonicalSpaceId,partitionId:obligation.canonicalSpaceId,tenantId:obligation.canonicalTenantId,tenant:obligation.confirmedTenantIdentity,tenancyId:obligation.canonicalTenancyId,baseAmountFils:obligation.contractualAmountFils,reportingMonth:plan.monthKey,dueDate:obligation.confirmedDueDate,status:"open",financialVersion:0,origin:"reconstruction",reconstructionPlanId:plan.id,sourceObligationId:obligation.obligationId,sourceReference:obligation.sourceReference,sourceRecordHash:obligation.sourceRecordHash,materializedBy:ctx.actor.id,materializedAt:nowIso(ctx),materializationOperationId:ctx.operationId};
    state.cycles.push(cycle);obligation.materializedCycleId=cycle.id;obligation.materializedAt=cycle.materializedAt;obligation.planItemStatus="MATERIALIZED";materialized.push({obligationId:obligation.obligationId,cycleId:cycle.id});audit(state,ctx,`reconstruction_cycle_materialized:${obligation.obligationId}`,"rental_cycle",cycle.id,null,cycle);
  }
  return {reconstructionPlanId:plan.id,materialized,skipped,blocked,totalPlanObligations:(plan.reviewedObligations||[]).length};
}

function createRentalCycle(state,ctx){
  assertManager(ctx.actor);const p=ctx.payload;const id=String(p.cycleId||p.id||"").trim();if(!id)throw new Error("CYCLE_ID_REQUIRED");if((state.cycles||[]).some(x=>x.id===id))throw new Error("CANONICAL_CYCLE_CONFLICT");
  const amountFils=Number(p.contractualAmountFils??p.baseAmountFils);if(!Number.isSafeInteger(amountFils)||amountFils<0)throw new Error("CONTRACTUAL_AMOUNT_INVALID");const monthKey=String(p.reportingMonth||"");if(!/^\d{4}_\d{1,2}$/.test(monthKey))throw new Error("MONTH_KEY_INVALID");if(!/^\d{4}-\d{2}-\d{2}$/.test(String(p.dueDate||"")))throw new Error("DUE_DATE_INVALID");
  const cycle={id,tenancyId:String(p.tenancyId||id),tenantId:p.tenantId?String(p.tenantId):null,tenant:p.tenant?String(p.tenant):null,unitId:String(p.unitId||""),partitionId:p.partitionId==null?null:String(p.partitionId),baseAmountFils:amountFils,reportingMonth:monthKey,dueDate:String(p.dueDate),status:"open",financialVersion:0,origin:"normal",sourceReference:String(p.sourceReference||""),createdBy:ctx.actor.id,createdAt:nowIso(ctx),operationId:ctx.operationId};state.cycles.push(cycle);audit(state,ctx,"rental_cycle_created","rental_cycle",id,null,cycle);return {cycleId:id,origin:"normal"};
}

function confirmReconstructionStructure(state,ctx){
  const plan=get(state.reconstructionPlans,ctx.payload.reconstructionPlanId,"RECONSTRUCTION_PLAN_NOT_FOUND");
  if(plan.status!=="DRAFT")throw new Error("RECONSTRUCTION_PLAN_NOT_EDITABLE");
  const confirmationType=String(ctx.payload.confirmationType||"");
  if(!["tenant_identity","due_date"].includes(confirmationType))throw new Error("STRUCTURAL_CONFIRMATION_TYPE_INVALID");
  const obligationId=String(ctx.payload.obligationId||"").trim();
  const itemId=`${obligationId}:${confirmationType}`;
  if(!plan.requiredStructuralConfirmations.includes(itemId))throw new Error("STRUCTURAL_CONFIRMATION_NOT_REQUIRED");
  const obligation=(plan.reviewedObligations||[]).find(x=>x.obligationId===obligationId);if(!obligation)throw new Error("RECONSTRUCTION_OBLIGATION_NOT_FOUND");
  if(obligation.planItemStatus==="CANCELLED"||obligation.structuralStatus==="CANCELLED")throw new Error("RECONSTRUCTION_OBLIGATION_CANCELLED");
  if(obligation.planItemStatus==="HISTORICAL_EXCEPTION"||obligation.historicalException?.status==="HISTORICAL_EXCEPTION")throw new Error("HISTORICAL_EXCEPTION_MUST_BE_REMOVED_FIRST");
  const value=String(ctx.payload.confirmedValue||"").trim();if(!value)throw new Error("STRUCTURAL_CONFIRMED_VALUE_REQUIRED");
  if(confirmationType==="due_date"&&!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error("DUE_DATE_INVALID");
  const basis=String(ctx.payload.confirmationBasis||ctx.payload.sourceReference||"").trim();if(!basis)throw new Error("CONFIRMATION_BASIS_REQUIRED");
  if((plan.structuralConfirmations||[]).some(x=>x.itemId===itemId))throw new Error("STRUCTURAL_CONFIRMATION_ALREADY_RECORDED");
  const confirmation={itemId,obligationId,unitId:obligation.unitId,partitionId:obligation.partitionId,confirmationType,previousUnresolvedState:confirmationType==="tenant_identity"?obligation.sourceTenantIdentity:obligation.sourceDueDate,confirmedValue:value,sourceReference:obligation.sourceReference,confirmationBasis:basis,reconstructionScope:plan.monthKey,confirmedBy:ctx.actor.id,confirmedAt:nowIso(ctx),operationId:ctx.operationId};
  plan.structuralConfirmations.push(confirmation);
  if(confirmationType==="tenant_identity"){obligation.confirmedTenantIdentity=value;obligation.tenantConfirmationStatus="CONFIRMED";}else{obligation.confirmedDueDate=value;obligation.dueDateConfirmationStatus="CONFIRMED";}
  obligation.structuralStatus=obligation.tenantConfirmationStatus==="CONFIRMED"&&obligation.dueDateConfirmationStatus==="CONFIRMED"?"READY_FOR_RECONSTRUCTION":obligation.tenantConfirmationStatus==="CONFIRMED"?"NEEDS_DUE_DATE_CONFIRMATION":"NEEDS_TENANT_CONFIRMATION";
  const activeRequirements=(plan.reviewedObligations||[]).filter(x=>!["CANCELLED","HISTORICAL_EXCEPTION"].includes(x.planItemStatus)&&x.structuralStatus!=="CANCELLED").flatMap(x=>[`${x.obligationId}:tenant_identity`,`${x.obligationId}:due_date`]);
  plan.structuralReviewStatus=activeRequirements.every(id=>plan.structuralConfirmations.some(x=>x.itemId===id))?"APPROVED":"PENDING";
  audit(state,ctx,"reconstruction_structure_confirmed","reconstruction_plan",plan.id,null,confirmation);
  return {reconstructionPlanId:plan.id,itemId,structuralReviewStatus:plan.structuralReviewStatus};
}

function activateReconstructionPlan(state,ctx){
  assertManager(ctx.actor);
  const plan=get(state.reconstructionPlans,ctx.payload.reconstructionPlanId,"RECONSTRUCTION_PLAN_NOT_FOUND");
  if(plan.status!=="DRAFT")throw new Error("RECONSTRUCTION_PLAN_NOT_ACTIVATABLE");
  const check=reconstructionCompletenessAudit(state,plan.id);
  if(!check.complete)throw new Error(`RECONSTRUCTION_INCOMPLETE:${check.blockers.join("|")}`);
  const before=clone(plan);plan.status="ACTIVE";plan.activated=true;plan.activatedBy=ctx.actor.id;plan.activatedAt=nowIso(ctx);
  const authority=get(state.monthAuthorities,plan.monthKey,"MONTH_AUTHORITY_NOT_FOUND");authority.status="ACTIVE";authority.activated=true;authority.activatedAt=nowIso(ctx);authority.activatedBy=ctx.actor.id;
  audit(state,ctx,"reconstruction_plan_activated","reconstruction_plan",plan.id,before,plan);
  return {reconstructionPlanId:plan.id,status:"ACTIVE",audit:check};
}

function cancelReconstructionPlan(state,ctx){
  assertManager(ctx.actor);const plan=get(state.reconstructionPlans,ctx.payload.reconstructionPlanId,"RECONSTRUCTION_PLAN_NOT_FOUND");
  if(plan.status!=="DRAFT")throw new Error("RECONSTRUCTION_PLAN_NOT_CANCELLABLE");
  const before=clone(plan);plan.status="CANCELLED";plan.cancelledAt=nowIso(ctx);plan.cancelledBy=ctx.actor.id;
  const authority=state.monthAuthorities.find(x=>x.reconstructionPlanId===plan.id);if(authority){authority.status="CANCELLED";authority.activated=false;}
  audit(state,ctx,"reconstruction_plan_cancelled","reconstruction_plan",plan.id,before,plan);return {reconstructionPlanId:plan.id,status:"CANCELLED"};
}

function abandonReconstructionAndActivate(state,ctx){
  assertManager(ctx.actor);
  const plan=get(state.reconstructionPlans,ctx.payload.reconstructionPlanId,"RECONSTRUCTION_PLAN_NOT_FOUND");
  if(plan.status!=="DRAFT")throw new Error("RECONSTRUCTION_PLAN_NOT_ABANDONABLE");
  const reason=String(ctx.payload.reason||"").trim();if(!reason)throw new Error("OWNER_ABANDONMENT_REASON_REQUIRED");
  const expectedBuildId=String(ctx.payload.expectedBuildId||"").trim();if(!expectedBuildId)throw new Error("EXPECTED_BUILD_ID_REQUIRED");
  const inventory=state.cleanStartInventory||{};
  if(Number(inventory.properties||0)<1||Number(inventory.units||0)<1||Number(inventory.rentableSpaces||0)<1)throw new Error("CANONICAL_STRUCTURE_REQUIRED");
  if(Number(inventory.tenants||0)!==0||Number(inventory.tenancies||0)!==0)throw new Error("CLEAN_START_OCCUPANCY_NOT_EMPTY");
  const month=plan.monthKey;
  const monthEntities=[
    ["cycles","reportingMonth"],["allocations","collectionMonth"],["paymentIntents","collectionMonth"],["collectionEvents","collectionMonth"],
    ["cashLots","collectionMonth"],["depositRequests","monthKey"],["custodyTransfers","monthKey"],["expenses","monthKey"],
    ["externalRevenues","effectiveMonth"],["ownerProfitDistributions","effectiveMonth"],["balanceTransfers","effectiveMonth"],
    ["adjustments","effectiveMonth"],["installments","effectiveMonth"],["installmentObligations","effectiveMonth"],
    ["legacyFinancialCorrections","effectiveMonth"],["dailyBookings","collectionMonth"],["ledger","effectiveMonth"]
  ];
  const present=monthEntities.flatMap(([key,field])=>(state[key]||[]).filter(x=>String(x[field]||"")===month).map(x=>`${key}:${x.id}`));
  if(present.length)throw new Error(`CLEAN_START_CANONICAL_MONTH_NOT_EMPTY:${present.join(",")}`);
  const beforePlan=clone(plan),beforeAuthority=clone(get(state.monthAuthorities,month,"MONTH_AUTHORITY_NOT_FOUND"));
  plan.status="ABANDONED";plan.abandonmentMode="OWNER_CLEAN_START";plan.abandonmentReason=reason;plan.abandonedBy=ctx.actor.id;plan.abandonedAt=nowIso(ctx);plan.abandonmentOperationId=ctx.operationId;plan.canonicalRepresentationEffect="none";
  const authority=get(state.monthAuthorities,month,"MONTH_AUTHORITY_NOT_FOUND");
  authority.authority="CANONICAL_CLEAN_START";authority.status="ACTIVE";authority.activated=true;authority.activatedAt=nowIso(ctx);authority.activatedBy=ctx.actor.id;authority.legacyProjectionEffect="evidence_only_zero";authority.cleanStartFromZero=true;authority.abandonedReconstructionPlanId=plan.id;authority.activationOperationId=ctx.operationId;
  state.financialTruthVersion=3;
  state.canonicalControl={state:"CANONICAL_ACTIVE",version:Number(state.canonicalControl?.version||0)+1,changedBy:ctx.actor.id,changedAt:nowIso(ctx),activationMode:"OWNER_CLEAN_START",monthKey:month,operationId:ctx.operationId,buildId:expectedBuildId};
  const decision={reason,monthKey:month,reconstructionPlanId:plan.id,legacyProjectionEffect:"evidence_only_zero",canonicalMonthStartsEmpty:true,structurePreserved:true,financialTruthVersion:3,buildId:expectedBuildId};
  audit(state,ctx,"reconstruction_abandoned_clean_start_activated","reconstruction_plan",plan.id,{plan:beforePlan,authority:beforeAuthority},{plan,authority,decision});
  return {reconstructionPlanId:plan.id,status:"ABANDONED",monthKey:month,gate:"CANONICAL_ACTIVE",financialTruthVersion:3,authority:"CANONICAL_CLEAN_START",legacyProjectionEffect:"evidence_only_zero",canonicalMonthStartsEmpty:true};
}


// ===== دخول بيانات الإيجار الحالية بواسطة الموظف =====
// الموظف يفتح مساحة قائمة ويُدخل الواقع الحالي. لا استيراد من Legacy،
// ولا اختراع لأي قيمة، ولا أي أثر مالي — إنشاء التزام تعاقدي فقط.
// معرّفات المستأجر/العقد/الدورة تُولَّد حتمياً من معرّف المساحة والشهر،
// فإعادة الحفظ تُحدِّث نفس السجلات ولا تُنشئ نسخاً مكررة.
function setSpaceRental(state, ctx) {
  assertEmployeeOrManager(ctx.actor);
  const p = ctx.payload;
  const spaceId = String(p.spaceId || "").trim();
  if (!spaceId) throw new Error("SPACE_ID_REQUIRED");
  const monthKey = String(p.reportingMonth || "").trim();
  if (!/^\d{4}_\d{1,2}$/.test(monthKey)) throw new Error("MONTH_KEY_INVALID");
  const space = (state.rentableSpaces || []).find((x) => x.id === spaceId);
  if (!space) throw new Error("RENTABLE_SPACE_NOT_FOUND");

  const occupancy = String(p.occupancy || "").trim();
  if (!["occupied", "vacant"].includes(occupancy)) throw new Error("OCCUPANCY_INVALID");

  const tenancyId = `tenancy:${spaceId}`;
  const cycleId   = `cycle:${spaceId}:${monthKey}`;
  const tenantId  = `tenant:${spaceId}`;
  const existingCycle = (state.cycles || []).find((x) => x.id === cycleId);

  // الدورة التي سبق أن تأثرت مالياً لا تُعدَّل من مسار دخول البيانات
  if (existingCycle && Number(existingCycle.financialVersion || 0) > 0) throw new Error("CYCLE_HAS_FINANCIAL_ACTIVITY");

  const before = existingCycle ? clone(existingCycle) : null;

  if (occupancy === "vacant") {
    space.occupancy = "vacant"; space.updatedBy = ctx.actor.id; space.updatedAt = nowIso(ctx);
    if (existingCycle) { existingCycle.status = "cancelled"; existingCycle.cancelledBy = ctx.actor.id; existingCycle.cancelledAt = nowIso(ctx); }
    const ten = (state.tenancies || []).find((x) => x.id === tenancyId);
    if (ten) ten.status = "ended";
    audit(state, ctx, "space_marked_vacant", "rentable_space", spaceId, before, { spaceId, occupancy: "vacant" });
    return { spaceId, occupancy: "vacant", cycleId: null };
  }

  // مشغولة — الحقول التعاقدية إلزامية ويُدخلها الموظف
  const amountFils = Number(p.contractualAmountFils);
  if (!Number.isSafeInteger(amountFils) || amountFils <= 0) throw new Error("CONTRACTUAL_AMOUNT_INVALID");
  const dueDate = String(p.dueDate || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) throw new Error("DUE_DATE_INVALID");
  const startDate = String(p.startDate || dueDate).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new Error("START_DATE_INVALID");

  // الاسم المجهول لا يوقف العمل — يُوسم unresolved ويظل قابلاً للتصحيح
  const rawName = String(p.tenantName || "").trim();
  const unresolved = rawName.length === 0;
  const tenantName = unresolved ? `ساكن غير محدد — ${space.label || spaceId}` : rawName;
  const phone = String(p.tenantPhone || "").trim();

  state.tenants = state.tenants || []; state.tenancies = state.tenancies || [];
  let tenant = state.tenants.find((x) => x.id === tenantId);
  if (!tenant) { tenant = { id: tenantId, createdBy: ctx.actor.id, createdAt: nowIso(ctx) }; state.tenants.push(tenant); }
  tenant.name = tenantName; tenant.phone = phone;
  tenant.identityStatus = unresolved ? "unresolved" : "confirmed";
  tenant.updatedBy = ctx.actor.id; tenant.updatedAt = nowIso(ctx);

  let tenancy = state.tenancies.find((x) => x.id === tenancyId);
  if (!tenancy) { tenancy = { id: tenancyId, spaceId, unitId: space.unitId || null, propertyId: space.propertyId || null, createdBy: ctx.actor.id, createdAt: nowIso(ctx) }; state.tenancies.push(tenancy); }
  tenancy.tenantId = tenantId; tenancy.startDate = startDate; tenancy.status = "active";
  tenancy.updatedBy = ctx.actor.id; tenancy.updatedAt = nowIso(ctx);

  space.occupancy = "occupied"; space.updatedBy = ctx.actor.id; space.updatedAt = nowIso(ctx);

  if (existingCycle) {
    existingCycle.baseAmountFils = amountFils; existingCycle.dueDate = dueDate;
    existingCycle.tenantId = tenantId; existingCycle.tenant = tenantName;
    existingCycle.tenancyId = tenancyId; existingCycle.status = "open";
    existingCycle.updatedBy = ctx.actor.id; existingCycle.updatedAt = nowIso(ctx);
    audit(state, ctx, "space_rental_updated", "rental_cycle", cycleId, before, existingCycle);
  } else {
    const cycle = { id: cycleId, tenancyId, tenantId, tenant: tenantName,
      propertyId: space.propertyId || null, unitId: space.unitId || null,
      spaceId, partitionId: space.partitionId == null ? null : String(space.partitionId),
      baseAmountFils: amountFils, reportingMonth: monthKey, dueDate,
      status: "open", financialVersion: 0, origin: "employee_rental_entry",
      unresolvedTenantIdentity: unresolved,
      createdBy: ctx.actor.id, createdAt: nowIso(ctx), operationId: ctx.operationId };
    state.cycles.push(cycle);
    audit(state, ctx, "space_rental_entered", "rental_cycle", cycleId, null, cycle);
  }
  return { spaceId, occupancy: "occupied", cycleId, unresolvedTenantIdentity: unresolved };
}

// تصحيح تاريخ الاستحقاق — للمدير فقط، بسبب إلزامي وسجل تدقيق
function correctCycleDueDate(state, ctx) {
  assertManager(ctx.actor);
  const cycle = get(state.cycles, ctx.payload.cycleId, "CYCLE_NOT_FOUND");
  const newDue = String(ctx.payload.dueDate || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(newDue)) throw new Error("DUE_DATE_INVALID");
  const reason = String(ctx.payload.reason || "").trim();
  if (!reason) throw new Error("REASON_REQUIRED");
  const before = clone(cycle);
  cycle.previousDueDate = cycle.dueDate; cycle.dueDate = newDue;
  cycle.dueDateHistory = [...(cycle.dueDateHistory || []),
    { from: before.dueDate, to: newDue, reason, by: ctx.actor.id, at: nowIso(ctx), operationId: ctx.operationId }];
  audit(state, ctx, "cycle_due_date_corrected", "rental_cycle", cycle.id, before, cycle);
  return { cycleId: cycle.id, dueDate: newDue };
}

// إلغاء إيداع — لا حذف فعلي. المعتمد يُعكس أثره مرة واحدة، والمعلّق يُلغى بلا عكس.
function cancelDeposit(state, ctx) {
  assertManager(ctx.actor);
  const request = get(state.depositRequests, ctx.payload.depositRequestId, "DEPOSIT_NOT_FOUND");
  const reason = String(ctx.payload.reason || "").trim();
  if (!reason) throw new Error("REASON_REQUIRED");
  if (["cancelled", "reversed", "rejected", "withdrawn"].includes(request.status)) throw new Error("DEPOSIT_ALREADY_CANCELLED");
  const before = clone(request);

  if (request.status === "pending") {
    request.status = "cancelled"; request.cancelledBy = ctx.actor.id; request.cancelledAt = nowIso(ctx);
    request.cancellationReason = reason; request.cancellationOperationId = ctx.operationId;
    audit(state, ctx, "deposit_cancelled_pending", "deposit", request.id, before, request);
    return { depositRequestId: request.id, status: "cancelled", reversedFils: 0 };
  }
  if (request.status !== "approved") throw new Error("DEPOSIT_NOT_CANCELLABLE");

  // عكس أثر الإيداع المعتمد مرة واحدة بالضبط
  let totalFils = 0;
  for (const [index, line] of request.allocations.entries()) {
    const lot = get(state.cashLots, line.cashLotId, "CASH_LOT_NOT_FOUND");
    state.cashMovements.push({ id: `cashmove:${ctx.operationId}:rev:${index}`, cashLotId: lot.id,
      type: "deposit_reversal", status: "active", amountFils: line.amountFils,
      toHolder: lot.currentHolder, sourceOperationId: ctx.operationId,
      reversalOf: request.id, at: nowIso(ctx) });
    const alloc = state.allocations.find((x) => x.paymentId === lot.originPaymentId);
    if (alloc) {
      const settledBefore = Number(alloc.settledAmountFils || 0);
      const nextSettled = settledBefore - line.amountFils;
      if (nextSettled < 0) throw new Error("SETTLEMENT_OVER_REVERSAL");
      alloc.settledAmountFils = nextSettled;
      alloc.settlementStatus = nextSettled === 0 ? "unsettled"
        : nextSettled === alloc.amountFils ? "settled" : "partially_settled";
    }
    totalFils += line.amountFils;
  }
  changeBalance(state, "revenue", -totalFils);
  const grouped = new Map();
  for (const line of request.allocations) {
    const lot = get(state.cashLots, line.cashLotId);
    grouped.set(lot.collectionMonth, (grouped.get(lot.collectionMonth) || 0) + line.amountFils);
  }
  ledger(state, ctx, [...grouped].map(([effectiveMonth, amountFils]) => ({
    account: "revenue", direction: "debit", amountFils, effectiveMonth,
    sourceType: "cash_deposit_reversal", sourceId: request.id })));

  request.status = "reversed"; request.cancelledBy = ctx.actor.id; request.cancelledAt = nowIso(ctx);
  request.cancellationReason = reason; request.reversalOperationId = ctx.operationId;
  request.reversedAmountFils = totalFils;
  audit(state, ctx, "deposit_reversed", "deposit", request.id, before, request);
  return { depositRequestId: request.id, status: "reversed", reversedFils: totalFils };
}

const HANDLERS = {
  createCashReceipt, createBankPayment, approveBankPayment, cancelPayment, correctPayment,
  createDepositRequest, editDepositRequest, rejectDeposit, withdrawDeposit, approveDeposit, cancelDeposit,
  ensureCompatibleCycle, setSpaceRental, correctCycleDueDate,
  createCustodyTransfer, confirmCustodyTransfer, rejectCustodyTransfer, reverseCustodyTransfer,
  requestDiscount, approveDiscountRequest, approveDiscount, reverseDiscount,
  createDailyBooking, refundDailyBooking,
  requestEviction, approveEvictionRequest, approveEviction, refundPayment,
  transferBalance, reverseBalanceTransfer, createInstallmentReserveTransfer, reverseInstallmentReserveTransfer,
  requestExpense, approveExpense, executeExpense, reverseExpense,
  recordExternalRevenue, reverseExternalRevenue, createOwnerProfitDistribution, reverseOwnerProfitDistribution,
  adjustInstallmentObligation, createLegacyFinancialCorrection,
  adjustBalance, reverseAdjustment, payInstallment, reverseInstallment,
  createBankInstallmentPayment, reverseBankInstallmentPayment,
  createReconstructionPlan, addReconstructionObligation, cancelReconstructionObligation, linkReconstructionObligationStructure, confirmReconstructionStructure, classifyHistoricalException, removeHistoricalException, materializeReconstructionCycles, activateReconstructionPlan, cancelReconstructionPlan, abandonReconstructionAndActivate, createRentalCycle,
  closeMonth: (s, c) => closeMonth(s, c, false), forceCloseMonth: (s, c) => closeMonth(s, c, true), reopenMonth,
};

export function executeCommand(inputState, command, ctx) {
  if (!HANDLERS[command]) throw new Error("UNKNOWN_COMMAND");
  const state = clone(inputState); const start = operationStart(state, ctx, command);
  if (start.replay) return { state, result: start.result, replay: true };
  const reconstructionMeta=prepareReconstructionCommand(state,command,ctx);
  const beforeLengths=Object.fromEntries(Object.entries(state).filter(([,v])=>Array.isArray(v)).map(([k,v])=>[k,v.length]));
  const result = HANDLERS[command](state, ctx);
  attachReconstructionLineage(state,beforeLengths,ctx,reconstructionMeta);
  assertStateInvariants(state);
  operationComplete(state, ctx, result);
  return { state, result, replay: false };
}
