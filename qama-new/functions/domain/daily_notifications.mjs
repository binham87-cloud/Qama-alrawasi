/**
 * Derived daily-booking reminders. Nothing here writes money or marks a guest out.
 * Times are Asia/Dubai. One booking produces at most one notice.
 */

const DUBAI = "Asia/Dubai";
export const DEFAULT_DAILY_CHECKOUT_TIME = "12:00";
/** Notices start on this Dubai calendar date. Earlier checkouts stay in history only. */
export const NOTICE_EFFECTIVE_DATE = "2026-10-20";

function bookingCancelled(booking) {
  if (!booking) return true;
  if (booking.cancelled === true || booking.canceled === true || booking.deleted === true || booking.reversed === true) {
    return true;
  }
  const status = String(booking.status || "").toLowerCase();
  return status === "cancelled" || status === "canceled" || status === "deleted" || status === "reversed";
}

export function isDailyCheckedOut(booking) {
  return !!(booking && (booking.checkedOutAt || booking.checkoutRecorded === true));
}

export function dubaiParts(date = new Date()) {
  const when = date instanceof Date ? date : new Date(date);
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: DUBAI,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(when).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${hour}:${parts.minute}`,
    minutes: Number(hour) * 60 + Number(parts.minute),
  };
}

export function checkoutTimeOf(booking) {
  const raw = String((booking && booking.checkoutTime) || DEFAULT_DAILY_CHECKOUT_TIME);
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(raw) ? raw : DEFAULT_DAILY_CHECKOUT_TIME;
}

function minutesOf(time) {
  const [hour, minute] = String(time).split(":");
  return Number(hour) * 60 + Number(minute);
}

function calendarDaysBetween(fromDate, toDate) {
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const to = Date.parse(`${toDate}T00:00:00Z`);
  return Math.round((to - from) / 86400000);
}

/**
 * before_24h: the checkout instant is within the next 24 hours and still on a later Dubai date.
 * checkout_day: today in Dubai is the checkout date and the checkout time has not passed.
 * overdue: the checkout time has passed and nobody recorded checkout or an extension.
 */
export function dailyExpiryNotice(booking, now = new Date()) {
  if (!booking || booking.id == null || booking.id === "") return null;
  if (bookingCancelled(booking)) return null;
  if (isDailyCheckedOut(booking)) return null;
  const end = String(booking.endDate || "").slice(0, 10);
  const start = String(booking.startDate || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) return null;
  if (end < NOTICE_EFFECTIVE_DATE) return null;
  const when = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(when.getTime())) return null;
  const dubai = dubaiParts(when);
  const checkoutTime = checkoutTimeOf(booking);
  const dayDelta = calendarDaysBetween(dubai.date, end);
  let kind = null;
  if (dayDelta < 0 || (dayDelta === 0 && dubai.minutes > minutesOf(checkoutTime))) kind = "overdue";
  else if (dayDelta === 0) kind = "checkout_day";
  else if (dayDelta === 1 && dubai.minutes >= minutesOf(checkoutTime)) kind = "before_24h";
  if (!kind) return null;
  return {
    id: `daily-expiry:${booking.id}:${kind}:${end}:${checkoutTime}`,
    bookingId: String(booking.id),
    kind,
    apartment: booking.unitName || "",
    partition: booking.partName || booking.partId || "",
    partId: booking.partId || "",
    place: booking.partLabel || "",
    guest: booking.guest || booking.tenantName || "",
    startDate: start,
    endDate: end,
    checkoutDate: end,
    checkoutTime,
    status: kind === "overdue" ? "occupied_after_checkout" : "occupied",
    checkedOut: false,
    period: String(booking.financialPeriod || booking.homePeriod || end.slice(0, 7)),
    total: booking.total,
    receiptId: booking.receiptId || null,
  };
}

export function dailyExpiryNotices(bookings, now = new Date()) {
  const seen = new Set();
  const notices = [];
  for (const booking of bookings || []) {
    const notice = dailyExpiryNotice(booking, now);
    if (!notice || seen.has(notice.bookingId)) continue;
    seen.add(notice.bookingId);
    notices.push(notice);
  }
  return notices;
}
