/**
 * Shared Holding by month + all-period total.
 * Canonical: Holding(P) = cash(P) − approved holding deposits(sourcePeriod=P).
 * sharedHoldingAllPeriodsFils = SUM(Holding(P)) — never an independent global formula.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { freshDb, run, bootstrapOwner, createUser, actorFrom, opId, seedBuilding } from "../helpers/commands.mjs";
import { buildDashboardFromDump } from "../../functions/services/readModel.mjs";
import {
  sharedHoldingFils, holdingByPeriodFils, sharedHoldingAllPeriodsFils, holdingByPeriodMap,
  RECEIPT_STATE, APPROVAL_STATE,
} from "../../functions/domain/finance.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const html = readFileSync(resolve(root, "src/frontend/index.html"), "utf8");

async function seedSepOct(db, owner) {
  const building = await seedBuilding(db, owner);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  await run(db, owner, "renewRentalCycle", {
    rentalId: building.rental.rentalId, asOfDate: "2026-10-01",
  }, opId("ren-oct-hbp"));
  await run(db, owner, "generateObligations", { period: "2026-10" }, opId("gen-oct-hbp"));
  const octOb = db.dump("obligations").find(
    (o) => o.rentalId === building.rental.rentalId && o.period === "2026-10" && o.state === "active",
  );
  assert.ok(octOb);
  return { building, yahia, octOb };
}

function assertHoldingInvariant(summary) {
  const by = summary.holdingByPeriod || [];
  const sum = by.reduce((s, r) => s + Number(r.holdingFils || 0), 0);
  assert.equal(sum, Number(summary.sharedHoldingAllPeriodsFils));
  assert.equal(Number(summary.sharedHoldingAllPeriodsFils), Number(summary.globalHoldingFils));
}

test("HBP1 Sep cash → Sep Holding only", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const { building, yahia, octOb } = await seedSepOct(db, owner);

  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 800000, collectionDate: "2026-09-05",
  }, opId("hbp-sep-cash"));

  const sep = buildDashboardFromDump(db, "2026-09", "2026-09-05");
  const oct = buildDashboardFromDump(db, "2026-10", "2026-10-05");
  assert.equal(sep.summary.holdingFils, 800000);
  assert.equal(sep.summary.periodCashCollectedFils, 800000);
  assert.equal(sep.summary.periodApprovedHoldingDepositsFils, 0);
  assert.equal(oct.summary.holdingFils, 0);
  assert.equal(sep.summary.holdingByPeriodFils["2026-09"], 800000);
  assert.equal(sep.summary.holdingByPeriodFils["2026-10"], undefined);
  assert.equal(sep.summary.sharedHoldingAllPeriodsFils, 800000);
  assertHoldingInvariant(sep.summary);
  void octOb;
});

test("HBP2 Oct cash → Oct Holding only; sum = all-period", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const { building, yahia, octOb } = await seedSepOct(db, owner);

  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 800000, collectionDate: "2026-09-05",
  }, opId("hbp-sep2"));
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: octOb.id, amountFils: 500000, collectionDate: "2026-10-05",
  }, opId("hbp-oct2"));

  const sep = buildDashboardFromDump(db, "2026-09", "2026-09-15");
  const oct = buildDashboardFromDump(db, "2026-10", "2026-10-15");
  assert.equal(sep.summary.holdingFils, 800000);
  assert.equal(oct.summary.holdingFils, 500000);
  assert.equal(sep.summary.sharedHoldingAllPeriodsFils, 1300000);
  assert.equal(oct.summary.sharedHoldingAllPeriodsFils, 1300000);
  assert.equal(
    sep.summary.holdingByPeriodFils["2026-09"] + sep.summary.holdingByPeriodFils["2026-10"],
    sep.summary.sharedHoldingAllPeriodsFils,
  );
  assertHoldingInvariant(sep.summary);
  assertHoldingInvariant(oct.summary);
});

test("HBP3 Sep Holding deposit dated in Oct with sourcePeriod=Sep → Sep↓ Oct unchanged", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const { building, yahia, octOb } = await seedSepOct(db, owner);

  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 800000, collectionDate: "2026-09-05",
  }, opId("hbp-s3"));
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: octOb.id, amountFils: 500000, collectionDate: "2026-10-05",
  }, opId("hbp-o3"));

  await run(db, owner, "submitDeposit", {
    amountFils: 300000,
    depositDate: "2026-10-08", // real deposit date in October
    destinationAccountId: building.account.accountId,
    sourceKind: "holding",
    sourcePeriod: "2026-09", // must reduce September
  }, opId("hbp-dep-cross"));

  const dep = db.dump("deposits").find((d) => d.sourcePeriod === "2026-09" && d.amountFils === 300000);
  assert.ok(dep);
  assert.equal(dep.depositDate, "2026-10-08");
  assert.equal(dep.sourcePeriod, "2026-09");

  const sep = buildDashboardFromDump(db, "2026-09", "2026-10-08");
  const oct = buildDashboardFromDump(db, "2026-10", "2026-10-08");
  assert.equal(sep.summary.holdingFils, 500000);
  assert.equal(sep.summary.periodApprovedHoldingDepositsFils, 300000);
  assert.equal(oct.summary.holdingFils, 500000);
  assert.equal(oct.summary.periodApprovedHoldingDepositsFils, 0);
  assert.equal(sep.summary.sharedHoldingAllPeriodsFils, 1000000);
  assertHoldingInvariant(sep.summary);
});

test("HBP4 bank / external / pending / rejected / approved / reverse", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const { building, yahia } = await seedBuilding(db, owner).then(async (building) => {
    const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
    return { building, yahia };
  });

  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 400000, collectionDate: "2026-09-05",
  }, opId("hbp-cash4"));

  // Bank: Collected+Deposited, Holding unchanged
  const bank = await run(db, actorFrom(yahia), "submitBankReceipt", {
    obligationId: building.obligationId, amountFils: 100000, collectionDate: "2026-09-06",
    bankReference: "HBP-BANK",
  }, opId("hbp-bank"));
  await run(db, owner, "approveBankReceipt", { receiptId: bank.receiptId }, opId("hbp-bankap"));
  let dash = buildDashboardFromDump(db, "2026-09", "2026-09-06");
  assert.equal(dash.summary.holdingFils, 400000);
  assert.ok(dash.summary.collectedFils >= 500000);
  assert.ok(dash.summary.depositedFils >= 100000);

  // External: no Holding reduction
  await run(db, owner, "submitDeposit", {
    amountFils: 50000,
    depositDate: "2026-09-07",
    destinationAccountId: building.account.accountId,
    sourceKind: "external",
    sourcePeriod: "2026-09",
  }, opId("hbp-ext"));
  assert.equal(buildDashboardFromDump(db, "2026-09", "2026-09-07").summary.holdingFils, 400000);

  // Pending (employee submit): no Holding effect
  const pend = await run(db, actorFrom(yahia), "submitDeposit", {
    amountFils: 100000,
    depositDate: "2026-09-08",
    destinationAccountId: building.account.accountId,
    sourceKind: "holding",
    sourcePeriod: "2026-09",
  }, opId("hbp-pend"));
  const pendDoc = db.dump("deposits").find((d) => d.id === pend.depositId);
  assert.equal(pendDoc.state, APPROVAL_STATE.PENDING);
  assert.equal(buildDashboardFromDump(db, "2026-09", "2026-09-08").summary.holdingFils, 400000);

  // Rejected: no Holding effect
  await run(db, owner, "rejectDeposit", {
    depositId: pend.depositId, reason: "رفض HBP",
  }, opId("hbp-rej"));
  assert.equal(buildDashboardFromDump(db, "2026-09", "2026-09-08").summary.holdingFils, 400000);

  // Approved Holding deposit decreases once (owner submit auto-approves)
  const appr = await run(db, owner, "submitDeposit", {
    amountFils: 100000,
    depositDate: "2026-09-09",
    destinationAccountId: building.account.accountId,
    sourceKind: "holding",
    sourcePeriod: "2026-09",
  }, opId("hbp-appr"));
  dash = buildDashboardFromDump(db, "2026-09", "2026-09-09");
  assert.equal(dash.summary.holdingFils, 300000);
  assert.equal(dash.summary.periodApprovedHoldingDepositsFils, 100000);

  // Reverse restores exactly once
  await run(db, owner, "reverseDeposit", {
    depositId: appr.depositId, reason: "عكس HBP",
  }, opId("hbp-rev"));
  dash = buildDashboardFromDump(db, "2026-09", "2026-09-10");
  assert.equal(dash.summary.holdingFils, 400000);
  assertHoldingInvariant(dash.summary);
});

test("HBP5 reversed cash receipt decreases correct month Holding", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const { building, yahia, octOb } = await seedSepOct(db, owner);

  const r = await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 200000, collectionDate: "2026-09-05",
  }, opId("hbp-rev-cash"));
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: octOb.id, amountFils: 100000, collectionDate: "2026-10-05",
  }, opId("hbp-oct-keep"));

  assert.equal(buildDashboardFromDump(db, "2026-09", "2026-09-05").summary.holdingFils, 200000);
  await run(db, owner, "reverseReceipt", {
    receiptId: r.receiptId, reason: "عكس نقد",
  }, opId("hbp-rev-r"));
  assert.equal(buildDashboardFromDump(db, "2026-09", "2026-09-06").summary.holdingFils, 0);
  assert.equal(buildDashboardFromDump(db, "2026-10", "2026-10-05").summary.holdingFils, 100000);
});

test("HBP6 daily prepaid cash → correct month Holding; month nav no drift", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  await run(db, owner, "createAccount", { name: "بنك", kind: "bank" });
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });

  const booking = {
    id: "hbp-daily-sep", partId: "u1-1", partLabel: "شقة 1 / 1", guest: "نزيل",
    startDate: "2026-09-10", endDate: "2026-09-11", nights: 1, nightRate: 300, total: 300,
    by: yahia.userId,
  };
  await run(db, actorFrom(yahia), "createDailyBookingPrepaid", {
    period: "2026-09",
    bookingJson: JSON.stringify(booking),
    amountFils: 30000,
    collectionDate: "2026-09-10",
  }, opId("hbp-daily"));

  let sep = buildDashboardFromDump(db, "2026-09", "2026-09-10");
  assert.equal(sep.summary.holdingFils, 30000);
  assert.equal(sep.summary.sharedHoldingAllPeriodsFils, 30000);

  // Sep → Oct → Sep navigation: same values, no duplication
  const oct = buildDashboardFromDump(db, "2026-10", "2026-10-01");
  assert.equal(oct.summary.holdingFils, 0);
  assert.equal(oct.summary.sharedHoldingAllPeriodsFils, 30000);
  sep = buildDashboardFromDump(db, "2026-09", "2026-09-10");
  assert.equal(sep.summary.holdingFils, 30000);
  assert.equal(sep.summary.sharedHoldingAllPeriodsFils, 30000);
  assert.equal(
    db.dump("receipts").filter((r) => r.sourceType === "daily_booking" && r.state === RECEIPT_STATE.RECOGNIZED).length,
    1,
  );
  assertHoldingInvariant(sep.summary);
});

test("HBP7 domain: holdingByPeriodFils + sharedHoldingAllPeriodsFils invariant", () => {
  const receipts = [
    { id: "s", amountFils: 800000, state: RECEIPT_STATE.RECOGNIZED, method: "cash", period: "2026-09", collectorUserId: "y" },
    { id: "o", amountFils: 500000, state: RECEIPT_STATE.RECOGNIZED, method: "cash", period: "2026-10", collectorUserId: "y" },
    { id: "b", amountFils: 200000, state: RECEIPT_STATE.RECOGNIZED, method: "bank", period: "2026-09", collectorUserId: "y" },
  ];
  const deposits = [
    {
      id: "d", amountFils: 300000, state: APPROVAL_STATE.APPROVED, sourceKind: "holding",
      sourcePeriod: "2026-09", period: "2026-10", depositDate: "2026-10-08", employeeId: "y",
    },
    {
      id: "e", amountFils: 100000, state: APPROVAL_STATE.APPROVED, sourceKind: "external",
      sourcePeriod: "2026-09", employeeId: "y",
    },
    {
      id: "p", amountFils: 50000, state: APPROVAL_STATE.PENDING, sourceKind: "holding",
      sourcePeriod: "2026-09", employeeId: "y",
    },
  ];
  const rows = holdingByPeriodFils({ receipts, deposits });
  const map = holdingByPeriodMap(rows);
  assert.equal(map["2026-09"], 500000);
  assert.equal(map["2026-10"], 500000);
  assert.equal(sharedHoldingAllPeriodsFils({ receipts, deposits }), 1000000);
  assert.equal(
    rows.reduce((s, r) => s + r.holdingFils, 0),
    sharedHoldingAllPeriodsFils({ receipts, deposits }),
  );
  assert.equal(sharedHoldingFils({ receipts, deposits, period: "2026-09" }), 500000);
  assert.equal(sharedHoldingFils({ receipts, deposits, period: "2026-10" }), 500000);
  const sepRow = rows.find((r) => r.period === "2026-09");
  assert.equal(sepRow.cashCollectedFils, 800000);
  assert.equal(sepRow.approvedHoldingDepositsFils, 300000);
});

test("HBP8 UI shows عهدة هذا الشهر / إجمالي / حسب الشهر from canonical fields", () => {
  assert.match(html, /holding-breakdown|عهدة هذا الشهر/);
  assert.match(html, /إجمالي العهدة المشتركة/);
  assert.match(html, /العهدة حسب الشهر/);
  assert.match(html, /holdingByPeriod|sharedHoldingAllPeriodsFils|holdingSummaryFromEng|renderHoldingBreakdownCard/);
  assert.match(html, /محصل نقداً/);
  assert.match(html, /مودع من العهدة/);
  assert.match(html, /العهدة المتبقية/);
});
