/**
 * One monthly rental receipt per physical space per calendar month.
 * Partials stay on the same obligation. Daily bookings stay available.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { freshDb, run, bootstrapOwner, createUser, actorFrom, opId } from "../helpers/commands.mjs";
import { monthlyRentBlockedMessage } from "../../functions/domain/finance.mjs";
import { classifyDailyBooking, dailyRangesOverlap, occupancyBookingsForPeriod } from "../../functions/domain/daily_booking.mjs";
import { buildDashboardFromDump } from "../../functions/services/readModel.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const html = readFileSync(resolve(root, "src/frontend/index.html"), "utf8");

function recognizedMonthly(db, spaceId, period) {
  return db.dump("receipts").filter((row) =>
    row.spaceId === spaceId
    && row.period === period
    && row.sourceType !== "daily_booking"
    && (row.state === "recognized" || row.state === "pending"));
}

async function setup(db, owner, { kind = "partitioned", name = "شقة 202 / 1" } = {}) {
  const prop = await run(db, owner, "createProperty", { name: "قمة الرواسي", address: "دبي" }, opId("prop"));
  const unit = await run(db, owner, "createUnit", {
    propertyId: prop.propertyId, name, kind,
  }, opId("unit"));
  const space = await run(db, owner, "createSpace", { unitId: unit.unitId, name }, opId("space"));
  return { prop, unit, space };
}

async function rent(db, owner, spaceId, { tenantName, amountFils, startDate }) {
  return run(db, owner, "createRental", {
    spaceId,
    tenantName,
    contractualAmountFils: amountFils,
    dueDayOfMonth: Number(String(startDate).slice(8, 10)) || 1,
    startDate,
  }, opId("rent"));
}

async function octoberObligation(db, owner, rentalId) {
  await run(db, owner, "generateObligations", { period: "2026-10" }, opId("gen"));
  const ob = db.dump("obligations").find((row) =>
    row.rentalId === rentalId && row.period === "2026-10" && row.state === "active");
  assert.ok(ob);
  return ob;
}

test("the shell shows the daily-booking warning, button, and occupancy badges", () => {
  assert.match(html, /MONTHLY_RENT_ALREADY_RECORDED/);
  assert.match(html, /تنبيه: يوجد إيجار شهري مسجل لهذا/);
  assert.match(html, /يمكن تسجيل إيجار شهري جديد/);
  assert.match(html, /الانتقال إلى الحجز اليومي/);
  assert.match(html, /btn-open-daily-booking/);
  assert.match(html, /dailyPresetPartId/);
  assert.match(html, /🟠 مؤجر يومي/);
  assert.match(html, /🔵 حجز يومي قادم/);
  assert.match(html, /daily-occupancy-badge/);
  assert.match(html, /daily-booking-detail/);
  assert.match(html, /mergeOccupancyDailyBookings/);
  assert.match(html, /إشغال فقط/);
});

test("same tenant cannot record a second monthly receipt after the month is paid", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const { space } = await setup(db, owner);
  const rental = await rent(db, owner, space.spaceId, {
    tenantName: "الأول", amountFils: 120000, startDate: "2026-10-01",
  });
  const ob = await octoberObligation(db, owner, rental.rentalId);
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: ob.id, amountFils: 120000, collectionDate: "2026-10-01",
  }, opId("pay"));
  await assert.rejects(
    () => run(db, actorFrom(yahia), "createCashReceipt", {
      obligationId: ob.id, amountFils: 120000, collectionDate: "2026-10-02",
    }, opId("pay-again")),
    (err) => err.code === "AMOUNT_EXCEEDS_REMAINING",
  );
  assert.equal(recognizedMonthly(db, space.spaceId, "2026-10").length, 1);
});

test("a new tenant cannot collect another monthly rent for the same space and month", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const { space } = await setup(db, owner);
  const first = await rent(db, owner, space.spaceId, {
    tenantName: "الأول", amountFils: 120000, startDate: "2026-10-01",
  });
  const ob = await octoberObligation(db, owner, first.rentalId);
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: ob.id, amountFils: 120000, collectionDate: "2026-10-01",
  }, opId("pay"));
  await run(db, owner, "closeRental", {
    rentalId: first.rentalId, endDate: "2026-10-10", reason: "إخلاء", setVacant: true,
  }, opId("close"));
  await assert.rejects(
    () => rent(db, owner, space.spaceId, {
      tenantName: "الثاني", amountFils: 120000, startDate: "2026-10-15",
    }),
    (err) => err.code === "MONTHLY_RENT_ALREADY_RECORDED"
      && err.details.message === monthlyRentBlockedMessage(err.details.coverageEndDate)
      && err.details.coverageEndDate === "2026-10-31",
  );
  const closed = db.dump("rentals").find((row) => row.id === first.rentalId);
  assert.equal(closed.state, "closed");
  assert.equal(recognizedMonthly(db, space.spaceId, "2026-10").length, 1);
});

test("vacating and re-renting in the same month cannot collect a second monthly receipt", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const { space } = await setup(db, owner);
  const first = await rent(db, owner, space.spaceId, {
    tenantName: "الأول", amountFils: 120000, startDate: "2026-10-01",
  });
  const ob = await octoberObligation(db, owner, first.rentalId);
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: ob.id, amountFils: 120000, collectionDate: "2026-10-01",
  }, opId("pay"));
  await run(db, owner, "closeRental", {
    rentalId: first.rentalId, endDate: "2026-10-10", reason: "إخلاء", setVacant: true,
  }, opId("close"));
  await assert.rejects(
    () => rent(db, owner, space.spaceId, {
      tenantName: "العائد", amountFils: 110000, startDate: "2026-10-15",
    }),
    (err) => err.code === "MONTHLY_RENT_ALREADY_RECORDED"
      && String(err.details.message).includes("31/10/2026"),
  );
});

test("a new calendar month can be collected after the previous month was collected", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const { space } = await setup(db, owner);
  const first = await rent(db, owner, space.spaceId, {
    tenantName: "الأول", amountFils: 120000, startDate: "2026-10-01",
  });
  const ob = await octoberObligation(db, owner, first.rentalId);
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: ob.id, amountFils: 120000, collectionDate: "2026-10-01",
  }, opId("pay-oct"));
  await run(db, owner, "closeRental", {
    rentalId: first.rentalId, endDate: "2026-10-20", reason: "إخلاء", setVacant: true,
  }, opId("close"));
  const november = await rent(db, owner, space.spaceId, {
    tenantName: "نوفمبر", amountFils: 120000, startDate: "2026-11-01",
  });
  await run(db, owner, "generateObligations", { period: "2026-11" }, opId("gen-nov"));
  const novOb = db.dump("obligations").find((row) =>
    row.rentalId === november.rentalId && row.period === "2026-11" && row.state === "active");
  assert.ok(novOb);
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: novOb.id, amountFils: 120000, collectionDate: "2026-11-01",
  }, opId("pay-nov"));
  assert.equal(recognizedMonthly(db, space.spaceId, "2026-11").length, 1);
  assert.equal(recognizedMonthly(db, space.spaceId, "2026-10").length, 1);
});

test("a daily booking after a monthly rental is allowed and counted once", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const { space } = await setup(db, owner);
  const rental = await rent(db, owner, space.spaceId, {
    tenantName: "الأول", amountFils: 120000, startDate: "2026-10-01",
  });
  const ob = await octoberObligation(db, owner, rental.rentalId);
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: ob.id, amountFils: 120000, collectionDate: "2026-10-01",
  }, opId("pay"));
  const booking = {
    id: "db-once", partId: "daily", partLabel: "يومي", guest: "نزيل",
    startDate: "2026-10-16", endDate: "2026-10-17", nights: 1, nightRate: 50, total: 50,
  };
  const body = {
    period: "2026-10", bookingJson: JSON.stringify(booking),
    amountFils: 5000, collectionDate: "2026-10-16",
  };
  const first = await run(db, actorFrom(yahia), "createDailyBookingPrepaid", body, opId("daily"));
  const replay = await run(db, actorFrom(yahia), "createDailyBookingPrepaid", body, opId("daily-replay"));
  assert.equal(replay.alreadyApplied, true);
  assert.equal(replay.receiptId, first.receiptId);
  const daily = db.dump("receipts").filter((row) => row.sourceType === "daily_booking" && row.state === "recognized");
  assert.equal(daily.length, 1);
  assert.equal(daily[0].amountFils, 5000);
});

test("repeating the same payment request does not create a second receipt", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const { space } = await setup(db, owner);
  const rental = await rent(db, owner, space.spaceId, {
    tenantName: "الأول", amountFils: 120000, startDate: "2026-10-01",
  });
  const ob = await octoberObligation(db, owner, rental.rentalId);
  const body = { obligationId: ob.id, amountFils: 120000, collectionDate: "2026-10-01" };
  const first = await run(db, actorFrom(yahia), "createCashReceipt", body, "op-pay-same");
  const replay = await run(db, actorFrom(yahia), "createCashReceipt", body, "op-pay-same");
  assert.equal(replay.replay, true);
  assert.equal(replay.receiptId, first.receiptId);
  assert.equal(recognizedMonthly(db, space.spaceId, "2026-10").length, 1);
});

test("another employee cannot record a second monthly receipt for the same space", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const nader = await createUser(db, owner, { displayName: "نادر", role: "employee", pin: "1399" });
  const { space } = await setup(db, owner);
  const first = await rent(db, owner, space.spaceId, {
    tenantName: "الأول", amountFils: 120000, startDate: "2026-10-01",
  });
  const ob = await octoberObligation(db, owner, first.rentalId);
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: ob.id, amountFils: 120000, collectionDate: "2026-10-01",
  }, opId("pay"));
  await run(db, owner, "closeRental", {
    rentalId: first.rentalId, endDate: "2026-10-08", reason: "إخلاء", setVacant: true,
  }, opId("close"));
  await assert.rejects(
    () => rent(db, owner, space.spaceId, {
      tenantName: "الثاني", amountFils: 120000, startDate: "2026-10-09",
    }),
    (err) => err.code === "MONTHLY_RENT_ALREADY_RECORDED",
  );
  const seededId = `${ob.id}-other-employee`;
  db.seed("obligations", seededId, { ...ob, id: seededId, rentalId: "rental-other-employee" });
  await assert.rejects(
    () => run(db, actorFrom(nader), "createCashReceipt", {
      obligationId: seededId, amountFils: 120000, collectionDate: "2026-10-09",
    }, opId("nader")),
    (err) => err.code === "MONTHLY_RENT_ALREADY_RECORDED",
  );
});

test("a full apartment follows the same one-receipt rule", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const { space } = await setup(db, owner, { kind: "whole", name: "شقة 301" });
  const first = await rent(db, owner, space.spaceId, {
    tenantName: "الأول", amountFils: 300000, startDate: "2026-10-01",
  });
  const ob = await octoberObligation(db, owner, first.rentalId);
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: ob.id, amountFils: 300000, collectionDate: "2026-10-01",
  }, opId("pay"));
  await run(db, owner, "closeRental", {
    rentalId: first.rentalId, endDate: "2026-10-04", reason: "إخلاء", setVacant: true,
  }, opId("close"));
  await assert.rejects(
    () => rent(db, owner, space.spaceId, {
      tenantName: "الثاني", amountFils: 300000, startDate: "2026-10-06",
    }),
    (err) => err.code === "MONTHLY_RENT_ALREADY_RECORDED",
  );
});

test("partial payments on the same obligation remain allowed", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const { space } = await setup(db, owner);
  const rental = await rent(db, owner, space.spaceId, {
    tenantName: "الأول", amountFils: 120000, startDate: "2026-10-01",
  });
  const ob = await octoberObligation(db, owner, rental.rentalId);
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: ob.id, amountFils: 40000, collectionDate: "2026-10-01",
  }, opId("part-1"));
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: ob.id, amountFils: 80000, collectionDate: "2026-10-05",
  }, opId("part-2"));
  const rows = recognizedMonthly(db, space.spaceId, "2026-10");
  assert.equal(rows.length, 2);
  assert.equal(rows.every((row) => row.obligationId === ob.id), true);
  assert.equal(rows.reduce((sum, row) => sum + row.amountFils, 0), 120000);
});

test("an unpaid obligation keeps the month until it is cancelled, and no receipt is deleted", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const { space } = await setup(db, owner);
  const first = await rent(db, owner, space.spaceId, {
    tenantName: "بدون دفع", amountFils: 120000, startDate: "2026-10-01",
  });
  const ob = await octoberObligation(db, owner, first.rentalId);
  await run(db, owner, "closeRental", {
    rentalId: first.rentalId, endDate: "2026-10-04", reason: "إخلاء بلا تحصيل", setVacant: true,
  }, opId("close-unpaid"));
  assert.equal(db.dump("obligations").find((row) => row.id === ob.id).state, "cancelled");
  assert.equal(db.dump("receipts").length, 0);
  const next = await rent(db, owner, space.spaceId, {
    tenantName: "بديل", amountFils: 100000, startDate: "2026-10-06",
  });
  const replacement = await octoberObligation(db, owner, next.rentalId);
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: replacement.id, amountFils: 100000, collectionDate: "2026-10-06",
  }, opId("pay-next"));
  assert.equal(recognizedMonthly(db, space.spaceId, "2026-10").length, 1);
});

test("November stays empty until renewal is confirmed", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const { space } = await setup(db, owner);
  const rental = await rent(db, owner, space.spaceId, {
    tenantName: "مستمر", amountFils: 120000, startDate: "2026-10-01",
  });
  const ob = await octoberObligation(db, owner, rental.rentalId);
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: ob.id, amountFils: 120000, collectionDate: "2026-10-01",
  }, opId("pay-oct"));
  const generated = await run(db, owner, "generateObligations", { period: "2026-11" }, opId("gen-nov"));
  assert.equal(generated.created, 0);
  assert.equal(db.dump("obligations").some((row) => row.period === "2026-11"), false);
  const renewed = await run(db, actorFrom(yahia), "renewRentalCycle", {
    rentalId: rental.rentalId, asOfDate: "2026-11-01",
  }, opId("renew"));
  assert.ok(renewed.obligationId || renewed.rentalCycleId || renewed.created === true || renewed.acknowledged === true || renewed.obligationIds || renewed.period === "2026-11" || renewed.cycleStart);
  const nov = db.dump("obligations").find((row) => row.rentalId === rental.rentalId && row.period === "2026-11" && row.state === "active");
  assert.ok(nov);
  assert.equal(nov.renewalStatus, "confirmed");
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: nov.id, amountFils: 120000, collectionDate: "2026-11-01",
  }, opId("pay-nov"));
  assert.equal(recognizedMonthly(db, space.spaceId, "2026-11").length, 1);
});

test("overlapping daily bookings on the same partition are blocked and income is counted once", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const { space, unit } = await setup(db, owner);
  const rental = await rent(db, owner, space.spaceId, {
    tenantName: "الأول", amountFils: 120000, startDate: "2026-10-01",
  });
  const ob = await octoberObligation(db, owner, rental.rentalId);
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: ob.id, amountFils: 120000, collectionDate: "2026-10-01",
  }, opId("pay"));
  const firstBooking = {
    id: "db-a", partId: "u-1", partLabel: "شقة 202 / 1", guest: "نزيل",
    startDate: "2026-10-15", endDate: "2026-10-20", nights: 5, total: 250,
    spaceId: space.spaceId, unitId: unit.unitId,
  };
  await run(db, actorFrom(yahia), "createDailyBookingPrepaid", {
    period: "2026-10", bookingJson: JSON.stringify(firstBooking),
    amountFils: 25000, collectionDate: "2026-10-15",
  }, opId("daily-a"));
  const overlap = { ...firstBooking, id: "db-b", startDate: "2026-10-18", endDate: "2026-10-22", total: 200 };
  await assert.rejects(
    () => run(db, actorFrom(yahia), "createDailyBookingPrepaid", {
      period: "2026-10", bookingJson: JSON.stringify(overlap),
      amountFils: 20000, collectionDate: "2026-10-18",
    }, opId("daily-b")),
    (err) => err.code === "BOOKING_OVERLAP",
  );
  const daily = db.dump("receipts").filter((row) => row.sourceType === "daily_booking" && row.state === "recognized");
  assert.equal(daily.length, 1);
  assert.equal(daily[0].spaceId, space.spaceId);
  assert.equal(daily[0].amountFils, 25000);
  assert.equal(classifyDailyBooking(firstBooking, "2026-10-16"), "active");
  assert.equal(classifyDailyBooking(firstBooking, "2026-10-10"), "future");
  assert.equal(classifyDailyBooking(firstBooking, "2026-10-21"), "expired");
  assert.equal(classifyDailyBooking({ ...firstBooking, status: "cancelled" }, "2026-10-16"), "cancelled");
  assert.equal(dailyRangesOverlap("2026-10-15", "2026-10-20", "2026-10-21", "2026-10-23"), false);
});

test("October 28 to November 5 occupies both months and creates one receipt", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const booking = {
    id: "db-span", partId: "202-1", partLabel: "شقة 202 / 1", guest: "نزيل",
    startDate: "2026-10-28", endDate: "2026-11-05", nights: 8, total: 80,
  };
  await run(db, actorFrom(yahia), "createDailyBookingPrepaid", {
    period: "2026-10", bookingJson: JSON.stringify(booking),
    amountFils: 8000, collectionDate: "2026-10-28",
  }, opId("span"));
  const docs = db.dump("uiPeriods");
  const october = occupancyBookingsForPeriod(docs, "2026-10");
  const november = occupancyBookingsForPeriod(docs, "2026-11");
  assert.equal(october.length, 1);
  assert.equal(october[0].displayOnly, false);
  assert.equal(november.length, 1);
  assert.equal(november[0].displayOnly, true);
  assert.equal(november[0].financialPeriod, "2026-10");
  const daily = db.dump("receipts").filter((row) => row.sourceType === "daily_booking" && row.state === "recognized");
  assert.equal(daily.length, 1);
  assert.equal(daily[0].period, "2026-10");
  assert.equal(daily[0].amountFils, 8000);
  assert.equal(classifyDailyBooking(booking, "2026-10-30"), "active");
  assert.equal(classifyDailyBooking(booking, "2026-11-02"), "active");
  await assert.rejects(
    () => run(db, actorFrom(yahia), "createDailyBookingPrepaid", {
      period: "2026-11",
      bookingJson: JSON.stringify({ ...booking, id: "db-cross", startDate: "2026-11-01", endDate: "2026-11-03", total: 40 }),
      amountFils: 4000, collectionDate: "2026-11-01",
    }, opId("cross-block")),
    (err) => err.code === "BOOKING_OVERLAP",
  );
  await run(db, actorFrom(yahia), "createDailyBookingPrepaid", {
    period: "2026-11",
    bookingJson: JSON.stringify({ ...booking, id: "db-after", startDate: "2026-11-06", endDate: "2026-11-08", total: 20 }),
    amountFils: 2000, collectionDate: "2026-11-06",
  }, opId("after"));
  const octDash = buildDashboardFromDump(db, "2026-10", "2026-11-02");
  const novDash = buildDashboardFromDump(db, "2026-11", "2026-11-02");
  assert.equal(octDash.summary.collectedFils, 8000);
  assert.equal(novDash.summary.collectedFils, 2000);
  assert.equal(octDash.summary.occupancyDailyBookings.length, 1);
  assert.equal(novDash.summary.occupancyDailyBookings.some((row) => row.id === "db-span" && row.displayOnly), true);
  assert.equal(db.dump("receipts").filter((row) => row.sourceType === "daily_booking" && row.state === "recognized").length, 2);
});

test("concurrent submissions leave a single monthly receipt", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const nader = await createUser(db, owner, { displayName: "نادر", role: "employee", pin: "1399" });
  const { space } = await setup(db, owner);
  const rental = await rent(db, owner, space.spaceId, {
    tenantName: "الأول", amountFils: 120000, startDate: "2026-10-01",
  });
  const ob = await octoberObligation(db, owner, rental.rentalId);
  const body = { obligationId: ob.id, amountFils: 120000, collectionDate: "2026-10-01" };
  const settled = await Promise.allSettled([
    run(db, actorFrom(yahia), "createCashReceipt", body, opId("race-a")),
    run(db, actorFrom(nader), "createCashReceipt", body, opId("race-b")),
  ]);
  const ok = settled.filter((row) => row.status === "fulfilled");
  const failed = settled.filter((row) => row.status === "rejected");
  assert.equal(ok.length, 1);
  assert.equal(failed.length, 1);
  const code = failed[0].reason && failed[0].reason.code;
  assert.ok(code === "AMOUNT_EXCEEDS_REMAINING" || code === "MONTHLY_RENT_ALREADY_RECORDED" || /TRANSACTION_CONFLICT/.test(String(failed[0].reason && failed[0].reason.message)));
  assert.equal(recognizedMonthly(db, space.spaceId, "2026-10").length, 1);
});
