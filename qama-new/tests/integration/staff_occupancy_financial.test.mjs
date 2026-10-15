/**
 * Staff occupancy is independent from collection.
 * Zero rent must not create a future obligation or inflate target.
 * A positive staff amount does not create a charge. Historical receipts stay.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshDb, run, bootstrapOwner, seedBuilding, opId } from "../helpers/commands.mjs";
import { buildDashboardFromDump } from "../../functions/services/readModel.mjs";

test("STAFF zero rent creates no obligation and does not inflate target", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const building = await seedBuilding(db, owner);
  const spaceId = building.space.spaceId;
  await run(db, owner, "setSpaceOccupancy", {
    spaceId, occupancy: "staff", staffRentFils: 0,
  }, opId("staff0"));
  const space = db.dump("spaces").find((s) => s.id === spaceId);
  assert.equal(space.occupancy, "staff");
  assert.equal(space.staffRentFils, 0);
  const active = db.dump("rentals").filter((r) => r.spaceId === spaceId && r.state === "active");
  assert.equal(active.length, 0);
  const openObs = db.dump("obligations").filter((o) => o.spaceId === spaceId && o.state !== "cancelled" && Number(o.amountFils) > 0);
  const dash = buildDashboardFromDump(db, "2026-10", "2026-10-20");
  const row = dash.spaces.find((s) => s.id === spaceId);
  assert.equal(row.occupancy, "staff");
  assert.equal(dash.summary.targetFils, 0);
  assert.ok(openObs.every((o) => o.period < "2026-10" || o.state === "cancelled" || Number(o.amountFils) === 0));
});

test("STAFF positive rent does not create a charge or a receipt", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const building = await seedBuilding(db, owner);
  const spaceId = building.space.spaceId;
  const before = db.dump("receipts").length;
  const result = await run(db, owner, "setSpaceOccupancy", {
    spaceId, occupancy: "staff", staffRentFils: 150000,
  }, opId("staff-pay"));
  assert.equal(result.occupancy, "staff");
  assert.equal(result.staffRentFils, 0);
  const space = db.dump("spaces").find((s) => s.id === spaceId);
  assert.equal(space.occupancy, "staff");
  assert.equal(space.staffRentFils, 0);
  const staffCharges = db.dump("obligations").filter((o) => o.spaceId === spaceId && o.purpose === "staff");
  assert.equal(staffCharges.length, 0);
  const september = db.dump("obligations").find((o) => o.id === building.obligationId);
  assert.equal(september.state, "active");
  assert.equal(september.amountFils, 920000);
  assert.equal(db.dump("receipts").length, before);
  const dash = buildDashboardFromDump(db, "2026-10", "2026-10-20");
  assert.equal(dash.summary.targetFils, 0);
});

test("RENTED after zero-rent STAFF does not invent an obligation or a receipt", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const building = await seedBuilding(db, owner);
  const spaceId = building.space.spaceId;
  const before = db.dump("obligations").filter((o) => o.spaceId === spaceId).length;
  const receiptsBefore = db.dump("receipts").length;
  await run(db, owner, "setSpaceOccupancy", {
    spaceId, occupancy: "staff", staffRentFils: 0,
  }, opId("staff0b"));
  await run(db, owner, "setSpaceOccupancy", { spaceId, occupancy: "rented" }, opId("back"));
  const space = db.dump("spaces").find((s) => s.id === spaceId);
  assert.equal(space.occupancy, "rented");
  const active = db.dump("rentals").filter((r) => r.spaceId === spaceId && r.state === "active");
  assert.equal(active.length, 0);
  assert.equal(db.dump("obligations").filter((o) => o.spaceId === spaceId).length, before);
  assert.equal(db.dump("receipts").length, receiptsBefore);
});

test("duplicate monthly obligation for the same period is refused", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const building = await seedBuilding(db, owner);
  await run(db, owner, "generateObligations", { period: "2026-09" }, opId("gen1"));
  await run(db, owner, "generateObligations", { period: "2026-09" }, opId("gen2"));
  const live = db.dump("obligations").filter((o) => o.spaceId === building.space.spaceId && o.period === "2026-09" && o.state !== "cancelled");
  assert.equal(live.length, 1);
});
