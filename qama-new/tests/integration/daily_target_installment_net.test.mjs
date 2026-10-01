/**
 * Daily Target unification + installment pay/idempotency + Net-after-profit/installment.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  freshDb, run, bootstrapOwner, seedBuilding, createUser, actorFrom, opId,
} from "../helpers/commands.mjs";
import { buildDashboardFromDump } from "../../functions/services/readModel.mjs";
import {
  dailyBookingsTargetFils, isValidDailyBooking, paidInstallmentsFilsForPeriod,
  netAfterProfitFils, installmentPaymentId,
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
  const operatingNetBefore = netAfterProfitFils({
    incomeFils: before.summary.incomeFils,
    expensesFils: before.summary.expensesFils,
    profitTransferFils: before.summary.profitTransferFils,
  });
  assert.equal(before.summary.netAfterProfitFils, operatingNetBefore);
  assert.equal(before.summary.netAfterProfitInstallmentFils, operatingNetBefore);

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
  // …but monthly operating Net must NOT subtract the installment.
  assert.equal(
    after.summary.netAfterProfitFils,
    after.summary.incomeFils - after.summary.expensesFils - 30000000,
  );
  assert.equal(after.summary.netAfterProfitFils, before.summary.netAfterProfitFils);
  assert.notEqual(
    after.summary.netAfterProfitFils,
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
  assert.equal(afterRev.summary.netAfterProfitFils, after.summary.netAfterProfitFils);

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
