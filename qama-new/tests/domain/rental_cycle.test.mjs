/**
 * Pure unit tests for anniversary rental cycles (no I/O).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  addMonthsClamped, nextCycleStart, cycleEndInclusive, rentalCycleIdFor,
  renewButtonVisible, buildCycleFields, daysUntilCycleStart,
} from "../../functions/domain/rental_cycle.mjs";

test("15 Sep cycle ends 14 Oct; next starts 15 Oct", () => {
  assert.equal(cycleEndInclusive("2026-09-15"), "2026-10-14");
  assert.equal(nextCycleStart("2026-09-15"), "2026-10-15");
  assert.equal(nextCycleStart("2026-10-15"), "2026-11-15");
});

test("Dec → Jan rollover", () => {
  assert.equal(nextCycleStart("2026-12-15"), "2027-01-15");
  assert.equal(cycleEndInclusive("2026-12-15"), "2027-01-14");
});

test("day 31 clamps then restores via anniversaryDay", () => {
  assert.equal(nextCycleStart("2026-01-31", 1, 31), "2026-02-28");
  assert.equal(nextCycleStart("2026-02-28", 1, 31), "2026-03-31"); // restore
  assert.equal(nextCycleStart("2024-01-31", 1, 31), "2024-02-29");
  assert.equal(nextCycleStart("2024-02-29", 1, 31), "2024-03-31");
  assert.equal(addMonthsClamped("2026-01-31", 2), "2026-03-31");
  assert.equal(addMonthsClamped("2026-03-31", 1), "2026-04-30");
  assert.equal(addMonthsClamped("2026-05-31", 1), "2026-06-30");
  assert.equal(addMonthsClamped("2026-07-31", 1), "2026-08-31");
});

test("days 28/29/30/31", () => {
  assert.equal(nextCycleStart("2026-01-28", 1, 28), "2026-02-28");
  assert.equal(nextCycleStart("2026-01-29", 1, 29), "2026-02-28");
  assert.equal(nextCycleStart("2026-02-28", 1, 29), "2026-03-29");
  assert.equal(nextCycleStart("2026-01-30", 1, 30), "2026-02-28");
  assert.equal(nextCycleStart("2026-02-28", 1, 30), "2026-03-30");
  assert.equal(nextCycleStart("2026-01-31", 1, 31), "2026-02-28");
  assert.equal(nextCycleStart("2024-01-29", 1, 29), "2024-02-29");
});

test("rentalCycleId deterministic", () => {
  assert.equal(rentalCycleIdFor("rental:x", "2026-10-15"), "rental:x_2026-10-15");
});

test("renew button early window", () => {
  assert.equal(renewButtonVisible("2026-10-15", "2026-10-15"), true);
  assert.equal(renewButtonVisible("2026-10-15", "2026-10-08"), true); // 7 days early
  assert.equal(renewButtonVisible("2026-10-15", "2026-10-07"), false); // 8 days early
  assert.equal(renewButtonVisible("2026-10-15", "2026-10-01"), false);
  assert.equal(daysUntilCycleStart("2026-10-15", "2026-10-10"), 5);
});

test("buildCycleFields", () => {
  const c = buildCycleFields({
    rentalId: "rental:a", cycleStart: "2026-09-15", amountFils: 100000, tenantName: "أحمد",
  });
  assert.equal(c.rentalCycleId, "rental:a_2026-09-15");
  assert.equal(c.cycleEnd, "2026-10-14");
  assert.equal(c.period, "2026-09");
  assert.equal(c.dueDate, "2026-09-15");
  assert.equal(c.previousCycleId, null);
});
