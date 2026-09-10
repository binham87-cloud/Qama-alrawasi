/**
 * Renewal / endTenancy / uncollect separation (emulator in-memory).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  freshDb, run, bootstrapOwner, seedBuilding, createUser, actorFrom, opId,
} from "../helpers/commands.mjs";
import { buildDashboardFromDump } from "../../functions/services/readModel.mjs";
import { sharedHoldingFils } from "../../functions/domain/finance.mjs";

async function setup() {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const building = await seedBuilding(db, owner);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "1111" });
  return { db, owner, building, yahia };
}

test("1 renew keeps tenant/rent; new cycle due unpaid; no receipt", async () => {
  const { db, owner, building } = await setup();
  const r1 = await run(db, owner, "renewRentalCycle", {
    rentalId: building.rental.rentalId, asOfDate: "2026-10-15",
  }, opId("renew-1"));
  assert.equal(r1.alreadyApplied, false);
  assert.equal(r1.cycleStart, "2026-10-01"); // start was Sep 1 → next Oct 1
  const ob = db.dump("obligations").find((o) => o.id === r1.obligationId);
  assert.equal(ob.tenantNameSnapshot, "أحمد");
  assert.equal(ob.amountFils, 920000);
  assert.equal(ob.previousCycleId, building.obligationId);
  assert.equal(db.dump("receipts").filter((r) => r.obligationId === r1.obligationId).length, 0);
  const dash = buildDashboardFromDump(db, "2026-10", "2026-10-15");
  const view = dash.summary.views.find((v) => v.obligationId === r1.obligationId);
  assert.ok(view);
  assert.equal(view.paidFils, 0);
  assert.equal(view.dueFils, 920000);
});

test("2 renew twice / same op replay does not duplicate cycle", async () => {
  const { db, owner, building } = await setup();
  const oid = opId("renew-dup");
  const a = await run(db, owner, "renewRentalCycle", {
    rentalId: building.rental.rentalId, asOfDate: "2026-10-15",
  }, oid);
  const b = await run(db, owner, "renewRentalCycle", {
    rentalId: building.rental.rentalId, asOfDate: "2026-10-15",
  }, oid);
  assert.equal(b.replay === true || b.alreadyApplied === true, true);
  // New opId after success: next cycle (Nov) is not due yet — must not create another Oct cycle.
  await assert.rejects(
    () => run(db, owner, "renewRentalCycle", {
      rentalId: building.rental.rentalId, asOfDate: "2026-10-15",
    }, opId("renew-dup-2")),
    (e) => e.code === "CYCLE_NOT_DUE_YET",
  );
  const cycles = db.dump("obligations").filter((o) => o.rentalId === building.rental.rentalId && o.cycleStart === "2026-10-01");
  assert.equal(cycles.length, 1);
  assert.ok(a.obligationId);
});

test("3 concurrent renew same cycle — one create", async () => {
  const { db, owner, building } = await setup();
  const results = await Promise.allSettled([
    run(db, owner, "renewRentalCycle", { rentalId: building.rental.rentalId, asOfDate: "2026-10-15" }, opId("ren-a")),
    run(db, owner, "renewRentalCycle", { rentalId: building.rental.rentalId, asOfDate: "2026-10-15" }, opId("ren-b")),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  assert.ok(ok.length >= 1);
  const ids = new Set(ok.map((r) => r.obligationId));
  assert.equal(ids.size, 1);
  const cycles = db.dump("obligations").filter((o) => o.cycleStart === "2026-10-01");
  assert.equal(cycles.length, 1);
});

test("5 endTenancy after paid keeps holding; no reverse", async () => {
  const { db, owner, building, yahia } = await setup();
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 920000, collectionDate: "2026-09-05",
  });
  const beforeH = sharedHoldingFils({ receipts: db.dump("receipts"), deposits: db.dump("deposits") });
  await run(db, owner, "endTenancy", {
    rentalId: building.rental.rentalId, endDate: "2026-09-30", reason: "إخلاء",
    arrearsDecision: "none",
  }, opId("end-paid"));
  const afterH = sharedHoldingFils({ receipts: db.dump("receipts"), deposits: db.dump("deposits") });
  assert.equal(afterH, beforeH);
  assert.equal(db.dump("receipts").find((r) => r.obligationId === building.obligationId).state, "recognized");
  assert.equal(db.dump("spaces").find((s) => s.id === building.space.spaceId).occupancy, "vacant");
  assert.equal(db.dump("rentals").find((r) => r.id === building.rental.rentalId).state, "closed");
});

test("6 endTenancy with arrears requires retain; then arrears remain", async () => {
  const { db, owner, building } = await setup();
  await assert.rejects(
    () => run(db, owner, "endTenancy", {
      rentalId: building.rental.rentalId, endDate: "2026-09-30", reason: "إخلاء",
    }, opId("end-arr-1")),
    (e) => e.code === "ARREARS_CONFIRMATION_REQUIRED",
  );
  const end = await run(db, owner, "endTenancy", {
    rentalId: building.rental.rentalId, endDate: "2026-09-30", reason: "إخلاء",
    arrearsDecision: "retain",
  }, opId("end-arr-2"));
  assert.ok(end.arrearsFils > 0);
  const ob = db.dump("obligations").find((o) => o.id === building.obligationId);
  assert.equal(ob.retainArrearsAfterVacate, true);
  assert.equal(ob.state, "active");
  const dash = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.ok(dash.summary.remainingFils > 0);
});

test("7 uncollect alone reverses once and drops holding", async () => {
  const { db, owner, building, yahia } = await setup();
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 50000, collectionDate: "2026-09-05",
  });
  assert.equal(sharedHoldingFils({ receipts: db.dump("receipts"), deposits: [] }), 50000);
  await run(db, owner, "uncollectObligation", {
    obligationId: building.obligationId, reason: "خطأ",
  }, opId("uncol-1"));
  assert.equal(sharedHoldingFils({ receipts: db.dump("receipts"), deposits: [] }), 0);
  // Second uncollect is a no-op (no live receipts) — holding stays 0, no double reverse.
  await run(db, owner, "uncollectObligation", {
    obligationId: building.obligationId, reason: "خطأ",
  }, opId("uncol-2"));
  assert.equal(sharedHoldingFils({ receipts: db.dump("receipts"), deposits: [] }), 0);
  assert.equal(db.dump("receipts").filter((r) => r.obligationId === building.obligationId && r.state === "reversed").length, 1);
});

test("9 re-rent space to new tenant after endTenancy — separate history", async () => {
  const { db, owner, building, yahia } = await setup();
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 920000, collectionDate: "2026-09-05",
  });
  await run(db, owner, "endTenancy", {
    rentalId: building.rental.rentalId, endDate: "2026-09-20", reason: "إخلاء",
  }, opId("end-rerent"));
  const r2 = await run(db, owner, "createRental", {
    spaceId: building.space.spaceId,
    tenantName: "خالد",
    contractualAmountFils: 800000,
    dueDayOfMonth: 15,
    startDate: "2026-09-21",
  }, opId("rent-new"));
  const gen = await run(db, owner, "generateObligations", { period: "2026-09" }, opId("gen-new"));
  assert.ok(gen.created >= 1);
  const newOb = db.dump("obligations").find((o) => o.rentalId === r2.rentalId);
  assert.equal(newOb.tenantNameSnapshot, "خالد");
  assert.equal(newOb.amountFils, 800000);
  const oldRcpt = db.dump("receipts").find((r) => r.obligationId === building.obligationId);
  assert.equal(oldRcpt.state, "recognized");
  assert.notEqual(newOb.id, building.obligationId);
});

test("8 recollect after uncollect does not revive old receipt", async () => {
  const { db, owner, building, yahia } = await setup();
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 920000, collectionDate: "2026-09-05",
  }, opId("pay-8a"));
  await run(db, owner, "uncollectObligation", {
    obligationId: building.obligationId, reason: "خطأ",
  }, opId("uncol-8"));
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 920000, collectionDate: "2026-09-06",
  }, opId("pay-8b"));
  const live = db.dump("receipts").filter((r) => r.obligationId === building.obligationId && r.state === "recognized");
  assert.equal(live.length, 1);
  assert.equal(sharedHoldingFils({ receipts: db.dump("receipts"), deposits: [] }), 920000);
});

test("10 Dec→Jan renew with anniversary day", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const prop = await run(db, owner, "createProperty", { name: "P" }, opId("p10"));
  const unit = await run(db, owner, "createUnit", { propertyId: prop.propertyId, name: "U", kind: "partitioned" }, opId("u10"));
  const space = await run(db, owner, "createSpace", { unitId: unit.unitId, name: "1" }, opId("s10"));
  const rental = await run(db, owner, "createRental", {
    spaceId: space.spaceId, tenantName: "سامي", contractualAmountFils: 100000,
    dueDayOfMonth: 15, startDate: "2026-12-15",
  }, opId("r10"));
  await run(db, owner, "generateObligations", { period: "2026-12" }, opId("g10"));
  const ren = await run(db, owner, "renewRentalCycle", {
    rentalId: rental.rentalId, asOfDate: "2027-01-15",
  }, opId("ren10"));
  assert.equal(ren.cycleStart, "2027-01-15");
  assert.equal(ren.cycleEnd, "2027-02-14");
});

test("11 day-31 anniversary restores after Feb clamp", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const prop = await run(db, owner, "createProperty", { name: "P31" }, opId("p31"));
  const unit = await run(db, owner, "createUnit", { propertyId: prop.propertyId, name: "U", kind: "partitioned" }, opId("u31"));
  const space = await run(db, owner, "createSpace", { unitId: unit.unitId, name: "1" }, opId("s31"));
  const rental = await run(db, owner, "createRental", {
    spaceId: space.spaceId, tenantName: "ليث", contractualAmountFils: 100000,
    dueDayOfMonth: 31, startDate: "2026-01-31",
  }, opId("r31"));
  await run(db, owner, "generateObligations", { period: "2026-01" }, opId("g31"));
  const feb = await run(db, owner, "renewRentalCycle", {
    rentalId: rental.rentalId, asOfDate: "2026-02-28",
  }, opId("ren-feb"));
  assert.equal(feb.cycleStart, "2026-02-28");
  const mar = await run(db, owner, "renewRentalCycle", {
    rentalId: rental.rentalId, asOfDate: "2026-03-31",
  }, opId("ren-mar"));
  assert.equal(mar.cycleStart, "2026-03-31");
});

test("12 undeposited holding persists across renew / month open", async () => {
  const { db, owner, building, yahia } = await setup();
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 300000, collectionDate: "2026-09-05",
  }, opId("hold-pay"));
  const before = sharedHoldingFils({ receipts: db.dump("receipts"), deposits: db.dump("deposits") });
  await run(db, owner, "renewRentalCycle", {
    rentalId: building.rental.rentalId, asOfDate: "2026-10-01",
  }, opId("hold-ren"));
  await run(db, owner, "generateObligations", { period: "2026-10" }, opId("hold-gen"));
  const after = sharedHoldingFils({ receipts: db.dump("receipts"), deposits: db.dump("deposits") });
  assert.equal(after, before);
  assert.equal(after, 300000);
});

test("4 refresh-shaped: rebuild dashboard after renew keeps one Oct cycle", async () => {
  const { db, owner, building } = await setup();
  await run(db, owner, "renewRentalCycle", {
    rentalId: building.rental.rentalId, asOfDate: "2026-10-01",
  }, opId("ref-ren"));
  const d1 = buildDashboardFromDump(db, "2026-10", "2026-10-01");
  const d2 = buildDashboardFromDump(db, "2026-10", "2026-10-01");
  assert.equal(d1.summary.views.filter((v) => v.rentalId === building.rental.rentalId).length, 1);
  assert.equal(d2.summary.views.filter((v) => v.rentalId === building.rental.rentalId).length, 1);
  assert.equal(d1.summary.targetFils, d2.summary.targetFils);
});

test("13 renew cycle status starts unpaid not collected", async () => {
  const { db, owner, building, yahia } = await setup();
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 920000, collectionDate: "2026-09-01",
  });
  const ren = await run(db, owner, "renewRentalCycle", {
    rentalId: building.rental.rentalId, asOfDate: "2026-10-01",
  }, opId("ren-status"));
  const dash = buildDashboardFromDump(db, "2026-10", "2026-10-01");
  const v = dash.summary.views.find((x) => x.obligationId === ren.obligationId);
  assert.equal(v.paidFils, 0);
  assert.notEqual(v.status, "collected");
});

test("14 generateObligations seeds next month unpaid cycle for continuing rental", async () => {
  const { db, owner, building } = await setup();
  const genOct = await run(db, owner, "generateObligations", { period: "2026-10" }, opId("gen-oct"));
  assert.equal(genOct.created, 1);
  const octObs = db.dump("obligations").filter((o) => o.period === "2026-10" && o.rentalId === building.rental.rentalId && o.state === "active");
  assert.equal(octObs.length, 1);
  assert.equal(octObs[0].dueDate, "2026-10-01");
  assert.equal(octObs[0].amountFils, 920000);
  // Idempotent — second generate creates nothing.
  const again = await run(db, owner, "generateObligations", { period: "2026-10" }, opId("gen-oct-2"));
  assert.equal(again.created, 0);
  assert.equal(db.dump("obligations").filter((o) => o.period === "2026-10" && o.rentalId === building.rental.rentalId && o.state === "active").length, 1);
});

test("15 Sep paid does not pay Oct; Oct before due is غير مستحق; Sep↔Oct round-trip", async () => {
  const { db, owner, building, yahia } = await setup();
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 920000, collectionDate: "2026-09-01",
  });
  let sep = buildDashboardFromDump(db, "2026-09", "2026-09-15");
  assert.equal(sep.obligations[0].status, "collected");
  assert.equal(sep.obligations[0].paidFils, 920000);
  assert.equal(sep.summary.collectedFils, 920000);
  const sepObId = sep.obligations[0].obligationId;
  const sepPaid = sep.obligations[0].paidFils;

  await run(db, owner, "generateObligations", { period: "2026-10" }, opId("gen-oct-pay"));
  // Before Oct due date → not_due (غير مستحق)
  let oct = buildDashboardFromDump(db, "2026-10", "2026-09-15");
  const octOb = oct.obligations.find((o) => o.rentalId === building.rental.rentalId) || oct.obligations[0];
  assert.ok(octOb);
  assert.notEqual(octOb.obligationId, sepObId);
  assert.equal(octOb.dueDate, "2026-10-01");
  assert.equal(octOb.paidFils, 0);
  assert.equal(octOb.status, "not_due");
  assert.equal(oct.summary.collectedFils, 0);

  // On/after Oct due with no payment → late
  oct = buildDashboardFromDump(db, "2026-10", "2026-10-01");
  const octLate = oct.obligations.find((o) => o.obligationId === octOb.obligationId);
  assert.equal(octLate.paidFils, 0);
  assert.equal(octLate.status, "late");

  // Round-trip: September unchanged
  sep = buildDashboardFromDump(db, "2026-09", "2026-09-15");
  assert.equal(sep.obligations[0].obligationId, sepObId);
  assert.equal(sep.obligations[0].paidFils, sepPaid);
  assert.equal(sep.obligations[0].status, "collected");
  assert.equal(sep.summary.collectedFils, 920000);

  // Reload Oct still Oct
  oct = buildDashboardFromDump(db, "2026-10", "2026-10-15");
  assert.equal(oct.obligations.find((o) => o.obligationId === octOb.obligationId).paidFils, 0);
  assert.equal(oct.summary.collectedFils, 0);
});
