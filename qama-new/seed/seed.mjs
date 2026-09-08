#!/usr/bin/env node
/**
 * Emulator seed — writes real Firestore documents via Admin SDK + executeCommand.
 * Demo PINs are for emulator acceptance only.
 */
import { initializeApp, getApps, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { scryptSync, randomBytes } from "node:crypto";
import { createFirestoreRepository } from "../functions/repositories/firestore.mjs";
import { executeCommand } from "../functions/commands/index.mjs";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error("REFUSED: seed runs only with FIRESTORE_EMULATOR_HOST set");
  process.exit(1);
}

const PROJECT = process.env.GCLOUD_PROJECT || "qama-new";
while (getApps().length) await deleteApp(getApps()[0]);
initializeApp({ projectId: PROJECT });

const db = createFirestoreRepository(getFirestore());
const now = () => new Date().toISOString();
const op = (name) => `seed:${name}:${Date.now()}`;

async function wipeEmulator() {
  const { getFirestore } = await import("firebase-admin/firestore");
  const firestore = getFirestore();
  const cols = ["users","properties","units","spaces","rentals","obligations","receipts","deposits","expenses","accounts","operations","auditEvents","reversals","loginAttempts"];
  for (const c of cols) {
    const snap = await firestore.collection(c).get();
    if (!snap.empty) {
      const batch = firestore.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  }
}

await wipeEmulator();

const OWNER_ID = "seed-owner";
const ownerActor = { userId: OWNER_ID, role: "owner", active: true, displayName: "سعيد" };

async function ensureOwner() {
  const existing = await db.getUser(OWNER_ID);
  if (existing) return;
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync("1325", salt, 64).toString("hex");
  await db.runTransaction(async (tx) => {
    tx.create("users", OWNER_ID, {
      id: OWNER_ID, userId: OWNER_ID, displayName: "سعيد", role: "owner", active: true,
      pinHash: hash, pinSalt: salt, pinUpdatedAt: now(),
      createdAt: now(), createdBy: "seed", schemaVersion: 1,
    });
  });
}

await ensureOwner();

const yahia = await executeCommand({
  db, actor: ownerActor, command: "createUser",
  payload: { displayName: "يحيى", role: "employee", pin: "6477" },
  operationId: op("user-yahia"), now: now(),
});
const nader = await executeCommand({
  db, actor: ownerActor, command: "createUser",
  payload: { displayName: "نادر", role: "employee", pin: "2026" },
  operationId: op("user-nader"), now: now(),
});

const prop = await executeCommand({
  db, actor: ownerActor, command: "createProperty",
  payload: { name: "قمة الرواسي", address: "دبي" },
  operationId: op("prop"), now: now(),
});
const unit = await executeCommand({
  db, actor: ownerActor, command: "createUnit",
  payload: { propertyId: prop.propertyId, name: "شقة 101", kind: "whole" },
  operationId: op("unit"), now: now(),
});
const space = await executeCommand({
  db, actor: ownerActor, command: "createSpace",
  payload: { unitId: unit.unitId, name: "غرفة 1" },
  operationId: op("space"), now: now(),
});
const account = await executeCommand({
  db, actor: ownerActor, command: "createAccount",
  payload: { name: "حساب الشركة", kind: "company" },
  operationId: op("account"), now: now(),
});
const rental = await executeCommand({
  db, actor: ownerActor, command: "createRental",
  payload: {
    spaceId: space.spaceId, tenantName: "أحمد", contractualAmountFils: 920000,
    dueDayOfMonth: 1, startDate: "2026-08-01",
  },
  operationId: op("rental"), now: now(),
});

const period = new Date().toISOString().slice(0, 7);
await executeCommand({
  db, actor: ownerActor, command: "generateObligations",
  payload: { period },
  operationId: op("obligations"), now: now(),
});

console.log(JSON.stringify({
  ok: true,
  period,
  ownerId: OWNER_ID,
  employees: [yahia.userId, nader.userId],
  propertyId: prop.propertyId,
  rentalId: rental.rentalId,
  accountId: account.accountId,
  demoPinsEmulatorOnly: { owner: "1325", yahia: "6477", nader: "2026" },
}, null, 2));
