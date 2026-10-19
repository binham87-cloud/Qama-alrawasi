/**
 * October invalid-receipt correction, local only.
 * Reverses the extra receipt, keeps the legitimate one, and does not
 * rewrite deposits or September history.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshDb, run, bootstrapOwner, createUser, actorFrom, opId } from "../helpers/commands.mjs";
import { buildDashboardFromDump } from "../../functions/services/readModel.mjs";
import { sharedHoldingFils } from "../../functions/domain/finance.mjs";
import { occupancyBookingsForPeriod } from "../../functions/domain/daily_booking.mjs";

async function spaceOf(db, owner, name, rent, start) {
  const prop = await run(db, owner, "createProperty", { name: "قمة", address: "دبي" }, opId("prop"));
  const unit = await run(db, owner, "createUnit", { propertyId: prop.propertyId, name, kind: "partitioned" }, opId("unit"));
  const space = await run(db, owner, "createSpace", { unitId: unit.unitId, name }, opId("space"));
  const account = await run(db, owner, "createAccount", { name: "بنك", kind: "bank" }, opId("acct"));
  const rental = await run(db, owner, "createRental", {
    spaceId: space.spaceId, tenantName: "المستأجر الأول", contractualAmountFils: rent,
    dueDayOfMonth: Number(String(start).slice(8, 10)) || 1, startDate: start,
  }, opId("rent"));
  const period = String(start).slice(0, 7);
  await run(db, owner, "generateObligations", { period }, opId("gen"));
  const obligation = db.dump("obligations").find((row) =>
    row.rentalId === rental.rentalId && row.period === period && row.state === "active");
  assert.ok(obligation);
  return { space, account, rental, obligation, period };
}

function octoberSummary(db) {
  return buildDashboardFromDump(db, "2026-10", "2026-10-18").summary;
}

test("reversing the later October receipt keeps the first, the deposit, and the audit trail", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const nader = await createUser(db, owner, { displayName: "نادر", role: "employee", pin: "1111" });
  const { space, account, rental, obligation } = await spaceOf(db, owner, "شقة 202 / 1", 120000, "2026-10-01");
  await run(db, actorFrom(nader), "createCashReceipt", {
    obligationId: obligation.id, amountFils: 50000, collectionDate: "2026-10-05",
  }, opId("part"));
  await run(db, actorFrom(nader), "createCashReceipt", {
    obligationId: obligation.id, amountFils: 70000, collectionDate: "2026-10-06",
  }, opId("rest"));
  const kept = db.dump("receipts").filter((row) => row.obligationId === obligation.id && row.state === "recognized");
  assert.equal(kept.length, 2);
  assert.equal(kept.reduce((sum, row) => sum + row.amountFils, 0), 120000);

  const laterObligationId = `${obligation.id}:later`;
  const laterRentalId = `${rental.rentalId}:later`;
  db.seed("rentals", laterRentalId, {
    id: laterRentalId, spaceId: space.spaceId, unitId: obligation.unitId, propertyId: obligation.propertyId,
    tenantName: "المستأجر الثاني", contractualAmountFils: 120000, startDate: "2026-10-12",
    endDate: null, state: "active", dueDayOfMonth: 12,
  });
  db.seed("obligations", laterObligationId, {
    ...obligation, id: laterObligationId, rentalId: laterRentalId, cycleStart: "2026-10-12", dueDate: "2026-10-12",
  });
  const invalidId = "rcpt:october-invalid-duplicate";
  db.seed("receipts", invalidId, {
    id: invalidId, obligationId: laterObligationId, rentalId: laterRentalId,
    propertyId: obligation.propertyId, unitId: obligation.unitId, spaceId: space.spaceId,
    period: "2026-10", amountFils: 120000, collectionDate: "2026-10-12", method: "cash",
    state: "recognized", collectorUserId: nader.userId, sourceType: null,
  });
  await run(db, owner, "submitDeposit", {
    amountFils: 100000, depositDate: "2026-10-15", destinationAccountId: account.accountId,
    employeeId: nader.userId, sourceKind: "holding", sourcePeriod: "2026-10", period: "2026-10",
  }, opId("dep"));
  const depositBefore = db.dump("deposits")[0];
  const before = octoberSummary(db);
  assert.equal(before.collectedFils, 240000);

  const reversed = await run(db, owner, "reverseReceipt", {
    receiptId: invalidId, reason: "إيصال أكتوبر غير مستلم",
  }, opId("rev"));
  assert.ok(reversed.reversalId);
  const invalid = db.dump("receipts").find((row) => row.id === invalidId);
  assert.equal(invalid.state, "reversed");
  assert.equal(invalid.reversedByReversalId, reversed.reversalId);
  assert.equal(db.dump("reversals").some((row) => row.id === reversed.reversalId && row.targetId === invalidId), true);
  for (const row of kept) {
    const live = db.dump("receipts").find((item) => item.id === row.id);
    assert.equal(live.state, "recognized");
    assert.equal(live.collectorUserId, nader.userId);
  }
  const depositAfter = db.dump("deposits")[0];
  assert.equal(depositAfter.id, depositBefore.id);
  assert.equal(depositAfter.amountFils, 100000);
  assert.equal(depositAfter.state, "approved");
  assert.equal(db.dump("obligations").find((row) => row.id === laterObligationId).state, "active");

  const after = octoberSummary(db);
  assert.equal(after.collectedFils, 120000);
  assert.equal(after.targetFils, 120000);
  assert.equal(after.remainingFils, 0);
  assert.equal(after.companyCollectedFils, 100000);
  assert.equal(after.dailyPaidFils, 0);
  const holding = sharedHoldingFils({
    receipts: db.dump("receipts"), deposits: db.dump("deposits"), period: "2026-10",
  });
  assert.equal(holding, 20000);
  assert.equal(after.collectedFils, after.cashOnObligationsFils + after.bankRecognizedFils);
  const card = buildDashboardFromDump(db, "2026-10", "2026-10-18").unitsTree
    .flatMap((unit) => unit.spaces).find((row) => row.spaceId === space.spaceId);
  assert.equal(card.paidFils, 120000);
  assert.equal(card.status, "collected");

  await assert.rejects(
    () => run(db, actorFrom(nader), "createCashReceipt", {
      obligationId: laterObligationId, amountFils: 120000, collectionDate: "2026-10-16",
    }, opId("again")),
    (err) => err && err.code === "MONTHLY_RENT_ALREADY_RECORDED",
  );
  await assert.rejects(
    () => run(db, owner, "reverseReceipt", { receiptId: invalidId, reason: "مرة ثانية" }, opId("rev-2")),
    (err) => err && err.code === "ALREADY_REVERSED",
  );
});

test("a vacant October receipt reversal leaves retained arrears and drops an unretained ended month", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "2222" });
  const retained = await spaceOf(db, owner, "شقة 101 / 1", 90000, "2026-09-01");
  await run(db, owner, "generateObligations", { period: "2026-10" }, opId("gen-oct"));
  const october = db.dump("obligations").find((row) =>
    row.rentalId === retained.rental.rentalId && row.period === "2026-10" && row.state === "active");
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: retained.obligation.id, amountFils: 90000, collectionDate: "2026-09-03",
  }, opId("sep-cash"));
  await run(db, owner, "endTenancy", {
    rentalId: retained.rental.rentalId, endDate: "2026-10-07", reason: "إخلاء", arrearsDecision: "retain",
  }, opId("end-retain"));
  const falseId = "rcpt:october-vacant-retained";
  db.seed("receipts", falseId, {
    id: falseId, obligationId: october.id, rentalId: retained.rental.rentalId,
    propertyId: october.propertyId, unitId: october.unitId, spaceId: october.spaceId,
    period: "2026-10", amountFils: 90000, collectionDate: "2026-10-01", method: "cash",
    state: "recognized", collectorUserId: yahia.userId,
  });

  const ended = await spaceOf(db, owner, "شقة 202 / 9", 130000, "2026-10-01");
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: ended.obligation.id, amountFils: 130000, collectionDate: "2026-10-02",
  }, opId("ended-cash"));
  await run(db, owner, "endTenancy", {
    rentalId: ended.rental.rentalId, endDate: "2026-10-11", reason: "إخلاء",
  }, opId("end-paid"));

  const before = octoberSummary(db);
  await run(db, owner, "reverseReceipt", { receiptId: falseId, reason: "الغرفة فارغة والمبلغ غير مستلم" }, opId("rev-retain"));
  await run(db, owner, "reverseReceipt", {
    receiptId: db.dump("receipts").find((row) => row.obligationId === ended.obligation.id).id,
    reason: "الغرفة فارغة والمبلغ غير مستلم",
  }, opId("rev-ended"));

  const september = db.dump("receipts").find((row) => row.obligationId === retained.obligation.id);
  assert.equal(september.state, "recognized");
  assert.equal(september.period, "2026-09");
  const retainedObligation = db.dump("obligations").find((row) => row.id === october.id);
  assert.equal(retainedObligation.state, "active");
  assert.equal(retainedObligation.retainArrearsAfterVacate, true);
  const endedObligation = db.dump("obligations").find((row) => row.id === ended.obligation.id);
  assert.equal(endedObligation.state, "active");
  assert.notEqual(endedObligation.retainArrearsAfterVacate, true);

  const after = octoberSummary(db);
  assert.equal(before.collectedFils - after.collectedFils, 220000);
  assert.equal(after.remainingFils, 90000);
  assert.equal(after.targetFils, 90000);
  assert.equal(buildDashboardFromDump(db, "2026-09", "2026-10-18").summary.collectedFils, 90000);
  const endedCard = buildDashboardFromDump(db, "2026-10", "2026-10-18").unitsTree
    .flatMap((unit) => unit.spaces).find((row) => row.spaceId === ended.space.spaceId);
  assert.equal(endedCard.occupancy, "vacant");
  assert.equal(endedCard.paidFils, 0);
});

test("reversing cash does not rewrite an approved bank deposit or a bank receipt's deposit history", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const { account, obligation } = await spaceOf(db, owner, "شقة 302 / 10", 90000, "2026-10-01");
  await run(db, owner, "createCashReceipt", {
    obligationId: obligation.id, amountFils: 40000, collectionDate: "2026-10-02",
  }, opId("cash"));
  await run(db, owner, "submitDeposit", {
    amountFils: 20000, depositDate: "2026-10-10", destinationAccountId: account.accountId,
    employeeId: owner.userId, sourceKind: "holding", sourcePeriod: "2026-10", period: "2026-10",
  }, opId("holding-dep"));
  const bank = await run(db, owner, "submitBankReceipt", {
    obligationId: obligation.id, amountFils: 50000, collectionDate: "2026-10-03", bankReference: "TRX-10",
  }, opId("bank"));
  await run(db, owner, "approveBankReceipt", { receiptId: bank.receiptId }, opId("bank-ok"));
  const depositsBefore = db.dump("deposits").map((row) => ({ id: row.id, amountFils: row.amountFils, state: row.state }));
  await run(db, owner, "reverseReceipt", { receiptId: bank.receiptId, reason: "تحويل غير مستلم" }, opId("rev-bank"));
  const depositsAfter = db.dump("deposits").map((row) => ({ id: row.id, amountFils: row.amountFils, state: row.state }));
  assert.deepEqual(depositsAfter, depositsBefore);
  assert.equal(db.dump("receipts").find((row) => row.id === bank.receiptId).state, "reversed");
  assert.equal(db.dump("receipts").find((row) => row.method === "cash").state, "recognized");
  const summary = octoberSummary(db);
  assert.equal(summary.bankRecognizedFils, 0);
  assert.equal(summary.companyCollectedFils, 20000);
  assert.equal(summary.cashOnObligationsFils, 40000);
});

test("a cross-month daily stay is occupied in both months and its mirror is not income", async () => {
  const stay = {
    id: "stay-1", spaceId: "s", startDate: "2026-10-28", endDate: "2026-11-05",
    status: "active", total: 300, financialPeriod: "2026-10",
  };
  const docs = [
    { id: "period:2026-10", period: "2026-10", extrasJson: JSON.stringify({ dailyBookings: [stay] }) },
    { id: "period:2026-11", period: "2026-11", extrasJson: JSON.stringify({
      dailyBookings: [{ ...stay, displayOnly: true, financialPeriod: "2026-10" }],
    }) },
  ];
  const october = occupancyBookingsForPeriod(docs, "2026-10");
  const november = occupancyBookingsForPeriod(docs, "2026-11");
  assert.equal(october.length, 1);
  assert.equal(november.length, 1);
  assert.equal(october.filter((row) => row.displayOnly === true).length, 0);
  assert.equal(november.filter((row) => row.displayOnly !== true).length, 0);
});
