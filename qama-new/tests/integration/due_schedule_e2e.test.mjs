/**
 * End-to-end due-date flow: createRental (same command as UI) → generateObligations
 * → dashboard → frontend-shaped status/due_date. Also deposit/expense cancel safety.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshDb, run, bootstrapOwner, createUser, actorFrom, opId } from "../helpers/commands.mjs";
import { buildDashboardFromDump } from "../../functions/services/readModel.mjs";
import { dueDateFor } from "../../functions/domain/finance.mjs";
import { STATUS, APPROVAL_STATE } from "../../functions/domain/finance.mjs";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const html = readFileSync(resolve(root, "src/frontend/index.html"), "utf8");

function oldStatus(engineStatus) {
  if (engineStatus === "not_due") return "pending";
  if (engineStatus === "partial") return "late"; // partial flag separate in UI
  if (engineStatus === "collected") return "collected";
  return "late";
}

async function rentalFlow(db, owner, { startDate, amountFils = 130000, period = "2026-09", asOfDate = "2026-09-03" }) {
  const prop = await run(db, owner, "createProperty", { name: "قمة", address: "دبي" });
  const unit = await run(db, owner, "createUnit", { propertyId: prop.propertyId, name: "شقة 202", kind: "partitioned" });
  const space = await run(db, owner, "createSpace", { unitId: unit.unitId, name: "شقة 202 / 9" });
  await run(db, owner, "setSpaceOccupancy", { spaceId: space.spaceId, occupancy: "rented" });
  const dueDay = Math.min(31, Math.max(1, Number(startDate.slice(8, 10)) || 1));
  const rental = await run(db, owner, "createRental", {
    spaceId: space.spaceId,
    tenantName: "مستأجر",
    contractualAmountFils: amountFils,
    dueDayOfMonth: dueDay,
    startDate,
  });
  await run(db, owner, "generateObligations", { period });
  const dash = buildDashboardFromDump(db, period, asOfDate);
  const rentalDoc = db.dump("rentals").find((r) => r.id === rental.rentalId);
  const ob = db.dump("obligations").find((o) => o.rentalId === rental.rentalId && o.period === period);
  const view = dash.obligations.find((v) => v.obligationId === ob.id);
  return { rental, rentalDoc, ob, view, dash, space, period };
}

for (const day of [1, 10, 29, 30, 31]) {
  test(`START DAY ${day}: createRental → dueDay → obligation → dashboard late`, async () => {
    const db = freshDb();
    const owner = await bootstrapOwner(db);

    if (day === 31) {
      const { rentalDoc, ob, view } = await rentalFlow(db, owner, {
        startDate: "2026-01-31",
        period: "2026-02",
        asOfDate: "2026-03-01",
      });
      assert.equal(rentalDoc.dueDayOfMonth, 31);
      assert.equal(ob.dueDate, dueDateFor("2026-02", 31)); // 2026-02-28
      assert.equal(view.dueDate, "2026-02-28");
      assert.equal(view.status, STATUS.LATE);
      await run(db, owner, "generateObligations", { period: "2026-03" });
      const mar = db.dump("obligations").find((o) => o.rentalId === rentalDoc.id && o.period === "2026-03");
      assert.equal(mar.dueDate, "2026-03-31");
      return;
    }

    const startDate = `2026-09-${String(day).padStart(2, "0")}`;
    const expectedDue = dueDateFor("2026-09", day);
    // asOf on/after due date → LATE (upfront rent rule)
    const asOfDate = expectedDue;
    const { rentalDoc, ob, view } = await rentalFlow(db, owner, { startDate, asOfDate });

    assert.equal(rentalDoc.dueDayOfMonth, day);
    assert.equal(ob.dueDate, expectedDue);
    assert.equal(view.dueDate, expectedDue);
    assert.equal(view.paidFils, 0);
    assert.equal(view.status, STATUS.LATE);
    assert.equal(oldStatus(view.status), "late");
    if (day === 1) {
      assert.equal(ob.dueDate, "2026-09-01");
      assert.notEqual(ob.dueDate, "2026-09-30");
    }
    if (day === 10) {
      // Before due day must still be not_due
      const early = buildDashboardFromDump(db, "2026-09", "2026-09-03");
      const earlyView = early.obligations.find((v) => v.obligationId === ob.id);
      assert.equal(earlyView.status, STATUS.NOT_DUE);
    }
  });
}

test("E2E REAL FLOW: start 2026-09-01 unpaid on Sep 3 → late / due Sep 1", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const { rentalDoc, ob, view } = await rentalFlow(db, owner, {
    startDate: "2026-09-01",
    asOfDate: "2026-09-03",
  });
  assert.equal(rentalDoc.dueDayOfMonth, 1);
  assert.equal(ob.dueDate, "2026-09-01");
  assert.equal(view.dueDate, "2026-09-01");
  assert.equal(view.status, STATUS.LATE);
  assert.equal(oldStatus(view.status), "late");
});

test("STATUS CHANGE DOES NOT ALTER DUE DATE", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const { rentalDoc, ob, view } = await rentalFlow(db, owner, { startDate: "2026-09-01" });
  const beforeDue = ob.dueDate;
  const beforeDay = rentalDoc.dueDayOfMonth;
  const beforeStart = rentalDoc.startDate;

  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: ob.id, amountFils: 130000, collectionDate: "2026-09-03",
  });
  let after = db.dump("obligations").find((o) => o.id === ob.id);
  let rentalAfter = db.dump("rentals").find((r) => r.id === rentalDoc.id);
  assert.equal(after.dueDate, beforeDue);
  assert.equal(rentalAfter.dueDayOfMonth, beforeDay);
  assert.equal(rentalAfter.startDate, beforeStart);

  const rcpt = db.dump("receipts").find((r) => r.obligationId === ob.id);
  await run(db, owner, "reverseReceipt", { receiptId: rcpt.id, reason: "تصحيح" });
  after = db.dump("obligations").find((o) => o.id === ob.id);
  rentalAfter = db.dump("rentals").find((r) => r.id === rentalDoc.id);
  assert.equal(after.dueDate, beforeDue);
  assert.equal(rentalAfter.dueDayOfMonth, beforeDay);
  assert.equal(rentalAfter.startDate, beforeStart);

  // schedule sync from wrong day 31 → day of start
  await run(db, owner, "updateRentalSchedule", {
    rentalId: rentalDoc.id,
    startDate: "2026-09-01",
    dueDayOfMonth: 31,
  });
  // Force wrong then repair from start alone
  await run(db, owner, "updateRentalSchedule", { rentalId: rentalDoc.id, startDate: "2026-09-01" });
  rentalAfter = db.dump("rentals").find((r) => r.id === rentalDoc.id);
  after = db.dump("obligations").find((o) => o.id === ob.id);
  assert.equal(rentalAfter.dueDayOfMonth, 1);
  assert.equal(after.dueDate, "2026-09-01");
  void view;
});

test("APPROVED DEPOSIT REVERSAL restores shared holding; double reverse blocked", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const prop = await run(db, owner, "createProperty", { name: "قمة", address: "دبي" });
  const unit = await run(db, owner, "createUnit", { propertyId: prop.propertyId, name: "U", kind: "whole" });
  const space = await run(db, owner, "createSpace", { unitId: unit.unitId, name: "S" });
  await run(db, owner, "setSpaceOccupancy", { spaceId: space.spaceId, occupancy: "rented" });
  const rental = await run(db, owner, "createRental", {
    spaceId: space.spaceId, tenantName: "T", contractualAmountFils: 900000, dueDayOfMonth: 1, startDate: "2026-09-01",
  });
  await run(db, owner, "generateObligations", { period: "2026-09" });
  const ob = db.dump("obligations").find((o) => o.rentalId === rental.rentalId);
  const acc = await run(db, owner, "createAccount", { name: "بنك", kind: "bank" });

  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: ob.id, amountFils: 900000, collectionDate: "2026-09-01",
  });
  let dash = buildDashboardFromDump(db, "2026-09", "2026-09-03");
  assert.equal(dash.summary.holdingFils, 900000);

  const dep = await run(db, actorFrom(yahia), "submitDeposit", {
    amountFils: 700000, depositDate: "2026-09-02", destinationAccountId: acc.accountId,
  });
  await run(db, owner, "approveDeposit", { depositId: dep.depositId });
  dash = buildDashboardFromDump(db, "2026-09", "2026-09-03");
  assert.equal(dash.summary.holdingFils, 200000);

  const rev = await run(db, owner, "reverseDeposit", { depositId: dep.depositId, reason: "إلغاء" });
  assert.ok(rev.reversalId);
  dash = buildDashboardFromDump(db, "2026-09", "2026-09-03");
  assert.equal(dash.summary.holdingFils, 900000);
  const depDoc = db.dump("deposits").find((d) => d.id === dep.depositId);
  assert.equal(depDoc.state, APPROVAL_STATE.REVERSED);

  await assert.rejects(
    () => run(db, owner, "reverseDeposit", { depositId: dep.depositId, reason: "مرة أخرى" }, opId("d2")),
    (e) => e.code === "ALREADY_REVERSED"
  );
  dash = buildDashboardFromDump(db, "2026-09", "2026-09-03");
  assert.equal(dash.summary.holdingFils, 900000);
});

test("PENDING DEPOSIT cancel leaves holding unchanged", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const prop = await run(db, owner, "createProperty", { name: "قمة", address: "دبي" });
  const unit = await run(db, owner, "createUnit", { propertyId: prop.propertyId, name: "U", kind: "whole" });
  const space = await run(db, owner, "createSpace", { unitId: unit.unitId, name: "S" });
  await run(db, owner, "setSpaceOccupancy", { spaceId: space.spaceId, occupancy: "rented" });
  const rental = await run(db, owner, "createRental", {
    spaceId: space.spaceId, tenantName: "T", contractualAmountFils: 500000, dueDayOfMonth: 1, startDate: "2026-09-01",
  });
  await run(db, owner, "generateObligations", { period: "2026-09" });
  const ob = db.dump("obligations").find((o) => o.rentalId === rental.rentalId);
  const acc = await run(db, owner, "createAccount", { name: "بنك", kind: "bank" });
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: ob.id, amountFils: 500000, collectionDate: "2026-09-01",
  });
  const dep = await run(db, actorFrom(yahia), "submitDeposit", {
    amountFils: 100000, depositDate: "2026-09-02", destinationAccountId: acc.accountId,
  });
  let dash = buildDashboardFromDump(db, "2026-09", "2026-09-03");
  assert.equal(dash.summary.holdingFils, 500000);
  await run(db, owner, "rejectDeposit", { depositId: dep.depositId, reason: "إلغاء معلق" });
  dash = buildDashboardFromDump(db, "2026-09", "2026-09-03");
  assert.equal(dash.summary.holdingFils, 500000);
  assert.equal(db.dump("deposits").find((d) => d.id === dep.depositId).state, APPROVAL_STATE.REJECTED);
});

test("APPROVED EXPENSE reverse once; history preserved; double blocked", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const acc = await run(db, owner, "createAccount", { name: "بنك", kind: "bank" });
  const exp = await run(db, owner, "submitExpense", {
    amountFils: 100000, reason: "صيانة", category: "صيانة", expenseDate: "2026-09-02", paidFromAccountId: acc.accountId,
  });
  assert.equal(exp.state, APPROVAL_STATE.APPROVED);
  let dash = buildDashboardFromDump(db, "2026-09", "2026-09-03");
  const beforeExpTotal = dash.summary.expensesFils ?? dash.expenses.filter((e) => e.state === "approved").reduce((s, e) => s + e.amountFils, 0);
  assert.ok(beforeExpTotal >= 100000);

  await run(db, owner, "reverseExpense", { expenseId: exp.expenseId, reason: "إلغاء" });
  const doc = db.dump("expenses").find((e) => e.id === exp.expenseId);
  assert.equal(doc.state, APPROVAL_STATE.REVERSED);
  assert.ok(doc.reversedByReversalId);
  assert.equal(doc.amountFils, 100000); // history amount preserved

  await assert.rejects(
    () => run(db, owner, "reverseExpense", { expenseId: exp.expenseId, reason: "مرة أخرى" }, opId("e2")),
    (e) => e.code === "ALREADY_REVERSED"
  );
});

test("UI: no addMonthsISO due formula; manager cancel wired; canonical due label", () => {
  assert.match(html, /تاريخ الاستحقاق التلقائي/);
  assert.match(html, /reverseDeposit/);
  assert.match(html, /reverseExpense/);
  assert.match(html, /rejectDeposit/);
  assert.match(html, /rejectExpense/);
  assert.match(html, /updateRentalSchedule/);
  // start_date change must not use addMonthsISO for monthly due
  assert.ok(!/p\.due_date\s*=\s*addMonthsISO/.test(html), "partition start must not use addMonthsISO");
  assert.ok(!/u\.due_date\s*=\s*addMonthsISO/.test(html), "full start must not use addMonthsISO");
  assert.match(html, /never invent "start \+ 1 month"/i);
});
