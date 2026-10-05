/**
 * Vacating an unpaid FUTURE obligation must NEVER create Holding/Collected.
 * Obligation ≠ cash. No receipt ⇒ no Holding.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshDb, run, bootstrapOwner, createUser, actorFrom, opId, seedBuilding } from "../helpers/commands.mjs";
import { buildDashboardFromDump } from "../../functions/services/readModel.mjs";
import {
  sharedHoldingFils, sharedHoldingAllPeriodsFils, RECEIPT_STATE, APPROVAL_STATE,
} from "../../functions/domain/finance.mjs";

async function seedSepWithNov(db, owner) {
  const building = await seedBuilding(db, owner);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  await run(db, owner, "renewRentalCycle", {
    rentalId: building.rental.rentalId, asOfDate: "2026-11-01",
  }, opId("ren-nov-fu"));
  await run(db, owner, "generateObligations", { period: "2026-11" }, opId("gen-nov-fu"));
  const novOb = db.dump("obligations").find(
    (o) => o.rentalId === building.rental.rentalId && o.period === "2026-11" && o.state === "active",
  );
  assert.ok(novOb);
  return { building, yahia, novOb };
}

test("1 unpaid future vacate: Target/Collected/Holding stay 0; global Holding unchanged", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const { building, novOb } = await seedSepWithNov(db, owner);

  const beforeGlobal = sharedHoldingAllPeriodsFils({
    receipts: db.dump("receipts"), deposits: db.dump("deposits"),
  });
  const beforeNov = buildDashboardFromDump(db, "2026-11", "2026-10-15");
  assert.equal(beforeNov.summary.collectedFils, 0);
  assert.equal(beforeNov.summary.holdingFils, 0);

  await run(db, owner, "endTenancy", {
    rentalId: building.rental.rentalId,
    endDate: "2026-10-15",
    reason: "إخلاء قبل استحقاق نوفمبر",
    arrearsDecision: "retain",
  }, opId("vac-fu-1"));

  const after = buildDashboardFromDump(db, "2026-11", "2026-10-15");
  assert.equal(after.summary.targetFils, 0, "cancelled future unpaid must leave Target");
  assert.equal(after.summary.collectedFils, 0);
  assert.equal(after.summary.holdingFils, 0);
  assert.equal(after.summary.periodCashCollectedFils || 0, 0);
  assert.equal(
    sharedHoldingAllPeriodsFils({ receipts: db.dump("receipts"), deposits: db.dump("deposits") }),
    beforeGlobal,
  );
  const ob = db.dump("obligations").find((o) => o.id === novOb.id);
  assert.equal(ob.state, "cancelled");
  assert.equal(ob.cancelledAsFutureUnpaidOnVacate, true);
});

test("2 vacancy creates ZERO receipts", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const { building } = await seedSepWithNov(db, owner);
  assert.equal(db.dump("receipts").length, 0);
  await run(db, owner, "endTenancy", {
    rentalId: building.rental.rentalId, endDate: "2026-10-15",
    reason: "إخلاء", arrearsDecision: "retain",
  }, opId("vac-fu-2"));
  assert.equal(db.dump("receipts").length, 0);
});

test("3 vacancy creates ZERO deposits / holding events", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const { building } = await seedSepWithNov(db, owner);
  const before = db.dump("deposits").length;
  await run(db, owner, "endTenancy", {
    rentalId: building.rental.rentalId, endDate: "2026-10-15",
    reason: "إخلاء", arrearsDecision: "retain",
  }, opId("vac-fu-3"));
  assert.equal(db.dump("deposits").length, before);
});

test("4 vacancy never copies obligation amount into paidFils", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const { building, novOb } = await seedSepWithNov(db, owner);
  await run(db, owner, "endTenancy", {
    rentalId: building.rental.rentalId, endDate: "2026-10-15",
    reason: "إخلاء", arrearsDecision: "retain",
  }, opId("vac-fu-4"));
  const dash = buildDashboardFromDump(db, "2026-11", "2026-10-15");
  assert.equal(dash.summary.collectedFils, 0);
  const view = (dash.obligations || []).find((v) => v.obligationId === novOb.id);
  assert.equal(view, undefined, "cancelled future ob must not appear in live views");
});

test("5 historical earned cash + later vacancy: receipt preserved; Holding follows money only", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const { building, yahia } = await seedBuilding(db, owner).then(async (building) => {
    const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
    return { building, yahia };
  });
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 200000, collectionDate: "2026-09-05",
  }, opId("hist-cash"));
  const beforeH = sharedHoldingFils({ receipts: db.dump("receipts"), deposits: db.dump("deposits") });
  await run(db, owner, "endTenancy", {
    rentalId: building.rental.rentalId, endDate: "2026-09-20",
    reason: "إخلاء بعد تحصيل", arrearsDecision: "retain",
  }, opId("vac-hist"));
  const receipt = db.dump("receipts").find((r) => r.obligationId === building.obligationId);
  assert.equal(receipt.state, RECEIPT_STATE.RECOGNIZED);
  assert.equal(
    sharedHoldingFils({ receipts: db.dump("receipts"), deposits: db.dump("deposits") }),
    beforeH,
  );
  const sep = buildDashboardFromDump(db, "2026-09", "2026-09-20");
  assert.equal(sep.summary.collectedFils, 200000);
  assert.equal(sep.summary.holdingFils, 200000);
});

test("6 payment reversal alone does not vacate", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const { building, yahia } = await seedBuilding(db, owner).then(async (building) => {
    const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
    return { building, yahia };
  });
  const r = await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 100000, collectionDate: "2026-09-05",
  }, opId("rev-only-cash"));
  await run(db, owner, "reverseReceipt", {
    receiptId: r.receiptId, reason: "عكس فقط",
  }, opId("rev-only"));
  const space = db.dump("spaces").find((s) => s.id === building.space.spaceId);
  assert.equal(space.occupancy, "rented");
  const rental = db.dump("rentals").find((x) => x.id === building.rental.rentalId);
  assert.equal(rental.state, "active");
});

test("7 vacancy does not reverse or recognize payment", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const { building, yahia } = await seedBuilding(db, owner).then(async (building) => {
    const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
    return { building, yahia };
  });
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 150000, collectionDate: "2026-09-05",
  }, opId("keep-cash"));
  await run(db, owner, "endTenancy", {
    rentalId: building.rental.rentalId, endDate: "2026-09-20",
    reason: "إخلاء", arrearsDecision: "retain",
  }, opId("vac-no-rev"));
  const live = db.dump("receipts").filter((r) => r.state === RECEIPT_STATE.RECOGNIZED);
  assert.equal(live.length, 1);
  assert.equal(live[0].amountFils, 150000);
  assert.equal(db.dump("receipts").filter((r) => r.state === RECEIPT_STATE.REVERSED).length, 0);
});

test("8 refresh/rebuild: unpaid vacated future still zero Holding", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const { building } = await seedSepWithNov(db, owner);
  await run(db, owner, "endTenancy", {
    rentalId: building.rental.rentalId, endDate: "2026-10-15",
    reason: "إخلاء", arrearsDecision: "retain",
  }, opId("vac-fu-8"));
  const a = buildDashboardFromDump(db, "2026-11", "2026-10-15");
  const b = buildDashboardFromDump(db, "2026-11", "2026-10-16");
  assert.equal(a.summary.holdingFils, 0);
  assert.equal(b.summary.holdingFils, 0);
  assert.equal(a.summary.collectedFils, 0);
  assert.equal(b.summary.collectedFils, 0);
  assert.equal(a.summary.sharedHoldingAllPeriodsFils, b.summary.sharedHoldingAllPeriodsFils);
});

test("9 due-month unpaid vacate still retains arrears (not Holding)", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const building = await seedBuilding(db, owner);
  await run(db, owner, "endTenancy", {
    rentalId: building.rental.rentalId, endDate: "2026-09-20",
    reason: "إخلاء متأخرات", arrearsDecision: "retain",
  }, opId("vac-due-retain"));
  const ob = db.dump("obligations").find((o) => o.id === building.obligationId);
  assert.equal(ob.state, "active");
  assert.equal(ob.retainArrearsAfterVacate, true);
  const dash = buildDashboardFromDump(db, "2026-09", "2026-09-20");
  assert.ok(dash.summary.remainingFils > 0);
  assert.equal(dash.summary.holdingFils, 0);
  assert.equal(dash.summary.collectedFils, 0);
});
