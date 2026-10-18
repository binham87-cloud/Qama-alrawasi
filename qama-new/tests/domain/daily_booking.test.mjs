import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyDailyBooking,
  occupancyBookingsForPeriod,
  stayIntersectsPeriod,
  periodsTouchedByStay,
} from "../../functions/domain/daily_booking.mjs";
import { dailyBookingsTargetFils } from "../../functions/domain/finance.mjs";

const span = {
  id: "db-span",
  partId: "202-1",
  startDate: "2026-10-28",
  endDate: "2026-11-05",
  total: 80,
  status: "active",
  financialPeriod: "2026-10",
};

test("a stay crossing October and November is visible in both and paid only in its home month", () => {
  assert.deepEqual(periodsTouchedByStay(span.startDate, span.endDate), ["2026-10", "2026-11"]);
  assert.equal(stayIntersectsPeriod(span.startDate, span.endDate, "2026-10"), true);
  assert.equal(stayIntersectsPeriod(span.startDate, span.endDate, "2026-11"), true);
  assert.equal(stayIntersectsPeriod(span.startDate, span.endDate, "2026-09"), false);
  const docs = [
    { period: "2026-10", extrasJson: JSON.stringify({ dailyBookings: [{ ...span, displayOnly: false }] }) },
    { period: "2026-11", extrasJson: JSON.stringify({ dailyBookings: [{ ...span, displayOnly: true }] }) },
  ];
  const october = occupancyBookingsForPeriod(docs, "2026-10");
  const november = occupancyBookingsForPeriod(docs, "2026-11");
  assert.equal(october.length, 1);
  assert.equal(october[0].displayOnly, false);
  assert.equal(november.length, 1);
  assert.equal(november[0].displayOnly, true);
  assert.equal(classifyDailyBooking(span, "2026-10-30"), "active");
  assert.equal(classifyDailyBooking(span, "2026-11-02"), "active");
  assert.equal(classifyDailyBooking(span, "2026-11-06"), "expired");
  assert.equal(dailyBookingsTargetFils(october), 8000);
  assert.equal(dailyBookingsTargetFils(november), 0);
});

test("cancelling any copy removes the stay from every month", () => {
  const docs = [
    { period: "2026-10", extrasJson: JSON.stringify({ dailyBookings: [{ ...span, displayOnly: false }] }) },
    { period: "2026-11", extrasJson: JSON.stringify({ dailyBookings: [{ ...span, displayOnly: true, status: "cancelled" }] }) },
  ];
  assert.equal(occupancyBookingsForPeriod(docs, "2026-10").length, 0);
  assert.equal(occupancyBookingsForPeriod(docs, "2026-11").length, 0);
});
