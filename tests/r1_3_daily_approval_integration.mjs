/**
 * R1.3 — add_daily approval integration (emulators only).
 * Mirrors the Owner-approve client sequence: createDailyBooking then approveBusinessRequest.
 */
import assert from "node:assert/strict";
import { initializeApp as adminInit } from "firebase-admin/app";
import { getAuth as getAdminAuth } from "firebase-admin/auth";
import { getFirestore as getAdminFirestore } from "firebase-admin/firestore";
import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, signInWithCustomToken } from "firebase/auth";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";

process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";
const projectId = "qama-test";
const admin = adminInit({ projectId }, "r13-daily-admin");
const db = getAdminFirestore(admin);
const authAdmin = getAdminAuth(admin);

for (const [uid, userKey, role] of [["r13_owner", "saeed_r13", "owner"], ["r13_emp", "yahia_r13", "employee"]]) {
  await db.collection("users").doc(uid).set({ userKey, role, active: true, name: userKey });
  try { await authAdmin.createUser({ uid }); } catch {}
}
await db.collection("months").doc("2026_7").set({
  _rev: 1,
  data: {
    units: [{ id: "u1", name: "شقة 101", partitions: [{ id: 1, rent: 0, status: "vacant", tenant: "", version: 0 }] }],
    full: [], transactions: [], expenses: [], dailyBookings: [],
  },
});
for (const a of ["company", "revenue", "deduction"]) {
  await db.collection("accountBalances").doc(a).set({ account: a, amountFils: 0, version: 0, schemaVersion: 3 }, { merge: true });
}

async function callables(uid, name) {
  const app = initializeApp({ projectId, apiKey: "fake", appId: name }, name);
  const auth = getAuth(app);
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  await signInWithCustomToken(auth, await authAdmin.createCustomToken(uid));
  const functions = getFunctions(app);
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  return {
    op: httpsCallable(functions, "operationalCommand"),
    fin: httpsCallable(functions, "financialCommand"),
  };
}

const owner = await callables("r13_owner", "r13-owner-app");
const emp = await callables("r13_emp", "r13-emp-app");

const booking = {
  partId: "u1-1", partLabel: "شقة 101 / 1", guest: "نزيل R13",
  startDate: "2026-08-01", endDate: "2026-08-03", nights: 2,
  nightRate: 150, total: 300, paymentMethod: "cash", status: "paid",
};

// --- reject path: pending → reject → zero month/financial effect ---
const rejectId = "req_r13_daily_reject";
await emp.op({
  operationId: "submit:" + rejectId,
  payload: {
    command: "submitBusinessRequest",
    type: "add_daily",
    desc: "حجز يومي رفض",
    requestId: rejectId,
    requestPayload: { booking },
    byName: "yahia_r13",
    month: 7, year: 2026, monthId: "2026_7",
  },
});
assert.equal((await db.collection("requests").doc(rejectId).get()).data().status, "pending");
assert.equal(((await db.collection("months").doc("2026_7").get()).data().data.dailyBookings || []).length, 0);
await assert.rejects(emp.op({
  operationId: "approve-denied:" + rejectId,
  payload: { command: "approveBusinessRequest", requestId: rejectId, monthId: "2026_7" },
}));
const rejected = await owner.op({
  operationId: "reject:" + rejectId,
  payload: { command: "rejectRequest", requestId: rejectId },
});
assert.equal(rejected.data.status, "rejected");
assert.equal(((await db.collection("months").doc("2026_7").get()).data().data.dailyBookings || []).length, 0);
assert.equal((await db.collection("dailyBookings").get()).size, 0);

// --- approve path ---
const approveId = "req_r13_daily_approve";
await emp.op({
  operationId: "submit:" + approveId,
  payload: {
    command: "submitBusinessRequest",
    type: "add_daily",
    desc: "حجز يومي اعتماد",
    requestId: approveId,
    requestPayload: { booking: { ...booking, guest: "نزيل OK" } },
    byName: "yahia_r13",
    month: 7, year: 2026, monthId: "2026_7",
  },
});
assert.equal((await db.collection("requests").doc(approveId).get()).data().status, "pending");
assert.equal(((await db.collection("months").doc("2026_7").get()).data().data.dailyBookings || []).length, 0);

// Employee cannot mint daily booking directly.
await assert.rejects(emp.fin({
  command: "createDailyBooking",
  operationId: "fin:emp-bypass:" + approveId,
  payload: {
    unitId: "u1", tenant: "نزيل OK", amountFils: 30000, nights: 2,
    method: "cash", paymentDate: "2026-08-01", monthKey: "2026_7",
  },
}));

const fin1 = await owner.fin({
  command: "createDailyBooking",
  operationId: "ui:approve-daily:" + approveId,
  payload: {
    unitId: "u1", tenant: "نزيل OK", guestName: "نزيل OK", amountFils: 30000, nights: 2,
    method: "cash", paymentDate: "2026-08-01", monthKey: "2026_7",
  },
});
assert.equal(fin1.data.replay, false);
const finReplay = await owner.fin({
  command: "createDailyBooking",
  operationId: "ui:approve-daily:" + approveId,
  payload: {
    unitId: "u1", tenant: "نزيل OK", guestName: "نزيل OK", amountFils: 30000, nights: 2,
    method: "cash", paymentDate: "2026-08-01", monthKey: "2026_7",
  },
});
assert.equal(finReplay.data.replay, true);
assert.equal((await db.collection("dailyBookings").get()).size, 1);

const appr = await owner.op({
  operationId: "approve:" + approveId,
  payload: { command: "approveBusinessRequest", requestId: approveId, monthId: "2026_7" },
});
assert.equal(appr.data.status, "approved");
assert.equal(appr.data.replay, false);
const monthAfter = (await db.collection("months").doc("2026_7").get()).data().data;
assert.equal((monthAfter.dailyBookings || []).length, 1);
assert.equal(monthAfter.dailyBookings[0].requestId, approveId);

const apprReplay = await owner.op({
  operationId: "approve:" + approveId,
  payload: { command: "approveBusinessRequest", requestId: approveId, monthId: "2026_7" },
});
assert.equal(apprReplay.data.replay, true);
assert.equal(((await db.collection("months").doc("2026_7").get()).data().data.dailyBookings || []).length, 1);
assert.equal((await db.collection("dailyBookings").get()).size, 1);

// Second approve op id must not re-apply against non-pending.
await assert.rejects(owner.op({
  operationId: "approve-again:" + approveId,
  payload: { command: "approveBusinessRequest", requestId: approveId, monthId: "2026_7" },
}));

console.log(JSON.stringify({
  tests: 12, pass: 12, fail: 0,
  focus: ["add_daily_submit_pending", "employee_approve_denied", "employee_createDailyBooking_denied",
    "reject_zero_effect", "approve_financial_once", "approve_month_mirror_once", "replay_safe"],
}));
process.exit(0);
