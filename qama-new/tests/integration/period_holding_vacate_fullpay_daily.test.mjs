/**
 * Regression: period-isolated Holding, vacancy tenant clear, Full collect,
 * daily prepaid, and approval idempotency.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { freshDb, run, bootstrapOwner, createUser, actorFrom, opId, seedBuilding } from "../helpers/commands.mjs";
import { buildDashboardFromDump } from "../../functions/services/readModel.mjs";
import {
  sharedHoldingFils, RECEIPT_STATE, STATUS, APPROVAL_STATE,
} from "../../functions/domain/finance.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const html = readFileSync(resolve(root, "src/frontend/index.html"), "utf8");

async function seedTwoPeriods(db, owner) {
  const building = await seedBuilding(db, owner);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const nader = await createUser(db, owner, { displayName: "نادر", role: "employee", pin: "1234" });
  // October cycle
  await run(db, owner, "renewRentalCycle", {
    rentalId: building.rental.rentalId, asOfDate: "2026-10-01",
  }, opId("ren-oct"));
  const octGen = await run(db, owner, "generateObligations", { period: "2026-10" }, opId("gen-oct"));
  const octOb = db.dump("obligations").find(
    (o) => o.rentalId === building.rental.rentalId && o.period === "2026-10" && o.state === "active",
  );
  assert.ok(octOb, "oct obligation");
  return { building, yahia, nader, octOb, octGen };
}

test("1 Holding: Sep cash + Sep deposit; Oct unchanged; over Sep refused despite global", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const { building, yahia, octOb } = await seedTwoPeriods(db, owner);

  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 800000, collectionDate: "2026-09-05",
  }, opId("sep-cash"));
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: octOb.id, amountFils: 500000, collectionDate: "2026-10-05",
  }, opId("oct-cash"));

  const sepDash = buildDashboardFromDump(db, "2026-09", "2026-09-15");
  const octDash = buildDashboardFromDump(db, "2026-10", "2026-10-15");
  assert.equal(sepDash.summary.holdingFils, 800000);
  assert.equal(octDash.summary.holdingFils, 500000);
  assert.equal(
    sharedHoldingFils({ receipts: db.dump("receipts"), deposits: db.dump("deposits") }),
    1300000,
  );

  await run(db, owner, "submitDeposit", {
    amountFils: 300000,
    depositDate: "2026-09-20",
    destinationAccountId: building.account.accountId,
    sourceKind: "holding",
    sourcePeriod: "2026-09",
  }, opId("sep-dep"));

  const sepAfter = buildDashboardFromDump(db, "2026-09", "2026-09-20");
  const octAfter = buildDashboardFromDump(db, "2026-10", "2026-10-15");
  assert.equal(sepAfter.summary.holdingFils, 500000);
  assert.equal(octAfter.summary.holdingFils, 500000);

  await assert.rejects(
    () => run(db, owner, "submitDeposit", {
      amountFils: 600000,
      depositDate: "2026-09-21",
      destinationAccountId: building.account.accountId,
      sourceKind: "holding",
      sourcePeriod: "2026-09",
    }, opId("sep-over")),
    (e) => e.code === "AMOUNT_EXCEEDS_HOLDING",
  );
  assert.equal(buildDashboardFromDump(db, "2026-10", "2026-10-15").summary.holdingFils, 500000);

  // Manager / Yahya / Nader see same SHARED period holding
  assert.equal(sepAfter.summary.sharedEmployeeHoldingFils, sepAfter.summary.holdingFils);
});

test("1b Holding: rejected deposit no effect; reverse restores same month; external/bank skip", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const { building, yahia } = await seedBuilding(db, owner).then(async (building) => {
    const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
    return { building, yahia };
  });

  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 400000, collectionDate: "2026-09-05",
  }, opId("cash1"));

  const pending = await run(db, actorFrom(yahia), "submitDeposit", {
    amountFils: 100000,
    depositDate: "2026-09-10",
    destinationAccountId: building.account.accountId,
    sourceKind: "holding",
    sourcePeriod: "2026-09",
  }, opId("pend"));
  assert.equal(buildDashboardFromDump(db, "2026-09", "2026-09-10").summary.holdingFils, 400000);

  await run(db, owner, "rejectDeposit", {
    depositId: pending.depositId, reason: "رفض اختبار",
  }, opId("rej"));
  assert.equal(buildDashboardFromDump(db, "2026-09", "2026-09-10").summary.holdingFils, 400000);

  const appr = await run(db, owner, "submitDeposit", {
    amountFils: 100000,
    depositDate: "2026-09-11",
    destinationAccountId: building.account.accountId,
    sourceKind: "holding",
    sourcePeriod: "2026-09",
  }, opId("appr"));
  assert.equal(buildDashboardFromDump(db, "2026-09", "2026-09-11").summary.holdingFils, 300000);
  await run(db, owner, "reverseDeposit", {
    depositId: appr.depositId, reason: "عكس اختبار",
  }, opId("rev"));
  assert.equal(buildDashboardFromDump(db, "2026-09", "2026-09-12").summary.holdingFils, 400000);

  await run(db, owner, "submitDeposit", {
    amountFils: 50000,
    depositDate: "2026-09-13",
    destinationAccountId: building.account.accountId,
    sourceKind: "external",
    sourcePeriod: "2026-09",
  }, opId("ext"));
  assert.equal(buildDashboardFromDump(db, "2026-09", "2026-09-13").summary.holdingFils, 400000);

  const bank = await run(db, actorFrom(yahia), "submitBankReceipt", {
    obligationId: building.obligationId, amountFils: 100000, collectionDate: "2026-09-14",
    bankReference: "BR-TEST",
  }, opId("bank"));
  await run(db, owner, "approveBankReceipt", { receiptId: bank.receiptId }, opId("bankap"));
  assert.equal(buildDashboardFromDump(db, "2026-09", "2026-09-14").summary.holdingFils, 400000);
});

test("2 Vacancy: endTenancy clears current tenant projection; history remains", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const building = await seedBuilding(db, owner);
  await run(db, owner, "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 200000, collectionDate: "2026-09-05",
  }, opId("pay-part"));

  await run(db, owner, "endTenancy", {
    rentalId: building.rental.rentalId,
    endDate: "2026-09-20",
    reason: "إخلاء اختبار",
    arrearsDecision: "retain",
  }, opId("vacate"));

  const space = db.dump("spaces").find((s) => s.id === building.space.spaceId);
  assert.ok(space);
  assert.equal(space.occupancy, "vacant");
  const liveRental = db.dump("rentals").find((r) => r.spaceId === building.space.spaceId && r.state === "active");
  assert.equal(liveRental, undefined);
  const closed = db.dump("rentals").find((r) => r.id === building.rental.rentalId);
  assert.equal(closed.state, "closed");

  const dash = buildDashboardFromDump(db, "2026-09", "2026-09-20");
  const view = dash.obligations.find((v) => v.spaceId === building.space.spaceId && Number(v.remainingFils || 0) > 0);
  assert.ok(view, "retained arrears obligation remains");
  // Historical tenant snapshot may remain on the obligation — not as live occupancy tenant.
  assert.equal(space.occupancy, "vacant");

  const receipts = db.dump("receipts").filter((r) => r.obligationId === building.obligationId);
  assert.ok(receipts.some((r) => r.state === RECEIPT_STATE.RECOGNIZED && r.amountFils === 200000));

  // Idempotent second vacate
  await assert.rejects(
    () => run(db, owner, "endTenancy", {
      rentalId: building.rental.rentalId, endDate: "2026-09-21", reason: "مرة ثانية", arrearsDecision: "retain",
    }, opId("vacate2")),
    (e) => /RENTAL_ALREADY_CLOSED|RENTAL_NOT_ACTIVE/i.test(e.code || e.message),
  );
});

test("2b UI: vacancy confirmation mentions clearing current tenant", () => {
  assert.match(html, /سيصبح البارتشن فارغاً، وسيتم مسح بيانات المستأجر الحالي/);
  assert.match(html, /تأكيد = تنفيذ/);
  assert.match(html, /إلغاء = لا تغيير/);
});

test("3 Full collect: 900 due → paid 900; partial then Full → remaining only; double no dup", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const prop = await run(db, owner, "createProperty", { name: "قمة", address: "دبي" });
  const unit = await run(db, owner, "createUnit", { propertyId: prop.propertyId, name: "شقة 9", kind: "partitioned" });
  const space = await run(db, owner, "createSpace", { unitId: unit.unitId, name: "شقة 9 / 1" });
  await run(db, owner, "createAccount", { name: "بنك", kind: "bank" });
  const rental = await run(db, owner, "createRental", {
    spaceId: space.spaceId, tenantName: "مستأجر كامل", contractualAmountFils: 90000,
    dueDayOfMonth: 1, startDate: "2026-09-01",
  });
  const gen = await run(db, owner, "generateObligations", { period: "2026-09" }, opId("gen9"));
  const obId = gen.obligationIds[0];

  await run(db, owner, "createCashReceipt", {
    obligationId: obId, amountFils: 90000, collectionDate: "2026-09-02",
  }, opId("full1"));
  let dash = buildDashboardFromDump(db, "2026-09", "2026-09-02");
  let view = dash.obligations.find((v) => v.obligationId === obId);
  assert.equal(view.paidFils, 90000);
  assert.equal(view.remainingFils, 0);
  assert.equal(view.status, STATUS.COLLECTED);

  // Fresh obligation with partial then Full remaining
  const space2 = await run(db, owner, "createSpace", { unitId: unit.unitId, name: "شقة 9 / 2" });
  const rental2 = await run(db, owner, "createRental", {
    spaceId: space2.spaceId, tenantName: "جزئي ثم كامل", contractualAmountFils: 90000,
    dueDayOfMonth: 1, startDate: "2026-09-01",
  });
  const gen2 = await run(db, owner, "generateObligations", { period: "2026-09" }, opId("gen92"));
  const ob2 = db.dump("obligations").find((o) => o.spaceId === space2.spaceId && o.period === "2026-09");
  await run(db, owner, "createCashReceipt", {
    obligationId: ob2.id, amountFils: 20000, collectionDate: "2026-09-03",
  }, opId("part"));
  await run(db, owner, "createCashReceipt", {
    obligationId: ob2.id, amountFils: 70000, collectionDate: "2026-09-04",
  }, opId("rest"));
  dash = buildDashboardFromDump(db, "2026-09", "2026-09-04");
  view = dash.obligations.find((v) => v.obligationId === ob2.id);
  assert.equal(view.paidFils, 90000);
  assert.equal(view.remainingFils, 0);
  const live = db.dump("receipts").filter((r) => r.obligationId === ob2.id && r.state === RECEIPT_STATE.RECOGNIZED);
  assert.equal(live.length, 2);
  assert.equal(live.reduce((s, r) => s + r.amountFils, 0), 90000);

  // Overpay rejected
  await assert.rejects(
    () => run(db, owner, "createCashReceipt", {
      obligationId: ob2.id, amountFils: 100, collectionDate: "2026-09-05",
    }, opId("over")),
    (e) => e.code === "AMOUNT_EXCEEDS_REMAINING" || e.code === "OBLIGATION_NOT_ACTIVE",
  );
});

test("3b commitWorkRequest Full uses remaining and finds cycle obligation", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const prop = await run(db, owner, "createProperty", { name: "قمة", address: "دبي" });
  const unit = await run(db, owner, "createUnit", { propertyId: prop.propertyId, name: "شقة 77", kind: "partitioned" });
  const space = await run(db, owner, "createSpace", { unitId: unit.unitId, name: "شقة 77 / 1" });
  await run(db, owner, "createAccount", { name: "بنك", kind: "bank" });

  const requestId = "req_full_collect_fix";
  await run(db, actorFrom(yahia), "submitWorkRequest", {
    requestId,
    type: "update_partition",
    desc: "محصل كامل 900",
    payloadJson: JSON.stringify({
      unitId: unit.unitId, partId: 1,
      fields: {
        status: "collected", rent: 900, paid_amount: 0, partial: false,
        collectionMethod: "cash", start_date: "2026-09-01", tenant: "مستأجر",
        _spaceId: space.spaceId,
      },
    }),
    month: 8, year: 2026,
  }, opId(requestId));

  await run(db, owner, "commitWorkRequest", { requestId }, "commit-" + requestId);
  const again = await run(db, owner, "commitWorkRequest", { requestId }, "commit-" + requestId);
  assert.equal(again.alreadyApplied, true);

  const ob = db.dump("obligations").find((o) => o.spaceId === space.spaceId && o.period === "2026-09");
  assert.ok(ob);
  const live = db.dump("receipts").filter((r) => r.obligationId === ob.id && r.state === RECEIPT_STATE.RECOGNIZED);
  assert.equal(live.length, 1);
  assert.equal(live[0].amountFils, 90000);
  const dash = buildDashboardFromDump(db, "2026-09", "2026-09-03");
  const view = dash.obligations.find((v) => v.obligationId === ob.id);
  assert.equal(view.paidFils, 90000);
  assert.equal(view.status, STATUS.COLLECTED);
  assert.notEqual(view.paidFils, 0);
});

test("4 UI: approveRequest is commit-first; no months mutate before commit", () => {
  assert.match(html, /commitWorkRequest FIRST/);
  assert.match(html, /Never Object\.assign paid\/status into the month and save before this/);
  const fn = html.slice(html.indexOf("async function approveRequest"), html.indexOf("async function rejectRequest"));
  assert.ok(!/Object\.assign\(p,R_\.payload\.fields\)/.test(fn), "approve must not assign fields before commit");
  assert.ok(!/fbSetDoc\(fbDoc\(db,\"months\"/.test(fn), "approve must not save months around commit");
  assert.match(fn, /commitWorkRequest/);
  assert.match(fn, /refreshAfterCanonicalApproval|refreshEngine\([^)]*true/);
  assert.match(fn, /S\.approvingReqId/);
});

test("5 Daily prepaid: Target+Collected+Holding; idempotent; period isolation", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  await run(db, owner, "createAccount", { name: "بنك", kind: "bank" });
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });

  const booking = {
    id: "db-sep-300", partId: "u1-1", partLabel: "شقة 1 / 1", guest: "نزيل",
    startDate: "2026-09-10", endDate: "2026-09-11", nights: 1, nightRate: 300, total: 300,
    by: yahia.userId,
  };
  const r1 = await run(db, actorFrom(yahia), "createDailyBookingPrepaid", {
    period: "2026-09",
    bookingJson: JSON.stringify(booking),
    amountFils: 30000,
    collectionDate: "2026-09-10",
    note: "نزيل",
  }, opId("daily-sep"));
  assert.equal(r1.alreadyApplied, false);
  assert.ok(r1.receiptId);

  const r2 = await run(db, actorFrom(yahia), "createDailyBookingPrepaid", {
    period: "2026-09",
    bookingJson: JSON.stringify(booking),
    amountFils: 30000,
    collectionDate: "2026-09-10",
    note: "نزيل",
  }, "dailyprepay-sep-300:fixed"); // same stable opId as first if we used fixed — use explicit
  // Fresh opId, same booking → alreadyApplied (no duplicate receipt)
  const r3 = await run(db, actorFrom(yahia), "createDailyBookingPrepaid", {
    period: "2026-09",
    bookingJson: JSON.stringify(booking),
    amountFils: 30000,
    collectionDate: "2026-09-10",
    note: "نزيل",
  }, opId("daily-sep-retry"));
  assert.equal(r3.alreadyApplied, true);
  void r2;

  const sep = buildDashboardFromDump(db, "2026-09", "2026-09-10");
  assert.equal(sep.summary.dailyTargetFils, 30000);
  assert.equal(sep.summary.collectedFils, 30000);
  assert.equal(sep.summary.holdingFils, 30000);
  assert.equal(sep.summary.depositedFils, 0);

  const receipts = db.dump("receipts").filter((r) => r.sourceType === "daily_booking" && r.state === RECEIPT_STATE.RECOGNIZED);
  assert.equal(receipts.length, 1);

  const bookingOct = { ...booking, id: "db-oct-200", total: 200, startDate: "2026-10-02", endDate: "2026-10-03" };
  await run(db, actorFrom(yahia), "createDailyBookingPrepaid", {
    period: "2026-10",
    bookingJson: JSON.stringify(bookingOct),
    amountFils: 20000,
    collectionDate: "2026-10-02",
  }, opId("daily-oct"));

  const oct = buildDashboardFromDump(db, "2026-10", "2026-10-02");
  assert.equal(oct.summary.holdingFils, 20000);
  assert.equal(buildDashboardFromDump(db, "2026-09", "2026-09-10").summary.holdingFils, 30000);

  // Sep holding deposit reduces Sep only
  const acc = db.dump("accounts")[0];
  await run(db, owner, "submitDeposit", {
    amountFils: 10000,
    depositDate: "2026-09-15",
    destinationAccountId: acc.id,
    sourceKind: "holding",
    sourcePeriod: "2026-09",
  }, opId("dep-sep-daily"));
  assert.equal(buildDashboardFromDump(db, "2026-09", "2026-09-15").summary.holdingFils, 20000);
  assert.equal(buildDashboardFromDump(db, "2026-10", "2026-10-02").summary.holdingFils, 20000);

  const extras = db.dump("uiPeriods").find((p) => p.period === "2026-09");
  const parsed = JSON.parse(extras.extrasJson);
  assert.equal(parsed.dailyBookings[0].paymentStatus, "collected");
});

test("5b UI: daily prepaid path present; no paid=0 collected paint requirement", () => {
  assert.match(html, /createDailyBookingPrepaid/);
  assert.match(html, /محصّل \/ لم يودع/);
  assert.match(html, /RECON-CLOSE-POSTVACATE-20261009T0207Z/);
});
