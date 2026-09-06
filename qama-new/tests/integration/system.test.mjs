import test from "node:test";
import assert from "node:assert/strict";
import { freshDb, run, bootstrapOwner, seedBuilding, createUser, actorFrom, opId } from "../helpers/commands.mjs";
import { executeCommand, PERMISSIONS, SCHEMAS } from "../../functions/commands/index.mjs";
import { verifyPinConstantTime } from "../../functions/auth/index.mjs";
import { STATUS, RECEIPT_STATE, APPROVAL_STATE } from "../../src/domain/finance.mjs";
import { buildDashboardFromDump } from "../../functions/services/readModel.mjs";

async function setup() {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const building = await seedBuilding(db, owner);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const nader = await createUser(db, owner, { displayName: "نادر", role: "employee", pin: "2026" });
  return { db, owner, building, yahia, nader };
}

test("permission matrix completeness", () => {
  for (const cmd of Object.keys(SCHEMAS)) {
    assert.ok(PERMISSIONS[cmd], `missing permission for ${cmd}`);
  }
});

test("M1 command: status collected rejected as UNKNOWN_FIELD", async () => {
  const { db, owner, building } = await setup();
  await assert.rejects(
    () => run(db, owner, "createCashReceipt", {
      obligationId: building.obligationId,
      amountFils: 900000,
      collectionDate: "2026-09-05",
      status: "collected",
    }),
    (e) => e.code === "UNKNOWN_FIELD"
  );
  const dash = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.equal(dash.summary.collectedFils, 0);
});

test("M1 command: partial then collected", async () => {
  const { db, building, yahia, nader } = await setup();
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 900000, collectionDate: "2026-09-05",
  });
  let dash = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.equal(dash.summary.collectedFils, 900000);
  assert.equal(dash.summary.remainingFils, 20000);
  assert.equal(dash.obligations[0].status, STATUS.PARTIAL);

  await run(db, actorFrom(nader), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 20000, collectionDate: "2026-09-06",
  });
  dash = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.equal(dash.summary.collectedFils, 920000);
  assert.equal(dash.obligations[0].status, STATUS.COLLECTED);
});

test("M2 command: shared holding across collectors", async () => {
  const { db, building, yahia, nader } = await setup();
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 500000, collectionDate: "2026-09-05",
  });
  await run(db, actorFrom(nader), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 400000, collectionDate: "2026-09-05",
  });
  const dash = buildDashboardFromDump(db, building.period, "2026-09-15");
  const y = dash.custody.find((c) => c.userId === yahia.userId);
  const n = dash.custody.find((c) => c.userId === nader.userId);
  assert.equal(y.cashCollectedFils, 500000);
  assert.equal(n.cashCollectedFils, 400000);
  assert.equal(dash.summary.holdingFils, 900000);
  assert.equal(dash.summary.sharedEmployeeHoldingFils, 900000);
});

test("M5 command: deposit lifecycle", async () => {
  const { db, owner, building, yahia } = await setup();
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 500000, collectionDate: "2026-09-05",
  });
  const dep = await run(db, actorFrom(yahia), "submitDeposit", {
    amountFils: 300000, depositDate: "2026-09-06", destinationAccountId: building.account.accountId,
  });
  let dash = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.equal(dash.summary.holdingFils, 500000);
  assert.equal(dash.summary.pendingDepositsFils, 300000);

  const approveOid = opId("approve-dep");
  await run(db, owner, "approveDeposit", { depositId: dep.depositId }, approveOid);
  dash = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.equal(dash.summary.holdingFils, 200000);
  assert.equal(dash.summary.depositedFils, 300000);

  const replay = await run(db, owner, "approveDeposit", { depositId: dep.depositId }, approveOid);
  assert.equal(replay.state, APPROVAL_STATE.APPROVED);
  dash = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.equal(dash.summary.holdingFils, 200000);
});

test("M6 command: bank pending then approved", async () => {
  const { db, owner, building, yahia } = await setup();
  const bank = await run(db, actorFrom(yahia), "submitBankReceipt", {
    obligationId: building.obligationId, amountFils: 300000, collectionDate: "2026-09-05", bankReference: "TRX1",
  });
  let dash = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.equal(dash.summary.collectedFils, 0);
  assert.equal(dash.summary.holdingFils, 0);

  await run(db, owner, "approveBankReceipt", { receiptId: bank.receiptId });
  dash = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.equal(dash.summary.collectedFils, 300000);
  assert.equal(dash.summary.depositedFils, 300000);
  assert.equal(dash.summary.holdingFils, 0);
});

test("M7 command: reversal", async () => {
  const { db, owner, building, yahia } = await setup();
  const rcpt = await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 400000, collectionDate: "2026-09-05",
  });
  await run(db, owner, "reverseReceipt", { receiptId: rcpt.receiptId, reason: "خطأ" });
  const dash = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.equal(dash.summary.collectedFils, 0);
  assert.equal(dash.custody.length, 0);
  await assert.rejects(
    () => run(db, owner, "reverseReceipt", { receiptId: rcpt.receiptId, reason: "again" }),
    (e) => e.code === "ALREADY_REVERSED"
  );
});

test("S1 employee cannot create property", async () => {
  const { db, yahia } = await setup();
  await assert.rejects(
    () => run(db, actorFrom(yahia), "createProperty", { name: "x" }),
    (e) => e.code === "FORBIDDEN"
  );
});

test("S2 role in payload ignored — still forbidden for employee", async () => {
  const { db, yahia } = await setup();
  await assert.rejects(
    () => run(db, actorFrom(yahia), "approveDeposit", { depositId: "dep:x", role: "owner" }),
    (e) => e.code === "FORBIDDEN"
  );
});

test("S4 unitId on deposit rejected", async () => {
  const { db, yahia, building } = await setup();
  await assert.rejects(
    () => run(db, actorFrom(yahia), "submitDeposit", {
      amountFils: 100, depositDate: "2026-09-06", destinationAccountId: building.account.accountId, unitId: "u1",
    }),
    (e) => e.code === "UNKNOWN_FIELD"
  );
});

test("S5 collectorUserId forged on cash receipt ignored for employee", async () => {
  const { db, yahia, building } = await setup();
  // Schema allows optional collectorUserId for owner attribution; employees are forced to self.
  const rcpt = await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 1000, collectionDate: "2026-09-05", collectorUserId: "other",
  });
  const doc = db.dump("receipts").find((r) => r.id === rcpt.receiptId);
  assert.equal(doc.collectorUserId, yahia.userId);
});

test("S8 deactivated user rejected", async () => {
  const { db, owner, yahia } = await setup();
  await run(db, owner, "deactivateUser", { userId: yahia.userId });
  await assert.rejects(
    () => executeCommand({
      db, actor: { ...actorFrom(yahia), active: false }, command: "createCashReceipt",
      payload: { obligationId: "x", amountFils: 100, collectionDate: "2026-09-05" },
      operationId: opId(), now: new Date().toISOString(),
    }),
    (e) => e.code === "ACCOUNT_DISABLED"
  );
});

test("S9 unknown command rejected", async () => {
  const { db, owner } = await setup();
  await assert.rejects(
    () => executeCommand({
      db, actor: owner, command: "forgeHolding", payload: {}, operationId: opId(), now: new Date().toISOString(),
    }),
    (e) => e.code === "UNKNOWN_COMMAND"
  );
});

test("idempotency: same operationId replays", async () => {
  const { db, owner, building, yahia } = await setup();
  const oid = opId("idem");
  const p = { obligationId: building.obligationId, amountFils: 10000, collectionDate: "2026-09-05" };
  const r1 = await run(db, actorFrom(yahia), "createCashReceipt", p, oid);
  const r2 = await run(db, actorFrom(yahia), "createCashReceipt", p, oid);
  assert.equal(r1.receiptId, r2.receiptId);
  assert.equal(r2.replay, true);
  assert.equal(db.dump("receipts").length, 1);
});

test("idempotency: payload mismatch rejected", async () => {
  const { db, building, yahia } = await setup();
  const oid = opId("idem-mismatch");
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 10000, collectionDate: "2026-09-05",
  }, oid);
  await assert.rejects(
    () => run(db, actorFrom(yahia), "createCashReceipt", {
      obligationId: building.obligationId, amountFils: 20000, collectionDate: "2026-09-05",
    }, oid),
    (e) => e.code === "IDEMPOTENCY_PAYLOAD_MISMATCH"
  );
});

test("D2 overpayment at command layer", async () => {
  const { db, building, yahia } = await setup();
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 900000, collectionDate: "2026-09-05",
  });
  await assert.rejects(
    () => run(db, actorFrom(yahia), "createCashReceipt", {
      obligationId: building.obligationId, amountFils: 30000, collectionDate: "2026-09-06",
    }),
    (e) => e.code === "AMOUNT_EXCEEDS_REMAINING"
  );
});

test("float money rejected by schema", async () => {
  const { db, building, yahia } = await setup();
  await assert.rejects(
    () => run(db, actorFrom(yahia), "createCashReceipt", {
      obligationId: building.obligationId, amountFils: 100.5, collectionDate: "2026-09-05",
    }),
    (e) => e.code === "INVALID_FIELD"
  );
});

test("PIN hashing works on createUser", async () => {
  const { db, owner } = await setup();
  const u = await createUser(db, owner, { displayName: "test", role: "employee", pin: "1234" });
  const doc = await db.getUser(u.userId);
  assert.ok(verifyPinConstantTime("1234", doc));
  assert.equal(verifyPinConstantTime("9999", doc), false);
});

test("vacant occupancy closes rental and drops unpaid target", async () => {
  const { db, owner, building } = await setup();
  const before = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.ok(before.summary.targetFils > 0);
  await run(db, owner, "setSpaceOccupancy", { spaceId: building.space.spaceId, occupancy: "vacant" });
  const after = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.equal(after.summary.targetFils, 0);
  assert.equal(after.summary.remainingFils, 0);
  const space = db.dump("spaces").find((s) => s.id === building.space.spaceId);
  assert.equal(space.occupancy, "vacant");
  const rental = db.dump("rentals").find((r) => r.id === building.rental.rentalId);
  assert.equal(rental.state, "closed");
  const ob = db.dump("obligations").find((o) => o.id === building.obligationId);
  assert.equal(ob.state, "cancelled");
});

test("close rental after cash keeps holding (إخلاء ≠ إلغاء تحصيل); uncollect clears it", async () => {
  const { db, owner, building, yahia } = await setup();
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 920000, collectionDate: "2026-09-05",
  });
  const mid = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.equal(mid.summary.sharedEmployeeHoldingFils, 920000);
  await run(db, owner, "closeRental", {
    rentalId: building.rental.rentalId, endDate: "2026-09-30", reason: "انتهاء", setVacant: true,
  });
  const afterClose = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.equal(afterClose.summary.targetFils, 0);
  // Paid cash remains in Shared Holding until deposit or explicit uncollect/reverse.
  assert.equal(afterClose.summary.sharedEmployeeHoldingFils, 920000);
  const rcpt = db.dump("receipts").find((r) => r.obligationId === building.obligationId);
  assert.equal(rcpt.state, "recognized");
  await run(db, owner, "uncollectObligation", {
    obligationId: building.obligationId, reason: "إلغاء تحصيل خاطئ",
  });
  const afterUncol = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.equal(afterUncol.summary.sharedEmployeeHoldingFils, 0);
  assert.equal(db.dump("receipts").find((r) => r.id === rcpt.id).state, "reversed");
});

test("vacate after cash: holding unchanged; double vacate safe; uncollect once", async () => {
  const { db, owner, building, yahia } = await setup();
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 17700, collectionDate: "2026-09-06",
  }, opId("vac-cash-177"));
  assert.equal(buildDashboardFromDump(db, building.period, "2026-09-15").summary.sharedEmployeeHoldingFils, 17700);
  await run(db, owner, "setSpaceOccupancy", {
    spaceId: building.space.spaceId, occupancy: "vacant",
  }, opId("vac-177-a"));
  assert.equal(buildDashboardFromDump(db, building.period, "2026-09-15").summary.sharedEmployeeHoldingFils, 17700);
  await run(db, owner, "setSpaceOccupancy", {
    spaceId: building.space.spaceId, occupancy: "vacant",
  }, opId("vac-177-b"));
  assert.equal(buildDashboardFromDump(db, building.period, "2026-09-15").summary.sharedEmployeeHoldingFils, 17700);
  await run(db, owner, "uncollectObligation", {
    obligationId: building.obligationId, reason: "إلغاء تحصيل",
  }, opId("vac-177-uncol"));
  assert.equal(buildDashboardFromDump(db, building.period, "2026-09-15").summary.sharedEmployeeHoldingFils, 0);
  const revCount = db.dump("receipts").filter((r) => r.obligationId === building.obligationId && r.state === "reversed").length;
  assert.equal(revCount, 1);
});

test("cancel obligation with receipts refused", async () => {
  const { db, owner, building, yahia } = await setup();
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 1000, collectionDate: "2026-09-05",
  });
  await assert.rejects(
    () => run(db, owner, "cancelObligation", { obligationId: building.obligationId, reason: "x" }),
    (e) => e.code === "OBLIGATION_HAS_RECEIPTS"
  );
});

test("deposit exceeds holding refused", async () => {
  const { db, building, yahia } = await setup();
  await assert.rejects(
    () => run(db, actorFrom(yahia), "submitDeposit", {
      amountFils: 1000, depositDate: "2026-09-06", destinationAccountId: building.account.accountId,
    }),
    (e) => e.code === "AMOUNT_EXCEEDS_HOLDING"
  );
});

test("J1 race: two collectors for last 200 — one succeeds one fails", async () => {
  const { db, building, yahia, nader } = await setup();
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 900000, collectionDate: "2026-09-05",
  });
  const results = await Promise.allSettled([
    run(db, actorFrom(yahia), "createCashReceipt", {
      obligationId: building.obligationId, amountFils: 20000, collectionDate: "2026-09-06",
    }, opId("race-y")),
    run(db, actorFrom(nader), "createCashReceipt", {
      obligationId: building.obligationId, amountFils: 20000, collectionDate: "2026-09-06",
    }, opId("race-n")),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled").length;
  const fail = results.filter((r) => r.status === "rejected").length;
  assert.equal(ok, 1);
  assert.equal(fail, 1);
  const dash = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.equal(dash.summary.collectedFils, 920000);
  assert.equal(dash.summary.remainingFils, 0);
});

test("J2 duplicate deposit approval — holding reduced once", async () => {
  const { db, owner, building, yahia } = await setup();
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 500000, collectionDate: "2026-09-05",
  });
  const dep = await run(db, actorFrom(yahia), "submitDeposit", {
    amountFils: 300000, depositDate: "2026-09-06", destinationAccountId: building.account.accountId,
  });
  const oid = opId("dup-approve");
  await run(db, owner, "approveDeposit", { depositId: dep.depositId }, oid);
  await run(db, owner, "approveDeposit", { depositId: dep.depositId }, oid);
  const dash = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.equal(dash.summary.holdingFils, 200000);
});

test("J3 deposit approval racing new collection", async () => {
  const { db, owner, building, yahia } = await setup();
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 500000, collectionDate: "2026-09-05",
  });
  const dep = await run(db, actorFrom(yahia), "submitDeposit", {
    amountFils: 300000, depositDate: "2026-09-06", destinationAccountId: building.account.accountId,
  });
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 20000, collectionDate: "2026-09-07",
  });
  await run(db, owner, "approveDeposit", { depositId: dep.depositId });
  const dash = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.ok(dash.summary.holdingFils >= 0);
  assert.equal(dash.summary.holdingFils, 220000);
  assert.equal(dash.summary.collectedFils, 520000);
});

test("generateObligations idempotent", async () => {
  const { db, owner, building } = await setup();
  const r1 = await run(db, owner, "generateObligations", { period: building.period }, opId("gen1"));
  const r2 = await run(db, owner, "generateObligations", { period: building.period }, opId("gen2"));
  assert.equal(r1.created, 0);
  assert.equal(r2.created, 0);
});

test("expense submit and approve", async () => {
  const { db, owner, building, yahia } = await setup();
  const exp = await run(db, actorFrom(yahia), "submitExpense", {
    amountFils: 50000, reason: "صيانة", category: "ops", expenseDate: "2026-09-10",
    paidFromAccountId: building.account.accountId,
  });
  await run(db, owner, "approveExpense", { expenseId: exp.expenseId });
  const dash = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.equal(dash.summary.expensesFils, 50000);
});

test("updateUser cannot be called by employee", async () => {
  const { db, yahia } = await setup();
  await assert.rejects(
    () => run(db, actorFrom(yahia), "updateUser", { userId: yahia.userId, displayName: "hack" }),
    (e) => e.code === "FORBIDDEN"
  );
});

test("approvedBy forged on bank approve rejected", async () => {
  const { db, owner, building, yahia } = await setup();
  const bank = await run(db, actorFrom(yahia), "submitBankReceipt", {
    obligationId: building.obligationId, amountFils: 10000, collectionDate: "2026-09-05", bankReference: "B1",
  });
  await assert.rejects(
    () => run(db, owner, "approveBankReceipt", { receiptId: bank.receiptId, approvedBy: "evil" }),
    (e) => e.code === "UNKNOWN_FIELD"
  );
});

test("S3 employee MAY deposit from shared pool without personal collections", async () => {
  const { db, building, yahia, nader } = await setup();
  await run(db, actorFrom(nader), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 100000, collectionDate: "2026-09-05",
  });
  const dep = await run(db, actorFrom(yahia), "submitDeposit", {
    amountFils: 50000, depositDate: "2026-09-06", destinationAccountId: building.account.accountId,
  });
  assert.equal(dep.state, APPROVAL_STATE.PENDING);
  const dash = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.equal(dash.summary.holdingFils, 100000);
});

test("employeeId on deposit submit ignored for employee", async () => {
  const { db, yahia, nader, building } = await setup();
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 500000, collectionDate: "2026-09-05",
  });
  const dep = await run(db, actorFrom(yahia), "submitDeposit", {
    amountFils: 100000, depositDate: "2026-09-06", destinationAccountId: building.account.accountId, employeeId: nader.userId,
  });
  const doc = db.dump("deposits").find((d) => d.id === dep.depositId);
  assert.equal(doc.employeeId, yahia.userId);
});

test("SHARED command: Nader deposits 7000 from combined 9000 → holding 2000", async () => {
  const { db, owner, building, yahia, nader } = await setup();
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 500000, collectionDate: "2026-09-05",
  });
  await run(db, actorFrom(nader), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 400000, collectionDate: "2026-09-05",
  });
  let dash = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.equal(dash.summary.holdingFils, 900000);
  const dep = await run(db, actorFrom(nader), "submitDeposit", {
    amountFils: 700000, depositDate: "2026-09-06", destinationAccountId: building.account.accountId,
  });
  dash = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.equal(dash.summary.holdingFils, 900000, "pending must not reduce");
  await run(db, owner, "approveDeposit", { depositId: dep.depositId });
  dash = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.equal(dash.summary.holdingFils, 200000);
});

test("SHARED command: reverse blocked when shared holding would go negative", async () => {
  const { db, owner, building, yahia, nader } = await setup();
  const y = await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 500000, collectionDate: "2026-09-05",
  });
  await run(db, actorFrom(nader), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 400000, collectionDate: "2026-09-05",
  });
  const dep = await run(db, actorFrom(nader), "submitDeposit", {
    amountFils: 700000, depositDate: "2026-09-06", destinationAccountId: building.account.accountId,
  });
  await run(db, owner, "approveDeposit", { depositId: dep.depositId });
  await assert.rejects(
    () => run(db, owner, "reverseReceipt", { receiptId: y.receiptId, reason: "too much deposited" }),
    (e) => e.code === "RECEIPT_ALREADY_DEPOSITED"
  );
  const small = await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 20000, collectionDate: "2026-09-07",
  });
  // holding was 2000 + 200 = 2200; reverse 200 → 2000 allowed
  await run(db, owner, "reverseReceipt", { receiptId: small.receiptId, reason: "ok" });
  const dash = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.equal(dash.summary.holdingFils, 200000);
});

test("payInstallment: debit+paid atomic; second session alreadyApplied; replay safe", async () => {
  const { db, owner } = await setup();
  const schedule = [
    { date: "2026-06-30", amount: 179294, paid: false },
    { date: "2026-09-30", amount: 179294, paid: false },
  ];
  await run(db, owner, "upsertUiConfig", {
    configId: "balances",
    json: JSON.stringify({
      companyBalance: 0,
      revenueBalance: 0,
      installmentBalance: 200000,
      installmentSchedule: schedule,
    }),
  });
  const amountFils = 17929400;
  const r1 = await run(db, owner, "payInstallment", {
    installmentDate: "2026-06-30", amountFils,
  }, "instpay-2026-06-30-17929400");
  assert.equal(r1.alreadyApplied, false);
  assert.equal(r1.installmentBalance, 20706);
  assert.equal(r1.paidCount, 1);

  // Lost-response retry — same operationId
  const replay = await executeCommand({
    db, actor: owner, command: "payInstallment",
    payload: { installmentDate: "2026-06-30", amountFils },
    operationId: "instpay-2026-06-30-17929400",
    now: new Date().toISOString(),
  });
  assert.equal(replay.replay, true);
  assert.equal(replay.installmentBalance, 20706);

  // Second session / different operationId — must not double-debit
  const r2 = await run(db, owner, "payInstallment", {
    installmentDate: "2026-06-30", amountFils,
  }, "instpay-session2-2026-06-30-17929400");
  assert.equal(r2.alreadyApplied, true);
  assert.equal(r2.installmentBalance, 20706);

  const cfg = db.dump("uiConfig").find((d) => d.id === "balances");
  const obj = JSON.parse(cfg.json);
  assert.equal(obj.installmentBalance, 20706);
  assert.equal(obj.installmentSchedule.filter((x) => x.paid).length, 1);
});
