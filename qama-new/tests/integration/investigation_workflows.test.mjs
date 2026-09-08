/**
 * Vacate cycle + deposit reverse + partial payment command-layer proofs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshDb, run, bootstrapOwner, seedBuilding, createUser, actorFrom, opId } from "../helpers/commands.mjs";
import { buildDashboardFromDump } from "../../functions/services/readModel.mjs";
import { APPROVAL_STATE } from "../../src/domain/finance.mjs";

async function setup() {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const building = await seedBuilding(db, owner);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const revenue = await run(db, owner, "createAccount", { name: "الإيرادات", kind: "bank" });
  return { db, owner, building, yahia, revenue };
}

test("vacate→rent→vacate: second vacate closes NEW rental (distinct opIds)", async () => {
  const { db, owner, building } = await setup();
  const spaceId = building.space.spaceId;
  const r1 = building.rental.rentalId;

  const vac1 = await run(db, owner, "setSpaceOccupancy", {
    spaceId, occupancy: "vacant",
  }, "occ-" + spaceId + "-vacant-" + r1);
  assert.equal(vac1.occupancy, "vacant");
  assert.equal(vac1.replay, false);

  const vac1Replay = await run(db, owner, "setSpaceOccupancy", {
    spaceId, occupancy: "vacant",
  }, "occ-" + spaceId + "-vacant-" + r1);
  assert.equal(vac1Replay.replay, true);

  const r2 = await run(db, owner, "createRental", {
    spaceId,
    tenantName: "مستأجر ثاني",
    contractualAmountFils: 10000,
    dueDayOfMonth: 5,
    startDate: "2026-09-10",
  }, opId("rent2"));
  assert.ok(r2.rentalId);
  assert.notEqual(r2.rentalId, r1);

  // Stale vacate opId from cycle 1 with same payload would replay without closing r2.
  const stale = await run(db, owner, "setSpaceOccupancy", {
    spaceId, occupancy: "vacant",
  }, "occ-" + spaceId + "-vacant-" + r1);
  assert.equal(stale.replay, true);

  const rentalAfterStale = db.dump("rentals").find((r) => r.id === r2.rentalId);
  assert.equal(rentalAfterStale.state, "active");

  // Correct cycle-2 opId (includes new rentalId) must close r2.
  const vac2 = await run(db, owner, "setSpaceOccupancy", {
    spaceId, occupancy: "vacant",
  }, "occ-" + spaceId + "-vacant-" + r2.rentalId);
  assert.equal(vac2.replay, false);
  assert.equal(vac2.occupancy, "vacant");

  const dash = buildDashboardFromDump(db, building.period, "2026-09-15");
  const sp = dash.spaces.find((s) => s.id === spaceId);
  assert.equal(sp.occupancy, "vacant");
  assert.equal(db.dump("rentals").find((r) => r.id === r2.rentalId).state, "closed");
});

test("partial 40 then 60 then reverse one receipt", async () => {
  const { db, owner, building, yahia } = await setup();
  const ob = building.obligationId;

  const p1 = await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: ob, amountFils: 4000, collectionDate: "2026-09-05",
  }, "pay-" + ob + "-w4000-d4000-g0");
  let dash = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.equal(dash.summary.collectedFils, 4000);
  assert.equal(dash.obligations[0].status, "partial");

  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: ob, amountFils: 6000, collectionDate: "2026-09-06",
  }, "pay-" + ob + "-w10000-d6000-g1");
  dash = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.equal(dash.summary.collectedFils, 10000);

  const rev = await run(db, owner, "reverseReceipt", {
    receiptId: p1.receiptId, reason: "عكس دفعة جزئية",
  });
  assert.ok(rev.reversalId);
  dash = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.equal(dash.summary.collectedFils, 6000);
  assert.equal(dash.summary.holdingFils, 6000);

  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: ob, amountFils: 4000, collectionDate: "2026-09-07",
  }, "pay-" + ob + "-w10000-d4000-g2");
  dash = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.equal(dash.summary.collectedFils, 10000);
});

test("deposit reverse restores holding and blocks double reverse", async () => {
  const { db, owner, building, yahia, revenue } = await setup();
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 10000, collectionDate: "2026-09-05",
  });
  const dep = await run(db, actorFrom(yahia), "submitDeposit", {
    amountFils: 10000, depositDate: "2026-09-05", destinationAccountId: revenue.accountId,
    reference: "BOT DEP OK",
  });
  await run(db, owner, "approveDeposit", { depositId: dep.depositId });
  let dash = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.equal(dash.summary.depositedFils, 10000);
  assert.equal(dash.summary.holdingFils, 0);

  const rev = await run(db, owner, "reverseDeposit", {
    depositId: dep.depositId, reason: "تصحيح اختبار",
  });
  assert.ok(rev.reversalId);
  dash = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.equal(dash.summary.depositedFils, 0);
  assert.equal(dash.summary.holdingFils, 10000);

  await assert.rejects(
    () => run(db, owner, "reverseDeposit", { depositId: dep.depositId, reason: "مرة أخرى" }, opId("rev2")),
    (e) => e.code === "ALREADY_REVERSED"
  );
  const depDoc = db.dump("deposits").find((d) => d.id === dep.depositId);
  assert.equal(depDoc.state, APPROVAL_STATE.REVERSED);
});
