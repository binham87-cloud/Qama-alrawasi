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
console.log(JSON.stringify({ tests: 8, pass: 8, fail: 0 }));
process.exit(0);
