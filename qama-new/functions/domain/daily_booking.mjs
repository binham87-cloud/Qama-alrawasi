/**
 * Daily booking occupancy is display and overlap only.
 * Money stays on the existing prepaid receipt, counted once.
 */

export function isCancelledDailyBooking(booking) {
  if (!booking) return true;
  if (booking.cancelled === true || booking.canceled === true || booking.deleted === true || booking.reversed === true) {
    return true;
  }
  const status = String(booking.status || "").toLowerCase();
  return status === "cancelled" || status === "canceled" || status === "deleted" || status === "reversed";
}

/** Inclusive stay. A booking that ends on the day another starts overlaps that day. */
export function dailyRangesOverlap(startA, endA, startB, endB) {
  const a0 = String(startA || "").slice(0, 10);
  const a1 = String(endA || "").slice(0, 10);
  const b0 = String(startB || "").slice(0, 10);
  const b1 = String(endB || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a0) || !/^\d{4}-\d{2}-\d{2}$/.test(a1)) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b0) || !/^\d{4}-\d{2}-\d{2}$/.test(b1)) return false;
  return a0 <= b1 && b0 <= a1;
}

export function classifyDailyBooking(booking, today) {
  if (isCancelledDailyBooking(booking)) return "cancelled";
  const start = String(booking.startDate || "").slice(0, 10);
  const end = String(booking.endDate || "").slice(0, 10);
  const day = String(today || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return "invalid";
  }
  if (day > end) return "expired";
  if (day < start) return "future";
  return "active";
}

export function monthEndIso(period) {
  const p = String(period || "");
  if (!/^\d{4}-\d{2}$/.test(p)) return null;
  const year = Number(p.slice(0, 4));
  const month = Number(p.slice(5, 7));
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${p}-${String(last).padStart(2, "0")}`;
}

export function stayIntersectsPeriod(start, end, period) {
  const monthStart = `${period}-01`;
  const monthEnd = monthEndIso(period);
  const a0 = String(start || "").slice(0, 10);
  const a1 = String(end || "").slice(0, 10);
  if (!monthEnd || !/^\d{4}-\d{2}-\d{2}$/.test(a0) || !/^\d{4}-\d{2}-\d{2}$/.test(a1)) return false;
  return a0 <= monthEnd && monthStart <= a1;
}

export function periodsTouchedByStay(start, end) {
  const a0 = String(start || "").slice(0, 10);
  const a1 = String(end || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a0) || !/^\d{4}-\d{2}-\d{2}$/.test(a1) || a1 < a0) return [];
  const periods = [];
  let year = Number(a0.slice(0, 4));
  let month = Number(a0.slice(5, 7));
  const last = a1.slice(0, 7);
  for (let guard = 0; guard < 36; guard++) {
    const period = `${year}-${String(month).padStart(2, "0")}`;
    periods.push(period);
    if (period >= last) break;
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return periods;
}

export function bookingsFromPeriodDoc(doc) {
  if (!doc) return [];
  let extras = {};
  try { extras = doc.extrasJson ? JSON.parse(doc.extrasJson) : (doc.extras || {}); }
  catch { extras = doc.extras || {}; }
  const home = doc.period || String(doc.id || "").replace(/^period:/, "");
  const list = Array.isArray(extras.dailyBookings) ? extras.dailyBookings : [];
  return list.filter(Boolean).map((booking) => ({ ...booking, homePeriod: booking.financialPeriod || home }));
}

/**
 * Bookings whose stay intersects `period`, from every stored month.
 * Money stays on the home period. Other months receive a display copy only.
 * If any copy of an id is cancelled, the stay is not occupied.
 */
export function occupancyBookingsForPeriod(periodDocs, period) {
  const cancelled = new Set();
  const copies = [];
  for (const doc of periodDocs || []) {
    for (const booking of bookingsFromPeriodDoc(doc)) {
      if (!booking.id) continue;
      if (isCancelledDailyBooking(booking)) {
        cancelled.add(String(booking.id));
        continue;
      }
      if (!stayIntersectsPeriod(booking.startDate, booking.endDate, period)) continue;
      const financialPeriod = booking.financialPeriod || booking.homePeriod;
      copies.push({
        ...booking,
        financialPeriod,
        displayOnly: booking.displayOnly === true || financialPeriod !== period,
      });
    }
  }
  const byId = new Map();
  for (const booking of copies) {
    if (cancelled.has(String(booking.id))) continue;
    const prev = byId.get(String(booking.id));
    if (!prev || (prev.displayOnly && !booking.displayOnly)) byId.set(String(booking.id), booking);
  }
  return [...byId.values()];
}

export function dailyOccupancyForPart({ bookings, partId, today }) {
  const rows = (bookings || []).filter((booking) => booking && String(booking.partId) === String(partId));
  const visible = rows.filter((booking) => !isCancelledDailyBooking(booking));
  const active = visible
    .filter((booking) => classifyDailyBooking(booking, today) === "active")
    .sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
  const upcoming = visible
    .filter((booking) => classifyDailyBooking(booking, today) === "future")
    .sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
  return {
    active: active[0] || null,
    upcoming: upcoming[0] || null,
    activeCount: active.length,
    historyCount: rows.length,
  };
}
