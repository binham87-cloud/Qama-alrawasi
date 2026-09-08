/**
 * E2E: employee update_partition request → commitWorkRequest → canonical receipt.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshDb, run, bootstrapOwner, createUser, actorFrom, opId } from "../helpers/commands.mjs";
import { buildDashboardFromDump } from "../../functions/services/readModel.mjs";
import { STATUS, APPROVAL_STATE, RECEIPT_STATE } from "../../functions/domain/finance.mjs";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const html = readFileSync(resolve(root, "src/frontend/index.html"), "utf8");

async function seedSpace(db, owner, { name = "شقة 202 / 1", rentFils = 140000 } = {}) {
  const prop = await run(db, owner, "createProperty", { name: "قمة", address: "دبي" });
  const unit = await run(db, owner, "createUnit", { propertyId: prop.propertyId, name: "شقة 202", kind: "partitioned" });
  const space = await run(db, owner, "createSpace", { unitId: unit.unitId, name });
  await run(db, owner, "createAccount", { name: "بنك", kind: "bank" });
  return { prop, unit, space, rentFils };
}

async function submitPartitionRequest(db, employee, {
  requestId, spaceId, unitId, partId = 1, fields, year = 2026, month = 8,
}) {
  return run(db, actorFrom(employee), "submitWorkRequest", {
    requestId,
    type: "update_partition",
    desc: `تعديل ${fields.status} ${fields.rent}`,
    payloadJson: JSON.stringify({
      unitId, partId,
      fields: { ...fields, _spaceId: spaceId },
    }),
    month, year,
  }, opId(requestId));
}

test("CASH FULL REQUEST E2E: 1400 collected → holding +1400, remaining 0", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const { space, unit, rentFils } = await seedSpace(db, owner);
  const holdBefore = buildDashboardFromDump(db, "2026-09", "2026-09-03").summary.holdingFils;

  const requestId = "req_cash_full_1400";
  await submitPartitionRequest(db, yahia, {
    requestId, spaceId: space.spaceId, unitId: unit.unitId,
    fields: {
      status: "collected", rent: 1400, paid_amount: 1400, partial: false,
      collectionMethod: "cash", start_date: "2026-09-01", tenant: "مستأجر",
    },
  });

  await run(db, owner, "commitWorkRequest", { requestId }, "commit-" + requestId);

  const dash = buildDashboardFromDump(db, "2026-09", "2026-09-03");
  const ob = db.dump("obligations").find((o) => o.spaceId === space.spaceId && o.period === "2026-09" && o.state === "active");
  assert.ok(ob);
  assert.equal(ob.amountFils, rentFils);
  const receipts = db.dump("receipts").filter((r) => r.obligationId === ob.id && r.state === RECEIPT_STATE.RECOGNIZED);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].amountFils, 140000);
  assert.equal(receipts[0].method, "cash");

  const view = dash.obligations.find((v) => v.obligationId === ob.id);
  assert.equal(view.paidFils, 140000);
  assert.equal(view.remainingFils, 0);
  assert.equal(view.status, STATUS.COLLECTED);
  assert.equal(dash.summary.collectedFils, 140000);
  assert.equal(dash.summary.holdingFils, holdBefore + 140000);

  const req = db.dump("uiRequests").find((r) => r.id === requestId);
  assert.equal(req.status, "approved");
});

test("CASH PARTIAL REQUEST E2E: paid 500 of 1400 → partial, holding +500", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const { space, unit } = await seedSpace(db, owner);
  const holdBefore = buildDashboardFromDump(db, "2026-09", "2026-09-03").summary.holdingFils;

  const requestId = "req_cash_partial_500";
  await submitPartitionRequest(db, yahia, {
    requestId, spaceId: space.spaceId, unitId: unit.unitId,
    fields: {
      status: "late", rent: 1400, paid_amount: 500, partial: true,
      collectionMethod: "cash", start_date: "2026-09-01", tenant: "مستأجر",
    },
  });
  await run(db, owner, "commitWorkRequest", { requestId }, "commit-" + requestId);

  const dash = buildDashboardFromDump(db, "2026-09", "2026-09-03");
  const ob = db.dump("obligations").find((o) => o.spaceId === space.spaceId && o.period === "2026-09" && o.state === "active");
  const receipts = db.dump("receipts").filter((r) => r.obligationId === ob.id && r.state === RECEIPT_STATE.RECOGNIZED);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].amountFils, 50000);
  const view = dash.obligations.find((v) => v.obligationId === ob.id);
  assert.equal(view.paidFils, 50000);
  assert.equal(view.remainingFils, 90000);
  assert.equal(view.status, STATUS.PARTIAL);
  assert.equal(dash.summary.holdingFils, holdBefore + 50000);
});

test("ZERO PAYMENT REQUEST: rent 1400 paid 0 → no receipt", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const { space, unit } = await seedSpace(db, owner);

  const requestId = "req_zero_pay";
  await submitPartitionRequest(db, yahia, {
    requestId, spaceId: space.spaceId, unitId: unit.unitId,
    fields: {
      status: "late", rent: 1400, paid_amount: 0, partial: false,
      collectionMethod: "cash", start_date: "2026-09-01", tenant: "مستأجر",
    },
  });
  await run(db, owner, "commitWorkRequest", { requestId }, "commit-" + requestId);

  const ob = db.dump("obligations").find((o) => o.spaceId === space.spaceId && o.period === "2026-09" && o.state === "active");
  assert.ok(ob);
  const live = db.dump("receipts").filter((r) => r.obligationId === ob.id && r.state === RECEIPT_STATE.RECOGNIZED);
  assert.equal(live.length, 0);
  const dash = buildDashboardFromDump(db, "2026-09", "2026-09-03");
  const view = dash.obligations.find((v) => v.obligationId === ob.id);
  assert.equal(view.paidFils, 0);
  assert.equal(view.status, STATUS.LATE);
});

test("DOUBLE APPROVAL: second commit creates no duplicate receipt", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const { space, unit } = await seedSpace(db, owner);

  const requestId = "req_double_appr";
  await submitPartitionRequest(db, yahia, {
    requestId, spaceId: space.spaceId, unitId: unit.unitId,
    fields: {
      status: "collected", rent: 1400, paid_amount: 1400, partial: false,
      collectionMethod: "cash", start_date: "2026-09-01", tenant: "مستأجر",
    },
  });
  await run(db, owner, "commitWorkRequest", { requestId }, "commit-" + requestId);
  const again = await run(db, owner, "commitWorkRequest", { requestId }, "commit-" + requestId);
  assert.equal(again.alreadyApplied, true);

  // Different operationId must still be idempotent at request level
  const again2 = await run(db, owner, "commitWorkRequest", { requestId }, "commit-" + requestId + "-retry");
  assert.equal(again2.alreadyApplied, true);

  const ob = db.dump("obligations").find((o) => o.spaceId === space.spaceId && o.period === "2026-09");
  const live = db.dump("receipts").filter((r) => r.obligationId === ob.id && r.state === RECEIPT_STATE.RECOGNIZED);
  assert.equal(live.length, 1);
  assert.equal(live[0].amountFils, 140000);
});

test("UI: approveRequest commits before months applyEngineDiff", () => {
  assert.match(html, /commitWorkRequest FIRST/);
  assert.match(html, /Never Object\.assign paid\/status into the month and save before this/);
  // Must not Object.assign request fields into month before commit in approveRequest
  const fn = html.slice(html.indexOf("async function approveRequest"), html.indexOf("async function rejectRequest"));
  assert.ok(!/Object\.assign\(p,R_\.payload\.fields\)/.test(fn), "approve must not assign fields before commit");
  assert.ok(!/fbSetDoc\(fbDoc\(db,\"months\"/.test(fn), "approve must not save months before/around commit");
  assert.match(fn, /commitWorkRequest/);
});
