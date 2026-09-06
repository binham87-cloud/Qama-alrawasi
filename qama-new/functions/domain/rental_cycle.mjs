/**
 * Anniversary rental-cycle helpers (pure).
 * Cycle: [cycleStart, nextCycleStart) — rent due on cycleStart.
 * Day 29/30/31 clamps to last day of shorter months; restores when month allows
 * by using the rental's anniversary day (dueDayOfMonth), not the clamped prior day.
 */
import { DomainError, daysInMonth, periodOf } from "./finance.mjs";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function assertIsoDate(isoDate, code = "INVALID_DATE") {
  const s = String(isoDate || "").slice(0, 10);
  if (!ISO.test(s)) throw new DomainError(code, { isoDate });
  const [y, m, d] = s.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) {
    throw new DomainError(code, { isoDate: s });
  }
  return s;
}

/**
 * Add months keeping `anniversaryDay` (1–31), clamped to month length.
 * Prefer this over chaining from a previously clamped date.
 */
export function cycleStartAfterMonths(fromCycleStart, months, anniversaryDay) {
  const s = assertIsoDate(fromCycleStart);
  const [y0, m0] = s.split("-").map(Number);
  const day = Math.min(31, Math.max(1, Number(anniversaryDay) || Number(s.slice(8, 10))));
  const idx = y0 * 12 + (m0 - 1) + Number(months);
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  const d = Math.min(day, daysInMonth(y, m));
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** @deprecated Prefer cycleStartAfterMonths with anniversaryDay for restore-after-clamp. */
export function addMonthsClamped(isoDate, months) {
  const s = assertIsoDate(isoDate);
  const day = Number(s.slice(8, 10));
  return cycleStartAfterMonths(s, months, day);
}

/** Next cycle start = anniversary + N months (clamped to month length). */
export function nextCycleStart(cycleStart, months = 1, anniversaryDay = null) {
  const s = assertIsoDate(cycleStart);
  const day = anniversaryDay != null ? Number(anniversaryDay) : Number(s.slice(8, 10));
  return cycleStartAfterMonths(s, months, day);
}

/** Inclusive last day of cycle (day before next start). */
export function cycleEndInclusive(cycleStart, anniversaryDay = null) {
  const next = nextCycleStart(cycleStart, 1, anniversaryDay);
  const [y, m, d] = next.split("-").map(Number);
  const utc = Date.UTC(y, m - 1, d) - 86400000;
  const dt = new Date(utc);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

export function rentalCycleIdFor(rentalId, cycleStart) {
  const start = assertIsoDate(cycleStart);
  return `${rentalId}_${start}`;
}

export function cyclePeriod(cycleStart) {
  return periodOf(assertIsoDate(cycleStart));
}

/** Days from asOf until cycleStart (negative if already due/past). */
export function daysUntilCycleStart(cycleStart, asOfDate) {
  const a = assertIsoDate(asOfDate);
  const c = assertIsoDate(cycleStart);
  const ms = Date.UTC(+c.slice(0, 4), +c.slice(5, 7) - 1, +c.slice(8, 10))
    - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
  return Math.round(ms / 86400000);
}

/**
 * Renew button may appear when next cycle starts within `earlyWindowDays`
 * or is already due. Creation still requires an explicit command (no auto-create).
 */
export function renewButtonVisible(nextCycleStartDate, asOfDate, earlyWindowDays = 7) {
  const days = daysUntilCycleStart(nextCycleStartDate, asOfDate);
  return days <= Number(earlyWindowDays || 0);
}

export function buildCycleFields({
  rentalId, cycleStart, previousCycleId = null, amountFils, tenantName, anniversaryDay = null,
}) {
  const start = assertIsoDate(cycleStart);
  const day = anniversaryDay != null ? Number(anniversaryDay) : Number(start.slice(8, 10));
  return {
    id: rentalCycleIdFor(rentalId, start),
    rentalCycleId: rentalCycleIdFor(rentalId, start),
    rentalId,
    cycleStart: start,
    cycleEnd: cycleEndInclusive(start, day),
    previousCycleId: previousCycleId || null,
    period: cyclePeriod(start),
    dueDate: start,
    amountFils,
    tenantNameSnapshot: tenantName || null,
    anniversaryDay: day,
  };
}
