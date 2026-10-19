/**
 * Manual monthly renewal. Opening a later month must not create the next obligation.
 * Renewal creates one obligation, no receipt, and does not touch a closed month.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshDb, run, bootstrapOwner, createUser, actorFrom, opId } from "../helpers/commands.mjs";
import { buildDashboardFromDump } from "../../functions/services/readModel.mjs";
import { sharedHoldingFils } from "../../functions/domain/finance.mjs";
import { reviewPeriodClose } from "../../functions/domain/closing_review.mjs";
import { nextCycleStart, cycleEndInclusive } from "../../functions/domain/rental_cycle.mjs";

async function contract(db, owner, { start = "2026-10-10", rent = 300000, tenant = "مستأجر" } = {}) {
  const prop = await run(db, owner, "createProperty", { name: "قمة", address: "دبي" }, opId("prop"));
  const unit = await run(db, owner, "createUnit", { propertyId: prop.propertyId, name: "شقة 10", kind: "whole" }, opId("unit"));
  const space = await run(db, owner, "createSpace", { unitId: unit.unitId, name: "شقة 10" }, opId("space"));
  const rental = await run(db, owner, "createRental", {
    spaceId: space.spaceId, tenantName: tenant, contractualAmountFils: rent,
    dueDayOfMonth: Number(start.slice(8, 10)), startDate: start,
  }, opId("rent"));
  await run(db, owner, "generateObligations", { period: start.slice(0, 7) }, opId("gen-first"));
  const account = await run(db, owner, "createAccount", { name: "بنك", kind: "bank" }, opId("bank"));
  const first = db.dump("obligations").find((o) => o.rentalId === rental.rentalId && o.state === "active");
  return { space, rental, account, first };
}

test("A-C new October 10 contract does not raise November until Yahya renews once", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const row = await contract(db, owner);
  assert.equal(row.first.cycleStart, "2026-10-10");
  assert.equal(row.first.cycleEnd, "2026-11-09");
  assert.equal(row.first.dueDate, "2026-10-10");
  assert.equal(row.first.amountFils, 300000);
  assert.equal(row.first.renewalStatus, "initial");
  assert.equal(db.dump("rentals").find((r) => r.id === row.rental.rentalId).startDate, "2026-10-10");

  const opened = await run(db, owner, "generateObligations", { period: "2026-11" }, opId("open-nov"));
  assert.equal(opened.created, 0);
  let nov = buildDashboardFromDump(db, "2026-11", "2026-11-10");
  assert.equal(nov.summary.obligationTargetFils || nov.summary.targetFils || 0, 0);

  const beforeCollected = nov.summary.collectedFils;
  const beforeHolding = sharedHoldingFils({ receipts: db.dump("receipts"), deposits: db.dump("deposits") });
  const renewed = await run(db, actorFrom(yahia), "renewRentalCycle", {
    rentalId: row.rental.rentalId, asOfDate: "2026-11-10",
  }, opId("yahya-renew"));
  assert.equal(renewed.alreadyApplied, false);
  assert.equal(renewed.cycleStart, "2026-11-10");
  assert.equal(renewed.cycleEnd, "2026-12-09");
  assert.equal(renewed.amountFils, 300000);
  const created = db.dump("obligations").find((o) => o.id === renewed.obligationId);
  assert.equal(created.period, "2026-11");
  assert.equal(created.renewalStatus, "confirmed");
  assert.equal(created.renewedBy, yahia.userId);
  assert.equal(db.dump("receipts").filter((r) => r.obligationId === created.id).length, 0);
  assert.equal(db.dump("rentals").find((r) => r.id === row.rental.rentalId).startDate, "2026-10-10");
  nov = buildDashboardFromDump(db, "2026-11", "2026-11-10");
  assert.equal(nov.summary.collectedFils, beforeCollected);
  assert.equal(sharedHoldingFils({ receipts: db.dump("receipts"), deposits: db.dump("deposits") }), beforeHolding);
  const target = nov.obligations.filter((o) => o.period === "2026-11").reduce((s, o) => s + o.dueFils, 0);
  assert.equal(target, 300000);

  const audit = db.dump("auditEvents").find((e) => e.action === "rental_cycle_renewed");
  assert.equal(audit.actorUserId, yahia.userId);
  assert.equal(audit.rentalId, row.rental.rentalId);
  assert.equal(audit.previousCycleStart, "2026-10-10");
  assert.equal(audit.cycleStart, "2026-11-10");
  assert.equal(audit.amountFils, 300000);
  assert.ok(audit.operationId);
});

test("D repeated renewal does not duplicate", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const row = await contract(db, owner);
  const op = opId("once");
  await run(db, actorFrom(yahia), "renewRentalCycle", {
    rentalId: row.rental.rentalId, asOfDate: "2026-11-10",
  }, op);
  const again = await run(db, actorFrom(yahia), "renewRentalCycle", {
    rentalId: row.rental.rentalId, asOfDate: "2026-11-10",
  }, op);
  assert.equal(again.replay === true || again.alreadyApplied === true, true);
  await assert.rejects(
    () => run(db, actorFrom(yahia), "renewRentalCycle", {
      rentalId: row.rental.rentalId, asOfDate: "2026-11-10",
    }, opId("twice")),
    (err) => err && err.code === "CYCLE_NOT_DUE_YET",
  );
  const cycles = db.dump("obligations").filter((o) => o.rentalId === row.rental.rentalId && o.state === "active");
  assert.equal(cycles.length, 2);
});

test("F-H renewal then cash, deposit, and partial do not double count", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const row = await contract(db, owner);
  const renewed = await run(db, actorFrom(yahia), "renewRentalCycle", {
    rentalId: row.rental.rentalId, asOfDate: "2026-11-10",
  }, opId("renew"));
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: renewed.obligationId, amountFils: 100000, collectionDate: "2026-11-10",
  }, opId("partial"));
  let holding = sharedHoldingFils({ receipts: db.dump("receipts"), deposits: db.dump("deposits"), period: "2026-11" });
  assert.equal(holding, 100000);
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: renewed.obligationId, amountFils: 200000, collectionDate: "2026-11-11",
  }, opId("rest"));
  const live = db.dump("receipts").filter((r) => r.obligationId === renewed.obligationId && r.state === "recognized");
  assert.equal(live.reduce((s, r) => s + r.amountFils, 0), 300000);
  holding = sharedHoldingFils({ receipts: db.dump("receipts"), deposits: db.dump("deposits"), period: "2026-11" });
  assert.equal(holding, 300000);
  const dep = await run(db, actorFrom(yahia), "submitDeposit", {
    amountFils: 300000, depositDate: "2026-11-12", destinationAccountId: row.account.accountId,
    sourceKind: "holding", sourcePeriod: "2026-11", period: "2026-11",
  }, opId("dep"));
  await run(db, owner, "approveDeposit", { depositId: dep.depositId }, opId("appr"));
  holding = sharedHoldingFils({ receipts: db.dump("receipts"), deposits: db.dump("deposits"), period: "2026-11" });
  assert.equal(holding, 0);
  const dash = buildDashboardFromDump(db, "2026-11", "2026-11-12");
  assert.equal(dash.summary.collectedFils, 300000);
  assert.equal(dash.summary.depositedFils, 300000);
});

test("I leaving without renewal creates no next obligation", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const row = await contract(db, owner);
  await run(db, owner, "endTenancy", {
    rentalId: row.rental.rentalId, endDate: "2026-11-09", reason: "مغادرة", arrearsDecision: "retain",
  }, opId("leave"));
  const gen = await run(db, owner, "generateObligations", { period: "2026-11" }, opId("no-renew"));
  assert.equal(gen.created, 0);
  await assert.rejects(
    () => run(db, owner, "renewRentalCycle", { rentalId: row.rental.rentalId, asOfDate: "2026-11-10" }, opId("after-leave")),
    (err) => err && (err.code === "RENTAL_NOT_ACTIVE" || err.code === "SPACE_NOT_RENTED"),
  );
});

test("J an existing future obligation is not duplicated or deleted", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const row = await contract(db, owner);
  const first = await run(db, owner, "renewRentalCycle", {
    rentalId: row.rental.rentalId, asOfDate: "2026-11-10",
  }, opId("existing"));
  const before = db.dump("obligations").map((o) => ({ id: o.id, amountFils: o.amountFils, state: o.state }));
  const gen = await run(db, owner, "generateObligations", { period: "2026-11" }, opId("gen-existing"));
  assert.equal(gen.created, 0);
  await assert.rejects(
    () => run(db, owner, "renewRentalCycle", {
      rentalId: row.rental.rentalId, asOfDate: "2026-11-10",
    }, opId("again")),
    (err) => err && err.code === "CYCLE_NOT_DUE_YET",
  );
  assert.deepEqual(
    db.dump("obligations").map((o) => ({ id: o.id, amountFils: o.amountFils, state: o.state })),
    before,
  );
  assert.equal(db.dump("obligations").find((o) => o.id === first.obligationId).state, "active");
});

test("K-L closed September and a 9000 rent are not rewritten by renewal", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const row = await contract(db, owner, { start: "2026-09-06", rent: 900000, tenant: "شوكت" });
  await run(db, owner, "createCashReceipt", {
    obligationId: row.first.id, amountFils: 900000, collectionDate: "2026-09-06",
  }, opId("sep-cash"));
  await run(db, owner, "closeAccountingPeriod", { period: "2026-09" }, opId("close"));
  await run(db, owner, "renewRentalCycle", {
    rentalId: row.rental.rentalId, asOfDate: "2026-10-06",
  }, opId("oct-renew"));
  const sep = db.dump("obligations").find((o) => o.id === row.first.id);
  assert.equal(sep.amountFils, 900000);
  assert.equal(sep.dueDate, "2026-09-06");
  assert.equal(db.dump("receipts").find((r) => r.obligationId === sep.id).amountFils, 900000);
  assert.match(db.dump("uiConfig").find((c) => c.id === "close-state:2026-09").json, /"status":"closed"/);
  await assert.rejects(
    () => run(db, owner, "createCashReceipt", {
      obligationId: sep.id, amountFils: 100, collectionDate: "2026-09-08",
    }, opId("blocked")),
    (err) => err && err.code === "MONTH_CLOSED",
  );
});

test("N a role that is not staff or owner cannot renew", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const row = await contract(db, owner);
  await assert.rejects(
    () => run(db, { userId: "stranger", role: "viewer", active: true }, "renewRentalCycle", {
      rentalId: row.rental.rentalId, asOfDate: "2026-11-10",
    }, opId("nope")),
    (err) => err && err.code === "FORBIDDEN",
  );
});

test("existing November obligation is confirmed in place and October generation stays automatic", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const row = await contract(db, owner, { start: "2026-09-06", rent: 900000, tenant: "شوكت" });
  const oct = await run(db, owner, "generateObligations", { period: "2026-10" }, opId("oct-auto"));
  assert.equal(oct.created, 1);
  const novGen = await run(db, owner, "generateObligations", { period: "2026-11" }, opId("nov-auto"));
  assert.equal(novGen.created, 0);
  const rental = db.dump("rentals").find((r) => r.id === row.rental.rentalId);
  const novId = `${rental.id}_2026-11-06`;
  db.seed("obligations", novId, {
    id: novId, rentalCycleId: novId, rentalId: rental.id, spaceId: rental.spaceId,
    propertyId: rental.propertyId, unitId: rental.unitId, period: "2026-11",
    amountFils: 900000, dueDate: "2026-11-06", cycleStart: "2026-11-06", cycleEnd: "2026-12-05",
    previousCycleId: row.first.id, state: "active", tenantNameSnapshot: "شوكت",
  });
  const beforeDash = buildDashboardFromDump(db, "2026-11", "2026-11-16");
  const beforeTarget = beforeDash.summary.targetFils;
  assert.equal(beforeTarget, 0);
  assert.equal(beforeDash.summary.obligationTargetFils, 0);
  assert.equal(beforeDash.summary.arrearsFils, 0);
  assert.equal(beforeDash.summary.collectedFils, 0);
  const beforeCard = beforeDash.unitsTree.flatMap((u) => u.spaces).find((s) => s.spaceId === row.space.spaceId);
  assert.equal(beforeCard.paidFils, 0);
  assert.equal(beforeCard.dueFils, 0);
  assert.equal(beforeCard.remainingFils, 0);
  assert.equal(beforeCard.status, "renewal_required");
  assert.equal(beforeCard.obligationId, null);
  assert.equal(buildDashboardFromDump(db, "2026-10", "2026-11-16").summary.targetFils, 900000);
  assert.equal(buildDashboardFromDump(db, "2026-09", "2026-11-16").summary.targetFils, 900000);
  const beforeClose = reviewPeriodClose({
    period: "2026-11", obligations: db.dump("obligations"), rentals: db.dump("rentals"),
    receipts: db.dump("receipts"), deposits: db.dump("deposits"),
  });
  assert.equal(beforeClose.totals.dueFils, 0);
  assert.equal(beforeClose.notes.filter((n) => n.code === "ARREARS").length, 0);
  const ack = await run(db, actorFrom(yahia), "renewRentalCycle", {
    rentalId: rental.id, acknowledgeCycleStart: "2026-11-06", asOfDate: "2026-11-16",
  }, opId("ack-nov"));
  assert.equal(ack.acknowledgedExisting, true);
  assert.equal(ack.financialUnchanged, true);
  assert.equal(ack.amountFils, 900000);
  const novs = db.dump("obligations").filter((o) => o.rentalId === rental.id && o.period === "2026-11" && o.state === "active");
  assert.equal(novs.length, 1);
  assert.equal(novs[0].amountFils, 900000);
  assert.equal(novs[0].renewalStatus, "acknowledged_existing");
  assert.equal(novs[0].renewedBy, yahia.userId);
  assert.equal(db.dump("receipts").filter((r) => r.obligationId === novId).length, 0);
  const afterOne = buildDashboardFromDump(db, "2026-11", "2026-11-16");
  assert.equal(afterOne.summary.targetFils, 900000);
  assert.equal(afterOne.summary.obligationTargetFils, 900000);
  assert.equal(afterOne.summary.remainingFils, 900000);
  assert.equal(afterOne.summary.arrearsFils, 900000);
  assert.equal(afterOne.summary.collectedFils, 0);
  assert.equal(buildDashboardFromDump(db, "2026-10", "2026-11-16").summary.targetFils, 900000);
  assert.equal(buildDashboardFromDump(db, "2026-09", "2026-11-16").summary.targetFils, 900000);
  const again = await run(db, actorFrom(yahia), "renewRentalCycle", {
    rentalId: rental.id, acknowledgeCycleStart: "2026-11-06", asOfDate: "2026-11-16",
  }, opId("ack-nov-2"));
  assert.equal(again.alreadyApplied, true);
  assert.equal(db.dump("obligations").filter((o) => o.id === novId).length, 1);
  assert.equal(buildDashboardFromDump(db, "2026-11", "2026-11-16").summary.targetFils, 900000);
  const octRow = db.dump("obligations").find((o) => o.rentalId === rental.id && o.period === "2026-10");
  const octAck = await run(db, owner, "renewRentalCycle", {
    rentalId: rental.id, acknowledgeCycleStart: octRow.cycleStart, asOfDate: "2026-10-20",
  }, opId("ack-oct"));
  assert.equal(octAck.financialUnchanged, true);
  assert.equal(db.dump("obligations").find((o) => o.id === octRow.id).renewalStatus, "initial");
  assert.equal(db.dump("obligations").find((o) => o.id === row.first.id).amountFils, 900000);
});

test("November rental target starts at zero and rises once per confirmation", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const other = await createUser(db, owner, { displayName: "موظف", role: "employee", pin: "2200" });
  const shawkat = await contract(db, owner, { start: "2026-09-06", rent: 900000, tenant: "شوكت" });
  await run(db, owner, "generateObligations", { period: "2026-10" }, opId("oct"));
  const rental = db.dump("rentals").find((r) => r.id === shawkat.rental.rentalId);
  const novId = `${rental.id}_2026-11-06`;
  db.seed("obligations", novId, {
    id: novId, rentalCycleId: novId, rentalId: rental.id, spaceId: rental.spaceId,
    propertyId: rental.propertyId, unitId: rental.unitId, period: "2026-11",
    amountFils: 900000, dueDate: "2026-11-06", cycleStart: "2026-11-06", cycleEnd: "2026-12-05",
    previousCycleId: shawkat.first.id, state: "active", tenantNameSnapshot: "شوكت",
  });
  const small = await contract(db, owner, { start: "2026-10-01", rent: 150000, tenant: "مستأجر صغير" });
  const smallRental = db.dump("rentals").find((r) => r.id === small.rental.rentalId);
  const storedBefore = db.dump("obligations").map((o) => o.id).sort();
  const open = buildDashboardFromDump(db, "2026-11", "2026-11-16");
  assert.equal(open.summary.obligationTargetFils, 0);
  assert.equal(open.summary.arrearsFils, 0);

  db.seed("uiPeriods", "period:2026-11", {
    id: "period:2026-11", period: "2026-11",
    extras: { dailyBookings: [{ id: "day-1", total: 200, status: "saved" }] },
  });
  const withDaily = buildDashboardFromDump(db, "2026-11", "2026-11-16");
  assert.equal(withDaily.summary.obligationTargetFils, 0);
  assert.equal(withDaily.summary.targetFils, 20000);

  await run(db, actorFrom(yahia), "renewRentalCycle", {
    rentalId: rental.id, acknowledgeCycleStart: "2026-11-06", asOfDate: "2026-11-16",
  }, opId("shawkat"));
  const one = buildDashboardFromDump(db, "2026-11", "2026-11-16");
  assert.equal(one.summary.obligationTargetFils, 900000);
  assert.equal(one.summary.targetFils, 920000);
  assert.equal(db.dump("obligations").filter((o) => o.id === novId).length, 1);
  assert.equal(db.dump("receipts").filter((r) => r.obligationId === novId).length, 0);

  const smallOp = opId("small");
  const created = await run(db, actorFrom(other), "renewRentalCycle", {
    rentalId: smallRental.id, asOfDate: "2026-11-01",
  }, smallOp);
  assert.equal(created.amountFils, 150000);
  assert.equal(created.alreadyApplied, false);
  const two = buildDashboardFromDump(db, "2026-11", "2026-11-16");
  assert.equal(two.summary.obligationTargetFils, 1050000);
  assert.equal(two.summary.targetFils, 1070000);
  const replay = await run(db, actorFrom(other), "renewRentalCycle", {
    rentalId: smallRental.id, asOfDate: "2026-11-01",
  }, smallOp);
  assert.equal(replay.replay === true || replay.alreadyApplied === true, true);
  assert.equal(buildDashboardFromDump(db, "2026-11", "2026-11-16").summary.obligationTargetFils, 1050000);
  assert.equal(db.dump("obligations").filter((o) => o.rentalId === smallRental.id && o.period === "2026-11" && o.state === "active").length, 1);

  const decId = `${rental.id}_2026-12-06`;
  db.seed("obligations", decId, {
    id: decId, rentalCycleId: decId, rentalId: rental.id, spaceId: rental.spaceId,
    propertyId: rental.propertyId, unitId: rental.unitId, period: "2026-12",
    amountFils: 900000, dueDate: "2026-12-06", cycleStart: "2026-12-06", cycleEnd: "2027-01-05",
    previousCycleId: novId, state: "active", tenantNameSnapshot: "شوكت",
  });
  assert.equal(buildDashboardFromDump(db, "2026-12", "2026-12-06").summary.obligationTargetFils, 0);
  await run(db, actorFrom(yahia), "renewRentalCycle", {
    rentalId: rental.id, acknowledgeCycleStart: "2026-12-06", asOfDate: "2026-12-06",
  }, opId("dec"));
  assert.equal(buildDashboardFromDump(db, "2026-12", "2026-12-06").summary.obligationTargetFils, 900000);
  assert.equal(db.dump("obligations").some((o) => o.id === decId), true);

  const stillThere = storedBefore.every((id) => db.dump("obligations").some((o) => o.id === id));
  assert.equal(stillThere, true);
  assert.equal(buildDashboardFromDump(db, "2026-10", "2026-11-16").summary.targetFils, 900000 + 150000);
  assert.equal(buildDashboardFromDump(db, "2026-09", "2026-11-16").summary.targetFils, 900000);
});

test("an unconfirmed November obligation cannot be collected or deposited", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const row = await contract(db, owner, { start: "2026-09-06", rent: 900000, tenant: "شوكت" });
  const rental = db.dump("rentals").find((r) => r.id === row.rental.rentalId);
  const novId = `${rental.id}_2026-11-06`;
  db.seed("obligations", novId, {
    id: novId, rentalCycleId: novId, rentalId: rental.id, spaceId: rental.spaceId,
    propertyId: rental.propertyId, unitId: rental.unitId, period: "2026-11",
    amountFils: 900000, dueDate: "2026-11-06", cycleStart: "2026-11-06", cycleEnd: "2026-12-05",
    previousCycleId: row.first.id, state: "active", tenantNameSnapshot: "شوكت",
  });
  const beforeReceipts = db.dump("receipts").length;
  const beforeDeposits = db.dump("deposits").length;
  const beforeHolding = sharedHoldingFils({ receipts: db.dump("receipts"), deposits: db.dump("deposits") });
  await assert.rejects(
    () => run(db, actorFrom(yahia), "createCashReceipt", {
      obligationId: novId, amountFils: 900000, collectionDate: "2026-11-06",
    }, opId("blocked-cash")),
    (err) => err && err.code === "RENEWAL_NOT_CONFIRMED",
  );
  await assert.rejects(
    () => run(db, owner, "submitBankReceipt", {
      obligationId: novId, amountFils: 900000, collectionDate: "2026-11-06",
      bankReference: "تحويل-اختبار",
    }, opId("blocked-bank")),
    (err) => err && err.code === "RENEWAL_NOT_CONFIRMED",
  );
  assert.equal(db.dump("receipts").length, beforeReceipts);
  assert.equal(db.dump("deposits").length, beforeDeposits);
  assert.equal(sharedHoldingFils({ receipts: db.dump("receipts"), deposits: db.dump("deposits") }), beforeHolding);
  assert.equal(buildDashboardFromDump(db, "2026-11", "2026-11-16").summary.obligationTargetFils, 0);
  assert.equal(db.dump("obligations").find((o) => o.id === novId).state, "active");
  assert.equal(db.dump("rentals").find((r) => r.id === rental.id).startDate, "2026-09-06");

  await run(db, actorFrom(yahia), "renewRentalCycle", {
    rentalId: rental.id, acknowledgeCycleStart: "2026-11-06", asOfDate: "2026-11-16",
  }, opId("then-confirm"));
  const cash = await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: novId, amountFils: 900000, collectionDate: "2026-11-16",
  }, opId("after-confirm"));
  assert.equal(db.dump("receipts").filter((r) => r.id === cash.receiptId && r.state === "recognized").length, 1);
  assert.equal(db.dump("deposits").length, beforeDeposits);
  const paid = buildDashboardFromDump(db, "2026-11", "2026-11-16");
  assert.equal(paid.summary.obligationTargetFils, 900000);
  assert.equal(paid.summary.collectedFils, 900000);
  assert.equal(paid.summary.remainingFils, 0);
  assert.equal(paid.summary.arrearsFils, 0);
  const again = await run(db, actorFrom(yahia), "renewRentalCycle", {
    rentalId: rental.id, acknowledgeCycleStart: "2026-11-06", asOfDate: "2026-11-16",
  }, opId("confirm-after-pay"));
  assert.equal(again.alreadyApplied, true);
  assert.equal(buildDashboardFromDump(db, "2026-11", "2026-11-16").summary.obligationTargetFils, 900000);
  assert.equal(db.dump("obligations").filter((o) => o.rentalId === rental.id && o.period === "2026-11").length, 1);
});

test("a recognized November payment stays in the target even before confirmation", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const row = await contract(db, owner, { start: "2026-09-06", rent: 900000, tenant: "شوكت" });
  const rental = db.dump("rentals").find((r) => r.id === row.rental.rentalId);
  const novId = `${rental.id}_2026-11-06`;
  db.seed("obligations", novId, {
    id: novId, rentalCycleId: novId, rentalId: rental.id, spaceId: rental.spaceId,
    propertyId: rental.propertyId, unitId: rental.unitId, period: "2026-11",
    amountFils: 900000, dueDate: "2026-11-06", cycleStart: "2026-11-06", cycleEnd: "2026-12-05",
    previousCycleId: row.first.id, state: "active", tenantNameSnapshot: "شوكت",
  });
  db.seed("receipts", "rcpt-nov-paid", {
    id: "rcpt-nov-paid", obligationId: novId, rentalId: rental.id, period: "2026-11",
    amountFils: 900000, method: "cash", state: "recognized", collectionDate: "2026-11-06",
    collectorUserId: owner.userId,
  });
  const dash = buildDashboardFromDump(db, "2026-11", "2026-11-16");
  assert.equal(dash.summary.obligationTargetFils, 900000);
  assert.equal(dash.summary.collectedFils, 900000);
  assert.equal(dash.summary.remainingFils, 0);
  assert.equal(dash.summary.arrearsFils, 0);
  assert.equal(db.dump("obligations").find((o) => o.id === novId).renewalStatus, undefined);
  assert.equal(db.dump("receipts").find((r) => r.id === "rcpt-nov-paid").amountFils, 900000);
});

test("a blocked November collection returns to pending and collects once after confirmation", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const row = await contract(db, owner, { start: "2026-09-06", rent: 900000, tenant: "شوكت" });
  await run(db, owner, "generateObligations", { period: "2026-10" }, opId("oct-for-request"));
  const rental = db.dump("rentals").find((r) => r.id === row.rental.rentalId);
  const novId = `${rental.id}_2026-11-06`;
  db.seed("obligations", novId, {
    id: novId, rentalCycleId: novId, rentalId: rental.id, spaceId: rental.spaceId,
    propertyId: rental.propertyId, unitId: rental.unitId, period: "2026-11",
    amountFils: 900000, dueDate: "2026-11-06", cycleStart: "2026-11-06", cycleEnd: "2026-12-05",
    previousCycleId: row.first.id, state: "active", tenantNameSnapshot: "شوكت",
  });
  const sepBefore = buildDashboardFromDump(db, "2026-09", "2026-11-16").summary;
  const octBefore = buildDashboardFromDump(db, "2026-10", "2026-11-16").summary;
  assert.equal(buildDashboardFromDump(db, "2026-11", "2026-11-16").summary.obligationTargetFils, 0);
  const beforeReceipts = db.dump("receipts").length;
  const beforeDeposits = db.dump("deposits").length;
  const beforeHolding = sharedHoldingFils({ receipts: db.dump("receipts"), deposits: db.dump("deposits") });

  const requestId = "req_nov_blocked";
  await run(db, actorFrom(yahia), "submitWorkRequest", {
    requestId,
    type: "update_full",
    desc: "تحصيل نوفمبر شوكت",
    payloadJson: JSON.stringify({
      fields: {
        status: "collected", rent: 9000, paid_amount: 9000, partial: false,
        collectionMethod: "cash", start_date: "2026-09-06", tenant: "شوكت",
        _spaceId: row.space.spaceId, _obligationId: novId,
      },
    }),
    month: 10, year: 2026,
  }, opId("submit-blocked"));

  const rentBeforeApproval = db.dump("rentals").find((r) => r.id === rental.id).contractualAmountFils;
  await assert.rejects(
    () => run(db, owner, "commitWorkRequest", { requestId }, "commit-blocked-1"),
    (err) => err && err.code === "RENEWAL_REQUIRED"
      && err.details.message === "يجب تجديد عقد الإيجار للشهر المحدد\nقبل اعتماد التحصيل.",
  );
  const blocked = db.dump("uiRequests").find((r) => r.id === requestId);
  assert.equal(blocked.status, "pending");
  assert.equal(blocked.lastError || null, null);
  assert.equal(db.dump("rentals").find((r) => r.id === rental.id).contractualAmountFils, rentBeforeApproval);
  assert.equal(
    db.dump("operations").some((op) => String(op.operationId || "").startsWith(`cwr-${requestId}-`)),
    false,
  );
  assert.equal(
    db.dump("operations").some((op) => op.command === "createCashReceipt" && String(op.operationId || "").startsWith(`cwr-${requestId}-`)),
    false,
  );
  assert.equal(db.dump("receipts").length, beforeReceipts);
  assert.equal(db.dump("deposits").length, beforeDeposits);
  assert.equal(sharedHoldingFils({ receipts: db.dump("receipts"), deposits: db.dump("deposits") }), beforeHolding);
  assert.equal(buildDashboardFromDump(db, "2026-11", "2026-11-16").summary.obligationTargetFils, 0);
  assert.equal(db.dump("obligations").find((o) => o.id === novId).state, "active");

  await run(db, actorFrom(yahia), "renewRentalCycle", {
    rentalId: rental.id, acknowledgeCycleStart: "2026-11-06", asOfDate: "2026-11-16",
  }, opId("confirm-then-retry"));
  assert.equal(buildDashboardFromDump(db, "2026-11", "2026-11-16").summary.obligationTargetFils, 900000);

  const committed = await run(db, owner, "commitWorkRequest", { requestId }, "commit-blocked-2");
  assert.equal(committed.status, "approved");
  const receipts = db.dump("receipts").filter((r) => r.obligationId === novId && r.state === "recognized");
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].amountFils, 900000);
  assert.equal(db.dump("deposits").length, beforeDeposits);
  const paid = buildDashboardFromDump(db, "2026-11", "2026-11-16");
  assert.equal(paid.summary.obligationTargetFils, 900000);
  assert.equal(paid.summary.collectedFils, 900000);
  assert.equal(paid.summary.remainingFils, 0);
  const replay = await run(db, owner, "commitWorkRequest", { requestId }, "commit-blocked-3");
  assert.equal(replay.alreadyApplied, true);
  assert.equal(db.dump("receipts").filter((r) => r.obligationId === novId && r.state === "recognized").length, 1);

  const sepAfter = buildDashboardFromDump(db, "2026-09", "2026-11-16").summary;
  const octAfter = buildDashboardFromDump(db, "2026-10", "2026-11-16").summary;
  assert.equal(sepAfter.targetFils, sepBefore.targetFils);
  assert.equal(sepAfter.collectedFils, sepBefore.collectedFils);
  assert.equal(sepAfter.obligationTargetFils, sepBefore.obligationTargetFils);
  assert.equal(octAfter.targetFils, octBefore.targetFils);
  assert.equal(octAfter.collectedFils, octBefore.collectedFils);
  assert.equal(octAfter.obligationTargetFils, octBefore.obligationTargetFils);
  assert.equal(db.dump("rentals").find((r) => r.id === rental.id).startDate, "2026-09-06");
});

test("P calendar months and leap day, not a fixed 30 days", () => {
  assert.equal(nextCycleStart("2026-10-10", 1, 10), "2026-11-10");
  assert.equal(cycleEndInclusive("2026-10-10", 10), "2026-11-09");
  assert.equal(nextCycleStart("2026-11-10", 1, 10), "2026-12-10");
  assert.equal(cycleEndInclusive("2026-11-10", 10), "2026-12-09");
  assert.equal(nextCycleStart("2026-12-10", 1, 10), "2027-01-10");
  assert.equal(nextCycleStart("2028-01-31", 1, 31), "2028-02-29");
  assert.equal(nextCycleStart("2028-02-29", 1, 31), "2028-03-31");
  assert.equal(nextCycleStart("2026-01-31", 1, 31), "2026-02-28");
});
