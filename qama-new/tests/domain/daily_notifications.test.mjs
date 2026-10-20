import test from "node:test";
import assert from "node:assert/strict";
import {
  dubaiParts, dailyExpiryNotice, dailyExpiryNotices, checkoutTimeOf,
  DEFAULT_DAILY_CHECKOUT_TIME, NOTICE_EFFECTIVE_DATE,
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

test("missing or invalid checkout time defaults to 12:00 Dubai, and an explicit time is kept", () => {
  assert.equal(DEFAULT_DAILY_CHECKOUT_TIME, "12:00");
  assert.equal(checkoutTimeOf({}), "12:00");
  assert.equal(checkoutTimeOf({ checkoutTime: "" }), "12:00");
  assert.equal(checkoutTimeOf({ checkoutTime: "25:00" }), "12:00");
  assert.equal(checkoutTimeOf({ checkoutTime: "00:01" }), "00:01");
  assert.equal(checkoutTimeOf({ checkoutTime: "16:30" }), "16:30");
  const noon = dailyExpiryNotice({ ...stay, checkoutTime: undefined }, new Date("2026-10-20T08:00:00.000Z"));
  assert.equal(noon.kind, "checkout_day");
  assert.equal(noon.checkoutTime, "12:00");
  const explicit = dailyExpiryNotice({ ...stay, checkoutTime: "16:30" }, new Date("2026-10-20T08:00:00.000Z"));
  assert.equal(explicit.kind, "checkout_day");
  assert.equal(explicit.checkoutTime, "16:30");
  const lateExplicit = dailyExpiryNotice({ ...stay, checkoutTime: "16:30" }, new Date("2026-10-20T12:31:00.000Z"));
  assert.equal(lateExplicit.kind, "overdue");
});

test("notices follow Dubai midnight and the October–November month boundary", () => {
  const crossing = { ...stay, startDate: "2026-10-30", endDate: "2026-11-01", checkoutTime: "12:00" };
  assert.equal(dailyExpiryNotice(crossing, new Date("2026-10-31T07:59:00.000Z")), null);
  const soon = dailyExpiryNotice(crossing, new Date("2026-10-31T08:00:00.000Z"));
  assert.equal(soon.kind, "before_24h");
  assert.equal(soon.checkoutDate, "2026-11-01");
  const midnight = dailyExpiryNotice(crossing, new Date("2026-10-31T20:00:00.000Z"));
  assert.equal(midnight.kind, "checkout_day");
  assert.equal(dubaiParts(new Date("2026-10-31T20:00:00.000Z")).date, "2026-11-01");
  const late = dailyExpiryNotice(crossing, new Date("2026-11-01T08:01:00.000Z"));
  assert.equal(late.kind, "overdue");
});

test("notices start on 20 Oct 2026 Dubai and leave earlier checkouts in history", () => {
  assert.equal(NOTICE_EFFECTIVE_DATE, "2026-10-20");
  const now = new Date("2026-10-20T10:00:00.000Z");
  const before = { ...stay, id: "old-sep", startDate: "2026-09-01", endDate: "2026-09-07" };
  const eve = { ...stay, id: "oct-19", startDate: "2026-10-18", endDate: "2026-10-19" };
  const first = { ...stay, id: "oct-20", startDate: "2026-10-18", endDate: "2026-10-20" };
  const later = { ...stay, id: "nov-1", startDate: "2026-10-30", endDate: "2026-11-01" };
  assert.equal(dailyExpiryNotice(before, now), null);
  assert.equal(dailyExpiryNotice(eve, now), null);
  assert.equal(dailyExpiryNotice(first, now).kind, "overdue");
  assert.equal(dailyExpiryNotice(later, now), null);
  const notices = dailyExpiryNotices([before, eve, first, later, { ...first }], now);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].bookingId, "oct-20");
  assert.equal(before.checkedOutAt, undefined);
  assert.equal(before.endDate, "2026-09-07");
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
