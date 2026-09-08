import test from "node:test";
import assert from "node:assert/strict";
import {
  parseAedToFils, formatFils, obligationView, deriveStatus, assertReceiptFits,
  holdingByEmployee, sharedHoldingFils, assertDepositFitsCustody, assertCashReversalFitsSharedHolding,
  totalHoldingFils, periodSummary, checkInvariants,
  STATUS, RECEIPT_STATE, APPROVAL_STATE, DomainError, periodOf, dueDateFor, obligationIdFor,
} from "../../src/domain/finance.mjs";

const RENT = 920000;
const ob = (amount = RENT) => ({
  id: "ob1", rentalId: "r1", spaceId: "s1", unitId: "u1", propertyId: "p1",
  period: "2026-09", amountFils: amount, dueDate: "2026-09-01", state: "active",
  tenantNameSnapshot: "أحمد",
});

test("money: parseAedToFils integer and decimal", () => {
  assert.equal(parseAedToFils(9200), 920000);
  assert.equal(parseAedToFils("9,200"), 920000);
  assert.equal(parseAedToFils("9200.50"), 920050);
  assert.equal(parseAedToFils(9200.005), 920000);
  assert.equal(parseAedToFils("bad"), null);
});

test("money: formatFils display only", () => {
  assert.equal(formatFils(920000), "9,200");
  assert.equal(formatFils(920050), "9,200.50");
});

test("M1: partial status when paid < due", () => {
  const receipts = [{ id: "a", obligationId: "ob1", amountFils: 900000, state: RECEIPT_STATE.RECOGNIZED, method: "cash", collectorUserId: "y" }];
  const view = obligationView(ob(), receipts, "2026-09-15");
  assert.equal(view.paidFils, 900000);
  assert.equal(view.remainingFils, 20000);
  assert.equal(view.status, STATUS.PARTIAL);
});

test("M1: collected when paid >= due", () => {
  const receipts = [
    { id: "a", obligationId: "ob1", amountFils: 900000, state: RECEIPT_STATE.RECOGNIZED, method: "cash", collectorUserId: "y" },
    { id: "b", obligationId: "ob1", amountFils: 20000, state: RECEIPT_STATE.RECOGNIZED, method: "cash", collectorUserId: "n" },
  ];
  const view = obligationView(ob(), receipts, "2026-09-15");
  assert.equal(view.paidFils, 920000);
  assert.equal(view.remainingFils, 0);
  assert.equal(view.status, STATUS.COLLECTED);
});

test("deriveStatus: never collected while underpaid", () => {
  for (const paid of [0, 1, 450000, 919999]) {
    const st = deriveStatus({ dueFils: 920000, paidFils: paid, dueDate: "2026-09-01", asOfDate: "2026-09-15" });
    assert.notEqual(st, STATUS.COLLECTED);
  }
});

test("D2: overpayment refused with exact figures", () => {
  const receipts = [{ id: "a", obligationId: "ob1", amountFils: 900000, state: RECEIPT_STATE.RECOGNIZED, method: "cash", collectorUserId: "y" }];
  assert.throws(() => assertReceiptFits({ obligation: ob(), receipts, amountFils: 30000, asOfDate: "2026-09-15" }), (e) => {
    assert.equal(e.code, "AMOUNT_EXCEEDS_REMAINING");
    assert.equal(e.details.remainingFils, 20000);
    return true;
  });
});

test("M2: multi-collector attribution is audit, holding is shared", () => {
  const receipts = [
    { id: "a", obligationId: "ob1", amountFils: 500000, state: RECEIPT_STATE.RECOGNIZED, method: "cash", collectorUserId: "yahia" },
    { id: "b", obligationId: "ob1", amountFils: 400000, state: RECEIPT_STATE.RECOGNIZED, method: "cash", collectorUserId: "nader" },
  ];
  const rows = holdingByEmployee({ receipts, deposits: [] });
  const y = rows.find((r) => r.userId === "yahia");
  const n = rows.find((r) => r.userId === "nader");
  assert.equal(y.cashCollectedFils, 500000);
  assert.equal(n.cashCollectedFils, 400000);
  assert.equal(sharedHoldingFils({ receipts, deposits: [] }), 900000);
});

test("M2: approved deposit reduces SHARED holding, not personal collected", () => {
  const receipts = [
    { id: "a", obligationId: "ob1", amountFils: 500000, state: RECEIPT_STATE.RECOGNIZED, method: "cash", collectorUserId: "yahia" },
    { id: "b", obligationId: "ob1", amountFils: 400000, state: RECEIPT_STATE.RECOGNIZED, method: "cash", collectorUserId: "nader" },
  ];
  const deposits = [{ id: "d1", employeeId: "nader", amountFils: 700000, state: APPROVAL_STATE.APPROVED }];
  assert.equal(sharedHoldingFils({ receipts, deposits }), 200000);
  assert.equal(holdingByEmployee({ receipts, deposits }).find((r) => r.userId === "yahia").cashCollectedFils, 500000);
  assert.equal(holdingByEmployee({ receipts, deposits }).find((r) => r.userId === "nader").cashCollectedFils, 400000);
});

test("F: pending deposit does not reduce holding", () => {
  const receipts = [{ id: "a", obligationId: "ob1", amountFils: 1000000, state: RECEIPT_STATE.RECOGNIZED, method: "cash", collectorUserId: "e1" }];
  const deposits = [{ id: "d1", employeeId: "e1", amountFils: 800000, state: APPROVAL_STATE.PENDING }];
  assert.equal(sharedHoldingFils({ receipts, deposits }), 1000000);
});

test("G: pending bank receipt not recognized", () => {
  const receipts = [{ id: "b", obligationId: "ob1", amountFils: 300000, state: RECEIPT_STATE.PENDING, method: "bank", collectorUserId: "e1" }];
  const view = obligationView(ob(), receipts, "2026-09-15");
  assert.equal(view.paidFils, 0);
  const rows = holdingByEmployee({ receipts, deposits: [] });
  assert.equal(rows.length, 0);
});

test("D1: bank recognized increases deposited not holding", () => {
  const receipts = [{ id: "b", obligationId: "ob1", amountFils: 300000, state: RECEIPT_STATE.RECOGNIZED, method: "bank", collectorUserId: "e1" }];
  const summary = periodSummary({ obligations: [ob()], receipts, deposits: [], expenses: [], asOfDate: "2026-09-15" });
  assert.equal(summary.collectedFils, 300000);
  assert.equal(summary.depositedFils, 300000);
  assert.equal(summary.holdingFils, 0);
});

test("M4: partial payments stay separate receipts", () => {
  const receipts = [
    { id: "a", obligationId: "ob1", amountFils: 300000, state: RECEIPT_STATE.RECOGNIZED, method: "cash", collectorUserId: "e" },
    { id: "b", obligationId: "ob1", amountFils: 200000, state: RECEIPT_STATE.RECOGNIZED, method: "cash", collectorUserId: "e" },
  ];
  const view = obligationView(ob(1000000), receipts, "2026-09-15");
  assert.equal(view.paidFils, 500000);
  assert.equal(view.remainingFils, 500000);
  assert.equal(view.receiptCount, 2);
  assert.equal(view.status, STATUS.PARTIAL);
});

test("M7: reversed receipt excluded from paid and holding", () => {
  const receipts = [
    { id: "a", obligationId: "ob1", amountFils: 400000, state: RECEIPT_STATE.REVERSED, method: "cash", collectorUserId: "e" },
  ];
  const view = obligationView(ob(), receipts, "2026-09-15");
  assert.equal(view.paidFils, 0);
  assert.equal(holdingByEmployee({ receipts, deposits: [] }).length, 0);
});

test("invariant A: target = collected + remaining", () => {
  const receipts = [{ id: "a", obligationId: "ob1", amountFils: 900000, state: RECEIPT_STATE.RECOGNIZED, method: "cash", collectorUserId: "e" }];
  const summary = periodSummary({ obligations: [ob()], receipts, deposits: [], expenses: [], asOfDate: "2026-09-15" });
  assert.equal(summary.targetFils, summary.collectedFils + summary.remainingFils);
  const inv = checkInvariants(summary);
  assert.equal(inv.ok, true, JSON.stringify(inv.problems));
});

test("MONTHLY KPI: TARGET = tenantCollected + unpaid; collected = company + atEmployees", () => {
  const obligations = [ob(1000000)];
  const receipts = [
    { id: "c", obligationId: "ob1", amountFils: 300000, state: RECEIPT_STATE.RECOGNIZED, method: "cash", collectorUserId: "yahia" },
  ];
  const before = periodSummary({ obligations, receipts, deposits: [], expenses: [], asOfDate: "2026-09-15" });
  assert.equal(before.targetFils, 1000000);
  assert.equal(before.collectedFils, 300000);
  assert.equal(before.companyCollectedFils, 0);
  assert.equal(before.atEmployeesMonthFils, 300000);
  assert.equal(before.tenantUnpaidFils, 700000);
  assert.equal(before.targetFils, before.collectedFils + before.tenantUnpaidFils);
  assert.equal(before.collectedFils, before.companyCollectedFils + before.atEmployeesMonthFils);

  const deposits = [{ id: "d", amountFils: 200000, state: "approved", employeeId: "yahia" }];
  const after = periodSummary({ obligations, receipts, deposits, expenses: [], asOfDate: "2026-09-15" });
  assert.equal(after.collectedFils, 300000);
  assert.equal(after.companyCollectedFils, 200000);
  assert.equal(after.atEmployeesMonthFils, 100000);
  assert.equal(after.tenantUnpaidFils, 700000);
  assert.equal(after.targetFils, after.collectedFils + after.tenantUnpaidFils);
  assert.equal(after.collectedFils, after.companyCollectedFils + after.atEmployeesMonthFils);
});

test("BANK goes to companyCollected, never atEmployees", () => {
  const receipts = [
    { id: "b", obligationId: "ob1", amountFils: 400000, state: RECEIPT_STATE.RECOGNIZED, method: "bank", collectorUserId: "nader" },
  ];
  const summary = periodSummary({ obligations: [ob()], receipts, deposits: [], expenses: [], asOfDate: "2026-09-15" });
  assert.equal(summary.companyCollectedFils, 400000);
  assert.equal(summary.atEmployeesMonthFils, 0);
  assert.equal(summary.tenantUnpaidFils, 520000);
});

test("invariant E: holding = cash collected - approved deposits", () => {
  const receipts = [{ id: "a", obligationId: "ob1", amountFils: 500000, state: RECEIPT_STATE.RECOGNIZED, method: "cash", collectorUserId: "e" }];
  const deposits = [{ id: "d", employeeId: "e", amountFils: 300000, state: APPROVAL_STATE.APPROVED }];
  const summary = periodSummary({ obligations: [ob()], receipts, deposits, expenses: [], asOfDate: "2026-09-15" });
  assert.equal(summary.holdingFils, 200000);
  assert.equal(checkInvariants(summary).ok, true);
});

test("invariant B: status mismatch detected", () => {
  const summary = periodSummary({ obligations: [ob()], receipts: [], deposits: [], expenses: [], asOfDate: "2026-09-15" });
  summary.views[0].status = STATUS.COLLECTED;
  summary.views[0].paidFils = 100;
  const inv = checkInvariants(summary);
  assert.equal(inv.ok, false);
  assert.ok(inv.problems.some((p) => p.code === "STATUS_MONEY_MISMATCH"));
});

test("occupancy: not_due before due date with zero paid", () => {
  const st = deriveStatus({ dueFils: 920000, paidFils: 0, dueDate: "2026-09-15", asOfDate: "2026-09-01" });
  assert.equal(st, STATUS.NOT_DUE);
});

test("late when past due and unpaid", () => {
  const st = deriveStatus({ dueFils: 920000, paidFils: 0, dueDate: "2026-09-01", asOfDate: "2026-09-15" });
  assert.equal(st, STATUS.LATE);
});

test("period helpers", () => {
  assert.equal(periodOf("2026-09-15"), "2026-09");
  assert.equal(dueDateFor("2026-02", 31), "2026-02-28");
  assert.equal(obligationIdFor("rental1", "2026-09"), "rental1_2026-09");
});

test("negative shared holding reported not clamped", () => {
  const deposits = [{ id: "d", employeeId: "e", amountFils: 500000, state: APPROVAL_STATE.APPROVED }];
  assert.equal(sharedHoldingFils({ receipts: [], deposits }), -500000);
});

test("cancelled obligation has zero due", () => {
  const cancelled = { ...ob(), state: "cancelled" };
  const view = obligationView(cancelled, [], "2026-09-15");
  assert.equal(view.dueFils, 0);
});

test("filters receipts to obligation only", () => {
  const receipts = [
    { id: "a", obligationId: "ob1", amountFils: 100000, state: RECEIPT_STATE.RECOGNIZED, method: "cash", collectorUserId: "e" },
    { id: "b", obligationId: "ob2", amountFils: 999999, state: RECEIPT_STATE.RECOGNIZED, method: "cash", collectorUserId: "e" },
  ];
  const view = obligationView(ob(), receipts, "2026-09-15");
  assert.equal(view.paidFils, 100000);
});

test("totalHoldingFils is unused for shared pool (rows are audit)", () => {
  const rows = [{ holdingFils: 0, cashCollectedFils: 200000 }, { holdingFils: 0, cashCollectedFils: 400000 }];
  assert.equal(totalHoldingFils(rows), 0);
});

test("approved expenses in summary", () => {
  const expenses = [{ id: "x", amountFils: 50000, state: APPROVAL_STATE.APPROVED }];
  const summary = periodSummary({ obligations: [ob()], receipts: [], deposits: [], expenses, asOfDate: "2026-09-15" });
  assert.equal(summary.expensesFils, 50000);
});

test("arrears sums remaining on past-due obligations", () => {
  const summary = periodSummary({ obligations: [ob()], receipts: [], deposits: [], expenses: [], asOfDate: "2026-10-01" });
  assert.equal(summary.arrearsFils, 920000);
});

// ══════════════════════════════════════════
// UPFRONT RENT DUE-DATE MATRIX TESTS
// Contract: startDate=2026-09-10, rent=120000 fils, dueDayOfMonth=10
// ══════════════════════════════════════════

const RENT_120 = 120000; // 1,200 AED
const obSep10 = (paid = 0) => ({
  id: "ob_sep10", rentalId: "r10", spaceId: "s10", unitId: "u10", propertyId: "p10",
  period: "2026-09", amountFils: RENT_120, dueDate: "2026-09-10", state: "active",
  tenantNameSnapshot: "مستأجر",
});
const receipt120 = (id, amount) => ({ id, obligationId: "ob_sep10", amountFils: amount, state: RECEIPT_STATE.RECOGNIZED, method: "cash", collectorUserId: "e1" });
const receipt120Bank = (id, amount) => ({ id, obligationId: "ob_sep10", amountFils: amount, state: RECEIPT_STATE.RECOGNIZED, method: "bank", collectorUserId: "e1" });

// Sep 9: before due date, unpaid → NOT_DUE
test("DUE-DATE: Sep 9 unpaid → not_due (غير مستحق)", () => {
  const st = deriveStatus({ dueFils: RENT_120, paidFils: 0, dueDate: "2026-09-10", asOfDate: "2026-09-09" });
  assert.equal(st, STATUS.NOT_DUE);
});

// Sep 10: ON due date, unpaid → LATE
test("DUE-DATE: Sep 10 unpaid → late (متأخر) [ON due date]", () => {
  const st = deriveStatus({ dueFils: RENT_120, paidFils: 0, dueDate: "2026-09-10", asOfDate: "2026-09-10" });
  assert.equal(st, STATUS.LATE);
});

// Sep 10: paid 500 → PARTIAL
test("DUE-DATE: Sep 10 paid 500 → partial (جزئي)", () => {
  const st = deriveStatus({ dueFils: RENT_120, paidFils: 50000, dueDate: "2026-09-10", asOfDate: "2026-09-10" });
  assert.equal(st, STATUS.PARTIAL);
});

// Sep 10: fully paid → COLLECTED
test("DUE-DATE: Sep 10 fully paid → collected (محصل)", () => {
  const st = deriveStatus({ dueFils: RENT_120, paidFils: RENT_120, dueDate: "2026-09-10", asOfDate: "2026-09-10" });
  assert.equal(st, STATUS.COLLECTED);
});

// Oct obligation: dueDate = 2026-10-10
// Oct 1: not_due
test("DUE-DATE: Oct 1 unpaid → not_due (obligation exists early)", () => {
  const st = deriveStatus({ dueFils: RENT_120, paidFils: 0, dueDate: "2026-10-10", asOfDate: "2026-10-01" });
  assert.equal(st, STATUS.NOT_DUE);
});

// Oct 9: not_due
test("DUE-DATE: Oct 9 unpaid → not_due", () => {
  const st = deriveStatus({ dueFils: RENT_120, paidFils: 0, dueDate: "2026-10-10", asOfDate: "2026-10-09" });
  assert.equal(st, STATUS.NOT_DUE);
});

// Oct 10: unpaid → LATE
test("DUE-DATE: Oct 10 unpaid → late", () => {
  const st = deriveStatus({ dueFils: RENT_120, paidFils: 0, dueDate: "2026-10-10", asOfDate: "2026-10-10" });
  assert.equal(st, STATUS.LATE);
});

// Oct 10: partial
test("DUE-DATE: Oct 10 partial paid → partial", () => {
  const st = deriveStatus({ dueFils: RENT_120, paidFils: 50000, dueDate: "2026-10-10", asOfDate: "2026-10-10" });
  assert.equal(st, STATUS.PARTIAL);
});

// Oct 10: full
test("DUE-DATE: Oct 10 full paid → collected", () => {
  const st = deriveStatus({ dueFils: RENT_120, paidFils: RENT_120, dueDate: "2026-10-10", asOfDate: "2026-10-10" });
  assert.equal(st, STATUS.COLLECTED);
});

// ══════════════════════════════════════════
// RECEIPT REVERSAL TESTS
// ══════════════════════════════════════════

test("M7: receipt reversal excluded from paid/holding (correct)", () => {
  const receipts = [
    { id: "a", obligationId: "ob_sep10", amountFils: RENT_120, state: RECEIPT_STATE.RECOGNIZED, method: "cash", collectorUserId: "e1" },
  ];
  // After reversal, state changes to REVERSED
  const reversed = [{ ...receipts[0], state: RECEIPT_STATE.REVERSED }];
  const view = obligationView(obSep10(), reversed, "2026-09-10");
  assert.equal(view.paidFils, 0);
  assert.equal(view.remainingFils, RENT_120);
  assert.equal(view.status, STATUS.LATE); // Oct 10 is due date, reversed → unpaid → LATE
  const rows = holdingByEmployee({ receipts: reversed, deposits: [] });
  assert.equal(rows.length, 0, "Reversed receipt should not appear in holding");
});

test("CORRECTION: collected receipt reversed BEFORE due → not_due", () => {
  // Obligation due 2026-09-20; today is 2026-09-15 (before due)
  const ob = { id: "ob", rentalId: "r", spaceId: "s", unitId: "u", propertyId: "p",
    period: "2026-09", amountFils: 120000, dueDate: "2026-09-20", state: "active", tenantNameSnapshot: "T" };
  const receipts = [{ id: "r1", obligationId: "ob", amountFils: 120000, state: RECEIPT_STATE.REVERSED, method: "cash", collectorUserId: "e1" }];
  const view = obligationView(ob, receipts, "2026-09-15");
  assert.equal(view.paidFils, 0);
  assert.equal(view.status, STATUS.NOT_DUE, "Before due date + no payment → not_due");
});

test("CORRECTION: collected receipt reversed ON/AFTER due → late", () => {
  const ob = { id: "ob", rentalId: "r", spaceId: "s", unitId: "u", propertyId: "p",
    period: "2026-09", amountFils: 120000, dueDate: "2026-09-20", state: "active", tenantNameSnapshot: "T" };
  const receipts = [{ id: "r1", obligationId: "ob", amountFils: 120000, state: RECEIPT_STATE.REVERSED, method: "cash", collectorUserId: "e1" }];
  const view = obligationView(ob, receipts, "2026-09-20");
  assert.equal(view.paidFils, 0);
  assert.equal(view.status, STATUS.LATE, "ON due date + no payment → late");
});

// ══════════════════════════════════════════
// PARTIAL STATUS
// ══════════════════════════════════════════

test("PARTIAL: partial paid always shows partial regardless of due date", () => {
  // Even before due date, if some money is paid, show PARTIAL
  const stBefore = deriveStatus({ dueFils: 120000, paidFils: 50000, dueDate: "2026-10-10", asOfDate: "2026-10-01" });
  assert.equal(stBefore, STATUS.PARTIAL);
  const stOn = deriveStatus({ dueFils: 120000, paidFils: 50000, dueDate: "2026-10-10", asOfDate: "2026-10-10" });
  assert.equal(stOn, STATUS.PARTIAL);
});

// ══════════════════════════════════════════
// END-OF-MONTH CONTRACT START DATE
// ══════════════════════════════════════════

test("EDGE: contract starts Jan 31 — Feb clamped to 28 (non-leap)", () => {
  // 2026 is not a leap year
  assert.equal(dueDateFor("2026-02", 31), "2026-02-28");
});

test("EDGE: contract starts Jan 31 — Feb clamped to 29 (leap year)", () => {
  // 2024 is a leap year
  assert.equal(dueDateFor("2024-02", 31), "2024-02-29");
});

test("EDGE: contract starts Jan 31 — Mar returns to 31", () => {
  assert.equal(dueDateFor("2026-03", 31), "2026-03-31");
});

test("EDGE: contract starts Jan 29 — Feb 2026 clamped to 28", () => {
  assert.equal(dueDateFor("2026-02", 29), "2026-02-28");
});

test("EDGE: contract starts Jan 29 — Feb 2024 uses 29", () => {
  assert.equal(dueDateFor("2024-02", 29), "2024-02-29");
});

// ══════════════════════════════════════════
// BANK RECEIPT REVERSAL - DOES NOT AFFECT HOLDING
// ══════════════════════════════════════════

test("BANK: bank receipt recognized → deposited, not holding", () => {
  const receipts = [receipt120Bank("b1", 120000)];
  const summary = periodSummary({ obligations: [obSep10()], receipts, deposits: [], expenses: [], asOfDate: "2026-09-10" });
  assert.equal(summary.collectedFils, 120000);
  assert.equal(summary.holdingFils, 0);
  assert.equal(summary.depositedFils, 120000);
});

test("BANK: display-only bank history rows must not double-count deposited", () => {
  const receipts = [receipt120Bank("b1", 120000)];
  // UI may attach a synthetic deposit history row for the same bank receipt.
  const deposits = [{
    id: "b1", amountFils: 120000, state: "approved", sourceKind: "bank", fromBankReceipt: true,
    depositDate: "2026-09-10", employeeId: "e1",
  }];
  const summary = periodSummary({ obligations: [obSep10()], receipts, deposits, expenses: [], asOfDate: "2026-09-10" });
  assert.equal(summary.collectedFils, 120000);
  assert.equal(summary.depositedFils, 120000);
  assert.equal(summary.approvedDepositsFils, 0);
  assert.equal(summary.holdingFils, 0);
});

test("BANK: bank receipt reversed → no effect on holding or deposited", () => {
  const receipts = [{ ...receipt120Bank("b1", 120000), state: RECEIPT_STATE.REVERSED }];
  const summary = periodSummary({ obligations: [obSep10()], receipts, deposits: [], expenses: [], asOfDate: "2026-09-10" });
  assert.equal(summary.collectedFils, 0);
  assert.equal(summary.holdingFils, 0);
  assert.equal(summary.depositedFils, 0);
});

// ══════════════════════════════════════════
// DOUBLE REVERSAL (domain level)
// The command layer blocks it (ALREADY_REVERSED). Domain: reversed receipts are simply
// not recognized, so a second reversal produces zero additional effect.
// ══════════════════════════════════════════

test("DOUBLE-REVERSAL: already-reversed receipt produces no paid change", () => {
  const rev1 = { id: "a", obligationId: "ob_sep10", amountFils: 120000, state: RECEIPT_STATE.REVERSED, method: "cash", collectorUserId: "e1" };
  const v1 = obligationView(obSep10(), [rev1], "2026-09-10");
  // Simulate "another reversal" that leaves state still REVERSED
  const v2 = obligationView(obSep10(), [rev1], "2026-09-10");
  assert.equal(v1.paidFils, 0);
  assert.equal(v2.paidFils, 0);
});

// ══════════════════════════════════════════
// FINANCIAL INVARIANTS AFTER REVERSAL
// ══════════════════════════════════════════

test("INVARIANT: after reversal, target=collected+remaining and holding reconciles", () => {
  const receipts = [
    { id: "a", obligationId: "ob_sep10", amountFils: 120000, state: RECEIPT_STATE.REVERSED, method: "cash", collectorUserId: "e1" },
  ];
  const summary = periodSummary({ obligations: [obSep10()], receipts, deposits: [], expenses: [], asOfDate: "2026-09-10" });
  assert.equal(summary.targetFils, summary.collectedFils + summary.remainingFils);
  assert.equal(summary.holdingFils, 0);
  const inv = checkInvariants(summary);
  assert.equal(inv.ok, true, JSON.stringify(inv.problems));
});

// ══════════════════════════════════════════
// SHARED EMPLOYEE HOLDING (عهدة الموظفين)
// ══════════════════════════════════════════

test("SHARED A: Yahia 5000 + Nader 4000 = 9000", () => {
  const receipts = [
    { id: "y", obligationId: "ob1", amountFils: 500000, state: RECEIPT_STATE.RECOGNIZED, method: "cash", collectorUserId: "yahia" },
    { id: "n", obligationId: "ob1", amountFils: 400000, state: RECEIPT_STATE.RECOGNIZED, method: "cash", collectorUserId: "nader" },
  ];
  assert.equal(sharedHoldingFils({ receipts, deposits: [] }), 900000);
});

test("SHARED B: pending 7000 does not reduce; approved → 2000", () => {
  const receipts = [
    { id: "y", obligationId: "ob1", amountFils: 500000, state: RECEIPT_STATE.RECOGNIZED, method: "cash", collectorUserId: "yahia" },
    { id: "n", obligationId: "ob1", amountFils: 400000, state: RECEIPT_STATE.RECOGNIZED, method: "cash", collectorUserId: "nader" },
  ];
  const pending = [{ id: "d", employeeId: "nader", amountFils: 700000, state: APPROVAL_STATE.PENDING }];
  assert.equal(sharedHoldingFils({ receipts, deposits: pending }), 900000);
  const approved = [{ id: "d", employeeId: "nader", amountFils: 700000, state: APPROVAL_STATE.APPROVED }];
  assert.equal(sharedHoldingFils({ receipts, deposits: approved }), 200000);
});

test("SHARED C: deposit exceeding shared pool refused", () => {
  const receipts = [
    { id: "y", obligationId: "ob1", amountFils: 500000, state: RECEIPT_STATE.RECOGNIZED, method: "cash", collectorUserId: "yahia" },
    { id: "n", obligationId: "ob1", amountFils: 400000, state: RECEIPT_STATE.RECOGNIZED, method: "cash", collectorUserId: "nader" },
  ];
  const deposits = [{ id: "d", employeeId: "nader", amountFils: 700000, state: APPROVAL_STATE.APPROVED }];
  assert.throws(
    () => assertDepositFitsCustody({ employeeId: "yahia", amountFils: 300000, receipts, deposits }),
    (e) => e.code === "AMOUNT_EXCEEDS_HOLDING" && e.details.holdingFils === 200000
  );
});

test("SHARED D: zero-personal-collection employee may deposit from shared pool", () => {
  const receipts = [
    { id: "n", obligationId: "ob1", amountFils: 400000, state: RECEIPT_STATE.RECOGNIZED, method: "cash", collectorUserId: "nader" },
  ];
  const holding = assertDepositFitsCustody({
    employeeId: "future-emp", amountFils: 100000, receipts, deposits: [],
  });
  assert.equal(holding, 400000);
});

test("external deposit does not reduce shared holding or employee depositedFils", () => {
  const receipts = [
    { id: "y", obligationId: "ob1", amountFils: 500000, state: RECEIPT_STATE.RECOGNIZED, method: "cash", collectorUserId: "yahia" },
  ];
  const deposits = [
    { id: "d1", employeeId: "yahia", amountFils: 200000, state: APPROVAL_STATE.APPROVED, sourceKind: "holding" },
    { id: "d2", employeeId: "yahia", amountFils: 100000, state: APPROVAL_STATE.APPROVED, sourceKind: "external" },
  ];
  assert.equal(sharedHoldingFils({ receipts, deposits }), 300000);
  const row = holdingByEmployee({ receipts, deposits }).find((r) => r.userId === "yahia");
  assert.equal(row.depositedFils, 200000);
  assert.equal(row.cashCollectedFils, 500000);
});

test("daily_booking receipts count in periodSummary paid and cash pool", () => {
  const daily = {
    id: "rd", obligationId: "daily:b1", amountFils: 150000, state: RECEIPT_STATE.RECOGNIZED,
    method: "cash", collectorUserId: "yahia", sourceType: "daily_booking",
  };
  const summary = periodSummary({
    obligations: [ob()], receipts: [daily], deposits: [], expenses: [], asOfDate: "2026-09-15",
  });
  assert.equal(summary.dailyPaidFils, 150000);
  assert.equal(summary.tenantPaidFils, 150000);
  assert.equal(summary.collectedFils, 150000);
  assert.equal(summary.cashOnObligationsFils, 150000);
  assert.equal(summary.targetFils, RENT + 150000);
  assert.equal(summary.tenantUnpaidFils, RENT);
  assert.equal(checkInvariants(summary).ok, true);
});

test("SHARED E/F: cash reversal vs shared pool", () => {
  const receipts = [
    { id: "y", obligationId: "ob1", amountFils: 500000, state: RECEIPT_STATE.RECOGNIZED, method: "cash", collectorUserId: "yahia" },
    { id: "n", obligationId: "ob1", amountFils: 400000, state: RECEIPT_STATE.RECOGNIZED, method: "cash", collectorUserId: "nader" },
  ];
  const deposits = [{ id: "d", employeeId: "nader", amountFils: 700000, state: APPROVAL_STATE.APPROVED }];
  // reverse 1000 → holding 1000, allowed
  assert.equal(assertCashReversalFitsSharedHolding({
    receipts, deposits, reversingReceiptIds: ["small"],
  }), 200000); // small id not in receipts so holding unchanged — use real id
  const r1k = { id: "r1k", obligationId: "ob1", amountFils: 100000, state: RECEIPT_STATE.RECOGNIZED, method: "cash", collectorUserId: "yahia" };
  const r3k = { id: "r3k", obligationId: "ob1", amountFils: 300000, state: RECEIPT_STATE.RECOGNIZED, method: "cash", collectorUserId: "yahia" };
  const recs = [
    { id: "a", obligationId: "ob1", amountFils: 500000, state: RECEIPT_STATE.RECOGNIZED, method: "cash", collectorUserId: "yahia" },
    { id: "b", obligationId: "ob1", amountFils: 400000, state: RECEIPT_STATE.RECOGNIZED, method: "cash", collectorUserId: "nader" },
    r1k,
  ];
  // 5000+4000+1000=10000 cash - 7000 dep = 3000; reverse 1000 → 2000
  const after = assertCashReversalFitsSharedHolding({
    receipts: recs, deposits, reversingReceiptIds: ["r1k"],
  });
  assert.equal(after, 200000);

  const recs2 = [
    { id: "a", obligationId: "ob1", amountFils: 500000, state: RECEIPT_STATE.RECOGNIZED, method: "cash", collectorUserId: "yahia" },
    { id: "b", obligationId: "ob1", amountFils: 400000, state: RECEIPT_STATE.RECOGNIZED, method: "cash", collectorUserId: "nader" },
    r3k,
  ];
  // 5000+4000+3000=12000 - 7000 = 5000; reverse 3000 → 2000 allowed
  assert.equal(assertCashReversalFitsSharedHolding({
    receipts: recs2, deposits, reversingReceiptIds: ["r3k"],
  }), 200000);

  // 9000 cash - 7000 dep = 2000; reverse 3000 → -1000 blocked
  assert.throws(
    () => assertCashReversalFitsSharedHolding({
      receipts: [
        { id: "a", obligationId: "ob1", amountFils: 500000, state: RECEIPT_STATE.RECOGNIZED, method: "cash", collectorUserId: "yahia" },
        { id: "b", obligationId: "ob1", amountFils: 400000, state: RECEIPT_STATE.RECOGNIZED, method: "cash", collectorUserId: "nader" },
      ],
      deposits,
      reversingReceiptIds: ["a"], // 5000 reversal → 4000-7000 = -3000
    }),
    (e) => e.code === "RECEIPT_ALREADY_DEPOSITED"
  );
});

test("SHARED G: bank receipt excluded from holding", () => {
  const receipts = [
    { id: "c", obligationId: "ob1", amountFils: 400000, state: RECEIPT_STATE.RECOGNIZED, method: "cash", collectorUserId: "e1" },
    { id: "b", obligationId: "ob1", amountFils: 500000, state: RECEIPT_STATE.RECOGNIZED, method: "bank", collectorUserId: "e1" },
  ];
  assert.equal(sharedHoldingFils({ receipts, deposits: [] }), 400000);
});
