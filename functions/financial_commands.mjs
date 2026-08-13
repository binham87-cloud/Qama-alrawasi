import crypto from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { SCHEMA_VERSION } from "./domain/financial_engine.mjs";
import { executeRepositoryCommand } from "./domain/entity_repositories.mjs";

const COMMANDS = new Set([
  "createCashReceipt", "createBankPayment", "approveBankPayment",
  "cancelPayment", "correctPayment",
  "createDepositRequest", "editDepositRequest", "rejectDeposit", "withdrawDeposit", "approveDeposit",
  "createCustodyTransfer", "confirmCustodyTransfer", "rejectCustodyTransfer", "reverseCustodyTransfer",
  "requestDiscount", "approveDiscountRequest", "approveDiscount", "refundPayment",
  "createDailyBooking", "refundDailyBooking",
  "reverseDiscount", "requestEviction", "approveEvictionRequest", "approveEviction",
  "transferBalance", "reverseBalanceTransfer", "createInstallmentReserveTransfer", "reverseInstallmentReserveTransfer",
  "requestExpense", "approveExpense", "executeExpense", "reverseExpense",
  "recordExternalRevenue", "reverseExternalRevenue",
  "createOwnerProfitDistribution", "reverseOwnerProfitDistribution",
  "adjustInstallmentObligation", "createLegacyFinancialCorrection",
  "adjustBalance", "reverseAdjustment", "payInstallment", "reverseInstallment",
  "createBankInstallmentPayment", "reverseBankInstallmentPayment",
  "closeMonth", "forceCloseMonth", "reopenMonth",
  "setSpaceRental", "ensureCompatibleCycle", "correctCycleDueDate", "cancelDeposit",
]);

const OP_ID = /^[A-Za-z0-9:_-]{8,160}$/;
const payloadHash = (command, payload) => crypto.createHash("sha256").update(JSON.stringify({ command, payload })).digest("hex");

function publicError(error) {
  const code = String(error?.message || "COMMAND_FAILED");
  if (/REQUIRED|DENIED|STAFF_REQUIRED|MANAGER_REQUIRED|GATE_CLOSED|REVIEW_WRITE/.test(code)) return new HttpsError("permission-denied", code);
  if (/NOT_FOUND|MISSING/.test(code)) return new HttpsError("not-found", code);
  if (/STALE|OVERPAYMENT|INSUFFICIENT|CLOSED|PENDING|MISMATCH|IN_PROGRESS|SETTLEMENT_OVER_REVERSAL|DEPOSIT_ALREADY/.test(code)) return new HttpsError("failed-precondition", code);
  return new HttpsError("invalid-argument", code);
}

export function buildFinancialCommand(db) {
  return onCall({ enforceAppCheck: false }, async (request) => {
    if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
    const command = String(request.data?.command || "");
    const operationId = String(request.data?.operationId || "");
    const payload = request.data?.payload || {};
    if (!COMMANDS.has(command)) throw new HttpsError("invalid-argument", "UNKNOWN_COMMAND");
    if (!OP_ID.test(operationId)) throw new HttpsError("invalid-argument", "OPERATION_ID_INVALID");
    const pHash = payloadHash(command, payload);
    try {
      return await db.runTransaction(async (tx) => {
        const userRef = db.collection("users").doc(request.auth.uid);
        const opRef = db.collection("financialOperations").doc(operationId);
        const [userSnap, opSnap] = await Promise.all([tx.get(userRef), tx.get(opRef)]);
        if (!userSnap.exists) throw new Error("PROFILE_MISSING");
        const profile = userSnap.data() || {};
        if (profile.active === false) throw new Error("PROFILE_DISABLED");
        if (profile.role === "finance") throw new Error("FINANCE_ROLE_UNMAPPED");
        const actor = { id: String(profile.userKey || request.auth.uid), uid: request.auth.uid, role: String(profile.role || "employee"), active: true };

        if (opSnap.exists) {
          const existing = opSnap.data() || {};
          if (existing.payloadHash !== pHash) throw new Error("IDEMPOTENCY_PAYLOAD_MISMATCH");
          if (existing.status === "completed") return { ...existing.result, replay: true };
          throw new Error("OPERATION_IN_PROGRESS");
        }

        const result = await executeRepositoryCommand({ db, tx, command, operationId, payloadHash: pHash, payload, actor, now: new Date().toISOString() });

        tx.create(opRef, { operationId, command, payloadHash: pHash, actorUid: request.auth.uid, actorId: actor.id, status: "completed", result, createdAt: FieldValue.serverTimestamp(), completedAt: FieldValue.serverTimestamp(), schemaVersion: SCHEMA_VERSION });
        return { ...result, replay: false };
      });
    } catch (error) {
      console.error("financialCommand", { command, operationId, code: String(error?.message || "COMMAND_FAILED") });
      throw publicError(error);
    }
  });
}
