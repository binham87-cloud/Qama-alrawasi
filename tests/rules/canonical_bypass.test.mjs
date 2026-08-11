import { after, before, beforeEach, test } from "node:test";
import { initializeTestEnvironment, assertFails } from "@firebase/rules-unit-testing";
import { doc, setDoc, updateDoc } from "firebase/firestore";
import fs from "node:fs";

let env;
const users = {
  employee_uid: { userKey: "employee_1", role: "employee", active: true },
  owner_uid: { userKey: "owner_1", role: "owner", active: true },
};

before(async () => {
  env = await initializeTestEnvironment({ projectId: "qama-test", firestore: { rules: fs.readFileSync(new URL("../../firestore-v11.rules", import.meta.url), "utf8"), host: "127.0.0.1", port: 8080 } });
});
after(async () => env?.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const [uid, profile] of Object.entries(users)) await setDoc(doc(db, "users", uid), profile);
    await setDoc(doc(db, "config", "balances"), { companyBalance: 1000, revenueBalance: 1000, installmentBalance: 1000 });
    await setDoc(doc(db, "months", "2026_7"), { _rev: 1, data: { transactions: [], cashReceipts: [], units: [] } });
    await setDoc(doc(db, "bankPayments", "bp_seed"), { status: "pending", amount: 100, createdBy: "employee_1" });
    await setDoc(doc(db, "cashLots", "lot_seed"), { id: "lot_seed", originalAmountFils: 10000, currentHolder: "employee_1" });
    await setDoc(doc(db, "custodyTransfers", "xfer_seed"), { id: "xfer_seed", status: "pending", from: "employee_1", to: "owner_1" });
    await setDoc(doc(db, "expenses", "expense_seed"), { id: "expense_seed", status: "active", amountFils: 10000 });
    await setDoc(doc(db, "monthStates", "2026_7"), { id: "2026_7", status: "open" });
    await setDoc(doc(db, "payments", "pay_seed"), { id: "pay_seed", status: "pending", amountFils: 10000 });
  });
});

const as = (uid) => env.authenticatedContext(uid).firestore();
async function deniedForBoth(action) {
  await assertFails(action(as("employee_uid")));
  await assertFails(action(as("owner_uid")));
}

test("1 direct Revenue increase denied", () => deniedForBoth((db) => updateDoc(doc(db, "config", "balances"), { revenueBalance: 1100 })));
test("2 direct Revenue decrease denied", () => deniedForBoth((db) => updateDoc(doc(db, "config", "balances"), { revenueBalance: 900 })));
test("3 direct Company mutation denied", () => deniedForBoth((db) => updateDoc(doc(db, "config", "balances"), { companyBalance: 900 })));
test("4 direct Deduction mutation denied", () => deniedForBoth((db) => updateDoc(doc(db, "config", "balances"), { installmentBalance: 900 })));
test("5 direct legacy deposit append denied", () => deniedForBoth((db) => updateDoc(doc(db, "months", "2026_7"), { "data.transactions": [{ id: "fake", amount: 100 }] })));
test("6 direct cash holder mutation denied", () => deniedForBoth((db) => updateDoc(doc(db, "cashLots", "lot_seed"), { currentHolder: "owner_1" })));
test("7 direct custody transfer creation denied", () => deniedForBoth((db) => setDoc(doc(db, "custodyTransfers", "xfer_fake"), { status: "confirmed", from: "employee_1", to: "owner_1", amountFils: 10000 })));
test("8 direct bank approval denied", () => deniedForBoth((db) => updateDoc(doc(db, "bankPayments", "bp_seed"), { status: "approved" })));
test("9 direct Remaining mutation denied", () => deniedForBoth((db) => updateDoc(doc(db, "months", "2026_7"), { "data.remaining": 0 })));
test("10 direct Paid/Collected status mutation denied", () => deniedForBoth((db) => updateDoc(doc(db, "months", "2026_7"), { "data.units": [{ status: "collected" }] })));
test("11 direct Ledger creation denied", () => deniedForBoth((db) => setDoc(doc(db, "financialLedger", "led_fake"), { amountFils: 10000, direction: "credit" })));
test("12 direct expense reversal denied", () => deniedForBoth((db) => updateDoc(doc(db, "expenses", "expense_seed"), { status: "reversed" })));
test("13 direct month close denied", () => deniedForBoth((db) => updateDoc(doc(db, "monthStates", "2026_7"), { status: "closed" })));
test("14 immutable financial event edit denied", () => deniedForBoth((db) => updateDoc(doc(db, "payments", "pay_seed"), { amountFils: 1 })));
test("15 fake financialOperations creation denied", () => deniedForBoth((db) => setDoc(doc(db, "financialOperations", "op_fake"), { status: "completed", result: { money: 1 } })));
