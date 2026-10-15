/**
 * QAMA — command layer.
 *
 * Every mutation in the system passes through executeCommand. There is no other write path:
 * Firestore Rules deny all client writes, so the only way money can change is a command that
 * has passed identity, role, schema, idempotency and transaction checks here.
 *
 * The database handle is injected, so this exact code runs under the Firebase Admin SDK in
 * production and under the test harness in tests. The layer under test is the layer shipped.
 */

import {
  DomainError, RECEIPT_STATE, APPROVAL_STATE, OCCUPANCY, METHOD,
  assertReceiptFits, assertDepositFitsCustody, assertCashReversalFitsSharedHolding,
  assertCashAdjustmentFitsSharedHolding,
  periodOf, dueDateFor, obligationIdFor, depositSourcePeriod,
  assertPositiveFils, isFils, isPlaceholderTenant, parseAedToFils,
  rentalCoversPeriod, isObligationAfterTenancyEnd, findPeriodCoverageConflict,
} from "../domain/finance.mjs";
import {
  buildCycleFields, nextCycleStart, renewButtonVisible, assertIsoDate,
  cyclePeriod,
} from "../domain/rental_cycle.mjs";
import { commitWorkRequestFlow } from "./commit_work_request.mjs";
import { reviewPeriodClose } from "../domain/closing_review.mjs";

/**
 * Cancel unpaid obligations that fall AFTER the vacancy effective date.
 * Past-month (historically covered) unpaid obligations stay frozen — never
 * rewrite September when vacating in October.
 */
async function cancelUnpaidObligationsForRental(
  ctx, rentalId, reason, { ignoreReceiptIds = [], endDate = null, rental = null } = {},
) {
  const skip = new Set(ignoreReceiptIds || []);
  const vacateDay = String(endDate || ctx.now.slice(0, 10)).slice(0, 10);
  const obligations = await ctx.tx.query("obligations", [["rentalId", "==", rentalId]]);
  const rentalDoc = rental || await ctx.tx.get("rentals", rentalId);
  const cancelled = [];
  for (const ob of obligations) {
    if (ob.state !== "active") continue;
    const receipts = await ctx.tx.query("receipts", [["obligationId", "==", ob.id]]);
    const live = receipts.filter(
      (r) =>
        !skip.has(r.id) &&
        (r.state === RECEIPT_STATE.RECOGNIZED || r.state === RECEIPT_STATE.PENDING),
    );
    if (live.length) continue;
    const due = String(ob.dueDate || `${ob.period || "9999-99"}-01`).slice(0, 10);
    const obPeriod = ob.period || periodOf(due);
    // Preserve historical months covered by this rental before vacancy.
    const covered = rentalDoc
      ? rentalCoversPeriod({ ...rentalDoc, endDate: vacateDay }, obPeriod)
      : due <= vacateDay;
    if (covered && due <= vacateDay) {
      // Past/current-due unpaid: freeze as historical — do not cancel.
      ctx.tx.update("obligations", ob.id, {
        frozenHistoricalObligation: true,
        frozenAtVacateOn: vacateDay,
      });
      continue;
    }
    // Future unpaid after vacancy effective date → cancel (not Target/Holding).
    ctx.tx.update("obligations", ob.id, {
      state: "cancelled",
      cancelledBy: ctx.actor.userId,
      cancelledAt: ctx.now,
      cancelReason: reason,
      cancelledAsFutureUnpaidOnVacate: due > vacateDay,
    });
    cancelled.push(ob.id);
  }
  return cancelled;
}

/**
 * Reverse every recognized receipt on a rental (idempotent per operationId+receiptId).
 * Used only when reverseLiveMoney:true (legacy/emergency). Normal إخلاء keeps receipts;
 * إلغاء تحصيل uses uncollectObligation / reverseReceipt.
 */
async function reverseLiveReceiptsForRental(ctx, rentalId, reason) {
  const obligations = await ctx.tx.query("obligations", [["rentalId", "==", rentalId]]);
  const toReverse = [];
  for (const ob of obligations) {
    const receipts = await ctx.tx.query("receipts", [["obligationId", "==", ob.id]]);
    for (const r of receipts) {
      if (r.state === RECEIPT_STATE.RECOGNIZED) toReverse.push(r);
    }
  }
  if (!toReverse.length) return { reversedReceiptIds: [], reversalIds: [] };

  const cashLive = toReverse.filter((r) => r.method === "cash");
  if (cashLive.length) {
    const allReceipts = await ctx.tx.query("receipts", []);
    const allDeposits = await ctx.tx.query("deposits", []);
    assertCashReversalFitsSharedHolding({
      receipts: allReceipts,
      deposits: allDeposits,
      reversingReceiptIds: cashLive.map((r) => r.id),
    });
  }

  const reversedReceiptIds = [];
  const reversalIds = [];
  for (const receipt of toReverse) {
    const reversalId = `rev:${ctx.operationId}:${receipt.id}`.slice(0, 140);
    if (await ctx.tx.get("reversals", reversalId)) {
      // Same operation replay — treat as already applied.
      if (receipt.state !== RECEIPT_STATE.REVERSED) {
        ctx.tx.update("receipts", receipt.id, {
          state: RECEIPT_STATE.REVERSED, reversedByReversalId: reversalId, reversedAt: ctx.now,
        });
      }
      reversedReceiptIds.push(receipt.id);
      reversalIds.push(reversalId);
      continue;
    }
    if (receipt.state === RECEIPT_STATE.REVERSED) continue;

    ctx.tx.create("reversals", reversalId, {
      id: reversalId, targetType: "receipt", targetId: receipt.id,
      amountFils: receipt.amountFils, reason, ...base(ctx),
    });
    ctx.tx.update("receipts", receipt.id, {
      state: RECEIPT_STATE.REVERSED, reversedByReversalId: reversalId, reversedAt: ctx.now,
    });
    if (receipt.method === "bank") {
      await debitRevenueAccount(ctx, {
        amountFils: receipt.amountFils,
        sourceType: "bank_receipt",
        sourceId: receipt.id,
        note: reason,
      });
    }
    audit(ctx, "receipt_reversed", "receipt", receipt.id, {
      amountFils: receipt.amountFils, reason, reversalId, via: "close_rental",
    });
    reversedReceiptIds.push(receipt.id);
    reversalIds.push(reversalId);
  }
  return { reversedReceiptIds, reversalIds };
}

/** Close an active rental. By default does NOT reverse live receipts (إخلاء ≠ إلغاء تحصيل).
 *  Pass reverseLiveMoney:true only for legacy emergency paths — prefer uncollectObligation. */
/**
 * Staff occupancy: from the staff month forward, unpaid rent is not an arrears
 * balance. Recognized receipts are never reversed or deleted. Months before the
 * staff effective period stay as historical rented money.
 * Each obligation is written at most once.
 */
async function applyStaffZeroRent(ctx, rentalId, staffPeriod, reason) {
  const period = /^\d{4}-\d{2}$/.test(String(staffPeriod || ""))
    ? String(staffPeriod)
    : periodOf(String(staffPeriod || ctx.now).slice(0, 10));
  const obligations = await ctx.tx.query("obligations", [["rentalId", "==", rentalId]]);
  const cancelledObligationIds = [];
  const cappedObligationIds = [];
  for (const ob of obligations) {
    if (!ob || ob.state !== "active" || ob.baselineExcluded === true) continue;
    const due = String(ob.dueDate || `${ob.period || "9999-99"}-01`).slice(0, 10);
    const obPeriod = ob.period || periodOf(due);
    if (String(obPeriod) < String(period)) continue;
    const receipts = await ctx.tx.query("receipts", [["obligationId", "==", ob.id]]);
    const pending = receipts.filter((r) => r.state === RECEIPT_STATE.PENDING);
    if (pending.length) continue;
    const paid = receipts
      .filter((r) => r.state === RECEIPT_STATE.RECOGNIZED)
      .reduce((s, r) => s + Number(r.amountFils || 0), 0);
    const future = String(obPeriod) > String(period);
    if (paid <= 0) {
      ctx.tx.update("obligations", ob.id, {
        state: "cancelled",
        cancelledBy: ctx.actor.userId,
        cancelledAt: ctx.now,
        cancelReason: reason,
        staffZeroRent: true,
        cancelledAsFutureUnpaidOnVacate: future,
      });
      cancelledObligationIds.push(ob.id);
      continue;
    }
    // A recognized receipt stays in its original month. Staff does not suppress
    // it and does not reverse it. Only an unpaid remainder is released.
    if (Number(ob.amountFils || 0) > paid) {
      ctx.tx.update("obligations", ob.id, {
        amountFils: paid,
        staffUnpaidReleased: true,
        staffReleasedAt: ctx.now,
      });
      cappedObligationIds.push(ob.id);
    }
  }
  return { cancelledObligationIds, cappedObligationIds };
}

/**
 * Staff accommodation is not chargeable.
 * Zero rent closes an unpaid staff agreement without reversing recognized receipts.
 * A positive amount does not open a new rental or a new obligation, and it does
 * not rewrite an existing staff agreement.
 */
async function syncStaffCharge(ctx, space, staffRentFils, { closedRentalIds = [] } = {}) {
  const today = String(ctx.now).slice(0, 10);
  const period = periodOf(today);
  const closedSet = new Set(closedRentalIds);
  const open = await ctx.tx.query("rentals", [["spaceId", "==", space.id], ["state", "==", "active"]]);
  const staffRentals = open.filter((r) => r && r.purpose === "staff" && !closedSet.has(r.id));
  if (!(staffRentFils > 0)) {
    const closed = [];
    for (const rental of staffRentals) {
      const r = await closeRentalInTx(ctx, rental, {
        endDate: today,
        reason: "سكن موظفين بدون إيجار",
        setVacant: false,
        staffZeroRent: true,
        reverseLiveMoney: false,
      });
      closed.push(r.rentalId);
    }
    return { rentalId: null, obligationId: null, amountFils: 0, closedStaffRentalIds: closed };
  }

  // Positive staff rent is not a rental charge. Leave any existing agreement unchanged.
  const existing = staffRentals[0] || null;
  return {
    rentalId: existing ? existing.id : null,
    obligationId: null,
    amountFils: 0,
    closedStaffRentalIds: [],
    refusedCharge: true,
  };
}

async function closeRentalInTx(ctx, rental, { endDate, reason, setVacant, reverseLiveMoney = false, retainArrears = false, staffZeroRent = false, staffFromPeriod = null }) {
  const closeReason = reason || "rental closed";
  let reversed = { reversedReceiptIds: [], reversalIds: [] };
  if (reverseLiveMoney) {
    reversed = await reverseLiveReceiptsForRental(ctx, rental.id, closeReason);
  }
  const vacateDay = String(endDate || ctx.now.slice(0, 10)).slice(0, 10);
  ctx.tx.update("rentals", rental.id, {
    state: "closed",
    endDate: vacateDay,
    closedBy: ctx.actor.userId,
    closedAt: ctx.now,
    closeReason,
  });
  if (setVacant) ctx.tx.update("spaces", rental.spaceId, { occupancy: "vacant" });

  // Closed rental snapshot used for period-coverage checks while cancelling.
  const closedRental = { ...rental, state: "closed", endDate: vacateDay };

  let cancelledObligationIds = [];
  let cappedObligationIds = [];
  if (staffZeroRent) {
    const staff = await applyStaffZeroRent(ctx, rental.id, staffFromPeriod || periodOf(vacateDay), closeReason);
    cancelledObligationIds = staff.cancelledObligationIds;
    cappedObligationIds = staff.cappedObligationIds;
  } else if (retainArrears) {
    const obligations = await ctx.tx.query("obligations", [["rentalId", "==", rental.id]]);
    for (const ob of obligations) {
      if (ob.state !== "active") continue;
      const receipts = await ctx.tx.query("receipts", [["obligationId", "==", ob.id]]);
      const livePaid = receipts
        .filter((r) => r.state === RECEIPT_STATE.RECOGNIZED)
        .reduce((s, r) => s + Number(r.amountFils || 0), 0);
      const remaining = Math.max(0, Number(ob.amountFils || 0) - livePaid);
      const due = String(ob.dueDate || `${ob.period || "9999-99"}-01`).slice(0, 10);
      const obPeriod = ob.period || periodOf(due);
      // Future not-yet-due unpaid obligation: CANCEL — never Target/Collected/Holding.
      // Vacancy must never invent collection. No receipts ⇒ no money event.
      if (remaining > 0 && !livePaid && due > vacateDay) {
        ctx.tx.update("obligations", ob.id, {
          state: "cancelled",
          cancelledBy: ctx.actor.userId,
          cancelledAt: ctx.now,
          cancelReason: closeReason,
          cancelledAsFutureUnpaidOnVacate: true,
        });
        cancelledObligationIds.push(ob.id);
        continue;
      }
      if (remaining > 0) {
        // Due/past unpaid arrears: retain collectible debt (not Holding).
        // Past months covered by the rental stay historically attributable.
        ctx.tx.update("obligations", ob.id, {
          retainArrearsAfterVacate: true,
          arrearsRemainingFilsSnapshot: remaining,
          frozenHistoricalObligation: rentalCoversPeriod(closedRental, obPeriod),
        });
      } else if (!livePaid && !rentalCoversPeriod(closedRental, obPeriod)) {
        // Zero leftover in a non-covered (future) period — cancel.
        ctx.tx.update("obligations", ob.id, {
          state: "cancelled",
          cancelledBy: ctx.actor.userId,
          cancelledAt: ctx.now,
          cancelReason: closeReason,
        });
        cancelledObligationIds.push(ob.id);
      }
      // Fully paid with receipts, or unpaid covered historical month with remaining 0:
      // leave as active history (money lifecycle separate). Vacancy NEVER reverses receipts.
    }
  } else {
    cancelledObligationIds = await cancelUnpaidObligationsForRental(
      ctx, rental.id, closeReason, {
        ignoreReceiptIds: reversed.reversedReceiptIds,
        endDate: vacateDay,
        rental: closedRental,
      },
    );
  }
  const suppressedFutureIds = staffZeroRent
    ? []
    : await suppressFutureRentMonthObligations(ctx, closedRental, vacateDay);
  audit(ctx, "rental_closed", "rental", rental.id, {
    reason: closeReason,
    cancelledObligationIds,
    cappedObligationIds,
    suppressedFutureObligationIds: suppressedFutureIds,
    reversedReceiptIds: reversed.reversedReceiptIds,
    reversalIds: reversed.reversalIds,
    reverseLiveMoney: !!reverseLiveMoney,
    retainArrears: !!retainArrears,
    staffZeroRent: !!staffZeroRent,
  });
  return {
    rentalId: rental.id,
    cancelledObligationIds,
    cappedObligationIds,
    suppressedFutureObligationIds: suppressedFutureIds,
    reversedReceiptIds: reversed.reversedReceiptIds,
    reversalIds: reversed.reversalIds,
  };
}

/**
 * Months strictly after the vacancy month lose rent-month attribution.
 * Receipts are never reversed or deleted here. Physical cash stays in global Holding.
 */
async function suppressFutureRentMonthObligations(ctx, rental, vacateDay) {
  const obligations = await ctx.tx.query("obligations", [["rentalId", "==", rental.id]]);
  const suppressed = [];
  for (const ob of obligations) {
    if (!ob || ob.baselineExcluded === true) continue;
    if (!isObligationAfterTenancyEnd(ob, rental)) continue;
    if (ob.rentMonthSuppressed === true && ob.state !== "active") {
      suppressed.push(ob.id);
      continue;
    }
    const receipts = await ctx.tx.query("receipts", [["obligationId", "==", ob.id]]);
    const live = receipts.filter(
      (r) => r.state === RECEIPT_STATE.RECOGNIZED || r.state === RECEIPT_STATE.PENDING,
    );
    if (live.length) {
      // Keep the receipt. Drop November (etc.) Target/Collected/Holding only.
      ctx.tx.update("obligations", ob.id, {
        rentMonthSuppressed: true,
        suppressedReason: "tenancy_ended_before_period",
        suppressedAt: ctx.now,
      });
    } else if (ob.state === "active") {
      ctx.tx.update("obligations", ob.id, {
        state: "cancelled",
        rentMonthSuppressed: true,
        suppressedReason: "tenancy_ended_before_period",
        cancelledAsFutureUnpaidOnVacate: true,
        cancelledBy: ctx.actor.userId,
        cancelledAt: ctx.now,
        cancelReason: "tenancy ended before period",
      });
    } else if (!ob.rentMonthSuppressed) {
      ctx.tx.update("obligations", ob.id, {
        rentMonthSuppressed: true,
        suppressedReason: "tenancy_ended_before_period",
      });
    }
    suppressed.push(ob.id);
  }
  void vacateDay;
  return suppressed;
}

const REVENUE_ACCOUNT_ID = "mig:acc:revenue";

async function resolveRevenueAccountId(ctx, preferredId) {
  // حساب الإيرادات is authoritative when present.
  const named = await ctx.tx.get("accounts", REVENUE_ACCOUNT_ID);
  if (named && named.active !== false) return REVENUE_ACCOUNT_ID;
  if (preferredId) {
    const preferred = await ctx.tx.get("accounts", preferredId);
    if (preferred && preferred.active !== false && (
      preferred.kind === "bank" || /إيراد|revenue/i.test(String(preferred.name || ""))
    )) return preferredId;
  }
  const all = await ctx.tx.query("accounts", []);
  const hit = (all || []).find((a) => a.active !== false && (
    a.kind === "bank" || /إيراد|revenue/i.test(String(a.name || ""))
  )) || (all || []).find((a) => a.active !== false);
  if (hit) return hit.id;
  throw new DomainError("ACCOUNT_NOT_FOUND", { accountId: preferredId || REVENUE_ACCOUNT_ID });
}

/** Idempotent revenue credit — one ledger entry per source.
 *  Ledger tracks NEW approved rent effects. Finance UI حساب الإيرادات is a SEPARATE
 *  cumulative/manual balance in uiConfig/balances (prior months + owner edits).
 *  Credits ADD to that UI balance; they never replace it with month-only revenue.
 */
async function creditRevenueAccount(ctx, { amountFils, sourceType, sourceId, note, accountId: preferredId }) {
  assertPositiveFils(amountFils);
  const entryId = (`ledger:${sourceType}:${sourceId}:credit`).slice(0, 140);
  if (await ctx.tx.get("ledgerEntries", entryId)) {
    return { entryId, alreadyApplied: true };
  }
  const accountId = await resolveRevenueAccountId(ctx, preferredId);
  const acc = await ctx.tx.get("accounts", accountId);
  if (!acc || acc.active === false) throw new DomainError("ACCOUNT_NOT_FOUND", { accountId });
  // Engine account balanceFils = post-migration ledger net only — NOT the Finance UI balance.
  const prev = Number(acc.balanceFils || 0);
  ctx.tx.update("accounts", accountId, { balanceFils: prev + amountFils });
  ctx.tx.create("ledgerEntries", entryId, {
    id: entryId,
    accountId,
    direction: "credit",
    amountFils,
    sourceType,
    sourceId,
    note: note || null,
    at: ctx.now,
    ...base(ctx),
  });
  await adjustUiRevenueBalance(ctx, amountFils / 100, {
    reason: note || "اعتماد تحصيل",
    sourceType,
    sourceId,
  });
  return { entryId, alreadyApplied: false, accountId };
}

/**
 * Idempotent revenue debit.
 * - requirePriorCredit=true (default): used for reversing a prior credit (deposit/bank).
 * - requirePriorCredit=false: used for expense/maintenance paid from حساب الإيرادات.
 */
async function debitRevenueAccount(ctx, {
  amountFils, sourceType, sourceId, note, accountId: preferredId, requirePriorCredit = true,
}) {
  assertPositiveFils(amountFils);
  const creditId = (`ledger:${sourceType}:${sourceId}:credit`).slice(0, 140);
  const debitId = (`ledger:${sourceType}:${sourceId}:debit`).slice(0, 140);
  if (await ctx.tx.get("ledgerEntries", debitId)) {
    return { entryId: debitId, alreadyApplied: true };
  }
  let accountId;
  if (requirePriorCredit) {
    const credit = await ctx.tx.get("ledgerEntries", creditId);
    if (!credit) {
      return { entryId: null, alreadyApplied: false, skipped: true };
    }
    accountId = credit.accountId || await resolveRevenueAccountId(ctx, preferredId);
  } else {
    accountId = await resolveRevenueAccountId(ctx, preferredId);
  }
  const acc = await ctx.tx.get("accounts", accountId);
  if (!acc || acc.active === false) throw new DomainError("ACCOUNT_NOT_FOUND", { accountId });
  const prev = Number(acc.balanceFils || 0);
  ctx.tx.update("accounts", accountId, { balanceFils: prev - amountFils });
  ctx.tx.create("ledgerEntries", debitId, {
    id: debitId,
    accountId,
    direction: "debit",
    amountFils,
    sourceType,
    sourceId,
    note: note || null,
    at: ctx.now,
    ...base(ctx),
  });
  await adjustUiRevenueBalance(ctx, -(amountFils / 100), {
    reason: note || "خصم من الإيرادات",
    sourceType,
    sourceId,
  });
  return { entryId: debitId, alreadyApplied: false, accountId };
}

/**
 * Adjust cumulative Finance UI حساب الإيرادات (uiConfig/balances.revenueBalance).
 * This is NOT month Target/Collected. Prior-month opening must be preserved;
 * only deltas (approved collections / reversals / owner edits) change it.
 */
async function adjustUiRevenueBalance(ctx, deltaAed, meta = {}) {
  const delta = Math.round(Number(deltaAed) * 100) / 100;
  if (!delta) return { before: null, after: null };
  let doc = await ctx.tx.get("uiConfig", "balances");
  let obj = {};
  if (doc) {
    try { obj = JSON.parse(doc.json || "{}"); } catch { obj = {}; }
  }
  const before = Math.round((Number(obj.revenueBalance) || 0) * 100) / 100;
  const after = Math.round((before + delta) * 100) / 100;
  obj.revenueBalance = after;
  const rec = {
    json: JSON.stringify(obj),
    updatedAt: ctx.now,
    updatedBy: ctx.actor.userId,
    schemaVersion: 1,
  };
  if (doc) ctx.tx.update("uiConfig", "balances", rec);
  else ctx.tx.create("uiConfig", "balances", { id: "balances", ...rec, ...base(ctx) });
  audit(ctx, "revenue_balance_adjusted", "uiConfig", "balances", {
    beforeAed: before,
    afterAed: after,
    deltaAed: delta,
    reason: meta.reason || null,
    sourceType: meta.sourceType || null,
    sourceId: meta.sourceId || null,
  });
  return { before, after };
}

/* ═════════════════════ permission matrix ═════════════════════ */
/* Single source of truth for who may do what. Referenced by tests and by SECURITY.md. */

const OWNER = ["owner"];
const BOTH = ["owner", "employee"];

export const PERMISSIONS = Object.freeze({
  createProperty: OWNER, updateProperty: OWNER,
  createUnit: OWNER, updateUnit: OWNER,
  // Operational structure matches the old QAMA screens: employees who can edit a month
  // could already add partitions / change occupancy by writing the month document.
  createSpace: BOTH, updateSpace: BOTH, setSpaceOccupancy: BOTH,
  createRental: BOTH, updateRentalRent: BOTH, updateRentalTenant: BOTH, updateRentalSchedule: BOTH, closeRental: BOTH,
  renewRentalCycle: BOTH, endTenancy: BOTH,
  generateObligations: BOTH, cancelObligation: OWNER,
  createCashReceipt: BOTH,
  createDailyCashReceipt: BOTH,
  createDailyBookingPrepaid: BOTH,
  submitBankReceipt: BOTH, approveBankReceipt: OWNER, rejectBankReceipt: OWNER,
  reverseReceipt: OWNER,
  restoreReversedReceipt: OWNER,
  submitDeposit: BOTH, approveDeposit: OWNER, rejectDeposit: OWNER, reverseDeposit: OWNER,
  submitExpense: BOTH, approveExpense: OWNER, rejectExpense: OWNER, reverseExpense: OWNER,
  createAccount: OWNER, updateAccount: OWNER,
  createUser: OWNER, updateUser: OWNER, setUserPin: OWNER, deactivateUser: OWNER,
  // Old-UI persistence: locks, permissions, requests, daily/maintenance extras.
  // Not financial truth — money still only moves through receipt/deposit/expense commands.
  upsertUiConfig: OWNER,
  payInstallment: OWNER,
  reverseInstallment: OWNER,
  submitWorkRequest: BOTH,
  reviseWorkRequest: BOTH,
  previewReceiptCorrection: BOTH,
  submitReceiptCorrection: BOTH,
  applyReceiptCorrection: BOTH,
  setCorrectionPolicy: OWNER,
  reviewAccountingClose: OWNER,
  closeAccountingPeriod: OWNER,
  reopenAccountingPeriod: OWNER,
  resolveWorkRequest: OWNER,
  commitWorkRequest: OWNER,
  uncollectObligation: OWNER,
  savePeriodExtras: BOTH,
});

/* ═════════════════════ strict payload schemas ═════════════════════ */
/*
 * Unknown fields are REJECTED, not stripped. This is the mechanism that stops
 * `status: "collected"` and `unitId` on a deposit: the request never reaches the domain.
 */

const S = {
  str: (max = 200) => ({ kind: "str", max }),
  id: () => ({ kind: "id" }),
  fils: () => ({ kind: "fils" }),
  filsNonNegative: () => ({ kind: "filsNonNegative" }),
  date: () => ({ kind: "date" }),
  period: () => ({ kind: "period" }),
  int: (min, max) => ({ kind: "int", min, max }),
  enum: (values) => ({ kind: "enum", values }),
  bool: () => ({ kind: "bool" }),
  opt: (inner) => ({ ...inner, optional: true }),
};

export const SCHEMAS = Object.freeze({
  createProperty: { name: S.str(120), address: S.opt(S.str(300)) },
  updateProperty: { propertyId: S.id(), name: S.opt(S.str(120)), address: S.opt(S.str(300)), active: S.opt(S.bool()) },
  createUnit: { propertyId: S.id(), name: S.str(120), kind: S.enum(["whole", "partitioned"]) },
  updateUnit: { unitId: S.id(), name: S.opt(S.str(120)), active: S.opt(S.bool()) },
  createSpace: { unitId: S.id(), name: S.str(120) },
  updateSpace: { spaceId: S.id(), name: S.opt(S.str(120)), active: S.opt(S.bool()) },
  setSpaceOccupancy: {
    spaceId: S.id(),
    occupancy: S.enum(OCCUPANCY),
    /** Staff only. 0 is accommodation. A positive integer is a chargeable amount. Omitted keeps the stored staff amount. */
    staffRentFils: S.opt(S.filsNonNegative()),
    /** Staff only. An explicit earlier month is kept. A later month does not erase it. */
    staffEffectivePeriod: S.opt(S.period()),
  },

  createRental: {
    spaceId: S.id(), tenantName: S.str(160), tenantPhone: S.opt(S.str(40)),
    contractualAmountFils: S.fils(), dueDayOfMonth: S.int(1, 31),
    startDate: S.date(), securityDepositFils: S.opt(S.fils()),
  },
  updateRentalRent: {
    rentalId: S.id(),
    contractualAmountFils: S.fils(),
    /** YYYY-MM — only this period and later unpaid obligations may be revised. */
    effectivePeriod: S.opt(S.period()),
  },
  updateRentalTenant: {
    rentalId: S.id(),
    tenantName: S.opt(S.str(160)),
    tenantPhone: S.opt(S.str(40)),
    effectivePeriod: S.opt(S.period()),
  },
  updateRentalSchedule: {
    rentalId: S.id(),
    startDate: S.opt(S.date()),
    dueDayOfMonth: S.opt(S.int(1, 31)),
    /** Only this period and later obligation due dates may move. */
    effectivePeriod: S.opt(S.period()),
  },
  closeRental: { rentalId: S.id(), endDate: S.date(), reason: S.str(300), setVacant: S.opt(S.bool()) },
  renewRentalCycle: {
    rentalId: S.id(),
    asOfDate: S.opt(S.date()),
    earlyWindowDays: S.opt(S.int(0, 31)),
  },
  endTenancy: {
    rentalId: S.id(),
    endDate: S.date(),
    reason: S.str(300),
    /** retain = keep unpaid arrears visible; required when remaining > 0 */
    arrearsDecision: S.opt(S.enum(["retain", "none"])),
  },

  generateObligations: { period: S.period() },
  cancelObligation: { obligationId: S.id(), reason: S.str(300) },

  createCashReceipt: {
    obligationId: S.id(), amountFils: S.fils(), collectionDate: S.date(), note: S.opt(S.str(300)),
    collectorUserId: S.opt(S.id()),
  },
  createDailyCashReceipt: {
    bookingId: S.str(120), amountFils: S.fils(), collectionDate: S.date(),
    collectorUserId: S.opt(S.id()), note: S.opt(S.str(300)), period: S.period(),
  },
  createDailyBookingPrepaid: {
    period: S.period(),
    bookingJson: S.str(4000),
    amountFils: S.fils(),
    collectionDate: S.date(),
    collectorUserId: S.opt(S.id()),
    note: S.opt(S.str(300)),
  },
  submitBankReceipt: {
    obligationId: S.id(), amountFils: S.fils(), collectionDate: S.date(), bankReference: S.str(120),
    collectorUserId: S.opt(S.id()),
  },
  approveBankReceipt: { receiptId: S.id() },
  rejectBankReceipt: { receiptId: S.id(), reason: S.str(300) },
  reverseReceipt: {
    receiptId: S.id(), reason: S.str(300),
    replacementAmountFils: S.opt(S.fils()),
  },
  restoreReversedReceipt: { receiptId: S.id(), reason: S.str(300) },

  submitDeposit: {
    amountFils: S.fils(), depositDate: S.date(), destinationAccountId: S.id(),
    note: S.opt(S.str(300)), reference: S.opt(S.str(120)), employeeId: S.opt(S.id()),
    sourceKind: S.opt(S.enum(["holding", "external"])),
    /** Financial period whose Holding this deposit reduces (required for holding deposits). */
    sourcePeriod: S.opt(S.period()),
    /** Accounting period for list/P&L visibility — independent of depositDate. */
    period: S.opt(S.period()),
  },
  approveDeposit: { depositId: S.id() },
  rejectDeposit: { depositId: S.id(), reason: S.str(300) },
  reverseDeposit: { depositId: S.id(), reason: S.str(300) },

  submitExpense: {
    amountFils: S.fils(), reason: S.str(300), category: S.str(60), expenseDate: S.date(),
    paidFromAccountId: S.id(),
    maintenanceLinkId: S.opt(S.str(120)),
    requestedBy: S.opt(S.id()),
    /** Accounting period (viewed month) — independent of expenseDate. */
    period: S.opt(S.period()),
  },
  approveExpense: { expenseId: S.id() },
  rejectExpense: { expenseId: S.id(), reason: S.str(300) },
  reverseExpense: { expenseId: S.id(), reason: S.str(300) },

  createAccount: { name: S.str(120), kind: S.enum(["bank", "cash", "company"]) },
  updateAccount: { accountId: S.id(), name: S.opt(S.str(120)), active: S.opt(S.bool()) },

  createUser: { displayName: S.str(120), role: S.enum(["owner", "employee"]), pin: S.str(12) },
  updateUser: { userId: S.id(), displayName: S.opt(S.str(120)), role: S.opt(S.enum(["owner", "employee"])), active: S.opt(S.bool()) },
  setUserPin: { userId: S.id(), pin: S.str(12) },
  deactivateUser: { userId: S.id() },

  upsertUiConfig: { configId: S.enum(["locks", "permissions", "balances", "customUnits"]), json: S.str(200000) },
  payInstallment: { installmentDate: S.date(), amountFils: S.fils() },
  reverseInstallment: { installmentDate: S.date() },
  submitWorkRequest: {
    requestId: S.id(), type: S.str(80), desc: S.str(800), payloadJson: S.str(100000),
    month: S.int(0, 11), year: S.int(2020, 2100),
  },
  reviseWorkRequest: {
    requestId: S.id(), expectedVersion: S.int(1, 100000), reason: S.str(300),
    payloadJson: S.str(100000), desc: S.opt(S.str(800)),
  },
  previewReceiptCorrection: {
    receiptId: S.id(), correctedAmountFils: S.filsNonNegative(),
  },
  submitReceiptCorrection: {
    requestId: S.id(), receiptId: S.id(), reason: S.str(300),
    correctedAmountFils: S.filsNonNegative(),
    month: S.int(0, 11), year: S.int(2020, 2100),
  },
  applyReceiptCorrection: {
    requestId: S.id(), expectedVersion: S.opt(S.int(1, 100000)),
    confirmDepositReconciliation: S.opt(S.bool()),
    resume: S.opt(S.bool()),
  },
  setCorrectionPolicy: { undeposited: S.enum(["manager_approval", "employee_direct"]) },
  reviewAccountingClose: { period: S.period() },
  closeAccountingPeriod: { period: S.period() },
  reopenAccountingPeriod: { period: S.period(), reason: S.str(300) },
  resolveWorkRequest: { requestId: S.id(), decision: S.enum(["pending", "processing", "approved", "rejected", "failed"]) },
  commitWorkRequest: {
    requestId: S.id(),
    expectedVersion: S.opt(S.int(1, 100000)),
    confirmDepositReconciliation: S.opt(S.bool()),
    resume: S.opt(S.bool()),
  },
  uncollectObligation: { obligationId: S.id(), reason: S.str(300) },
  savePeriodExtras: {
    period: S.period(),
    extrasJson: S.str(400000),
    writeMode: S.opt(S.enum(["replace", "patch"])),
    scopes: S.opt(S.str(240)),
  },
});

const ID_RE = /^[A-Za-z0-9_:.-]{1,140}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD_RE = /^\d{4}-\d{2}$/;

export function validatePayload(command, payload) {
  const schema = SCHEMAS[command];
  if (!schema) throw new DomainError("UNKNOWN_COMMAND", { command });
  const raw = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};

  const allowed = new Set(Object.keys(schema));
  const unknown = Object.keys(raw).filter((k) => !allowed.has(k));
  if (unknown.length) {
    // Deliberately loud. A client sending status/unitId/role learns the field is refused,
    // and no partial effect occurs.
    throw new DomainError("UNKNOWN_FIELD", { command, fields: unknown.sort() });
  }

  const out = {};
  for (const [key, rule] of Object.entries(schema)) {
    const value = raw[key];
    if (value === undefined || value === null) {
      if (rule.optional) continue;
      throw new DomainError("MISSING_FIELD", { command, field: key });
    }
    out[key] = coerce(command, key, rule, value);
  }
  return out;
}

function coerce(command, field, rule, value) {
  const bad = (why) => { throw new DomainError("INVALID_FIELD", { command, field, why }); };
  switch (rule.kind) {
    case "str": {
      if (typeof value !== "string") bad("not a string");
      const t = value.trim();
      if (!t) bad("empty");
      if (t.length > rule.max) bad("too long");
      return t;
    }
    case "id":
      if (typeof value !== "string" || !ID_RE.test(value)) bad("not an id");
      return value;
    case "fils":
      if (!isFils(value)) bad("money must be an integer number of fils");
      if (value <= 0) bad("must be positive");
      return value;
    case "filsNonNegative":
      if (!isFils(value)) bad("money must be an integer number of fils");
      if (value < 0) bad("must not be negative");
      return value;
    case "date":
      if (typeof value !== "string" || !DATE_RE.test(value)) bad("expected YYYY-MM-DD");
      return value;
    case "period":
      if (typeof value !== "string" || !PERIOD_RE.test(value)) bad("expected YYYY-MM");
      return value;
    case "int": {
      if (!Number.isInteger(value)) bad("not an integer");
      if (value < rule.min || value > rule.max) bad(`out of range ${rule.min}..${rule.max}`);
      return value;
    }
    case "enum":
      if (!rule.values.includes(value)) bad(`expected one of ${rule.values.join("|")}`);
      return value;
    case "bool":
      if (typeof value !== "boolean") bad("not a boolean");
      return value;
    default:
      bad("unsupported");
  }
}

/* ═════════════════════ command execution ═════════════════════ */

/**
 * @param db        repository facade (see repositories/firestore.mjs)
 * @param actor     { userId, role, active } — loaded from the database, never from the client
 * @param command   command name
 * @param payload   raw client payload
 * @param operationId  idempotency key
 * @param now       ISO timestamp supplied by the caller so the domain stays pure
 */
const CORRECTION_GRANT_COMMANDS = new Set(["reverseReceipt", "createCashReceipt"]);

/**
 * An employee may run only the cash steps of their own processing receipt
 * correction. The grant is attached by commitWorkRequestFlow, never by the
 * callable payload. Role stays employee, so the audit names that employee.
 */
async function correctionGrantAllows({ db, actor, command, payload, operationId, grant }) {
  if (!grant || grant.kind !== "receipt_correction") return false;
  if (!CORRECTION_GRANT_COMMANDS.has(command)) return false;
  const requestId = String(grant.requestId || "");
  if (!requestId || operationId !== `cwr-${requestId}-${command === "reverseReceipt" ? "rev" : "cash"}`) return false;
  const req = await db.runTransaction((tx) => tx.get("uiRequests", requestId));
  if (!req || req.type !== "receipt_correction" || req.status !== "processing") return false;
  if (req.approvingBy !== actor.userId) return false;
  let body = {};
  try { body = JSON.parse(req.payloadJson || "{}"); } catch { return false; }
  if (command === "reverseReceipt") {
    if (payload.receiptId !== body.receiptId) return false;
    const corrected = Number(body.correctedAmountFils);
    if (corrected > 0) return payload.replacementAmountFils === corrected;
    return payload.replacementAmountFils == null;
  }
  const receipt = await db.runTransaction((tx) => tx.get("receipts", body.receiptId));
  if (!receipt || receipt.method !== "cash") return false;
  if (payload.collectorUserId && payload.collectorUserId !== receipt.collectorUserId) return false;
  return payload.obligationId === receipt.obligationId
    && payload.amountFils === Number(body.correctedAmountFils);
}

export async function executeCommand({ db, actor, command, payload, operationId, now, grant }) {
  if (!PERMISSIONS[command]) throw new DomainError("UNKNOWN_COMMAND", { command });
  if (!actor || !actor.userId) throw new DomainError("UNAUTHENTICATED");
  if (actor.active === false) throw new DomainError("ACCOUNT_DISABLED");
  if (typeof operationId !== "string" || !ID_RE.test(operationId) || operationId.length < 8) {
    throw new DomainError("INVALID_OPERATION_ID");
  }
  const roleAllowed = PERMISSIONS[command].includes(actor.role);
  if (!roleAllowed && !grant) throw new DomainError("FORBIDDEN", { command, role: actor.role });
  const clean = validatePayload(command, payload);
  let usedCorrectionGrant = false;
  if (!roleAllowed) {
    usedCorrectionGrant = await correctionGrantAllows({ db, actor, command, payload: clean, operationId, grant });
    if (!usedCorrectionGrant) throw new DomainError("FORBIDDEN", { command, role: actor.role });
  }

  if (command === "commitWorkRequest" || command === "applyReceiptCorrection") {
    const run = (who, cmd, body, op, stepGrant) => executeCommand({
      db, actor: who, command: cmd, payload: body, operationId: op, now, grant: stepGrant,
    });
    return commitWorkRequestFlow({
      db, actor, payload: clean, operationId, now, run,
      enforceCorrectionPolicy: command === "applyReceiptCorrection",
    });
  }

  return db.runTransaction(async (tx) => {
    // Idempotency: a replay returns the original result and produces no new effect.
    const prior = await tx.get("operations", operationId);
    const fingerprint = hashPayload(command, clean);
    if (prior) {
      if (prior.payloadHash !== fingerprint) throw new DomainError("IDEMPOTENCY_PAYLOAD_MISMATCH");
      return { ...prior.result, replay: true };
    }

    const ctx = { tx, actor, now, operationId, payload: clean, usedCorrectionGrant };
    const result = await HANDLERS[command](ctx);

    // `create` (not set) so two concurrent duplicates collide at the database.
    tx.create("operations", operationId, {
      operationId, command, payloadHash: fingerprint,
      actorUserId: actor.userId, state: "completed", result, at: now,
    });
    return { ...result, replay: false };
  });
}

function hashPayload(command, payload) {
  const stable = JSON.stringify([command, sortKeys(payload)]);
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < stable.length; i++) {
    const c = stable.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c, 2246822519) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0") + ":" + stable.length;
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  }
  return v;
}

/* ═════════════════════ audit ═════════════════════ */

function audit(ctx, action, targetType, targetId, extra = {}) {
  ctx.tx.create("auditEvents", `audit:${ctx.operationId}:${action}:${targetType}:${targetId}`.slice(0, 700), {
    at: ctx.now, actorUserId: ctx.actor.userId, actorRole: ctx.actor.role,
    action, targetType, targetId, operationId: ctx.operationId, ...extra,
  });
}

const base = (ctx) => ({ createdAt: ctx.now, createdBy: ctx.actor.userId, schemaVersion: 1 });
const newId = (prefix, ctx) => `${prefix}:${ctx.operationId}`;

/* ═════════════════════ handlers ═════════════════════ */

const HANDLERS = {
  /* ---------- structure ---------- */
  async createProperty(ctx) {
    const id = newId("prop", ctx);
    ctx.tx.create("properties", id, { id, ...ctx.payload, active: true, ...base(ctx) });
    audit(ctx, "property_created", "property", id);
    return { propertyId: id };
  },
  async updateProperty(ctx) {
    const { propertyId, ...patch } = ctx.payload;
    const doc = await ctx.tx.get("properties", propertyId);
    if (!doc) throw new DomainError("PROPERTY_NOT_FOUND");
    ctx.tx.update("properties", propertyId, patch);
    audit(ctx, "property_updated", "property", propertyId, { before: doc, after: { ...doc, ...patch } });
    return { propertyId };
  },
  async createUnit(ctx) {
    const prop = await ctx.tx.get("properties", ctx.payload.propertyId);
    if (!prop) throw new DomainError("PROPERTY_NOT_FOUND");
    const id = newId("unit", ctx);
    ctx.tx.create("units", id, { id, ...ctx.payload, active: true, ...base(ctx) });
    audit(ctx, "unit_created", "unit", id);
    return { unitId: id };
  },
  async updateUnit(ctx) {
    const { unitId, ...patch } = ctx.payload;
    const doc = await ctx.tx.get("units", unitId);
    if (!doc) throw new DomainError("UNIT_NOT_FOUND");
    if (patch.active === false) {
      const open = await ctx.tx.query("rentals", [["unitId", "==", unitId], ["state", "==", "active"]]);
      if (open.length) throw new DomainError("UNIT_HAS_ACTIVE_RENTAL", { rentalId: open[0].id });
      const spaces = await ctx.tx.query("spaces", [["unitId", "==", unitId]]);
      for (const sp of spaces) {
        if (sp.active === false) continue;
        ctx.tx.update("spaces", sp.id, { active: false });
      }
    }
    ctx.tx.update("units", unitId, patch);
    audit(ctx, "unit_updated", "unit", unitId);
    return { unitId };
  },
  async createSpace(ctx) {
    const unit = await ctx.tx.get("units", ctx.payload.unitId);
    if (!unit) throw new DomainError("UNIT_NOT_FOUND");
    const id = newId("space", ctx);
    ctx.tx.create("spaces", id, {
      id, unitId: unit.id, propertyId: unit.propertyId, name: ctx.payload.name,
      occupancy: "vacant", active: true, ...base(ctx),
    });
    audit(ctx, "space_created", "space", id);
    return { spaceId: id };
  },
  /**
   * Renaming or deactivating a space is operational. Receipts and obligations already
   * created keep their own snapshots, so history is untouched either way.
   */
  async updateSpace(ctx) {
    const { spaceId, ...patch } = ctx.payload;
    const space = await ctx.tx.get("spaces", spaceId);
    if (!space) throw new DomainError("SPACE_NOT_FOUND");
    if (patch.active === false) {
      const open = await ctx.tx.query("rentals", [["spaceId", "==", spaceId], ["state", "==", "active"]]);
      // Refusing beats orphaning a live tenancy: end the rental deliberately first.
      if (open.length) throw new DomainError("SPACE_HAS_ACTIVE_RENTAL", { rentalId: open[0].id });
    }
    ctx.tx.update("spaces", spaceId, patch);
    audit(ctx, "space_updated", "space", spaceId, { before: { name: space.name, active: space.active }, after: patch });
    return { spaceId };
  },

  /** Correcting the tenant's name or phone. Past-period obligation snapshots stay frozen. */
  async updateRentalTenant(ctx) {
    const { rentalId, effectivePeriod: effPeriod, ...patch } = ctx.payload;
    const rental = await ctx.tx.get("rentals", rentalId);
    if (!rental) throw new DomainError("RENTAL_NOT_FOUND");
    if (rental.state !== "active") throw new DomainError("RENTAL_NOT_ACTIVE");
    const tenantPatch = {};
    if (patch.tenantName != null) tenantPatch.tenantName = patch.tenantName;
    if (patch.tenantPhone != null) tenantPatch.tenantPhone = patch.tenantPhone;
    if (!Object.keys(tenantPatch).length) throw new DomainError("NOTHING_TO_UPDATE");
    const effectivePeriod = effPeriod || periodOf(ctx.now.slice(0, 10));
    const tenantRevisions = Array.isArray(rental.tenantRevisions) ? rental.tenantRevisions.slice() : [];
    const nameChanged = tenantPatch.tenantName != null && tenantPatch.tenantName !== rental.tenantName;
    const phoneChanged = tenantPatch.tenantPhone != null && tenantPatch.tenantPhone !== (rental.tenantPhone || null);
    if (nameChanged || phoneChanged) {
      const startPeriod = periodOf(String(rental.startDate || ctx.now).slice(0, 10));
      if (!tenantRevisions.some((r) => r && r.effectivePeriod === startPeriod)) {
        tenantRevisions.push({
          effectivePeriod: startPeriod,
          tenantName: rental.tenantName,
          tenantPhone: rental.tenantPhone || null,
        });
      }
      const nextRevs = tenantRevisions.filter((r) => r && r.effectivePeriod !== effectivePeriod);
      nextRevs.push({
        effectivePeriod,
        tenantName: nameChanged ? tenantPatch.tenantName : rental.tenantName,
        tenantPhone: phoneChanged
          ? tenantPatch.tenantPhone
          : (tenantPatch.tenantPhone != null ? tenantPatch.tenantPhone : (rental.tenantPhone || null)),
      });
      tenantPatch.tenantRevisions = nextRevs;
    }
    ctx.tx.update("rentals", rentalId, tenantPatch);
    const revised = [];
    const frozen = [];
    if (tenantPatch.tenantName != null) {
      const obligations = await ctx.tx.query("obligations", [["rentalId", "==", rentalId]]);
      for (const ob of obligations) {
        if (ob.state !== "active") continue;
        const obPeriod = ob.period || (ob.dueDate ? periodOf(ob.dueDate) : null);
        if (obPeriod && String(obPeriod) < String(effectivePeriod)) {
          // Freeze the name that was valid before this change. Never overwrite it.
          if (!ob.tenantNameSnapshot) {
            ctx.tx.update("obligations", ob.id, { tenantNameSnapshot: rental.tenantName });
            frozen.push(ob.id);
          }
          continue;
        }
        if (ob.tenantNameSnapshot === tenantPatch.tenantName) continue;
        ctx.tx.update("obligations", ob.id, { tenantNameSnapshot: tenantPatch.tenantName });
        revised.push(ob.id);
      }
    }
    audit(ctx, "rental_tenant_updated", "rental", rentalId, {
      before: { tenantName: rental.tenantName },
      after: tenantPatch,
      effectivePeriod,
      revisedObligationSnapshots: revised,
      frozenHistoricalSnapshots: frozen,
    });
    return { rentalId, effectivePeriod, revisedObligationSnapshotIds: revised };
  },

  /**
   * Occupancy is operational and separate from the financial status.
   * Vacant ends a live rental and does not create rent.
   * Staff stores an explicit rent: 0 is accommodation with no obligation;
   * a positive amount is an unpaid charge until a real receipt is recorded.
   * A later staff save that omits staffRentFils does not reset a stored amount.
   */
  async setSpaceOccupancy(ctx) {
    await assertEmployeePeriodOpen(ctx, periodOf(ctx.now.slice(0, 10)));
    const space = await ctx.tx.get("spaces", ctx.payload.spaceId);
    if (!space) throw new DomainError("SPACE_NOT_FOUND");
    const next = ctx.payload.occupancy;
    const staffRentSpecified = Object.prototype.hasOwnProperty.call(ctx.payload, "staffRentFils");
    let staffRentFils = null;
    if (next === "staff") {
      // Staff accommodation is never a rental charge, including a typed positive amount.
      staffRentFils = 0;
    }
    const closed = [];
    const requestedStaffPeriod = /^\d{4}-\d{2}$/.test(String(ctx.payload.staffEffectivePeriod || ""))
      ? String(ctx.payload.staffEffectivePeriod)
      : null;
    const existingStaffPeriod = /^\d{4}-\d{2}$/.test(String(space.staffEffectivePeriod || ""))
      ? String(space.staffEffectivePeriod)
      : null;
    let staffPeriod = null;
    if (next === "staff") {
      if (requestedStaffPeriod && (!existingStaffPeriod || requestedStaffPeriod < existingStaffPeriod)) {
        staffPeriod = requestedStaffPeriod;
      } else {
        staffPeriod = existingStaffPeriod || periodOf(ctx.now.slice(0, 10));
      }
    }
    if (next === "vacant" || next === "staff") {
      const open = await ctx.tx.query("rentals", [["spaceId", "==", space.id], ["state", "==", "active"]]);
      for (const rental of open) {
        if (next === "staff" && rental.purpose === "staff") continue;
        const r = await closeRentalInTx(ctx, rental, {
          endDate: ctx.now.slice(0, 10),
          reason: next === "vacant" ? "إفراغ الوحدة" : "تحويل إلى موظفين",
          setVacant: next === "vacant",
          staffZeroRent: next === "staff",
          staffFromPeriod: staffPeriod,
          reverseLiveMoney: false,
        });
        closed.push(r);
      }
    }
    if (next === "rented") {
      const open = await ctx.tx.query("rentals", [["spaceId", "==", space.id], ["state", "==", "active"]]);
      for (const rental of open) {
        if (rental.purpose !== "staff") continue;
        if (!(Number(rental.contractualAmountFils) > 0)) {
          throw new DomainError("RENT_NOT_POSITIVE", { rentalId: rental.id });
        }
        ctx.tx.update("rentals", rental.id, { purpose: null });
      }
    }
    const spacePatch = { occupancy: next };
    if (next === "staff") {
      spacePatch.staffRentFils = staffRentFils;
      spacePatch.staffEffectivePeriod = staffPeriod;
    }
    ctx.tx.update("spaces", space.id, spacePatch);
    let staffCharge = null;
    if (next === "staff") {
      const handled = new Set(closed.map((c) => c.rentalId));
      if (!(staffRentFils > 0)) {
        const prior = await ctx.tx.query("rentals", [["spaceId", "==", space.id]]);
        for (const rental of prior) {
          if (!rental || handled.has(rental.id) || rental.purpose === "staff" || rental.state === "active") continue;
          await applyStaffZeroRent(ctx, rental.id, staffPeriod, "تحويل إلى موظفين");
        }
      }
      staffCharge = await syncStaffCharge(ctx, { ...space, ...spacePatch }, staffRentFils, {
        closedRentalIds: closed.map((c) => c.rentalId),
      });
    }
    audit(ctx, "occupancy_changed", "space", space.id, {
      before: space.occupancy,
      after: next,
      staffRentFils,
      closedRentals: closed.map((c) => c.rentalId),
    });
    return {
      spaceId: space.id,
      occupancy: next,
      staffRentFils,
      closedRentals: closed,
      staffCharge,
    };
  },

  /* ---------- rentals ---------- */
  async createRental(ctx) {
    const space = await ctx.tx.get("spaces", ctx.payload.spaceId);
    if (!space) throw new DomainError("SPACE_NOT_FOUND");
    if (isPlaceholderTenant(ctx.payload.tenantName)) {
      throw new DomainError("TENANT_REQUIRED", { tenantName: ctx.payload.tenantName });
    }
    const open = await ctx.tx.query("rentals", [["spaceId", "==", space.id], ["state", "==", "active"]]);
    if (open.length) throw new DomainError("SPACE_ALREADY_RENTED", { rentalId: open[0].id });
    const spaceRentals = await ctx.tx.query("rentals", [["spaceId", "==", space.id]]);
    const spaceObligations = await ctx.tx.query("obligations", [["spaceId", "==", space.id]]);
    const coverageConflict = findPeriodCoverageConflict({
      spaceId: space.id,
      startDate: ctx.payload.startDate,
      rentals: spaceRentals,
      obligations: spaceObligations,
    });
    if (coverageConflict) throw new DomainError("PERIOD_ALREADY_COVERED", coverageConflict);
    await assertPeriodMutable(ctx, periodOf(ctx.payload.startDate));

    const id = newId("rental", ctx);
    ctx.tx.create("rentals", id, {
      id, propertyId: space.propertyId, unitId: space.unitId, spaceId: space.id,
      tenantName: String(ctx.payload.tenantName).trim(), tenantPhone: ctx.payload.tenantPhone || null,
      contractualAmountFils: ctx.payload.contractualAmountFils,
      dueDayOfMonth: ctx.payload.dueDayOfMonth, startDate: ctx.payload.startDate,
      endDate: null, state: "active",
      securityDepositFils: ctx.payload.securityDepositFils || 0, ...base(ctx),
    });
    ctx.tx.update("spaces", space.id, { occupancy: "rented" });
    audit(ctx, "rental_created", "rental", id, { amountFils: ctx.payload.contractualAmountFils });
    return { rentalId: id };
  },
  /**
   * Rent on the rental always updates. Period obligations that already have
   * live receipts stay frozen (historical snapshot). Unpaid obligations of the
   * same rental are revised only for effectivePeriod and later — never silently
   * rewrite earlier months (Oct rent change must not mutate Sep obligation).
   */
  async updateRentalRent(ctx) {
    const rental = await ctx.tx.get("rentals", ctx.payload.rentalId);
    if (!rental) throw new DomainError("RENTAL_NOT_FOUND");
    if (rental.state !== "active") throw new DomainError("RENTAL_NOT_ACTIVE");
    const effectivePeriod = ctx.payload.effectivePeriod || periodOf(ctx.now.slice(0, 10));
    const rentRevisions = Array.isArray(rental.rentRevisions) ? rental.rentRevisions.slice() : [];
    const startPeriod = periodOf(String(rental.startDate || ctx.now).slice(0, 10));
    if (!rentRevisions.some((r) => r && r.effectivePeriod === startPeriod)) {
      rentRevisions.push({ effectivePeriod: startPeriod, amountFils: rental.contractualAmountFils });
    }
    const nextRentRevs = rentRevisions.filter((r) => r && r.effectivePeriod !== effectivePeriod);
    nextRentRevs.push({ effectivePeriod, amountFils: ctx.payload.contractualAmountFils });
    ctx.tx.update("rentals", rental.id, {
      contractualAmountFils: ctx.payload.contractualAmountFils,
      rentRevisions: nextRentRevs,
    });
    const obligations = await ctx.tx.query("obligations", [["rentalId", "==", rental.id]]);
    const revised = [];
    const skippedHistorical = [];
    const receiptFrozen = [];
    for (const ob of obligations) {
      if (ob.state !== "active") continue;
      const obPeriod = ob.period || (ob.dueDate ? periodOf(ob.dueDate) : null);
      if (obPeriod && String(obPeriod) < String(effectivePeriod)) {
        skippedHistorical.push(ob.id);
        continue;
      }
      const receipts = await ctx.tx.query("receipts", [["obligationId", "==", ob.id]]);
      const live = receipts.filter(
        (r) => r.state === RECEIPT_STATE.RECOGNIZED || r.state === RECEIPT_STATE.PENDING,
      );
      if (live.length) {
        const paid = live.reduce((sum, r) => sum + Number(r.amountFils || 0), 0);
        const next = ctx.payload.contractualAmountFils;
        // A collected month can be lowered only down to what is already recognized.
        // It cannot be raised here, and it cannot fall below the live receipts.
        if (next < Number(ob.amountFils || 0) && next >= paid) {
          ctx.tx.update("obligations", ob.id, { amountFils: next });
          revised.push(ob.id);
        } else {
          receiptFrozen.push(ob.id);
        }
        continue;
      }
      if (ob.amountFils === ctx.payload.contractualAmountFils) continue;
      ctx.tx.update("obligations", ob.id, { amountFils: ctx.payload.contractualAmountFils });
      revised.push(ob.id);
    }
    audit(ctx, "rental_rent_updated", "rental", rental.id, {
      before: rental.contractualAmountFils,
      after: ctx.payload.contractualAmountFils,
      effectivePeriod,
      revised,
      skippedHistorical,
      receiptFrozen,
    });
    return {
      rentalId: rental.id,
      effectivePeriod,
      revisedObligationIds: revised,
      skippedHistoricalObligationIds: skippedHistorical,
      receiptFrozenObligationIds: receiptFrozen,
    };
  },
  /**
   * Recurring due day must follow the contract start day-of-month.
   * Updates rental.startDate / dueDayOfMonth and rewrites active obligation dueDates
   * for every period (money amounts untouched).
   */
  async updateRentalSchedule(ctx) {
    const rental = await ctx.tx.get("rentals", ctx.payload.rentalId);
    if (!rental) throw new DomainError("RENTAL_NOT_FOUND");
    if (rental.state !== "active") throw new DomainError("RENTAL_NOT_ACTIVE");

    const patch = {};
    const effectivePeriod = ctx.payload.effectivePeriod || periodOf(ctx.now.slice(0, 10));
    if (ctx.payload.startDate) {
      const nextStart = String(ctx.payload.startDate).slice(0, 10);
      const prevStart = String(rental.startDate || "").slice(0, 10);
      // A later month's cycle start must not move the contract start forward
      // (that would uncover September when October is saved).
      if (!prevStart || periodOf(nextStart) <= periodOf(prevStart)) patch.startDate = nextStart;
    }
    if (ctx.payload.dueDayOfMonth != null) patch.dueDayOfMonth = ctx.payload.dueDayOfMonth;

    // If only startDate is supplied, derive due day from it (upfront rent rule).
    if (patch.startDate && ctx.payload.dueDayOfMonth == null) {
      patch.dueDayOfMonth = Math.min(31, Math.max(1, Number(String(patch.startDate).slice(8, 10)) || 1));
    }
    if (!Object.keys(patch).length && ctx.payload.dueDayOfMonth == null && !ctx.payload.startDate) {
      throw new DomainError("NOTHING_TO_UPDATE");
    }
    if (!Object.keys(patch).length) throw new DomainError("NOTHING_TO_UPDATE");

    const nextDueDay = patch.dueDayOfMonth != null ? patch.dueDayOfMonth : rental.dueDayOfMonth;
    ctx.tx.update("rentals", rental.id, patch);

    const obligations = await ctx.tx.query("obligations", [["rentalId", "==", rental.id]]);
    const revised = [];
    const skippedHistorical = [];
    for (const ob of obligations) {
      if (ob.state !== "active") continue;
      const obPeriod = ob.period || (ob.dueDate ? periodOf(ob.dueDate) : null);
      if (obPeriod && String(obPeriod) < String(effectivePeriod)) {
        skippedHistorical.push(ob.id);
        continue;
      }
      const nextDue = dueDateFor(ob.period, nextDueDay);
      if (ob.dueDate === nextDue) continue;
      ctx.tx.update("obligations", ob.id, { dueDate: nextDue });
      revised.push({ obligationId: ob.id, before: ob.dueDate, after: nextDue });
    }
    audit(ctx, "rental_schedule_updated", "rental", rental.id, {
      before: { startDate: rental.startDate, dueDayOfMonth: rental.dueDayOfMonth },
      after: { ...patch, dueDayOfMonth: nextDueDay },
      effectivePeriod,
      revised,
      skippedHistorical,
    });
    return { rentalId: rental.id, dueDayOfMonth: nextDueDay, revisedObligationIds: revised.map((r) => r.obligationId) };
  },
  /**
   * Closing ends the tenancy without reversing collections (إخلاء ≠ إلغاء تحصيل).
   * Prefer endTenancy for vacate-with-arrears-confirm. reverseLiveMoney stays false.
   */
  async closeRental(ctx) {
    const rental = await ctx.tx.get("rentals", ctx.payload.rentalId);
    if (!rental) throw new DomainError("RENTAL_NOT_FOUND");
    if (rental.state === "closed") throw new DomainError("RENTAL_ALREADY_CLOSED");
    return closeRentalInTx(ctx, rental, {
      endDate: ctx.payload.endDate,
      reason: ctx.payload.reason,
      setVacant: !!ctx.payload.setVacant,
      reverseLiveMoney: false,
      retainArrears: false,
    });
  },

  /**
   * تجديد شهر — create the next anniversary cycle for the same tenant/rent/space.
   * Idempotent by deterministic rentalCycleId. Never mints a receipt.
   */
  async renewRentalCycle(ctx) {
    const rental = await ctx.tx.get("rentals", ctx.payload.rentalId);
    if (!rental) throw new DomainError("RENTAL_NOT_FOUND");
    if (rental.state !== "active") throw new DomainError("RENTAL_NOT_ACTIVE");
    const space = await ctx.tx.get("spaces", rental.spaceId);
    if (!space || space.occupancy === "vacant" || space.occupancy === "staff") {
      throw new DomainError("SPACE_NOT_RENTED", { spaceId: rental.spaceId });
    }

    const obligations = await ctx.tx.query("obligations", [["rentalId", "==", rental.id]]);
    const cycles = obligations
      .filter((o) => o && o.state !== "cancelled")
      .map((o) => ({
        ...o,
        _start: o.cycleStart || o.dueDate || `${o.period}-01`,
      }))
      .sort((a, b) => String(a._start).localeCompare(String(b._start)));
    if (!cycles.length) throw new DomainError("NO_CYCLE_TO_RENEW", { rentalId: rental.id });

    const latest = cycles[cycles.length - 1];
    const latestStart = assertIsoDate(latest.cycleStart || latest.dueDate || latest._start);
    const anniversaryDay = Number(
      rental.dueDayOfMonth
      || latest.anniversaryDay
      || String(rental.startDate || latestStart).slice(8, 10),
    ) || Number(latestStart.slice(8, 10));
    const nextStart = nextCycleStart(latestStart, 1, anniversaryDay);
    const fields = buildCycleFields({
      rentalId: rental.id,
      cycleStart: nextStart,
      previousCycleId: latest.rentalCycleId || latest.id,
      amountFils: rental.contractualAmountFils,
      tenantName: rental.tenantName,
      anniversaryDay,
    });
    const existing = await ctx.tx.get("obligations", fields.id);
    if (existing) {
      return {
        alreadyApplied: true,
        rentalCycleId: fields.id,
        obligationId: fields.id,
        cycleStart: fields.cycleStart,
        cycleEnd: fields.cycleEnd,
        previousCycleId: fields.previousCycleId,
      };
    }
    const samePeriod = obligations.find((o) => {
      if (!o || o.state !== "active" || o.baselineExcluded === true) return false;
      if (o.period === fields.period) return true;
      const start = String(o.cycleStart || o.dueDate || "").slice(0, 10);
      return /^\d{4}-\d{2}-\d{2}$/.test(start) && cyclePeriod(start) === fields.period;
    });
    if (samePeriod) {
      throw new DomainError("PERIOD_OBLIGATION_EXISTS", {
        obligationId: samePeriod.id, period: fields.period, rentalId: rental.id,
      });
    }
    const spaceRentals = await ctx.tx.query("rentals", [["spaceId", "==", rental.spaceId]]);
    const spaceObligations = await ctx.tx.query("obligations", [["spaceId", "==", rental.spaceId]]);
    const renewConflict = findPeriodCoverageConflict({
      spaceId: rental.spaceId,
      startDate: nextStart,
      rentals: spaceRentals,
      obligations: spaceObligations,
      excludeRentalId: rental.id,
    });
    if (renewConflict) throw new DomainError("PERIOD_ALREADY_COVERED", renewConflict);

    const asOf = assertIsoDate(ctx.payload.asOfDate || ctx.now.slice(0, 10));
    const earlyWindowDays = ctx.payload.earlyWindowDays != null ? ctx.payload.earlyWindowDays : 7;
    if (!renewButtonVisible(nextStart, asOf, earlyWindowDays)) {
      throw new DomainError("CYCLE_NOT_DUE_YET", {
        nextCycleStart: nextStart, asOfDate: asOf, earlyWindowDays,
      });
    }

    ctx.tx.create("obligations", fields.id, {
      id: fields.id,
      rentalCycleId: fields.rentalCycleId,
      rentalId: rental.id,
      propertyId: rental.propertyId,
      unitId: rental.unitId,
      spaceId: rental.spaceId,
      period: fields.period,
      amountFils: fields.amountFils,
      dueDate: fields.dueDate,
      cycleStart: fields.cycleStart,
      cycleEnd: fields.cycleEnd,
      previousCycleId: fields.previousCycleId,
      anniversaryDay: fields.anniversaryDay,
      tenantNameSnapshot: fields.tenantNameSnapshot,
      state: "active",
      ...base(ctx),
    });
    audit(ctx, "rental_cycle_renewed", "obligation", fields.id, {
      rentalId: rental.id,
      previousCycleId: fields.previousCycleId,
      cycleStart: fields.cycleStart,
      cycleEnd: fields.cycleEnd,
      amountFils: fields.amountFils,
      asOfDate: asOf,
    });
    return {
      alreadyApplied: false,
      rentalCycleId: fields.id,
      obligationId: fields.id,
      cycleStart: fields.cycleStart,
      cycleEnd: fields.cycleEnd,
      previousCycleId: fields.previousCycleId,
      amountFils: fields.amountFils,
    };
  },

  /**
   * إخلاء وتحويل لفارغ — end tenancy, keep collection history & holding.
   * Does NOT reverse receipts. Arrears require explicit arrearsDecision:"retain".
   */
  async endTenancy(ctx) {
    const rental = await ctx.tx.get("rentals", ctx.payload.rentalId);
    if (!rental) throw new DomainError("RENTAL_NOT_FOUND");
    if (rental.state === "closed") throw new DomainError("RENTAL_ALREADY_CLOSED");

    const obligations = await ctx.tx.query("obligations", [["rentalId", "==", rental.id]]);
    let arrearsFils = 0;
    for (const ob of obligations) {
      if (ob.state !== "active") continue;
      const receipts = await ctx.tx.query("receipts", [["obligationId", "==", ob.id]]);
      const paid = receipts
        .filter((r) => r.state === RECEIPT_STATE.RECOGNIZED)
        .reduce((s, r) => s + Number(r.amountFils || 0), 0);
      arrearsFils += Math.max(0, Number(ob.amountFils || 0) - paid);
    }
    const decision = ctx.payload.arrearsDecision || "none";
    if (arrearsFils > 0 && decision !== "retain") {
      throw new DomainError("ARREARS_CONFIRMATION_REQUIRED", {
        arrearsFils,
        message: "توجد متأخرات — اختر retain للإخلاء مع الإبقاء على المتأخرات",
      });
    }

    const closed = await closeRentalInTx(ctx, rental, {
      endDate: ctx.payload.endDate,
      reason: ctx.payload.reason,
      setVacant: true,
      reverseLiveMoney: false,
      retainArrears: decision === "retain",
    });
    audit(ctx, "tenancy_ended", "rental", rental.id, {
      reason: ctx.payload.reason,
      arrearsFils,
      arrearsDecision: decision,
      reversedReceiptIds: closed.reversedReceiptIds,
    });
    return { ...closed, arrearsFils, arrearsDecision: decision };
  },

  /* ---------- obligations ---------- */
  /**
   * Ensure each active continuing rental has an unpaid cycle for `period`.
   * First cycle seeds from rental.startDate; later calendar months mint the
   * matching anniversary cycle (idempotent by rentalCycleId). Never copies
   * receipts/payment from a prior month. Closed / vacant / staff skipped.
   */
  async generateObligations(ctx) {
    const period = ctx.payload.period;
    await assertPeriodMutable(ctx, period);
    const rentals = await ctx.tx.query("rentals", [["state", "==", "active"]]);
    const created = [];
    for (const rental of rentals) {
      const space = await ctx.tx.get("spaces", rental.spaceId);
      if (!space || space.active === false) continue;
      if (space.occupancy === "vacant") continue;
      if (space.occupancy === "staff") {
        if (!(Number(space.staffRentFils) > 0) || rental.purpose !== "staff") continue;
      }
      if (isPlaceholderTenant(rental.tenantName)) continue;

      const start = assertIsoDate(rental.startDate);
      const anniversaryDay = Number(rental.dueDayOfMonth) || Number(start.slice(8, 10));
      // Do not invent cycles before the contractual start period.
      if (String(periodOf(start)) > String(period)) continue;

      let cycleStart = start;
      let guard = 0;
      while (cyclePeriod(cycleStart) < period && guard++ < 240) {
        cycleStart = nextCycleStart(cycleStart, 1, anniversaryDay);
      }
      if (cyclePeriod(cycleStart) !== period) continue;

      const existingForRental = await ctx.tx.query("obligations", [["rentalId", "==", rental.id]]);
      const periodHit = (existingForRental || []).find(
        (o) => o && o.state === "active" && o.baselineExcluded !== true && (
          o.period === period
          || cyclePeriod(o.cycleStart || o.dueDate || `${o.period}-01`) === period
        ),
      );
      if (periodHit) continue;

      const spaceRentals = await ctx.tx.query("rentals", [["spaceId", "==", rental.spaceId]]);
      const spaceObligations = await ctx.tx.query("obligations", [["spaceId", "==", rental.spaceId]]);
      const otherCoverage = spaceRentals.some((other) =>
        other && other.id !== rental.id && other.baselineExcluded !== true
        && rentalCoversPeriod(other, period, spaceObligations)
      );
      // A successor that starts after the previous contract ended inside the month
      // is allowed. Block only when another rental still covers this period.
      if (otherCoverage) continue;

      const prior = (existingForRental || [])
        .filter((o) => o && o.state !== "cancelled")
        .map((o) => ({
          ...o,
          _start: o.cycleStart || o.dueDate || `${o.period}-01`,
        }))
        .filter((o) => cyclePeriod(o._start) < period)
        .sort((a, b) => String(a._start).localeCompare(String(b._start)));
      const previousCycleId = prior.length
        ? (prior[prior.length - 1].rentalCycleId || prior[prior.length - 1].id)
        : null;

      const fields = buildCycleFields({
        rentalId: rental.id,
        cycleStart,
        previousCycleId,
        amountFils: space.occupancy === "staff" ? Number(space.staffRentFils) : rental.contractualAmountFils,
        tenantName: rental.tenantName,
        anniversaryDay,
      });
      const legacyId = obligationIdFor(rental.id, period);
      const existing = (await ctx.tx.get("obligations", fields.id))
        || (await ctx.tx.get("obligations", legacyId));
      if (existing) continue;

      ctx.tx.create("obligations", fields.id, {
        id: fields.id,
        rentalCycleId: fields.rentalCycleId,
        rentalId: rental.id,
        propertyId: rental.propertyId,
        unitId: rental.unitId,
        spaceId: rental.spaceId,
        period: fields.period,
        amountFils: fields.amountFils,
        dueDate: fields.dueDate,
        cycleStart: fields.cycleStart,
        cycleEnd: fields.cycleEnd,
        previousCycleId: fields.previousCycleId,
        anniversaryDay: fields.anniversaryDay,
        tenantNameSnapshot: fields.tenantNameSnapshot,
        state: "active",
        ...base(ctx),
      });
      created.push(fields.id);
    }
    audit(ctx, "obligations_generated", "period", period, { count: created.length });
    return { period, created: created.length, obligationIds: created };
  },
  async cancelObligation(ctx) {
    const ob = await ctx.tx.get("obligations", ctx.payload.obligationId);
    if (!ob) throw new DomainError("OBLIGATION_NOT_FOUND");
    if (ob.state !== "active") throw new DomainError("OBLIGATION_NOT_ACTIVE");
    const receipts = await ctx.tx.query("receipts", [["obligationId", "==", ob.id]]);
    const live = receipts.filter((r) => r.state === RECEIPT_STATE.RECOGNIZED || r.state === RECEIPT_STATE.PENDING);
    // Refusing beats orphaning money: reverse the receipts first, deliberately.
    if (live.length) throw new DomainError("OBLIGATION_HAS_RECEIPTS", { count: live.length });
    ctx.tx.update("obligations", ob.id, {
      state: "cancelled", cancelledBy: ctx.actor.userId, cancelledAt: ctx.now, cancelReason: ctx.payload.reason,
    });
    audit(ctx, "obligation_cancelled", "obligation", ob.id, { reason: ctx.payload.reason });
    return { obligationId: ob.id };
  },

  /* ---------- receipts ---------- */
  async createCashReceipt(ctx) {
    const collectorUserId = await collectorFor(ctx);
    return createReceipt(ctx, {
      method: "cash",
      state: RECEIPT_STATE.RECOGNIZED,     // D6: employee cash is recognized immediately
      collectorUserId,
    });
  },
  /**
   * Daily booking cash — no obligation document. Synthetic obligationId "daily:"+bookingId
   * so Holding/Collected still count recognized cash via sharedHoldingFils / periodSummary.
   */
  async createDailyCashReceipt(ctx) {
    await assertEmployeePeriodOpen(ctx, ctx.payload.period);
    const collectorUserId = await collectorFor(ctx);
    const bookingId = ctx.payload.bookingId;
    const periodDoc = await ctx.tx.get("uiPeriods", `period:${ctx.payload.period}`);
    let extras = {};
    if (periodDoc) {
      try {
        extras = typeof periodDoc.extrasJson === "string"
          ? JSON.parse(periodDoc.extrasJson || "{}")
          : (periodDoc.extras || {});
      } catch { extras = periodDoc.extras || {}; }
    }
    const booking = (extras.dailyBookings || []).find((b) => b && String(b.id) === String(bookingId));
    if (booking && String(booking.status || "") !== "cancelled") {
      const expectedFils = Math.round(Number(booking.total) * 100);
      if (!Number.isFinite(expectedFils) || expectedFils <= 0 || ctx.payload.amountFils !== expectedFils) {
        throw new DomainError("BOOKING_AMOUNT_MISMATCH", {
          bookingTotalFils: expectedFils, amountFils: ctx.payload.amountFils,
        });
      }
    }
    // Idempotent: one recognized cash receipt per daily booking.
    const existing = await ctx.tx.query("receipts", [["obligationId", "==", `daily:${bookingId}`]]);
    const live = (existing || []).find(
      (r) => r && r.state === RECEIPT_STATE.RECOGNIZED && r.sourceType === "daily_booking",
    );
    if (live) {
      return {
        receiptId: live.id, state: RECEIPT_STATE.RECOGNIZED, method: "cash",
        bookingId, alreadyApplied: true,
      };
    }
    const id = newId("rcpt", ctx);
    ctx.tx.create("receipts", id, {
      id,
      obligationId: `daily:${bookingId}`,
      rentalId: null,
      propertyId: null,
      unitId: null,
      spaceId: null,
      period: ctx.payload.period,
      tenantNameSnapshot: ctx.payload.note || "حجز يومي",
      amountFils: ctx.payload.amountFils,
      collectionDate: ctx.payload.collectionDate,
      note: ctx.payload.note || null,
      method: "cash",
      state: RECEIPT_STATE.RECOGNIZED,
      collectorUserId,
      sourceType: "daily_booking",
      bookingId,
      ...base(ctx),
    });
    audit(ctx, "daily_cash_receipt_created", "receipt", id, {
      amountFils: ctx.payload.amountFils, bookingId, method: "cash",
    });
    return { receiptId: id, state: RECEIPT_STATE.RECOGNIZED, method: "cash", bookingId };
  },

  /**
   * Atomic prepaid daily booking: one booking in uiPeriods + one recognized cash receipt.
   * Daily rentals are always prepaid — Save means full amount already received.
   * Holding/Target/Collected follow the same canonical `period` as the daily Target engine
   * (viewing-month extras period — not browser "today").
   */
  async createDailyBookingPrepaid(ctx) {
    const period = ctx.payload.period;
    await assertEmployeePeriodOpen(ctx, period);
    assertPositiveFils(ctx.payload.amountFils, "INVALID_AMOUNT");
    let booking;
    try {
      booking = JSON.parse(ctx.payload.bookingJson);
    } catch {
      throw new DomainError("INVALID_BOOKING_JSON");
    }
    if (!booking || typeof booking !== "object") throw new DomainError("INVALID_BOOKING");
    const bookingId = String(booking.id || ctx.operationId || "").slice(0, 120);
    if (!bookingId) throw new DomainError("BOOKING_ID_REQUIRED");
    const totalFils = Number(ctx.payload.amountFils);
    const bookingTotal = parseAedToFils(booking.total);
    if (bookingTotal != null && bookingTotal !== totalFils) {
      throw new DomainError("BOOKING_AMOUNT_MISMATCH", {
        bookingTotalFils: bookingTotal, amountFils: totalFils,
      });
    }

    const periodDocId = `period:${period}`;
    const existingPeriod = await ctx.tx.get("uiPeriods", periodDocId);
    let extras = {};
    if (existingPeriod) {
      try {
        extras = typeof existingPeriod.extrasJson === "string"
          ? JSON.parse(existingPeriod.extrasJson || "{}")
          : (existingPeriod.extras || {});
      } catch { extras = existingPeriod.extras || {}; }
    }
    const list = Array.isArray(extras.dailyBookings) ? extras.dailyBookings.slice() : [];
    const priorIdx = list.findIndex((b) => b && String(b.id) === bookingId);
    const prior = priorIdx >= 0 ? list[priorIdx] : null;

    const existingRcpts = await ctx.tx.query("receipts", [["obligationId", "==", `daily:${bookingId}`]]);
    const liveRcpt = (existingRcpts || []).find(
      (r) => r && r.state === RECEIPT_STATE.RECOGNIZED && r.sourceType === "daily_booking",
    );

    if (prior && liveRcpt) {
      return {
        bookingId, receiptId: liveRcpt.id, period,
        state: RECEIPT_STATE.RECOGNIZED, alreadyApplied: true,
      };
    }

    const collectorUserId = await collectorFor(ctx);
    let receiptId = liveRcpt ? liveRcpt.id : null;
    if (!liveRcpt) {
      receiptId = newId("rcpt", ctx);
      ctx.tx.create("receipts", receiptId, {
        id: receiptId,
        obligationId: `daily:${bookingId}`,
        rentalId: null, propertyId: null, unitId: null, spaceId: null,
        period,
        tenantNameSnapshot: String(booking.guest || ctx.payload.note || "حجز يومي").slice(0, 160),
        amountFils: totalFils,
        collectionDate: ctx.payload.collectionDate,
        note: ctx.payload.note || String(booking.guest || "حجز يومي").slice(0, 300),
        method: "cash",
        state: RECEIPT_STATE.RECOGNIZED,
        collectorUserId,
        sourceType: "daily_booking",
        bookingId,
        ...base(ctx),
      });
    }

    const row = {
      ...(prior || {}),
      ...booking,
      id: bookingId,
      total: Number(booking.total) || totalFils / 100,
      paymentStatus: "collected",
      receiptId,
      prepaid: true,
      by: booking.by || ctx.actor.userId,
    };
    if (priorIdx >= 0) list[priorIdx] = row;
    else list.push(row);
    extras.dailyBookings = list;
    const rec = {
      id: periodDocId,
      period,
      extrasJson: JSON.stringify(extras),
      updatedAt: ctx.now,
      updatedBy: ctx.actor.userId,
      schemaVersion: 1,
    };
    if (existingPeriod) ctx.tx.update("uiPeriods", periodDocId, rec);
    else ctx.tx.create("uiPeriods", periodDocId, { ...rec, ...base(ctx) });

    audit(ctx, "daily_booking_prepaid", "receipt", receiptId, {
      amountFils: totalFils, bookingId, period, method: "cash",
    });
    return {
      bookingId, receiptId, period,
      state: RECEIPT_STATE.RECOGNIZED, alreadyApplied: false,
    };
  },
  async submitBankReceipt(ctx) {
    const collectorUserId = await collectorFor(ctx);
    return createReceipt(ctx, {
      method: "bank",
      state: RECEIPT_STATE.PENDING,        // pending affects nothing until owner approval
      collectorUserId,
      bankReference: ctx.payload.bankReference,
    });
  },
  async approveBankReceipt(ctx) {
    const receipt = await ctx.tx.get("receipts", ctx.payload.receiptId);
    if (!receipt) throw new DomainError("RECEIPT_NOT_FOUND");
    if (receipt.state !== RECEIPT_STATE.PENDING) throw new DomainError("RECEIPT_NOT_PENDING", { state: receipt.state });

    // Re-check the fit at approval time: the obligation may have been paid meanwhile.
    const ob = await ctx.tx.get("obligations", receipt.obligationId);
    const siblings = await ctx.tx.query("receipts", [["obligationId", "==", receipt.obligationId]]);
    assertReceiptFits({
      obligation: ob,
      receipts: siblings.filter((r) => r.id !== receipt.id),
      amountFils: receipt.amountFils,
      asOfDate: ctx.now.slice(0, 10),
    });

    ctx.tx.update("receipts", receipt.id, {
      state: RECEIPT_STATE.RECOGNIZED, approvedBy: ctx.actor.userId, approvedAt: ctx.now,
    });
    await creditRevenueAccount(ctx, {
      amountFils: receipt.amountFils,
      sourceType: "bank_receipt",
      sourceId: receipt.id,
      note: "تحويل بنكي معتمد",
    });
    audit(ctx, "bank_receipt_approved", "receipt", receipt.id, { amountFils: receipt.amountFils });
    return { receiptId: receipt.id, state: RECEIPT_STATE.RECOGNIZED };
  },
  async rejectBankReceipt(ctx) {
    const receipt = await ctx.tx.get("receipts", ctx.payload.receiptId);
    if (!receipt) throw new DomainError("RECEIPT_NOT_FOUND");
    if (receipt.state !== RECEIPT_STATE.PENDING) throw new DomainError("RECEIPT_NOT_PENDING");
    ctx.tx.update("receipts", receipt.id, {
      state: RECEIPT_STATE.REJECTED, rejectedBy: ctx.actor.userId, rejectedAt: ctx.now,
      rejectReason: ctx.payload.reason,
    });
    audit(ctx, "bank_receipt_rejected", "receipt", receipt.id, { reason: ctx.payload.reason });
    return { receiptId: receipt.id, state: RECEIPT_STATE.REJECTED };
  },
  /** Corrections never edit or delete. The original stays, visibly reversed. */
  async reverseReceipt(ctx) {
    const receipt = await ctx.tx.get("receipts", ctx.payload.receiptId);
    if (!receipt) throw new DomainError("RECEIPT_NOT_FOUND");
    if (receipt.state === RECEIPT_STATE.REVERSED) throw new DomainError("ALREADY_REVERSED");
    if (receipt.state !== RECEIPT_STATE.RECOGNIZED) throw new DomainError("RECEIPT_NOT_RECOGNIZED", { state: receipt.state });
    await assertPeriodMutable(ctx, receipt.period);

    const replacement = ctx.payload.replacementAmountFils;
    if (replacement != null && receipt.method !== "cash") {
      throw new DomainError("INVALID_CORRECTION", { method: receipt.method });
    }
    if (replacement != null && (replacement <= 0 || replacement >= receipt.amountFils)) {
      throw new DomainError("INVALID_CORRECTION", {
        originalAmountFils: receipt.amountFils, replacementAmountFils: replacement,
      });
    }
    // Shared-pool safety. A replacement is judged on the end state, so a 200 AED
    // reduction is not refused just because removing the whole receipt would be.
    // Either way, approved deposits are left untouched and a negative pool is refused.
    if (receipt.method === "cash") {
      const allReceipts = await ctx.tx.query("receipts", []);
      const allDeposits = await ctx.tx.query("deposits", []);
      if (replacement != null) {
        assertCashAdjustmentFitsSharedHolding({
          receipts: allReceipts, deposits: allDeposits,
          receiptId: receipt.id, nextAmountFils: replacement,
        });
      } else {
        assertCashReversalFitsSharedHolding({
          receipts: allReceipts,
          deposits: allDeposits,
          reversingReceiptIds: [receipt.id],
        });
      }
    }

    const reversalId = newId("rev", ctx);
    ctx.tx.create("reversals", reversalId, {
      id: reversalId, targetType: "receipt", targetId: receipt.id,
      amountFils: receipt.amountFils, reason: ctx.payload.reason,
      replacementAmountFils: replacement ?? null, ...base(ctx),
    });
    ctx.tx.update("receipts", receipt.id, {
      state: RECEIPT_STATE.REVERSED, reversedByReversalId: reversalId, reversedAt: ctx.now,
    });
    let replacementReceiptId = null;
    if (replacement != null) {
      replacementReceiptId = newId("rcpt", ctx);
      ctx.tx.create("receipts", replacementReceiptId, {
        id: replacementReceiptId,
        obligationId: receipt.obligationId, rentalId: receipt.rentalId,
        propertyId: receipt.propertyId, unitId: receipt.unitId, spaceId: receipt.spaceId,
        period: receipt.period, tenantNameSnapshot: receipt.tenantNameSnapshot,
        amountFils: replacement, collectionDate: receipt.collectionDate,
        method: receipt.method, state: RECEIPT_STATE.RECOGNIZED,
        collectorUserId: receipt.collectorUserId,
        replacesReceiptId: receipt.id, note: ctx.payload.reason, ...base(ctx),
      });
      audit(ctx, "cash_receipt_created", "receipt", replacementReceiptId, {
        amountFils: replacement, obligationId: receipt.obligationId, method: receipt.method,
        collectorUserId: receipt.collectorUserId, replacesReceiptId: receipt.id,
      });
    }
    if (receipt.method === "bank") {
      await debitRevenueAccount(ctx, {
        amountFils: receipt.amountFils,
        sourceType: "bank_receipt",
        sourceId: receipt.id,
        note: ctx.payload.reason,
      });
    }
    audit(ctx, "receipt_reversed", "receipt", receipt.id, {
      amountFils: receipt.amountFils, reason: ctx.payload.reason, reversalId, replacementReceiptId,
    });
    return { receiptId: receipt.id, reversalId, replacementReceiptId };
  },

  /**
   * Put a reversed receipt back to recognized. The same document is restored:
   * amount, collection date, collector, and period stay as they were.
   * The reversal document stays for audit. Deposits are not rewritten.
   * A second recognized receipt is never created.
   */
  async restoreReversedReceipt(ctx) {
    const receipt = await ctx.tx.get("receipts", ctx.payload.receiptId);
    if (!receipt) throw new DomainError("RECEIPT_NOT_FOUND");
    if (receipt.state === RECEIPT_STATE.RECOGNIZED && receipt.restoredAt) {
      throw new DomainError("ALREADY_RESTORED");
    }
    if (receipt.state !== RECEIPT_STATE.REVERSED) {
      throw new DomainError("RECEIPT_NOT_REVERSED", { state: receipt.state });
    }
    const reversals = await ctx.tx.query("reversals", [["targetId", "==", receipt.id]]);
    const reversal = (reversals || []).find((row) => row && row.targetType === "receipt");
    if (!reversal) throw new DomainError("REVERSAL_NOT_FOUND");
    if (Number(reversal.amountFils) !== Number(receipt.amountFils)) {
      throw new DomainError("RESTORATION_AMOUNT_MISMATCH", {
        receiptAmountFils: receipt.amountFils,
        reversalAmountFils: reversal.amountFils,
      });
    }
    if (receipt.obligationId) {
      const ob = await ctx.tx.get("obligations", receipt.obligationId);
      if (!ob || ob.state !== "active") throw new DomainError("OBLIGATION_NOT_ACTIVE");
      const siblings = await ctx.tx.query("receipts", [["obligationId", "==", receipt.obligationId]]);
      const otherPaid = (siblings || [])
        .filter((row) => row && row.id !== receipt.id && row.state === RECEIPT_STATE.RECOGNIZED)
        .reduce((sum, row) => sum + Number(row.amountFils || 0), 0);
      if (otherPaid + Number(receipt.amountFils) > Number(ob.amountFils || 0)) {
        throw new DomainError("AMOUNT_EXCEEDS_REMAINING");
      }
    }
    ctx.tx.update("receipts", receipt.id, {
      state: RECEIPT_STATE.RECOGNIZED,
      restoredAt: ctx.now,
      restoredBy: ctx.actor.userId,
      restoreReason: ctx.payload.reason,
      restoredFromReversalId: reversal.id,
    });
    if (receipt.method === "bank") {
      await creditRevenueAccount(ctx, {
        amountFils: receipt.amountFils,
        sourceType: "bank_receipt_restore",
        sourceId: receipt.id,
        note: ctx.payload.reason,
      });
    }
    audit(ctx, "receipt_restored", "receipt", receipt.id, {
      amountFils: receipt.amountFils,
      collectionDate: receipt.collectionDate,
      period: receipt.period,
      collectorUserId: receipt.collectorUserId || null,
      reversalId: reversal.id,
      reason: ctx.payload.reason,
    });
    return {
      receiptId: receipt.id,
      amountFils: receipt.amountFils,
      collectionDate: receipt.collectionDate,
      period: receipt.period,
      restored: true,
    };
  },

  /**
   * Owner correction: reverse every recognized receipt on an obligation so the
   * derived status returns to late/unpaid. Status is never stored — money moves.
   */
  async uncollectObligation(ctx) {
    const ob = await ctx.tx.get("obligations", ctx.payload.obligationId);
    if (!ob) throw new DomainError("OBLIGATION_NOT_FOUND");
    await assertEmployeePeriodOpen(ctx, ob.period);
    await assertPeriodMutable(ctx, ob.period);
    const receipts = await ctx.tx.query("receipts", [["obligationId", "==", ob.id]]);
    const live = receipts.filter((r) => r.state === RECEIPT_STATE.RECOGNIZED);
    const cashLive = live.filter((r) => r.method === "cash");
    if (cashLive.length) {
      const allReceipts = await ctx.tx.query("receipts", []);
      const allDeposits = await ctx.tx.query("deposits", []);
      assertCashReversalFitsSharedHolding({
        receipts: allReceipts,
        deposits: allDeposits,
        reversingReceiptIds: cashLive.map((r) => r.id),
      });
    }
    const reversalIds = [];
    for (const receipt of live) {
      const reversalId = `rev:${ctx.operationId}:${receipt.id}`.slice(0, 140);
      ctx.tx.create("reversals", reversalId, {
        id: reversalId, targetType: "receipt", targetId: receipt.id,
        amountFils: receipt.amountFils, reason: ctx.payload.reason, ...base(ctx),
      });
      ctx.tx.update("receipts", receipt.id, {
        state: RECEIPT_STATE.REVERSED, reversedByReversalId: reversalId, reversedAt: ctx.now,
      });
      // Mirror reverseReceipt: bank money left the revenue ledger on approve — debit it back.
      if (receipt.method === "bank") {
        await debitRevenueAccount(ctx, {
          amountFils: receipt.amountFils,
          sourceType: "bank_receipt",
          sourceId: receipt.id,
          note: ctx.payload.reason,
        });
      }
      audit(ctx, "receipt_reversed", "receipt", receipt.id, {
        amountFils: receipt.amountFils, reason: ctx.payload.reason, reversalId,
      });
      reversalIds.push(reversalId);
    }
    audit(ctx, "obligation_uncollected", "obligation", ob.id, { count: reversalIds.length, reason: ctx.payload.reason });
    return { obligationId: ob.id, reversed: reversalIds.length, reversalIds };
  },

  /* ---------- deposits ---------- */
  async submitDeposit(ctx) {
    const account = await ctx.tx.get("accounts", ctx.payload.destinationAccountId);
    if (!account || account.active === false) throw new DomainError("ACCOUNT_NOT_FOUND");

    const employeeId = await depositEmployeeFor(ctx);
    const sourceKind = ctx.payload.sourceKind || "holding";
    // Accounting period (list/P&L) is independent of depositDate.
    // Prefer explicit period; else sourcePeriod; else legacy periodOf(depositDate).
    const accountingPeriod = (ctx.payload.period && PERIOD_RE.test(String(ctx.payload.period)))
      ? String(ctx.payload.period)
      : null;
    // Holding deposits must name the source period they reduce. Never infer from "today".
    const sourcePeriod = sourceKind === "external"
      ? (ctx.payload.sourcePeriod || accountingPeriod || periodOf(ctx.payload.depositDate))
      : (ctx.payload.sourcePeriod || accountingPeriod || periodOf(ctx.payload.depositDate));
    if (sourceKind !== "external" && !PERIOD_RE.test(String(sourcePeriod || ""))) {
      throw new DomainError("SOURCE_PERIOD_REQUIRED", { sourcePeriod });
    }
    const listPeriod = accountingPeriod || sourcePeriod || periodOf(ctx.payload.depositDate);
    await assertEmployeePeriodOpen(ctx, listPeriod);
    await assertPeriodMutable(ctx, listPeriod);
    const receipts = await ctx.tx.query("receipts", []);
    const deposits = await ctx.tx.query("deposits", []);
    // Holding deposits must fit Holding(sourcePeriod) only. External does not reduce Holding.
    if (sourceKind !== "external") {
      assertDepositFitsCustody({
        employeeId, amountFils: ctx.payload.amountFils, receipts, deposits, sourcePeriod,
      });
    }

    const id = newId("dep", ctx);
    const approved = ctx.actor.role === "owner";
    ctx.tx.create("deposits", id, {
      id,
      employeeId,
      amountFils: ctx.payload.amountFils,
      depositDate: ctx.payload.depositDate,
      period: listPeriod,
      sourcePeriod,
      destinationAccountId: account.id,
      note: ctx.payload.note || null, reference: ctx.payload.reference || null,
      sourceKind,
      state: approved ? APPROVAL_STATE.APPROVED : APPROVAL_STATE.PENDING,
      ...(approved ? { approvedBy: ctx.actor.userId, approvedAt: ctx.now } : {}),
      ...base(ctx),
    });
    audit(ctx, "deposit_submitted", "deposit", id, {
      amountFils: ctx.payload.amountFils, sourceKind, sourcePeriod, period: listPeriod,
    });
    if (approved) {
      await creditRevenueAccount(ctx, {
        amountFils: ctx.payload.amountFils,
        sourceType: "deposit",
        sourceId: id,
        note: "إيداع معتمد (مدير)",
        accountId: account.id,
      });
    }
    return {
      depositId: id,
      state: approved ? APPROVAL_STATE.APPROVED : APPROVAL_STATE.PENDING,
      sourcePeriod,
      period: listPeriod,
    };
  },
  async approveDeposit(ctx) {
    const dep = await ctx.tx.get("deposits", ctx.payload.depositId);
    if (!dep) throw new DomainError("DEPOSIT_NOT_FOUND");
    if (dep.state !== APPROVAL_STATE.PENDING) throw new DomainError("DEPOSIT_NOT_PENDING", { state: dep.state });

    // Same Firestore transaction: refuse if amount exceeds Holding for the deposit's source period.
    // External deposits never drew from Holding — skip custody check.
    if (dep.sourceKind !== "external") {
      const receipts = await ctx.tx.query("receipts", []);
      const deposits = await ctx.tx.query("deposits", []);
      const sourcePeriod = depositSourcePeriod(dep) || dep.period;
      assertDepositFitsCustody({
        employeeId: dep.employeeId, amountFils: dep.amountFils,
        receipts, deposits: deposits.filter((d) => d.id !== dep.id),
        sourcePeriod,
      });
      // Persist sourcePeriod on approve when legacy pending deposit lacked it.
      if (!dep.sourcePeriod && sourcePeriod) {
        ctx.tx.update("deposits", dep.id, { sourcePeriod });
      }
    }

    ctx.tx.update("deposits", dep.id, {
      state: APPROVAL_STATE.APPROVED, approvedBy: ctx.actor.userId, approvedAt: ctx.now,
    });
    await creditRevenueAccount(ctx, {
      amountFils: dep.amountFils,
      sourceType: "deposit",
      sourceId: dep.id,
      note: "اعتماد إيداع موظف",
      accountId: dep.destinationAccountId,
    });
    audit(ctx, "deposit_approved", "deposit", dep.id, { amountFils: dep.amountFils, employeeId: dep.employeeId });
    return { depositId: dep.id, state: APPROVAL_STATE.APPROVED };
  },
  async rejectDeposit(ctx) {
    const dep = await ctx.tx.get("deposits", ctx.payload.depositId);
    if (!dep) throw new DomainError("DEPOSIT_NOT_FOUND");
    if (dep.state !== APPROVAL_STATE.PENDING) throw new DomainError("DEPOSIT_NOT_PENDING");
    ctx.tx.update("deposits", dep.id, {
      state: APPROVAL_STATE.REJECTED, rejectedBy: ctx.actor.userId, rejectedAt: ctx.now,
      rejectReason: ctx.payload.reason,
    });
    audit(ctx, "deposit_rejected", "deposit", dep.id, { reason: ctx.payload.reason });
    return { depositId: dep.id, state: APPROVAL_STATE.REJECTED };
  },
  async reverseDeposit(ctx) {
    const dep = await ctx.tx.get("deposits", ctx.payload.depositId);
    if (!dep) throw new DomainError("DEPOSIT_NOT_FOUND");
    if (dep.state === APPROVAL_STATE.REVERSED) throw new DomainError("ALREADY_REVERSED");
    if (dep.state !== APPROVAL_STATE.APPROVED) throw new DomainError("DEPOSIT_NOT_APPROVED", { state: dep.state });
    const reversalId = newId("rev", ctx);
    ctx.tx.create("reversals", reversalId, {
      id: reversalId, targetType: "deposit", targetId: dep.id,
      amountFils: dep.amountFils, reason: ctx.payload.reason, ...base(ctx),
    });
    ctx.tx.update("deposits", dep.id, {
      state: APPROVAL_STATE.REVERSED, reversedByReversalId: reversalId, reversedAt: ctx.now,
    });
    await debitRevenueAccount(ctx, {
      amountFils: dep.amountFils,
      sourceType: "deposit",
      sourceId: dep.id,
      note: ctx.payload.reason,
      accountId: dep.destinationAccountId,
    });
    audit(ctx, "deposit_reversed", "deposit", dep.id, { amountFils: dep.amountFils, reversalId });
    return { depositId: dep.id, reversalId };
  },

  /* ---------- expenses ---------- */
  async submitExpense(ctx) {
    // Accounting period is independent of expenseDate (invoice may arrive in a later month).
    const accountingPeriod = (ctx.payload.period && PERIOD_RE.test(String(ctx.payload.period)))
      ? String(ctx.payload.period)
      : periodOf(ctx.payload.expenseDate);
    await assertEmployeePeriodOpen(ctx, accountingPeriod);
    const account = await ctx.tx.get("accounts", ctx.payload.paidFromAccountId);
    if (!account || account.active === false) throw new DomainError("ACCOUNT_NOT_FOUND");
    const id = newId("exp", ctx);
    const approved = ctx.actor.role === "owner";
    const maintenanceLinkId = ctx.payload.maintenanceLinkId || null;
    const requestedBy = ctx.payload.requestedBy || null;
    ctx.tx.create("expenses", id, {
      id, amountFils: ctx.payload.amountFils, reason: ctx.payload.reason,
      category: ctx.payload.category, expenseDate: ctx.payload.expenseDate,
      period: accountingPeriod,
      paidFromAccountId: account.id, submittedBy: ctx.actor.userId,
      maintenanceLinkId,
      requestedBy,
      state: approved ? APPROVAL_STATE.APPROVED : APPROVAL_STATE.PENDING,
      ...(approved ? { approvedBy: ctx.actor.userId, approvedAt: ctx.now } : {}),
      ...base(ctx),
    });
    audit(ctx, "expense_submitted", "expense", id, {
      amountFils: ctx.payload.amountFils, maintenanceLinkId, requestedBy, period: accountingPeriod,
    });
    // Recognized expenses are paid from حساب الإيرادات exactly once.
    if (approved) {
      await debitRevenueAccount(ctx, {
        amountFils: ctx.payload.amountFils,
        sourceType: "expense",
        sourceId: id,
        note: ctx.payload.reason || "مصروف",
        accountId: account.id,
        requirePriorCredit: false,
      });
    }
    return {
      expenseId: id,
      state: approved ? APPROVAL_STATE.APPROVED : APPROVAL_STATE.PENDING,
      period: accountingPeriod,
    };
  },
  async approveExpense(ctx) {
    const exp = await ctx.tx.get("expenses", ctx.payload.expenseId);
    if (!exp) throw new DomainError("EXPENSE_NOT_FOUND");
    if (exp.state !== APPROVAL_STATE.PENDING) throw new DomainError("EXPENSE_NOT_PENDING", { state: exp.state });
    ctx.tx.update("expenses", exp.id, {
      state: APPROVAL_STATE.APPROVED, approvedBy: ctx.actor.userId, approvedAt: ctx.now,
    });
    await debitRevenueAccount(ctx, {
      amountFils: exp.amountFils,
      sourceType: "expense",
      sourceId: exp.id,
      note: exp.reason || "اعتماد مصروف",
      accountId: exp.paidFromAccountId,
      requirePriorCredit: false,
    });
    audit(ctx, "expense_approved", "expense", exp.id, { amountFils: exp.amountFils });
    return { expenseId: exp.id, state: APPROVAL_STATE.APPROVED };
  },
  async rejectExpense(ctx) {
    const exp = await ctx.tx.get("expenses", ctx.payload.expenseId);
    if (!exp) throw new DomainError("EXPENSE_NOT_FOUND");
    if (exp.state !== APPROVAL_STATE.PENDING) throw new DomainError("EXPENSE_NOT_PENDING");
    ctx.tx.update("expenses", exp.id, {
      state: APPROVAL_STATE.REJECTED, rejectedBy: ctx.actor.userId, rejectedAt: ctx.now,
      rejectReason: ctx.payload.reason,
    });
    audit(ctx, "expense_rejected", "expense", exp.id, { reason: ctx.payload.reason });
    return { expenseId: exp.id, state: APPROVAL_STATE.REJECTED };
  },
  async reverseExpense(ctx) {
    const exp = await ctx.tx.get("expenses", ctx.payload.expenseId);
    if (!exp) throw new DomainError("EXPENSE_NOT_FOUND");
    if (exp.state === APPROVAL_STATE.REVERSED) throw new DomainError("ALREADY_REVERSED");
    if (exp.state !== APPROVAL_STATE.APPROVED) throw new DomainError("EXPENSE_NOT_APPROVED");
    const reversalId = newId("rev", ctx);
    ctx.tx.create("reversals", reversalId, {
      id: reversalId, targetType: "expense", targetId: exp.id,
      amountFils: exp.amountFils, reason: ctx.payload.reason, ...base(ctx),
    });
    ctx.tx.update("expenses", exp.id, {
      state: APPROVAL_STATE.REVERSED, reversedByReversalId: reversalId, reversedAt: ctx.now,
    });
    // Restore Revenue only if this expense previously debited it (idempotent credit).
    const debitId = (`ledger:expense:${exp.id}:debit`).slice(0, 140);
    if (await ctx.tx.get("ledgerEntries", debitId)) {
      await creditRevenueAccount(ctx, {
        amountFils: exp.amountFils,
        sourceType: "expense",
        sourceId: exp.id,
        note: ctx.payload.reason || "عكس مصروف",
        accountId: exp.paidFromAccountId,
      });
    }
    audit(ctx, "expense_reversed", "expense", exp.id, { reversalId });
    return { expenseId: exp.id, reversalId };
  },

  /* ---------- accounts (D4) ---------- */
  async createAccount(ctx) {
    const id = newId("acc", ctx);
    ctx.tx.create("accounts", id, { id, ...ctx.payload, active: true, ...base(ctx) });
    audit(ctx, "account_created", "account", id);
    return { accountId: id };
  },
  async updateAccount(ctx) {
    const { accountId, ...patch } = ctx.payload;
    const doc = await ctx.tx.get("accounts", accountId);
    if (!doc) throw new DomainError("ACCOUNT_NOT_FOUND");
    ctx.tx.update("accounts", accountId, patch);
    audit(ctx, "account_updated", "account", accountId);
    return { accountId };
  },

  /* ---------- users ---------- */
  async createUser(ctx) {
    const id = newId("user", ctx);
    const { hash, salt } = await ctx.tx.hashPin(ctx.payload.pin);
    ctx.tx.create("users", id, {
      id, userId: id, displayName: ctx.payload.displayName, role: ctx.payload.role,
      active: true, pinHash: hash, pinSalt: salt, pinUpdatedAt: ctx.now, ...base(ctx),
    });
    audit(ctx, "user_created", "user", id, { role: ctx.payload.role });
    return { userId: id };
  },
  async updateUser(ctx) {
    const { userId, ...patch } = ctx.payload;
    const doc = await ctx.tx.get("users", userId);
    if (!doc) throw new DomainError("USER_NOT_FOUND");
    ctx.tx.update("users", userId, patch);
    audit(ctx, "user_updated", "user", userId, { before: { role: doc.role, active: doc.active }, after: patch });
    return { userId };
  },
  async setUserPin(ctx) {
    const doc = await ctx.tx.get("users", ctx.payload.userId);
    if (!doc) throw new DomainError("USER_NOT_FOUND");
    const { hash, salt } = await ctx.tx.hashPin(ctx.payload.pin);
    ctx.tx.update("users", doc.id, { pinHash: hash, pinSalt: salt, pinUpdatedAt: ctx.now });
    audit(ctx, "user_pin_changed", "user", doc.id);   // never records the PIN itself
    return { userId: doc.id };
  },
  async deactivateUser(ctx) {
    const doc = await ctx.tx.get("users", ctx.payload.userId);
    if (!doc) throw new DomainError("USER_NOT_FOUND");
    if (doc.id === ctx.actor.userId) throw new DomainError("CANNOT_DEACTIVATE_SELF");
    ctx.tx.update("users", doc.id, { active: false });
    audit(ctx, "user_deactivated", "user", doc.id);
    return { userId: doc.id };
  },

  async upsertUiConfig(ctx) {
    const id = ctx.payload.configId;
    parseJsonField(ctx.payload.json, "json");
    let jsonOut = ctx.payload.json;
    const existing = await ctx.tx.get("uiConfig", id);
    let beforeRev = null;
    let afterRev = null;
    if (id === "balances") {
      try {
        const prevObj = existing ? JSON.parse(existing.json || "{}") : {};
        const nextObj = JSON.parse(ctx.payload.json || "{}");
        beforeRev = Number(prevObj.revenueBalance);
        afterRev = Number(nextObj.revenueBalance);
        // Guard: upsertUiConfig must not silently unpay / restore deduction balance.
        // Only payInstallment / reverseInstallment may flip paid or debit/credit that ledger.
        const prevSched = Array.isArray(prevObj.installmentSchedule) ? prevObj.installmentSchedule : [];
        const prevPays = Array.isArray(prevObj.installmentPayments) ? prevObj.installmentPayments : [];
        let nextSched = Array.isArray(nextObj.installmentSchedule) ? nextObj.installmentSchedule.slice() : null;
        let nextPays = Array.isArray(nextObj.installmentPayments) ? nextObj.installmentPayments.slice() : null;
        if (nextSched == null) nextSched = prevSched.slice();
        if (nextPays == null) nextPays = prevPays.slice();
        if (nextObj.installmentBalance == null && prevObj.installmentBalance != null) {
          nextObj.installmentBalance = prevObj.installmentBalance;
        }
        const prevByDate = new Map(prevSched.map((r) => [String(r && r.date), r]));
        let blockedUnpay = false;
        for (let i = 0; i < nextSched.length; i++) {
          const row = nextSched[i] || {};
          const prev = prevByDate.get(String(row.date));
          if (prev && prev.paid && !row.paid) {
            nextSched[i] = { ...prev };
            blockedUnpay = true;
          }
        }
        for (const p of prevPays) {
          if (!p || p.state !== "applied") continue;
          if (!nextPays.some((x) => x && x.id === p.id && x.state === "applied")) {
            nextPays.push(p);
            blockedUnpay = true;
          }
        }
        if (blockedUnpay) {
          const prevBal = Number(prevObj.installmentBalance || 0);
          const nextBal = Number(nextObj.installmentBalance);
          if (Number.isFinite(nextBal) && nextBal > prevBal) {
            nextObj.installmentBalance = prevBal;
          }
        }
        nextObj.installmentSchedule = nextSched;
        nextObj.installmentPayments = nextPays;
        jsonOut = JSON.stringify(nextObj);
      } catch { /* ignore parse */ }
    }
    const rec = {
      id, json: jsonOut, updatedAt: ctx.now, updatedBy: ctx.actor.userId, schemaVersion: 1,
    };
    if (existing) ctx.tx.update("uiConfig", id, rec);
    else ctx.tx.create("uiConfig", id, { ...rec, ...base(ctx) });
    if (id === "balances" && beforeRev != null && afterRev != null && beforeRev !== afterRev) {
      audit(ctx, "revenue_balance_manual_adjust", "uiConfig", "balances:revenue", {
        beforeAed: beforeRev,
        afterAed: afterRev,
        deltaAed: Math.round((afterRev - beforeRev) * 100) / 100,
        reason: "تعديل يدوي من المالية",
      });
    } else {
      audit(ctx, "ui_config_upserted", "uiConfig", id);
    }
    return { configId: id };
  },

  /**
   * Atomic installment pay: mark one schedule row paid + debit installmentBalance.
   * Concurrent sessions / lost-response retries are safe via operationId + paid guard
   * + stable paymentId `instpay:YYYY-MM-DD` (never Date.now()).
   * Plan is open-ended: after paying the last unpaid row, append the next quarterly row.
   * Audit is written ONLY after canonical success (not on alreadyApplied).
   */
  async payInstallment(ctx) {
    const date = ctx.payload.installmentDate;
    const amountFils = ctx.payload.amountFils;
    const amountAed = Math.round(amountFils) / 100;
    const paymentId = `instpay:${date}`;
    const existing = await ctx.tx.get("uiConfig", "balances");
    if (!existing) throw new DomainError("BALANCES_NOT_FOUND");
    let obj = {};
    try { obj = JSON.parse(existing.json || "{}"); } catch { obj = {}; }
    const sched = Array.isArray(obj.installmentSchedule) ? obj.installmentSchedule.slice() : [];
    const payments = Array.isArray(obj.installmentPayments) ? obj.installmentPayments.slice() : [];
    const idx = sched.findIndex((x) => String(x && x.date) === date);
    if (idx < 0) throw new DomainError("INSTALLMENT_NOT_FOUND", { installmentDate: date });
    const row = sched[idx] || {};
    const rowFils = Math.round(Number(row.amount || 0) * 100);
    if (rowFils !== amountFils) {
      throw new DomainError("INSTALLMENT_AMOUNT_MISMATCH", {
        installmentDate: date, expectedFils: rowFils, gotFils: amountFils,
      });
    }
    const priorPayment = payments.find((p) => p && p.id === paymentId && p.state === "applied");
    if (row.paid || priorPayment) {
      return {
        alreadyApplied: true,
        paymentId,
        installmentDate: date,
        installmentBalance: Number(obj.installmentBalance || 0),
        paidCount: sched.filter((x) => x && x.paid).length,
        installmentSchedule: sched,
        installmentPayments: payments,
      };
    }
    const bal = Number(obj.installmentBalance || 0);
    if (!(bal >= amountAed)) {
      throw new DomainError("INSUFFICIENT_INSTALLMENT_BALANCE", {
        installmentDate: date, balanceAed: bal, needAed: amountAed,
      });
    }
    const nextBal = Math.round((bal - amountAed) * 100) / 100;
    sched[idx] = {
      ...row,
      paid: true,
      paidAt: ctx.now,
      paidBy: ctx.actor.userId,
      paymentId,
      evidence: row.evidence || "payInstallment",
      reversedAt: null,
      reversedBy: null,
    };
    // Open-ended: always keep at least one future unpaid installment.
    if (!sched.some((x) => x && !x.paid)) {
      const last = sched[sched.length - 1] || row;
      sched.push({
        date: nextQuarterEndDate(String(last.date || date)),
        amount: Number(last.amount) || amountAed,
        paid: false,
      });
    }
    payments.push({
      id: paymentId,
      installmentDate: date,
      amountFils,
      state: "applied",
      paidAt: ctx.now,
      paidBy: ctx.actor.userId,
      balanceAfterAed: nextBal,
      operationId: ctx.operationId,
    });
    obj.installmentSchedule = sched;
    obj.installmentPayments = payments;
    obj.installmentBalance = nextBal;
    obj.updatedAt = ctx.now;
    ctx.tx.update("uiConfig", "balances", {
      json: JSON.stringify(obj),
      updatedAt: ctx.now,
      updatedBy: ctx.actor.userId,
      schemaVersion: 1,
    });
    // Canonical success FIRST — then exactly one audit success entry.
    audit(ctx, "installment_paid", "uiConfig", `balances:installment:${date}`, {
      amountFils, balanceAfterAed: nextBal, paymentId,
    });
    return {
      alreadyApplied: false,
      paymentId,
      installmentDate: date,
      installmentBalance: nextBal,
      paidCount: sched.filter((x) => x && x.paid).length,
      installmentSchedule: sched,
      installmentPayments: payments,
    };
  },

  /** Undo a paid installment: restore balance once; unpaid rows no longer count. */
  async reverseInstallment(ctx) {
    const date = ctx.payload.installmentDate;
    const paymentId = `instpay:${date}`;
    const existing = await ctx.tx.get("uiConfig", "balances");
    if (!existing) throw new DomainError("BALANCES_NOT_FOUND");
    let obj = {};
    try { obj = JSON.parse(existing.json || "{}"); } catch { obj = {}; }
    const sched = Array.isArray(obj.installmentSchedule) ? obj.installmentSchedule.slice() : [];
    const payments = Array.isArray(obj.installmentPayments) ? obj.installmentPayments.slice() : [];
    const idx = sched.findIndex((x) => String(x && x.date) === date);
    if (idx < 0) throw new DomainError("INSTALLMENT_NOT_FOUND", { installmentDate: date });
    const row = sched[idx] || {};
    const livePay = payments.find((p) => p && p.id === paymentId && p.state === "applied");
    if (!row.paid && !livePay) {
      return {
        alreadyApplied: true,
        paymentId,
        installmentDate: date,
        installmentBalance: Number(obj.installmentBalance || 0),
        paidCount: sched.filter((x) => x && x.paid).length,
        installmentSchedule: sched,
        installmentPayments: payments,
      };
    }
    const amountAed = Number(row.amount) || (livePay ? Number(livePay.amountFils || 0) / 100 : 0);
    const nextBal = Math.round((Number(obj.installmentBalance || 0) + amountAed) * 100) / 100;
    sched[idx] = {
      ...row,
      paid: false,
      paidAt: null,
      paidBy: null,
      paymentId: null,
      evidence: null,
      reversedAt: ctx.now,
      reversedBy: ctx.actor.userId,
    };
    const payIdx = payments.findIndex((p) => p && p.id === paymentId && p.state === "applied");
    if (payIdx >= 0) {
      payments[payIdx] = {
        ...payments[payIdx],
        state: "reversed",
        reversedAt: ctx.now,
        reversedBy: ctx.actor.userId,
        reverseOperationId: ctx.operationId,
        balanceAfterAed: nextBal,
      };
    }
    obj.installmentSchedule = sched;
    obj.installmentPayments = payments;
    obj.installmentBalance = nextBal;
    obj.updatedAt = ctx.now;
    ctx.tx.update("uiConfig", "balances", {
      json: JSON.stringify(obj),
      updatedAt: ctx.now,
      updatedBy: ctx.actor.userId,
      schemaVersion: 1,
    });
    audit(ctx, "installment_reversed", "uiConfig", `balances:installment:${date}`, {
      amountAed, balanceAfterAed: nextBal, paymentId,
    });
    return {
      alreadyApplied: false,
      paymentId,
      installmentDate: date,
      installmentBalance: nextBal,
      paidCount: sched.filter((x) => x && x.paid).length,
      installmentSchedule: sched,
      installmentPayments: payments,
    };
  },

  async submitWorkRequest(ctx) {
    const id = ctx.payload.requestId;
    if (await ctx.tx.get("uiRequests", id)) throw new DomainError("REQUEST_EXISTS", { requestId: id });
    parseJsonField(ctx.payload.payloadJson, "payloadJson");
    let payload = {};
    try { payload = JSON.parse(ctx.payload.payloadJson); } catch { payload = {}; }
    const lockId = pendingRequestLockId({
      type: ctx.payload.type,
      actorKey: actorKey(ctx.actor),
      year: ctx.payload.year,
      month: ctx.payload.month,
      payload,
    });
    if (lockId) {
      const lock = await ctx.tx.get("uiRequests", lockId);
      if (lock && lock.status === "pending" && lock.activeRequestId) {
        const existing = await ctx.tx.get("uiRequests", lock.activeRequestId);
        if (existing && existing.status === "pending") {
          throw new DomainError("DUPLICATE_PENDING_REQUEST", {
            requestId: existing.id,
            lockId,
            type: ctx.payload.type,
          });
        }
      }
    }
    ctx.tx.create("uiRequests", id, {
      id,
      type: ctx.payload.type,
      desc: ctx.payload.desc,
      payloadJson: ctx.payload.payloadJson,
      originalPayloadJson: ctx.payload.payloadJson,
      version: 1,
      revisions: [originalRevision(ctx, ctx.payload.payloadJson)],
      month: ctx.payload.month,
      year: ctx.payload.year,
      by: ctx.actor.userId,
      byKey: actorKey(ctx.actor),
      byName: ctx.actor.displayName || actorKey(ctx.actor),
      status: "pending",
      createdAt: ctx.now,
      ...(lockId ? { lockId } : {}),
      ...base(ctx),
    });
    if (lockId) {
      const lockRec = {
        id: lockId,
        type: "pending_lock",
        status: "pending",
        activeRequestId: id,
        lockType: ctx.payload.type,
        by: ctx.actor.userId,
        byKey: actorKey(ctx.actor),
        month: ctx.payload.month,
        year: ctx.payload.year,
        updatedAt: ctx.now,
        ...base(ctx),
      };
      const prev = await ctx.tx.get("uiRequests", lockId);
      if (prev) ctx.tx.update("uiRequests", lockId, lockRec);
      else ctx.tx.create("uiRequests", lockId, lockRec);
    }
    audit(ctx, "work_request_submitted", "uiRequest", id, { type: ctx.payload.type });
    return { requestId: id, status: "pending", version: 1 };
  },

  async reviseWorkRequest(ctx) {
    const doc = await ctx.tx.get("uiRequests", ctx.payload.requestId);
    if (!doc) throw new DomainError("REQUEST_NOT_FOUND");
    if (doc.status !== "pending") {
      throw new DomainError("REQUEST_NOT_EDITABLE", { status: doc.status });
    }
    const sameUser = ctx.actor.userId === doc.by || actorKey(ctx.actor) === doc.byKey;
    if (!sameUser) throw new DomainError("FORBIDDEN", { why: "not the submitter" });
    const steps = await ctx.tx.query("operations", []);
    if ((steps || []).some((op) => op && String(op.operationId || "").startsWith(`cwr-${doc.id}-`))) {
      throw new DomainError("REQUEST_PARTIALLY_APPLIED", { requestId: doc.id });
    }
    const version = Number(doc.version || 1);
    if (ctx.payload.expectedVersion !== version) {
      throw new DomainError("STALE_REQUEST_VERSION", {
        requestId: doc.id, version, expectedVersion: ctx.payload.expectedVersion,
      });
    }
    let nextPayload = {};
    try { nextPayload = JSON.parse(ctx.payload.payloadJson); } catch { nextPayload = {}; }
    if (doc.lockId) {
      const nextLock = pendingRequestLockId({
        type: doc.type,
        actorKey: doc.byKey || actorKey(ctx.actor),
        year: doc.year,
        month: doc.month,
        payload: nextPayload,
      });
      if (nextLock && nextLock !== doc.lockId) {
        throw new DomainError("CORRECTION_CHANGES_TARGET", { lockId: doc.lockId, nextLock });
      }
    }
    const revisions = Array.isArray(doc.revisions) ? doc.revisions.slice() : [
      originalRevision({ ...ctx, actor: { userId: doc.by, displayName: doc.byName }, now: doc.createdAt }, doc.payloadJson),
    ];
    const nextVersion = version + 1;
    revisions.push({
      version: nextVersion,
      at: ctx.now,
      by: ctx.actor.userId,
      byName: ctx.actor.displayName || actorKey(ctx.actor),
      reason: ctx.payload.reason,
      oldValues: payloadSnapshot(doc.payloadJson),
      newValues: payloadSnapshot(ctx.payload.payloadJson),
    });
    ctx.tx.update("uiRequests", doc.id, {
      payloadJson: ctx.payload.payloadJson,
      desc: ctx.payload.desc || doc.desc,
      version: nextVersion,
      revisions,
      originalPayloadJson: doc.originalPayloadJson || doc.payloadJson,
      correctedAt: ctx.now,
      correctedBy: ctx.actor.userId,
    });
    audit(ctx, "work_request_revised", "uiRequest", doc.id, {
      version: nextVersion, reason: ctx.payload.reason,
    });
    return { requestId: doc.id, status: "pending", version: nextVersion };
  },

  async previewReceiptCorrection(ctx) {
    const impact = await receiptCorrectionImpact(ctx, ctx.payload.receiptId, ctx.payload.correctedAmountFils);
    return { ...impact, preview: true };
  },

  async submitReceiptCorrection(ctx) {
    const id = ctx.payload.requestId;
    if (await ctx.tx.get("uiRequests", id)) throw new DomainError("REQUEST_EXISTS", { requestId: id });
    const impact = await receiptCorrectionImpact(ctx, ctx.payload.receiptId, ctx.payload.correctedAmountFils);
    await assertPeriodMutable(ctx, impact.period);
    const lockId = `lock:rcptcorr:${String(ctx.payload.receiptId).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80)}`;
    const lock = await ctx.tx.get("uiRequests", lockId);
    if (lock && lock.status === "pending" && lock.activeRequestId) {
      const existing = await ctx.tx.get("uiRequests", lock.activeRequestId);
      if (existing && existing.status === "pending") {
        throw new DomainError("DUPLICATE_PENDING_REQUEST", { requestId: existing.id, lockId });
      }
    }
    const payload = {
      receiptId: ctx.payload.receiptId,
      reason: ctx.payload.reason,
      correctedAmountFils: ctx.payload.correctedAmountFils,
      impact,
    };
    const payloadJson = JSON.stringify(payload);
    ctx.tx.create("uiRequests", id, {
      id,
      type: "receipt_correction",
      desc: `تصحيح إيصال ${ctx.payload.receiptId}`,
      payloadJson,
      originalPayloadJson: payloadJson,
      version: 1,
      revisions: [originalRevision(ctx, payloadJson)],
      impact,
      month: ctx.payload.month,
      year: ctx.payload.year,
      by: ctx.actor.userId,
      byKey: actorKey(ctx.actor),
      byName: ctx.actor.displayName || actorKey(ctx.actor),
      status: "pending",
      lockId,
      createdAt: ctx.now,
      ...base(ctx),
    });
    const lockRec = {
      id: lockId, type: "pending_lock", status: "pending", activeRequestId: id,
      lockType: "receipt_correction", by: ctx.actor.userId, byKey: actorKey(ctx.actor),
      month: ctx.payload.month, year: ctx.payload.year, updatedAt: ctx.now, ...base(ctx),
    };
    if (lock) ctx.tx.update("uiRequests", lockId, lockRec);
    else ctx.tx.create("uiRequests", lockId, lockRec);
    audit(ctx, "receipt_correction_requested", "uiRequest", id, {
      receiptId: ctx.payload.receiptId,
      originalAmountFils: impact.originalAmountFils,
      correctedAmountFils: impact.correctedAmountFils,
      reason: ctx.payload.reason,
    });
    return { requestId: id, status: "pending", version: 1, impact };
  },

  async setCorrectionPolicy(ctx) {
    const json = JSON.stringify({ undeposited: ctx.payload.undeposited });
    const prev = await ctx.tx.get("uiConfig", "correctionPolicy");
    const rec = {
      id: "correctionPolicy", json, updatedAt: ctx.now, updatedBy: ctx.actor.userId, schemaVersion: 1,
    };
    if (prev) ctx.tx.update("uiConfig", "correctionPolicy", rec);
    else ctx.tx.create("uiConfig", "correctionPolicy", { ...rec, ...base(ctx) });
    audit(ctx, "correction_policy_set", "uiConfig", "correctionPolicy", { undeposited: ctx.payload.undeposited });
    return { undeposited: ctx.payload.undeposited };
  },

  async reviewAccountingClose(ctx) {
    return buildCloseReport(ctx, ctx.payload.period);
  },

  async closeAccountingPeriod(ctx) {
    const period = ctx.payload.period;
    const report = await buildCloseReport(ctx, period);
    if (!report.ready) throw new DomainError("MONTH_NOT_READY", { period, blockers: report.blockers });
    const stateId = `close-state:${period}`;
    const state = await ctx.tx.get("uiConfig", stateId);
    const stateData = parseConfigJson(state);
    if (stateData.status === "closed") throw new DomainError("ALREADY_CLOSED", { period, snapshotId: stateData.snapshotId });
    const version = Number(stateData.version || 0) + 1;
    const snapshotId = `close:${period}:v${version}`;
    if (await ctx.tx.get("uiConfig", snapshotId)) throw new DomainError("ALREADY_CLOSED", { snapshotId });
    const snapshot = {
      period, version, report, closedAt: ctx.now, closedBy: ctx.actor.userId,
    };
    ctx.tx.create("uiConfig", snapshotId, {
      id: snapshotId, json: JSON.stringify(snapshot), period, version, immutable: true, ...base(ctx),
    });
    const nextState = {
      status: "closed", snapshotId, version, closedAt: ctx.now, closedBy: ctx.actor.userId,
    };
    const stateRec = {
      id: stateId, json: JSON.stringify(nextState), updatedAt: ctx.now, updatedBy: ctx.actor.userId, schemaVersion: 1,
    };
    if (state) ctx.tx.update("uiConfig", stateId, stateRec);
    else ctx.tx.create("uiConfig", stateId, { ...stateRec, ...base(ctx) });
    await writeMonthLock(ctx, period, true);
    audit(ctx, "accounting_period_closed", "period", period, { snapshotId, version });
    return { period, snapshotId, version, ready: true };
  },

  async reopenAccountingPeriod(ctx) {
    const period = ctx.payload.period;
    const stateId = `close-state:${period}`;
    const state = await ctx.tx.get("uiConfig", stateId);
    const stateData = parseConfigJson(state);
    if (stateData.status !== "closed") throw new DomainError("PERIOD_NOT_CLOSED", { period });
    const eventId = `close-reopen:${period}:${ctx.operationId}`.slice(0, 140);
    ctx.tx.create("uiConfig", eventId, {
      id: eventId,
      json: JSON.stringify({
        period, reason: ctx.payload.reason, reopenedBy: ctx.actor.userId, at: ctx.now,
        snapshotId: stateData.snapshotId, version: stateData.version,
      }),
      ...base(ctx),
    });
    ctx.tx.update("uiConfig", stateId, {
      json: JSON.stringify({
        status: "open",
        snapshotId: stateData.snapshotId,
        version: stateData.version,
        reopenedAt: ctx.now,
        reopenedBy: ctx.actor.userId,
        reason: ctx.payload.reason,
      }),
      updatedAt: ctx.now,
      updatedBy: ctx.actor.userId,
    });
    await writeMonthLock(ctx, period, false);
    audit(ctx, "accounting_period_reopened", "period", period, {
      reason: ctx.payload.reason, snapshotId: stateData.snapshotId,
    });
    return { period, status: "open", snapshotId: stateData.snapshotId };
  },

  async resolveWorkRequest(ctx) {
    const doc = await ctx.tx.get("uiRequests", ctx.payload.requestId);
    if (!doc) throw new DomainError("REQUEST_NOT_FOUND");
    const next = ctx.payload.decision;
    if (next === "pending") {
      const steps = await ctx.tx.query("operations", []);
      if ((steps || []).some((op) => op && String(op.operationId || "").startsWith(`cwr-${doc.id}-`))) {
        throw new DomainError("REQUEST_PARTIALLY_APPLIED", { requestId: doc.id });
      }
    }
    if (next === "approved" || next === "rejected") {
      if (doc.status !== "pending" && doc.status !== "processing") {
        throw new DomainError("REQUEST_NOT_PENDING", { status: doc.status });
      }
    }
    ctx.tx.update("uiRequests", doc.id, {
      status: next, resolvedBy: ctx.actor.userId, resolvedAt: ctx.now,
    });
    if (doc.lockId && (next === "approved" || next === "rejected" || next === "failed")) {
      const lock = await ctx.tx.get("uiRequests", doc.lockId);
      if (lock && lock.activeRequestId === doc.id) {
        ctx.tx.update("uiRequests", doc.lockId, {
          status: "clear", activeRequestId: null, clearedAt: ctx.now,
        });
      }
    }
    audit(ctx, "work_request_resolved", "uiRequest", doc.id, { decision: next });
    return { requestId: doc.id, status: next };
  },

  async savePeriodExtras(ctx) {
    await assertEmployeePeriodOpen(ctx, ctx.payload.period);
    parseJsonField(ctx.payload.extrasJson, "extrasJson");
    const id = `period:${ctx.payload.period}`;
    const existing = await ctx.tx.get("uiPeriods", id);
    // Default stays full replace so existing callers keep today's behavior.
    // Patch updates only the named scopes and never drops rows the client omitted.
    const mode = ctx.payload.writeMode || "replace";
    const extrasJson = mode === "patch"
      ? patchPeriodExtras(existing, ctx.payload.extrasJson, ctx.payload.scopes, ctx.actor.role === "owner")
      : (ctx.actor.role === "owner"
        ? ctx.payload.extrasJson
        : preserveOwnerExtras(existing, ctx.payload.extrasJson));
    const rec = {
      id, period: ctx.payload.period, extrasJson,
      updatedAt: ctx.now, updatedBy: ctx.actor.userId, schemaVersion: 1,
    };
    if (existing) ctx.tx.update("uiPeriods", id, rec);
    else ctx.tx.create("uiPeriods", id, { ...rec, ...base(ctx) });
    audit(ctx, "period_extras_saved", "uiPeriod", id);
    return { period: ctx.payload.period };
  },
};

/* shared receipt creation for cash and bank */
async function createReceipt(ctx, extra) {
  const ob = await ctx.tx.get("obligations", ctx.payload.obligationId);
  if (!ob) throw new DomainError("OBLIGATION_NOT_FOUND");
  if (ob.state !== "active") throw new DomainError("OBLIGATION_NOT_ACTIVE");
  await assertEmployeePeriodOpen(ctx, ob.period);
  await assertPeriodMutable(ctx, ob.period);

  const siblings = await ctx.tx.query("receipts", [["obligationId", "==", ob.id]]);

  // D2: overpayment is refused with the exact figures. Pending bank receipts are counted
  // as claims on the remainder so two submissions cannot together exceed the obligation.
  const claiming = siblings.filter(
    (r) => r.state === RECEIPT_STATE.RECOGNIZED || r.state === RECEIPT_STATE.PENDING
  ).map((r) => ({ ...r, state: RECEIPT_STATE.RECOGNIZED }));
  assertReceiptFits({
    obligation: ob, receipts: claiming,
    amountFils: ctx.payload.amountFils, asOfDate: ctx.payload.collectionDate,
  });
  // Touch the obligation so a concurrent second collection conflicts and retries
  // against the receipt just written, instead of both passing the remaining check.
  ctx.tx.update("obligations", ob.id, {
    lastCollectionOperationId: ctx.operationId,
    lastCollectionAt: ctx.now,
  });

  const id = newId("rcpt", ctx);
  ctx.tx.create("receipts", id, {
    id, obligationId: ob.id, rentalId: ob.rentalId, propertyId: ob.propertyId,
    unitId: ob.unitId, spaceId: ob.spaceId, period: ob.period,
    tenantNameSnapshot: ob.tenantNameSnapshot,
    amountFils: ctx.payload.amountFils,
    collectionDate: ctx.payload.collectionDate,
    note: ctx.payload.note || null,
    ...extra, ...base(ctx),
  });
  audit(ctx, extra.method === "cash" ? "cash_receipt_created" : "bank_receipt_submitted", "receipt", id, {
    amountFils: ctx.payload.amountFils, obligationId: ob.id, method: extra.method,
  });
  return { receiptId: id, state: extra.state, method: extra.method };
}

/**
 * Employee period saves replace the extras document. Keep owner-only mirrors
 * (profit transfers, installment rows) from the previous canonical blob.
 */
function preserveOwnerExtras(existing, incomingJson) {
  let prev = {};
  let next = {};
  try { prev = existing && existing.extrasJson ? JSON.parse(existing.extrasJson) : {}; } catch { prev = {}; }
  try { next = JSON.parse(incomingJson); } catch { next = {}; }
  if (!prev || typeof prev !== "object" || Array.isArray(prev)) prev = {};
  if (!next || typeof next !== "object" || Array.isArray(next)) next = {};
  next.profits = Array.isArray(prev.profits) ? prev.profits : [];
  next.installments = Array.isArray(prev.installments) ? prev.installments : [];
  return JSON.stringify(next);
}

const EXTRAS_PATCH_SCOPES = new Set([
  "spaces", "dailyBookings", "unitMaintenance", "facilityMaintenance",
  "profits", "installments", "logs",
]);

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function mergeRowsById(serverRows, upserts, removeIds) {
  const list = Array.isArray(serverRows) ? serverRows.map((row) => ({ ...row })) : [];
  const index = new Map();
  list.forEach((row, i) => {
    if (row && row.id != null) index.set(String(row.id), i);
  });
  for (const row of Array.isArray(upserts) ? upserts : []) {
    if (!row || typeof row !== "object" || Array.isArray(row) || row.id == null) continue;
    const key = String(row.id);
    if (index.has(key)) list[index.get(key)] = { ...list[index.get(key)], ...row };
    else {
      index.set(key, list.length);
      list.push({ ...row });
    }
  }
  const drop = new Set((Array.isArray(removeIds) ? removeIds : []).map(String));
  if (!drop.size) return list;
  return list.filter((row) => !row || row.id == null || !drop.has(String(row.id)));
}

function patchPeriodExtras(existing, incomingJson, scopes, isOwner) {
  let prev = {};
  let patch = {};
  try { prev = existing && existing.extrasJson ? JSON.parse(existing.extrasJson) : {}; } catch { prev = {}; }
  try { patch = JSON.parse(incomingJson); } catch { patch = {}; }
  prev = plainObject(prev);
  patch = plainObject(patch);
  const next = { ...prev };
  const wanted = String(scopes || "").split(",").map((s) => s.trim()).filter((s) => EXTRAS_PATCH_SCOPES.has(s));
  const upserts = plainObject(patch.upserts);
  const removed = plainObject(patch.removedIds);
  for (const scope of wanted) {
    if ((scope === "profits" || scope === "installments") && !isOwner) continue;
    if (scope === "spaces") {
      const spaces = { ...plainObject(prev.spaces) };
      const patches = plainObject(patch.spacePatches);
      const allowed = new Set(Array.isArray(patch.touchedSpaceIds) ? patch.touchedSpaceIds.map(String) : []);
      for (const [id, fields] of Object.entries(patches)) {
        if (!allowed.has(String(id))) continue;
        if (!fields || typeof fields !== "object" || Array.isArray(fields)) continue;
        spaces[id] = { ...plainObject(spaces[id]), ...fields };
      }
      for (const id of (Array.isArray(removed.spaces) ? removed.spaces.map(String) : [])) delete spaces[id];
      next.spaces = spaces;
      continue;
    }
    next[scope] = mergeRowsById(prev[scope], upserts[scope], removed[scope]);
  }
  return JSON.stringify(next);
}

export { HANDLERS };

async function collectorFor(ctx) {
  // Employees cannot forge collector identity. Only the owner may attribute a receipt
  // to an employee (the old approve-request path). A granted correction may keep
  // the original collector, and only that collector.
  if ((ctx.actor.role === "owner" || ctx.usedCorrectionGrant) && ctx.payload.collectorUserId) {
    const user = await ctx.tx.get("users", ctx.payload.collectorUserId);
    if (user && user.active !== false) return user.id;
  }
  return ctx.actor.userId;
}

async function depositEmployeeFor(ctx) {
  if (ctx.actor.role === "owner" && ctx.payload.employeeId) {
    const user = await ctx.tx.get("users", ctx.payload.employeeId);
    if (user && user.active !== false) return user.id;
  }
  return ctx.actor.userId;
}

function parseConfigJson(doc) {
  if (!doc) return {};
  try { return JSON.parse(doc.json || "{}") || {}; } catch { return {}; }
}

function payloadSnapshot(raw) {
  let payload = {};
  try { payload = JSON.parse(raw || "{}"); } catch { payload = {}; }
  const fields = payload.fields || payload;
  const out = {};
  for (const key of ["status", "rent", "tenant", "paid_amount", "partial", "collectionMethod", "start_date", "note"]) {
    if (fields[key] != null && fields[key] !== "") out[key] = fields[key];
  }
  if (payload.receiptId) out.receiptId = payload.receiptId;
  if (payload.correctedAmountFils != null) out.correctedAmountFils = payload.correctedAmountFils;
  if (payload.reason) out.reason = payload.reason;
  return out;
}

function originalRevision(ctx, payloadJson) {
  return {
    version: 1,
    at: ctx.now,
    by: ctx.actor.userId,
    byName: ctx.actor.displayName || actorKey(ctx.actor),
    reason: "التقديم الأصلي",
    newValues: payloadSnapshot(payloadJson),
  };
}

async function assertPeriodMutable(ctx, period) {
  if (!period || !/^\d{4}-\d{2}$/.test(String(period))) return;
  const data = parseConfigJson(await ctx.tx.get("uiConfig", `close-state:${period}`));
  if (data.status === "closed") throw new DomainError("MONTH_CLOSED", { period });
}

async function receiptCorrectionImpact(ctx, receiptId, correctedAmountFils) {
  const receipt = await ctx.tx.get("receipts", receiptId);
  if (!receipt) throw new DomainError("RECEIPT_NOT_FOUND");
  if (receipt.state !== RECEIPT_STATE.RECOGNIZED) {
    throw new DomainError("RECEIPT_NOT_RECOGNIZED", { state: receipt.state });
  }
  const original = Number(receipt.amountFils || 0);
  const corrected = Number(correctedAmountFils);
  if (!Number.isInteger(corrected) || corrected < 0 || corrected > original) {
    throw new DomainError("INVALID_CORRECTION", { originalAmountFils: original, correctedAmountFils: corrected });
  }
  const receipts = await ctx.tx.query("receipts", []);
  const deposits = await ctx.tx.query("deposits", []);
  let blocked = null;
  if (receipt.method === "cash") {
    try {
      assertCashReversalFitsSharedHolding({
        receipts, deposits, reversingReceiptIds: [receipt.id],
      });
    } catch (e) {
      if (e.code !== "RECEIPT_ALREADY_DEPOSITED") throw e;
      blocked = "DEPOSIT_RECONCILIATION_REQUIRED";
    }
  }
  if (receipt.method === "bank") blocked = blocked || "BANK_RECONCILIATION_REQUIRED";
  const space = receipt.spaceId ? await ctx.tx.get("spaces", receipt.spaceId) : null;
  return {
    receiptId: receipt.id,
    obligationId: receipt.obligationId,
    period: receipt.period,
    spaceId: receipt.spaceId || null,
    spaceName: space && space.name || null,
    method: receipt.method,
    originalAmountFils: original,
    correctedAmountFils: corrected,
    deltaFils: corrected - original,
    holdingDeltaFils: receipt.method === "cash" ? corrected - original : 0,
    blocked,
  };
}

async function buildCloseReport(ctx, period) {
  const [obligations, receipts, deposits, rentals, requests] = await Promise.all([
    ctx.tx.query("obligations", []),
    ctx.tx.query("receipts", []),
    ctx.tx.query("deposits", []),
    ctx.tx.query("rentals", []),
    ctx.tx.query("uiRequests", []),
  ]);
  return reviewPeriodClose({ period, obligations, receipts, deposits, rentals, requests });
}

async function writeMonthLock(ctx, period, locked) {
  const locksDoc = await ctx.tx.get("uiConfig", "locks");
  let data = parseConfigJson(locksDoc);
  if (data && data.data && typeof data.data === "object") data = { ...data, ...data.data };
  const [y, m] = String(period).split("-").map(Number);
  const key = `${y}_${m - 1}`;
  if (locked) data[key] = true;
  else delete data[key];
  const rec = {
    id: "locks", json: JSON.stringify(data), updatedAt: ctx.now, updatedBy: ctx.actor.userId, schemaVersion: 1,
  };
  if (locksDoc) ctx.tx.update("uiConfig", "locks", rec);
  else ctx.tx.create("uiConfig", "locks", { ...rec, ...base(ctx) });
}

export function actorKey(actor) {
  const id = String(actor.userId || "");
  if (id.includes("nader")) return "nader";
  if (id.includes("yahia")) return "yahia";
  if (id.includes("saeed")) return "saeed";
  const tail = id.split(":").filter(Boolean).pop() || "user";
  const safe = tail.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40);
  return safe || "user";
}

/** Next calendar quarter-end date after an ISO date (open-ended installment cadence). */
function nextQuarterEndDate(isoDate) {
  const s = String(isoDate || "").slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new DomainError("INVALID_DATE", { isoDate });
  let y = Number(m[1]);
  let month = Number(m[2]); // 1-12
  month += 3;
  while (month > 12) { month -= 12; y += 1; }
  const lastDay = new Date(Date.UTC(y, month, 0)).getUTCDate();
  return `${y}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

function parseJsonField(value, field) {
  try { JSON.parse(value); }
  catch { throw new DomainError("INVALID_FIELD", { field, why: "not json" }); }
}

/** One pending card per employee+entity+month. Prevents duplicate Manager requests. */
function pendingRequestLockId({ type, actorKey: who, year, month, payload }) {
  const y = Number(year);
  const m = Number(month);
  if (!who || !Number.isFinite(y) || !Number.isFinite(m)) return null;
  const safe = (v) => String(v || "").replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80);
  if (type === "update_partition") {
    return `lock:updpart:${safe(who)}:${y}:${m}:${safe(payload.unitId)}:${safe(payload.partId)}`;
  }
  if (type === "update_full") {
    return `lock:updfull:${safe(who)}:${y}:${m}:${safe(payload.unitId)}`;
  }
  if (type === "add_transaction") {
    const tx = payload.transaction || {};
    // Prefer depositId when present — exact canonical identity.
    if (tx.depositId || payload.depositId) {
      return `lock:dep:${safe(tx.depositId || payload.depositId)}`;
    }
    return `lock:depamt:${safe(who)}:${y}:${m}:${safe(tx.amount)}:${safe(tx.date)}:${safe(tx.desc)}`;
  }
  return null;
}

/** Employees cannot mutate a month the owner locked in uiConfig/locks. */
async function assertEmployeePeriodOpen(ctx, period) {
  if (!period || ctx.actor.role === "owner") return;
  const locksDoc = await ctx.tx.get("uiConfig", "locks");
  if (!locksDoc) return;
  let data = {};
  try { data = JSON.parse(locksDoc.json || "{}"); } catch { data = {}; }
  if (data && data.data && typeof data.data === "object") data = { ...data, ...data.data };
  const [y, m] = String(period).split("-").map(Number);
  if (!y || !m) return;
  const key = `${y}_${m - 1}`;
  if (data[key]) throw new DomainError("MONTH_LOCKED", { period });
}
