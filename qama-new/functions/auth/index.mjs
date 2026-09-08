/**
 * Authentication.
 *
 * The PIN is verified on the server against a scrypt hash. The client receives a Firebase
 * custom token and nothing else — no role, no user list, no PIN material. Role is re-read
 * from the database on every command, so a client claiming a role is simply ignored.
 */
import { hashPinWith, keylenForStoredHash, safeEqual } from "../repositories/firestore.mjs";
import { scryptSync } from "node:crypto";

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

/** Sync helper for unit tests — same scrypt params as hashPinWith. */
export function verifyPinConstantTime(pin, user) {
  if (!user?.pinHash || !user?.pinSalt) return false;
  const keylen = keylenForStoredHash(user.pinHash);
  const candidate = scryptSync(String(pin), user.pinSalt, keylen, { N: 16384, r: 8, p: 1 }).toString("hex");
  return safeEqual(candidate, user.pinHash);
}

export async function verifyPin({ db, pin, deviceKey, now, attempts }) {
  const key = String(deviceKey || "unknown");
  const recent = (attempts.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_ATTEMPTS) {
    const error = new Error("TOO_MANY_ATTEMPTS");
    error.code = "TOO_MANY_ATTEMPTS";
    error.retryAfterMs = WINDOW_MS - (now - recent[0]);
    throw error;
  }

  const users = await db.listActiveUsers();
  let matched = null;
  // Check every candidate so the time taken does not reveal which user matched.
  for (const user of users) {
    const candidate = await hashPinWith(pin, user.pinSalt, keylenForStoredHash(user.pinHash));
    if (safeEqual(candidate, user.pinHash)) matched = user;
  }

  if (!matched) {
    recent.push(now);
    attempts.set(key, recent);
    const error = new Error("INVALID_PIN");
    error.code = "INVALID_PIN";
    throw error;
  }
  attempts.delete(key);
  return { userId: matched.id, displayName: matched.displayName, role: matched.role, active: true };
}

export async function verifyPinForUser({ db, userId, pin, deviceKey, now, attempts }) {
  const key = String(deviceKey || "unknown");
  const recent = (attempts.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_ATTEMPTS) {
    const error = new Error("TOO_MANY_ATTEMPTS");
    error.code = "TOO_MANY_ATTEMPTS";
    error.retryAfterMs = WINDOW_MS - (now - recent[0]);
    throw error;
  }
  if (!userId) {
    const error = new Error("USER_REQUIRED");
    error.code = "USER_REQUIRED";
    throw error;
  }
  const user = await db.getUser(userId);
  if (!user || user.active === false) {
    recent.push(now);
    attempts.set(key, recent);
    const error = new Error("INVALID_USER");
    error.code = "INVALID_USER";
    throw error;
  }
  const candidate = await hashPinWith(pin, user.pinSalt, keylenForStoredHash(user.pinHash));
  if (!safeEqual(candidate, user.pinHash)) {
    recent.push(now);
    attempts.set(key, recent);
    const error = new Error("INVALID_PIN");
    error.code = "INVALID_PIN";
    throw error;
  }
  attempts.delete(key);
  return { userId: user.id, displayName: user.displayName, role: user.role, active: true };
}

export function publicLoginUsers(users) {
  return (users || [])
    .filter((u) => u.active !== false)
    .map((u) => ({
      userId: u.userId || u.id,
      displayName: u.displayName || u.name || "مستخدم",
      role: u.role === "owner" ? "owner" : "employee",
    }))
    .sort((a, b) => {
      if (a.role !== b.role) return a.role === "owner" ? -1 : 1;
      return String(a.displayName).localeCompare(String(b.displayName), "ar");
    });
}

/** Loaded server-side on every command. The client's claim about itself is never used. */
export async function loadActor({ db, userId }) {
  const user = await db.getUser(userId);
  if (!user) { const e = new Error("UNAUTHENTICATED"); e.code = "UNAUTHENTICATED"; throw e; }
  if (user.active === false) { const e = new Error("ACCOUNT_DISABLED"); e.code = "ACCOUNT_DISABLED"; throw e; }
  return { userId: user.id, role: user.role, active: true, displayName: user.displayName };
}
