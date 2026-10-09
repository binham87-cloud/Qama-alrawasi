/**
 * Daily Target unification + installment pay/idempotency + operating Net independence.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  freshDb, run, bootstrapOwner, seedBuilding, createUser, actorFrom, opId,
} from "../helpers/commands.mjs";
import { buildDashboardFromDump } from "../../functions/services/readModel.mjs";
import {
  dailyBookingsTargetFils, isValidDailyBooking, paidInstallmentsFilsForPeriod,
  operatingNetFils, installmentPaymentId,
} from "../../functions/domain/finance.mjs";

async function setup() {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const building = await seedBuilding(db, owner);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "1111" });
  return { db, owner, building, yahia };
}

async function saveDailyExtras(db, owner, period, dailyBookings, profits = []) {
  await run(db, owner, "savePeriodExtras", {
    period,
    extrasJson: JSON.stringify({ dailyBookings, profits, expenses: [], transactions: [], logs: [] }),
  }, opId("extras-" + period));
}

test("domain: valid daily bookings sum; cancelled excluded", () => {
  const list = [
    { id: 1, total: 300, paymentStatus: "collected" },
    { id: 2, total: 150, paymentStatus: "unpaid" },
    { id: 3, total: 150, cancelled: true },
    { id: 4, total: 900, status: "deleted" },
  ];
  assert.equal(isValidDailyBooking(list[0]), true);
  assert.equal(isValidDailyBooking(list[2]), false);
  assert.equal(dailyBookingsTargetFils(list), 45000);
});

test("daily Target: unpaid + paid cash + approved bank all increase Target once", async () => {
  const { db, owner, building, yahia } = await setup();
  const period = building.period;
  const bookings = [
    { id: "d1", partId: "101-3", total: 300, startDate: "2026-09-01", endDate: "2026-09-07", nights: 6, paymentStatus: "unpaid" },
    { id: "d2", partId: "mz2-8", total: 150, startDate: "2026-09-03", endDate: "2026-09-06", nights: 3, paymentStatus: "collected" },
    { id: "d3", partId: "101-2", total: 900, startDate: "2026-09-10", endDate: "2026-09-13", nights: 3, paymentStatus: "unpaid" },
  ];
  await saveDailyExtras(db, owner, period, bookings);

  const beforePay = buildDashboardFromDump(db, period, "2026-09-15");
  assert.equal(beforePay.summary.dailyTargetFils, 135000);
  assert.equal(beforePay.summary.targetFils, beforePay.summary.obligationTargetFils + 135000);

  await run(db, actorFrom(yahia), "createDailyCashReceipt", {
    bookingId: "d2", amountFils: 15000, collectionDate: "2026-09-04", period,
  }, opId("dailycash-d2"));

  const afterCash = buildDashboardFromDump(db, period, "2026-09-15");
  assert.equal(afterCash.summary.dailyTargetFils, 135000);
  assert.equal(afterCash.summary.targetFils, beforePay.summary.targetFils);
  assert.equal(afterCash.summary.dailyPaidFils, 15000);
  assert.equal(afterCash.summary.collectedFils, beforePay.summary.collectedFils + 15000);
  assert.equal(
    afterCash.summary.targetFils,
    afterCash.summary.collectedFils + afterCash.summary.remainingFils,
  );

  // Cancelled booking must not inflate Target
  await saveDailyExtras(db, owner, period, [
    ...bookings,
    { id: "d4", total: 200, cancelled: true },
  ]);
  const afterCancel = buildDashboardFromDump(db, period, "2026-09-15");
  assert.equal(afterCancel.summary.dailyTargetFils, 135000);
});

test("orphan recognized daily receipt increases Collected only, not Target", async () => {
  const { db, owner, building, yahia } = await setup();
  const period = building.period;
  await saveDailyExtras(db, owner, period, [
    { id: "kept", total: 50, paymentStatus: "collected", startDate: "2026-09-01", endDate: "2026-09-02" },
  ]);
  await run(db, actorFrom(yahia), "createDailyCashReceipt", {
    bookingId: "kept", amountFils: 5000, collectionDate: "2026-09-01", period,
  }, opId("kept-cash"));
  await run(db, actorFrom(yahia), "createDailyCashReceipt", {
    bookingId: "1790349871123", amountFils: 15000, collectionDate: "2026-09-25", period,
  }, opId("orphan-150"));

  const dash = buildDashboardFromDump(db, period, "2026-09-30");
  const orphan = db.dump("receipts").find((r) => r.obligationId === "daily:1790349871123");
  assert.equal(orphan.amountFils, 15000);
  assert.equal(orphan.sourceType, "daily_booking");
  assert.equal(orphan.state, "recognized");
  assert.equal(dash.summary.dailyTargetFils, 5000);
  assert.equal(dash.summary.dailyPaidFils, 20000);
  assert.equal(dash.summary.dailyPaidFils - dash.summary.dailyTargetFils, 15000);
  assert.equal(dash.summary.targetFils, dash.summary.obligationTargetFils + 5000);
  assert.equal(
    dash.summary.remainingFils,
    dash.summary.targetFils - dash.summary.collectedFils,
  );
});

test("daily Target: Sep↔Oct↔Sep no duplicate; crossing-month booking counts once in Sep extras", async () => {
  const { db, owner, building } = await setup();
  const bookings = [
    { id: "cross", total: 400, startDate: "2026-09-28", endDate: "2026-10-02", nights: 4 },
  ];
  await saveDailyExtras(db, owner, "2026-09", bookings);
  await saveDailyExtras(db, owner, "2026-10", []);

  const sep1 = buildDashboardFromDump(db, "2026-09", "2026-09-30");
  const oct = buildDashboardFromDump(db, "2026-10", "2026-10-05");
  const sep2 = buildDashboardFromDump(db, "2026-09", "2026-09-30");
  assert.equal(sep1.summary.dailyTargetFils, 40000);
  assert.equal(sep2.summary.dailyTargetFils, sep1.summary.dailyTargetFils);
  assert.equal(sep2.summary.targetFils, sep1.summary.targetFils);
  assert.equal(oct.summary.dailyTargetFils, 0);
});

test("payInstallment: one debit + one audit; retry/double-tap alreadyApplied; Net ignores installment", async () => {
  const { db, owner } = await setup();
  const schedule = [
    { date: "2026-06-30", amount: 179294, paid: true, paymentId: "instpay:2026-06-30" },
    { date: "2026-09-30", amount: 179294, paid: false },
    { date: "2026-12-31", amount: 179294, paid: false },
  ];
  await run(db, owner, "upsertUiConfig", {
    configId: "balances",
    json: JSON.stringify({
      companyBalance: 0,
      revenueBalance: 0,
      installmentBalance: 366000,
      installmentSchedule: schedule,
      installmentPayments: [
        { id: "instpay:2026-06-30", installmentDate: "2026-06-30", amountFils: 17929400, state: "applied" },
      ],
    }),
  }, opId("bal-seed"));

  await saveDailyExtras(db, owner, "2026-09", [], [
    { id: 1, amount: 300000, date: "2026-09-01" },
  ]);

  const before = buildDashboardFromDump(db, "2026-09", "2026-09-30");
  assert.equal(before.summary.paidInstallmentFils, 0);
  const operatingNetBefore = operatingNetFils({
    incomeFils: before.summary.incomeFils,
    expensesFils: before.summary.expensesFils,
  });
  assert.equal(before.summary.operatingNetFils, operatingNetBefore);
  assert.equal(before.summary.netAfterProfitFils, operatingNetBefore);
  assert.equal(before.summary.netAfterProfitInstallmentFils, operatingNetBefore);
  // Profit transfer is tracked but must NOT reduce operating Net.
  assert.equal(before.summary.profitTransferFils, 30000000);
  assert.equal(
    before.summary.operatingNetFils,
    before.summary.incomeFils - before.summary.expensesFils,
  );
  assert.notEqual(
    before.summary.operatingNetFils,
    before.summary.incomeFils - before.summary.expensesFils - 30000000,
  );

  const amountFils = 17929400;
  const token = "instpay-2026-09-30-17929400";
  const r1 = await run(db, owner, "payInstallment", {
    installmentDate: "2026-09-30", amountFils,
  }, token);
  assert.equal(r1.alreadyApplied, false);
  assert.equal(r1.paymentId, installmentPaymentId("2026-09-30"));
  assert.equal(r1.installmentBalance, 366000 - 179294);
  assert.equal(r1.paidCount, 2);

  const audits1 = db.dump("auditEvents").filter((a) => a.action === "installment_paid"
    && String(a.targetId || "").includes("2026-09-30"));
  assert.equal(audits1.length, 1);

  // Lost-response replay — same operationId
  const replay = await run(db, owner, "payInstallment", {
    installmentDate: "2026-09-30", amountFils,
  }, token);
  assert.equal(replay.replay === true || replay.alreadyApplied === true || replay.installmentBalance === r1.installmentBalance, true);

  // Rapid double-tap / second session — different operationId
  const r2 = await run(db, owner, "payInstallment", {
    installmentDate: "2026-09-30", amountFils,
  }, "instpay-session2-2026-09-30-17929400");
  assert.equal(r2.alreadyApplied, true);
  assert.equal(r2.installmentBalance, 186706);
  assert.equal(r2.paidCount, 2);

  const audits2 = db.dump("auditEvents").filter((a) => a.action === "installment_paid"
    && String(a.targetId || "").includes("2026-09-30"));
  assert.equal(audits2.length, 1);

  const cfg = JSON.parse(db.dump("uiConfig").find((d) => d.id === "balances").json);
  assert.equal(cfg.installmentBalance, 186706);
  assert.equal(cfg.installmentSchedule.filter((x) => x.paid).length, 2);
  assert.equal(cfg.installmentPayments.filter((p) => p.state === "applied" && p.installmentDate === "2026-09-30").length, 1);

  const after = buildDashboardFromDump(db, "2026-09", "2026-09-30");
  // Financing track is visible separately…
  assert.equal(after.summary.paidInstallmentFils, 17929400);
  assert.equal(after.summary.profitTransferFils, 30000000);
  // …but monthly operating Net = Income − Expenses ONLY (no profit, no installment).
  assert.equal(
    after.summary.operatingNetFils,
    after.summary.incomeFils - after.summary.expensesFils,
  );
  assert.equal(after.summary.operatingNetFils, before.summary.operatingNetFils);
  assert.equal(after.summary.netAfterProfitFils, after.summary.operatingNetFils);
  assert.notEqual(
    after.summary.operatingNetFils,
    after.summary.incomeFils - after.summary.expensesFils - 30000000,
  );
  assert.notEqual(
    after.summary.operatingNetFils,
    after.summary.incomeFils - after.summary.expensesFils - 30000000 - 17929400,
  );

  // Sep → Oct → Sep keeps paid
  const oct = buildDashboardFromDump(db, "2026-10", "2026-10-05");
  assert.equal(oct.summary.paidInstallmentFils, 0);
  const sepAgain = buildDashboardFromDump(db, "2026-09", "2026-09-30");
  assert.equal(sepAgain.summary.paidInstallmentFils, 17929400);

  // upsertUiConfig must not silently unpay / restore balance
  await run(db, owner, "upsertUiConfig", {
    configId: "balances",
    json: JSON.stringify({
      companyBalance: 0,
      revenueBalance: 0,
      installmentBalance: 366000,
      installmentSchedule: schedule.map((x) => ({ ...x, paid: false })),
      installmentPayments: [],
    }),
  }, opId("bal-clobber"));
  const guarded = JSON.parse(db.dump("uiConfig").find((d) => d.id === "balances").json);
  assert.equal(guarded.installmentSchedule.find((x) => x.date === "2026-09-30").paid, true);
  assert.ok(guarded.installmentBalance <= 186706);

  // Reverse once
  const rev = await run(db, owner, "reverseInstallment", {
    installmentDate: "2026-09-30",
  }, "instrev-2026-09-30");
  assert.equal(rev.alreadyApplied, false);
  assert.equal(rev.paidCount, 1);
  assert.equal(rev.installmentBalance, 366000);
  const afterRev = buildDashboardFromDump(db, "2026-09", "2026-09-30");
  assert.equal(afterRev.summary.paidInstallmentFils, 0);
  assert.equal(afterRev.summary.operatingNetFils, after.summary.operatingNetFils);
  assert.equal(afterRev.summary.netAfterProfitFils, after.summary.operatingNetFils);

  const rev2 = await run(db, owner, "reverseInstallment", {
    installmentDate: "2026-09-30",
  }, "instrev-2026-09-30-b");
  assert.equal(rev2.alreadyApplied, true);
});

test("payInstallment insufficient balance: atomic reject, no paid, no audit success", async () => {
  const { db, owner } = await setup();
  await run(db, owner, "upsertUiConfig", {
    configId: "balances",
    json: JSON.stringify({
      companyBalance: 0,
      revenueBalance: 0,
      installmentBalance: 1000,
      installmentSchedule: [{ date: "2026-09-30", amount: 179294, paid: false }],
    }),
  }, opId("bal-low"));
  await assert.rejects(
    () => run(db, owner, "payInstallment", {
      installmentDate: "2026-09-30", amountFils: 17929400,
    }, opId("inst-fail")),
    /INSUFFICIENT_INSTALLMENT_BALANCE/,
  );
  const cfg = JSON.parse(db.dump("uiConfig").find((d) => d.id === "balances").json);
  assert.equal(cfg.installmentBalance, 1000);
  assert.equal(cfg.installmentSchedule[0].paid, false);
  assert.equal(db.dump("auditEvents").filter((a) => a.action === "installment_paid").length, 0);
});

test("installment payment never changes rent Collected/Deposited/Holding", async () => {
  const { db, owner, building, yahia } = await setup();
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 200000, collectionDate: "2026-09-05",
  });
  await run(db, owner, "upsertUiConfig", {
    configId: "balances",
    json: JSON.stringify({
      companyBalance: 0, revenueBalance: 0, installmentBalance: 200000,
      installmentSchedule: [{ date: "2026-09-30", amount: 179294, paid: false }],
    }),
  }, opId("bal-rent"));
  const before = buildDashboardFromDump(db, building.period, "2026-09-15");
  await run(db, owner, "payInstallment", {
    installmentDate: "2026-09-30", amountFils: 17929400,
  }, opId("inst-rent-safe"));
  const after = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.equal(after.summary.collectedFils, before.summary.collectedFils);
  assert.equal(after.summary.depositedFils, before.summary.depositedFils);
  assert.equal(after.summary.holdingFils, before.summary.holdingFils);
  assert.equal(after.summary.targetFils, before.summary.targetFils);
});

test("paidInstallmentsFilsForPeriod helper", () => {
  const sched = [
    { date: "2026-06-30", amount: 179294, paid: true },
    { date: "2026-09-30", amount: 179294, paid: true },
    { date: "2026-12-31", amount: 179294, paid: false },
  ];
  assert.equal(paidInstallmentsFilsForPeriod(sched, "2026-09"), 17929400);
  assert.equal(paidInstallmentsFilsForPeriod(sched, "2026-10"), 0);
});

/* ───────── operating Net independence (Income − Expenses ONLY) ───────── */

test("domain operatingNetFils: Income − Expenses; ignores profitTransferFils arg if passed", () => {
  assert.equal(operatingNetFils({
    incomeFils: 10000000, expensesFils: 1000000,
  }), 9000000);
  // Extra keys must not affect the formula (backward-compat callers).
  assert.equal(operatingNetFils({
    incomeFils: 10000000, expensesFils: 1000000, profitTransferFils: 5000000,
  }), 9000000);
  assert.equal(operatingNetFils({
    incomeFils: 10000000, expensesFils: 1000000, paidInstallmentFils: 2000000,
  }), 9000000);
});

test("operating Net: Income 100k − Expenses 10k; profit 50k does NOT reduce Net", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const prop = await run(db, owner, "createProperty", { name: "قمة", address: "دبي" });
  const unit = await run(db, owner, "createUnit", { propertyId: prop.propertyId, name: "U1", kind: "whole" });
  const space = await run(db, owner, "createSpace", { unitId: unit.unitId, name: "S1" });
  await run(db, owner, "createRental", {
    spaceId: space.spaceId, tenantName: "تاجر",
    contractualAmountFils: 10000000, dueDayOfMonth: 1, startDate: "2026-09-01",
  });
  const obs = await run(db, owner, "generateObligations", { period: "2026-09" });
  const obligationId = obs.obligationIds[0];
  const account = await run(db, owner, "createAccount", { name: "شركة", kind: "company" });
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "1111" });

  const bank = await run(db, actorFrom(yahia), "submitBankReceipt", {
    obligationId, amountFils: 10000000, collectionDate: "2026-09-05", bankReference: "TRX-NET",
  }, opId("bank-100k"));
  await run(db, owner, "approveBankReceipt", { receiptId: bank.receiptId }, opId("apr-100k"));

  await run(db, owner, "submitExpense", {
    amountFils: 1000000, reason: "تشغيل", category: "ops",
    expenseDate: "2026-09-10", paidFromAccountId: account.accountId,
  }, opId("exp-10k"));

  await saveDailyExtras(db, owner, "2026-09", [], [
    { id: 1, amount: 50000, date: "2026-09-15", note: "تحويل أرباح" },
  ]);

  const dash = buildDashboardFromDump(db, "2026-09", "2026-09-30");
  assert.equal(dash.summary.incomeFils, 10000000);
  assert.equal(dash.summary.expensesFils, 1000000);
  assert.equal(dash.summary.profitTransferFils, 5000000);
  assert.equal(dash.summary.operatingNetFils, 9000000);
  assert.equal(dash.summary.netAfterProfitFils, 9000000);
  assert.equal(dash.summary.netAfterProfitInstallmentFils, 9000000);
  assert.equal(dash.summary.netIncomeFils, 9000000);
});

test("operating Net unchanged when paid installment 20k added (still 90k)", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const prop = await run(db, owner, "createProperty", { name: "قمة", address: "دبي" });
  const unit = await run(db, owner, "createUnit", { propertyId: prop.propertyId, name: "U1", kind: "whole" });
  const space = await run(db, owner, "createSpace", { unitId: unit.unitId, name: "S1" });
  await run(db, owner, "createRental", {
    spaceId: space.spaceId, tenantName: "تاجر",
    contractualAmountFils: 10000000, dueDayOfMonth: 1, startDate: "2026-09-01",
  });
  const obs = await run(db, owner, "generateObligations", { period: "2026-09" });
  const obligationId = obs.obligationIds[0];
  const account = await run(db, owner, "createAccount", { name: "شركة", kind: "company" });
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "1111" });

  const bank = await run(db, actorFrom(yahia), "submitBankReceipt", {
    obligationId, amountFils: 10000000, collectionDate: "2026-09-05", bankReference: "TRX-NET",
  }, opId("bank-100k-b"));
  await run(db, owner, "approveBankReceipt", { receiptId: bank.receiptId }, opId("apr-100k-b"));
  await run(db, owner, "submitExpense", {
    amountFils: 1000000, reason: "تشغيل", category: "ops",
    expenseDate: "2026-09-10", paidFromAccountId: account.accountId,
  }, opId("exp-10k-b"));
  await saveDailyExtras(db, owner, "2026-09", [], [
    { id: 1, amount: 50000, date: "2026-09-15" },
  ]);
  await run(db, owner, "upsertUiConfig", {
    configId: "balances",
    json: JSON.stringify({
      companyBalance: 500000,
      revenueBalance: 100000,
      installmentBalance: 50000,
      installmentSchedule: [{ date: "2026-09-30", amount: 20000, paid: false }],
      installmentPayments: [],
    }),
  }, opId("bal-net-inst"));

  const before = buildDashboardFromDump(db, "2026-09", "2026-09-30");
  assert.equal(before.summary.operatingNetFils, 9000000);

  const pay = await run(db, owner, "payInstallment", {
    installmentDate: "2026-09-30", amountFils: 2000000,
  }, opId("inst-20k"));
  assert.equal(pay.installmentBalance, 30000);

  const after = buildDashboardFromDump(db, "2026-09", "2026-09-30");
  assert.equal(after.summary.paidInstallmentFils, 2000000);
  assert.equal(after.summary.operatingNetFils, 9000000);
  assert.equal(after.summary.profitTransferFils, 5000000);
  // Liquidity/account moved; rent KPIs untouched.
  assert.equal(after.summary.collectedFils, before.summary.collectedFils);
  assert.equal(after.summary.depositedFils, before.summary.depositedFils);
  assert.equal(after.summary.holdingFils, before.summary.holdingFils);
  assert.equal(after.summary.targetFils, before.summary.targetFils);
});

test("profit transfer tracked + company balance change; operating Net unchanged", async () => {
  const { db, owner, building, yahia } = await setup();
  const account = building.account;
  // Deposit some income so Net is non-trivial.
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 500000, collectionDate: "2026-09-05",
  }, opId("cash-net"));
  const dep = await run(db, actorFrom(yahia), "submitDeposit", {
    amountFils: 500000, depositDate: "2026-09-06", destinationAccountId: account.accountId,
  }, opId("dep-net"));
  await run(db, owner, "approveDeposit", { depositId: dep.depositId }, opId("dep-apr-net"));
  await run(db, owner, "submitExpense", {
    amountFils: 100000, reason: "صيانة", category: "ops",
    expenseDate: "2026-09-08", paidFromAccountId: account.accountId,
  }, opId("exp-net"));

  await run(db, owner, "upsertUiConfig", {
    configId: "balances",
    json: JSON.stringify({ companyBalance: 800000, revenueBalance: 0, installmentBalance: 0 }),
  }, opId("bal-before-profit"));

  const beforeProfit = buildDashboardFromDump(db, "2026-09", "2026-09-30");
  const netBefore = beforeProfit.summary.operatingNetFils;
  assert.equal(netBefore, beforeProfit.summary.incomeFils - beforeProfit.summary.expensesFils);

  await saveDailyExtras(db, owner, "2026-09", [], [
    { id: 9, amount: 200000, date: "2026-09-20", note: "أرباح" },
  ]);
  // Owner distribution reduces company liquidity — not operating Net.
  await run(db, owner, "upsertUiConfig", {
    configId: "balances",
    json: JSON.stringify({ companyBalance: 600000, revenueBalance: 0, installmentBalance: 0 }),
  }, opId("bal-after-profit"));

  const after = buildDashboardFromDump(db, "2026-09", "2026-09-30");
  assert.equal(after.summary.profitTransferFils, 20000000);
  assert.equal(after.summary.operatingNetFils, netBefore);
  const bal = JSON.parse(db.dump("uiConfig").find((d) => d.id === "balances").json);
  assert.equal(bal.companyBalance, 600000);
});

test("reversed profit transfer: audit list clears; Net still Income − Expenses", async () => {
  const { db, owner, building, yahia } = await setup();
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 400000, collectionDate: "2026-09-05",
  }, opId("cash-revp"));
  const dep = await run(db, actorFrom(yahia), "submitDeposit", {
    amountFils: 400000, depositDate: "2026-09-06", destinationAccountId: building.account.accountId,
  }, opId("dep-revp"));
  await run(db, owner, "approveDeposit", { depositId: dep.depositId }, opId("dep-apr-revp"));

  await saveDailyExtras(db, owner, "2026-09", [], [
    { id: 1, amount: 100000, date: "2026-09-12" },
  ]);
  await run(db, owner, "upsertUiConfig", {
    configId: "balances",
    json: JSON.stringify({ companyBalance: 100000, revenueBalance: 0 }),
  }, opId("bal-revp-1"));

  const withProfit = buildDashboardFromDump(db, "2026-09", "2026-09-30");
  const expectedNet = withProfit.summary.incomeFils - withProfit.summary.expensesFils;
  assert.equal(withProfit.summary.operatingNetFils, expectedNet);
  assert.equal(withProfit.summary.profitTransferFils, 10000000);

  // Reversal of profit transfer: remove from extras + restore company balance.
  await saveDailyExtras(db, owner, "2026-09", [], []);
  await run(db, owner, "upsertUiConfig", {
    configId: "balances",
    json: JSON.stringify({ companyBalance: 200000, revenueBalance: 0 }),
  }, opId("bal-revp-2"));

  const afterRev = buildDashboardFromDump(db, "2026-09", "2026-09-30");
  assert.equal(afterRev.summary.profitTransferFils, 0);
  assert.equal(afterRev.summary.operatingNetFils, expectedNet);
  const bal = JSON.parse(db.dump("uiConfig").find((d) => d.id === "balances").json);
  assert.equal(bal.companyBalance, 200000);
});

test("pending/rejected bank receipt: no Income/Net effect; profit still excluded from Net", async () => {
  const { db, owner, building, yahia } = await setup();
  // Pending bank — not income yet.
  await run(db, actorFrom(yahia), "submitBankReceipt", {
    obligationId: building.obligationId, amountFils: 300000, collectionDate: "2026-09-05", bankReference: "TRX-NET",
  }, opId("bank-pend"));
  // Rejected bank — never income.
  const rej = await run(db, actorFrom(yahia), "submitBankReceipt", {
    obligationId: building.obligationId, amountFils: 200000, collectionDate: "2026-09-06", bankReference: "TRX-NET2",
  }, opId("bank-rej"));
  await run(db, owner, "rejectBankReceipt", { receiptId: rej.receiptId, reason: "خطأ" }, opId("rej-bank"));

  await saveDailyExtras(db, owner, "2026-09", [], [
    { id: 1, amount: 99999, date: "2026-09-07" },
  ]);

  const dash = buildDashboardFromDump(db, "2026-09", "2026-09-30");
  assert.equal(dash.summary.incomeFils, 0);
  assert.equal(dash.summary.expensesFils, 0);
  assert.equal(dash.summary.profitTransferFils, 9999900);
  assert.equal(dash.summary.operatingNetFils, 0);
});

test("canonical Net fields are identical aliases of operatingNetFils", async () => {
  const { db, owner, building, yahia } = await setup();
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 800000, collectionDate: "2026-09-05",
  }, opId("cash-alias"));
  const dep = await run(db, actorFrom(yahia), "submitDeposit", {
    amountFils: 800000, depositDate: "2026-09-06", destinationAccountId: building.account.accountId,
  }, opId("dep-alias"));
  await run(db, owner, "approveDeposit", { depositId: dep.depositId }, opId("dep-apr-alias"));
  await saveDailyExtras(db, owner, "2026-09", [], [
    { id: 1, amount: 10000, date: "2026-09-09" },
  ]);
  const s = buildDashboardFromDump(db, "2026-09", "2026-09-30").summary;
  assert.equal(s.operatingNetFils, s.incomeFils - s.expensesFils);
  assert.equal(s.netAfterProfitFils, s.operatingNetFils);
  assert.equal(s.netAfterProfitInstallmentFils, s.operatingNetFils);
  assert.equal(s.netIncomeFils, s.operatingNetFils);
});
