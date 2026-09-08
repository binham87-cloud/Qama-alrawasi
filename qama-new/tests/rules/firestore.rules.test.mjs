import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from "@firebase/rules-unit-testing";

const rules = readFileSync(new URL("../../rules/firestore.rules", import.meta.url), "utf8");
const PROJECT = "qama-new-rules";

let testEnv;

test.before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT,
    firestore: { rules, host: "127.0.0.1", port: 8080 },
  });
});

test.beforeEach(async () => {
  await testEnv.clearFirestore();
});

test.after(async () => {
  await testEnv.cleanup();
});

async function seedUser(uid, role) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().collection("users").doc(uid).set({
      userId: uid, displayName: "test", role, active: true,
    });
  });
}

test("S6 employee cannot write receipts", async () => {
  await seedUser("emp1", "employee");
  const ctx = testEnv.authenticatedContext("emp1");
  await assertFails(ctx.firestore().collection("receipts").doc("r1").set({ amountFils: 100 }));
});

test("S7 client cannot read users pinHash", async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().collection("users").doc("u1").set({
      userId: "u1", role: "owner", active: true, pinHash: "secret", pinSalt: "s",
    });
  });
  const ctx = testEnv.authenticatedContext("u1");
  await assertFails(ctx.firestore().collection("users").doc("u1").get());
});

test("staff can read obligations", async () => {
  await seedUser("emp1", "employee");
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().collection("obligations").doc("o1").set({ period: "2026-09", state: "active" });
  });
  const ctx = testEnv.authenticatedContext("emp1");
  await assertSucceeds(ctx.firestore().collection("obligations").doc("o1").get());
});

test("employee reads own deposit", async () => {
  await seedUser("emp1", "employee");
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().collection("deposits").doc("d1").set({ employeeId: "emp1", state: "pending" });
  });
  const emp = testEnv.authenticatedContext("emp1");
  await assertSucceeds(emp.firestore().collection("deposits").doc("d1").get());
});

test("employee cannot read another employees deposit", async () => {
  await seedUser("emp1", "employee");
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().collection("deposits").doc("d2").set({ employeeId: "other", state: "pending" });
  });
  const emp = testEnv.authenticatedContext("emp1");
  await assertFails(emp.firestore().collection("deposits").doc("d2").get());
});

test("owner reads any deposit", async () => {
  await seedUser("owner1", "owner");
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().collection("deposits").doc("d2").set({ employeeId: "other", state: "pending" });
  });
  const owner = testEnv.authenticatedContext("owner1");
  await assertSucceeds(owner.firestore().collection("deposits").doc("d2").get());
});

test("operations collection denied to all clients", async () => {
  await seedUser("owner1", "owner");
  const ctx = testEnv.authenticatedContext("owner1");
  await assertFails(ctx.firestore().collection("operations").doc("op1").get());
});
