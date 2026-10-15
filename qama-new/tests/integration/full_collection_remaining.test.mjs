import test from "node:test";
import assert from "node:assert/strict";
import { freshDb, run, bootstrapOwner, createUser, actorFrom, opId } from "../helpers/commands.mjs";
import { RECEIPT_STATE } from "../../functions/domain/finance.mjs";

async function space(db, owner) {
  const prop = await run(db, owner, "createProperty", { name: "قمة", address: "دبي" });
  const unit = await run(db, owner, "createUnit", { propertyId: prop.propertyId, name: "شقة 11", kind: "partitioned" });
  const sp = await run(db, owner, "createSpace", { unitId: unit.unitId, name: "شقة 11 / 1" });
  await run(db, owner, "createAccount", { name: "بنك", kind: "bank" });
  return { unit, space: sp };
}

test("approved full cash request with a zero amount does not create a receipt", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const { unit, space: sp } = await space(db, owner);
  const requestId = "req_zero_full";
  await run(db, actorFrom(yahia), "submitWorkRequest", {
    requestId, type: "update_partition", desc: "كامل صفر",
    payloadJson: JSON.stringify({
      unitId: unit.unitId, partId: 1,
      fields: {
        status: "collected", rent: 1200, paid_amount: 0, partial: false,
        collectionMethod: "cash", start_date: "2026-09-01", tenant: "مستأجر",
        _spaceId: sp.spaceId,
      },
    }),
    month: 8, year: 2026,
  }, opId(requestId));
  await assert.rejects(
    () => run(db, owner, "commitWorkRequest", { requestId }, "commit-" + requestId),
    (e) => e.code === "ZERO_FULL_COLLECTION",
  );
  const recognized = db.dump("receipts").filter((r) => r.state === RECEIPT_STATE.RECOGNIZED);
  assert.equal(recognized.length, 0);
});

test("full payment after a partial collects only the remaining balance", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const { unit, space: sp } = await space(db, owner);
  await run(db, actorFrom(yahia), "submitWorkRequest", {
    requestId: "req_part", type: "update_partition", desc: "جزئي",
    payloadJson: JSON.stringify({
      unitId: unit.unitId, partId: 1,
      fields: {
        status: "late", rent: 1200, paid_amount: 500, partial: true,
        collectionMethod: "cash", start_date: "2026-09-01", tenant: "مستأجر",
        _spaceId: sp.spaceId, newPaymentFils: 50000,
      },
    }),
    month: 8, year: 2026,
  }, opId("req_part"));
  await run(db, owner, "commitWorkRequest", { requestId: "req_part" }, "commit-req_part");
  await run(db, actorFrom(yahia), "submitWorkRequest", {
    requestId: "req_rest", type: "update_partition", desc: "كامل المتبقي",
    payloadJson: JSON.stringify({
      unitId: unit.unitId, partId: 1,
      fields: {
        status: "collected", rent: 1200, paid_amount: 700, partial: false,
        collectionMethod: "bank", start_date: "2026-09-01", tenant: "مستأجر",
        _spaceId: sp.spaceId, newPaymentFils: 70000, paymentResolved: true,
      },
    }),
    month: 8, year: 2026,
  }, opId("req_rest"));
  await run(db, owner, "commitWorkRequest", { requestId: "req_rest" }, "commit-req_rest");
  const ob = db.dump("obligations").find((o) => o.spaceId === sp.spaceId && o.state === "active");
  const live = db.dump("receipts").filter((r) => r.obligationId === ob.id && r.state === RECEIPT_STATE.RECOGNIZED);
  assert.equal(live.length, 2);
  assert.equal(live.reduce((s, r) => s + r.amountFils, 0), 120000);
  const bank = live.find((r) => r.method === "bank");
  assert.equal(bank.amountFils, 70000);
});
