/**
 * Real Firestore emulator concurrency — executeCommand against Admin SDK.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { initializeApp, getApps, deleteApp } from "firebase-admin/app";
import { getDb } from "../../functions/repositories/firestore.mjs";
import { executeCommand } from "../../functions/commands/index.mjs";
import { buildDashboard } from "../../functions/services/readModel.mjs";

const PROJECT = process.env.GCLOUD_PROJECT || "qama-new";
const now = () => new Date().toISOString();

async function wipe() {
  const { getFirestore } = await import("firebase-admin/firestore");
  const db = getFirestore();
  const cols = ["users","properties","units","spaces","rentals","obligations","receipts","deposits","expenses","accounts","operations","auditEvents","reversals","loginAttempts"];
  for (const c of cols) {
    const snap = await db.collection(c).get();
    if (!snap.empty) {
      const batch = db.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  }
}

async function createUsers(db, users) {
  for (const u of users) {
    await db.runTransaction(async (tx) => {
      const { hash, salt } = await tx.hashPin("1");
      tx.create("users", u.userId, {
        id: u.userId, userId: u.userId, role: u.role, active: true, pinHash: hash, pinSalt: salt,
        displayName: u.userId, createdAt: now(), createdBy: "test", schemaVersion: 1,
      });
    });
  }
}

async function seedBuilding(db, owner) {
  const ts = Date.now();
  const prop = await executeCommand({ db, actor: owner, command: "createProperty", payload: { name: "P" }, operationId: `cc:prop:${ts}`, now: now() });
  const unit = await executeCommand({ db, actor: owner, command: "createUnit", payload: { propertyId: prop.propertyId, name: "U", kind: "whole" }, operationId: `cc:unit:${ts}`, now: now() });
  const space = await executeCommand({ db, actor: owner, command: "createSpace", payload: { unitId: unit.unitId, name: "S" }, operationId: `cc:space:${ts}`, now: now() });
  const account = await executeCommand({ db, actor: owner, command: "createAccount", payload: { name: "A", kind: "company" }, operationId: `cc:acc:${ts}`, now: now() });
  await executeCommand({ db, actor: owner, command: "createRental", payload: {
    spaceId: space.spaceId, tenantName: "T", contractualAmountFils: 920000, dueDayOfMonth: 1, startDate: "2026-08-01",
  }, operationId: `cc:rental:${ts}`, now: now() });
  const period = "2026-09";
  const obs = await executeCommand({ db, actor: owner, command: "generateObligations", payload: { period }, operationId: `cc:obs:${ts}`, now: now() });
  return { obligationId: obs.obligationIds[0], period, accountId: account.accountId };
}

test.before(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("FIRESTORE_EMULATOR_HOST required");
  while (getApps().length) await deleteApp(getApps()[0]);
  initializeApp({ projectId: PROJECT });
  await wipe();
});

test("A: concurrent last-200 collections — one succeeds one fails", async () => {
  const db = getDb(PROJECT);
  const owner = { userId: "owner-a", role: "owner", active: true };
  const emp1 = { userId: "emp-a1", role: "employee", active: true };
  const emp2 = { userId: "emp-a2", role: "employee", active: true };
  await createUsers(db, [owner, emp1, emp2]);

  const { obligationId, period } = await seedBuilding(db, owner);
  await executeCommand({ db, actor: owner, command: "createCashReceipt", payload: {
    obligationId, amountFils: 900000, collectionDate: "2026-09-05",
  }, operationId: `cc:rcpt0:${Date.now()}`, now: now() });

  const payload = { obligationId, amountFils: 20000, collectionDate: "2026-09-06" };
  const results = await Promise.allSettled([
    executeCommand({ db, actor: emp1, command: "createCashReceipt", payload, operationId: `cc:race1:${Date.now()}`, now: now() }),
    executeCommand({ db, actor: emp2, command: "createCashReceipt", payload, operationId: `cc:race2:${Date.now()}`, now: now() }),
  ]);

  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);

  const dash = await buildDashboard(db, period, "2026-09-15");
  const ob = dash.obligations.find((o) => o.obligationId === obligationId);
  assert.equal(ob.paidFils, 920000);
  assert.equal(ob.remainingFils, 0);
});

test("B: concurrent deposit approvals — holding reduced once", async () => {
  const db = getDb(PROJECT);
  const owner = { userId: "owner-b", role: "owner", active: true };
  const emp = { userId: "emp-b", role: "employee", active: true };
  await createUsers(db, [owner, emp]);

  const { obligationId, period, accountId } = await seedBuilding(db, owner);
  await executeCommand({ db, actor: emp, command: "createCashReceipt", payload: {
    obligationId, amountFils: 500000, collectionDate: "2026-09-05",
  }, operationId: `cc:rcpt1:${Date.now()}`, now: now() });

  const dep = await executeCommand({ db, actor: emp, command: "submitDeposit", payload: {
    amountFils: 300000, depositDate: "2026-09-07", destinationAccountId: accountId,
  }, operationId: `cc:dep:${Date.now()}`, now: now() });

  const results = await Promise.allSettled([
    executeCommand({ db, actor: owner, command: "approveDeposit", payload: { depositId: dep.depositId }, operationId: `cc:ap1:${Date.now()}`, now: now() }),
    executeCommand({ db, actor: owner, command: "approveDeposit", payload: { depositId: dep.depositId }, operationId: `cc:ap2:${Date.now()}`, now: now() }),
  ]);

  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);

  const dash = await buildDashboard(db, period, "2026-09-15");
  const row = dash.custody.find((c) => c.userId === emp.userId);
  assert.equal(row.cashCollectedFils, 500000);
  assert.equal(dash.summary.holdingFils, 200000);
});

test("C: same operationId concurrently — one financial effect", async () => {
  const db = getDb(PROJECT);
  const owner = { userId: "owner-c", role: "owner", active: true };
  await createUsers(db, [owner]);

  const oid = `cc:idem:${Date.now()}`;
  const payload = { name: "ConcurrentProp" };
  const results = await Promise.allSettled([
    executeCommand({ db, actor: owner, command: "createProperty", payload, operationId: oid, now: now() }),
    executeCommand({ db, actor: owner, command: "createProperty", payload, operationId: oid, now: now() }),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  assert.equal(fulfilled.length, 2);
  const ids = fulfilled.map((r) => r.value.propertyId);
  assert.equal(ids[0], ids[1]);
  assert.ok(fulfilled.some((r) => r.value.replay === true));

  const props = await db.listAll("properties");
  assert.equal(props.filter((p) => p.name === "ConcurrentProp").length, 1);
});
