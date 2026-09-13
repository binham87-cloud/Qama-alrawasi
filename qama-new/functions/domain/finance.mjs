/**
 * QAMA — Financial domain.
 *
 * PURE. No I/O, no clock, no randomness, no Firebase. Same inputs → same outputs.
 * That is what makes every figure reproducible in an audit and testable without an emulator.
 *
 * THE RULE
 *   Money is the source of financial truth. Financial status is derived from money.
 *   Nothing in this file reads a stored status, paid total, holding or balance.
 *   Every figure is computed from financial events.
 *
 * MONEY
 *   Integer fils only. 1 AED = 100 fils. No float ever touches a money value.
 */

/* ─────────────────────────── money ─────────────────────────── */

export const FILS_PER_AED = 100;

/** Parse a human-entered AED string/number into integer fils. Rejects nonsense. */
export function parseAedToFils(input) {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) return null;
    // Route through a fixed-precision string: 9200.005 * 100 is 920000.49999... in binary
    // floating point, which would silently round the wrong way. toFixed applies decimal
    // rounding first so the fils value matches what a person typed.
    input = input.toFixed(2);
  }
  const text = String(input ?? "").trim().replace(/[٬,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [whole, frac = ""] = text.split(".");
  return Number(whole) * FILS_PER_AED + Number((frac + "00").slice(0, 2));
}

export function isFils(value) {
  return Number.isSafeInteger(value);
}

export function assertPositiveFils(value, code = "INVALID_AMOUNT") {
  if (!isFils(value) || value <= 0) throw new DomainError(code, { amountFils: value });
  return value;
}

/** Format fils for display. Presentation only — never feeds a calculation. */
export function formatFils(fils) {
  const n = Number(fils) || 0;
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const whole = Math.floor(abs / FILS_PER_AED);
  const frac = abs % FILS_PER_AED;
  const wholeText = whole.toLocaleString("en-US");
  return sign + (frac === 0 ? wholeText : wholeText + "." + String(frac).padStart(2, "0"));
}

/* ─────────────────────────── errors ─────────────────────────── */

export class DomainError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

/* ─────────────────────────── states ─────────────────────────── */

export const RECEIPT_STATE = Object.freeze({
  RECOGNIZED: "recognized",
  PENDING: "pending",
  REJECTED: "rejected",
  REVERSED: "reversed",
});
export const APPROVAL_STATE = Object.freeze({
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  REVERSED: "reversed",
});
export const OCCUPANCY = Object.freeze(["rented", "vacant", "staff"]);
export const METHOD = Object.freeze(["cash", "bank"]);

/** Derived financial status. Never stored. */
export const STATUS = Object.freeze({
  NOT_DUE: "not_due",
  LATE: "late",
  PARTIAL: "partial",
  COLLECTED: "collected",
});
export const STATUS_AR = Object.freeze({
  not_due: "لم يحل",
  late: "متأخر",
  partial: "جزئي",
  collected: "محصّل",
  vacant: "فارغ",
  staff: "موظفين",
});

/** Placeholder / blank tenant names must never create a live rental. */
export function isPlaceholderTenant(name) {
  const t = String(name ?? "").trim();
  return !t || t === "-" || t === "–" || t === "—" || /^[\s\-—–_]+$/.test(t);
}

/**
 * Monthly Target/Collected/Remaining count active obligations whose rental
 * is still active, PLUS unpaid arrears explicitly retained after vacate.
 */
export function liveObligationsForPeriod(obligations, rentals) {
  const activeRentalIds = new Set(
    (rentals || []).filter((r) => r && r.state === "active" && r.baselineExcluded !== true).map((r) => r.id),
  );
  return (obligations || []).filter((o) => {
    if (!o || o.state !== "active" || o.baselineExcluded === true) return false;
    if (activeRentalIds.has(o.rentalId)) return true;
    return o.retainArrearsAfterVacate === true;
  });
}

/* ───────────────────── receipt recognition ───────────────────── */

/** A receipt counts toward money only when recognized and not reversed. */
export function isRecognizedReceipt(receipt) {
  if (!receipt || receipt.baselineExcluded === true) return false;
  // Archived/hidden test receipts never enter operational Collected/Holding.
  if (receipt.operationalHidden === true || receipt.archivedOperational === true) return false;
  return receipt.state === RECEIPT_STATE.RECOGNIZED;
}

export function isApproved(record) {
  if (!record || record.baselineExcluded === true) return false;
  return record.state === APPROVAL_STATE.APPROVED;
}

/**
 * Display/audit projections of bank receipts (fromBankReceipt / sourceKind bank).
 * These rows exist ONLY for UI history. They must never be treated as custody
 * deposits or as a second copy of recognized bank money.
 */
export function isDisplayOnlyMoneyProjection(row) {
  if (!row) return false;
  return row.fromBankReceipt === true || row.sourceKind === "bank";
}

/**
 * Whether a deposits[] / transactions projection row belongs in تفاصيل الدخل
 * (financially effective now). Pending / rejected / reversed → audit only.
 * Approved bank history (recognized receipt projection) → yes (deposited income).
 */
export function isFinancialIncomeDetailRow(row) {
  if (!row || row.baselineExcluded === true) return false;
  const st = String(row.state || "");
  if (st === APPROVAL_STATE.PENDING || st === APPROVAL_STATE.REJECTED || st === APPROVAL_STATE.REVERSED) {
    return false;
  }
  if (st === RECEIPT_STATE.PENDING || st === RECEIPT_STATE.REJECTED || st === RECEIPT_STATE.REVERSED) {
    return false;
  }
  if (isDisplayOnlyMoneyProjection(row)) {
    // bankReceiptHistoryRows maps recognized → "approved"
    return st === APPROVAL_STATE.APPROVED || st === RECEIPT_STATE.RECOGNIZED;
  }
  return isApproved(row);
}

/**
 * Canonical money effect of one receipt on *current* totals.
 * pending / rejected / reversed / unrecognized → all zeros (audit only).
 *
 * Bank recognized:  Collected+, Deposited+, Holding unchanged
 * Cash recognized:  Collected+, Holding+, Deposited unchanged
 */
export function receiptMoneyEffect(receipt) {
  const zero = { collectedFils: 0, depositedFils: 0, holdingFils: 0, inert: true };
  if (!isRecognizedReceipt(receipt)) return zero;
  const amountFils = toSafeFils(receipt.amountFils);
  if (receipt.method === "bank") {
    return { collectedFils: amountFils, depositedFils: amountFils, holdingFils: 0, inert: false };
  }
  if (receipt.method === "cash") {
    return { collectedFils: amountFils, depositedFils: 0, holdingFils: amountFils, inert: false };
  }
  return zero;
}

/**
 * Canonical money effect of one deposit on *current* totals.
 * Display-only bank history rows → always inert (even when state maps to "approved").
 * pending / rejected / reversed → inert.
 * Approved holding deposit: Holding−, Deposited+, Collected unchanged.
 * Approved external deposit: Deposited+, Holding unchanged, Collected unchanged.
 */
export function depositMoneyEffect(deposit) {
  const zero = { collectedFils: 0, depositedFils: 0, holdingFils: 0, inert: true, displayOnly: false };
  if (!deposit || deposit.baselineExcluded === true) return zero;
  if (isDisplayOnlyMoneyProjection(deposit)) {
    return { ...zero, displayOnly: true };
  }
  if (!isApproved(deposit)) return zero;
  const amountFils = toSafeFils(deposit.amountFils);
  if (deposit.sourceKind === "external") {
    return { collectedFils: 0, depositedFils: amountFils, holdingFils: 0, inert: false, displayOnly: false };
  }
  // Default: deposit from employee Holding.
  return { collectedFils: 0, depositedFils: amountFils, holdingFils: -amountFils, inert: false, displayOnly: false };
}

/**
 * Prove that display-only / inert rows cannot change period money when mixed into deposits[].
 * Returns problems[] (empty = ok). Used by tests and checkInvariants callers.
 */
export function assertProjectionsDoNotMoveMoney({ obligations, receipts, deposits, expenses, asOfDate }) {
  const problems = [];
  const base = periodSummary({ obligations, receipts, deposits, expenses, asOfDate });
  const withoutDisplay = (deposits || []).filter((d) => !isDisplayOnlyMoneyProjection(d));
  const stripped = periodSummary({
    obligations, receipts, deposits: withoutDisplay, expenses, asOfDate,
  });
  for (const key of [
    "collectedFils", "depositedFils", "holdingFils", "companyCollectedFils",
    "approvedDepositsFils", "bankRecognizedFils", "expensesFils", "incomeFils", "netIncomeFils",
  ]) {
    if (base[key] !== stripped[key]) {
      problems.push({
        code: "DISPLAY_PROJECTION_MOVED_MONEY",
        detail: `${key} changed when display-only deposit rows were included`,
        withDisplay: base[key],
        withoutDisplay: stripped[key],
      });
    }
  }
  // Inert receipt states must not contribute via money-effect helpers.
  for (const r of receipts || []) {
    const eff = receiptMoneyEffect(r);
    if (!isRecognizedReceipt(r) && !eff.inert) {
      problems.push({ code: "INERT_RECEIPT_HAS_EFFECT", detail: `receipt ${r.id} state=${r.state}` });
    }
    if (!isRecognizedReceipt(r) && (eff.collectedFils || eff.depositedFils || eff.holdingFils)) {
      problems.push({ code: "INERT_RECEIPT_NONZERO", detail: `receipt ${r.id} state=${r.state}` });
    }
  }
  for (const d of deposits || []) {
    const eff = depositMoneyEffect(d);
    if (isDisplayOnlyMoneyProjection(d) && (eff.collectedFils || eff.depositedFils || eff.holdingFils || !eff.inert)) {
      problems.push({ code: "DISPLAY_DEPOSIT_HAS_EFFECT", detail: `deposit ${d.id}` });
    }
    if (!isApproved(d) && !isDisplayOnlyMoneyProjection(d) && (eff.collectedFils || eff.depositedFils || eff.holdingFils)) {
      problems.push({ code: "INERT_DEPOSIT_NONZERO", detail: `deposit ${d.id} state=${d.state}` });
    }
  }
  return { ok: problems.length === 0, problems, summary: base };
}

/* ───────────────────── obligation derivation ───────────────────── */

/**
 * The financial view of one obligation.
 * `receipts` may contain receipts for other obligations; they are filtered here so no
 * caller can accidentally widen the set.
 */
export function obligationView(obligation, receipts, asOfDate) {
  if (!obligation) throw new DomainError("OBLIGATION_REQUIRED");
  const active = obligation.state === "active";
  const dueFils = active ? toSafeFils(obligation.amountFils) : 0;

  const mine = (receipts || []).filter(
    (r) => r.obligationId === obligation.id && isRecognizedReceipt(r)
  );
  const paidFils = mine.reduce((sum, r) => sum + toSafeFils(r.amountFils), 0);
  const remainingFils = dueFils - paidFils;

  return {
    obligationId: obligation.id,
    rentalId: obligation.rentalId,
    spaceId: obligation.spaceId,
    unitId: obligation.unitId,
    propertyId: obligation.propertyId,
    period: obligation.period,
    tenantName: obligation.tenantNameSnapshot || null,
    dueDate: obligation.dueDate,
    dueFils,
    paidFils,
    remainingFils,
    receiptCount: mine.length,
    status: deriveStatus({ dueFils, paidFils, dueDate: obligation.dueDate, asOfDate }),
  };
}

/**
 * Status is a pure function of money and time. There is no input by which a caller
 * can assert a status: the parameter simply does not exist.
 */
export function deriveStatus({ dueFils, paidFils, dueDate, asOfDate }) {
  if (dueFils <= 0) return STATUS.NOT_DUE;
  if (paidFils >= dueFils) return STATUS.COLLECTED;
  if (paidFils > 0) return STATUS.PARTIAL;
  return isPastDue(dueDate, asOfDate) ? STATUS.LATE : STATUS.NOT_DUE;
}

function isPastDue(dueDate, asOfDate) {
  if (!dueDate || !asOfDate) return false;
  // ON the due date OR AFTER → late. Business rule: rent is collected upfront,
  // so the day the obligation falls due it is already overdue if unpaid.
  return String(asOfDate).slice(0, 10) >= String(dueDate).slice(0, 10);
}

function toSafeFils(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new DomainError("NON_INTEGER_FILS", { value });
  return n;
}

/* ───────────────────── overpayment (D2: reject) ───────────────────── */

/**
 * D2: a payment may not exceed what is outstanding. The excess is neither clamped nor
 * discarded — the command is refused and the caller is told the exact numbers.
 */
export function assertReceiptFits({ obligation, receipts, amountFils, asOfDate }) {
  assertPositiveFils(amountFils, "INVALID_AMOUNT");
  const view = obligationView(obligation, receipts, asOfDate);
  if (view.dueFils <= 0) {
    throw new DomainError("OBLIGATION_NOT_ACTIVE", { obligationId: obligation.id });
  }
  if (amountFils > view.remainingFils) {
    throw new DomainError("AMOUNT_EXCEEDS_REMAINING", {
      dueFils: view.dueFils,
      paidFils: view.paidFils,
      remainingFils: view.remainingFils,
      attemptedFils: amountFils,
    });
  }
  return view;
}

/* ───────────────────── custody / holding ───────────────────── */

/**
 * Operational cash custody is ONE shared pool (عهدة الموظفين).
 *
 * Shared Holding =
 *   SUM(recognized CASH receipts from any collector)
 * − SUM(APPROVED deposits from shared custody)
 *
 * collectorUserId / deposit employeeId are audit fields only.
 * Bank receipts never enter the pool. Pending/rejected deposits do not reduce it.
 * Reversed cash receipts leave the set via state. NO CLAMPING.
 */

/** Shared spendable custody. Integer fils. */
export function sharedHoldingFils({ receipts, deposits, excludeReceiptIds = [], excludeDepositIds = [] }) {
  const skipR = new Set(excludeReceiptIds);
  const skipD = new Set(excludeDepositIds);
  let cash = 0;
  for (const r of receipts || []) {
    if (skipR.has(r.id)) continue;
    if (!isRecognizedReceipt(r) || r.method !== "cash") continue;
    cash += toSafeFils(r.amountFils);
  }
  let deposited = 0;
  for (const d of deposits || []) {
    if (skipD.has(d.id)) continue;
    if (!isApproved(d)) continue;
    // External (other) deposits never reduce Shared Holding.
    if (d.sourceKind === "external") continue;
    // Display-only bank-receipt history rows are not custody deposits.
    if (isDisplayOnlyMoneyProjection(d)) continue;
    deposited += toSafeFils(d.amountFils);
  }
  return cash - deposited;
}

/**
 * Audit only: cash collected BY each employee. Not a spendable limit.
 * depositedFils here is deposits that employee submitted (audit), not their personal pool.
 */
export function holdingByEmployee({ receipts, deposits }) {
  const collected = new Map();
  const submitted = new Map();

  for (const r of receipts || []) {
    if (!isRecognizedReceipt(r) || r.method !== "cash") continue;
    const who = r.collectorUserId;
    if (!who) continue;
    collected.set(who, (collected.get(who) || 0) + toSafeFils(r.amountFils));
  }
  for (const d of deposits || []) {
    if (!isApproved(d)) continue;
    if (d.sourceKind === "external") continue;
    if (isDisplayOnlyMoneyProjection(d)) continue;
    const who = d.employeeId;
    if (!who) continue;
    submitted.set(who, (submitted.get(who) || 0) + toSafeFils(d.amountFils));
  }

  const people = new Set([...collected.keys(), ...submitted.keys()]);
  const rows = [];
  for (const userId of people) {
    const c = collected.get(userId) || 0;
    const d = submitted.get(userId) || 0;
    rows.push({
      userId,
      cashCollectedFils: c,
      depositedFils: d,
      submittedDepositFils: d,
      // Attribution for audit/display. Operational deposit limit remains sharedHoldingFils.
      holdingFils: Math.max(0, c - d),
    });
  }
  rows.sort((a, b) => b.cashCollectedFils - a.cashCollectedFils || a.userId.localeCompare(b.userId));
  return rows;
}

export function totalHoldingFils(rows) {
  return rows.reduce((sum, r) => sum + (r.holdingFils || 0), 0);
}

/**
 * A deposit may not exceed the SHARED employee holding pool.
 * Submitter identity is audit only — it does not create a personal limit.
 */
export function assertDepositFitsCustody({ employeeId, amountFils, receipts, deposits }) {
  assertPositiveFils(amountFils, "INVALID_AMOUNT");
  const holding = sharedHoldingFils({ receipts, deposits });
  if (holding < 0) {
    throw new DomainError("CUSTODY_RECONCILIATION_ERROR", { employeeId, holdingFils: holding });
  }
  if (amountFils > holding) {
    throw new DomainError("AMOUNT_EXCEEDS_HOLDING", { employeeId, holdingFils: holding, attemptedFils: amountFils });
  }
  return holding;
}

/**
 * Cash receipt reversal is allowed iff shared holding after removing those
 * receipts remains >= 0. Bank receipts skip this (they never entered the pool).
 */
export function assertCashReversalFitsSharedHolding({ receipts, deposits, reversingReceiptIds }) {
  const ids = Array.isArray(reversingReceiptIds) ? reversingReceiptIds : [reversingReceiptIds];
  const after = sharedHoldingFils({ receipts, deposits, excludeReceiptIds: ids });
  if (after < 0) {
    throw new DomainError("RECEIPT_ALREADY_DEPOSITED", {
      reversingReceiptIds: ids,
      sharedHoldingAfterFils: after,
      message: "تم تضمين هذا المبلغ في إيداع معتمد من العهدة المشتركة. يُرجى عكس الإيداع أولاً قبل إلغاء الإيصال.",
    });
  }
  return after;
}

/* ───────────────────── period summary ───────────────────── */

/**
 * The one place period figures are defined. Every screen renders this; no screen
 * recomputes any part of it.
 *
 * Selected-month rent equation (core):
 *   TARGET = TENANT COLLECTED + TENANT UNPAID
 *
 * Tenant collected operationally splits as:
 *   TENANT COLLECTED = COMPANY/DEPOSITED + AT EMPLOYEES (month)
 * where COMPANY/DEPOSITED = recognized BANK on this month's obligations
 *   + approved deposits covering this month's CASH (capped so prior-month
 *     shared-pool deposits cannot invent September rent figures).
 *
 * Global Shared Holding is separate (all-period cash − all approved deposits)
 * and must never be mixed into TARGET.
 */
export function periodSummary({ obligations, receipts, deposits, expenses, asOfDate }) {
  const obs = (obligations || []).filter((o) => o.state === "active");
  const views = obs.map((o) => obligationView(o, receipts, asOfDate));
  const liveObIds = new Set(obs.map((o) => o.id));

  const obligationTargetFils = views.reduce((s, v) => s + v.dueFils, 0);
  const obligationPaidFils = views.reduce((s, v) => s + v.paidFils, 0);

  // Daily booking receipts (no obligation doc) — count as tenant paid / cash in pool.
  // Unpaid daily target is layered in buildDashboard from uiPeriods extras.
  const dailyPaidFils = (receipts || [])
    .filter((r) => isRecognizedReceipt(r) && r.sourceType === "daily_booking")
    .reduce((s, r) => s + toSafeFils(r.amountFils), 0);
  const dailyCashFils = (receipts || [])
    .filter((r) => isRecognizedReceipt(r) && r.sourceType === "daily_booking" && r.method === "cash")
    .reduce((s, r) => s + toSafeFils(r.amountFils), 0);

  // Include paid daily in target so TARGET = COLLECTED + UNPAID still holds until
  // buildDashboard adds the unpaid daily remainder.
  const targetFils = obligationTargetFils + dailyPaidFils;
  const tenantPaidFils = obligationPaidFils + dailyPaidFils;
  const tenantUnpaidFils = obligationTargetFils - obligationPaidFils;

  const cashOnObligationsFils = (receipts || [])
    .filter((r) => isRecognizedReceipt(r) && r.method === "cash" && liveObIds.has(r.obligationId))
    .reduce((s, r) => s + toSafeFils(r.amountFils), 0) + dailyCashFils;
  const bankRecognizedFils = (receipts || [])
    .filter((r) => isRecognizedReceipt(r) && r.method === "bank" && liveObIds.has(r.obligationId))
    .reduce((s, r) => s + toSafeFils(r.amountFils), 0);

  const approvedDepositsFils = (deposits || [])
    .filter((d) => isApproved(d) && !isDisplayOnlyMoneyProjection(d))
    .reduce((s, d) => s + toSafeFils(d.amountFils), 0);

  // Deposits may draw from the shared global pool; for THIS month's rent split,
  // only count deposit coverage up to this month's cash on obligations.
  const monthDepositCoverFils = Math.min(approvedDepositsFils, cashOnObligationsFils);
  const atEmployeesMonthFils = cashOnObligationsFils - monthDepositCoverFils;
  const companyCollectedFils = bankRecognizedFils + monthDepositCoverFils;

  // collectedFils = TENANT COLLECTED; remaining = TENANT UNPAID; deposited = COMPANY.
  const collectedFils = tenantPaidFils;
  const remainingFils = tenantUnpaidFils;
  const depositedFils = companyCollectedFils;

  const arrearsFils = views
    .filter((v) => isPastDue(v.dueDate, asOfDate))
    .reduce((s, v) => s + v.remainingFils, 0);

  const pendingDepositsFils = (deposits || [])
    .filter((d) => d && d.baselineExcluded !== true && d.state === APPROVAL_STATE.PENDING)
    .reduce((s, d) => s + toSafeFils(d.amountFils), 0);
  const pendingBankFils = (receipts || [])
    .filter((r) => r && r.baselineExcluded !== true && r.state === RECEIPT_STATE.PENDING)
    .reduce((s, r) => s + toSafeFils(r.amountFils), 0);

  const expensesFils = (expenses || [])
    .filter(isApproved)
    .reduce((s, e) => s + toSafeFils(e.amountFils), 0);

  const custody = holdingByEmployee({ receipts, deposits });
  const holdingFils = sharedHoldingFils({ receipts, deposits });

  // Income / Net income are domain KPIs derived from the same company/deposit truth —
  // never from UI history rows. Income = money recognized as company/deposited for the period.
  const incomeFils = depositedFils;
  const netIncomeFils = incomeFils - expensesFils;

  const counts = { total: views.length, not_due: 0, late: 0, partial: 0, collected: 0 };
  for (const v of views) counts[v.status] += 1;

  return {
    targetFils,
    collectedFils,
    remainingFils,
    tenantPaidFils,
    tenantUnpaidFils,
    companyCollectedFils,
    atEmployeesMonthFils,
    cashOnObligationsFils,
    arrearsFils,
    depositedFils,
    approvedDepositsFils,
    bankRecognizedFils,
    pendingDepositsFils,
    pendingBankFils,
    holdingFils,
    sharedEmployeeHoldingFils: holdingFils,
    custody,
    expensesFils,
    incomeFils,
    netIncomeFils,
    dailyPaidFils,
    counts,
    views,
  };
}

/* ───────────────────── invariant check ───────────────────── */

/**
 * Fails loudly. Never repairs, never clamps. A broken invariant is evidence, not noise.
 */
export function checkInvariants(summary) {
  const problems = [];

  if (summary.targetFils !== summary.collectedFils + summary.remainingFils) {
    problems.push({ code: "TARGET_MISMATCH", detail: "Target ≠ Collected + Remaining" });
  }
  const cashCollected = summary.custody.reduce((s, r) => s + r.cashCollectedFils, 0);
  // Holding-reducing deposits only (external deposits are skipped in custody.depositedFils).
  const holdingDeposits = summary.custody.reduce((s, r) => s + (r.depositedFils || 0), 0);
  if (summary.holdingFils !== cashCollected - holdingDeposits) {
    problems.push({ code: "HOLDING_MISMATCH", detail: "Shared Holding ≠ recognized cash − approved deposits" });
  }
  if (summary.holdingFils < 0) {
    problems.push({
      code: "NEGATIVE_HOLDING",
      detail: "Shared employee holding is negative",
      holdingFils: summary.holdingFils,
    });
  }
  // Income/Net must track deposited/company truth — never a parallel UI sum.
  if (summary.incomeFils != null && summary.incomeFils !== summary.depositedFils) {
    problems.push({ code: "INCOME_MISMATCH", detail: "Income ≠ Deposited (canonical)" });
  }
  if (
    summary.netIncomeFils != null
    && summary.netIncomeFils !== summary.incomeFils - summary.expensesFils
  ) {
    problems.push({ code: "NET_INCOME_MISMATCH", detail: "Net income ≠ Income − approved expenses" });
  }
  if (summary.companyCollectedFils != null && summary.companyCollectedFils !== summary.depositedFils) {
    problems.push({ code: "DEPOSITED_COMPANY_MISMATCH", detail: "Deposited ≠ companyCollectedFils" });
  }
  for (const v of summary.views) {
    if (v.remainingFils < 0) {
      problems.push({ code: "OVERPAID_OBLIGATION", detail: `Obligation ${v.obligationId} is overpaid`, obligationId: v.obligationId });
    }
    const expected = deriveStatus({ dueFils: v.dueFils, paidFils: v.paidFils, dueDate: v.dueDate, asOfDate: null });
    if (v.status === STATUS.COLLECTED && v.paidFils < v.dueFils) {
      problems.push({ code: "STATUS_MONEY_MISMATCH", detail: `Obligation ${v.obligationId} shows collected while underpaid` });
    }
    void expected;
  }
  return { ok: problems.length === 0, problems };
}

/* ───────────────────── period helpers ───────────────────── */

/** "2026-09" from an ISO date. Periods are strings so they sort and compare directly. */
export function periodOf(isoDate) {
  const s = String(isoDate || "");
  if (!/^\d{4}-\d{2}/.test(s)) throw new DomainError("INVALID_DATE", { isoDate });
  return s.slice(0, 7);
}

/** Due date for a rental in a period, clamped to the real length of that month. */
export function dueDateFor(period, dueDayOfMonth) {
  if (!/^\d{4}-\d{2}$/.test(String(period))) throw new DomainError("INVALID_PERIOD", { period });
  const [y, m] = String(period).split("-").map(Number);
  const day = Math.min(Math.max(1, Math.floor(Number(dueDayOfMonth) || 1)), daysInMonth(y, m));
  return `${period}-${String(day).padStart(2, "0")}`;
}

export function daysInMonth(year, month1to12) {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

/** Deterministic obligation id — makes double generation impossible at the database. */
export function obligationIdFor(rentalId, period) {
  return `${rentalId}_${period}`;
}
