/**
 * Cloud Functions entry points. Three callables, nothing else.
 *
 *   login    — PIN → custom token. The only unauthenticated endpoint.
 *   command  — the single write path for the entire system.
 *   read     — derived read model.
 *
 * There is no debug endpoint, no test shortcut and no privileged client path.
 * Deploy marker: deposit-expense-revenue-2026-09-04
 * Deploy marker: holding-invariant-2026-09-04
 */
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

import { executeCommand } from "./commands/index.mjs";
import { createFirestoreRepository } from "./repositories/firestore.mjs";
import { verifyPin, verifyPinForUser, publicLoginUsers, loadActor } from "./auth/index.mjs";
import { buildDashboard } from "./services/readModel.mjs";

initializeApp();
const firestore = getFirestore();
firestore.settings({ ignoreUndefinedProperties: true });
const repo = createFirestoreRepository(firestore);

/** Runtime identity that can mint custom tokens on this project. */
const CALLABLE_OPTS = {
  cors: true,
  region: "me-central1",
  serviceAccount: "qama-token-signer@qama-new-prod-2026.iam.gserviceaccount.com",
};

/** Attempt tracking is per-instance; a persistent store would harden it further. */
const attempts = new Map();

const readerDb = {
  async list(collection, wheres) {
    let q = firestore.collection(collection);
    for (const [f, op, v] of wheres) q = q.where(f, op, v);
    const snap = await q.get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  },
  async getUser(userId) {
    const snap = await firestore.collection("users").doc(String(userId)).get();
    return snap.exists ? { id: snap.id, ...snap.data() } : null;
  },
  async listActiveUsers() {
    const snap = await firestore.collection("users").where("active", "==", true).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  },
};

const fail = (error) => {
  const code = error?.code || "INTERNAL";
  const map = {
    UNAUTHENTICATED: "unauthenticated", ACCOUNT_DISABLED: "permission-denied",
    FORBIDDEN: "permission-denied", INVALID_PIN: "unauthenticated",
    INVALID_USER: "unauthenticated", USER_REQUIRED: "invalid-argument",
    TOO_MANY_ATTEMPTS: "resource-exhausted", UNKNOWN_COMMAND: "invalid-argument",
    UNKNOWN_FIELD: "invalid-argument", MISSING_FIELD: "invalid-argument",
    INVALID_FIELD: "invalid-argument", INVALID_OPERATION_ID: "invalid-argument",
  };
  throw new HttpsError(map[code] || "failed-precondition", code, error?.details || null);
};

/** Public directory for the login screen — names/roles only, no secrets. */
export const listLoginUsers = onCall({ ...CALLABLE_OPTS, invoker: "public" }, async () => {
  try {
    const users = await readerDb.listActiveUsers();
    return { users: publicLoginUsers(users) };
  } catch (error) { return fail(error); }
});

export const login = onCall({ ...CALLABLE_OPTS, invoker: "public" }, async (request) => {
  try {
    const pin = String(request.data?.pin || "");
    const userId = request.data?.userId ? String(request.data.userId) : "";
    if (!/^\d{4,12}$/.test(pin)) throw Object.assign(new Error("INVALID_PIN"), { code: "INVALID_PIN" });
    const user = userId
      ? await verifyPinForUser({
        db: readerDb, userId, pin, deviceKey: request.rawRequest?.ip || "unknown",
        now: Date.now(), attempts,
      })
      : await verifyPin({
        db: readerDb, pin, deviceKey: request.rawRequest?.ip || "unknown",
        now: Date.now(), attempts,
      });
    const customToken = await getAuth().createCustomToken(user.userId);
    return { customToken, user };
  } catch (error) { return fail(error); }
});

export const command = onCall(CALLABLE_OPTS, async (request) => {
  try {
    if (!request.auth?.uid) throw Object.assign(new Error("UNAUTHENTICATED"), { code: "UNAUTHENTICATED" });
    const actor = await loadActor({ db: readerDb, userId: request.auth.uid });
    return await executeCommand({
      db: repo, actor,
      command: String(request.data?.command || ""),
      payload: request.data?.payload,
      operationId: String(request.data?.operationId || ""),
      now: new Date().toISOString(),
    });
  } catch (error) { return fail(error); }
});

export const read = onCall(CALLABLE_OPTS, async (request) => {
  try {
    if (!request.auth?.uid) throw Object.assign(new Error("UNAUTHENTICATED"), { code: "UNAUTHENTICATED" });
    const viewer = await loadActor({ db: readerDb, userId: request.auth.uid });
    if (request.data?.what !== "dashboard") throw Object.assign(new Error("UNKNOWN_READ"), { code: "UNKNOWN_READ" });
    const period = String(request.data?.period || new Date().toISOString().slice(0, 7));
    if (!/^\d{4}-\d{2}$/.test(period)) throw Object.assign(new Error("INVALID_FIELD"), { code: "INVALID_FIELD" });
    return await buildDashboard({
      db: readerDb, viewer, period, asOfDate: new Date().toISOString().slice(0, 10),
    });
  } catch (error) { return fail(error); }
});
