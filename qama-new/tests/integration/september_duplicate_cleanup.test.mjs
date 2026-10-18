/**
 * Isolated September duplicate cleanup.
 * No production data. Approved deposits are never rewritten.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshDb, run, bootstrapOwner, createUser, actorFrom, opId } from "../helpers/commands.mjs";
import { RECEIPT_STATE } from "../../functions/domain/finance.mjs";
import { sharedHoldingFils } from "../../functions/domain/finance.mjs";

async function spaceOf(db, owner, name, rent, start = "2026-09-01") {
  const prop = await run(db, owner, "createProperty", { name: "قمة", address: "دبي" });
  const unit = await run(db, owner, "createUnit", { propertyId: prop.propertyId, name, kind: "partitioned" });
  const space = await run(db, owner, "createSpace", { unitId: unit.unitId, name });
  const account = await run(db, owner, "createAccount", { name: "بنك", kind: "bank" });
  const rental = await run(db, owner, "createRental", {
    spaceId: space.spaceId, tenantName: "مستأجر", contractualAmountFils: rent,
    dueDayOfMonth: 1, startDate: start,
  });
  await run(db, owner, "generateObligations", { period: "2026-09" });
  const obligation = db.dump("obligations").find((o) => o.rentalId === rental.rentalId && o.period === "2026-09" && o.state === "active");
  return { prop, unit, space, account, rental, obligation };
}

function recognized(db, obligationId) {
  return db.dump("receipts").filter((r) => r.obligationId === obligationId && r.state === RECEIPT_STATE.RECOGNIZED);
}

test("one September charge remains after the unpaid duplicate obligation is cancelled", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const { space, rental, obligation } = await spaceOf(db, owner, "شقة 202 / 8", 120000);
  const duplicateId = obligation.id + "-dup";
  db.seed("obligations", duplicateId, { ...obligation, id: duplicateId, cycleStart: "2026-09-07" });
  await run(db, owner, "generateObligations", { period: "2026-10" }, opId("gen-oct"));
  const octoberBefore = db.dump("obligations").find((o) => o.rentalId === rental.rentalId && o.period === "2026-10");
  await run(db, owner, "createCashReceipt", {
    obligationId: obligation.id, amountFils: 120000, collectionDate: "2026-09-07",
  }, opId("keep-cash"));
  const depositsBefore = JSON.stringify(db.dump("deposits"));
  await run(db, owner, "cancelObligation", { obligationId: duplicateId, reason: "التزام مكرر لشهر سبتمبر" }, opId("cancel-dup"));
  await assert.rejects(
    () => run(db, owner, "cancelObligation", { obligationId: duplicateId, reason: "مرة ثانية" }, opId("cancel-dup-2")),
    (err) => err && err.code === "OBLIGATION_NOT_ACTIVE",
  );
  assert.equal(db.dump("obligations").filter((o) => o.spaceId === space.spaceId && o.period === "2026-09" && o.state === "active").length, 1);
  assert.equal(recognized(db, obligation.id)[0].amountFils, 120000);
  assert.equal(JSON.stringify(db.dump("deposits")), depositsBefore);
  const octoberAfter = db.dump("obligations").find((o) => o.id === octoberBefore.id);
  assert.equal(octoberAfter.amountFils, octoberBefore.amountFils);
  assert.equal(octoberAfter.state, octoberBefore.state);
});

test("a later duplicate receipt is reversed and the earlier receipt stays recognized", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "2222" });
  const { space, account, obligation } = await spaceOf(db, owner, "شقة 302 / 5", 100000);
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: obligation.id, amountFils: 100000, collectionDate: "2026-09-07",
  }, opId("first-cash"));
  const duplicateId = obligation.id + "-later";
  db.seed("obligations", duplicateId, { ...obligation, id: duplicateId });
  const secondReceiptId = "rcpt-historical-duplicate";
  db.seed("receipts", secondReceiptId, {
    id: secondReceiptId,
    obligationId: duplicateId,
    rentalId: obligation.rentalId,
    propertyId: obligation.propertyId,
    unitId: obligation.unitId,
    spaceId: obligation.spaceId,
    period: "2026-09",
    tenantNameSnapshot: obligation.tenantNameSnapshot,
    amountFils: 100000,
    collectionDate: "2026-09-01",
    method: "cash",
    state: "recognized",
    collectorUserId: yahia.userId,
  });
  const first = recognized(db, obligation.id)[0];
  const second = recognized(db, duplicateId)[0];
  await run(db, owner, "submitDeposit", {
    amountFils: 50000, depositDate: "2026-09-20", destinationAccountId: account.accountId,
    employeeId: yahia.userId, sourceKind: "holding", sourcePeriod: "2026-09", period: "2026-09",
  }, opId("dep"));
  const deposit = db.dump("deposits")[0];
  assert.equal(deposit.state, "approved");
  await run(db, owner, "reverseReceipt", { receiptId: second.id, reason: "تحصيل مكرر لنفس شهر سبتمبر" }, opId("rev-dup"));
  await assert.rejects(
    () => run(db, owner, "reverseReceipt", { receiptId: second.id, reason: "مرة ثانية" }, opId("rev-dup-2")),
    (err) => err && err.code === "ALREADY_REVERSED",
  );
  await run(db, owner, "cancelObligation", { obligationId: duplicateId, reason: "التزام التحصيل المكرر" }, opId("cancel-later"));
  assert.equal(recognized(db, obligation.id)[0].id, first.id);
  assert.equal(recognized(db, obligation.id)[0].collectorUserId, yahia.userId);
  assert.equal(db.dump("receipts").find((r) => r.id === second.id).state, "reversed");
  assert.equal(db.dump("deposits")[0].amountFils, 50000);
  assert.equal(db.dump("deposits")[0].state, "approved");
  const holding = sharedHoldingFils({ receipts: db.dump("receipts"), deposits: db.dump("deposits"), period: "2026-09" });
  assert.equal(holding, 50000);
  assert.equal(db.dump("obligations").filter((o) => o.spaceId === space.spaceId && o.period === "2026-09" && o.state === "active").length, 1);
});

test("partial payments on one obligation are not a duplicate", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const { obligation } = await spaceOf(db, owner, "شقة 101 / 1", 100000);
  await run(db, owner, "createCashReceipt", {
    obligationId: obligation.id, amountFils: 40000, collectionDate: "2026-09-05",
  }, opId("part-a"));
  await run(db, owner, "createCashReceipt", {
    obligationId: obligation.id, amountFils: 30000, collectionDate: "2026-09-12",
  }, opId("part-b"));
  assert.equal(recognized(db, obligation.id).length, 2);
  assert.equal(recognized(db, obligation.id).reduce((s, r) => s + r.amountFils, 0), 70000);
});

test("aggregate deposits stay approved when the employee difference is negative", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const nader = await createUser(db, owner, { displayName: "نادر", role: "employee", pin: "1111" });
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "2222" });
  const { account, obligation } = await spaceOf(db, owner, "شقة 204 / 4", 100000);
  await run(db, actorFrom(nader), "createCashReceipt", {
    obligationId: obligation.id, amountFils: 40000, collectionDate: "2026-09-08",
  }, opId("nader-cash"));
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: obligation.id, amountFils: 60000, collectionDate: "2026-09-09",
  }, opId("yahia-cash"));
  await run(db, owner, "submitDeposit", {
    amountFils: 100000, depositDate: "2026-09-20", destinationAccountId: account.accountId,
    employeeId: yahia.userId, sourceKind: "holding", sourcePeriod: "2026-09", period: "2026-09",
  }, opId("yahia-dep"));
  const cash = (id) => db.dump("receipts")
    .filter((r) => r.collectorUserId === id && r.state === "recognized" && r.method === "cash")
    .reduce((s, r) => s + r.amountFils, 0);
  const deposited = (id) => db.dump("deposits")
    .filter((d) => d.employeeId === id && d.state === "approved")
    .reduce((s, d) => s + d.amountFils, 0);
  assert.equal(cash(nader.userId) - deposited(nader.userId), 40000);
  assert.equal(cash(yahia.userId) - deposited(yahia.userId), -40000);
  assert.equal(sharedHoldingFils({ receipts: db.dump("receipts"), deposits: db.dump("deposits"), period: "2026-09" }), 0);
  assert.equal(db.dump("deposits")[0].amountFils, 100000);
});

test("apartment 102 drops 200 AED without a full reversal and stays fully collected", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "2222" });
  const { space, account, rental, obligation } = await spaceOf(db, owner, "102", 920000, "2026-09-06");
  const receipt = await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: obligation.id, amountFils: 920000, collectionDate: "2026-09-06",
  }, opId("rent-9200"));
  await run(db, owner, "createCashReceipt", {
    obligationId: (await (async () => {
      const other = await run(db, owner, "createRental", {
        spaceId: (await run(db, owner, "createSpace", {
          unitId: (await run(db, owner, "createUnit", {
            propertyId: (await run(db, owner, "createProperty", { name: "أخرى", address: "دبي" })).propertyId,
            name: "أخرى", kind: "whole",
          }, opId("u2"))).unitId,
          name: "غرفة",
        }, opId("s2"))).spaceId,
        tenantName: "آخر", contractualAmountFils: 30000, dueDayOfMonth: 1, startDate: "2026-09-01",
      }, opId("r2"));
      await run(db, owner, "generateObligations", { period: "2026-09" }, opId("g2"));
      return db.dump("obligations").find((o) => o.rentalId === other.rentalId && o.state === "active");
    })()).id,
    amountFils: 30000, collectionDate: "2026-09-06",
  }, opId("spare-cash"));
  await run(db, owner, "submitDeposit", {
    amountFils: 930000, depositDate: "2026-09-20", destinationAccountId: account.accountId,
    employeeId: yahia.userId, sourceKind: "holding", sourcePeriod: "2026-09", period: "2026-09",
  }, opId("big-dep"));
  const depositBefore = db.dump("deposits")[0].amountFils;
  await assert.rejects(
    () => run(db, owner, "reverseReceipt", { receiptId: receipt.receiptId, reason: "عكس كامل" }, opId("full-rev")),
    (err) => err && err.code === "RECEIPT_ALREADY_DEPOSITED",
  );
  assert.equal(db.dump("receipts").find((r) => r.id === receipt.receiptId).state, "recognized");
  const correctionId = opId("net-200");
  const adjusted = await run(db, owner, "reverseReceipt", {
    receiptId: receipt.receiptId, reason: "الإيجار الصحيح 9000", replacementAmountFils: 900000,
  }, correctionId);
  const replacement = db.dump("receipts").find((r) => r.id === adjusted.replacementReceiptId);
  assert.equal(replacement.amountFils, 900000);
  assert.equal(replacement.collectorUserId, yahia.userId);
  assert.equal(replacement.state, "recognized");
  assert.equal(db.dump("reversals")[0].createdBy, owner.userId);
  const rent = await run(db, owner, "updateRentalRent", {
    rentalId: rental.rentalId, contractualAmountFils: 900000, effectivePeriod: "2026-09",
  }, opId("rent-9000"));
  assert.ok(rent.revisedObligationIds.includes(obligation.id));
  const ob = db.dump("obligations").find((o) => o.id === obligation.id);
  assert.equal(ob.amountFils, 900000);
  assert.equal(ob.state, "active");
  const paid = recognized(db, obligation.id).reduce((s, r) => s + r.amountFils, 0);
  assert.equal(paid, 900000);
  assert.equal(paid - ob.amountFils, 0);
  assert.equal(db.dump("spaces").find((s) => s.id === space.spaceId).occupancy, "rented");
  assert.equal(db.dump("deposits")[0].amountFils, depositBefore);
  assert.equal(db.dump("deposits")[0].state, "approved");
  assert.equal(sharedHoldingFils({ receipts: db.dump("receipts"), deposits: db.dump("deposits"), period: "2026-09" }), 0);
  const again = await run(db, owner, "reverseReceipt", {
    receiptId: receipt.receiptId, reason: "الإيجار الصحيح 9000", replacementAmountFils: 900000,
  }, correctionId);
  assert.equal(again.replay, true);
  assert.equal(recognized(db, obligation.id).length, 1);
});

test("a net correction that would make shared holding negative changes nothing", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const { account, obligation } = await spaceOf(db, owner, "102", 920000, "2026-09-06");
  const receipt = await run(db, owner, "createCashReceipt", {
    obligationId: obligation.id, amountFils: 920000, collectionDate: "2026-09-06",
  }, opId("all-cash"));
  await run(db, owner, "submitDeposit", {
    amountFils: 920000, depositDate: "2026-09-20", destinationAccountId: account.accountId,
    employeeId: owner.userId, sourceKind: "holding", sourcePeriod: "2026-09", period: "2026-09",
  }, opId("all-dep"));
  await assert.rejects(
    () => run(db, owner, "reverseReceipt", {
      receiptId: receipt.receiptId, reason: "مائتا درهم", replacementAmountFils: 900000,
    }, opId("too-far")),
    (err) => err && err.code === "RECEIPT_ALREADY_DEPOSITED",
  );
  assert.equal(db.dump("receipts").find((r) => r.id === receipt.receiptId).amountFils, 920000);
  assert.equal(db.dump("receipts").find((r) => r.id === receipt.receiptId).state, "recognized");
  assert.equal(db.dump("obligations").find((o) => o.id === obligation.id).amountFils, 920000);
  assert.equal(db.dump("deposits")[0].amountFils, 920000);
  assert.equal(db.dump("reversals").length, 0);
});

test("closing September after the duplicate is gone does not change October", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const { rental, obligation } = await spaceOf(db, owner, "شقة 202 / 5", 120000);
  const duplicateId = obligation.id + "-dup";
  db.seed("obligations", duplicateId, { ...obligation, id: duplicateId });
  await assert.rejects(
    () => run(db, owner, "closeAccountingPeriod", { period: "2026-09" }, opId("close-blocked")),
    (err) => err && err.code === "MONTH_NOT_READY",
  );
  await run(db, owner, "cancelObligation", { obligationId: duplicateId, reason: "مكرر" }, opId("cancel"));
  await run(db, owner, "generateObligations", { period: "2026-10" }, opId("oct"));
  const october = db.dump("obligations").find((o) => o.rentalId === rental.rentalId && o.period === "2026-10");
  const before = JSON.stringify(october);
  const review = await run(db, owner, "reviewAccountingClose", { period: "2026-09" }, opId("review"));
  assert.equal(review.ready, true);
  assert.ok(review.notes.some((n) => n.code === "ARREARS"));
  await run(db, owner, "closeAccountingPeriod", { period: "2026-09" }, opId("close"));
  assert.equal(JSON.stringify(db.dump("obligations").find((o) => o.id === october.id)), before);
  await run(db, owner, "reopenAccountingPeriod", { period: "2026-09", reason: "اختبار" }, opId("reopen"));
  assert.equal(db.dump("obligations").find((o) => o.id === obligation.id).state, "active");
});

test("owner approval of a 200 AED correction keeps the deposit and one receipt", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "2222" });
  const { account, obligation } = await spaceOf(db, owner, "102", 920000, "2026-09-06");
  const receipt = await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: obligation.id, amountFils: 920000, collectionDate: "2026-09-06",
  });
  const spareSpace = await run(db, owner, "createSpace", { unitId: db.dump("units")[0].id, name: "spare" });
  const spare = await run(db, owner, "createRental", {
    spaceId: spareSpace.spaceId, tenantName: "آخر", contractualAmountFils: 30000,
    dueDayOfMonth: 1, startDate: "2026-09-01",
  });
  await run(db, owner, "generateObligations", { period: "2026-09" });
  const spareOb = db.dump("obligations").find((o) => o.rentalId === spare.rentalId && o.state === "active");
  await run(db, owner, "createCashReceipt", {
    obligationId: spareOb.id, amountFils: 30000, collectionDate: "2026-09-06",
  });
  await run(db, owner, "submitDeposit", {
    amountFils: 930000, depositDate: "2026-09-20", destinationAccountId: account.accountId,
    employeeId: yahia.userId, sourceKind: "holding", sourcePeriod: "2026-09", period: "2026-09",
  });
  await run(db, actorFrom(yahia), "submitReceiptCorrection", {
    requestId: "req_aed200", receiptId: receipt.receiptId, reason: "الإيجار الصحيح 9000",
    correctedAmountFils: 900000, month: 9, year: 2026,
  });
  await run(db, owner, "commitWorkRequest", { requestId: "req_aed200", expectedVersion: 1 });
  const live = recognized(db, obligation.id);
  assert.equal(live.length, 1);
  assert.equal(live[0].amountFils, 900000);
  assert.equal(live[0].collectorUserId, yahia.userId);
  assert.equal(db.dump("deposits")[0].amountFils, 930000);
  assert.equal(db.dump("deposits")[0].state, "approved");
  const again = await run(db, owner, "commitWorkRequest", { requestId: "req_aed200", expectedVersion: 1 });
  assert.equal(again.alreadyApplied, true);
  assert.equal(recognized(db, obligation.id).length, 1);
});

test("a second September rental on a covered space is refused", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const { space } = await spaceOf(db, owner, "شقة 302 / 5", 100000);
  await run(db, owner, "endTenancy", {
    rentalId: db.dump("rentals")[0].id, endDate: "2026-10-02", reason: "إخلاء", arrearsDecision: "retain",
  }, opId("end"));
  await assert.rejects(
    () => run(db, owner, "createRental", {
      spaceId: space.spaceId, tenantName: "عقد ثان", contractualAmountFils: 100000,
      dueDayOfMonth: 1, startDate: "2026-09-01",
    }, opId("second-rent")),
    (err) => err && err.code === "PERIOD_ALREADY_COVERED",
  );
  assert.equal(db.dump("obligations").filter((o) => o.spaceId === space.spaceId && o.period === "2026-09" && o.state === "active").length, 1);
});
