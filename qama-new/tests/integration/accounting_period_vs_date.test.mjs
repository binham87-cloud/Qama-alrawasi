/**
 * Accounting period ≠ transaction date for manual expenses/deposits/maintenance.
 * New form date defaults to today; period comes from viewed month.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { freshDb, run, bootstrapOwner, createUser, actorFrom, opId, seedBuilding } from "../helpers/commands.mjs";
import { buildDashboardFromDump } from "../../functions/services/readModel.mjs";
import { sharedHoldingFils, APPROVAL_STATE } from "../../functions/domain/finance.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const html = readFileSync(resolve(root, "src/frontend/index.html"), "utf8");
const shell = readFileSync(resolve(root, "src/frontend/old-qama-shell.html"), "utf8");

test("UI A/B: new expense/maintenance/deposit defaults use todayISO, not month day-1", () => {
  // Expense form must not hard-code viewed-month -01 for NEW records.
  const expBlock = html.slice(html.indexOf("مصروف جديد"), html.indexOf("صيانة شقة"));
  assert.match(expBlock, /todayISO|engineToday/);
  assert.ok(!/date=S\.year\+\"-\"\+\(S\.month\+1/.test(expBlock), "expense must not default to month-01");
  assert.match(expBlock, /period:_acctPeriod/);
  assert.match(expBlock, /dateInp\.addEventListener\("change",e=>date=e\.target\.value\)/);
  // Maintenance forms initialize date from todayISO
  assert.match(html, /const fm=\{unitId:""[\s\S]{0,80}todayISO/);
  assert.match(html, /const fm=\{facility:"المصاعد"[\s\S]{0,80}todayISO/);
  assert.ok(!/const fm=\{unitId:""[\s\S]{0,120}date:S\.year\+/.test(html));
  // Deposit forms default document date to today
  assert.match(html, /date:\(typeof todayISO/);
  assert.match(shell, /todayISO/);
});

test("UI C: existing expense hydrate uses expenseDate from engine (not today overwrite)", () => {
  assert.match(html, /date: e\.expenseDate/);
  assert.match(html, /function mapDashboardToMonth/);
});

test("D/E/F/G: Sep expense dated Oct stays in Sep P&L; Oct unaffected; nav round-trip", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const building = await seedBuilding(db, owner);

  const created = await run(db, owner, "submitExpense", {
    amountFils: 500000,
    reason: "كهرباء سبتمبر",
    category: "كهرباء",
    expenseDate: "2026-10-05",
    paidFromAccountId: building.account.accountId,
    period: "2026-09",
  }, opId("exp-sep-oct"));

  assert.equal(created.period, "2026-09");
  const doc = db.dump("expenses").find((e) => e.id === created.expenseId);
  assert.equal(doc.period, "2026-09");
  assert.equal(doc.expenseDate, "2026-10-05");
  assert.equal(doc.amountFils, 500000);

  const sep = buildDashboardFromDump(db, "2026-09", "2026-10-05");
  const oct = buildDashboardFromDump(db, "2026-10", "2026-10-05");
  assert.equal(sep.summary.expensesFils, 500000);
  assert.equal(oct.summary.expensesFils, 0);
  assert.ok(sep.expenses.some((e) => e.id === created.expenseId));
  assert.ok(!oct.expenses.some((e) => e.id === created.expenseId));

  // Net reduced in September only (Income 0 − Expenses 5000)
  assert.equal(sep.summary.operatingNetFils ?? sep.summary.netIncomeFils, 0 - 500000);
  assert.equal(oct.summary.operatingNetFils ?? oct.summary.netIncomeFils, 0);

  // Round-trip Sep → Oct → Sep
  const sep2 = buildDashboardFromDump(db, "2026-09", "2026-10-06");
  assert.equal(sep2.summary.expensesFils, 500000);
  assert.ok(sep2.expenses.some((e) => e.id === created.expenseId && e.expenseDate === "2026-10-05"));
});

test("H: maintenance expense from Sep with Oct date stays Sep operating expense", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const building = await seedBuilding(db, owner);
  const r = await run(db, owner, "submitExpense", {
    amountFils: 250000,
    reason: "صيانة مصعد",
    category: "صيانة",
    expenseDate: "2026-10-03",
    paidFromAccountId: building.account.accountId,
    period: "2026-09",
    maintenanceLinkId: "fac-oct-date",
  }, opId("maint-sep"));
  assert.equal(r.period, "2026-09");
  assert.equal(buildDashboardFromDump(db, "2026-09", "2026-10-03").summary.expensesFils, 250000);
  assert.equal(buildDashboardFromDump(db, "2026-10", "2026-10-03").summary.expensesFils, 0);
});

test("I: Sep holding deposit dated Oct reduces Sep Holding only", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const building = await seedBuilding(db, owner);
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 800000, collectionDate: "2026-09-05",
  }, opId("cash-sep"));
  // October cash so Oct Holding is non-zero
  await run(db, owner, "renewRentalCycle", {
    rentalId: building.rental.rentalId, asOfDate: "2026-10-01",
  }, opId("ren"));
  const octGen = await run(db, owner, "generateObligations", { period: "2026-10" }, opId("geno"));
  const octOb = db.dump("obligations").find((o) => o.period === "2026-10" && o.state === "active");
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: octOb.id, amountFils: 500000, collectionDate: "2026-10-02",
  }, opId("cash-oct"));

  assert.equal(buildDashboardFromDump(db, "2026-09", "2026-09-15").summary.holdingFils, 800000);
  assert.equal(buildDashboardFromDump(db, "2026-10", "2026-10-15").summary.holdingFils, 500000);

  const dep = await run(db, owner, "submitDeposit", {
    amountFils: 300000,
    depositDate: "2026-10-05",
    destinationAccountId: building.account.accountId,
    sourceKind: "holding",
    sourcePeriod: "2026-09",
    period: "2026-09",
  }, opId("dep-sep-octdate"));

  assert.equal(dep.sourcePeriod, "2026-09");
  assert.equal(dep.period, "2026-09");
  const row = db.dump("deposits").find((d) => d.id === dep.depositId);
  assert.equal(row.depositDate, "2026-10-05");
  assert.equal(row.period, "2026-09");
  assert.equal(row.sourcePeriod, "2026-09");

  assert.equal(buildDashboardFromDump(db, "2026-09", "2026-10-05").summary.holdingFils, 500000);
  assert.equal(buildDashboardFromDump(db, "2026-10", "2026-10-05").summary.holdingFils, 500000);
  assert.ok(buildDashboardFromDump(db, "2026-09", "2026-10-05").deposits.some((d) => d.id === dep.depositId));
});

test("J: external deposit with Oct date + Sep period does not reduce Holding", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const building = await seedBuilding(db, owner);
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 400000, collectionDate: "2026-09-05",
  }, opId("cash"));
  const before = buildDashboardFromDump(db, "2026-09", "2026-09-15").summary.holdingFils;
  await run(db, owner, "submitDeposit", {
    amountFils: 100000,
    depositDate: "2026-10-05",
    destinationAccountId: building.account.accountId,
    sourceKind: "external",
    sourcePeriod: "2026-09",
    period: "2026-09",
  }, opId("ext"));
  assert.equal(buildDashboardFromDump(db, "2026-09", "2026-10-05").summary.holdingFils, before);
});

test("K: monthly rent cash receipt period still follows obligation, not viewed month override", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const building = await seedBuilding(db, owner);
  const r = await run(db, owner, "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 100000, collectionDate: "2026-10-05",
  }, opId("rent-cash"));
  const rcpt = db.dump("receipts").find((x) => x.id === r.receiptId);
  assert.equal(rcpt.period, "2026-09"); // obligation period
  assert.equal(buildDashboardFromDump(db, "2026-09", "2026-10-05").summary.holdingFils, 100000);
  assert.equal(buildDashboardFromDump(db, "2026-10", "2026-10-05").summary.holdingFils, 0);
});

test("L: daily prepaid period still uses explicit booking period", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  await run(db, owner, "createAccount", { name: "بنك", kind: "bank" });
  const booking = {
    id: "db-period-test", partId: "1", partLabel: "x", guest: "g",
    startDate: "2026-09-10", endDate: "2026-09-11", nights: 1, total: 300,
  };
  await run(db, owner, "createDailyBookingPrepaid", {
    period: "2026-09",
    bookingJson: JSON.stringify(booking),
    amountFils: 30000,
    collectionDate: "2026-10-05",
  }, opId("daily"));
  assert.equal(buildDashboardFromDump(db, "2026-09", "2026-10-05").summary.holdingFils, 30000);
  assert.equal(buildDashboardFromDump(db, "2026-10", "2026-10-05").summary.holdingFils, 0);
});

test("N: owner profit transfer still excluded from operating expenses", async () => {
  // Static + domain invariant: expensesFils only from approved expenses, not profits extras.
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const building = await seedBuilding(db, owner);
  await run(db, owner, "submitExpense", {
    amountFils: 10000, reason: "ops", category: "عام",
    expenseDate: "2026-09-01", paidFromAccountId: building.account.accountId, period: "2026-09",
  }, opId("tiny-exp"));
  // Save a profit row only in extras — must not inflate expensesFils.
  await run(db, owner, "savePeriodExtras", {
    period: "2026-09",
    extrasJson: JSON.stringify({ profits: [{ id: 1, amount: 5000, date: "2026-10-05" }] }),
  }, opId("profit-extra"));
  const sep = buildDashboardFromDump(db, "2026-09", "2026-10-05");
  assert.equal(sep.summary.expensesFils, 10000);
  assert.ok((sep.summary.operatingNetFils ?? sep.summary.netIncomeFils) === 0 - 10000
    || sep.summary.operatingNetFils === sep.summary.incomeFils - 10000);
});

test("BUILD stamp present", () => {
  assert.match(html, /RECON-CLOSE-POSTVACATE-20261009T0207Z/);
});

test("legacy expense without period still derives from expenseDate (compat)", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const building = await seedBuilding(db, owner);
  const r = await run(db, owner, "submitExpense", {
    amountFils: 77000,
    reason: "legacy",
    category: "عام",
    expenseDate: "2026-09-12",
    paidFromAccountId: building.account.accountId,
  }, opId("legacy-exp"));
  assert.equal(r.period, "2026-09");
  assert.equal(db.dump("expenses").find((e) => e.id === r.expenseId).period, "2026-09");
});
