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
const admin = adminInit({ projectId }, `concurrency-admin-${Date.now()}`);
const db = getAdminFirestore(admin); const authAdmin = getAdminAuth(admin);
await db.collection("config").doc("system").set({ financialTruthVersion: 3, buildId: "qama-phase3c-canonical-events-2026-08-11.4" });
await db.collection("config").doc("canonicalControl").set({ state: "CANONICAL_ACTIVE", version: 1 });

async function callable(uid, role, key) {
  try { await authAdmin.createUser({ uid }); } catch {}
  await db.collection("users").doc(uid).set({ userKey: key, role, active: true });
  const app = initializeApp({ projectId, apiKey: "fake", appId: `app-${uid}` }, `app-${uid}-${Date.now()}`);
  const auth = getAuth(app); connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  await signInWithCustomToken(auth, await authAdmin.createCustomToken(uid));
  const functions = getFunctions(app); connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  return httpsCallable(functions, "financialCommand");
}

const employeeA = await callable("uid_con_a", "employee", "employee:a");
const employeeB = await callable("uid_con_b", "employee", "employee:b");
const manager = await callable("uid_con_m", "owner", "manager:m");
for (const account of ["company", "revenue", "deduction"]) await db.collection("accountBalances").doc(account).set({ account, amountFils: account === "company" ? 100000 : 0, version: 0, schemaVersion: 2 });

const call = (fn, command, operationId, payload) => fn({ command, operationId, payload }).then((x) => ({ ok: true, data: x.data })).catch((error) => ({ ok: false, code: error.details || error.message }));
const seedCycle = async (id, amountFils = 100000) => db.collection("rentalCycles").doc(id).set({ id, tenancyId: id, baseAmountFils: amountFils, reportingMonth: "2026_07", dueDate: "2026-07-30", status: "open_late", financialVersion: 0, schemaVersion: 2 });

let passed = 0;
// Two devices compete for one remaining amount: exactly one succeeds.
await seedCycle("cycle:concurrency:collect", 100000);
const competing = await Promise.all([
  call(employeeA, "createCashReceipt", "op:con:collect:a", { cycleId: "cycle:concurrency:collect", amountFils: 100000, paymentDate: "2026-07-30" }),
  call(employeeB, "createCashReceipt", "op:con:collect:b", { cycleId: "cycle:concurrency:collect", amountFils: 100000, paymentDate: "2026-07-30" }),
]);
assert.equal(competing.filter((x) => x.ok).length, 1); assert.equal(competing.filter((x) => !x.ok).length, 1); passed++;

// Same stable operation 10x in parallel creates one payment/allocation/lot.
await seedCycle("cycle:concurrency:idem", 100000);
const idemPayload = { cycleId: "cycle:concurrency:idem", amountFils: 50000, paymentDate: "2026-07-30" };
const idem = await Promise.all(Array.from({ length: 10 }, () => call(employeeA, "createCashReceipt", "op:con:idem:one", idemPayload)));
assert.equal(idem.filter((x) => x.ok).length, 10);
assert.equal((await db.collection("payments").where("operationId", "==", "op:con:idem:one").get()).size, 1);
assert.equal((await db.collection("paymentAllocations").where("operationId", "==", "op:con:idem:one").get()).size, 1); passed++;
assert.equal((await db.collection("collectionEvents").where("operationId", "==", "op:con:idem:one").get()).size, 1);

// Deposit approval and custody confirmation compete for the same lot: only one consumes it.
await seedCycle("cycle:concurrency:cash", 100000);
await call(employeeA, "createCashReceipt", "op:con:cash:source", { cycleId: "cycle:concurrency:cash", amountFils: 100000, paymentDate: "2026-07-30" });
const line = [{ cashLotId: "lot:op:con:cash:source", amountFils: 100000 }];
await call(employeeA, "createDepositRequest", "op:con:cash:deposit", { amountFils: 100000, allocations: line, depositDate: "2026-08-02" });
await call(employeeA, "createCustodyTransfer", "op:con:cash:transfer", { to: "employee:b", amountFils: 100000, allocations: line });
const cashRace = await Promise.all([
  call(manager, "approveDeposit", "op:con:cash:approve", { depositRequestId: "dep:op:con:cash:deposit" }),
  call(employeeB, "confirmCustodyTransfer", "op:con:cash:confirm", { transferId: "xfer:op:con:cash:transfer" }),
]);
assert.equal(cashRace.filter((x) => x.ok).length, 1); passed++;

// Competing expenses cannot overdraw one materialized balance.
await call(employeeA, "requestExpense", "op:con:expense:q1", { amountFils: 80000, reason: "one" });
await call(employeeB, "requestExpense", "op:con:expense:q2", { amountFils: 80000, reason: "two" });
const expenseRace = await Promise.all([
  call(manager, "approveExpense", "op:con:expense:a1", { expenseId: "expense:op:con:expense:q1", account: "company" }),
  call(manager, "approveExpense", "op:con:expense:a2", { expenseId: "expense:op:con:expense:q2", account: "company" }),
]);
assert.equal(expenseRace.filter((x) => x.ok).length, 1);
assert.equal((await db.collection("accountBalances").doc("company").get()).data().amountFils, 20000); passed++;

console.log(JSON.stringify({ tests: 4, pass: passed, fail: 4 - passed, scenarios: ["competing_collection", "parallel_idempotency_10x", "deposit_vs_custody", "competing_expense_balance"] }));
process.exit(passed === 4 ? 0 : 1);
