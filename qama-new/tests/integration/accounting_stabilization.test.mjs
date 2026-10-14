/**
 * Isolated accounting stabilization:
 * pending corrections, receipt corrections, duplicate guards, and month close.
 * No production data.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshDb, run, bootstrapOwner, createUser, actorFrom, opId } from "../helpers/commands.mjs";
import { executeCommand } from "../../functions/commands/index.mjs";
import { commitWorkRequestFlow } from "../../functions/commands/commit_work_request.mjs";
import { RECEIPT_STATE } from "../../functions/domain/finance.mjs";
import { reviewPeriodClose } from "../../functions/domain/closing_review.mjs";

async function seedSpace(db, owner, name = "شقة 202 / 5") {
  const prop = await run(db, owner, "createProperty", { name: "قمة", address: "دبي" });
  const unit = await run(db, owner, "createUnit", { propertyId: prop.propertyId, name: "شقة 202", kind: "partitioned" });
  const space = await run(db, owner, "createSpace", { unitId: unit.unitId, name });
  const account = await run(db, owner, "createAccount", { name: "بنك", kind: "bank" });
  return { unit, space, account };
}

function recognized(db, spaceId) {
  return db.dump("receipts").filter((r) => r.spaceId === spaceId && r.state === RECEIPT_STATE.RECOGNIZED);
}

async function submit(db, employee, requestId, unit, space, fields, month = 8) {
  return run(db, actorFrom(employee), "submitWorkRequest", {
    requestId,
    type: "update_partition",
    desc: "تعديل",
    month,
    year: 2026,
    payloadJson: JSON.stringify({
      unitId: unit.unitId,
      partId: 5,
      fields: { ...fields, _spaceId: space.spaceId, _unitId: unit.unitId },
    }),
  }, opId(requestId));
}

test("employee correction updates the same pending request and approval uses the latest version once", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const nader = await createUser(db, owner, { displayName: "نادر", role: "employee", pin: "1111" });
  const { unit, space } = await seedSpace(db, owner);
  await submit(db, nader, "req_v1", unit, space, {
    status: "collected", rent: 1200, tenant: "هنا", start_date: "2026-09-01", collectionMethod: "cash",
  });
  await assert.rejects(
    () => run(db, actorFrom(nader), "reviseWorkRequest", {
      requestId: "req_v1",
      expectedVersion: 1,
      reason: "",
      payloadJson: "{}",
    }, opId("bad-reason")),
    (err) => err && err.code === "INVALID_FIELD",
  );
  const revised = await run(db, actorFrom(nader), "reviseWorkRequest", {
    requestId: "req_v1",
    expectedVersion: 1,
    reason: "تصحيح الإيجار قبل الاعتماد",
    payloadJson: JSON.stringify({
      unitId: unit.unitId, partId: 5,
      fields: { status: "partial", partial: true, paid_amount: 400, rent: 1200, tenant: "هناء", start_date: "2026-09-01", collectionMethod: "cash", _spaceId: space.spaceId },
    }),
  }, opId("revise"));
  assert.equal(revised.version, 2);
  assert.equal(db.dump("uiRequests").filter((r) => r.type === "update_partition").length, 1);
  const doc = db.dump("uiRequests").find((r) => r.id === "req_v1");
  assert.equal(doc.revisions.length, 2);
  assert.equal(doc.revisions[0].reason, "التقديم الأصلي");
  assert.equal(doc.revisions[1].oldValues.tenant, "هنا");
  assert.equal(doc.revisions[1].newValues.tenant, "هناء");
  await assert.rejects(
    () => run(db, owner, "commitWorkRequest", { requestId: "req_v1", expectedVersion: 1 }, opId("stale")),
    (err) => err && err.code === "STALE_REQUEST_VERSION",
  );
  assert.equal(recognized(db, space.spaceId).length, 0);
  await run(db, owner, "commitWorkRequest", { requestId: "req_v1", expectedVersion: 2 }, opId("approve-v2"));
  const again = await run(db, owner, "commitWorkRequest", { requestId: "req_v1", expectedVersion: 2 }, opId("approve-again"));
  assert.equal(again.alreadyApplied, true);
  assert.equal(recognized(db, space.spaceId).length, 1);
  assert.equal(recognized(db, space.spaceId)[0].amountFils, 40000);
  await assert.rejects(
    () => run(db, actorFrom(nader), "reviseWorkRequest", {
      requestId: "req_v1", expectedVersion: 2, reason: "بعد الاعتماد",
      payloadJson: doc.payloadJson,
    }, opId("after")),
    (err) => err && err.code === "REQUEST_NOT_EDITABLE",
  );
});

test("rejected correction creates nothing, and a deposited receipt is not reversed", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const nader = await createUser(db, owner, { displayName: "نادر", role: "employee", pin: "1111" });
  const { unit, space, account } = await seedSpace(db, owner);
  await submit(db, nader, "req_cash", unit, space, {
    status: "collected", rent: 1000, tenant: "أحمد", start_date: "2026-09-01", collectionMethod: "cash",
  });
  await run(db, owner, "commitWorkRequest", { requestId: "req_cash", expectedVersion: 1 }, opId("ok"));
  const receipt = recognized(db, space.spaceId)[0];
  const preview = await run(db, actorFrom(nader), "previewReceiptCorrection", {
    receiptId: receipt.id, correctedAmountFils: 0,
  }, opId("preview"));
  assert.equal(preview.deltaFils, -100000);
  assert.equal(preview.blocked, null);
  await run(db, actorFrom(nader), "submitReceiptCorrection", {
    requestId: "req_corr_reject", receiptId: receipt.id, reason: "تحصيل بالخطأ",
    correctedAmountFils: 0, month: 8, year: 2026,
  }, opId("corr-reject"));
  await run(db, owner, "resolveWorkRequest", { requestId: "req_corr_reject", decision: "rejected" });
  assert.equal(recognized(db, space.spaceId).length, 1);

  const deposit = await run(db, owner, "submitDeposit", {
    amountFils: 100000, depositDate: "2026-09-12", destinationAccountId: account.accountId,
    employeeId: nader.userId, sourceKind: "holding", sourcePeriod: "2026-09", period: "2026-09",
  });
  assert.equal(db.dump("deposits").find((d) => d.id === deposit.depositId).state, "approved");
  await run(db, actorFrom(nader), "submitReceiptCorrection", {
    requestId: "req_corr_dep", receiptId: receipt.id, reason: "بعد الإيداع",
    correctedAmountFils: 0, month: 8, year: 2026,
  }, opId("corr-dep"));
  await assert.rejects(
    () => run(db, owner, "commitWorkRequest", {
      requestId: "req_corr_dep", expectedVersion: 1, confirmDepositReconciliation: true,
    }, opId("corr-dep-commit")),
    (err) => err && err.code === "DEPOSIT_RECONCILIATION_REQUIRED",
  );
  assert.equal(recognized(db, space.spaceId).length, 1);
  assert.equal(db.dump("deposits").find((d) => d.id === deposit.depositId).state, "approved");
  await assert.rejects(
    () => run(db, actorFrom(nader), "applyReceiptCorrection", { requestId: "req_corr_dep", expectedVersion: 1 }, opId("emp-apply")),
    (err) => err && err.code === "CORRECTION_APPROVAL_REQUIRED",
  );
});

test("undeposited correction reverses once and keeps a valid partial", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const nader = await createUser(db, owner, { displayName: "نادر", role: "employee", pin: "1111" });
  const { unit, space } = await seedSpace(db, owner);
  await submit(db, nader, "req_full", unit, space, {
    status: "collected", rent: 1000, tenant: "أحمد", start_date: "2026-09-01", collectionMethod: "cash",
  });
  await run(db, owner, "commitWorkRequest", { requestId: "req_full", expectedVersion: 1 }, opId("full"));
  const receipt = recognized(db, space.spaceId)[0];
  await run(db, actorFrom(nader), "submitReceiptCorrection", {
    requestId: "req_partial_corr", receiptId: receipt.id, reason: "كان جزئياً",
    correctedAmountFils: 40000, month: 8, year: 2026,
  }, opId("partial-corr"));
  await run(db, owner, "commitWorkRequest", { requestId: "req_partial_corr", expectedVersion: 1 }, opId("apply-partial"));
  const again = await run(db, owner, "commitWorkRequest", { requestId: "req_partial_corr", expectedVersion: 1 }, opId("apply-partial-2"));
  assert.equal(again.alreadyApplied, true);
  const live = recognized(db, space.spaceId);
  assert.equal(live.length, 1);
  assert.equal(live[0].amountFils, 40000);
  assert.equal(db.dump("receipts").filter((r) => r.state === "reversed").length, 1);
  assert.ok(db.dump("reversals").length >= 1);
});

test("month close allows arrears and holding, blocks duplicates, and preserves the snapshot", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const { space } = await seedSpace(db, owner);
  const rental = await run(db, owner, "createRental", {
    spaceId: space.spaceId, tenantName: "أحمد", contractualAmountFils: 100000,
    dueDayOfMonth: 1, startDate: "2026-09-01",
  });
  await run(db, owner, "generateObligations", { period: "2026-09" });
  const review = await run(db, owner, "reviewAccountingClose", { period: "2026-09" }, opId("review"));
  assert.equal(review.ready, true);
  assert.ok(review.notes.some((n) => n.code === "ARREARS"));
  const closed = await run(db, owner, "closeAccountingPeriod", { period: "2026-09" }, opId("close"));
  const snapId = closed.snapshotId;
  const before = db.dump("uiConfig").find((d) => d.id === snapId).json;
  await assert.rejects(
    () => run(db, owner, "closeAccountingPeriod", { period: "2026-09" }, opId("close-2")),
    (err) => err && err.code === "ALREADY_CLOSED",
  );
  const ob = db.dump("obligations").find((o) => o.rentalId === rental.rentalId && o.period === "2026-09");
  await assert.rejects(
    () => run(db, owner, "createCashReceipt", {
      obligationId: ob.id, amountFils: 100000, collectionDate: "2026-09-05", collectorUserId: owner.userId,
    }, opId("late-cash")),
    (err) => err && err.code === "MONTH_CLOSED",
  );
  await run(db, owner, "reopenAccountingPeriod", { period: "2026-09", reason: "تصحيح معتمد" }, opId("reopen"));
  assert.equal(db.dump("uiConfig").find((d) => d.id === snapId).json, before);
  await run(db, owner, "createCashReceipt", {
    obligationId: ob.id, amountFils: 40000, collectionDate: "2026-10-02", collectorUserId: owner.userId,
  }, opId("after-reopen"));
  assert.equal(recognized(db, space.spaceId)[0].amountFils, 40000);

  db.seed("obligations", ob.id + "-dup", {
    ...ob, id: ob.id + "-dup", state: "active",
  });
  await assert.rejects(
    () => run(db, owner, "closeAccountingPeriod", { period: "2026-09" }, opId("close-dup")),
    (err) => err && err.code === "MONTH_NOT_READY",
  );
});

test("August through January uses the same rules, including a later payment of an earlier debt", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const { space } = await seedSpace(db, owner, "شقة 101 / 1");
  const rental = await run(db, owner, "createRental", {
    spaceId: space.spaceId, tenantName: "مستأجر", contractualAmountFils: 100000,
    dueDayOfMonth: 1, startDate: "2026-08-01",
  });
  const periods = ["2026-08", "2026-09", "2026-10", "2026-11", "2026-12"];
  for (const period of periods) await run(db, owner, "generateObligations", { period }, opId("gen-" + period));
  const obs = Object.fromEntries(periods.map((period) => [
    period,
    db.dump("obligations").find((o) => o.rentalId === rental.rentalId && o.period === period && o.state === "active"),
  ]));
  for (const period of periods) assert.ok(obs[period], period);
  assert.equal(new Set(periods.map((p) => obs[p].id)).size, 5);

  await run(db, owner, "createCashReceipt", {
    obligationId: obs["2026-08"].id, amountFils: 100000, collectionDate: "2026-08-02",
  }, opId("aug"));
  await run(db, owner, "createCashReceipt", {
    obligationId: obs["2026-10"].id, amountFils: 40000, collectionDate: "2026-10-03",
  }, opId("oct-partial"));
  await run(db, owner, "createCashReceipt", {
    obligationId: obs["2026-09"].id, amountFils: 100000, collectionDate: "2026-10-20",
  }, opId("sep-paid-in-oct"));
  await run(db, owner, "createCashReceipt", {
    obligationId: obs["2026-11"].id, amountFils: 100000, collectionDate: "2026-11-02",
  }, opId("nov"));
  await run(db, owner, "createCashReceipt", {
    obligationId: obs["2026-12"].id, amountFils: 100000, collectionDate: "2026-12-02",
  }, opId("dec"));
  await run(db, owner, "generateObligations", { period: "2026-10" }, opId("gen-oct-again"));
  assert.equal(db.dump("obligations").filter((o) => o.rentalId === rental.rentalId && o.period === "2026-10" && o.state === "active").length, 1);

  await run(db, owner, "endTenancy", {
    rentalId: rental.rentalId, endDate: "2027-01-01", reason: "إخلاء", arrearsDecision: "retain",
  }, opId("vacate"));
  const next = await run(db, owner, "createRental", {
    spaceId: space.spaceId, tenantName: "مستأجر جديد", contractualAmountFils: 110000,
    dueDayOfMonth: 1, startDate: "2027-01-01",
  }, opId("jan-rent"));
  await run(db, owner, "generateObligations", { period: "2027-01" }, opId("gen-jan"));
  const jan = db.dump("obligations").find((o) => o.rentalId === next.rentalId && o.period === "2027-01" && o.state === "active");
  assert.ok(jan);
  assert.equal(db.dump("obligations").filter((o) => o.spaceId === space.spaceId && o.period === "2027-01" && o.state === "active").length, 1);
  const sepPaid = db.dump("receipts").filter((r) => r.obligationId === obs["2026-09"].id && r.state === "recognized")
    .reduce((s, r) => s + r.amountFils, 0);
  assert.equal(sepPaid, 100000);
  const octPaid = db.dump("receipts").filter((r) => r.obligationId === obs["2026-10"].id && r.state === "recognized")
    .reduce((s, r) => s + r.amountFils, 0);
  assert.equal(octPaid, 40000);
});

test("employee direct policy can correct an undeposited receipt once", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const nader = await createUser(db, owner, { displayName: "نادر", role: "employee", pin: "1111" });
  const { unit, space } = await seedSpace(db, owner);
  await run(db, owner, "setCorrectionPolicy", { undeposited: "employee_direct" }, opId("policy"));
  await submit(db, nader, "req_direct", unit, space, {
    status: "collected", rent: 800, tenant: "سالم", start_date: "2026-09-01", collectionMethod: "cash",
  });
  await run(db, owner, "commitWorkRequest", { requestId: "req_direct", expectedVersion: 1 }, opId("direct-approve"));
  const receipt = recognized(db, space.spaceId)[0];
  await run(db, actorFrom(nader), "submitReceiptCorrection", {
    requestId: "req_direct_corr", receiptId: receipt.id, reason: "تحصيل خاطئ",
    correctedAmountFils: 0, month: 8, year: 2026,
  }, opId("direct-submit"));
  await run(db, actorFrom(nader), "applyReceiptCorrection", {
    requestId: "req_direct_corr", expectedVersion: 1,
  }, opId("direct-apply"));
  assert.equal(recognized(db, space.spaceId).length, 0);
  const reversed = db.dump("receipts").filter((r) => r.state === "reversed");
  assert.equal(reversed.length, 1);
  const reversal = db.dump("reversals")[0];
  assert.equal(reversal.createdBy, nader.userId);
  const reversalAudit = db.dump("auditEvents").filter((e) => e.action === "receipt_reversed");
  assert.equal(reversalAudit.length, 1);
  assert.equal(reversalAudit[0].actorUserId, nader.userId);
  assert.equal(reversalAudit[0].actorRole, "employee");
  const second = await run(db, actorFrom(nader), "applyReceiptCorrection", {
    requestId: "req_direct_corr", expectedVersion: 1,
  }, opId("direct-apply-2"));
  assert.equal(second.alreadyApplied, true);
});

test("reviewPeriodClose does not treat legitimate partials or arrears as duplicates", () => {
  const report = reviewPeriodClose({
    period: "2026-09",
    obligations: [{ id: "ob1", rentalId: "r1", spaceId: "s1", period: "2026-09", state: "active", amountFils: 100000 }],
    receipts: [
      { id: "a", obligationId: "ob1", period: "2026-09", state: "recognized", amountFils: 40000, method: "cash" },
      { id: "b", obligationId: "ob1", period: "2026-09", state: "recognized", amountFils: 30000, method: "cash", collectionDate: "2026-09-02" },
    ],
    deposits: [],
    rentals: [{ id: "r1", spaceId: "s1", state: "active", startDate: "2026-09-01", endDate: null }],
    requests: [],
  });
  assert.equal(report.ready, true);
  assert.equal(report.blockers.length, 0);
  assert.ok(report.notes.some((n) => n.code === "ARREARS"));
});

test("an employee correction grant cannot run owner commands or a mismatched receipt", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const nader = await createUser(db, owner, { displayName: "نادر", role: "employee", pin: "1111" });
  const employee = actorFrom(nader);
  const forged = { kind: "receipt_correction", requestId: "req_forged" };
  for (const [command, payload] of [
    ["createUser", { displayName: "دخيل", role: "owner", pin: "9999" }],
    ["reverseDeposit", { depositId: "dep_x", reason: "لا" }],
    ["closeAccountingPeriod", { period: "2026-09" }],
    ["commitWorkRequest", { requestId: "req_forged" }],
    ["reverseReceipt", { receiptId: "rcpt_x", reason: "لا" }],
    ["approveBankReceipt", { receiptId: "rcpt_x" }],
  ]) {
    await assert.rejects(
      () => run(db, employee, command, payload, opId("no-" + command)),
      (err) => err && err.code === "FORBIDDEN",
      command,
    );
    await assert.rejects(
      () => executeCommand({
        db, actor: employee, command, payload, operationId: opId("grant-" + command),
        now: new Date().toISOString(), grant: forged,
      }),
      (err) => err && err.code === "FORBIDDEN",
      "grant " + command,
    );
  }
});

test("a stuck approval resumes the same steps and does not duplicate money", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const nader = await createUser(db, owner, { displayName: "نادر", role: "employee", pin: "1111" });
  const { unit, space } = await seedSpace(db, owner);

  await submit(db, nader, "req_before", unit, space, {
    status: "collected", rent: 1000, tenant: "قبل", start_date: "2026-09-01", collectionMethod: "cash",
    _spaceId: "missing-space",
  });
  await db.runTransaction((tx) => tx.update("uiRequests", "req_before", {
    payloadJson: JSON.stringify({
      unitId: unit.unitId, partId: 5,
      fields: { status: "collected", rent: 1000, tenant: "قبل", start_date: "2026-09-01", _spaceId: "missing-space", _unitId: unit.unitId },
    }),
  }));
  await assert.rejects(
    () => run(db, owner, "commitWorkRequest", { requestId: "req_before", expectedVersion: 1 }, opId("before")),
    (err) => err && err.code === "SPACE_NOT_FOUND",
  );
  assert.equal((await db.runTransaction((tx) => tx.get("uiRequests", "req_before"))).status, "pending");
  assert.equal(db.dump("receipts").length, 0);
  assert.equal(db.dump("operations").filter((op) => String(op.operationId).startsWith("cwr-req_before-")).length, 0);

  await submit(db, nader, "req_during", unit, space, {
    status: "collected", rent: 800, tenant: "أثناء", start_date: "2026-10-01", collectionMethod: "cash",
  }, 9);
  const now = new Date().toISOString();
  const runStep = (who, cmd, body, op, grant) => executeCommand({
    db, actor: who, command: cmd, payload: body, operationId: op, now, grant,
  });
  let steps = 0;
  await assert.rejects(
    () => commitWorkRequestFlow({
      db, actor: owner, payload: { requestId: "req_during", expectedVersion: 1 },
      operationId: opId("during"), now,
      run: async (...args) => {
        const result = await runStep(...args);
        steps += 1;
        if (steps === 1) throw Object.assign(new Error("INTERRUPT"), { code: "INTERRUPT" });
        return result;
      },
    }),
    (err) => err && err.code === "INTERRUPT",
  );
  const stuck = await db.runTransaction((tx) => tx.get("uiRequests", "req_during"));
  assert.equal(stuck.status, "processing");
  assert.ok(db.dump("operations").some((op) => String(op.operationId).startsWith("cwr-req_during-")));
  await assert.rejects(
    () => run(db, owner, "commitWorkRequest", { requestId: "req_during", expectedVersion: 1 }, opId("during-auto")),
    (err) => err && err.code === "REQUEST_BEING_APPROVED",
  );
  await assert.rejects(
    () => run(db, actorFrom(nader), "reviseWorkRequest", {
      requestId: "req_during", expectedVersion: 1, reason: "تغيير بعد الحركة",
      payloadJson: JSON.stringify({ unitId: unit.unitId, partId: 5, fields: { rent: 1, _spaceId: space.spaceId } }),
    }, opId("during-revise")),
    (err) => err && (err.code === "REQUEST_NOT_EDITABLE" || err.code === "REQUEST_PARTIALLY_APPLIED"),
  );
  await db.runTransaction((tx) => tx.update("uiRequests", "req_during", { status: "pending" }));
  await assert.rejects(
    () => run(db, actorFrom(nader), "reviseWorkRequest", {
      requestId: "req_during", expectedVersion: 1, reason: "تغيير بعد الحركة",
      payloadJson: JSON.stringify({ unitId: unit.unitId, partId: 5, fields: { rent: 1, _spaceId: space.spaceId } }),
    }, opId("during-revise-pending")),
    (err) => err && err.code === "REQUEST_PARTIALLY_APPLIED",
  );
  await assert.rejects(
    () => run(db, owner, "resolveWorkRequest", { requestId: "req_during", decision: "pending" }, opId("during-reopen")),
    (err) => err && err.code === "REQUEST_PARTIALLY_APPLIED",
  );
  await db.runTransaction((tx) => tx.update("uiRequests", "req_during", { status: "processing" }));
  const resumed = await run(db, owner, "commitWorkRequest", {
    requestId: "req_during", expectedVersion: 1, resume: true,
  }, opId("during-resume"));
  assert.equal(resumed.status, "approved");
  assert.equal(recognized(db, space.spaceId).length, 1);
  const again = await run(db, owner, "commitWorkRequest", {
    requestId: "req_during", expectedVersion: 1,
  }, opId("after"));
  assert.equal(again.alreadyApplied, true);
  assert.equal(recognized(db, space.spaceId).length, 1);
  assert.equal(db.dump("obligations").filter((o) => o.spaceId === space.spaceId && o.state === "active").length, 1);
});

test("closing September leaves October through January unchanged and holding does not block", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const { space } = await seedSpace(db, owner, "شقة 101 / 2");
  const rental = await run(db, owner, "createRental", {
    spaceId: space.spaceId, tenantName: "مستأجر", contractualAmountFils: 100000,
    dueDayOfMonth: 1, startDate: "2026-09-01",
  });
  const periods = ["2026-09", "2026-10", "2026-11", "2026-12", "2027-01"];
  for (const period of periods) await run(db, owner, "generateObligations", { period }, opId("span-" + period));
  const byPeriod = Object.fromEntries(periods.map((period) => [
    period,
    db.dump("obligations").find((o) => o.rentalId === rental.rentalId && o.period === period),
  ]));
  await run(db, owner, "createCashReceipt", {
    obligationId: byPeriod["2026-09"].id, amountFils: 40000, collectionDate: "2026-09-10",
  }, opId("sep-hold"));
  await run(db, owner, "createCashReceipt", {
    obligationId: byPeriod["2026-10"].id, amountFils: 100000, collectionDate: "2026-10-02",
  }, opId("oct-full"));
  const before = JSON.stringify(db.dump("receipts").concat(db.dump("obligations")).map((row) => ({
    id: row.id, period: row.period, amountFils: row.amountFils, state: row.state, obligationId: row.obligationId,
  })));
  const review = await run(db, owner, "reviewAccountingClose", { period: "2026-09" }, opId("sep-review"));
  assert.equal(review.ready, true);
  assert.ok(review.notes.some((n) => n.code === "ARREARS"));
  assert.ok(review.notes.some((n) => n.code === "UNDEPOSITED_HOLDING"));
  await run(db, owner, "closeAccountingPeriod", { period: "2026-09" }, opId("sep-close"));
  const after = JSON.stringify(db.dump("receipts").concat(db.dump("obligations")).map((row) => ({
    id: row.id, period: row.period, amountFils: row.amountFils, state: row.state, obligationId: row.obligationId,
  })));
  assert.equal(after, before);
  for (const period of ["2026-10", "2026-11", "2026-12", "2027-01"]) {
    const later = await run(db, owner, "reviewAccountingClose", { period }, opId("later-" + period));
    assert.equal(later.blockers.some((b) => b.code === "DUPLICATE_OBLIGATION"), false, period);
  }

  db.seed("obligations", byPeriod["2026-10"].id + "-dup", {
    ...byPeriod["2026-10"], id: byPeriod["2026-10"].id + "-dup", state: "active",
  });
  await assert.rejects(
    () => run(db, owner, "closeAccountingPeriod", { period: "2026-10" }, opId("oct-dup")),
    (err) => err && err.code === "MONTH_NOT_READY",
  );
  const overpaid = { ...byPeriod["2026-11"], id: "ob-over", amountFils: 1000, state: "active" };
  db.seed("obligations", overpaid.id, overpaid);
  db.seed("receipts", "rcpt-over", {
    id: "rcpt-over", obligationId: overpaid.id, spaceId: space.spaceId, period: "2026-11",
    state: "recognized", amountFils: 5000, method: "cash",
  });
  await assert.rejects(
    () => run(db, owner, "closeAccountingPeriod", { period: "2026-11" }, opId("nov-over")),
    (err) => err && err.code === "MONTH_NOT_READY",
  );
  db.seed("receipts", "rcpt-orphan", {
    id: "rcpt-orphan", obligationId: "missing-obligation", spaceId: space.spaceId, period: "2026-12",
    state: "recognized", amountFils: 1000, method: "cash",
  });
  await assert.rejects(
    () => run(db, owner, "closeAccountingPeriod", { period: "2026-12" }, opId("dec-orphan")),
    (err) => err && err.code === "MONTH_NOT_READY",
  );
});
