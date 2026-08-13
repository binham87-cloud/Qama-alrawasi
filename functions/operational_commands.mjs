import crypto from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import {
  applyApprovedBusinessRequest,
  applyOperationalPatch,
  applyOwnerRentalPatch,
  assertBusinessRequestType,
} from "./domain/operational_commands.mjs";

const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const OP_ID = /^[A-Za-z0-9:_-]{8,160}$/;
const REQUEST_ID = /^[A-Za-z0-9:_-]{3,160}$/;
const MANAGER_ROLES = new Set(["owner", "manager"]);

function publicError(error) {
  const code = String(error?.message || "OPERATIONAL_COMMAND_FAILED");
  if (/REQUIRED|DENIED|COLLECTION_REQUIRES/.test(code)) return new HttpsError("permission-denied", code);
  if (/STALE|NOT_PENDING|ALREADY_PROCESSED|MISMATCH|TARGET_OCCUPIED|EXISTS/.test(code)) return new HttpsError("failed-precondition", code);
  if (/NOT_FOUND/.test(code)) return new HttpsError("not-found", code);
  return new HttpsError("invalid-argument", code);
}

async function replayOrCreate(tx, opRef, payloadHash) {
  const opSnap = await tx.get(opRef);
  if (!opSnap.exists) return null;
  const existing = opSnap.data() || {};
  if (existing.payloadHash !== payloadHash) throw new Error("IDEMPOTENCY_PAYLOAD_MISMATCH");
  return { ...existing.result, replay: true };
}

function writeOpAudit(tx, db, { opRef, operationId, payloadHash, actor, publicResult, audit }) {
  tx.create(opRef, {
    operationId, payloadHash, actorUid: actor.uid, actorId: actor.id,
    status: "completed", result: publicResult, createdAt: FieldValue.serverTimestamp(),
  });
  tx.create(db.collection("auditEvents").doc(`operational:${operationId}`), {
    operationId, actorUid: actor.uid, actorId: actor.id,
    financialEffectFils: 0, createdAt: FieldValue.serverTimestamp(), ...audit,
  });
}

async function executeRejectRequest(db, tx, { operationId, payload, payloadHash, actor, opRef }) {
  if (!MANAGER_ROLES.has(actor.role)) throw new Error("MANAGER_REQUIRED");
  const requestId = String(payload.requestId || "");
  if (!REQUEST_ID.test(requestId)) throw new Error("REQUEST_ID_INVALID");
  const replay = await replayOrCreate(tx, opRef, payloadHash);
  if (replay) return replay;
  const reqRef = db.collection("requests").doc(requestId);
  const reqSnap = await tx.get(reqRef);
  if (!reqSnap.exists) throw new Error("REQUEST_NOT_FOUND");
  const current = reqSnap.data() || {};
  if (current.status !== "pending") throw new Error("REQUEST_NOT_PENDING");
  const now = new Date().toISOString();
  tx.set(reqRef, {
    status: "rejected", rejectedAt: now, rejectedBy: actor.id, rejectedByUid: actor.uid,
  }, { merge: true });
  const publicResult = { command: "rejectRequest", requestId, status: "rejected", financialEffectFils: 0 };
  writeOpAudit(tx, db, {
    opRef, operationId, payloadHash, actor, publicResult,
    audit: { action: "request_rejected", requestId, requestType: current.type || null, beforeStatus: "pending", afterStatus: "rejected" },
  });
  return { ...publicResult, replay: false };
}

async function executeSubmitBusinessRequest(db, tx, { operationId, payload, payloadHash, actor, opRef }) {
  const replay = await replayOrCreate(tx, opRef, payloadHash);
  if (replay) return replay;
  const type = assertBusinessRequestType(payload.type);
  const requestId = String(payload.requestId || `req_${operationId}`);
  if (!REQUEST_ID.test(requestId)) throw new Error("REQUEST_ID_INVALID");
  const reqRef = db.collection("requests").doc(requestId);
  const existing = await tx.get(reqRef);
  if (existing.exists) throw new Error("REQUEST_EXISTS");
  const now = new Date().toISOString();
  const doc = {
    id: requestId,
    type,
    desc: String(payload.desc || "").slice(0, 500),
    payload: payload.requestPayload || {},
    by: actor.id,
    byName: String(payload.byName || actor.id),
    byUid: actor.uid,
    month: Number(payload.month),
    year: Number(payload.year),
    monthId: String(payload.monthId || ""),
    status: "pending",
    createdAt: now,
    financialEffectFils: 0,
  };
  tx.create(reqRef, doc);
  const publicResult = { command: "submitBusinessRequest", requestId, type, status: "pending", financialEffectFils: 0 };
  writeOpAudit(tx, db, {
    opRef, operationId, payloadHash, actor, publicResult,
    audit: { action: "business_request_submitted", requestId, requestType: type },
  });
  return { ...publicResult, replay: false };
}

async function executeApproveBusinessRequest(db, tx, { operationId, payload, payloadHash, actor, opRef }) {
  if (!MANAGER_ROLES.has(actor.role)) throw new Error("MANAGER_REQUIRED");
  const replay = await replayOrCreate(tx, opRef, payloadHash);
  if (replay) return replay;
  const requestId = String(payload.requestId || "");
  if (!REQUEST_ID.test(requestId)) throw new Error("REQUEST_ID_INVALID");
  const reqRef = db.collection("requests").doc(requestId);
  const reqSnap = await tx.get(reqRef);
  if (!reqSnap.exists) throw new Error("REQUEST_NOT_FOUND");
  const current = reqSnap.data() || {};
  if (current.status !== "pending") throw new Error("REQUEST_NOT_PENDING");
  assertBusinessRequestType(current.type);
  const monthId = String(payload.monthId || current.monthId || `${current.year}_${current.month}`);
  const monthRef = db.collection("months").doc(monthId);
  const monthSnap = await tx.get(monthRef);
  if (!monthSnap.exists) throw new Error("MONTH_NOT_FOUND");
  const applied = applyApprovedBusinessRequest(monthSnap.data(), current, actor);
  const now = new Date().toISOString();
  tx.set(monthRef, {
    data: applied.data,
    _rev: (Number(monthSnap.data()?._rev) || 0) + 1,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: actor.id,
  }, { merge: true });
  tx.set(reqRef, {
    status: "approved", approvedAt: now, approvedBy: actor.id, approvedByUid: actor.uid,
  }, { merge: true });
  const publicResult = {
    command: "approveBusinessRequest", requestId, type: current.type, status: "approved",
    monthId, target: applied.target, financialEffectFils: 0,
  };
  writeOpAudit(tx, db, {
    opRef, operationId, payloadHash, actor, publicResult,
    audit: { action: "business_request_approved", requestId, requestType: current.type, monthId, target: applied.target },
  });
  return { ...publicResult, replay: false };
}

export function buildOperationalCommand(db) {
  return onCall({ enforceAppCheck: false }, async (request) => {
    if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
    const operationId = String(request.data?.operationId || "");
    const payload = request.data?.payload || {};
    if (!OP_ID.test(operationId)) throw new HttpsError("invalid-argument", "OPERATION_ID_INVALID");
    const payloadHash = hash(payload);
    try {
      return await db.runTransaction(async (tx) => {
        const userRef = db.collection("users").doc(request.auth.uid);
        const opRef = db.collection("operationalOperations").doc(operationId);
        const userSnap = await tx.get(userRef);
        if (!userSnap.exists) throw new Error("PROFILE_MISSING");
        const profile = userSnap.data() || {};
        if (profile.active === false) throw new Error("PROFILE_DISABLED");
        if (profile.role === "finance") throw new Error("FINANCE_ROLE_UNMAPPED");
        const actor = { uid: request.auth.uid, id: String(profile.userKey || request.auth.uid), role: String(profile.role || "employee") };
        const command = String(payload.command || "");

        if (command === "rejectRequest") {
          return executeRejectRequest(db, tx, { operationId, payload, payloadHash, actor, opRef });
        }
        if (command === "submitBusinessRequest") {
          return executeSubmitBusinessRequest(db, tx, { operationId, payload, payloadHash, actor, opRef });
        }
        if (command === "approveBusinessRequest") {
          return executeApproveBusinessRequest(db, tx, { operationId, payload, payloadHash, actor, opRef });
        }

        const monthRef = db.collection("months").doc(String(payload.monthId || ""));
        const [opSnap, monthSnap] = await Promise.all([tx.get(opRef), tx.get(monthRef)]);
        if (opSnap.exists) {
          const existing = opSnap.data() || {};
          if (existing.payloadHash !== payloadHash) throw new Error("IDEMPOTENCY_PAYLOAD_MISMATCH");
          return { ...existing.result, replay: true };
        }
        if (!monthSnap.exists) throw new Error("MONTH_NOT_FOUND");

        if (command === "applyOwnerRentalPatch") {
          const result = applyOwnerRentalPatch(monthSnap.data(), payload, actor);
          const publicResult = { command, monthId: payload.monthId, target: result.target, version: result.version, financialEffectFils: 0 };
          tx.set(monthRef, { data: result.data, _rev: (Number(monthSnap.data()?._rev) || 0) + 1, updatedAt: FieldValue.serverTimestamp(), updatedBy: actor.id }, { merge: true });
          writeOpAudit(tx, db, {
            opRef, operationId, payloadHash, actor, publicResult,
            audit: { action: "owner_rental_patch", monthId: payload.monthId, target: result.target, before: result.before, after: result.after },
          });
          return { ...publicResult, replay: false };
        }

        if (command === "applyOwnerBusinessMutation") {
          if (!MANAGER_ROLES.has(actor.role)) throw new Error("MANAGER_REQUIRED");
          const type = assertBusinessRequestType(payload.type);
          const applied = applyApprovedBusinessRequest(monthSnap.data(), { type, payload: payload.requestPayload || {} }, actor);
          const publicResult = { command, monthId: payload.monthId, type, target: applied.target, financialEffectFils: 0 };
          tx.set(monthRef, { data: applied.data, _rev: (Number(monthSnap.data()?._rev) || 0) + 1, updatedAt: FieldValue.serverTimestamp(), updatedBy: actor.id }, { merge: true });
          writeOpAudit(tx, db, {
            opRef, operationId, payloadHash, actor, publicResult,
            audit: { action: "owner_business_mutation", monthId: payload.monthId, type, target: applied.target },
          });
          return { ...publicResult, replay: false };
        }

        // Default: note/phone operational patch
        const result = applyOperationalPatch(monthSnap.data(), payload, actor);
        const publicResult = { monthId: payload.monthId, target: result.target, version: result.version };
        tx.set(monthRef, { data: result.data, _rev: (Number(monthSnap.data()?._rev) || 0) + 1, updatedAt: FieldValue.serverTimestamp(), updatedBy: actor.id }, { merge: true });
        writeOpAudit(tx, db, {
          opRef, operationId, payloadHash, actor, publicResult,
          audit: { action: "operational_update", monthId: payload.monthId, target: result.target, before: result.before, after: result.after },
        });
        return { ...publicResult, replay: false };
      });
    } catch (error) {
      throw publicError(error);
    }
  });
}
