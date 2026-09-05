#!/usr/bin/env node
/**
 * Emulator seed matching the assembled Old-UI bridge NEW_UID map.
 * Demo PINs only — never for production.
 */
import { initializeApp, getApps, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createFirestoreRepository, hashPin } from "../functions/repositories/firestore.mjs";
import { executeCommand } from "../functions/commands/index.mjs";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error("REFUSED: seed_bridge_ui runs only with FIRESTORE_EMULATOR_HOST set");
  process.exit(1);
}

const PROJECT = process.env.GCLOUD_PROJECT || "qama-new-prod-2026";
while (getApps().length) await deleteApp(getApps()[0]);
initializeApp({ projectId: PROJECT });

const db = createFirestoreRepository(getFirestore());
const now = () => new Date().toISOString();
const op = (name) => `seed-bridge:${name}:${Date.now()}`;

const USERS = [
  { id: "mig:user:owner:saeed", displayName: "مدير", role: "owner", pin: "1325" },
  { id: "mig:user:yahia", displayName: "يحيى", role: "employee", pin: "6477" },
  { id: "mig:user:nader", displayName: "نادر", role: "employee", pin: "2026" },
];

async function wipeEmulator() {
  const firestore = getFirestore();
  const cols = [
    "users", "properties", "units", "spaces", "rentals", "obligations", "receipts",
    "deposits", "expenses", "accounts", "operations", "auditEvents", "reversals",
    "loginAttempts", "uiPeriods", "uiRequests", "uiConfig", "workRequests",
  ];
  for (const c of cols) {
    const snap = await firestore.collection(c).get();
    if (snap.empty) continue;
    const batch = firestore.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}

await wipeEmulator();

async function ensureUser(u) {
  const { hash, salt } = await hashPin(u.pin);
  await db.runTransaction(async (tx) => {
    tx.create("users", u.id, {
      id: u.id, userId: u.id, displayName: u.displayName, role: u.role, active: true,
      pinHash: hash, pinSalt: salt, pinUpdatedAt: now(),
      createdAt: now(), createdBy: "seed-bridge-ui", schemaVersion: 1,
    });
  });
}

for (const u of USERS) await ensureUser(u);

const ownerActor = { userId: USERS[0].id, role: "owner", active: true, displayName: USERS[0].displayName };

const prop = await executeCommand({
  db, actor: ownerActor, command: "createProperty",
  payload: { name: "قمة الرواسي", address: "دبي" },
  operationId: op("prop"), now: now(),
});
const unit = await executeCommand({
  db, actor: ownerActor, command: "createUnit",
  payload: { propertyId: prop.propertyId, name: "شقة 101", kind: "partitioned" },
  operationId: op("unit"), now: now(),
});
const space = await executeCommand({
  db, actor: ownerActor, command: "createSpace",
  payload: { unitId: unit.unitId, name: "شقة 101 / 1" },
  operationId: op("space"), now: now(),
});
await executeCommand({
  db, actor: ownerActor, command: "createAccount",
  payload: { name: "حساب الشركة", kind: "company" },
  operationId: op("acct"), now: now(),
});
const rental = await executeCommand({
  db, actor: ownerActor, command: "createRental",
  payload: {
    spaceId: space.spaceId, tenantName: "مستأجر اختبار", contractualAmountFils: 10000,
    dueDayOfMonth: 1, startDate: "2026-09-01",
  },
  operationId: op("rental"), now: now(),
});
await executeCommand({
  db, actor: ownerActor, command: "setSpaceOccupancy",
  payload: { spaceId: space.spaceId, occupancy: "rented" },
  operationId: op("occ"), now: now(),
});
// Second vacant partition — daily booking target (no monthly rental conflict required)
const spaceVacant = await executeCommand({
  db, actor: ownerActor, command: "createSpace",
  payload: { unitId: unit.unitId, name: "شقة 101 / 2" },
  operationId: op("space2"), now: now(),
});
await executeCommand({
  db, actor: ownerActor, command: "setSpaceOccupancy",
  payload: { spaceId: spaceVacant.spaceId, occupancy: "vacant" },
  operationId: op("occ2"), now: now(),
});

// Whole unit with active rental for full-unit collect/uncollect UI
const whole = await executeCommand({
  db, actor: ownerActor, command: "createUnit",
  payload: { propertyId: prop.propertyId, name: "201", kind: "whole" },
  operationId: op("whole"), now: now(),
});
const wholeSpace = await executeCommand({
  db, actor: ownerActor, command: "createSpace",
  payload: { unitId: whole.unitId, name: "201" },
  operationId: op("wholesp"), now: now(),
});
const wholeRental = await executeCommand({
  db, actor: ownerActor, command: "createRental",
  payload: {
    spaceId: wholeSpace.spaceId, tenantName: "مستأجر شقة كاملة", contractualAmountFils: 20000,
    dueDayOfMonth: 1, startDate: "2026-09-01",
  },
  operationId: op("wholerent"), now: now(),
});
await executeCommand({
  db, actor: ownerActor, command: "setSpaceOccupancy",
  payload: { spaceId: wholeSpace.spaceId, occupancy: "rented" },
  operationId: op("wholeocc"), now: now(),
});

await executeCommand({
  db, actor: ownerActor, command: "generateObligations",
  payload: { period: "2026-09" },
  operationId: op("obligations"), now: now(),
});

console.log(JSON.stringify({
  ok: true,
  ownerId: USERS[0].id,
  spaceId: space.spaceId,
  vacantSpaceId: spaceVacant.spaceId,
  rentalId: rental.rentalId,
  wholeUnitId: whole.unitId,
  wholeSpaceId: wholeSpace.spaceId,
  wholeRentalId: wholeRental.rentalId,
  period: "2026-09",
  demoPinsEmulatorOnly: Object.fromEntries(USERS.map((u) => [u.id, u.pin])),
}, null, 2));
