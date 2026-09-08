/**
 * Real callable authorization — authenticated employee sessions.
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

async function employeeSession(fn) {
  const app = initClient({ apiKey: "demo", projectId: PROJECT, appId: "sec-emp" }, "sec-emp");
  const auth = getAuth(app);
  const functions = getFunctions(app, "me-central1");
  connectAuthEmulator(auth, `http://${HOST}:9099`, { disableWarnings: true });
  connectFunctionsEmulator(functions, HOST, 5001);
  try {
    const listFn = httpsCallable(functions, "listLoginUsers");
    const { data: listed } = await listFn({});
    const emp = (listed.users || []).find((u) => u.role === "employee");
    assert.ok(emp, "employee user listed");
    const loginFn = httpsCallable(functions, "login");
    const { data } = await loginFn({ userId: emp.userId, pin: "6477" });
    await signInWithCustomToken(auth, data.customToken);
    const cmdFn = httpsCallable(functions, "command");
    await fn({ cmdFn, functions });
  } finally {
    await deleteClientApp(app);
  }
}

function assertForbidden(err) {
  const code = err?.code || "";
  const msg = err?.message || "";
  return code === "functions/failed-precondition" && (msg.includes("FORBIDDEN") || msg.includes("forbidden"));
}

test("authenticated employee cannot createProperty via callable", async () => {
  await employeeSession(async ({ cmdFn }) => {
    await assert.rejects(
      () => cmdFn({
        name: "createProperty",
        operationId: `sec:prop:${Date.now()}`,
        payload: { name: "hack" },
      }),
      (e) => assertForbidden(e)
    );
  });
});

test("authenticated employee cannot approveDeposit via callable", async () => {
  await employeeSession(async ({ cmdFn }) => {
    await assert.rejects(
      () => cmdFn({
        name: "approveDeposit",
        operationId: `sec:dep:${Date.now()}`,
        payload: { depositId: "dep:fake" },
      }),
      (e) => assertForbidden(e)
    );
  });
});

test("authenticated employee cannot approveBankReceipt via callable", async () => {
  await employeeSession(async ({ cmdFn }) => {
    await assert.rejects(
      () => cmdFn({
        name: "approveBankReceipt",
        operationId: `sec:bank:${Date.now()}`,
        payload: { receiptId: "rcpt:fake" },
      }),
      (e) => assertForbidden(e)
    );
  });
});

test("authenticated employee cannot createUser via callable", async () => {
  await employeeSession(async ({ cmdFn }) => {
    await assert.rejects(
      () => cmdFn({
        name: "createUser",
        operationId: `sec:user:${Date.now()}`,
        payload: { displayName: "hack", role: "owner", pin: "9999" },
      }),
      (e) => assertForbidden(e)
    );
  });
});
