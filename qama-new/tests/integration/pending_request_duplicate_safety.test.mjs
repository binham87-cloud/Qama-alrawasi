/**
 * Current backend enforcement for partition requests.
 * These tests describe production behavior on an in-memory database.
 * They do not add a new locking feature.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshDb, run, bootstrapOwner, createUser, actorFrom, opId } from "../helpers/commands.mjs";
import { executeCommand } from "../../functions/commands/index.mjs";
import { RECEIPT_STATE } from "../../functions/domain/finance.mjs";

async function seed(db, owner) {
  const prop = await run(db, owner, "createProperty", { name: "قمة", address: "دبي" });
  const unit = await run(db, owner, "createUnit", { propertyId: prop.propertyId, name: "شقة 202", kind: "partitioned" });
  const space = await run(db, owner, "createSpace", { unitId: unit.unitId, name: "شقة 202 / 5" });
  const account = await run(db, owner, "createAccount", { name: "بنك", kind: "bank" });
  return { unit, space, account };
}

function recognized(db, spaceId) {
  return db.dump("receipts").filter((r) => r.spaceId === spaceId && r.state === RECEIPT_STATE.RECOGNIZED);
}

async function submit(db, employee, {
  requestId, unitId, spaceId, partId = 5, year = 2026, month = 8, fields,
}) {
  return run(db, actorFrom(employee), "submitWorkRequest", {
    requestId,
    type: "update_partition",
    desc: "تعديل",
    month,
    year,
    payloadJson: JSON.stringify({
      unitId,
      partId,
      fields: { ...fields, _spaceId: spaceId, _unitId: unitId },
    }),
  }, opId(requestId));
}

async function commitAt(db, owner, requestId, now) {
  return executeCommand({
    db, actor: owner, command: "commitWorkRequest",
    payload: { requestId }, operationId: "commit-" + requestId, now,
  });
}

test("same employee cannot open a second pending request for the same partition and month", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const nader = await createUser(db, owner, { displayName: "نادر", role: "employee", pin: "1111" });
  const { unit, space } = await seed(db, owner);
  await submit(db, nader, {
    requestId: "req_first_collect", unitId: unit.unitId, spaceId: space.spaceId,
    fields: { status: "collected", rent: 1200, tenant: "هنا", start_date: "2026-09-01", collectionMethod: "cash" },
  });
  await assert.rejects(
    () => submit(db, nader, {
      requestId: "req_second_collect", unitId: unit.unitId, spaceId: space.spaceId,
      fields: { status: "collected", rent: 900, tenant: "هناء", start_date: "2026-09-01", collectionMethod: "cash", paid_amount: 900, partial: true },
    }),
    (err) => err && err.code === "DUPLICATE_PENDING_REQUEST",
  );
  await commitAt(db, owner, "req_first_collect", "2026-09-10T20:21:53.350Z");
  const again = await commitAt(db, owner, "req_first_collect", "2026-09-10T20:22:00.000Z");
  assert.equal(again.alreadyApplied, true);
  assert.equal(recognized(db, space.spaceId).length, 1);
  assert.equal(recognized(db, space.spaceId)[0].amountFils, 120000);
});

test("retry of the same submission does not create a second request", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const nader = await createUser(db, owner, { displayName: "نادر", role: "employee", pin: "1111" });
  const { unit, space } = await seed(db, owner);
  const payload = {
    requestId: "req_retry_same",
    type: "update_partition",
    desc: "تعديل",
    month: 8,
    year: 2026,
    payloadJson: JSON.stringify({
      unitId: unit.unitId, partId: 5,
      fields: { status: "collected", rent: 1200, tenant: "هنا", start_date: "2026-09-01", collectionMethod: "cash", _spaceId: space.spaceId },
    }),
  };
  const first = await run(db, actorFrom(nader), "submitWorkRequest", payload, "op-retry-same-01");
  const replay = await run(db, actorFrom(nader), "submitWorkRequest", payload, "op-retry-same-01");
  assert.equal(replay.replay, true);
  assert.equal(replay.requestId, first.requestId);
  await assert.rejects(
    () => run(db, actorFrom(nader), "submitWorkRequest", payload, "op-retry-same-02"),
    (err) => err && err.code === "REQUEST_EXISTS",
  );
  assert.equal(db.dump("uiRequests").filter((r) => r.type === "update_partition").length, 1);
});

test("rejection creates no receipt and a later correction creates exactly one", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const nader = await createUser(db, owner, { displayName: "نادر", role: "employee", pin: "1111" });
  const { unit, space } = await seed(db, owner);
  await submit(db, nader, {
    requestId: "req_reject_me", unitId: unit.unitId, spaceId: space.spaceId,
    fields: { status: "collected", rent: 1200, tenant: "هنا", start_date: "2026-09-01", collectionMethod: "cash" },
  });
  await run(db, owner, "resolveWorkRequest", { requestId: "req_reject_me", decision: "rejected" });
  await assert.rejects(
    () => commitAt(db, owner, "req_reject_me", "2026-09-10T20:00:00.000Z"),
    (err) => err && err.code === "REQUEST_NOT_PENDING",
  );
  assert.equal(recognized(db, space.spaceId).length, 0);
  await submit(db, nader, {
    requestId: "req_after_reject", unitId: unit.unitId, spaceId: space.spaceId,
    fields: { status: "partial", partial: true, paid_amount: 400, rent: 1200, tenant: "هنا", start_date: "2026-09-01", collectionMethod: "cash" },
  });
  await commitAt(db, owner, "req_after_reject", "2026-09-10T21:00:00.000Z");
  const receipts = recognized(db, space.spaceId);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].amountFils, 40000);
});

test("two employees may both submit, and two full approvals still collect once", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const nader = await createUser(db, owner, { displayName: "نادر", role: "employee", pin: "1111" });
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "2222" });
  const { unit, space } = await seed(db, owner);
  const fields = { status: "collected", rent: 1200, tenant: "هنا", start_date: "2026-09-01", collectionMethod: "cash" };
  await submit(db, nader, { requestId: "req_nader", unitId: unit.unitId, spaceId: space.spaceId, fields });
  await submit(db, yahia, { requestId: "req_yahia", unitId: unit.unitId, spaceId: space.spaceId, fields });
  await commitAt(db, owner, "req_nader", "2026-09-10T20:00:00.000Z");
  const second = await commitAt(db, owner, "req_yahia", "2026-09-10T20:05:00.000Z");
  assert.equal(second.status, "approved");
  assert.equal(recognized(db, space.spaceId).length, 1);
  assert.equal(db.dump("rentals").filter((r) => r.spaceId === space.spaceId).length, 1);
});

test("a second partial payment is another receipt, and an amount above remaining is refused", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const nader = await createUser(db, owner, { displayName: "نادر", role: "employee", pin: "1111" });
  const { unit, space } = await seed(db, owner);
  await submit(db, nader, {
    requestId: "req_partial_400", unitId: unit.unitId, spaceId: space.spaceId,
    fields: { status: "partial", partial: true, paid_amount: 400, rent: 1200, tenant: "هنا", start_date: "2026-09-01", collectionMethod: "cash" },
  });
  await commitAt(db, owner, "req_partial_400", "2026-09-10T20:00:00.000Z");
  await submit(db, nader, {
    requestId: "req_partial_400_again", unitId: unit.unitId, spaceId: space.spaceId,
    fields: { status: "partial", partial: true, paid_amount: 400, rent: 1200, tenant: "هنا", start_date: "2026-09-01", collectionMethod: "cash" },
  });
  await commitAt(db, owner, "req_partial_400_again", "2026-09-11T20:00:00.000Z");
  assert.equal(recognized(db, space.spaceId).reduce((s, r) => s + r.amountFils, 0), 80000);
  await assert.rejects(
    () => submit(db, nader, {
      requestId: "req_partial_900", unitId: unit.unitId, spaceId: space.spaceId,
      fields: { status: "partial", partial: true, paid_amount: 900, rent: 1200, tenant: "هنا", start_date: "2026-09-01", collectionMethod: "cash" },
    }).then(() => commitAt(db, owner, "req_partial_900", "2026-09-12T20:00:00.000Z")),
    (e) => e.code === "AMOUNT_EXCEEDS_REMAINING",
  );
  const total = recognized(db, space.spaceId).reduce((s, r) => s + r.amountFils, 0);
  assert.equal(total, 80000);
  assert.equal(recognized(db, space.spaceId).length, 2);
});

test("October vacate then a new September collection does not create a second receipt", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const nader = await createUser(db, owner, { displayName: "نادر", role: "employee", pin: "1111" });
  const { unit, space } = await seed(db, owner);
  await submit(db, nader, {
    requestId: "req_sep_collect", unitId: unit.unitId, spaceId: space.spaceId,
    fields: { status: "collected", rent: 1200, tenant: "هنا", start_date: "2026-09-01", collectionMethod: "cash" },
  });
  await commitAt(db, owner, "req_sep_collect", "2026-09-10T20:21:53.350Z");
  await submit(db, nader, {
    requestId: "req_oct_vacate", unitId: unit.unitId, spaceId: space.spaceId, month: 9,
    fields: { status: "vacant", rent: 1200, tenant: "هنا", start_date: "2026-10-01" },
  });
  await commitAt(db, owner, "req_oct_vacate", "2026-10-04T15:55:53.904Z");
  await submit(db, nader, {
    requestId: "req_sep_again", unitId: unit.unitId, spaceId: space.spaceId,
    fields: { status: "collected", rent: 1200, tenant: "هناء", start_date: "2026-09-01", collectionMethod: "cash" },
  });
  await assert.rejects(
    () => commitAt(db, owner, "req_sep_again", "2026-10-04T23:28:01.583Z"),
    (err) => err && err.code === "PERIOD_ALREADY_COVERED",
  );
  assert.equal(recognized(db, space.spaceId).length, 1);
  assert.equal(db.dump("rentals").filter((r) => r.spaceId === space.spaceId && r.state === "active").length, 0);
});

test("staff occupancy and a non-financial edit do not create receipts", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const nader = await createUser(db, owner, { displayName: "نادر", role: "employee", pin: "1111" });
  const { unit, space } = await seed(db, owner);
  await submit(db, nader, {
    requestId: "req_note", unitId: unit.unitId, spaceId: space.spaceId,
    fields: { status: "pending", rent: 1200, tenant: "هنا", start_date: "2026-09-01", note: "ملاحظة فقط" },
  });
  await commitAt(db, owner, "req_note", "2026-09-02T10:00:00.000Z");
  assert.equal(recognized(db, space.spaceId).length, 0);
  assert.equal(db.dump("rentals").filter((r) => r.spaceId === space.spaceId).length, 1);

  const prop = await run(db, owner, "createProperty", { name: "أخرى", address: "دبي" });
  const unit2 = await run(db, owner, "createUnit", { propertyId: prop.propertyId, name: "شقة 302", kind: "partitioned" });
  const space2 = await run(db, owner, "createSpace", { unitId: unit2.unitId, name: "302 / 7" });
  await submit(db, nader, {
    requestId: "req_staff", unitId: unit2.unitId, spaceId: space2.spaceId, partId: 7,
    fields: { status: "staff", rent: 0, tenant: "", note: "موظفين" },
  });
  await commitAt(db, owner, "req_staff", "2026-09-03T10:00:00.000Z");
  assert.equal(recognized(db, space2.spaceId).length, 0);
  const saved = db.dump("spaces").find((s) => s.id === space2.spaceId);
  assert.equal(saved.occupancy, "staff");
});

test("a later unpaid correction reverses the receipt once, before any deposit", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const nader = await createUser(db, owner, { displayName: "نادر", role: "employee", pin: "1111" });
  const { unit, space } = await seed(db, owner);
  await submit(db, nader, {
    requestId: "req_collected", unitId: unit.unitId, spaceId: space.spaceId,
    fields: { status: "collected", rent: 1200, tenant: "هنا", start_date: "2026-09-01", collectionMethod: "cash" },
  });
  await commitAt(db, owner, "req_collected", "2026-09-10T20:00:00.000Z");
  await submit(db, nader, {
    requestId: "req_mark_late", unitId: unit.unitId, spaceId: space.spaceId,
    fields: { status: "late", rent: 1200, tenant: "هنا", start_date: "2026-09-01", paid_amount: 0 },
  });
  await commitAt(db, owner, "req_mark_late", "2026-09-12T20:00:00.000Z");
  assert.equal(recognized(db, space.spaceId).length, 0);
  assert.equal(db.dump("receipts").filter((r) => r.spaceId === space.spaceId && r.state === "reversed").length, 1);
});

test("an approved deposit blocks receipt reversal and stays approved", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const nader = await createUser(db, owner, { displayName: "نادر", role: "employee", pin: "1111" });
  const { unit, space, account } = await seed(db, owner);
  await submit(db, nader, {
    requestId: "req_collected_dep", unitId: unit.unitId, spaceId: space.spaceId,
    fields: { status: "collected", rent: 1200, tenant: "هنا", start_date: "2026-09-01", collectionMethod: "cash" },
  });
  await commitAt(db, owner, "req_collected_dep", "2026-09-10T20:00:00.000Z");
  const deposit = await run(db, owner, "submitDeposit", {
    amountFils: 120000,
    depositDate: "2026-09-11",
    destinationAccountId: account.accountId,
    employeeId: nader.userId,
    sourceKind: "holding",
    sourcePeriod: "2026-09",
    period: "2026-09",
  });
  assert.equal(db.dump("deposits").find((d) => d.id === deposit.depositId).state, "approved");
  await submit(db, nader, {
    requestId: "req_late_after_deposit", unitId: unit.unitId, spaceId: space.spaceId,
    fields: { status: "late", rent: 1200, tenant: "هنا", start_date: "2026-09-01", paid_amount: 0 },
  });
  await assert.rejects(
    () => commitAt(db, owner, "req_late_after_deposit", "2026-09-12T20:00:00.000Z"),
    (err) => err && err.code === "RECEIPT_ALREADY_DEPOSITED",
  );
  assert.equal(recognized(db, space.spaceId).length, 1);
  assert.equal(db.dump("deposits").find((d) => d.id === deposit.depositId).state, "approved");
  const stuck = db.dump("uiRequests").find((r) => r.id === "req_late_after_deposit");
  assert.equal(stuck.status, "processing");
  await assert.rejects(
    () => run(db, owner, "resolveWorkRequest", { requestId: "req_late_after_deposit", decision: "pending" }, opId("reopen-deposited")),
    (err) => err && err.code === "REQUEST_PARTIALLY_APPLIED",
  );
});
