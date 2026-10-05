/**
 * Month isolation / historical immutability / effective-dated rental state.
 *
 * An October vacancy (or rent/tenant change) must NEVER rewrite September.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  freshDb, run, bootstrapOwner, seedBuilding, createUser, actorFrom, opId,
} from "../helpers/commands.mjs";
import { buildDashboardFromDump } from "../../functions/services/readModel.mjs";
import {
  rentalCoversPeriod, occupancyForPeriod, liveObligationsForPeriod,
} from "../../functions/domain/finance.mjs";

async function setup() {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const building = await seedBuilding(db, owner);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "1111" });
  return { db, owner, building, yahia };
}

function spaceOn(dash, spaceId) {
  return (dash.unitsTree || [])
    .flatMap((u) => u.spaces || [])
    .find((s) => s.spaceId === spaceId)
    || (dash.spaces || []).find((s) => s.id === spaceId || s.spaceId === spaceId);
}

function snapMonth(db, period, asOf, spaceId) {
  const d = buildDashboardFromDump(db, period, asOf);
  const sp = spaceOn(d, spaceId);
  return {
    occupancy: sp?.occupancy,
    tenantName: sp?.tenantName || null,
    target: d.summary.targetFils,
    collected: d.summary.collectedFils,
    deposited: d.summary.depositedFils,
    holding: d.summary.holdingFils,
    dueFils: sp?.dueFils ?? 0,
    status: sp?.status,
    obligationId: sp?.obligationId || null,
  };
}

test("domain: rentalCoversPeriod — Oct vacate keeps Sep, drops Oct", () => {
  const r = { startDate: "2026-09-01", endDate: "2026-10-01", state: "closed" };
  assert.equal(rentalCoversPeriod(r, "2026-09"), true);
  assert.equal(rentalCoversPeriod(r, "2026-10"), false);
  assert.equal(rentalCoversPeriod(r, "2026-11"), false);
  assert.equal(
    occupancyForPeriod({
      space: { id: "s", occupancy: "vacant" },
      rentals: [{ ...r, spaceId: "s", id: "r1" }],
      period: "2026-09",
      asOfDate: "2026-10-05",
    }),
    "rented",
  );
  assert.equal(
    occupancyForPeriod({
      space: { id: "s", occupancy: "vacant" },
      rentals: [{ ...r, spaceId: "s", id: "r1" }],
      period: "2026-10",
      asOfDate: "2026-10-05",
    }),
    "vacant",
  );
});

test("TEST 1 — October vacancy must not change September", async () => {
  const { db, owner, building } = await setup();
  const spaceId = building.space.spaceId;
  // Rename tenant for clarity
  await run(db, owner, "updateRentalTenant", {
    rentalId: building.rental.rentalId, tenantName: "Mohammed",
    effectivePeriod: "2026-09",
  }, opId("t1-tenant"));
  await run(db, owner, "updateRentalRent", {
    rentalId: building.rental.rentalId,
    contractualAmountFils: 100000,
    effectivePeriod: "2026-09",
  }, opId("t1-rent"));

  const before = snapMonth(db, "2026-09", "2026-09-20", spaceId);
  assert.equal(before.occupancy, "rented");
  assert.equal(before.tenantName, "Mohammed");
  assert.equal(before.target, 100000);

  await run(db, owner, "generateObligations", { period: "2026-10" }, opId("t1-oct"));
  await run(db, owner, "endTenancy", {
    rentalId: building.rental.rentalId,
    endDate: "2026-10-01",
    reason: "إخلاء أكتوبر",
    arrearsDecision: "retain",
  }, opId("t1-vacate"));

  const afterSep = snapMonth(db, "2026-09", "2026-10-05", spaceId);
  assert.equal(afterSep.occupancy, "rented");
  assert.equal(afterSep.tenantName, "Mohammed");
  assert.equal(afterSep.target, 100000);
  assert.equal(afterSep.dueFils, 100000);

  const afterOct = snapMonth(db, "2026-10", "2026-10-05", spaceId);
  assert.equal(afterOct.occupancy, "vacant");
  assert.equal(db.dump("spaces").find((s) => s.id === spaceId).occupancy, "vacant");

  const sepOb = db.dump("obligations").find((o) => o.id === building.obligationId);
  assert.equal(sepOb.state, "active");
});

test("TEST 2 — October rent change must not rewrite September rent", async () => {
  const { db, owner, building } = await setup();
  await run(db, owner, "updateRentalRent", {
    rentalId: building.rental.rentalId,
    contractualAmountFils: 100000,
    effectivePeriod: "2026-09",
  }, opId("t2-sep"));
  await run(db, owner, "generateObligations", { period: "2026-10" }, opId("t2-gen"));
  await run(db, owner, "updateRentalRent", {
    rentalId: building.rental.rentalId,
    contractualAmountFils: 120000,
    effectivePeriod: "2026-10",
  }, opId("t2-oct"));

  const sepOb = db.dump("obligations").find((o) => o.id === building.obligationId);
  assert.equal(sepOb.amountFils, 100000);
  const octOb = db.dump("obligations").find(
    (o) => o.rentalId === building.rental.rentalId && o.period === "2026-10" && o.state === "active",
  );
  assert.ok(octOb);
  assert.equal(octOb.amountFils, 120000);

  const sep = snapMonth(db, "2026-09", "2026-10-05", building.space.spaceId);
  assert.equal(sep.target, 100000);
  const oct = snapMonth(db, "2026-10", "2026-10-05", building.space.spaceId);
  assert.equal(oct.target, 120000);
});

test("TEST 3 — Tenant replacement preserves September tenant", async () => {
  const { db, owner, building } = await setup();
  const spaceId = building.space.spaceId;
  await run(db, owner, "updateRentalTenant", {
    rentalId: building.rental.rentalId, tenantName: "TenantA",
    effectivePeriod: "2026-09",
  }, opId("t3-a"));
  const sepObBefore = db.dump("obligations").find((o) => o.id === building.obligationId);
  assert.equal(sepObBefore.tenantNameSnapshot, "TenantA");

  await run(db, owner, "endTenancy", {
    rentalId: building.rental.rentalId,
    endDate: "2026-10-01",
    reason: "استبدال",
    arrearsDecision: "retain",
  }, opId("t3-end"));
  const neu = await run(db, owner, "createRental", {
    spaceId,
    tenantName: "TenantB",
    contractualAmountFils: 100000,
    dueDayOfMonth: 1,
    startDate: "2026-10-01",
  }, opId("t3-new"));
  await run(db, owner, "generateObligations", { period: "2026-10" }, opId("t3-gen"));

  const sep = snapMonth(db, "2026-09", "2026-10-05", spaceId);
  assert.equal(sep.occupancy, "rented");
  assert.equal(sep.tenantName, "TenantA");
  const closed = db.dump("rentals").find((r) => r.id === building.rental.rentalId);
  assert.equal(closed.tenantName, "TenantA");

  const oct = snapMonth(db, "2026-10", "2026-10-05", spaceId);
  assert.equal(oct.occupancy, "rented");
  assert.equal(oct.tenantName, "TenantB");
  assert.notEqual(neu.rentalId, building.rental.rentalId);
});

test("TEST 4 — Historical receipts survive October vacancy", async () => {
  const { db, owner, building, yahia } = await setup();
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 500000, collectionDate: "2026-09-05",
  }, opId("t4-cash"));
  const before = snapMonth(db, "2026-09", "2026-09-20", building.space.spaceId);
  assert.equal(before.collected, 500000);

  await run(db, owner, "endTenancy", {
    rentalId: building.rental.rentalId,
    endDate: "2026-10-01",
    reason: "إخلاء",
    arrearsDecision: "retain",
  }, opId("t4-vac"));

  const after = snapMonth(db, "2026-09", "2026-10-05", building.space.spaceId);
  assert.equal(after.collected, 500000);
  assert.equal(after.holding, before.holding);
  const rcpt = db.dump("receipts").filter((r) => r.obligationId === building.obligationId);
  assert.ok(rcpt.some((r) => r.state === "recognized" && r.amountFils === 500000));
  assert.equal(rcpt.filter((r) => r.state === "reversed").length, 0);
});

test("TEST 5 — Future obligation cancelled; September untouched", async () => {
  const { db, owner, building } = await setup();
  await run(db, owner, "generateObligations", { period: "2026-10" }, opId("t5-oct"));
  await run(db, owner, "generateObligations", { period: "2026-11" }, opId("t5-nov"));
  const novBefore = db.dump("obligations").find(
    (o) => o.rentalId === building.rental.rentalId && o.period === "2026-11" && o.state === "active",
  );
  assert.ok(novBefore);

  await run(db, owner, "endTenancy", {
    rentalId: building.rental.rentalId,
    endDate: "2026-10-05",
    reason: "إخلاء قبل نوفمبر",
    arrearsDecision: "retain",
  }, opId("t5-vac"));

  const nov = db.dump("obligations").find((o) => o.id === novBefore.id);
  assert.equal(nov.state, "cancelled");
  assert.equal(nov.cancelledAsFutureUnpaidOnVacate, true);

  const sep = db.dump("obligations").find((o) => o.id === building.obligationId);
  assert.equal(sep.state, "active");
  assert.equal(snapMonth(db, "2026-09", "2026-10-05", building.space.spaceId).target, 920000);
});

test("TEST 6 — Explicit September correction only affects September", async () => {
  const { db, owner, building } = await setup();
  await run(db, owner, "generateObligations", { period: "2026-10" }, opId("t6-oct"));
  // Explicit historical vacate effective in September
  await run(db, owner, "endTenancy", {
    rentalId: building.rental.rentalId,
    endDate: "2026-09-15",
    reason: "تصحيح تاريخي سبتمبر",
    arrearsDecision: "retain",
  }, opId("t6-corr"));

  const sep = snapMonth(db, "2026-09", "2026-10-05", building.space.spaceId);
  assert.equal(sep.occupancy, "vacant");
  // Retained arrears still contribute to Target
  assert.ok(sep.target > 0);

  const oct = snapMonth(db, "2026-10", "2026-10-05", building.space.spaceId);
  assert.equal(oct.occupancy, "vacant");
  const octOb = db.dump("obligations").find(
    (o) => o.rentalId === building.rental.rentalId && o.period === "2026-10",
  );
  // Oct due 2026-10-01 > vacate 2026-09-15 → cancelled as future
  assert.equal(octOb.state, "cancelled");
});

test("TEST 7 — Refresh/rebuild read model is identical", async () => {
  const { db, owner, building } = await setup();
  await run(db, owner, "endTenancy", {
    rentalId: building.rental.rentalId,
    endDate: "2026-10-01",
    reason: "إخلاء",
    arrearsDecision: "retain",
  }, opId("t7-vac"));
  const a = snapMonth(db, "2026-09", "2026-10-05", building.space.spaceId);
  const b = snapMonth(db, "2026-09", "2026-10-05", building.space.spaceId);
  assert.deepEqual(a, b);
  assert.equal(a.occupancy, "rented");
});

test("TEST 8 — Month navigation isolation Sep ↔ Oct ↔ Sep", async () => {
  const { db, owner, building, yahia } = await setup();
  const spaceId = building.space.spaceId;
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 300000, collectionDate: "2026-09-05",
  }, opId("t8-pay"));
  const before = snapMonth(db, "2026-09", "2026-09-20", spaceId);

  await run(db, owner, "generateObligations", { period: "2026-10" }, opId("t8-oct"));
  await run(db, owner, "endTenancy", {
    rentalId: building.rental.rentalId,
    endDate: "2026-10-01",
    reason: "إخلاء",
    arrearsDecision: "retain",
  }, opId("t8-vac"));

  const after = snapMonth(db, "2026-09", "2026-10-15", spaceId);
  assert.equal(after.occupancy, before.occupancy);
  assert.equal(after.target, before.target);
  assert.equal(after.collected, before.collected);
  assert.equal(after.holding, before.holding);
  assert.equal(after.dueFils, before.dueFils);
});

test("TEST 9 — November change must not rewrite Sep or Oct", async () => {
  const { db, owner, building } = await setup();
  const spaceId = building.space.spaceId;
  await run(db, owner, "generateObligations", { period: "2026-10" }, opId("t9-oct"));
  await run(db, owner, "generateObligations", { period: "2026-11" }, opId("t9-nov"));
  const sepBefore = snapMonth(db, "2026-09", "2026-09-20", spaceId);
  const octBefore = snapMonth(db, "2026-10", "2026-10-05", spaceId);

  await run(db, owner, "endTenancy", {
    rentalId: building.rental.rentalId,
    endDate: "2026-11-01",
    reason: "إخلاء نوفمبر",
    arrearsDecision: "retain",
  }, opId("t9-vac"));

  const sepAfter = snapMonth(db, "2026-09", "2026-11-05", spaceId);
  assert.equal(sepAfter.occupancy, "rented");
  assert.equal(sepAfter.target, sepBefore.target);
  assert.equal(sepAfter.collected, sepBefore.collected);
  const octAfter = snapMonth(db, "2026-10", "2026-11-05", spaceId);
  assert.equal(octAfter.occupancy, "rented");
  assert.equal(octAfter.target, octBefore.target);
  assert.equal(snapMonth(db, "2026-11", "2026-11-05", spaceId).occupancy, "vacant");
});

test("TEST 10 — Mutating October does not write September uiPeriods", async () => {
  const { db, owner, building } = await setup();
  await run(db, owner, "savePeriodExtras", {
    period: "2026-09",
    extrasJson: JSON.stringify({ marker: "sep-only", dailyBookings: [] }),
  }, opId("t10-sep"));
  const sepBefore = JSON.stringify(db.dump("uiPeriods").find((p) => p.period === "2026-09"));

  await run(db, owner, "generateObligations", { period: "2026-10" }, opId("t10-oct"));
  await run(db, owner, "savePeriodExtras", {
    period: "2026-10",
    extrasJson: JSON.stringify({ marker: "oct-only", dailyBookings: [] }),
  }, opId("t10-octex"));
  await run(db, owner, "endTenancy", {
    rentalId: building.rental.rentalId,
    endDate: "2026-10-01",
    reason: "إخلاء",
    arrearsDecision: "retain",
  }, opId("t10-vac"));

  const sepAfter = JSON.stringify(db.dump("uiPeriods").find((p) => p.period === "2026-09"));
  assert.equal(sepAfter, sepBefore);
  assert.match(sepAfter, /sep-only/);
  assert.match(JSON.stringify(db.dump("uiPeriods").find((p) => p.period === "2026-10")), /oct-only/);
});

test("liveObligationsForPeriod keeps frozen historical unpaid after close", () => {
  const rental = {
    id: "r1", spaceId: "s1", startDate: "2026-09-01", endDate: "2026-10-01", state: "closed",
  };
  const obs = [{
    id: "o-sep", rentalId: "r1", period: "2026-09", state: "active",
    amountFils: 100000, dueDate: "2026-09-01",
  }];
  const live = liveObligationsForPeriod(obs, [rental], []);
  assert.equal(live.length, 1);
});
