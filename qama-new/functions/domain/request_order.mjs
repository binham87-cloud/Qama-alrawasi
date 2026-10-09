/**
 * Canonical work-request ordering.
 *
 * Primary key: server creation instant, newest first.
 * Approval, rejection, and update times never change this order.
 * A missing creation instant sorts as oldest — never as "now".
 * Equal instants tie-break by document id descending.
 */

const ISO_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)$/;
const DATE_RE = /^(\d{4}-\d{2}-\d{2})$/;

/** Trusted instant → comparable ISO or date string. Untrusted values become "". */
export function instantToIso(raw) {
  if (raw == null || raw === "") return "";
  if (typeof raw === "string") {
    const s = raw.trim();
    if (ISO_RE.test(s)) return s;
    if (DATE_RE.test(s)) return s;
    return "";
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const ms = raw > 1e12 ? raw : (raw > 1e9 ? raw * 1000 : 0);
    if (!ms) return "";
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString();
  }
  if (typeof raw === "object") {
    if (typeof raw.toDate === "function") {
      try {
        const d = raw.toDate();
        if (d instanceof Date && !Number.isNaN(d.getTime())) return d.toISOString();
      } catch { /* ignore broken timestamp */ }
    }
    const sec = raw.seconds ?? raw._seconds;
    const nano = raw.nanoseconds ?? raw._nanoseconds ?? 0;
    if (typeof sec === "number" && Number.isFinite(sec)) {
      const ms = (sec * 1000) + Math.floor(Number(nano) / 1e6);
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? "" : d.toISOString();
    }
  }
  return "";
}

/**
 * Creation instant used for ordering.
 * Never reads resolvedAt, approvedAt, rejectedAt, or updatedAt.
 */
export function canonicalRequestCreatedAt(record) {
  if (!record || typeof record !== "object") return "";
  const primary = instantToIso(record.createdAt ?? record.created_at);
  if (primary) return primary;
  const payload = record.payload && typeof record.payload === "object" ? record.payload : null;
  const fallbacks = [
    record.submittedAt,
    payload && payload.createdAt,
  ];
  for (const raw of fallbacks) {
    const iso = instantToIso(raw);
    if (iso) return iso;
  }
  return "";
}

export function compareRequestsNewestFirst(a, b) {
  const ca = canonicalRequestCreatedAt(a);
  const cb = canonicalRequestCreatedAt(b);
  if (ca !== cb) return ca < cb ? 1 : -1;
  const ia = String((a && a.id) || "");
  const ib = String((b && b.id) || "");
  if (ia !== ib) return ia < ib ? 1 : -1;
  return 0;
}

export function sortRequestsNewestFirst(records) {
  return (Array.isArray(records) ? records : []).slice().sort(compareRequestsNewestFirst);
}
