/**
 * Safeguards for the September 2026 corrections:
 * cancelled unpaid rent must not look collectible, a same-day unpaid stay
 * must not become arrears, and a schedule change must not backdate into
 * a month another contract still covers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshDb, run, bootstrapOwner, seedBuilding, opId } from "../helpers/commands.mjs";
import { buildDashboardFromDump } from "../../functions/services/readModel.mjs";

async function rentedSpace(db, owner, { key, name, tenant, rent, start, dueDay }) {
  const prop = await run(db, owner, "createProperty", { name: "قمة", address: "دبي" }, opId("prop-" + key));
  const unit = await run(db, owner, "createUnit", { propertyId: prop.propertyId, name, kind: "partitioned" }, opId("unit-" + key));
  const space = await run(db, owner, "createSpace", { unitId: unit.unitId, name: name + " / 2" }, opId("space-" + key));
  const rental = await run(db, owner, "createRental", {
    spaceId: space.spaceId, tenantName: tenant, contractualAmountFils: rent,
    dueDayOfMonth: dueDay, startDate: start,
  }, opId("rent-" + key));
  await run(db, owner, "generateObligations", { period: start.slice(0, 7) }, opId("gen-" + key));
  const obligation = db.dump("obligations").find((o) => o.rentalId === rental.rentalId && o.state === "active");
  return { space, rental, obligation };
}

test("a closed cancelled unpaid September contract is vacant with no collectible rent", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const left = await rentedSpace(db, owner, {
    key: "203", name: "شقة 203", tenant: "دلينا", rent: 120000, start: "2026-09-25", dueDay: 25,
  });
  const stays = await rentedSpace(db, owner, {
    key: "101", name: "شقة 101", tenant: "محمود", rent: 150000, start: "2026-09-01", dueDay: 1,
  });
  await run(db, owner, "cancelObligation", {
    obligationId: left.obligation.id, reason: "لا يوجد مستحق",
  }, opId("cancel-203"));
  await run(db, owner, "endTenancy", {
    rentalId: left.rental.rentalId, endDate: "2026-10-03", reason: "غادر", arrearsDecision: "retain",
  }, opId("end-203"));

  const dash = buildDashboardFromDump(db, "2026-09", "2026-10-15");
  const card = dash.unitsTree.flatMap((u) => u.spaces).find((s) => s.spaceId === left.space.spaceId);
  const kept = dash.unitsTree.flatMap((u) => u.spaces).find((s) => s.spaceId === stays.space.spaceId);
  assert.equal(card.occupancy, "vacant");
  assert.equal(card.dueFils, 0);
  assert.equal(card.status, "vacant");
  assert.equal(db.dump("rentals").find((r) => r.id === left.rental.rentalId).tenantName, "دلينا");
  assert.equal(db.dump("rentals").find((r) => r.id === left.rental.rentalId).endDate, "2026-10-03");
  assert.equal(kept.occupancy, "rented");
  assert.equal(kept.dueFils, 150000);
  assert.equal(dash.summary.obligationTargetFils, 150000);
});

test("same-day unpaid vacate cancels the obligation instead of retaining arrears", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const row = await rentedSpace(db, owner, {
    key: "m3", name: "ميزان 3", tenant: "هندي", rent: 100000, start: "2026-09-25", dueDay: 25,
  });
  await run(db, owner, "endTenancy", {
    rentalId: row.rental.rentalId, endDate: "2026-09-25", reason: "إخلاء من زر مستقل", arrearsDecision: "retain",
  }, opId("same-day"));
  const ob = db.dump("obligations").find((o) => o.id === row.obligation.id);
  assert.equal(ob.state, "cancelled");
  assert.equal(ob.retainArrearsAfterVacate, undefined);
  const dash = buildDashboardFromDump(db, "2026-09", "2026-10-15");
  assert.equal(dash.summary.obligationTargetFils, 0);

  const stayed = await rentedSpace(db, owner, {
    key: "101b", name: "شقة 101", tenant: "محمود", rent: 150000, start: "2026-09-01", dueDay: 1,
  });
  await run(db, owner, "endTenancy", {
    rentalId: stayed.rental.rentalId, endDate: "2026-09-20", reason: "إخلاء مع متأخر", arrearsDecision: "retain",
  }, opId("real-arrears"));
  const kept = db.dump("obligations").find((o) => o.id === stayed.obligation.id);
  assert.equal(kept.state, "active");
  assert.equal(kept.retainArrearsAfterVacate, true);
  const after = buildDashboardFromDump(db, "2026-09", "2026-10-15");
  assert.equal(after.summary.obligationTargetFils, 150000);
});

test("moving a contract start back into a covered month is refused", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const first = await rentedSpace(db, owner, {
    key: "302", name: "شقة 302", tenant: "الصومال", rent: 100000, start: "2026-09-01", dueDay: 1,
  });
  await run(db, owner, "endTenancy", {
    rentalId: first.rental.rentalId, endDate: "2026-10-02", reason: "إخلاء", arrearsDecision: "retain",
  }, opId("vacate-302"));
  const propId = db.dump("spaces").find((s) => s.id === first.space.spaceId).propertyId;
  const unitId = db.dump("spaces").find((s) => s.id === first.space.spaceId).unitId;
  const space = await run(db, owner, "createSpace", { unitId, name: "شقة 302 / 5b" }, opId("space-b"));
  // Successor on the SAME space, starting in October after the September contract ended inside October.
  const successor = await run(db, owner, "createRental", {
    spaceId: first.space.spaceId, tenantName: "صومالي", contractualAmountFils: 100000,
    dueDayOfMonth: 8, startDate: "2026-10-08",
  }, opId("second-rent"));
  await assert.rejects(
    () => run(db, owner, "updateRentalSchedule", {
      rentalId: successor.rentalId, startDate: "2026-09-01", effectivePeriod: "2026-10",
    }, opId("backdate")),
    (err) => err && err.code === "PERIOD_ALREADY_COVERED",
  );
  assert.equal(db.dump("rentals").find((r) => r.id === successor.rentalId).startDate, "2026-10-08");
  assert.equal(propId && unitId && space.spaceId ? true : false, true);
});

test("a vacant partition can be re-rented after the previous contract ends", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const first = await rentedSpace(db, owner, {
    key: "rerent", name: "شقة 301", tenant: "السابق", rent: 100000, start: "2026-09-01", dueDay: 1,
  });
  await run(db, owner, "endTenancy", {
    rentalId: first.rental.rentalId, endDate: "2026-09-06", reason: "إخلاء", arrearsDecision: "retain",
  }, opId("rerent-end"));
  const next = await run(db, owner, "createRental", {
    spaceId: first.space.spaceId, tenantName: "الجديد", contractualAmountFils: 90000,
    dueDayOfMonth: 10, startDate: "2026-09-10",
  }, opId("rerent-next"));
  await run(db, owner, "generateObligations", { period: "2026-09" }, opId("rerent-gen"));
  const created = db.dump("obligations").filter((o) => o.rentalId === next.rentalId && o.state === "active");
  assert.equal(created.length, 1);
  assert.equal(created[0].amountFils, 90000);
  await assert.rejects(
    () => run(db, owner, "createRental", {
      spaceId: first.space.spaceId, tenantName: "تداخل", contractualAmountFils: 90000,
      dueDayOfMonth: 1, startDate: "2026-09-12",
    }, opId("rerent-overlap")),
    (err) => err && err.code === "SPACE_ALREADY_RENTED",
  );
});

test("a closed month refuses later owner changes to its money", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const building = await seedBuilding(db, owner);
  await run(db, owner, "savePeriodExtras", {
    period: "2026-09",
    extrasJson: JSON.stringify({
      dailyBookings: [
        { id: "kept", total: 50, paymentStatus: "unpaid", status: "active" },
        { id: "later", total: 20, paymentStatus: "unpaid", status: "active" },
      ],
    }),
  }, opId("extras-closed"));
  const cash = await run(db, owner, "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 100000, collectionDate: "2026-09-02",
  }, opId("cash-closed"));
  await run(db, owner, "reverseReceipt", {
    receiptId: cash.receiptId, reason: "before close",
  }, opId("rev-closed"));
  const daily = await run(db, owner, "createDailyCashReceipt", {
    bookingId: "kept", amountFils: 5000, collectionDate: "2026-09-03", period: "2026-09",
  }, opId("daily-closed"));
  const dep = await run(db, owner, "submitDeposit", {
    amountFils: 5000, depositDate: "2026-09-04",
    destinationAccountId: building.account.accountId,
    sourceKind: "holding", sourcePeriod: "2026-09", period: "2026-09",
  }, opId("dep-closed"));
  await run(db, owner, "closeAccountingPeriod", { period: "2026-09" }, opId("close-guard"));

  const blocked = [
    ["cancelObligation", { obligationId: building.obligationId, reason: "after close" }],
    ["createCashReceipt", { obligationId: building.obligationId, amountFils: 100000, collectionDate: "2026-09-05" }],
    ["createDailyCashReceipt", { bookingId: "later", amountFils: 2000, collectionDate: "2026-09-05", period: "2026-09" }],
    ["savePeriodExtras", { period: "2026-09", extrasJson: "{}" }],
    ["restoreReversedReceipt", { receiptId: cash.receiptId, reason: "after close" }],
    ["reverseDeposit", { depositId: dep.depositId, reason: "after close" }],
    ["endTenancy", { rentalId: building.rental.rentalId, endDate: "2026-09-20", reason: "after close", arrearsDecision: "retain" }],
  ];
  for (const [command, payload] of blocked) {
    await assert.rejects(
      () => run(db, owner, command, payload, opId("blocked-" + command)),
      (err) => err && err.code === "MONTH_CLOSED",
      command,
    );
  }

  assert.equal(db.dump("obligations").find((o) => o.id === building.obligationId).state, "active");
  assert.equal(db.dump("rentals").find((r) => r.id === building.rental.rentalId).state, "active");
  assert.equal(db.dump("receipts").find((r) => r.id === cash.receiptId).state, "reversed");
  assert.equal(db.dump("receipts").find((r) => r.id === daily.receiptId).state, "recognized");
  assert.equal(db.dump("deposits").find((d) => d.id === dep.depositId).state, "approved");
  assert.match(db.dump("uiPeriods").find((p) => p.period === "2026-09").extrasJson, /"later"/);
  await run(db, owner, "generateObligations", { period: "2026-10" }, opId("oct-open"));
  assert.equal(
    db.dump("obligations").some((o) => o.rentalId === building.rental.rentalId && o.period === "2026-10" && o.state === "active"),
    true,
  );
});
