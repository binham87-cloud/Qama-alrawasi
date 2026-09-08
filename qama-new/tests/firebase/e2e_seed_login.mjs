/**
 * E2E: seed → login callable → read callable with real Firestore emulator.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { initializeApp, getApps, deleteApp } from "firebase-admin/app";
import { execSync } from "node:child_process";
import { initializeApp as initClient, deleteApp as deleteClientApp } from "firebase/app";
import { getAuth, connectAuthEmulator, signInWithCustomToken } from "firebase/auth";
import { getFunctions, connectFunctionsEmulator, httpsCallable } from "firebase/functions";

const PROJECT = process.env.GCLOUD_PROJECT || "qama-new";
const HOST = "127.0.0.1";

test.before(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("FIRESTORE_EMULATOR_HOST required");
  while (getApps().length) await deleteApp(getApps()[0]);
  initializeApp({ projectId: PROJECT });
  execSync("node seed/seed.mjs", {
    env: { ...process.env, FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST, GCLOUD_PROJECT: PROJECT },
    stdio: "pipe",
  });
});

async function withClient(name, fn) {
  const app = initClient({ apiKey: "demo", projectId: PROJECT, appId: `demo-${name}` }, name);
  const auth = getAuth(app);
  const functions = getFunctions(app, "me-central1");
  connectAuthEmulator(auth, `http://${HOST}:9099`, { disableWarnings: true });
  connectFunctionsEmulator(functions, HOST, 5001);
  try {
    await fn({ auth, functions });
  } finally {
    await deleteClientApp(app);
  }
}

test("E2E: seeded login and read show property", async () => {
  await withClient("owner-read", async ({ auth, functions }) => {
    const listFn = httpsCallable(functions, "listLoginUsers");
    const { data: listed } = await listFn({});
    const owner = (listed.users || []).find((u) => u.role === "owner");
    assert.ok(owner);
    const loginFn = httpsCallable(functions, "login");
    const { data: loginData } = await loginFn({ userId: owner.userId, pin: "1325" });
    assert.ok(loginData.customToken);
    await signInWithCustomToken(auth, loginData.customToken);

    const period = new Date().toISOString().slice(0, 7);
    const readFn = httpsCallable(functions, "read");
    const { data: readData } = await readFn({ period });
    assert.equal(readData.actor.role, "owner");
    assert.ok(readData.app.properties.length >= 1);
    assert.ok(readData.app.rentals.length >= 1);
    assert.ok(readData.dashboard.obligations.length >= 1);
  });
});

test("E2E: employee workflow partial cash receipt", async () => {
  await withClient("employee-rcpt", async ({ auth, functions }) => {
    const listFn = httpsCallable(functions, "listLoginUsers");
    const { data: listed } = await listFn({});
    const emp = (listed.users || []).find((u) => u.displayName === "يحيى" || u.role === "employee");
    assert.ok(emp);
    const loginFn = httpsCallable(functions, "login");
    const { data: loginData } = await loginFn({ userId: emp.userId, pin: "6477" });
    await signInWithCustomToken(auth, loginData.customToken);

    const period = new Date().toISOString().slice(0, 7);
    const readFn = httpsCallable(functions, "read");
    const { data: before } = await readFn({ period });
    const ob = before.dashboard.obligations[0];
    assert.ok(ob);

    const cmdFn = httpsCallable(functions, "command");
    await cmdFn({
      name: "createCashReceipt",
      operationId: `e2e:rcpt:${Date.now()}`,
      payload: { obligationId: ob.obligationId, amountFils: 900000, collectionDate: new Date().toISOString().slice(0, 10) },
    });

    const { data: after } = await readFn({ period });
    const ob2 = after.dashboard.obligations.find((o) => o.obligationId === ob.obligationId);
    assert.equal(ob2.paidFils, 900000);
    assert.equal(ob2.status, "partial");
  });
});
