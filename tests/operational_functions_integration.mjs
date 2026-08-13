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
const admin = adminInit({ projectId }, "operational-integration-admin");
const db = getAdminFirestore(admin); const authAdmin = getAdminAuth(admin);
for (const [uid, userKey, role] of [["op_owner", "saeed_op", "owner"], ["op_employee", "yahia_op", "employee"]]) {
  await db.collection("users").doc(uid).set({ userKey, role, active: true });
  try { await authAdmin.createUser({ uid }); } catch {}
}
await db.collection("months").doc("2026_7").set({ _rev: 4, data: { units: [{ id: "u1", name: "شقة 101", partitions: [{ id: 8, note: "old", phone: "050", operationalVersion: 0, rent: 3000, paid_amount: 0 }] }], full: [], transactions: [] } });

async function command(uid, name) {
  const app = initializeApp({ projectId, apiKey: "fake", appId: name }, name);
  const auth = getAuth(app); connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  await signInWithCustomToken(auth, await authAdmin.createCustomToken(uid));
  const functions = getFunctions(app); connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  return httpsCallable(functions, "operationalCommand");
}
const owner = await command("op_owner", "op-owner-app");
const employee = await command("op_employee", "op-employee-app");
const request = { operationId: "operational:test:0001", payload: { monthId: "2026_7", target: { entityType: "partition", unitId: "u1", entityId: 8 }, patch: { note: "new" }, baseVersion: 0 } };
const [first, replay] = await Promise.all([owner(request), owner(request)]);
assert.equal(first.data.version, 1); assert.equal(replay.data.version, 1);
let snap = await db.collection("months").doc("2026_7").get();
assert.equal(snap.data().data.units[0].partitions[0].note, "new");
assert.equal(snap.data().data.units[0].partitions[0].rent, 3000);

await assert.rejects(owner({ operationId: "operational:test:0002", payload: { monthId: "2026_7", target: { entityType: "partition", unitId: "u1", entityId: 8 }, patch: { phone: "055", collected: 999 }, baseVersion: 1 } }));
snap = await db.collection("months").doc("2026_7").get();
assert.equal(snap.data().data.units[0].partitions[0].phone, "050");
assert.equal(snap.data().data.units[0].partitions[0].collected, undefined);
await assert.rejects(employee({ operationId: "operational:test:0003", payload: { monthId: "2026_7", target: { entityType: "partition", unitId: "u1", entityId: 8 }, patch: { phone: "055" }, baseVersion: 1 } }));
await assert.rejects(owner({ operationId: "operational:test:0004", payload: { monthId: "2026_7", target: { entityType: "partition", unitId: "u1", entityId: 8 }, patch: { phone: "055" }, baseVersion: 0 } }));

await db.collection("requests").doc("req_reject_1").set({
  id: "req_reject_1", type: "update_partition", desc: "تصحيح رقم الهاتف",
  payload: { unitId: "u1", partId: 8, fields: { phone: "055" } },
  by: "yahia_op", byName: "يحيى", month: 7, year: 2026, status: "pending",
  createdAt: "2026-08-01T00:00:00.000Z",
});
for (const account of ["company", "revenue", "deduction"]) {
  await db.collection("accountBalances").doc(account).set({ account, amountFils: account === "revenue" ? 250000 : 100000, version: 0, schemaVersion: 3 }, { merge: true });
}
const balancesBefore = Object.fromEntries(await Promise.all(["company", "revenue", "deduction"].map(async (account) => [account, (await db.collection("accountBalances").doc(account).get()).data().amountFils])));
const ledgerBefore = (await db.collection("financialLedger").get()).size;

await assert.rejects(employee({ operationId: "rejectRequest:req_reject_1:denied", payload: { command: "rejectRequest", requestId: "req_reject_1" } }));
assert.equal((await db.collection("requests").doc("req_reject_1").get()).data().status, "pending");

const rejected = await owner({ operationId: "rejectRequest:req_reject_1:once", payload: { command: "rejectRequest", requestId: "req_reject_1" } });
assert.equal(rejected.data.status, "rejected");
assert.equal(rejected.data.financialEffectFils, 0);
assert.equal(rejected.data.replay, false);

const rejectReplay = await owner({ operationId: "rejectRequest:req_reject_1:once", payload: { command: "rejectRequest", requestId: "req_reject_1" } });
assert.equal(rejectReplay.data.replay, true);
assert.equal(rejectReplay.data.status, "rejected");
assert.equal((await db.collection("requests").doc("req_reject_1").get()).data().status, "rejected");

await assert.rejects(owner({ operationId: "rejectRequest:req_reject_1:second", payload: { command: "rejectRequest", requestId: "req_reject_1" } }));
for (const account of ["company", "revenue", "deduction"]) {
  assert.equal((await db.collection("accountBalances").doc(account).get()).data().amountFils, balancesBefore[account], account);
}
assert.equal((await db.collection("financialLedger").get()).size, ledgerBefore);
assert.equal((await db.collection("auditEvents").doc("operational:rejectRequest:req_reject_1:once").get()).exists, true);

console.log(JSON.stringify({ tests: 13, pass: 13, fail: 0 }));
process.exit(0);
