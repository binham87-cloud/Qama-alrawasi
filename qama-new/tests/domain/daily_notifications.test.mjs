import test from "node:test";
import assert from "node:assert/strict";
import {
  dubaiParts, dailyExpiryNotice, dailyExpiryNotices,
} from "../../functions/domain/daily_notifications.mjs";
import { canonicalDailyBookings, dailyOccupancyForPart } from "../../functions/domain/daily_booking.mjs";

const stay = {
  id: "stay-1",
  partId: "101-2",
  partLabel: "شقة 101 / بارتشن 2",
  unitName: "شقة 101",
  partName: "2",
  guest: "سالم",
  startDate: "2026-10-18",
  endDate: "2026-10-20",
  checkoutTime: "12:00",
  financialPeriod: "2026-10",
  total: 300,
  receiptId: "rcpt:stay-1",
  status: "active",
};

test("Dubai clock is four hours ahead of UTC", () => {
  const parts = dubaiParts(new Date("2026-10-18T20:30:00.000Z"));
  assert.equal(parts.date, "2026-10-19");
  assert.equal(parts.time, "00:30");
});

test("a stay notifies 24 hours before checkout, on the checkout date, then after checkout time", () => {
  assert.equal(dailyExpiryNotice(stay, new Date("2026-10-19T07:59:00.000Z")), null);
  const soon = dailyExpiryNotice(stay, new Date("2026-10-19T08:00:00.000Z"));
  assert.equal(soon.kind, "before_24h");
  assert.equal(soon.guest, "سالم");
  assert.equal(soon.apartment, "شقة 101");
  assert.equal(soon.partition, "2");
  assert.equal(soon.checkoutDate, "2026-10-20");
  assert.equal(soon.checkoutTime, "12:00");
  assert.equal(soon.status, "occupied");
  const day = dailyExpiryNotice(stay, new Date("2026-10-20T04:00:00.000Z"));
  assert.equal(day.kind, "checkout_day");
  const late = dailyExpiryNotice(stay, new Date("2026-10-20T08:01:00.000Z"));
  assert.equal(late.kind, "overdue");
  assert.equal(late.status, "occupied_after_checkout");
  assert.equal(late.checkedOut, false);
});

test("checkout, cancellation, and a later end date each clear the previous notice", () => {
  const now = new Date("2026-10-20T10:00:00.000Z");
  assert.equal(dailyExpiryNotice({ ...stay, checkedOutAt: "2026-10-20T09:00:00.000Z" }, now), null);
  assert.equal(dailyExpiryNotice({ ...stay, status: "cancelled" }, now), null);
  const extended = dailyExpiryNotice({ ...stay, endDate: "2026-10-25" }, now);
  assert.equal(extended, null);
  assert.equal(stay.checkedOutAt, undefined);
});

test("duplicate copies of one booking produce one notice", () => {
  const now = new Date("2026-10-20T10:00:00.000Z");
  const mirror = { ...stay, displayOnly: true, financialPeriod: "2026-10" };
  const notices = dailyExpiryNotices([stay, mirror, { ...stay }], now);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].bookingId, "stay-1");
});

test("canonical bookings keep the paid copy and occupancy ignores explicit checkout only", () => {
  const docs = [
    { period: "2026-10", extrasJson: JSON.stringify({ dailyBookings: [stay] }) },
    { period: "2026-11", extrasJson: JSON.stringify({ dailyBookings: [{ ...stay, displayOnly: true, endDate: "2026-10-20" }] }) },
  ];
  const rows = canonicalDailyBookings(docs);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].displayOnly, undefined);
  assert.equal(rows[0].receiptId, "rcpt:stay-1");
  const occupied = dailyOccupancyForPart({ bookings: [stay], partId: "101-2", today: "2026-10-19" });
  assert.equal(occupied.active.id, "stay-1");
  const departed = dailyOccupancyForPart({
    bookings: [{ ...stay, checkedOutAt: "2026-10-19T08:00:00.000Z" }],
    partId: "101-2",
    today: "2026-10-19",
  });
  assert.equal(departed.active, null);
});
