/**
 * Firestore-backed login rate limiting. Keyed by server-derived client identity, not client input alone.
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const COLLECTION = "loginAttempts";

function normalizeIp(rawRequest = {}) {
  const forwarded = rawRequest.headers?.["x-forwarded-for"] || rawRequest.headers?.["X-Forwarded-For"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  if (rawRequest.ip) return String(rawRequest.ip);
  if (rawRequest.socket?.remoteAddress) return String(rawRequest.socket.remoteAddress);
  return "unknown";
}

export function clientRateKey(rawRequest = {}) {
  const ip = normalizeIp(rawRequest);
  if (!ip || ip === "unknown") return "ip:server-local";
  return `ip:${ip}`;
}

export async function checkRateLimit(db, rateKey) {
  const doc = await db.getDocument(COLLECTION, rateKey);
  const now = Date.now();
  if (!doc) return { allowed: true };
  if (now > doc.resetAt) return { allowed: true };
  if (doc.count >= MAX_ATTEMPTS) {
    return { allowed: false, retryAfterMs: doc.resetAt - now };
  }
  return { allowed: true };
}

export async function recordFailedAttempt(db, rateKey) {
  const now = Date.now();
  await db.runTransaction(async (tx) => {
    const doc = await tx.get(COLLECTION, rateKey);
    if (!doc || now > doc.resetAt) {
      const data = { id: rateKey, count: 1, resetAt: now + WINDOW_MS, lastAttemptAt: now };
      if (doc) tx.update(COLLECTION, rateKey, data);
      else tx.create(COLLECTION, rateKey, data);
      return;
    }
    tx.update(COLLECTION, rateKey, { count: doc.count + 1, lastAttemptAt: now });
  });
}

export async function clearAttempts(db, rateKey) {
  await db.deleteDocument(COLLECTION, rateKey);
}
