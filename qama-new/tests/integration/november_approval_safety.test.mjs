/**
 * November collection approval must fail closed before any mutation.
 * Renewal is explicit. The same request stays retryable and collects once.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshDb, run, bootstrapOwner, createUser, actorFrom, opId } from "../helpers/commands.mjs";
import { buildDashboardFromDump } from "../../functions/services/readModel.mjs";
import { sharedHoldingFils } from "../../functions/domain/finance.mjs";
import { RENEWAL_REQUIRED_MESSAGE } from "../../functions/commands/commit_work_request.mjs";

const ARABIC = "يجب تجديد عقد الإيجار للشهر المحدد\nقبل اعتماد التحصيل.";

async function octoberContract(db, owner) {
  const prop = await run(db, owner, "createProperty", { name: "قمة", address: "دبي" }, opId("prop"));
  const unit = await run(db, owner, "createUnit", { propertyId: prop.propertyId, name: "شقة 4", kind: "whole" }, opId("unit"));
  const space = await run(db, owner, "createSpace", { unitId: unit.unitId, name: "شقة 4" }, opId("space"));
  const rental = await run(db, owner, "createRental", {
    spaceId: space.spaceId, tenantName: "مستأجر قائم", contractualAmountFils: 120000,
    dueDayOfMonth: 1, startDate: "2026-10-01",
  }, opId("rent"));
  await run(db, owner, "generateObligations", { period: "2026-10" }, opId("gen-oct"));
  await run(db, owner, "generateObligations", { period: "2026-09" }, opId("gen-sep"));
  const october = db.dump("obligations").find((row) => row.rentalId === rental.rentalId && row.period === "2026-10");
  return { space, unit, rental, october };
}

function collectionRequest({ requestId, unitId, spaceId, rentAed, paidAed, partial, month, start }) {
  return {
    requestId,
    type: "update_partition",
    desc: "تحصيل",
    payloadJson: JSON.stringify({
      unitId, partId: 1,
      fields: {
        status: partial ? "partial" : "collected",
        rent: rentAed,
        paid_amount: paidAed,
        partial: !!partial,
        collectionMethod: "cash",
        start_date: start,
        tenant: "مستأجر قائم",
        _spaceId: spaceId,
      },
    }),
    month, year: 2026,
  };
}

test("A-H November approval before renewal changes nothing and succeeds once after renewal", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const row = await octoberContract(db, owner);
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: row.october.id, amountFils: 50000, collectionDate: "2026-10-03",
  }, opId("oct-partial"));
  const sepBefore = buildDashboardFromDump(db, "2026-09", "2026-11-02").summary;
  const octBefore = buildDashboardFromDump(db, "2026-10", "2026-11-02").summary;
  const holdingBefore = sharedHoldingFils({ receipts: db.dump("receipts"), deposits: db.dump("deposits") });
  const rentalBefore = { ...db.dump("rentals").find((r) => r.id === row.rental.rentalId) };

  const requestId = "req_nov_before_renewal";
  await run(db, actorFrom(yahia), "submitWorkRequest", collectionRequest({
    requestId, unitId: row.unit.unitId, spaceId: row.space.spaceId,
    rentAed: 1500, paidAed: 1500, month: 10, start: "2026-10-01",
  }), opId("submit"));

  await assert.rejects(
    () => run(db, owner, "commitWorkRequest", { requestId }, "commit-before"),
    (err) => err.code === "RENEWAL_REQUIRED" && err.details.message === ARABIC && err.details.message === RENEWAL_REQUIRED_MESSAGE,
  );
  await assert.rejects(
    () => run(db, owner, "commitWorkRequest", { requestId }, "commit-retry"),
    (err) => err.code === "RENEWAL_REQUIRED",
  );

  const rentalAfterReject = db.dump("rentals").find((r) => r.id === row.rental.rentalId);
  assert.equal(rentalAfterReject.contractualAmountFils, rentalBefore.contractualAmountFils);
  assert.equal(rentalAfterReject.startDate, rentalBefore.startDate);
  assert.equal(rentalAfterReject.state, "active");
  assert.equal(rentalAfterReject.tenantName, rentalBefore.tenantName);
  const request = db.dump("uiRequests").find((r) => r.id === requestId);
  assert.equal(request.status, "pending");
  assert.equal(db.dump("obligations").some((o) => o.period === "2026-11"), false);
  assert.equal(db.dump("receipts").filter((r) => r.period === "2026-11").length, 0);
  assert.equal(db.dump("deposits").length, 0);
  assert.equal(sharedHoldingFils({ receipts: db.dump("receipts"), deposits: db.dump("deposits") }), holdingBefore);
  assert.equal(db.dump("operations").some((op) => String(op.operationId || "").startsWith(`cwr-${requestId}-`)), false);
  const october = db.dump("obligations").find((o) => o.id === row.october.id);
  assert.equal(october.amountFils, 120000);
  assert.equal(october.state, "active");

  const renewed = await run(db, actorFrom(yahia), "renewRentalCycle", {
    rentalId: row.rental.rentalId, asOfDate: "2026-11-01",
  }, opId("renew"));
  assert.equal(db.dump("receipts").filter((r) => r.obligationId === renewed.obligationId).length, 0);
  const approved = await run(db, owner, "commitWorkRequest", { requestId }, "commit-after");
  assert.equal(approved.status, "approved");
  const november = db.dump("obligations").filter((o) => o.rentalId === row.rental.rentalId && o.period === "2026-11" && o.state === "active");
  assert.equal(november.length, 1);
  assert.equal(november[0].id, renewed.obligationId);
  const receipts = db.dump("receipts").filter((r) => r.obligationId === renewed.obligationId && r.state === "recognized");
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].amountFils, 150000);
  const replay = await run(db, owner, "commitWorkRequest", { requestId }, "commit-replay");
  assert.equal(replay.alreadyApplied, true);
  assert.equal(db.dump("receipts").filter((r) => r.obligationId === renewed.obligationId && r.state === "recognized").length, 1);
  assert.equal(db.dump("obligations").filter((o) => o.rentalId === row.rental.rentalId && o.period === "2026-11" && o.state === "active").length, 1);

  const novDash = buildDashboardFromDump(db, "2026-11", "2026-11-02");
  assert.equal(novDash.summary.collectedFils, 150000);
  assert.equal(novDash.summary.obligationTargetFils, 150000);
  const sepAfter = buildDashboardFromDump(db, "2026-09", "2026-11-02").summary;
  const octAfter = buildDashboardFromDump(db, "2026-10", "2026-11-02").summary;
  assert.equal(sepAfter.targetFils, sepBefore.targetFils);
  assert.equal(sepAfter.collectedFils, sepBefore.collectedFils);
  assert.equal(octAfter.targetFils, octBefore.targetFils);
  assert.equal(octAfter.collectedFils, octBefore.collectedFils);
  assert.equal(db.dump("receipts").filter((r) => r.obligationId === row.october.id && r.state === "recognized").length, 1);
  assert.equal(db.dump("receipts").find((r) => r.obligationId === row.october.id).amountFils, 50000);
});

test("F partial November payments stay separate after an explicit renewal", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const row = await octoberContract(db, owner);
  const renewed = await run(db, owner, "renewRentalCycle", {
    rentalId: row.rental.rentalId, asOfDate: "2026-11-01",
  }, opId("renew"));
  const requestId = "req_nov_partial";
  await run(db, actorFrom(yahia), "submitWorkRequest", collectionRequest({
    requestId, unitId: row.unit.unitId, spaceId: row.space.spaceId,
    rentAed: 1200, paidAed: 400, partial: true, month: 10, start: "2026-10-01",
  }), opId("submit-partial"));
  await run(db, owner, "commitWorkRequest", { requestId }, "commit-partial");
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: renewed.obligationId, amountFils: 80000, collectionDate: "2026-11-04",
  }, opId("rest"));
  const receipts = db.dump("receipts").filter((r) => r.obligationId === renewed.obligationId && r.state === "recognized");
  assert.equal(receipts.length, 2);
  assert.equal(receipts.reduce((sum, r) => sum + r.amountFils, 0), 120000);
  const dash = buildDashboardFromDump(db, "2026-11", "2026-11-04");
  assert.equal(dash.summary.collectedFils, 120000);
  assert.equal(dash.summary.remainingFils, 0);
});

test("G October collection approval still creates one receipt", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const row = await octoberContract(db, owner);
  const requestId = "req_oct_collect";
  await run(db, actorFrom(yahia), "submitWorkRequest", collectionRequest({
    requestId, unitId: row.unit.unitId, spaceId: row.space.spaceId,
    rentAed: 1200, paidAed: 700, partial: true, month: 9, start: "2026-10-01",
  }), opId("submit-oct"));
  const approved = await run(db, owner, "commitWorkRequest", { requestId }, "commit-oct");
  assert.equal(approved.status, "approved");
  const receipts = db.dump("receipts").filter((r) => r.obligationId === row.october.id && r.state === "recognized");
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].amountFils, 70000);
  assert.equal(db.dump("obligations").some((o) => o.period === "2026-11"), false);
});
