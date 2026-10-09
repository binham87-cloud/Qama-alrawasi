/**
 * Firebase emulator integration — real Firestore transactions via Admin SDK.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { initializeApp, getApps, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getDb } from "../../functions/repositories/firestore.mjs";
import { executeCommand } from "../../functions/commands/index.mjs";
import { verifyPinForUser } from "../../functions/auth/index.mjs";
import { buildDashboard } from "../../functions/services/readModel.mjs";

const PROJECT = process.env.GCLOUD_PROJECT || "qama-new";
const now = () => new Date().toISOString();

async function wipe() {
  const { getFirestore } = await import("firebase-admin/firestore");
  const db = getFirestore();
  const cols = ["users","properties","units","spaces","rentals","obligations","receipts","deposits","expenses","accounts","operations","auditEvents","reversals","loginAttempts"];
  for (const c of cols) {
    const snap = await db.collection(c).get();
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    if (snap.size) await batch.commit();
  }
}

test.before(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error("FIRESTORE_EMULATOR_HOST required");
  }
  while (getApps().length) await deleteApp(getApps()[0]);
  initializeApp({ projectId: PROJECT });
  await wipe();
});

function readerDb(fs) {
  return {
    async getUser(userId) {
      const snap = await fs.collection("users").doc(String(userId)).get();
      return snap.exists ? { id: snap.id, ...snap.data() } : null;
    },
    async list(collection, wheres = []) {
      let q = fs.collection(collection);
      for (const [f, op, v] of wheres) q = q.where(f, op, v);
      const snap = await q.get();
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    },
  };
}

test("integration: M1 partial payment via real Firestore", async () => {
  const fs = getFirestore();
  const db = getDb(fs);
  const ownerActor = { userId: "owner1", role: "owner", active: true };

  await db.runTransaction(async (tx) => {
    const { hash, salt } = await tx.hashPin("1325");
    tx.create("users", "owner1", {
      id: "owner1", userId: "owner1", displayName: "سعيد", role: "owner", active: true,
      pinHash: hash, pinSalt: salt, createdAt: now(), createdBy: "seed", schemaVersion: 1,
    });
  });

  const login = await verifyPinForUser({
    db: readerDb(fs), userId: "owner1", pin: "1325", deviceKey: "test-integration",
    now: Date.now(), attempts: new Map(),
  });
  assert.equal(login.role, "owner");
  assert.equal(login.userId, "owner1");

  const prop = await executeCommand({ db, actor: ownerActor, command: "createProperty", payload: { name: "P" }, operationId: "op:prop:1", now: now() });
  const unit = await executeCommand({ db, actor: ownerActor, command: "createUnit", payload: { propertyId: prop.propertyId, name: "U", kind: "whole" }, operationId: "op:unit:1", now: now() });
  const space = await executeCommand({ db, actor: ownerActor, command: "createSpace", payload: { unitId: unit.unitId, name: "S" }, operationId: "op:space:1", now: now() });
  const rental = await executeCommand({ db, actor: ownerActor, command: "createRental", payload: {
    spaceId: space.spaceId, tenantName: "T", contractualAmountFils: 920000, dueDayOfMonth: 1, startDate: "2026-08-01",
  }, operationId: "op:rental:1", now: now() });
  const period = "2026-09";
  const obs = await executeCommand({ db, actor: ownerActor, command: "generateObligations", payload: { period }, operationId: "op:obs:1", now: now() });
  const obligationId = obs.obligationIds[0];

  await executeCommand({ db, actor: ownerActor, command: "createCashReceipt", payload: {
    obligationId, amountFils: 900000, collectionDate: "2026-09-05",
  }, operationId: "op:rcpt:1", now: now() });

  const dash = await buildDashboard({
    db: readerDb(fs), viewer: ownerActor, period, asOfDate: "2026-09-15",
  });
  assert.equal(dash.summary.collectedFils, 900000);
  assert.equal(dash.summary.remainingFils, 20000);
});
