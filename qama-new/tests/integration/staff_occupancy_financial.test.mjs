/**
 * Staff occupancy is independent from collection.
 * Zero rent must not create a future obligation or inflate target.
 * Positive staff rent stays chargeable. Historical receipts stay.
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

test("STAFF positive rent creates one charge and keeps it unpaid until a receipt", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const building = await seedBuilding(db, owner);
  const spaceId = building.space.spaceId;
  const result = await run(db, owner, "setSpaceOccupancy", {
    spaceId, occupancy: "staff", staffRentFils: 150000,
  }, opId("staff-pay"));
  assert.equal(result.occupancy, "staff");
  assert.ok(result.staffCharge && result.staffCharge.obligationId);
  const ob = db.dump("obligations").find((o) => o.id === result.staffCharge.obligationId);
  assert.equal(ob.amountFils, 150000);
  assert.notEqual(ob.state, "cancelled");
  const receipts = db.dump("receipts").filter((r) => r.obligationId === ob.id && r.state === "recognized");
  assert.equal(receipts.length, 0);
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
