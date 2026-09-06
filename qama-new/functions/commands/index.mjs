/**
 * QAMA — command layer.
 *
 * Every mutation in the system passes through executeCommand. There is no other write path:
 * Firestore Rules deny all client writes, so the only way money can change is a command that
 * has passed identity, role, schema, idempotency and transaction checks here.
 *
 * The database handle is injected, so this exact code runs under the Firebase Admin SDK in
 * production and under the test harness in tests. The layer under test is the layer shipped.
 */

import {
  DomainError, RECEIPT_STATE, APPROVAL_STATE, OCCUPANCY, METHOD,
  assertReceiptFits, assertDepositFitsCustody, assertCashReversalFitsSharedHolding,
  periodOf, dueDateFor, obligationIdFor,
  assertPositiveFils, isFils, isPlaceholderTenant,
} from "../domain/finance.mjs";
import { commitWorkRequestFlow } from "./commit_work_request.mjs";

/** Cancel unpaid active obligations for a rental (no live receipts). History with money is kept. */
async function cancelUnpaidObligationsForRental(ctx, rentalId, reason, { ignoreReceiptIds = [] } = {}) {
  const skip = new Set(ignoreReceiptIds || []);
  const obligations = await ctx.tx.query("obligations", [["rentalId", "==", rentalId]]);
  const cancelled = [];
  for (const ob of obligations) {
    if (ob.state !== "active") continue;
    const receipts = await ctx.tx.query("receipts", [["obligationId", "==", ob.id]]);
    const live = receipts.filter(
      (r) =>
        !skip.has(r.id) &&
        (r.state === RECEIPT_STATE.RECOGNIZED || r.state === RECEIPT_STATE.PENDING),
    );
    if (live.length) continue;
    ctx.tx.update("obligations", ob.id, {
      state: "cancelled",
      cancelledBy: ctx.actor.userId,
      cancelledAt: ctx.now,
      cancelReason: reason,
    });
    cancelled.push(ob.id);
  }
  return cancelled;
}

/**
 * Reverse every recognized receipt on a rental (idempotent per operationId+receiptId).
 * Required before vacate/close: otherwise cash stays in Shared Holding while the space
 * looks empty and monthly target drops — the production vacate/holding contradiction.
 */
async function reverseLiveReceiptsForRental(ctx, rentalId, reason) {
  const obligations = await ctx.tx.query("obligations", [["rentalId", "==", rentalId]]);
  const toReverse = [];
  for (const ob of obligations) {
    const receipts = await ctx.tx.query("receipts", [["obligationId", "==", ob.id]]);
    for (const r of receipts) {
      if (r.state === RECEIPT_STATE.RECOGNIZED) toReverse.push(r);
    }
  }
  if (!toReverse.length) return { reversedReceiptIds: [], reversalIds: [] };

  const cashLive = toReverse.filter((r) => r.method === "cash");
  if (cashLive.length) {
    const allReceipts = await ctx.tx.query("receipts", []);
    const allDeposits = await ctx.tx.query("deposits", []);
    assertCashReversalFitsSharedHolding({
      receipts: allReceipts,
      deposits: allDeposits,
      reversingReceiptIds: cashLive.map((r) => r.id),
    });
  }

  const reversedReceiptIds = [];
  const reversalIds = [];
  for (const receipt of toReverse) {
    const reversalId = `rev:${ctx.operationId}:${receipt.id}`.slice(0, 140);
    if (await ctx.tx.get("reversals", reversalId)) {
      // Same operation replay — treat as already applied.
      if (receipt.state !== RECEIPT_STATE.REVERSED) {
        ctx.tx.update("receipts", receipt.id, {
          state: RECEIPT_STATE.REVERSED, reversedByReversalId: reversalId, reversedAt: ctx.now,
        });
      }
      reversedReceiptIds.push(receipt.id);
      reversalIds.push(reversalId);
      continue;
    }
    if (receipt.state === RECEIPT_STATE.REVERSED) continue;

    ctx.tx.create("reversals", reversalId, {
      id: reversalId, targetType: "receipt", targetId: receipt.id,
      amountFils: receipt.amountFils, reason, ...base(ctx),
    });
    ctx.tx.update("receipts", receipt.id, {
      state: RECEIPT_STATE.REVERSED, reversedByReversalId: reversalId, reversedAt: ctx.now,
    });
    if (receipt.method === "bank") {
      await debitRevenueAccount(ctx, {
        amountFils: receipt.amountFils,
        sourceType: "bank_receipt",
        sourceId: receipt.id,
        note: reason,
      });
    }
    audit(ctx, "receipt_reversed", "receipt", receipt.id, {
      amountFils: receipt.amountFils, reason, reversalId, via: "close_rental",
    });
    reversedReceiptIds.push(receipt.id);
    reversalIds.push(reversalId);
  }
  return { reversedReceiptIds, reversalIds };
}

/** Close an active rental, reverse live money, vacate optionally, cancel unpaid obligations. */
async function closeRentalInTx(ctx, rental, { endDate, reason, setVacant }) {
  const closeReason = reason || "rental closed";
  const reversed = await reverseLiveReceiptsForRental(ctx, rental.id, closeReason);
  ctx.tx.update("rentals", rental.id, {
    state: "closed",
    endDate,
    closedBy: ctx.actor.userId,
    closedAt: ctx.now,
    closeReason,
  });
  if (setVacant) ctx.tx.update("spaces", rental.spaceId, { occupancy: "vacant" });
  // In-tx queries may still see pre-update receipt state — ignore ids we just reversed.
  const cancelledObligationIds = await cancelUnpaidObligationsForRental(
    ctx, rental.id, closeReason, { ignoreReceiptIds: reversed.reversedReceiptIds },
  );
  audit(ctx, "rental_closed", "rental", rental.id, {
    reason: closeReason,
    cancelledObligationIds,
    reversedReceiptIds: reversed.reversedReceiptIds,
    reversalIds: reversed.reversalIds,
  });
  return {
    rentalId: rental.id,
    cancelledObligationIds,
    reversedReceiptIds: reversed.reversedReceiptIds,
    reversalIds: reversed.reversalIds,
  };
}

const REVENUE_ACCOUNT_ID = "mig:acc:revenue";

async function resolveRevenueAccountId(ctx, preferredId) {
  // حساب الإيرادات is authoritative when present.
  const named = await ctx.tx.get("accounts", REVENUE_ACCOUNT_ID);
  if (named && named.active !== false) return REVENUE_ACCOUNT_ID;
  if (preferredId) {
    const preferred = await ctx.tx.get("accounts", preferredId);
    if (preferred && preferred.active !== false && (
      preferred.kind === "bank" || /إيراد|revenue/i.test(String(preferred.name || ""))
    )) return preferredId;
  }
  const all = await ctx.tx.query("accounts", []);
  const hit = (all || []).find((a) => a.active !== false && (
    a.kind === "bank" || /إيراد|revenue/i.test(String(a.name || ""))
  )) || (all || []).find((a) => a.active !== false);
  if (hit) return hit.id;
  throw new DomainError("ACCOUNT_NOT_FOUND", { accountId: preferredId || REVENUE_ACCOUNT_ID });
}

/** Idempotent revenue credit — one ledger entry per source.
 *  Ledger tracks NEW approved rent effects. Finance UI حساب الإيرادات is a SEPARATE
 *  cumulative/manual balance in uiConfig/balances (prior months + owner edits).
 *  Credits ADD to that UI balance; they never replace it with month-only revenue.
 */
async function creditRevenueAccount(ctx, { amountFils, sourceType, sourceId, note, accountId: preferredId }) {
  assertPositiveFils(amountFils);
  const entryId = (`ledger:${sourceType}:${sourceId}:credit`).slice(0, 140);
  if (await ctx.tx.get("ledgerEntries", entryId)) {
    return { entryId, alreadyApplied: true };
  }
  const accountId = await resolveRevenueAccountId(ctx, preferredId);
  const acc = await ctx.tx.get("accounts", accountId);
  if (!acc || acc.active === false) throw new DomainError("ACCOUNT_NOT_FOUND", { accountId });
  // Engine account balanceFils = post-migration ledger net only — NOT the Finance UI balance.
  const prev = Number(acc.balanceFils || 0);
  ctx.tx.update("accounts", accountId, { balanceFils: prev + amountFils });
  ctx.tx.create("ledgerEntries", entryId, {
    id: entryId,
    accountId,
    direction: "credit",
    amountFils,
    sourceType,
    sourceId,
    note: note || null,
    at: ctx.now,
    ...base(ctx),
  });
  await adjustUiRevenueBalance(ctx, amountFils / 100, {
    reason: note || "اعتماد تحصيل",
    sourceType,
    sourceId,
  });
  return { entryId, alreadyApplied: false, accountId };
}

/**
 * Idempotent revenue debit.
 * - requirePriorCredit=true (default): used for reversing a prior credit (deposit/bank).
 * - requirePriorCredit=false: used for expense/maintenance paid from حساب الإيرادات.
 */
async function debitRevenueAccount(ctx, {
  amountFils, sourceType, sourceId, note, accountId: preferredId, requirePriorCredit = true,
}) {
  assertPositiveFils(amountFils);
  const creditId = (`ledger:${sourceType}:${sourceId}:credit`).slice(0, 140);
  const debitId = (`ledger:${sourceType}:${sourceId}:debit`).slice(0, 140);
  if (await ctx.tx.get("ledgerEntries", debitId)) {
    return { entryId: debitId, alreadyApplied: true };
  }
  let accountId;
  if (requirePriorCredit) {
    const credit = await ctx.tx.get("ledgerEntries", creditId);
    if (!credit) {
      return { entryId: null, alreadyApplied: false, skipped: true };
    }
    accountId = credit.accountId || await resolveRevenueAccountId(ctx, preferredId);
  } else {
    accountId = await resolveRevenueAccountId(ctx, preferredId);
  }
  const acc = await ctx.tx.get("accounts", accountId);
  if (!acc || acc.active === false) throw new DomainError("ACCOUNT_NOT_FOUND", { accountId });
  const prev = Number(acc.balanceFils || 0);
  ctx.tx.update("accounts", accountId, { balanceFils: prev - amountFils });
  ctx.tx.create("ledgerEntries", debitId, {
    id: debitId,
    accountId,
    direction: "debit",
    amountFils,
    sourceType,
    sourceId,
    note: note || null,
    at: ctx.now,
    ...base(ctx),
  });
  await adjustUiRevenueBalance(ctx, -(amountFils / 100), {
    reason: note || "خصم من الإيرادات",
    sourceType,
    sourceId,
  });
  return { entryId: debitId, alreadyApplied: false, accountId };
}

/**
 * Adjust cumulative Finance UI حساب الإيرادات (uiConfig/balances.revenueBalance).
 * This is NOT month Target/Collected. Prior-month opening must be preserved;
 * only deltas (approved collections / reversals / owner edits) change it.
 */
async function adjustUiRevenueBalance(ctx, deltaAed, meta = {}) {
  const delta = Math.round(Number(deltaAed) * 100) / 100;
  if (!delta) return { before: null, after: null };
  let doc = await ctx.tx.get("uiConfig", "balances");
  let obj = {};
  if (doc) {
    try { obj = JSON.parse(doc.json || "{}"); } catch { obj = {}; }
  }
  const before = Math.round((Number(obj.revenueBalance) || 0) * 100) / 100;
  const after = Math.round((before + delta) * 100) / 100;
  obj.revenueBalance = after;
  const rec = {
    json: JSON.stringify(obj),
    updatedAt: ctx.now,
    updatedBy: ctx.actor.userId,
    schemaVersion: 1,
  };
  if (doc) ctx.tx.update("uiConfig", "balances", rec);
  else ctx.tx.create("uiConfig", "balances", { id: "balances", ...rec, ...base(ctx) });
  audit(ctx, "revenue_balance_adjusted", "uiConfig", "balances", {
    beforeAed: before,
    afterAed: after,
    deltaAed: delta,
    reason: meta.reason || null,
    sourceType: meta.sourceType || null,
    sourceId: meta.sourceId || null,
  });
  return { before, after };
}

/* ═════════════════════ permission matrix ═════════════════════ */
/* Single source of truth for who may do what. Referenced by tests and by SECURITY.md. */

const OWNER = ["owner"];
const BOTH = ["owner", "employee"];

export const PERMISSIONS = Object.freeze({
  createProperty: OWNER, updateProperty: OWNER,
  createUnit: OWNER, updateUnit: OWNER,
  // Operational structure matches the old QAMA screens: employees who can edit a month
  // could already add partitions / change occupancy by writing the month document.
  createSpace: BOTH, updateSpace: BOTH, setSpaceOccupancy: BOTH,
  createRental: BOTH, updateRentalRent: BOTH, updateRentalTenant: BOTH, updateRentalSchedule: OWNER, closeRental: BOTH,
  generateObligations: OWNER, cancelObligation: OWNER,
  createCashReceipt: BOTH,
  submitBankReceipt: BOTH, approveBankReceipt: OWNER, rejectBankReceipt: OWNER,
  reverseReceipt: OWNER,
  submitDeposit: BOTH, approveDeposit: OWNER, rejectDeposit: OWNER, reverseDeposit: OWNER,
  submitExpense: BOTH, approveExpense: OWNER, rejectExpense: OWNER, reverseExpense: OWNER,
  createAccount: OWNER, updateAccount: OWNER,
  createUser: OWNER, updateUser: OWNER, setUserPin: OWNER, deactivateUser: OWNER,
  // Old-UI persistence: locks, permissions, requests, daily/maintenance extras.
  // Not financial truth — money still only moves through receipt/deposit/expense commands.
  upsertUiConfig: OWNER,
  payInstallment: OWNER,
  submitWorkRequest: BOTH,
  resolveWorkRequest: OWNER,
  commitWorkRequest: OWNER,
  uncollectObligation: OWNER,
  savePeriodExtras: BOTH,
});

/* ═════════════════════ strict payload schemas ═════════════════════ */
/*
 * Unknown fields are REJECTED, not stripped. This is the mechanism that stops
 * `status: "collected"` and `unitId` on a deposit: the request never reaches the domain.
 */

const S = {
  str: (max = 200) => ({ kind: "str", max }),
  id: () => ({ kind: "id" }),
  fils: () => ({ kind: "fils" }),
  date: () => ({ kind: "date" }),
  period: () => ({ kind: "period" }),
  int: (min, max) => ({ kind: "int", min, max }),
  enum: (values) => ({ kind: "enum", values }),
  bool: () => ({ kind: "bool" }),
  opt: (inner) => ({ ...inner, optional: true }),
};

export const SCHEMAS = Object.freeze({
  createProperty: { name: S.str(120), address: S.opt(S.str(300)) },
  updateProperty: { propertyId: S.id(), name: S.opt(S.str(120)), address: S.opt(S.str(300)), active: S.opt(S.bool()) },
  createUnit: { propertyId: S.id(), name: S.str(120), kind: S.enum(["whole", "partitioned"]) },
  updateUnit: { unitId: S.id(), name: S.opt(S.str(120)), active: S.opt(S.bool()) },
  createSpace: { unitId: S.id(), name: S.str(120) },
  updateSpace: { spaceId: S.id(), name: S.opt(S.str(120)), active: S.opt(S.bool()) },
  setSpaceOccupancy: { spaceId: S.id(), occupancy: S.enum(OCCUPANCY) },

  createRental: {
    spaceId: S.id(), tenantName: S.str(160), tenantPhone: S.opt(S.str(40)),
    contractualAmountFils: S.fils(), dueDayOfMonth: S.int(1, 31),
    startDate: S.date(), securityDepositFils: S.opt(S.fils()),
  },
  updateRentalRent: { rentalId: S.id(), contractualAmountFils: S.fils() },
  updateRentalTenant: { rentalId: S.id(), tenantName: S.opt(S.str(160)), tenantPhone: S.opt(S.str(40)) },
  updateRentalSchedule: {
    rentalId: S.id(),
    startDate: S.opt(S.date()),
    dueDayOfMonth: S.opt(S.int(1, 31)),
  },
  closeRental: { rentalId: S.id(), endDate: S.date(), reason: S.str(300), setVacant: S.opt(S.bool()) },

  generateObligations: { period: S.period() },
  cancelObligation: { obligationId: S.id(), reason: S.str(300) },

  createCashReceipt: {
    obligationId: S.id(), amountFils: S.fils(), collectionDate: S.date(), note: S.opt(S.str(300)),
    collectorUserId: S.opt(S.id()),
  },
  submitBankReceipt: {
    obligationId: S.id(), amountFils: S.fils(), collectionDate: S.date(), bankReference: S.str(120),
    collectorUserId: S.opt(S.id()),
  },
  approveBankReceipt: { receiptId: S.id() },
  rejectBankReceipt: { receiptId: S.id(), reason: S.str(300) },
  reverseReceipt: { receiptId: S.id(), reason: S.str(300) },

  submitDeposit: {
    amountFils: S.fils(), depositDate: S.date(), destinationAccountId: S.id(),
    note: S.opt(S.str(300)), reference: S.opt(S.str(120)), employeeId: S.opt(S.id()),
  },
  approveDeposit: { depositId: S.id() },
  rejectDeposit: { depositId: S.id(), reason: S.str(300) },
  reverseDeposit: { depositId: S.id(), reason: S.str(300) },

  submitExpense: {
    amountFils: S.fils(), reason: S.str(300), category: S.str(60), expenseDate: S.date(),
    paidFromAccountId: S.id(),
    maintenanceLinkId: S.opt(S.str(120)),
  },
  approveExpense: { expenseId: S.id() },
  rejectExpense: { expenseId: S.id(), reason: S.str(300) },
  reverseExpense: { expenseId: S.id(), reason: S.str(300) },

  createAccount: { name: S.str(120), kind: S.enum(["bank", "cash", "company"]) },
  updateAccount: { accountId: S.id(), name: S.opt(S.str(120)), active: S.opt(S.bool()) },

  createUser: { displayName: S.str(120), role: S.enum(["owner", "employee"]), pin: S.str(12) },
  updateUser: { userId: S.id(), displayName: S.opt(S.str(120)), role: S.opt(S.enum(["owner", "employee"])), active: S.opt(S.bool()) },
  setUserPin: { userId: S.id(), pin: S.str(12) },
  deactivateUser: { userId: S.id() },

  upsertUiConfig: { configId: S.enum(["locks", "permissions", "balances", "customUnits"]), json: S.str(200000) },
  payInstallment: { installmentDate: S.date(), amountFils: S.fils() },
  submitWorkRequest: {
    requestId: S.id(), type: S.str(80), desc: S.str(800), payloadJson: S.str(100000),
    month: S.int(0, 11), year: S.int(2020, 2100),
  },
  resolveWorkRequest: { requestId: S.id(), decision: S.enum(["pending", "processing", "approved", "rejected", "failed"]) },
  commitWorkRequest: { requestId: S.id() },
  uncollectObligation: { obligationId: S.id(), reason: S.str(300) },
  savePeriodExtras: { period: S.period(), extrasJson: S.str(400000) },
});

const ID_RE = /^[A-Za-z0-9_:.-]{1,140}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD_RE = /^\d{4}-\d{2}$/;

export function validatePayload(command, payload) {
  const schema = SCHEMAS[command];
  if (!schema) throw new DomainError("UNKNOWN_COMMAND", { command });
  const raw = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};

  const allowed = new Set(Object.keys(schema));
  const unknown = Object.keys(raw).filter((k) => !allowed.has(k));
  if (unknown.length) {
    // Deliberately loud. A client sending status/unitId/role learns the field is refused,
    // and no partial effect occurs.
    throw new DomainError("UNKNOWN_FIELD", { command, fields: unknown.sort() });
  }

  const out = {};
  for (const [key, rule] of Object.entries(schema)) {
    const value = raw[key];
    if (value === undefined || value === null) {
      if (rule.optional) continue;
      throw new DomainError("MISSING_FIELD", { command, field: key });
    }
    out[key] = coerce(command, key, rule, value);
  }
  return out;
}

function coerce(command, field, rule, value) {
  const bad = (why) => { throw new DomainError("INVALID_FIELD", { command, field, why }); };
  switch (rule.kind) {
    case "str": {
      if (typeof value !== "string") bad("not a string");
      const t = value.trim();
      if (!t) bad("empty");
      if (t.length > rule.max) bad("too long");
      return t;
    }
    case "id":
      if (typeof value !== "string" || !ID_RE.test(value)) bad("not an id");
      return value;
    case "fils":
      if (!isFils(value)) bad("money must be an integer number of fils");
      if (value <= 0) bad("must be positive");
      return value;
    case "date":
      if (typeof value !== "string" || !DATE_RE.test(value)) bad("expected YYYY-MM-DD");
      return value;
    case "period":
      if (typeof value !== "string" || !PERIOD_RE.test(value)) bad("expected YYYY-MM");
      return value;
    case "int": {
      if (!Number.isInteger(value)) bad("not an integer");
      if (value < rule.min || value > rule.max) bad(`out of range ${rule.min}..${rule.max}`);
      return value;
    }
    case "enum":
      if (!rule.values.includes(value)) bad(`expected one of ${rule.values.join("|")}`);
      return value;
    case "bool":
      if (typeof value !== "boolean") bad("not a boolean");
      return value;
    default:
      bad("unsupported");
  }
}

/* ═════════════════════ command execution ═════════════════════ */

/**
 * @param db        repository facade (see repositories/firestore.mjs)
 * @param actor     { userId, role, active } — loaded from the database, never from the client
 * @param command   command name
 * @param payload   raw client payload
 * @param operationId  idempotency key
 * @param now       ISO timestamp supplied by the caller so the domain stays pure
 */
export async function executeCommand({ db, actor, command, payload, operationId, now }) {
  if (!PERMISSIONS[command]) throw new DomainError("UNKNOWN_COMMAND", { command });
  if (!actor || !actor.userId) throw new DomainError("UNAUTHENTICATED");
  if (actor.active === false) throw new DomainError("ACCOUNT_DISABLED");
  if (!PERMISSIONS[command].includes(actor.role)) {
    throw new DomainError("FORBIDDEN", { command, role: actor.role });
  }
  if (typeof operationId !== "string" || !ID_RE.test(operationId) || operationId.length < 8) {
    throw new DomainError("INVALID_OPERATION_ID");
  }
  const clean = validatePayload(command, payload);

  if (command === "commitWorkRequest") {
    const run = (who, cmd, body, op) => executeCommand({
      db, actor: who, command: cmd, payload: body, operationId: op, now,
    });
    return commitWorkRequestFlow({ db, actor, payload: clean, operationId, now, run });
  }

  return db.runTransaction(async (tx) => {
    // Idempotency: a replay returns the original result and produces no new effect.
    const prior = await tx.get("operations", operationId);
    const fingerprint = hashPayload(command, clean);
    if (prior) {
      if (prior.payloadHash !== fingerprint) throw new DomainError("IDEMPOTENCY_PAYLOAD_MISMATCH");
      return { ...prior.result, replay: true };
    }

    const ctx = { tx, actor, now, operationId, payload: clean };
    const result = await HANDLERS[command](ctx);

    // `create` (not set) so two concurrent duplicates collide at the database.
    tx.create("operations", operationId, {
      operationId, command, payloadHash: fingerprint,
      actorUserId: actor.userId, state: "completed", result, at: now,
    });
    return { ...result, replay: false };
  });
}

function hashPayload(command, payload) {
  const stable = JSON.stringify([command, sortKeys(payload)]);
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < stable.length; i++) {
    const c = stable.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c, 2246822519) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0") + ":" + stable.length;
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  }
  return v;
}

/* ═════════════════════ audit ═════════════════════ */

function audit(ctx, action, targetType, targetId, extra = {}) {
  ctx.tx.create("auditEvents", `audit:${ctx.operationId}:${targetType}:${targetId}`, {
    at: ctx.now, actorUserId: ctx.actor.userId, actorRole: ctx.actor.role,
    action, targetType, targetId, operationId: ctx.operationId, ...extra,
  });
}

const base = (ctx) => ({ createdAt: ctx.now, createdBy: ctx.actor.userId, schemaVersion: 1 });
const newId = (prefix, ctx) => `${prefix}:${ctx.operationId}`;

/* ═════════════════════ handlers ═════════════════════ */

const HANDLERS = {
  /* ---------- structure ---------- */
  async createProperty(ctx) {
    const id = newId("prop", ctx);
    ctx.tx.create("properties", id, { id, ...ctx.payload, active: true, ...base(ctx) });
    audit(ctx, "property_created", "property", id);
    return { propertyId: id };
  },
  async updateProperty(ctx) {
    const { propertyId, ...patch } = ctx.payload;
    const doc = await ctx.tx.get("properties", propertyId);
    if (!doc) throw new DomainError("PROPERTY_NOT_FOUND");
    ctx.tx.update("properties", propertyId, patch);
    audit(ctx, "property_updated", "property", propertyId, { before: doc, after: { ...doc, ...patch } });
    return { propertyId };
  },
  async createUnit(ctx) {
    const prop = await ctx.tx.get("properties", ctx.payload.propertyId);
    if (!prop) throw new DomainError("PROPERTY_NOT_FOUND");
    const id = newId("unit", ctx);
    ctx.tx.create("units", id, { id, ...ctx.payload, active: true, ...base(ctx) });
    audit(ctx, "unit_created", "unit", id);
    return { unitId: id };
  },
  async updateUnit(ctx) {
    const { unitId, ...patch } = ctx.payload;
    const doc = await ctx.tx.get("units", unitId);
    if (!doc) throw new DomainError("UNIT_NOT_FOUND");
    if (patch.active === false) {
      const open = await ctx.tx.query("rentals", [["unitId", "==", unitId], ["state", "==", "active"]]);
      if (open.length) throw new DomainError("UNIT_HAS_ACTIVE_RENTAL", { rentalId: open[0].id });
      const spaces = await ctx.tx.query("spaces", [["unitId", "==", unitId]]);
      for (const sp of spaces) {
        if (sp.active === false) continue;
        ctx.tx.update("spaces", sp.id, { active: false });
      }
    }
    ctx.tx.update("units", unitId, patch);
    audit(ctx, "unit_updated", "unit", unitId);
    return { unitId };
  },
  async createSpace(ctx) {
    const unit = await ctx.tx.get("units", ctx.payload.unitId);
    if (!unit) throw new DomainError("UNIT_NOT_FOUND");
    const id = newId("space", ctx);
    ctx.tx.create("spaces", id, {
      id, unitId: unit.id, propertyId: unit.propertyId, name: ctx.payload.name,
      occupancy: "vacant", active: true, ...base(ctx),
    });
    audit(ctx, "space_created", "space", id);
    return { spaceId: id };
  },
  /**
   * Renaming or deactivating a space is operational. Receipts and obligations already
   * created keep their own snapshots, so history is untouched either way.
   */
  async updateSpace(ctx) {
    const { spaceId, ...patch } = ctx.payload;
    const space = await ctx.tx.get("spaces", spaceId);
    if (!space) throw new DomainError("SPACE_NOT_FOUND");
    if (patch.active === false) {
      const open = await ctx.tx.query("rentals", [["spaceId", "==", spaceId], ["state", "==", "active"]]);
      // Refusing beats orphaning a live tenancy: end the rental deliberately first.
      if (open.length) throw new DomainError("SPACE_HAS_ACTIVE_RENTAL", { rentalId: open[0].id });
    }
    ctx.tx.update("spaces", spaceId, patch);
    audit(ctx, "space_updated", "space", spaceId, { before: { name: space.name, active: space.active }, after: patch });
    return { spaceId };
  },

  /** Correcting the tenant's name or phone. Obligation snapshots already issued stay as they were. */
  async updateRentalTenant(ctx) {
    const { rentalId, ...patch } = ctx.payload;
    const rental = await ctx.tx.get("rentals", rentalId);
    if (!rental) throw new DomainError("RENTAL_NOT_FOUND");
    if (rental.state !== "active") throw new DomainError("RENTAL_NOT_ACTIVE");
    if (!Object.keys(patch).length) throw new DomainError("NOTHING_TO_UPDATE");
    ctx.tx.update("rentals", rentalId, patch);
    audit(ctx, "rental_tenant_updated", "rental", rentalId, { before: { tenantName: rental.tenantName }, after: patch });
    return { rentalId };
  },

  /**
   * Occupancy is operational. Setting vacant/staff MUST end any active rental and
   * cancel unpaid obligations — a vacant space cannot remain late with an active due.
   */
  async setSpaceOccupancy(ctx) {
    await assertEmployeePeriodOpen(ctx, periodOf(ctx.now.slice(0, 10)));
    const space = await ctx.tx.get("spaces", ctx.payload.spaceId);
    if (!space) throw new DomainError("SPACE_NOT_FOUND");
    const next = ctx.payload.occupancy;
    const closed = [];
    if (next === "vacant" || next === "staff") {
      const open = await ctx.tx.query("rentals", [["spaceId", "==", space.id], ["state", "==", "active"]]);
      for (const rental of open) {
        const r = await closeRentalInTx(ctx, rental, {
          endDate: ctx.now.slice(0, 10),
          reason: next === "vacant" ? "إفراغ الوحدة" : "تحويل إلى موظفين",
          setVacant: next === "vacant",
        });
        closed.push(r);
      }
    }
    ctx.tx.update("spaces", space.id, { occupancy: next });
    audit(ctx, "occupancy_changed", "space", space.id, {
      before: space.occupancy, after: next, closedRentals: closed.map((c) => c.rentalId),
    });
    return { spaceId: space.id, occupancy: next, closedRentals: closed };
  },

  /* ---------- rentals ---------- */
  async createRental(ctx) {
    const space = await ctx.tx.get("spaces", ctx.payload.spaceId);
    if (!space) throw new DomainError("SPACE_NOT_FOUND");
    if (isPlaceholderTenant(ctx.payload.tenantName)) {
      throw new DomainError("TENANT_REQUIRED", { tenantName: ctx.payload.tenantName });
    }
    const open = await ctx.tx.query("rentals", [["spaceId", "==", space.id], ["state", "==", "active"]]);
    if (open.length) throw new DomainError("SPACE_ALREADY_RENTED", { rentalId: open[0].id });

    const id = newId("rental", ctx);
    ctx.tx.create("rentals", id, {
      id, propertyId: space.propertyId, unitId: space.unitId, spaceId: space.id,
      tenantName: String(ctx.payload.tenantName).trim(), tenantPhone: ctx.payload.tenantPhone || null,
      contractualAmountFils: ctx.payload.contractualAmountFils,
      dueDayOfMonth: ctx.payload.dueDayOfMonth, startDate: ctx.payload.startDate,
      endDate: null, state: "active",
      securityDepositFils: ctx.payload.securityDepositFils || 0, ...base(ctx),
    });
    ctx.tx.update("spaces", space.id, { occupancy: "rented" });
    audit(ctx, "rental_created", "rental", id, { amountFils: ctx.payload.contractualAmountFils });
    return { rentalId: id };
  },
  /**
   * Rent on the rental always updates. Period obligations that already have
   * live receipts stay frozen (historical snapshot). Unpaid obligations of the
   * same rental are revised so the current month's card matches the edit.
   */
  async updateRentalRent(ctx) {
    const rental = await ctx.tx.get("rentals", ctx.payload.rentalId);
    if (!rental) throw new DomainError("RENTAL_NOT_FOUND");
    if (rental.state !== "active") throw new DomainError("RENTAL_NOT_ACTIVE");
    ctx.tx.update("rentals", rental.id, { contractualAmountFils: ctx.payload.contractualAmountFils });
    const obligations = await ctx.tx.query("obligations", [["rentalId", "==", rental.id]]);
    const revised = [];
    for (const ob of obligations) {
      if (ob.state !== "active") continue;
      const receipts = await ctx.tx.query("receipts", [["obligationId", "==", ob.id]]);
      const live = receipts.filter(
        (r) => r.state === RECEIPT_STATE.RECOGNIZED || r.state === RECEIPT_STATE.PENDING,
      );
      if (live.length) continue;
      if (ob.amountFils === ctx.payload.contractualAmountFils) continue;
      ctx.tx.update("obligations", ob.id, { amountFils: ctx.payload.contractualAmountFils });
      revised.push(ob.id);
    }
    audit(ctx, "rental_rent_updated", "rental", rental.id, {
      before: rental.contractualAmountFils, after: ctx.payload.contractualAmountFils, revised,
    });
    return { rentalId: rental.id, revisedObligationIds: revised };
  },
  /**
   * Recurring due day must follow the contract start day-of-month.
   * Updates rental.startDate / dueDayOfMonth and rewrites active obligation dueDates
   * for every period (money amounts untouched).
   */
  async updateRentalSchedule(ctx) {
    const rental = await ctx.tx.get("rentals", ctx.payload.rentalId);
    if (!rental) throw new DomainError("RENTAL_NOT_FOUND");
    if (rental.state !== "active") throw new DomainError("RENTAL_NOT_ACTIVE");

    const patch = {};
    if (ctx.payload.startDate) patch.startDate = ctx.payload.startDate;
    if (ctx.payload.dueDayOfMonth != null) patch.dueDayOfMonth = ctx.payload.dueDayOfMonth;

    // If only startDate is supplied, derive due day from it (upfront rent rule).
    if (patch.startDate && ctx.payload.dueDayOfMonth == null) {
      patch.dueDayOfMonth = Math.min(31, Math.max(1, Number(String(patch.startDate).slice(8, 10)) || 1));
    }
    if (!Object.keys(patch).length) throw new DomainError("NOTHING_TO_UPDATE");

    const nextDueDay = patch.dueDayOfMonth != null ? patch.dueDayOfMonth : rental.dueDayOfMonth;
    ctx.tx.update("rentals", rental.id, patch);

    const obligations = await ctx.tx.query("obligations", [["rentalId", "==", rental.id]]);
    const revised = [];
    for (const ob of obligations) {
      if (ob.state !== "active") continue;
      const nextDue = dueDateFor(ob.period, nextDueDay);
      if (ob.dueDate === nextDue) continue;
      ctx.tx.update("obligations", ob.id, { dueDate: nextDue });
      revised.push({ obligationId: ob.id, before: ob.dueDate, after: nextDue });
    }
    audit(ctx, "rental_schedule_updated", "rental", rental.id, {
      before: { startDate: rental.startDate, dueDayOfMonth: rental.dueDayOfMonth },
      after: { ...patch, dueDayOfMonth: nextDueDay },
      revised,
    });
    return { rentalId: rental.id, dueDayOfMonth: nextDueDay, revisedObligationIds: revised.map((r) => r.obligationId) };
  },
  /**
   * Closing ends the tenancy. Unpaid obligations are cancelled so Target/Late cannot
   * keep a due on a vacant space. Obligations with live receipts stay as audit history
   * but the read model excludes closed-rental obligations from monthly KPIs.
   */
  async closeRental(ctx) {
    const rental = await ctx.tx.get("rentals", ctx.payload.rentalId);
    if (!rental) throw new DomainError("RENTAL_NOT_FOUND");
    if (rental.state === "closed") throw new DomainError("RENTAL_ALREADY_CLOSED");
    return closeRentalInTx(ctx, rental, {
      endDate: ctx.payload.endDate,
      reason: ctx.payload.reason,
      setVacant: !!ctx.payload.setVacant,
    });
  },

  /* ---------- obligations ---------- */
  /**
   * Deterministic ids make this idempotent at the database, not merely at the operation
   * record: two concurrent calls for the same period cannot both create.
   * ONLY legitimate ACTIVE rentals on non-vacant spaces get obligations.
   * Closed / reset / archive rentals never regenerate.
   */
  async generateObligations(ctx) {
    const period = ctx.payload.period;
    const rentals = await ctx.tx.query("rentals", [["state", "==", "active"]]);
    const created = [];
    for (const rental of rentals) {
      if (String(rental.startDate).slice(0, 7) > period) continue;
      const space = await ctx.tx.get("spaces", rental.spaceId);
      if (!space || space.active === false) continue;
      if (space.occupancy === "vacant" || space.occupancy === "staff") continue;
      if (isPlaceholderTenant(rental.tenantName)) continue;
      const id = obligationIdFor(rental.id, period);
      const existing = await ctx.tx.get("obligations", id);
      // Existing cancelled/closed docs must never be resurrected by regenerate.
      if (existing) continue;
      ctx.tx.create("obligations", id, {
        id, rentalId: rental.id, propertyId: rental.propertyId, unitId: rental.unitId,
        spaceId: rental.spaceId, period,
        amountFils: rental.contractualAmountFils,
        dueDate: dueDateFor(period, rental.dueDayOfMonth),
        tenantNameSnapshot: rental.tenantName,
        state: "active", ...base(ctx),
      });
      created.push(id);
    }
    audit(ctx, "obligations_generated", "period", period, { count: created.length });
    return { period, created: created.length, obligationIds: created };
  },
  async cancelObligation(ctx) {
    const ob = await ctx.tx.get("obligations", ctx.payload.obligationId);
    if (!ob) throw new DomainError("OBLIGATION_NOT_FOUND");
    if (ob.state !== "active") throw new DomainError("OBLIGATION_NOT_ACTIVE");
    const receipts = await ctx.tx.query("receipts", [["obligationId", "==", ob.id]]);
    const live = receipts.filter((r) => r.state === RECEIPT_STATE.RECOGNIZED || r.state === RECEIPT_STATE.PENDING);
    // Refusing beats orphaning money: reverse the receipts first, deliberately.
    if (live.length) throw new DomainError("OBLIGATION_HAS_RECEIPTS", { count: live.length });
    ctx.tx.update("obligations", ob.id, {
      state: "cancelled", cancelledBy: ctx.actor.userId, cancelledAt: ctx.now, cancelReason: ctx.payload.reason,
    });
    audit(ctx, "obligation_cancelled", "obligation", ob.id, { reason: ctx.payload.reason });
    return { obligationId: ob.id };
  },

  /* ---------- receipts ---------- */
  async createCashReceipt(ctx) {
    const collectorUserId = await collectorFor(ctx);
    return createReceipt(ctx, {
      method: "cash",
      state: RECEIPT_STATE.RECOGNIZED,     // D6: employee cash is recognized immediately
      collectorUserId,
    });
  },
  async submitBankReceipt(ctx) {
    const collectorUserId = await collectorFor(ctx);
    return createReceipt(ctx, {
      method: "bank",
      state: RECEIPT_STATE.PENDING,        // pending affects nothing until owner approval
      collectorUserId,
      bankReference: ctx.payload.bankReference,
    });
  },
  async approveBankReceipt(ctx) {
    const receipt = await ctx.tx.get("receipts", ctx.payload.receiptId);
    if (!receipt) throw new DomainError("RECEIPT_NOT_FOUND");
    if (receipt.state !== RECEIPT_STATE.PENDING) throw new DomainError("RECEIPT_NOT_PENDING", { state: receipt.state });

    // Re-check the fit at approval time: the obligation may have been paid meanwhile.
    const ob = await ctx.tx.get("obligations", receipt.obligationId);
    const siblings = await ctx.tx.query("receipts", [["obligationId", "==", receipt.obligationId]]);
    assertReceiptFits({
      obligation: ob,
      receipts: siblings.filter((r) => r.id !== receipt.id),
      amountFils: receipt.amountFils,
      asOfDate: ctx.now.slice(0, 10),
    });

    ctx.tx.update("receipts", receipt.id, {
      state: RECEIPT_STATE.RECOGNIZED, approvedBy: ctx.actor.userId, approvedAt: ctx.now,
    });
    await creditRevenueAccount(ctx, {
      amountFils: receipt.amountFils,
      sourceType: "bank_receipt",
      sourceId: receipt.id,
      note: "تحويل بنكي معتمد",
    });
    audit(ctx, "bank_receipt_approved", "receipt", receipt.id, { amountFils: receipt.amountFils });
    return { receiptId: receipt.id, state: RECEIPT_STATE.RECOGNIZED };
  },
  async rejectBankReceipt(ctx) {
    const receipt = await ctx.tx.get("receipts", ctx.payload.receiptId);
    if (!receipt) throw new DomainError("RECEIPT_NOT_FOUND");
    if (receipt.state !== RECEIPT_STATE.PENDING) throw new DomainError("RECEIPT_NOT_PENDING");
    ctx.tx.update("receipts", receipt.id, {
      state: RECEIPT_STATE.REJECTED, rejectedBy: ctx.actor.userId, rejectedAt: ctx.now,
      rejectReason: ctx.payload.reason,
    });
    audit(ctx, "bank_receipt_rejected", "receipt", receipt.id, { reason: ctx.payload.reason });
    return { receiptId: receipt.id, state: RECEIPT_STATE.REJECTED };
  },
  /** Corrections never edit or delete. The original stays, visibly reversed. */
  async reverseReceipt(ctx) {
    const receipt = await ctx.tx.get("receipts", ctx.payload.receiptId);
    if (!receipt) throw new DomainError("RECEIPT_NOT_FOUND");
    if (receipt.state === RECEIPT_STATE.REVERSED) throw new DomainError("ALREADY_REVERSED");
    if (receipt.state !== RECEIPT_STATE.RECOGNIZED) throw new DomainError("RECEIPT_NOT_RECOGNIZED", { state: receipt.state });

    // Shared-pool safety: reversing cash is allowed only if عهدة الموظفين stays >= 0.
    if (receipt.method === "cash") {
      const allReceipts = await ctx.tx.query("receipts", []);
      const allDeposits = await ctx.tx.query("deposits", []);
      assertCashReversalFitsSharedHolding({
        receipts: allReceipts,
        deposits: allDeposits,
        reversingReceiptIds: [receipt.id],
      });
    }

    const reversalId = newId("rev", ctx);
    ctx.tx.create("reversals", reversalId, {
      id: reversalId, targetType: "receipt", targetId: receipt.id,
      amountFils: receipt.amountFils, reason: ctx.payload.reason, ...base(ctx),
    });
    ctx.tx.update("receipts", receipt.id, {
      state: RECEIPT_STATE.REVERSED, reversedByReversalId: reversalId, reversedAt: ctx.now,
    });
    if (receipt.method === "bank") {
      await debitRevenueAccount(ctx, {
        amountFils: receipt.amountFils,
        sourceType: "bank_receipt",
        sourceId: receipt.id,
        note: ctx.payload.reason,
      });
    }
    audit(ctx, "receipt_reversed", "receipt", receipt.id, { amountFils: receipt.amountFils, reason: ctx.payload.reason, reversalId });
    return { receiptId: receipt.id, reversalId };
  },

  /**
   * Owner correction: reverse every recognized receipt on an obligation so the
   * derived status returns to late/unpaid. Status is never stored — money moves.
   */
  async uncollectObligation(ctx) {
    const ob = await ctx.tx.get("obligations", ctx.payload.obligationId);
    if (!ob) throw new DomainError("OBLIGATION_NOT_FOUND");
    await assertEmployeePeriodOpen(ctx, ob.period);
    const receipts = await ctx.tx.query("receipts", [["obligationId", "==", ob.id]]);
    const live = receipts.filter((r) => r.state === RECEIPT_STATE.RECOGNIZED);
    const cashLive = live.filter((r) => r.method === "cash");
    if (cashLive.length) {
      const allReceipts = await ctx.tx.query("receipts", []);
      const allDeposits = await ctx.tx.query("deposits", []);
      assertCashReversalFitsSharedHolding({
        receipts: allReceipts,
        deposits: allDeposits,
        reversingReceiptIds: cashLive.map((r) => r.id),
      });
    }
    const reversalIds = [];
    for (const receipt of live) {
      const reversalId = `rev:${ctx.operationId}:${receipt.id}`.slice(0, 140);
      ctx.tx.create("reversals", reversalId, {
        id: reversalId, targetType: "receipt", targetId: receipt.id,
        amountFils: receipt.amountFils, reason: ctx.payload.reason, ...base(ctx),
      });
      ctx.tx.update("receipts", receipt.id, {
        state: RECEIPT_STATE.REVERSED, reversedByReversalId: reversalId, reversedAt: ctx.now,
      });
      audit(ctx, "receipt_reversed", "receipt", receipt.id, {
        amountFils: receipt.amountFils, reason: ctx.payload.reason, reversalId,
      });
      reversalIds.push(reversalId);
    }
    audit(ctx, "obligation_uncollected", "obligation", ob.id, { count: reversalIds.length, reason: ctx.payload.reason });
    return { obligationId: ob.id, reversed: reversalIds.length, reversalIds };
  },

  /* ---------- deposits ---------- */
  async submitDeposit(ctx) {
    await assertEmployeePeriodOpen(ctx, periodOf(ctx.payload.depositDate));
    const account = await ctx.tx.get("accounts", ctx.payload.destinationAccountId);
    if (!account || account.active === false) throw new DomainError("ACCOUNT_NOT_FOUND");

    const employeeId = await depositEmployeeFor(ctx);
    const receipts = await ctx.tx.query("receipts", []);
    const deposits = await ctx.tx.query("deposits", []);
    // EVERY approved/pending deposit that will reduce Shared Holding must fit
    // current cash custody. Owner auto-approve used to skip this and could
    // drive Holding negative (e.g. book deposit with no live cash).
    assertDepositFitsCustody({
      employeeId, amountFils: ctx.payload.amountFils, receipts, deposits,
    });

    const id = newId("dep", ctx);
    const approved = ctx.actor.role === "owner";
    ctx.tx.create("deposits", id, {
      id,
      employeeId,
      amountFils: ctx.payload.amountFils,
      depositDate: ctx.payload.depositDate,
      period: periodOf(ctx.payload.depositDate),
      destinationAccountId: account.id,
      note: ctx.payload.note || null, reference: ctx.payload.reference || null,
      state: approved ? APPROVAL_STATE.APPROVED : APPROVAL_STATE.PENDING,
      ...(approved ? { approvedBy: ctx.actor.userId, approvedAt: ctx.now } : {}),
      ...base(ctx),
    });
    audit(ctx, "deposit_submitted", "deposit", id, { amountFils: ctx.payload.amountFils });
    if (approved) {
      await creditRevenueAccount(ctx, {
        amountFils: ctx.payload.amountFils,
        sourceType: "deposit",
        sourceId: id,
        note: "إيداع معتمد (مدير)",
        accountId: account.id,
      });
    }
    return { depositId: id, state: approved ? APPROVAL_STATE.APPROVED : APPROVAL_STATE.PENDING };
  },
  async approveDeposit(ctx) {
    const dep = await ctx.tx.get("deposits", ctx.payload.depositId);
    if (!dep) throw new DomainError("DEPOSIT_NOT_FOUND");
    if (dep.state !== APPROVAL_STATE.PENDING) throw new DomainError("DEPOSIT_NOT_PENDING", { state: dep.state });

    // Same Firestore transaction: refuse if amount exceeds current Shared Holding.
    const receipts = await ctx.tx.query("receipts", []);
    const deposits = await ctx.tx.query("deposits", []);
    assertDepositFitsCustody({
      employeeId: dep.employeeId, amountFils: dep.amountFils,
      receipts, deposits: deposits.filter((d) => d.id !== dep.id),
    });

    ctx.tx.update("deposits", dep.id, {
      state: APPROVAL_STATE.APPROVED, approvedBy: ctx.actor.userId, approvedAt: ctx.now,
    });
    await creditRevenueAccount(ctx, {
      amountFils: dep.amountFils,
      sourceType: "deposit",
      sourceId: dep.id,
      note: "اعتماد إيداع موظف",
      accountId: dep.destinationAccountId,
    });
    audit(ctx, "deposit_approved", "deposit", dep.id, { amountFils: dep.amountFils, employeeId: dep.employeeId });
    return { depositId: dep.id, state: APPROVAL_STATE.APPROVED };
  },
  async rejectDeposit(ctx) {
    const dep = await ctx.tx.get("deposits", ctx.payload.depositId);
    if (!dep) throw new DomainError("DEPOSIT_NOT_FOUND");
    if (dep.state !== APPROVAL_STATE.PENDING) throw new DomainError("DEPOSIT_NOT_PENDING");
    ctx.tx.update("deposits", dep.id, {
      state: APPROVAL_STATE.REJECTED, rejectedBy: ctx.actor.userId, rejectedAt: ctx.now,
      rejectReason: ctx.payload.reason,
    });
    audit(ctx, "deposit_rejected", "deposit", dep.id, { reason: ctx.payload.reason });
    return { depositId: dep.id, state: APPROVAL_STATE.REJECTED };
  },
  async reverseDeposit(ctx) {
    const dep = await ctx.tx.get("deposits", ctx.payload.depositId);
    if (!dep) throw new DomainError("DEPOSIT_NOT_FOUND");
    if (dep.state === APPROVAL_STATE.REVERSED) throw new DomainError("ALREADY_REVERSED");
    if (dep.state !== APPROVAL_STATE.APPROVED) throw new DomainError("DEPOSIT_NOT_APPROVED", { state: dep.state });
    const reversalId = newId("rev", ctx);
    ctx.tx.create("reversals", reversalId, {
      id: reversalId, targetType: "deposit", targetId: dep.id,
      amountFils: dep.amountFils, reason: ctx.payload.reason, ...base(ctx),
    });
    ctx.tx.update("deposits", dep.id, {
      state: APPROVAL_STATE.REVERSED, reversedByReversalId: reversalId, reversedAt: ctx.now,
    });
    await debitRevenueAccount(ctx, {
      amountFils: dep.amountFils,
      sourceType: "deposit",
      sourceId: dep.id,
      note: ctx.payload.reason,
      accountId: dep.destinationAccountId,
    });
    audit(ctx, "deposit_reversed", "deposit", dep.id, { amountFils: dep.amountFils, reversalId });
    return { depositId: dep.id, reversalId };
  },

  /* ---------- expenses ---------- */
  async submitExpense(ctx) {
    await assertEmployeePeriodOpen(ctx, periodOf(ctx.payload.expenseDate));
    const account = await ctx.tx.get("accounts", ctx.payload.paidFromAccountId);
    if (!account || account.active === false) throw new DomainError("ACCOUNT_NOT_FOUND");
    const id = newId("exp", ctx);
    const approved = ctx.actor.role === "owner";
    const maintenanceLinkId = ctx.payload.maintenanceLinkId || null;
    ctx.tx.create("expenses", id, {
      id, amountFils: ctx.payload.amountFils, reason: ctx.payload.reason,
      category: ctx.payload.category, expenseDate: ctx.payload.expenseDate,
      period: periodOf(ctx.payload.expenseDate),
      paidFromAccountId: account.id, submittedBy: ctx.actor.userId,
      maintenanceLinkId,
      state: approved ? APPROVAL_STATE.APPROVED : APPROVAL_STATE.PENDING,
      ...(approved ? { approvedBy: ctx.actor.userId, approvedAt: ctx.now } : {}),
      ...base(ctx),
    });
    audit(ctx, "expense_submitted", "expense", id, { amountFils: ctx.payload.amountFils, maintenanceLinkId });
    // Recognized expenses are paid from حساب الإيرادات exactly once.
    if (approved) {
      await debitRevenueAccount(ctx, {
        amountFils: ctx.payload.amountFils,
        sourceType: "expense",
        sourceId: id,
        note: ctx.payload.reason || "مصروف",
        accountId: account.id,
        requirePriorCredit: false,
      });
    }
    return { expenseId: id, state: approved ? APPROVAL_STATE.APPROVED : APPROVAL_STATE.PENDING };
  },
  async approveExpense(ctx) {
    const exp = await ctx.tx.get("expenses", ctx.payload.expenseId);
    if (!exp) throw new DomainError("EXPENSE_NOT_FOUND");
    if (exp.state !== APPROVAL_STATE.PENDING) throw new DomainError("EXPENSE_NOT_PENDING", { state: exp.state });
    ctx.tx.update("expenses", exp.id, {
      state: APPROVAL_STATE.APPROVED, approvedBy: ctx.actor.userId, approvedAt: ctx.now,
    });
    await debitRevenueAccount(ctx, {
      amountFils: exp.amountFils,
      sourceType: "expense",
      sourceId: exp.id,
      note: exp.reason || "اعتماد مصروف",
      accountId: exp.paidFromAccountId,
      requirePriorCredit: false,
    });
    audit(ctx, "expense_approved", "expense", exp.id, { amountFils: exp.amountFils });
    return { expenseId: exp.id, state: APPROVAL_STATE.APPROVED };
  },
  async rejectExpense(ctx) {
    const exp = await ctx.tx.get("expenses", ctx.payload.expenseId);
    if (!exp) throw new DomainError("EXPENSE_NOT_FOUND");
    if (exp.state !== APPROVAL_STATE.PENDING) throw new DomainError("EXPENSE_NOT_PENDING");
    ctx.tx.update("expenses", exp.id, {
      state: APPROVAL_STATE.REJECTED, rejectedBy: ctx.actor.userId, rejectedAt: ctx.now,
      rejectReason: ctx.payload.reason,
    });
    audit(ctx, "expense_rejected", "expense", exp.id, { reason: ctx.payload.reason });
    return { expenseId: exp.id, state: APPROVAL_STATE.REJECTED };
  },
  async reverseExpense(ctx) {
    const exp = await ctx.tx.get("expenses", ctx.payload.expenseId);
    if (!exp) throw new DomainError("EXPENSE_NOT_FOUND");
    if (exp.state === APPROVAL_STATE.REVERSED) throw new DomainError("ALREADY_REVERSED");
    if (exp.state !== APPROVAL_STATE.APPROVED) throw new DomainError("EXPENSE_NOT_APPROVED");
    const reversalId = newId("rev", ctx);
    ctx.tx.create("reversals", reversalId, {
      id: reversalId, targetType: "expense", targetId: exp.id,
      amountFils: exp.amountFils, reason: ctx.payload.reason, ...base(ctx),
    });
    ctx.tx.update("expenses", exp.id, {
      state: APPROVAL_STATE.REVERSED, reversedByReversalId: reversalId, reversedAt: ctx.now,
    });
    // Restore Revenue only if this expense previously debited it (idempotent credit).
    const debitId = (`ledger:expense:${exp.id}:debit`).slice(0, 140);
    if (await ctx.tx.get("ledgerEntries", debitId)) {
      await creditRevenueAccount(ctx, {
        amountFils: exp.amountFils,
        sourceType: "expense",
        sourceId: exp.id,
        note: ctx.payload.reason || "عكس مصروف",
        accountId: exp.paidFromAccountId,
      });
    }
    audit(ctx, "expense_reversed", "expense", exp.id, { reversalId });
    return { expenseId: exp.id, reversalId };
  },

  /* ---------- accounts (D4) ---------- */
  async createAccount(ctx) {
    const id = newId("acc", ctx);
    ctx.tx.create("accounts", id, { id, ...ctx.payload, active: true, ...base(ctx) });
    audit(ctx, "account_created", "account", id);
    return { accountId: id };
  },
  async updateAccount(ctx) {
    const { accountId, ...patch } = ctx.payload;
    const doc = await ctx.tx.get("accounts", accountId);
    if (!doc) throw new DomainError("ACCOUNT_NOT_FOUND");
    ctx.tx.update("accounts", accountId, patch);
    audit(ctx, "account_updated", "account", accountId);
    return { accountId };
  },

  /* ---------- users ---------- */
  async createUser(ctx) {
    const id = newId("user", ctx);
    const { hash, salt } = await ctx.tx.hashPin(ctx.payload.pin);
    ctx.tx.create("users", id, {
      id, userId: id, displayName: ctx.payload.displayName, role: ctx.payload.role,
      active: true, pinHash: hash, pinSalt: salt, pinUpdatedAt: ctx.now, ...base(ctx),
    });
    audit(ctx, "user_created", "user", id, { role: ctx.payload.role });
    return { userId: id };
  },
  async updateUser(ctx) {
    const { userId, ...patch } = ctx.payload;
    const doc = await ctx.tx.get("users", userId);
    if (!doc) throw new DomainError("USER_NOT_FOUND");
    ctx.tx.update("users", userId, patch);
    audit(ctx, "user_updated", "user", userId, { before: { role: doc.role, active: doc.active }, after: patch });
    return { userId };
  },
  async setUserPin(ctx) {
    const doc = await ctx.tx.get("users", ctx.payload.userId);
    if (!doc) throw new DomainError("USER_NOT_FOUND");
    const { hash, salt } = await ctx.tx.hashPin(ctx.payload.pin);
    ctx.tx.update("users", doc.id, { pinHash: hash, pinSalt: salt, pinUpdatedAt: ctx.now });
    audit(ctx, "user_pin_changed", "user", doc.id);   // never records the PIN itself
    return { userId: doc.id };
  },
  async deactivateUser(ctx) {
    const doc = await ctx.tx.get("users", ctx.payload.userId);
    if (!doc) throw new DomainError("USER_NOT_FOUND");
    if (doc.id === ctx.actor.userId) throw new DomainError("CANNOT_DEACTIVATE_SELF");
    ctx.tx.update("users", doc.id, { active: false });
    audit(ctx, "user_deactivated", "user", doc.id);
    return { userId: doc.id };
  },

  async upsertUiConfig(ctx) {
    const id = ctx.payload.configId;
    parseJsonField(ctx.payload.json, "json");
    const rec = {
      id, json: ctx.payload.json, updatedAt: ctx.now, updatedBy: ctx.actor.userId, schemaVersion: 1,
    };
    const existing = await ctx.tx.get("uiConfig", id);
    let beforeRev = null;
    let afterRev = null;
    if (id === "balances") {
      try {
        const prevObj = existing ? JSON.parse(existing.json || "{}") : {};
        const nextObj = JSON.parse(ctx.payload.json || "{}");
        beforeRev = Number(prevObj.revenueBalance);
        afterRev = Number(nextObj.revenueBalance);
      } catch { /* ignore parse */ }
    }
    if (existing) ctx.tx.update("uiConfig", id, rec);
    else ctx.tx.create("uiConfig", id, { ...rec, ...base(ctx) });
    if (id === "balances" && beforeRev != null && afterRev != null && beforeRev !== afterRev) {
      audit(ctx, "revenue_balance_manual_adjust", "uiConfig", "balances:revenue", {
        beforeAed: beforeRev,
        afterAed: afterRev,
        deltaAed: Math.round((afterRev - beforeRev) * 100) / 100,
        reason: "تعديل يدوي من المالية",
      });
    } else {
      audit(ctx, "ui_config_upserted", "uiConfig", id);
    }
    return { configId: id };
  },

  /**
   * Atomic installment pay: mark one schedule row paid + debit installmentBalance.
   * Concurrent sessions / lost-response retries are safe via operationId + paid guard.
   */
  async payInstallment(ctx) {
    const date = ctx.payload.installmentDate;
    const amountFils = ctx.payload.amountFils;
    const amountAed = Math.round(amountFils) / 100;
    const existing = await ctx.tx.get("uiConfig", "balances");
    if (!existing) throw new DomainError("BALANCES_NOT_FOUND");
    let obj = {};
    try { obj = JSON.parse(existing.json || "{}"); } catch { obj = {}; }
    const sched = Array.isArray(obj.installmentSchedule) ? obj.installmentSchedule.slice() : [];
    const idx = sched.findIndex((x) => String(x && x.date) === date);
    if (idx < 0) throw new DomainError("INSTALLMENT_NOT_FOUND", { installmentDate: date });
    const row = sched[idx] || {};
    const rowFils = Math.round(Number(row.amount || 0) * 100);
    if (rowFils !== amountFils) {
      throw new DomainError("INSTALLMENT_AMOUNT_MISMATCH", {
        installmentDate: date, expectedFils: rowFils, gotFils: amountFils,
      });
    }
    if (row.paid) {
      return {
        alreadyApplied: true,
        installmentDate: date,
        installmentBalance: Number(obj.installmentBalance || 0),
        paidCount: sched.filter((x) => x && x.paid).length,
      };
    }
    const bal = Number(obj.installmentBalance || 0);
    if (!(bal >= amountAed)) {
      throw new DomainError("INSUFFICIENT_INSTALLMENT_BALANCE", {
        installmentDate: date, balanceAed: bal, needAed: amountAed,
      });
    }
    const nextBal = Math.round((bal - amountAed) * 100) / 100;
    sched[idx] = {
      ...row,
      paid: true,
      paidAt: ctx.now,
      paidBy: ctx.actor.userId,
      evidence: row.evidence || "payInstallment",
    };
    obj.installmentSchedule = sched;
    obj.installmentBalance = nextBal;
    obj.updatedAt = ctx.now;
    ctx.tx.update("uiConfig", "balances", {
      json: JSON.stringify(obj),
      updatedAt: ctx.now,
      updatedBy: ctx.actor.userId,
      schemaVersion: 1,
    });
    audit(ctx, "installment_paid", "uiConfig", `balances:installment:${date}`, {
      amountFils, balanceAfterAed: nextBal,
    });
    return {
      alreadyApplied: false,
      installmentDate: date,
      installmentBalance: nextBal,
      paidCount: sched.filter((x) => x && x.paid).length,
    };
  },

  async submitWorkRequest(ctx) {
    const id = ctx.payload.requestId;
    if (await ctx.tx.get("uiRequests", id)) throw new DomainError("REQUEST_EXISTS", { requestId: id });
    parseJsonField(ctx.payload.payloadJson, "payloadJson");
    let payload = {};
    try { payload = JSON.parse(ctx.payload.payloadJson); } catch { payload = {}; }
    const lockId = pendingRequestLockId({
      type: ctx.payload.type,
      actorKey: actorKey(ctx.actor),
      year: ctx.payload.year,
      month: ctx.payload.month,
      payload,
    });
    if (lockId) {
      const lock = await ctx.tx.get("uiRequests", lockId);
      if (lock && lock.status === "pending" && lock.activeRequestId) {
        const existing = await ctx.tx.get("uiRequests", lock.activeRequestId);
        if (existing && existing.status === "pending") {
          throw new DomainError("DUPLICATE_PENDING_REQUEST", {
            requestId: existing.id,
            lockId,
            type: ctx.payload.type,
          });
        }
      }
    }
    ctx.tx.create("uiRequests", id, {
      id,
      type: ctx.payload.type,
      desc: ctx.payload.desc,
      payloadJson: ctx.payload.payloadJson,
      month: ctx.payload.month,
      year: ctx.payload.year,
      by: ctx.actor.userId,
      byKey: actorKey(ctx.actor),
      byName: ctx.actor.displayName || actorKey(ctx.actor),
      status: "pending",
      createdAt: ctx.now,
      ...(lockId ? { lockId } : {}),
      ...base(ctx),
    });
    if (lockId) {
      const lockRec = {
        id: lockId,
        type: "pending_lock",
        status: "pending",
        activeRequestId: id,
        lockType: ctx.payload.type,
        by: ctx.actor.userId,
        byKey: actorKey(ctx.actor),
        month: ctx.payload.month,
        year: ctx.payload.year,
        updatedAt: ctx.now,
        ...base(ctx),
      };
      const prev = await ctx.tx.get("uiRequests", lockId);
      if (prev) ctx.tx.update("uiRequests", lockId, lockRec);
      else ctx.tx.create("uiRequests", lockId, lockRec);
    }
    audit(ctx, "work_request_submitted", "uiRequest", id, { type: ctx.payload.type });
    return { requestId: id, status: "pending" };
  },

  async resolveWorkRequest(ctx) {
    const doc = await ctx.tx.get("uiRequests", ctx.payload.requestId);
    if (!doc) throw new DomainError("REQUEST_NOT_FOUND");
    const next = ctx.payload.decision;
    if (next === "approved" || next === "rejected") {
      if (doc.status !== "pending" && doc.status !== "processing") {
        throw new DomainError("REQUEST_NOT_PENDING", { status: doc.status });
      }
    }
    ctx.tx.update("uiRequests", doc.id, {
      status: next, resolvedBy: ctx.actor.userId, resolvedAt: ctx.now,
    });
    if (doc.lockId && (next === "approved" || next === "rejected" || next === "failed")) {
      const lock = await ctx.tx.get("uiRequests", doc.lockId);
      if (lock && lock.activeRequestId === doc.id) {
        ctx.tx.update("uiRequests", doc.lockId, {
          status: "clear", activeRequestId: null, clearedAt: ctx.now,
        });
      }
    }
    audit(ctx, "work_request_resolved", "uiRequest", doc.id, { decision: next });
    return { requestId: doc.id, status: next };
  },

  async savePeriodExtras(ctx) {
    await assertEmployeePeriodOpen(ctx, ctx.payload.period);
    parseJsonField(ctx.payload.extrasJson, "extrasJson");
    const id = `period:${ctx.payload.period}`;
    const rec = {
      id, period: ctx.payload.period, extrasJson: ctx.payload.extrasJson,
      updatedAt: ctx.now, updatedBy: ctx.actor.userId, schemaVersion: 1,
    };
    const existing = await ctx.tx.get("uiPeriods", id);
    if (existing) ctx.tx.update("uiPeriods", id, rec);
    else ctx.tx.create("uiPeriods", id, { ...rec, ...base(ctx) });
    audit(ctx, "period_extras_saved", "uiPeriod", id);
    return { period: ctx.payload.period };
  },
};

/* shared receipt creation for cash and bank */
async function createReceipt(ctx, extra) {
  const ob = await ctx.tx.get("obligations", ctx.payload.obligationId);
  if (!ob) throw new DomainError("OBLIGATION_NOT_FOUND");
  if (ob.state !== "active") throw new DomainError("OBLIGATION_NOT_ACTIVE");
  await assertEmployeePeriodOpen(ctx, ob.period);

  const siblings = await ctx.tx.query("receipts", [["obligationId", "==", ob.id]]);

  // D2: overpayment is refused with the exact figures. Pending bank receipts are counted
  // as claims on the remainder so two submissions cannot together exceed the obligation.
  const claiming = siblings.filter(
    (r) => r.state === RECEIPT_STATE.RECOGNIZED || r.state === RECEIPT_STATE.PENDING
  ).map((r) => ({ ...r, state: RECEIPT_STATE.RECOGNIZED }));
  assertReceiptFits({
    obligation: ob, receipts: claiming,
    amountFils: ctx.payload.amountFils, asOfDate: ctx.payload.collectionDate,
  });

  const id = newId("rcpt", ctx);
  ctx.tx.create("receipts", id, {
    id, obligationId: ob.id, rentalId: ob.rentalId, propertyId: ob.propertyId,
    unitId: ob.unitId, spaceId: ob.spaceId, period: ob.period,
    tenantNameSnapshot: ob.tenantNameSnapshot,
    amountFils: ctx.payload.amountFils,
    collectionDate: ctx.payload.collectionDate,
    note: ctx.payload.note || null,
    ...extra, ...base(ctx),
  });
  audit(ctx, extra.method === "cash" ? "cash_receipt_created" : "bank_receipt_submitted", "receipt", id, {
    amountFils: ctx.payload.amountFils, obligationId: ob.id, method: extra.method,
  });
  return { receiptId: id, state: extra.state, method: extra.method };
}

export { HANDLERS };

async function collectorFor(ctx) {
  // Employees cannot forge collector identity. Only the owner may attribute a receipt
  // to an employee (the old approve-request path).
  if (ctx.actor.role === "owner" && ctx.payload.collectorUserId) {
    const user = await ctx.tx.get("users", ctx.payload.collectorUserId);
    if (user && user.active !== false) return user.id;
  }
  return ctx.actor.userId;
}

async function depositEmployeeFor(ctx) {
  if (ctx.actor.role === "owner" && ctx.payload.employeeId) {
    const user = await ctx.tx.get("users", ctx.payload.employeeId);
    if (user && user.active !== false) return user.id;
  }
  return ctx.actor.userId;
}

function actorKey(actor) {
  const id = String(actor.userId || "");
  if (id.includes("nader")) return "nader";
  if (id.includes("yahia")) return "yahia";
  return "saeed";
}

function parseJsonField(value, field) {
  try { JSON.parse(value); }
  catch { throw new DomainError("INVALID_FIELD", { field, why: "not json" }); }
}

/** One pending card per employee+entity+month. Prevents duplicate Manager requests. */
function pendingRequestLockId({ type, actorKey: who, year, month, payload }) {
  const y = Number(year);
  const m = Number(month);
  if (!who || !Number.isFinite(y) || !Number.isFinite(m)) return null;
  const safe = (v) => String(v || "").replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80);
  if (type === "update_partition") {
    return `lock:updpart:${safe(who)}:${y}:${m}:${safe(payload.unitId)}:${safe(payload.partId)}`;
  }
  if (type === "update_full") {
    return `lock:updfull:${safe(who)}:${y}:${m}:${safe(payload.unitId)}`;
  }
  if (type === "add_transaction") {
    const tx = payload.transaction || {};
    // Prefer depositId when present — exact canonical identity.
    if (tx.depositId || payload.depositId) {
      return `lock:dep:${safe(tx.depositId || payload.depositId)}`;
    }
    return `lock:depamt:${safe(who)}:${y}:${m}:${safe(tx.amount)}:${safe(tx.date)}:${safe(tx.desc)}`;
  }
  return null;
}

/** Employees cannot mutate a month the owner locked in uiConfig/locks. */
async function assertEmployeePeriodOpen(ctx, period) {
  if (!period || ctx.actor.role === "owner") return;
  const locksDoc = await ctx.tx.get("uiConfig", "locks");
  if (!locksDoc) return;
  let data = {};
  try { data = JSON.parse(locksDoc.json || "{}"); } catch { data = {}; }
  if (data && data.data && typeof data.data === "object") data = { ...data, ...data.data };
  const [y, m] = String(period).split("-").map(Number);
  if (!y || !m) return;
  const key = `${y}_${m - 1}`;
  if (data[key]) throw new DomainError("MONTH_LOCKED", { period });
}
