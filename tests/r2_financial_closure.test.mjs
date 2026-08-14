/**
 * R2 financial closure — canonical money paths, reconciliation, evidence classes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { blankState, executeCommand } from "../functions/domain/command_processor.mjs";
import { money, custodyProjection, ledgerReplay } from "../functions/domain/financial_engine.mjs";
import { monthlyOperationalProjection } from "../functions/domain/canonical_selectors.mjs";
import { assertReconciled, reconcileCanonicalState } from "../functions/domain/financial_reconciliation.mjs";
import { classifyLegacyMonth, dryRunLegacyClassification, EVIDENCE_CLASS } from "../functions/domain/legacy_evidence_classifier.mjs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const publicHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const owner = { id: "saeed", uid: "uid-owner", role: "owner", active: true };
const empA = { id: "yahia", uid: "uid-yahia", role: "employee", active: true };
const empB = { id: "nader", uid: "uid-nader", role: "employee", active: true };

function seed() {
  const s = blankState();
  s.financialTruthVersion = 3;
  s.openingBalances = { company: 0, revenue: 0, deduction: 0 };
  s.cycles.push({
    id: "cycle:r2:1", tenancyId: "tenancy:r2:1", tenantId: "tenant:r2:1",
    unitId: "unit:101", tenant: "Tenant", baseAmountFils: money(1000),
    reportingMonth: "2026_08", dueDate: "2026-08-01", status: "open_late", financialVersion: 0,
  });
  return s;
}
function go(s, command, operationId, actor, payload, now = "2026-08-14T12:00:00.000Z") {
  return executeCommand(s, command, { operationId, actor, payload, now }).state;
}
function replay(s, command, operationId, actor, payload) {
  return executeCommand(s, command, {
    operationId, actor, payload, now: "2026-08-14T12:00:00.000Z",
  });
}

test("R2-00 BUILD rc1 + index/public byte parity", () => {
  assert.equal(html, publicHtml);
  assert.equal(createHash("sha256").update(html).digest("hex"), createHash("sha256").update(publicHtml).digest("hex"));
  assert.match(html, /qama-unified-final-2026-08-14\.6-rc1/);
  assert.doesNotMatch(html, /qama-unified-final-2026-08-14\.5"/);
  assert.match(html, /LEGACY_FINANCIAL_WRITE_DISABLED/);
  assert.match(html, /commitMoneyOp\(opts\)\{\s*return blockLegacyFinancialWrite/);
});

test("R2-01 cash collection increases Collected+Holding, not Deposited; retry is replay", () => {
  let s = seed();
  const ctx = { cycleId: "cycle:r2:1", amountFils: money(400), paymentDate: "2026-08-14" };
  s = go(s, "createCashReceipt", "op:r2:cash", empA, ctx);
  const before = monthlyOperationalProjection(s, "2026_08", "2026-08-14").cards;
  assert.equal(before.collectedFils, money(400));
  assert.equal(before.depositedFils, 0);
  assert.equal(before.receivedNotDepositedFils, money(400));
  assert.equal(custodyProjection(s).byHolder[empA.id], money(400));
  const second = replay(s, "createCashReceipt", "op:r2:cash", empA, ctx);
  assert.equal(second.replay, true);
  assert.equal(second.state.collectionEvents.length, 1);
  assert.equal(monthlyOperationalProjection(second.state, "2026_08", "2026-08-14").cards.collectedFils, money(400));
  assertReconciled(second.state, "2026_08", "2026-08-14");
});

test("R2-02 two employees hold cash independently; bank never enters holding", () => {
  let s = seed();
  s.cycles.push({
    id: "cycle:r2:2", tenancyId: "tenancy:r2:2", unitId: "unit:102", tenant: "B",
    baseAmountFils: money(1000), reportingMonth: "2026_08", dueDate: "2026-08-01", status: "open_late", financialVersion: 0,
  });
  s = go(s, "createCashReceipt", "op:r2:a", empA, { cycleId: "cycle:r2:1", amountFils: money(300), paymentDate: "2026-08-14" });
  s = go(s, "createCashReceipt", "op:r2:b", empB, { cycleId: "cycle:r2:2", amountFils: money(200), paymentDate: "2026-08-14" });
  const hold = custodyProjection(s).byHolder;
  assert.equal(hold[empA.id], money(300));
  assert.equal(hold[empB.id], money(200));
  s = go(s, "createBankPayment", "op:r2:bank", empA, { cycleId: "cycle:r2:1", amountFils: money(100), paymentDate: "2026-08-14" });
  assert.equal(custodyProjection(s).byHolder[empA.id], money(300));
  s = go(s, "approveBankPayment", "op:r2:bank-ok", owner, { paymentId: "pay:op:r2:bank" });
  const p = monthlyOperationalProjection(s, "2026_08", "2026-08-14").cards;
  assert.equal(p.collectedFils, money(600));
  assert.equal(p.depositedFils, money(100));
  assert.equal(p.receivedNotDepositedFils, money(500));
  assert.equal(custodyProjection(s).byHolder[empA.id], money(300));
  assertReconciled(s, "2026_08", "2026-08-14");
});

test("R2-03 deposit approve moves holding to deposited once; reject is zero-effect; retry replays", () => {
  let s = seed();
  s = go(s, "createCashReceipt", "op:r2:c", empA, { cycleId: "cycle:r2:1", amountFils: money(500), paymentDate: "2026-08-14" });
  s = go(s, "createDepositRequest", "op:r2:d", empA, {
    amountFils: money(500), allocations: [{ cashLotId: "lot:op:r2:c", amountFils: money(500) }], depositDate: "2026-08-14",
  });
  assert.equal(monthlyOperationalProjection(s, "2026_08", "2026-08-14").cards.depositedFils, 0);
  const pending = s;
  let rejected = go(structuredClone(pending), "rejectDeposit", "op:r2:d-rej", owner, { depositRequestId: "dep:op:r2:d", reason: "not-now" });
  assert.equal(monthlyOperationalProjection(rejected, "2026_08", "2026-08-14").cards.depositedFils, 0);
  assert.equal(custodyProjection(rejected).totalFils, money(500));
  s = go(pending, "approveDeposit", "op:r2:d-ok", owner, { depositRequestId: "dep:op:r2:d" });
  const after = monthlyOperationalProjection(s, "2026_08", "2026-08-14").cards;
  assert.equal(after.collectedFils, money(500));
  assert.equal(after.depositedFils, money(500));
  assert.equal(after.receivedNotDepositedFils, 0);
  const again = replay(s, "approveDeposit", "op:r2:d-ok", owner, { depositRequestId: "dep:op:r2:d" });
  assert.equal(again.replay, true);
  assert.equal(monthlyOperationalProjection(again.state, "2026_08", "2026-08-14").cards.depositedFils, money(500));
  assert.deepEqual(ledgerReplay(s.openingBalances, s.ledger), s.balances);
  assertReconciled(s, "2026_08", "2026-08-14");
});

test("R2-04 handover moves custody once without minting collected/deposited/revenue", () => {
  let s = seed();
  s = go(s, "createCashReceipt", "op:r2:hv", empA, { cycleId: "cycle:r2:1", amountFils: money(250), paymentDate: "2026-08-14" });
  const before = monthlyOperationalProjection(s, "2026_08", "2026-08-14").cards;
  s = go(s, "createCustodyTransfer", "op:r2:send", empA, { to: empB.id, allocations: [{ cashLotId: "lot:op:r2:hv", amountFils: money(250) }] });
  assert.equal(custodyProjection(s).byHolder[empA.id], money(250));
  s = go(s, "confirmCustodyTransfer", "op:r2:ack", empB, { transferId: "xfer:op:r2:send" });
  const after = monthlyOperationalProjection(s, "2026_08", "2026-08-14").cards;
  assert.equal(after.collectedFils, before.collectedFils);
  assert.equal(after.depositedFils, before.depositedFils);
  assert.equal(after.receivedNotDepositedFils, before.receivedNotDepositedFils);
  assert.equal(custodyProjection(s).byHolder[empB.id], money(250));
  assert.equal(custodyProjection(s).byHolder[empA.id] || 0, 0);
  const retry = replay(s, "confirmCustodyTransfer", "op:r2:ack", empB, { transferId: "xfer:op:r2:send" });
  assert.equal(retry.replay, true);
  assertReconciled(s, "2026_08", "2026-08-14");
});

test("R2-05 expense request has no effect until owner approve; retry does not double-debit", () => {
  let s = seed();
  s.balances.company = money(1000);
  s.openingBalances.company = money(1000);
  s = go(s, "requestExpense", "op:r2:ex", empA, { amountFils: money(200), reason: "repair", monthKey: "2026_08" });
  assert.equal(s.balances.company, money(1000));
  s = go(s, "approveExpense", "op:r2:ex-ok", owner, { expenseId: "expense:op:r2:ex", account: "company" });
  assert.equal(s.balances.company, money(800));
  const retry = replay(s, "approveExpense", "op:r2:ex-ok", owner, { expenseId: "expense:op:r2:ex", account: "company" });
  assert.equal(retry.replay, true);
  assert.equal(retry.state.balances.company, money(800));
  assert.deepEqual(ledgerReplay(s.openingBalances, s.ledger), s.balances);
});

test("R2-06 employee cannot mint daily booking; owner cash daily hits holding once", () => {
  const empty = blankState();
  empty.financialTruthVersion = 3;
  empty.openingBalances = { company: 0, revenue: 0, deduction: 0 };
  assert.throws(() => go(empty, "createDailyBooking", "op:r2:daily-emp", empA, {
    unitId: "unit:daily", tenant: "Guest", amountFils: money(150), method: "cash", paymentDate: "2026-08-14",
  }), /MANAGER_REQUIRED/);
  let s = go(empty, "createDailyBooking", "op:r2:daily", owner, {
    unitId: "unit:daily", tenant: "Guest", amountFils: money(150), method: "cash", paymentDate: "2026-08-14",
  });
  const p = monthlyOperationalProjection(s, "2026_08", "2026-08-14").cards;
  assert.equal(p.collectedFils, money(150));
  assert.equal(p.receivedNotDepositedFils, money(150));
  assert.equal(p.depositedFils, 0);
  const retry = replay(s, "createDailyBooking", "op:r2:daily", owner, {
    unitId: "unit:daily", tenant: "Guest", amountFils: money(150), method: "cash", paymentDate: "2026-08-14",
  });
  assert.equal(retry.replay, true);
  assert.equal(retry.state.dailyBookings.length, 1);
});

test("R2-07 daily bank does not enter holding until approved; unknown method fails", () => {
  const empty = blankState();
  empty.financialTruthVersion = 3;
  empty.openingBalances = { company: 0, revenue: 0, deduction: 0 };
  assert.throws(() => go(empty, "createDailyBooking", "op:r2:bad", owner, {
    unitId: "u", tenant: "G", amountFils: money(50), method: "wallet", paymentDate: "2026-08-14",
  }), /INVALID_PAYMENT_METHOD/);
  let s = go(empty, "createDailyBooking", "op:r2:dbank", owner, {
    unitId: "u", tenant: "G", amountFils: money(80), method: "bank", paymentDate: "2026-08-14",
  });
  assert.equal(custodyProjection(s).totalFils, 0);
  assert.equal(monthlyOperationalProjection(s, "2026_08", "2026-08-14").cards.collectedFils, 0);
  s = go(s, "approveBankPayment", "op:r2:dbank-ok", owner, { paymentId: "pay:op:r2:dbank" });
  const p = monthlyOperationalProjection(s, "2026_08", "2026-08-14").cards;
  assert.equal(p.collectedFils, money(80));
  assert.equal(p.depositedFils, money(80));
  assert.equal(p.receivedNotDepositedFils, 0);
});

test("R2-08 status/paid_amount cannot mint money; remaining is target-reserved", () => {
  const s = seed();
  s.cycles[0].status = "collected";
  s.cycles[0].paid_amount = money(9999);
  const p = monthlyOperationalProjection(s, "2026_08", "2026-08-14").cards;
  assert.equal(p.collectedFils, 0);
  assert.equal(p.receivedNotDepositedFils, 0);
  assert.equal(p.arrearsFils, money(1000));
});

test("R2-09 hybrid deposited does not Math.max competing ledgers", () => {
  let s = seed();
  s.legacyMonthData = {
    units: [{ id: "u_hat", partitions: [
      { id: 1, rent: 1000, status: "late", paid_amount: 0, tenant: "A", due_date: "2026-08-01" },
      { id: 2, rent: 2000, status: "late", paid_amount: 2000, tenant: "B", due_date: "2026-08-01" },
    ] }],
    full: [],
    transactions: [{ id: "tx-legacy", amount: 9000, reversed: false }],
  };
  s.legacyMonthYear = 2026;
  s.legacyMonthIndex0 = 7;
  s = go(s, "createCashReceipt", "op:r2:hyb", empA, { cycleId: "cycle:r2:1", amountFils: money(1000), paymentDate: "2026-08-14" });
  s = go(s, "createDepositRequest", "op:r2:hyb-d", empA, {
    amountFils: money(1000), allocations: [{ cashLotId: "lot:op:r2:hyb", amountFils: money(1000) }], depositDate: "2026-08-14",
  });
  s = go(s, "approveDeposit", "op:r2:hyb-ok", owner, { depositRequestId: "dep:op:r2:hyb-d" });
  const proj = monthlyOperationalProjection(s, "2026_08", "2026-08-14");
  assert.equal(proj.compatibilitySource, "legacy_month_hybrid");
  assert.equal(proj.cards.depositedFils, money(1000));
  assert.ok((proj.reconciliationExceptions || []).some((x) => x.code === "DEPOSITED_DUAL_REPRESENTATION"));
});

test("R2-10 evidence classifier never mints; write flag is forbidden", () => {
  const classified = classifyLegacyMonth({
    units: [{ id: "u1", partitions: [
      { id: 1, rent: 1000, status: "late", paid_amount: 400 },
      { id: 2, rent: 1000, status: "collected", paid_amount: 0 },
      { id: 3, rent: 500, status: "late", paid_amount: 900 },
    ] }],
  });
  assert.equal(classified.mintedFils, 0);
  assert.equal(classified.spaces[0].classification, EVIDENCE_CLASS.B_LEGACY_DERIVED);
  assert.equal(classified.spaces[1].classification, EVIDENCE_CLASS.D_UNVERIFIABLE);
  assert.equal(classified.spaces[2].classification, EVIDENCE_CLASS.E_CONTRADICTION);
  assert.throws(() => dryRunLegacyClassification([], { write: true }), /R2_MIGRATION_WRITE_FORBIDDEN/);
  const dry = dryRunLegacyClassification([{ id: "2026_7", data: { units: [], full: [], transactions: [] } }]);
  assert.equal(dry.write, false);
  assert.equal(dry.mode, "dry-run");
});

test("R2-11 UI still queues employee add_daily and owner deposit approval", () => {
  assert.match(html, /identity:"approve-daily:"\+req\.id/);
  assert.match(html, /command:"createDepositRequest"/);
  assert.match(html, /command:"approveDeposit"/);
  assert.match(html, /command:"requestExpense"/);
  assert.match(html, /command:"approveExpense"/);
});

test("R2-12 locked month rejects new cash origin", () => {
  let s = seed();
  s.monthStates.push({ id: "2026_08", monthKey: "2026_08", status: "closed" });
  assert.throws(() => go(s, "createCashReceipt", "op:r2:closed", empA, {
    cycleId: "cycle:r2:1", amountFils: money(100), paymentDate: "2026-08-14",
  }), /MONTH_CLOSED/);
});

test("R2-13 identity 1 vs 10 remains distinct in remaining/paid", () => {
  let s = seed();
  s.cycles.push({
    id: "cycle:r2:10", tenancyId: "tenancy:r2:10", unitId: "unit:101", partitionId: "10",
    tenant: "Ten10", baseAmountFils: money(2500), reportingMonth: "2026_08", dueDate: "2026-08-01",
    status: "open_late", financialVersion: 0,
  });
  s.cycles[0].partitionId = "1";
  s = go(s, "createCashReceipt", "op:r2:id1", empA, { cycleId: "cycle:r2:1", amountFils: money(1000), paymentDate: "2026-08-14" });
  const p = monthlyOperationalProjection(s, "2026_08", "2026-08-14");
  const one = p.details.target.find((x) => x.cycleId === "cycle:r2:1");
  const ten = p.details.target.find((x) => x.cycleId === "cycle:r2:10");
  assert.equal(one.remainingFils, 0);
  assert.equal(ten.remainingFils, money(2500));
});

test("R2-14 unsynced UI collected must not fall back to deposited", () => {
  assert.match(html, /function actualCollected\(d\)\{ const value=card\("collectedFils"\); return value!==null\?value:0; \}/);
  assert.doesNotMatch(html, /actualCollected\(d\)\{ const value=card\("collectedFils"\); return value!==null\?value:netDepositedForKPI/);
});

test("R2-15 reconcile reports fail closed on duplicate entity ids", () => {
  const s = seed();
  s.collectionEvents.push({ id: "dup", status: "active", approvalState: "approved", amountFils: money(1), method: "cash", collectionMonth: "2026_08" });
  s.allocations.push({ id: "dup", amountFils: money(1), reservationStatus: "active", cycleId: "cycle:r2:1", collectionMonth: "2026_08" });
  const result = reconcileCanonicalState(s, "2026_08", "2026-08-14");
  assert.equal(result.ok, false);
  assert.ok(result.exceptions.some((x) => x.code === "DUPLICATE_ENTITY_ID" || x.code === "STATE_INVARIANT"));
});
