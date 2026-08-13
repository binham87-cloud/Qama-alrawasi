/**
 * Explicit month-key conversion between:
 * - storage keys used by months/{id}:      YYYY_M   (0-based month index, unpadded)
 * - reporting keys used by cycles/UI:      YYYY_MM  (1-based calendar month, zero-padded)
 * - ISO-derived keys from monthOf(date):   YYYY_M|YYYY_MM (1-based, unpadded or padded)
 *
 * Never rename Production month documents. Convert at the boundary.
 */

const STORAGE_RE = /^(\d{4})_(\d{1,2})$/;
const REPORTING_RE = /^(\d{4})_(\d{2})$/;

export function storageMonthKey(year, monthIndex0) {
  const y = Number(year);
  const m = Number(monthIndex0);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new Error("MONTH_KEY_INVALID");
  if (!Number.isInteger(m) || m < 0 || m > 11) throw new Error("MONTH_KEY_INVALID");
  return `${y}_${m}`;
}

export function reportingMonthKey(year, monthIndex0) {
  const y = Number(year);
  const m = Number(monthIndex0);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new Error("MONTH_KEY_INVALID");
  if (!Number.isInteger(m) || m < 0 || m > 11) throw new Error("MONTH_KEY_INVALID");
  return `${y}_${String(m + 1).padStart(2, "0")}`;
}

/** Convert months/{2026_7} → reporting 2026_08 */
export function storageToReportingMonthKey(storageKey) {
  const m = STORAGE_RE.exec(String(storageKey || ""));
  if (!m) throw new Error("MONTH_KEY_INVALID");
  const monthIndex0 = Number(m[2]);
  if (monthIndex0 < 0 || monthIndex0 > 11) throw new Error("MONTH_KEY_INVALID");
  return `${m[1]}_${String(monthIndex0 + 1).padStart(2, "0")}`;
}

/** Convert reporting 2026_08 → months/{2026_7} */
export function reportingToStorageMonthKey(reportingKey) {
  const raw = String(reportingKey || "");
  const padded = REPORTING_RE.exec(raw);
  if (padded) {
    const calendarMonth = Number(padded[2]);
    if (calendarMonth < 1 || calendarMonth > 12) throw new Error("MONTH_KEY_INVALID");
    return `${padded[1]}_${calendarMonth - 1}`;
  }
  const loose = STORAGE_RE.exec(raw);
  if (!loose) throw new Error("MONTH_KEY_INVALID");
  const calendarMonth = Number(loose[2]);
  // Ambiguous form like 2026_7: treat as 1-based calendar when value is 1..12
  // only when the caller already passed a reporting-shaped key from monthOf.
  // Prefer explicit reporting (zero-padded) at API boundaries.
  if (calendarMonth < 1 || calendarMonth > 12) throw new Error("MONTH_KEY_INVALID");
  return `${loose[1]}_${calendarMonth - 1}`;
}

/**
 * Normalize any accepted inbound key to reporting form YYYY_MM.
 * Accepts: 2026_08 (reporting), 2026_7 (storage 0-based), 2026_8 (ISO monthOf).
 * Disambiguation:
 * - zero-padded 2-digit → reporting (1-based)
 * - single-digit or unpadded → if hint==="storage" treat as 0-based; else 1-based calendar
 */
export function toReportingMonthKey(key, hint = "auto") {
  const raw = String(key || "");
  if (REPORTING_RE.test(raw) && raw.split("_")[1].length === 2) return raw;
  const m = STORAGE_RE.exec(raw);
  if (!m) throw new Error("MONTH_KEY_INVALID");
  const n = Number(m[2]);
  if (hint === "storage") {
    if (n < 0 || n > 11) throw new Error("MONTH_KEY_INVALID");
    return `${m[1]}_${String(n + 1).padStart(2, "0")}`;
  }
  if (hint === "calendar") {
    if (n < 1 || n > 12) throw new Error("MONTH_KEY_INVALID");
    return `${m[1]}_${String(n).padStart(2, "0")}`;
  }
  // auto: 2-digit already handled; unpadded 0..11 with leading ambiguity —
  // values 0 are always storage; 1..11 prefer calendar (monthOf / reporting unpadded)
  // because financial engine monthOf("2026-08-01") → "2026_8".
  if (n === 0) return `${m[1]}_01`;
  if (n >= 1 && n <= 12) return `${m[1]}_${String(n).padStart(2, "0")}`;
  throw new Error("MONTH_KEY_INVALID");
}

export function toStorageMonthKey(key, hint = "auto") {
  return reportingToStorageMonthKey(toReportingMonthKey(key, hint === "storage" ? "storage" : hint === "calendar" ? "calendar" : "auto"));
}

export const monthKeyInternals = Object.freeze({ STORAGE_RE, REPORTING_RE });
