import { createMemoryRepository, resetRepository } from "../helpers/repository.mjs";
import { executeCommand } from "../../functions/commands/index.mjs";
import { verifyPinConstantTime } from "../../functions/auth/index.mjs";

let opSeq = 0;

export function freshDb() {
  resetRepository();
  return createMemoryRepository();
}

export function opId(label = "op") {
  opSeq++;
  return `${label}:${Date.now()}:${opSeq}`;
}

export async function run(db, actor, command, payload, operationId = opId(command)) {
  const now = new Date().toISOString();
  return executeCommand({ db, actor, command, payload, operationId, now });
}

export async function createUser(db, owner, { displayName, role, pin }) {
  const r = await run(db, owner, "createUser", { displayName, role, pin });
  const userId = r.userId;
  const doc = await db.getUser(userId);
  return { userId, role, active: true, displayName, pinHash: doc.pinHash, pinSalt: doc.pinSalt };
}

export async function bootstrapOwner(db) {
  const owner = { userId: "owner-bootstrap", role: "owner", active: true, displayName: "سعيد" };
  db.seed("users", owner.userId, {
    id: owner.userId,
    userId: owner.userId,
    displayName: owner.displayName,
    role: "owner",
    active: true,
    pinHash: "00",
    pinSalt: "00",
    createdAt: new Date().toISOString(),
    createdBy: "bootstrap",
    schemaVersion: 1,
  });
  return owner;
}

export async function seedBuilding(db, owner) {
  const prop = await run(db, owner, "createProperty", { name: "قمة الرواسي", address: "دبي" });
  const unit = await run(db, owner, "createUnit", { propertyId: prop.propertyId, name: "شقة 101", kind: "whole" });
  const space = await run(db, owner, "createSpace", { unitId: unit.unitId, name: "غرفة 1" });
  const rental = await run(db, owner, "createRental", {
    spaceId: space.spaceId,
    tenantName: "أحمد",
    contractualAmountFils: 920000,
    dueDayOfMonth: 1,
    startDate: "2026-09-01",
  });
  const period = "2026-09";
  const obs = await run(db, owner, "generateObligations", { period });
  const obligationId = obs.obligationIds[0];
  if (!obligationId) throw new Error("SEED_NO_OBLIGATION");
  const account = await run(db, owner, "createAccount", { name: "حساب الشركة", kind: "company" });
  return { prop, unit, space, rental, obligationId, period, account };
}

export function actorFrom(user) {
  return { userId: user.userId, role: user.role, active: true, displayName: user.displayName };
}

export function assertPinWorks(pin, user) {
  if (!verifyPinConstantTime(pin, user)) throw new Error("PIN_SETUP_FAILED");
}
