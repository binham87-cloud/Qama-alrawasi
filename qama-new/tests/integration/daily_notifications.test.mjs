import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { freshDb, bootstrapOwner, run, seedBuilding, createUser, actorFrom } from "../helpers/commands.mjs";
import { dailyExpiryNotices } from "../../functions/domain/daily_notifications.mjs";
import { DomainError } from "../../functions/domain/finance.mjs";

async function receiptsFor(db, bookingId) {
  return db.query("receipts", [["obligationId", "==", `daily:${bookingId}`]]);
}

function stored(db, collection, id) {
  return db.dump(collection).find((row) => row.id === id) || null;
}

test("extension and checkout do not create a second daily receipt or mark expiry as checkout", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const employee = actorFrom(await createUser(db, owner, { displayName: "نادر", role: "employee", pin: "2468" }));
  const seeded = await seedBuilding(db, owner);
  const monthly = await run(db, owner, "createCashReceipt", {
    obligationId: seeded.obligationId, amountFils: 100000, collectionDate: "2026-09-05",
  });
  const bookingId = "daily-notice-stay-1";
  const created = await run(db, owner, "createDailyBookingPrepaid", {
    period: "2026-10",
    amountFils: 15000,
    collectionDate: "2026-10-18",
    bookingJson: JSON.stringify({
      id: bookingId,
      partId: "101-2",
      partLabel: "شقة 101 / بارتشن 2",
      unitName: "شقة 101",
      partName: "2",
      guest: "سالم",
      startDate: "2026-10-18",
      endDate: "2026-10-19",
      checkoutTime: "12:00",
      total: 150,
    }),
  });
  const dailyReceipts = await receiptsFor(db, bookingId);
  assert.equal(dailyReceipts.length, 1);
  assert.equal(dailyReceipts[0].amountFils, 15000);
  assert.equal(dailyReceipts[0].state, "recognized");
  const open = dailyExpiryNotices([{
    id: bookingId, guest: "سالم", startDate: "2026-10-18", endDate: "2026-10-19", checkoutTime: "12:00",
  }], new Date("2026-10-19T10:00:00.000Z"));
  assert.equal(open[0].kind, "overdue");
  assert.equal(open[0].checkedOut, false);

  const extended = await run(db, owner, "updateDailyBookingStay", {
    period: "2026-10", bookingId, endDate: "2026-10-22", checkoutTime: "12:00",
  });
  assert.equal(extended.total, 150);
  assert.equal(extended.receiptId, created.receiptId);
  assert.equal(extended.checkedOutAt, null);
  const afterExtend = await receiptsFor(db, bookingId);
  assert.equal(afterExtend.length, 1);
  assert.equal(afterExtend[0].id, created.receiptId);
  assert.equal(afterExtend[0].amountFils, 15000);
  const period = stored(db, "uiPeriods", "period:2026-10");
  const booking = JSON.parse(period.extrasJson).dailyBookings.find((row) => row.id === bookingId);
  assert.equal(booking.endDate, "2026-10-22");
  assert.equal(booking.total, 150);
  assert.equal(booking.checkedOutAt, null);
  const quiet = dailyExpiryNotices([booking], new Date("2026-10-19T10:00:00.000Z"));
  assert.equal(quiet.length, 0);

  const checked = await run(db, employee, "updateDailyBookingStay", {
    period: "2026-10", bookingId, recordCheckout: true,
  });
  assert.ok(checked.checkedOutAt);
  assert.equal(checked.receiptId, created.receiptId);
  const afterOut = await receiptsFor(db, bookingId);
  assert.equal(afterOut.length, 1);
  const gone = dailyExpiryNotices([
    { ...booking, checkedOutAt: checked.checkedOutAt },
  ], new Date("2026-10-23T10:00:00.000Z"));
  assert.equal(gone.length, 0);
  const monthlyAfter = stored(db, "receipts", monthly.receiptId);
  assert.equal(monthlyAfter.amountFils, 100000);
  assert.equal(monthlyAfter.state, "recognized");
  const september = stored(db, "obligations", seeded.obligationId);
  assert.equal(september.amountFils, 920000);
  assert.equal(september.state, "active");
});

test("a closed month cannot be rewritten by a stay reminder", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  db.seed("uiConfig", "close-state:2026-09", { json: JSON.stringify({ status: "closed" }) });
  db.seed("uiPeriods", "period:2026-09", {
    id: "period:2026-09",
    period: "2026-09",
    extrasJson: JSON.stringify({
      dailyBookings: [{
        id: "old-stay", partId: "101-1", guest: "قديم", startDate: "2026-09-01",
        endDate: "2026-09-03", total: 200, receiptId: "rcpt:old", displayOnly: false,
      }],
    }),
  });
  await assert.rejects(
    () => run(db, owner, "updateDailyBookingStay", {
      period: "2026-09", bookingId: "old-stay", recordCheckout: true,
    }),
    (err) => err instanceof DomainError && err.code === "MONTH_CLOSED",
  );
  const period = stored(db, "uiPeriods", "period:2026-09");
  const booking = JSON.parse(period.extrasJson).dailyBookings[0];
  assert.equal(booking.endDate, "2026-09-03");
  assert.equal(booking.checkedOutAt, undefined);
  assert.equal(booking.receiptId, "rcpt:old");
});

test("the shell shows the bell, the stay actions, and the existing PIN screen", () => {
  const shell = readFileSync(new URL("../../src/frontend/old-qama-shell.html", import.meta.url), "utf8");
  for (const marker of [
    "btn-daily-notices",
    "daily-notice-count",
    "notice-guest",
    "notice-stay",
    "notice-checkout",
    "notice-status",
    "تأكيد الخروج",
    "تمديد الحجز",
    "updateDailyBookingStay",
    "pin-key-",
  ]) {
    assert.equal(shell.includes(marker), true, marker);
  }
  assert.equal(shell.includes("window.confirm"), false);
  assert.equal(shell.includes("window.prompt"), false);
});
