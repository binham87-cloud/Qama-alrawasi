#!/usr/bin/env node
/**
 * Emulator seed shaped like the 2026-09-05 production residue relationship graph.
 * IDs are rehearsal-* (not production IDs) but amounts/states/links mirror prod.
 *
 * Mirrors:
 *  - approved deposit 100 AED → deposited + revenue
 *  - recognized cash 100 on CLOSED rental / vacant space / ACTIVE obligation (BOT TEMP DEP shape)
 *  - recognized cash 150 on ACTIVE rented+collected rental (BOT R3 shape)
 * Holding = 250 - 100 = 150; Target/Collected = 150 (only live rented obligation)
 */
import { initializeApp, getApps, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createFirestoreRepository, hashPin } from "../functions/repositories/firestore.mjs";
import { executeCommand } from "../functions/commands/index.mjs";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error("REFUSED: residue rehearsal seed requires FIRESTORE_EMULATOR_HOST");
  process.exit(1);
}

const PROJECT = process.env.GCLOUD_PROJECT || "qama-new-prod-2026";
while (getApps().length) await deleteApp(getApps()[0]);
initializeApp({ projectId: PROJECT });
const firestore = getFirestore();
const db = createFirestoreRepository(firestore);
const now = () => new Date().toISOString();
const op = (n) => `reh:${n}:${Date.now()}`;

async function wipe() {
  const cols = [
    "users", "properties", "units", "spaces", "rentals", "obligations", "receipts",
    "deposits", "expenses", "accounts", "operations", "auditEvents", "reversals",
    "loginAttempts", "uiPeriods", "uiRequests", "uiConfig", "workRequests", "ledgerEntries",
  ];
  for (const c of cols) {
    const snap = await firestore.collection(c).get();
    if (snap.empty) continue;
    const batch = firestore.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}
await wipe();

const OWNER = "mig:user:owner:saeed";
const { hash, salt } = await hashPin("1325");
await db.runTransaction(async (tx) => {
  tx.create("users", OWNER, {
    id: OWNER, userId: OWNER, displayName: "مدير", role: "owner", active: true,
    pinHash: hash, pinSalt: salt, pinUpdatedAt: now(),
    createdAt: now(), createdBy: "rehearsal", schemaVersion: 1,
  });
});
const owner = { userId: OWNER, role: "owner", active: true, displayName: "مدير" };

const prop = await executeCommand({
  db, actor: owner, command: "createProperty",
  payload: { name: "قمة الرواسي", address: "دبي" }, operationId: op("prop"), now: now(),
});
const unit = await executeCommand({
  db, actor: owner, command: "createUnit",
  payload: { propertyId: prop.propertyId, name: "ميزان 3", kind: "partitioned" },
  operationId: op("unit"), now: now(),
});
const spaceTemp = await executeCommand({
  db, actor: owner, command: "createSpace",
  payload: { unitId: unit.unitId, name: "ميزان 3 / 10" }, operationId: op("sp-temp"), now: now(),
});
const spaceR3 = await executeCommand({
  db, actor: owner, command: "createSpace",
  payload: { unitId: unit.unitId, name: "ميزان 3 / 16" }, operationId: op("sp-r3"), now: now(),
});
const acct = await executeCommand({
  db, actor: owner, command: "createAccount",
  payload: { name: "الإيرادات", kind: "company" }, operationId: op("acct"), now: now(),
});

// --- BOT TEMP DEP shape: rent, collect 100, close/vacate, leave receipt recognized ---
const rentTemp = await executeCommand({
  db, actor: owner, command: "createRental",
  payload: {
    spaceId: spaceTemp.spaceId, tenantName: "REH TEMP DEP", contractualAmountFils: 10000,
    dueDayOfMonth: 5, startDate: "2026-09-05",
  }, operationId: op("rent-temp"), now: now(),
});
await executeCommand({
  db, actor: owner, command: "setSpaceOccupancy",
  payload: { spaceId: spaceTemp.spaceId, occupancy: "rented" }, operationId: op("occ-temp"), now: now(),
});
await executeCommand({
  db, actor: owner, command: "generateObligations",
  payload: { period: "2026-09" }, operationId: op("ob-temp"), now: now(),
});
const obTempId = `${rentTemp.rentalId}_2026-09`;
const rcptTemp = await executeCommand({
  db, actor: owner, command: "createCashReceipt",
  payload: { obligationId: obTempId, amountFils: 10000, collectionDate: "2026-09-05", collectorUserId: OWNER },
  operationId: op("rcpt-temp"), now: now(),
});
await executeCommand({
  db, actor: owner, command: "closeRental",
  payload: { rentalId: rentTemp.rentalId, endDate: "2026-09-05", reason: "reh vacate temp", setVacant: true },
  operationId: op("close-temp"), now: now(),
});

// --- BOT R3 shape: rent 150, collect, leave active ---
const rentR3 = await executeCommand({
  db, actor: owner, command: "createRental",
  payload: {
    spaceId: spaceR3.spaceId, tenantName: "REH R3 TENANT", contractualAmountFils: 15000,
    dueDayOfMonth: 25, startDate: "2026-09-01",
  }, operationId: op("rent-r3"), now: now(),
});
await executeCommand({
  db, actor: owner, command: "setSpaceOccupancy",
  payload: { spaceId: spaceR3.spaceId, occupancy: "rented" }, operationId: op("occ-r3"), now: now(),
});
await executeCommand({
  db, actor: owner, command: "generateObligations",
  payload: { period: "2026-09" }, operationId: op("ob-r3"), now: now(),
});
const obR3Id = `${rentR3.rentalId}_2026-09`;
const rcptR3 = await executeCommand({
  db, actor: owner, command: "createCashReceipt",
  payload: { obligationId: obR3Id, amountFils: 15000, collectionDate: "2026-09-25", collectorUserId: OWNER },
  operationId: op("rcpt-r3"), now: now(),
});

// --- BOT DEP OK shape: deposit 100 (owner submit auto-approves) ---
const dep = await executeCommand({
  db, actor: owner, command: "submitDeposit",
  payload: {
    amountFils: 10000, depositDate: "2026-09-05", destinationAccountId: acct.accountId,
    reference: "REH DEP OK",
  }, operationId: op("dep-sub"), now: now(),
});

// Snapshot states for correction preconditions
const snap = {
  depositId: dep.depositId,
  receiptTempId: rcptTemp.receiptId,
  receiptR3Id: rcptR3.receiptId,
  rentalTempId: rentTemp.rentalId,
  rentalR3Id: rentR3.rentalId,
  obligationTempId: obTempId,
  obligationR3Id: obR3Id,
  spaceTempId: spaceTemp.spaceId,
  spaceR3Id: spaceR3.spaceId,
  accountId: acct.accountId,
};
const docs = {};
for (const [k, id] of Object.entries({
  deposit: snap.depositId, receiptTemp: snap.receiptTempId, receiptR3: snap.receiptR3Id,
  rentalTemp: snap.rentalTempId, rentalR3: snap.rentalR3Id,
  obligationTemp: snap.obligationTempId, obligationR3: snap.obligationR3Id,
  spaceTemp: snap.spaceTempId, spaceR3: snap.spaceR3Id,
})) {
  const col = k.startsWith("receipt") ? "receipts"
    : k.startsWith("rental") ? "rentals"
    : k.startsWith("obligation") ? "obligations"
    : k.startsWith("space") ? "spaces"
    : "deposits";
  const d = (await firestore.doc(`${col}/${id}`).get()).data();
  docs[k] = { id, state: d?.state, amountFils: d?.amountFils, occupancy: d?.occupancy, tenantName: d?.tenantName, endDate: d?.endDate };
}

console.log(JSON.stringify({ ok: true, snap, docs }, null, 2));
