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
const admin = adminInit({ projectId }, "wiring-integration-admin");
const adb = getAdminFirestore(admin);
const aauth = getAdminAuth(admin);

const empUid = "uid_wiring_emp";
const ownUid = "uid_wiring_own";
const spaceId = "space:wiring:101-3";
const month = "2026_08";

await adb.collection("users").doc(empUid).set({ userKey: "wiring_emp", role: "employee", active: true });
await adb.collection("users").doc(ownUid).set({ userKey: "wiring_own", role: "owner", active: true });
await adb.collection("config").doc("system").set({ financialTruthVersion: 3, buildId: "qama-wiring-local" }, { merge: true });
await adb.collection("rentableSpaces").doc(spaceId).set({
  id: spaceId, unitId: "unit:wiring:101", propertyId: "property:wiring",
  name: "بارتشن 3", partitionId: "3", status: "active",
});
for (const account of ["company", "revenue", "deduction"]) {
  await adb.collection("accountBalances").doc(account).set({ account, amountFils: account === "company" ? 1000000 : 0, version: 0, schemaVersion: 3 });
}

async function client(uid, name) {
  try { await aauth.createUser({ uid }); } catch {}
  const app = initializeApp({ projectId, apiKey: "fake-api-key", appId: `app-${name}` }, name);
  const auth = getAuth(app); connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  await signInWithCustomToken(auth, await aauth.createCustomToken(uid));
  const functions = getFunctions(app); connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  return httpsCallable(functions, "financialCommand");
}

const employee = await client(empUid, "wiring-employee");
const manager = await client(ownUid, "wiring-manager");

try {
  await manager({ command: "setSpaceRental", operationId: "x", payload: { spaceId, reportingMonth: month, occupancy: "vacant" } });
  assert.fail("short operationId must be rejected");
} catch (error) {
  const text = `${error.code || ""} ${error.message || ""}`;
  assert.ok(text.includes("invalid-argument") || text.includes("OPERATION_ID_INVALID"), text);
}

const rental = await employee({
  command: "setSpaceRental",
  operationId: "op:wiring:rental:001",
  payload: {
    spaceId, reportingMonth: month, occupancy: "occupied",
    contractualAmountFils: 130000, dueDate: "2026-08-01", startDate: "2026-08-01",
    tenantName: "أحمد", tenantPhone: "0501234567",
  },
});
assert.equal(rental.data.replay, false);
const tenant = (await adb.collection("tenants").doc(`tenant:${spaceId}`).get()).data();
const tenancy = (await adb.collection("tenancies").doc(`tenancy:${spaceId}`).get()).data();
const cycleId = `cycle:${spaceId}:${month}`;
const cycle = (await adb.collection("rentalCycles").doc(cycleId).get()).data();
assert.ok(tenant, "tenant persisted");
assert.ok(tenancy, "tenancy persisted");
assert.equal(tenancy.tenantId, `tenant:${spaceId}`);
assert.equal(cycle.baseAmountFils, 130000);
assert.equal(cycle.dueDate, "2026-08-01");

const corrected = await manager({
  command: "correctCycleDueDate",
  operationId: "op:wiring:due:001",
  payload: { cycleId, dueDate: "2026-08-10", reason: "تصحيح تاريخ الاستحقاق" },
});
assert.equal(corrected.data.dueDate, "2026-08-10");
assert.equal((await adb.collection("rentalCycles").doc(cycleId).get()).data().dueDate, "2026-08-10");

await employee({
  command: "createCashReceipt",
  operationId: "op:wiring:cash:001",
  payload: { cycleId, amountFils: 130000, paymentDate: "2026-08-05" },
});
const lotId = "lot:op:wiring:cash:001";
await employee({
  command: "createDepositRequest",
  operationId: "op:wiring:dep:req",
  payload: { allocations: [{ cashLotId: lotId, amountFils: 130000 }], amountFils: 130000, depositDate: "2026-08-06", monthKey: month },
});
await manager({
  command: "approveDeposit",
  operationId: "op:wiring:dep:approve",
  payload: { depositRequestId: "dep:op:wiring:dep:req" },
});
assert.equal((await adb.collection("accountBalances").doc("revenue").get()).data().amountFils, 130000);

await manager({
  command: "cancelDeposit",
  operationId: "op:wiring:dep:cancel",
  payload: { depositRequestId: "dep:op:wiring:dep:req", reason: "إلغاء إيداع اختبار" },
});
assert.equal((await adb.collection("accountBalances").doc("revenue").get()).data().amountFils, 0);
const reversals = (await adb.collection("cashMovements").where("type", "==", "deposit_reversal").get()).docs
  .filter((d) => String(d.id).includes("op:wiring:dep:cancel"));
assert.ok(reversals.length >= 1, "deposit_reversal movement persisted");
assert.equal((await adb.collection("deposits").doc("dep:op:wiring:dep:req").get()).data().status, "reversed");

console.log(JSON.stringify({
  tests: 5, pass: 5, fail: 0,
  setSpaceRentalPersisted: true,
  correctCycleDueDate: true,
  cancelDeposit: true,
  operationIdRejected: true,
}));
process.exit(0);
