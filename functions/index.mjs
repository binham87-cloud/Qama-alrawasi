import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { verifyPin } from "./pin_crypto.mjs";
import { buildFinancialCommand } from "./financial_commands.mjs";
import { buildOperationalCommand } from "./operational_commands.mjs";
import { buildCanonicalReadModel } from "./canonical_read_model.mjs";
import { buildStructuralCommand } from "./structural_commands.mjs";

initializeApp();
const db = getFirestore();

export const financialCommand = buildFinancialCommand(db);
export const operationalCommand = buildOperationalCommand(db);
export const operationalReadModel = buildCanonicalReadModel(db);
export const canonicalReadModel = operationalReadModel;
export const structuralCommand = buildStructuralCommand(db);

const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;
const USER_KEY_RE = /^[A-Za-z0-9_-]{1,40}$/;
const PIN_RE = /^\d{4}$/;

// قائمة عرض فقط لشاشة اختيار المستخدم. لا تُرجع UID أو دوراً أو أي مادة تحقق.
export const listPinUsers = onCall(async () => {
  const snap = await db.collection("authPins").where("active", "==", true).get();
  const users = snap.docs.map((d) => {
    const v = d.data() || {};
    return { userKey: d.id, name: String(v.name || d.id), sortOrder: Number(v.sortOrder) || 999 };
  }).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ar"));
  return { users: users.map(({ userKey, name }) => ({ userKey, name })) };
});

export const pinLogin = onCall(async (request) => {
  const userKey = String(request.data?.userKey || "").trim();
  const pin = String(request.data?.pin || "");
  if (!USER_KEY_RE.test(userKey) || !PIN_RE.test(pin)) {
    throw new HttpsError("invalid-argument", "PIN_INVALID");
  }

  const ref = db.collection("authPins").doc(userKey);
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false, reason: "PIN_INVALID" };
    const record = snap.data() || {};
    if (record.active === false) return { ok: false, reason: "PIN_INVALID" };

    const now = Timestamp.now();
    const lockedUntil = record.lockedUntil instanceof Timestamp ? record.lockedUntil : null;
    if (lockedUntil && lockedUntil.toMillis() > now.toMillis()) {
      return { ok: false, reason: "PIN_LOCKED" };
    }

    if (!verifyPin(pin, record)) {
      const failures = (Number(record.failedCount) || 0) + 1;
      const patch = { failedCount: failures, lastFailedAt: now, updatedAt: FieldValue.serverTimestamp() };
      if (failures >= MAX_FAILURES) {
        patch.failedCount = 0;
        patch.lockedUntil = Timestamp.fromMillis(now.toMillis() + LOCK_MINUTES * 60 * 1000);
      }
      tx.set(ref, patch, { merge: true });
      return { ok: false, reason: failures >= MAX_FAILURES ? "PIN_LOCKED" : "PIN_INVALID" };
    }

    tx.set(ref, {
      failedCount: 0,
      lockedUntil: null,
      lastLoginAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    return { ok: true, uid: String(record.uid || "") };
  });

  if (!result.ok) {
    throw new HttpsError(result.reason === "PIN_LOCKED" ? "resource-exhausted" : "permission-denied", result.reason);
  }
  if (!result.uid) throw new HttpsError("failed-precondition", "PROFILE_MISSING");

  const profileSnap = await db.collection("users").doc(result.uid).get();
  if (!profileSnap.exists) throw new HttpsError("failed-precondition", "PROFILE_MISSING");
  const profile = profileSnap.data() || {};
  if (profile.active === false || profile.userKey !== userKey) {
    throw new HttpsError("permission-denied", "PROFILE_INACTIVE");
  }

  const token = await getAuth().createCustomToken(result.uid, {
    userKey,
    role: String(profile.role || "employee")
  });
  return { token };
});
