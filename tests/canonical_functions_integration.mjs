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
const admin = adminInit({ projectId }, "canonical-integration-admin");
const adb = getAdminFirestore(admin); const aauth = getAdminAuth(admin);

await adb.collection("users").doc("uid_yahia_v2").set({ userKey: "yahia_v2", role: "employee", active: true });
await adb.collection("users").doc("uid_saeed_v2").set({ userKey: "saeed_v2", role: "owner", active: true });
await adb.collection("config").doc("system").set({ financialTruthVersion: 3, buildId: "qama-phase3c-canonical-events-2026-08-11.4" });
await adb.collection("rentalCycles").doc("cycle:integration:1").set({ id: "cycle:integration:1", tenancyId: "integration", baseAmountFils: 300000, reportingMonth: "2026_07", dueDate: "2026-08-10", status: "open_not_due", schemaVersion: 2 });
for (const account of ["company", "revenue", "deduction"]) await adb.collection("accountBalances").doc(account).set({ account, amountFils: account === "company" ? 1000000 : 0, version: 0, schemaVersion: 3 });

async function client(uid, name) {
  try { await aauth.createUser({ uid }); } catch {}
  const app = initializeApp({ projectId, apiKey: "fake-api-key", appId: `app-${name}` }, name);
  const auth = getAuth(app); connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  await signInWithCustomToken(auth, await aauth.createCustomToken(uid));
  const functions = getFunctions(app); connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  return { command: httpsCallable(functions, "financialCommand"), read: httpsCallable(functions, "operationalReadModel") };
}

const employeeClient = await client("uid_yahia_v2", "canonical-employee");
const managerClient = await client("uid_saeed_v2", "canonical-manager");
const employee = employeeClient.command;
const manager = managerClient.command;
const cash = { command: "createCashReceipt", operationId: "op:integration:cash:001", payload: { cycleId: "cycle:integration:1", amountFils: 100000, paymentDate: "2026-07-30" } };
let c1,c2;
try { [c1,c2] = await Promise.all([employee(cash), employee(cash)]); }
catch (e) { console.error("INTEGRATION_CALL_FAILED", e?.code, e?.message, e?.details, e?.stack); process.exit(1); }
assert.equal(c1.data.remainingCollectibleFils, 200000); assert.equal(c2.data.remainingCollectibleFils, 200000);

await employee({ command: "createDepositRequest", operationId: "op:integration:dep:req", payload: { allocations: [{ cashLotId: "lot:op:integration:cash:001", amountFils: 100000 }], depositDate: "2026-08-02" } });
await manager({ command: "approveDeposit", operationId: "op:integration:dep:approve", payload: { depositRequestId: "dep:op:integration:dep:req" } });
const alloc = (await adb.collection("paymentAllocations").doc("alloc:op:integration:cash:001").get()).data();
const revenue = (await adb.collection("accountBalances").doc("revenue").get()).data();
const op = await adb.collection("financialOperations").doc(cash.operationId).get();
assert.equal(alloc.amountFils, 100000); assert.equal(alloc.settlementStatus, "settled"); assert.equal(revenue.amountFils, 100000);
assert.equal(op.exists, true);
assert.equal((await adb.collection("collectionEvents").where("paymentId", "==", "pay:op:integration:cash:001").get()).size, 1);
const managerView = (await managerClient.read({ monthKey: "2026_07", asOfDate: "2026-08-02" })).data;
assert.equal(managerView.projection.cards.targetFils, 300000);
assert.equal(managerView.projection.cards.collectedFils, 100000);
assert.equal(managerView.projection.cards.receivedNotDepositedFils, 0);
assert.equal(managerView.balances.revenue, 100000);
const employeeView = (await employeeClient.read({ monthKey: "2026_07", asOfDate: "2026-08-02" })).data;
assert.equal(employeeView.projection.cards.collectedFils, 100000);
assert.equal(employeeView.balances, null);
assert.equal(employeeView.projection.accounting, undefined);
// A second independent browser/session sees server canonical state, not the
// first browser's local mutation.
const browserB = await client("uid_yahia_v2", "canonical-employee-browser-b");
const browserBView = (await browserB.read({ monthKey: "2026_07", asOfDate: "2026-08-02" })).data;
assert.equal(browserBView.projection.cards.collectedFils, 100000);
const reserveCommand = { command: "createInstallmentReserveTransfer", operationId: "op:integration:reserve:001", payload: { amountFils: 175000, reason: "synthetic authorized reserve", effectiveDate: "2026-07-31" } };
const reserveA = await manager(reserveCommand); const reserveB = await manager(reserveCommand);
assert.equal(reserveA.data.amountFils, 175000); assert.equal(reserveB.data.amountFils, 175000);
assert.equal((await adb.collection("accountBalances").doc("company").get()).data().amountFils, 825000);
assert.equal((await adb.collection("accountBalances").doc("deduction").get()).data().amountFils, 175000);
assert.equal((await adb.collection("balanceTransfers").where("operationId", "==", reserveCommand.operationId).get()).size, 1);
const bankInstallmentCommand = { command: "createBankInstallmentPayment", operationId: "op:integration:bank-installment:001", payload: { amountFils: 75000, reference: "synthetic bank reference", effectiveDate: "2026-07-31" } };
const bankA = await manager(bankInstallmentCommand); const bankB = await manager(bankInstallmentCommand);
assert.equal(bankA.data.amountFils, 75000); assert.equal(bankB.data.amountFils, 75000);
assert.equal((await adb.collection("accountBalances").doc("deduction").get()).data().amountFils, 100000);
assert.equal((await adb.collection("installments").where("operationId", "==", bankInstallmentCommand.operationId).get()).size, 1);
console.log(JSON.stringify({ tests: 16, pass: 16, fail: 0, remainingCollectibleFils: 200000, receivedNotDepositedFils: 0, collectedFils: 100000, revenueBalanceFils: 100000, installmentReserveRetryDeduplicated: true, bankInstallmentRetryDeduplicated: true, secondSessionCanonicalRead: true, employeeBalanceLeak: false }));
process.exit(0);
