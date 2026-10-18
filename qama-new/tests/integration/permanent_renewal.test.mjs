/**
 * Renewal confirmation applies to every month from November 2026 onward.
 * No November-only branch. September and October stay on the old rule.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshDb, run, bootstrapOwner, createUser, actorFrom, opId } from "../helpers/commands.mjs";
import { buildDashboardFromDump } from "../../functions/services/readModel.mjs";
import { nextCycleStart, cycleEndInclusive } from "../../functions/domain/rental_cycle.mjs";

async function contract(db, owner, start, rent = 100000) {
  const prop = await run(db, owner, "createProperty", { name: "عقار", address: "محاكي" }, opId("prop"));
  const unit = await run(db, owner, "createUnit", { propertyId: prop.propertyId, name: "وحدة", kind: "whole" }, opId("unit"));
  const space = await run(db, owner, "createSpace", { unitId: unit.unitId, name: "غرفة" }, opId("space"));
  const rental = await run(db, owner, "createRental", {
    spaceId: space.spaceId, tenantName: "مستأجر تجريبي", contractualAmountFils: rent,
    dueDayOfMonth: Number(start.slice(8, 10)), startDate: start,
  }, opId("rental"));
  await run(db, owner, "generateObligations", { period: start.slice(0, 7) }, opId("gen"));
  return rental;
}

test("future months, year boundary, and leap day do not need a code change", async () => {
  assert.equal(nextCycleStart("2027-12-15", 1, 15), "2028-01-15");
  assert.equal(cycleEndInclusive("2027-12-15", 15), "2028-01-14");
  assert.equal(nextCycleStart("2028-01-31", 1, 31), "2028-02-29");
  assert.equal(nextCycleStart("2028-02-29", 1, 31), "2028-03-31");
  assert.equal(nextCycleStart("2027-01-31", 1, 31), "2027-02-28");

  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const employee = actorFrom(await createUser(db, owner, { displayName: "موظف", role: "employee", pin: "2026" }));
  const rental = await contract(db, owner, "2026-10-15");
  const octBefore = buildDashboardFromDump(db, "2026-10", "2026-10-20").summary.targetFils;
  const sepBefore = buildDashboardFromDump(db, "2026-09", "2026-10-20").summary.targetFils;

  for (const period of ["2026-12", "2027-01", "2027-12", "2028-02"]) {
    const opened = await run(db, owner, "generateObligations", { period }, opId("open-" + period));
    assert.equal(opened.created, 0, period);
  }

  const steps = [
    ["2026-11-10", "2026-11-15"],
    ["2026-12-10", "2026-12-15"],
    ["2027-01-10", "2027-01-15"],
  ];
  for (const [asOf, start] of steps) {
    const created = await run(db, employee, "renewRentalCycle", {
      rentalId: rental.rentalId, asOfDate: asOf,
    }, opId("renew-" + start));
    assert.equal(created.cycleStart, start);
    await assert.rejects(
      () => run(db, employee, "renewRentalCycle", { rentalId: rental.rentalId, asOfDate: asOf }, opId("early-" + start)),
      (err) => err && err.code === "CYCLE_NOT_DUE_YET",
    );
    const ack = await run(db, employee, "renewRentalCycle", {
      rentalId: rental.rentalId, acknowledgeCycleStart: start, asOfDate: asOf,
    }, opId("ack-" + start));
    assert.equal(ack.alreadyApplied, true);
    const period = start.slice(0, 7);
    const rows = db.dump("obligations").filter((o) => o.rentalId === rental.rentalId && o.period === period && o.state === "active");
    assert.equal(rows.length, 1);
    assert.equal(buildDashboardFromDump(db, period, asOf).summary.obligationTargetFils, 100000);
  }
  assert.equal((await run(db, owner, "generateObligations", { period: "2028-01" }, opId("still-manual"))).created, 0);

  assert.equal(buildDashboardFromDump(db, "2026-10", "2027-01-10").summary.targetFils, octBefore);
  assert.equal(buildDashboardFromDump(db, "2026-09", "2027-01-10").summary.targetFils, sepBefore);
  assert.equal(db.dump("receipts").length, 0);
});

test("a seeded future cycle stays out of the target until one confirmation", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const rental = await contract(db, owner, "2026-10-01", 80000);
  const doc = db.dump("rentals").find((r) => r.id === rental.rentalId);
  const id = `${rental.rentalId}_2027-06-01`;
  db.seed("obligations", id, {
    id, rentalCycleId: id, rentalId: rental.rentalId, spaceId: doc.spaceId,
    propertyId: doc.propertyId, unitId: doc.unitId, period: "2027-06",
    amountFils: 80000, dueDate: "2027-06-01", cycleStart: "2027-06-01", cycleEnd: "2027-06-30",
    state: "active", tenantNameSnapshot: "مستأجر تجريبي",
  });
  assert.equal(buildDashboardFromDump(db, "2027-06", "2027-06-02").summary.obligationTargetFils, 0);
  await assert.rejects(
    () => run(db, owner, "createCashReceipt", {
      obligationId: id, amountFils: 80000, collectionDate: "2027-06-02",
    }, opId("early")),
    (err) => err && err.code === "RENEWAL_NOT_CONFIRMED",
  );
  assert.equal(db.dump("receipts").length, 0);
  const ack = await run(db, owner, "renewRentalCycle", {
    rentalId: rental.rentalId, acknowledgeCycleStart: "2027-06-01", asOfDate: "2027-06-02",
  }, opId("ack"));
  assert.equal(ack.financialUnchanged, true);
  assert.equal(buildDashboardFromDump(db, "2027-06", "2027-06-02").summary.obligationTargetFils, 80000);
  assert.equal(db.dump("obligations").filter((o) => o.period === "2027-06" && o.state === "active").length, 1);
});
