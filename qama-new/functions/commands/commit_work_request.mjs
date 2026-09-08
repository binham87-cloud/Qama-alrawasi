/**
 * Owner approval of an old-UI work request.
 *
 * Runs as a sequence of real commands (separate transactions) so each step sees
 * committed state. Sub-operation ids are derived from the request id, so retry
 * after a crash is idempotent. The request is marked approved only after every
 * step succeeds. On failure it returns to pending with lastError — never left
 * permanently in "processing".
 */
import { DomainError, parseAedToFils, periodOf, obligationIdFor, isPlaceholderTenant } from "../domain/finance.mjs";

const STEP = (requestId, name) => (`cwr-${requestId}-${name}`).slice(0, 140);

export async function commitWorkRequestFlow({ db, actor, payload, operationId, now, run }) {
  const requestId = payload.requestId;
  const req = await readDoc(db, "uiRequests", requestId);
  if (!req) throw new DomainError("REQUEST_NOT_FOUND", { requestId });
  if (req.status === "approved") {
    await rememberOperation(db, { operationId, command: "commitWorkRequest", actor, now, result: { requestId, status: "approved", alreadyApplied: true } });
    return { requestId, status: "approved", alreadyApplied: true, replay: false };
  }
  if (req.status === "rejected") throw new DomainError("REQUEST_NOT_PENDING", { status: req.status });

  const body = parseJson(req.payloadJson, req.payload);
  const period = periodOfRequest(req);
  const collectorUserId = req.by || actor.userId;
  const snap = await loadSnapshot(db);

  try {
    await dispatchRequest({
      db, actor, now, run, req, body, period, collectorUserId, snap, requestId,
    });
    await markRequest(db, actor, requestId, now, "approved", null);
    const result = { requestId, status: "approved", alreadyApplied: false };
    await rememberOperation(db, { operationId, command: "commitWorkRequest", actor, now, result });
    return { ...result, replay: false };
  } catch (err) {
    try {
      await markRequest(db, actor, requestId, now, "pending", err.code || err.message || "FAILED");
    } catch { /* still throw the original */ }
    throw err;
  }
}

async function dispatchRequest(ctx) {
  const type = String(ctx.req.type || "");
  if (type === "update_partition" || type === "update_full") {
    await applySpaceFields(ctx, ctx.body);
    return;
  }
  if (type === "delete_partition" || type === "delete_full") {
    await deleteSpaceOrUnit(ctx, type === "delete_full");
    return;
  }
  if (type === "add_unit") {
    await addPartitionedUnit(ctx, ctx.body.unit || ctx.body);
    return;
  }
  if (type === "add_full_unit") {
    await addWholeUnit(ctx, ctx.body.unit || ctx.body);
    return;
  }
  if (type === "add_expense") {
    await addExpense(ctx, ctx.body.expense || ctx.body);
    return;
  }
  if (type === "add_transaction") {
    await addDeposit(ctx, {
      ...(ctx.body.transaction || ctx.body),
      depositId: ctx.body.depositId || (ctx.body.transaction && ctx.body.transaction.depositId),
    });
    return;
  }
  if (type === "add_daily") {
    await mergeExtrasArray(ctx, "dailyBookings", { ...(ctx.body.booking || ctx.body), id: ctx.requestId });
    return;
  }
  if (type === "add_unit_maintenance") {
    await addMaintenance(ctx, "unitMaintenance", ctx.body.maintenance || ctx.body);
    return;
  }
  if (type === "add_facility_maintenance") {
    await addMaintenance(ctx, "facilityMaintenance", ctx.body.maintenance || ctx.body);
    return;
  }
  throw new DomainError("UNKNOWN_REQUEST_TYPE", { type });
}

async function applySpaceFields(ctx, payload) {
  const fields = payload.fields || payload;
  const space = resolveSpace(ctx.snap, payload);
  if (!space) throw new DomainError("SPACE_NOT_FOUND");
  await patchSpaceExtras(ctx, space.id, fields);

  const status = fields.status;
  const occ = status === "staff" ? "staff" : status === "vacant" ? "vacant" : "rented";
  let rental = ctx.snap.rentals.find((r) => r.spaceId === space.id && r.state === "active") || null;

  if (occ === "vacant" || occ === "staff") {
    if (rental) {
      await ctx.run(ctx.actor, "closeRental", {
        rentalId: rental.id,
        endDate: ctx.now.slice(0, 10),
        reason: "طلب معتمد — تغيير الحالة",
        setVacant: occ === "vacant",
      }, STEP(ctx.requestId, "close"));
      rental = null;
    }
    await ctx.run(ctx.actor, "setSpaceOccupancy", { spaceId: space.id, occupancy: occ }, STEP(ctx.requestId, "occ"));
    return;
  }

  // Vacant → rented: create rental with the full payload BEFORE occupancy.
  // setSpaceOccupancy(rented) first left partial rented-with-no-tenant state when
  // TENANT_REQUIRED fired — matching the live iPhone failure.
  const rentFils = moneyFils(fields.rent);
  if (!rental && rentFils > 0) {
    if (isPlaceholderTenant(fields.tenant)) {
      throw new DomainError("TENANT_REQUIRED", { tenant: fields.tenant });
    }
    const start = validDate(fields.start_date) || ctx.now.slice(0, 10);
    const dueDay = clampDay(start);
    const created = await ctx.run(ctx.actor, "createRental", {
      spaceId: space.id,
      tenantName: String(fields.tenant).trim().slice(0, 160),
      ...(fields.phone ? { tenantPhone: String(fields.phone).slice(0, 40) } : {}),
      contractualAmountFils: rentFils,
      dueDayOfMonth: dueDay,
      startDate: start,
    }, STEP(ctx.requestId, "rental"));
    rental = { id: created.rentalId, spaceId: space.id };
    await ctx.run(ctx.actor, "generateObligations", { period: ctx.period }, STEP(ctx.requestId, "genobl"));
  } else if (!rental && rentFils <= 0) {
    // Do not mark occupancy rented without a contractual rental.
    return;
  } else if (rental) {
    if (fields.tenant || fields.phone) {
      const patch = { rentalId: rental.id };
      if (fields.tenant) patch.tenantName = String(fields.tenant).slice(0, 160);
      if (fields.phone) patch.tenantPhone = String(fields.phone).slice(0, 40);
      try {
        await ctx.run(ctx.actor, "updateRentalTenant", patch, STEP(ctx.requestId, "tenant"));
      } catch (e) {
        if (e.code !== "NOTHING_TO_UPDATE") throw e;
      }
    }
    if (rentFils > 0) {
      await ctx.run(ctx.actor, "updateRentalRent", {
        rentalId: rental.id, contractualAmountFils: rentFils,
      }, STEP(ctx.requestId, "rent"));
    }
    // Contract start = first due day. Changing start must never leave +1-month leftovers.
    if (validDate(fields.start_date)) {
      try {
        await ctx.run(ctx.actor, "updateRentalSchedule", {
          rentalId: rental.id,
          startDate: fields.start_date,
        }, STEP(ctx.requestId, "sched"));
      } catch (e) {
        if (e.code !== "NOTHING_TO_UPDATE") throw e;
      }
    }
  }

  // createRental sets occupancy=rented; ensure for pre-existing rentals too.
  if (rental) {
    try {
      await ctx.run(ctx.actor, "setSpaceOccupancy", { spaceId: space.id, occupancy: "rented" }, STEP(ctx.requestId, "occ"));
    } catch (e) {
      if (e.code !== "NOTHING_TO_UPDATE") throw e;
    }
  }
  const obligationId = fields._obligationId
    || (rental ? obligationIdFor(rental.id, ctx.period) : null);
  if (!obligationId) return;
  const ob = await readDoc(ctx.db, "obligations", obligationId);
  if (!ob) return;

  const wantPaid = fields.partial ? moneyFils(fields.paid_amount) : (status === "collected" ? (ob.amountFils || 0) : 0);
  // OLD UI keeps paid_amount when switching محصّل → متأخر. Treat non-partial late as unpaid.
  const unpaidIntent = (status === "late" || status === "pending") && (!fields.partial || wantPaid === 0);
  if (unpaidIntent) {
    await ctx.run(ctx.actor, "uncollectObligation", {
      obligationId: ob.id, reason: "طلب معتمد — متأخر",
    }, STEP(ctx.requestId, "uncol"));
    return;
  }
  if (status !== "collected" && !fields.partial) return;

  const paidNow = await recognizedPaid(ctx.db, ob.id);
  const delta = wantPaid - paidNow;
  if (delta <= 0) return;
  const date = validDate(fields.due_date) || validDate(fields.start_date) || ctx.now.slice(0, 10);
  const method = fields.collectionMethod === "bank" ? "bank" : "cash";
  if (method === "bank") {
    const sub = await ctx.run(ctx.actor, "submitBankReceipt", {
      obligationId: ob.id, amountFils: delta, collectionDate: date,
      bankReference: ("طلب-" + ctx.requestId).slice(0, 120),
      collectorUserId: ctx.collectorUserId,
    }, STEP(ctx.requestId, "bank"));
    if (sub.receiptId) {
      await ctx.run(ctx.actor, "approveBankReceipt", { receiptId: sub.receiptId }, STEP(ctx.requestId, "bankap"));
    }
  } else {
    await ctx.run(ctx.actor, "createCashReceipt", {
      obligationId: ob.id, amountFils: delta, collectionDate: date,
      collectorUserId: ctx.collectorUserId,
    }, STEP(ctx.requestId, "cash"));
  }
}

async function deleteSpaceOrUnit(ctx, whole) {
  const space = resolveSpace(ctx.snap, ctx.body);
  if (!space) throw new DomainError("SPACE_NOT_FOUND");
  const rental = ctx.snap.rentals.find((r) => r.spaceId === space.id && r.state === "active");
  if (rental) {
    await ctx.run(ctx.actor, "closeRental", {
      rentalId: rental.id, endDate: ctx.now.slice(0, 10),
      reason: "طلب معتمد — حذف", setVacant: true,
    }, STEP(ctx.requestId, "close"));
  }
  await ctx.run(ctx.actor, "updateSpace", { spaceId: space.id, active: false }, STEP(ctx.requestId, "delsp"));
  if (whole) {
    await ctx.run(ctx.actor, "updateUnit", { unitId: space.unitId, active: false }, STEP(ctx.requestId, "delun"));
  }
}

async function addPartitionedUnit(ctx, unit) {
  const prop = ctx.snap.properties.find((p) => p.active !== false) || ctx.snap.properties[0];
  if (!prop) throw new DomainError("PROPERTY_NOT_FOUND");
  const created = await ctx.run(ctx.actor, "createUnit", {
    propertyId: prop.id, name: String(unit.name || "شقة").slice(0, 120), kind: "partitioned",
  }, STEP(ctx.requestId, "unit"));
  const parts = Array.isArray(unit.partitions) && unit.partitions.length ? unit.partitions : [{ id: 1 }];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    await ctx.run(ctx.actor, "createSpace", {
      unitId: created.unitId, name: `${unit.name || "شقة"} / ${p.id ?? i + 1}`,
    }, STEP(ctx.requestId, "sp" + i));
  }
}

async function addWholeUnit(ctx, unit) {
  const prop = ctx.snap.properties.find((p) => p.active !== false) || ctx.snap.properties[0];
  if (!prop) throw new DomainError("PROPERTY_NOT_FOUND");
  const name = String(unit.id || unit.name || "شقة").slice(0, 120);
  const created = await ctx.run(ctx.actor, "createUnit", {
    propertyId: prop.id, name, kind: "whole",
  }, STEP(ctx.requestId, "unit"));
  const sp = await ctx.run(ctx.actor, "createSpace", {
    unitId: created.unitId, name,
  }, STEP(ctx.requestId, "sp"));
  const rentFils = moneyFils(unit.rent);
  if (rentFils > 0 && !isPlaceholderTenant(unit.tenant) && (unit.status === "late" || unit.status === "collected" || unit.status === "pending" || unit.tenant)) {
    const start = validDate(unit.start_date) || ctx.now.slice(0, 10);
    await ctx.run(ctx.actor, "createRental", {
      spaceId: sp.spaceId,
      tenantName: String(unit.tenant).trim().slice(0, 160),
      contractualAmountFils: rentFils,
      dueDayOfMonth: clampDay(start),
      startDate: start,
    }, STEP(ctx.requestId, "rental"));
    await ctx.run(ctx.actor, "generateObligations", { period: ctx.period }, STEP(ctx.requestId, "genobl"));
  }
}

async function addExpense(ctx, expense) {
  const acc = pickAccount(ctx.snap.accounts);
  if (!acc) throw new DomainError("ACCOUNT_NOT_FOUND");
  const fils = moneyFils(expense.amount);
  if (fils <= 0) throw new DomainError("INVALID_AMOUNT", { amount: expense.amount });
  const requestedBy = ctx.req.by || ctx.collectorUserId || null;
  await ctx.run(ctx.actor, "submitExpense", {
    amountFils: fils,
    reason: String(expense.desc || expense.reason || "مصروف").slice(0, 300),
    category: String(expense.category || "عام").slice(0, 60),
    expenseDate: validDate(expense.date) || ctx.now.slice(0, 10),
    paidFromAccountId: acc.id,
    ...(requestedBy ? { requestedBy } : {}),
  }, STEP(ctx.requestId, "exp"));
}

async function addDeposit(ctx, tx) {
  const acc = pickAccount(ctx.snap.accounts);
  if (!acc) throw new DomainError("ACCOUNT_NOT_FOUND");
  // Prefer approving an already-submitted pending deposit (employee created it on send).
  const existingId = tx.depositId || tx._depositId || null;
  if (existingId) {
    const dep = await readDoc(ctx.db, "deposits", existingId);
    if (!dep) throw new DomainError("DEPOSIT_NOT_FOUND", { depositId: existingId });
    if (dep.state === "approved") return { depositId: existingId, state: "approved", alreadyApplied: true };
    if (dep.state === "pending") {
      await ctx.run(ctx.actor, "approveDeposit", { depositId: existingId }, STEP(ctx.requestId, "depap"));
      return { depositId: existingId, state: "approved" };
    }
    throw new DomainError("DEPOSIT_NOT_PENDING", { state: dep.state, depositId: existingId });
  }

  const fils = moneyFils(tx.amount);
  if (fils <= 0) throw new DomainError("INVALID_AMOUNT", { amount: tx.amount });
  const submitted = await ctx.run(ctx.actor, "submitDeposit", {
    amountFils: fils,
    depositDate: validDate(tx.date) || ctx.now.slice(0, 10),
    destinationAccountId: acc.id,
    note: String(tx.desc || tx.notes || "إيداع").slice(0, 300),
    reference: String(tx.desc || ctx.requestId).slice(0, 120),
    employeeId: ctx.collectorUserId,
  }, STEP(ctx.requestId, "dep"));
  // Owner submitDeposit auto-approves; employee-attributed submit stays pending until approve.
  if (submitted.state === "pending" && submitted.depositId) {
    await ctx.run(ctx.actor, "approveDeposit", { depositId: submitted.depositId }, STEP(ctx.requestId, "depap"));
  }
  return submitted;
}

async function addMaintenance(ctx, key, row) {
  const fils = moneyFils(row.amount);
  let expenseId = row._expenseId || row._engineId || null;
  if (fils > 0 && !expenseId) {
    const acc = pickAccount(ctx.snap.accounts);
    if (!acc) throw new DomainError("ACCOUNT_NOT_FOUND");
    const submitted = await ctx.run(ctx.actor, "submitExpense", {
      amountFils: fils,
      reason: String(row.desc || row.description || "صيانة").slice(0, 300),
      category: "صيانة",
      expenseDate: validDate(row.date) || ctx.now.slice(0, 10),
      paidFromAccountId: acc.id,
      maintenanceLinkId: String(ctx.requestId || row.id || "").slice(0, 120) || undefined,
    }, STEP(ctx.requestId, "mexp"));
    expenseId = submitted.expenseId || null;
  }
  await mergeExtrasArray(ctx, key, {
    ...row,
    id: ctx.requestId,
    ...(expenseId ? { _expenseId: expenseId, _engineId: expenseId } : {}),
  });
}

async function mergeExtrasArray(ctx, key, row) {
  await ctx.db.runTransaction(async (tx) => {
    const id = `period:${ctx.period}`;
    const existing = await tx.get("uiPeriods", id);
    const extras = existing ? parseJson(existing.extrasJson, existing.extras || {}) : {};
    const list = Array.isArray(extras[key]) ? extras[key] : [];
    if (!list.some((x) => x && x.id === row.id)) list.push(row);
    extras[key] = list;
    const rec = {
      id, period: ctx.period, extrasJson: JSON.stringify(extras),
      updatedAt: ctx.now, updatedBy: ctx.actor.userId, schemaVersion: 1,
    };
    if (existing) tx.update("uiPeriods", id, rec);
    else tx.create("uiPeriods", id, { ...rec, createdAt: ctx.now, createdBy: ctx.actor.userId });
  });
}

async function patchSpaceExtras(ctx, spaceId, fields) {
  await ctx.db.runTransaction(async (tx) => {
    const id = `period:${ctx.period}`;
    const existing = await tx.get("uiPeriods", id);
    const extras = existing ? parseJson(existing.extrasJson, existing.extras || {}) : {};
    extras.spaces = extras.spaces || {};
    extras.spaces[spaceId] = {
      ...(extras.spaces[spaceId] || {}),
      note: fields.note || "",
      phone: fields.phone || "",
      start_date: fields.start_date || "",
      end_date: fields.end_date || "",
      due_date: fields.due_date || "",
      deposit: fields.deposit || "",
      collectionMethod: fields.collectionMethod || "",
      collectedBy: fields.collectedBy || "",
      rent_type: fields.rent_type || "monthly",
      elec_paid: !!fields.elec_paid,
      elec_amount: Number(fields.elec_amount || 0),
      tenant: fields.tenant || "",
    };
    const rec = {
      id, period: ctx.period, extrasJson: JSON.stringify(extras),
      updatedAt: ctx.now, updatedBy: ctx.actor.userId, schemaVersion: 1,
    };
    if (existing) tx.update("uiPeriods", id, rec);
    else tx.create("uiPeriods", id, { ...rec, createdAt: ctx.now, createdBy: ctx.actor.userId });
  });
}

function resolveSpace(snap, payload) {
  const fields = payload.fields || payload.unit || payload || {};
  const spaceId = fields._spaceId || payload.spaceId;
  if (spaceId) {
    return snap.spaces.find((s) => s.id === spaceId) || null;
  }
  const unitId = fields._unitId || payload.unitId;
  const partId = payload.partId != null ? payload.partId : fields.id;
  let unit = snap.units.find((u) => u.id === unitId);
  if (!unit && unitId != null) {
    const want = String(unitId);
    unit = snap.units.find((u) => u.name === want || String(u.name).endsWith(want) || String(u.name).includes(want));
  }
  const uid = unit?.id || unitId;
  const spaces = snap.spaces.filter((s) => s.unitId === uid && s.active !== false);
  if (partId != null && spaces.length) {
    const p = String(partId);
    const hit = spaces.find((s) => {
      const n = String(s.name || "");
      return n.endsWith("/ " + p) || n.endsWith("/" + p) || n === p || n.endsWith(p);
    });
    if (hit) return hit;
  }
  if (spaces.length === 1) return spaces[0];
  return null;
}

async function recognizedPaid(db, obligationId) {
  const receipts = await db.runTransaction((tx) => tx.query("receipts", [["obligationId", "==", obligationId]]));
  return receipts
    .filter((r) => r.state === "recognized")
    .reduce((s, r) => s + Number(r.amountFils || 0), 0);
}

async function loadSnapshot(db) {
  const [spaces, units, rentals, accounts, properties] = await Promise.all([
    queryAll(db, "spaces"), queryAll(db, "units"), queryAll(db, "rentals"),
    queryAll(db, "accounts"), queryAll(db, "properties"),
  ]);
  return { spaces, units, rentals, accounts, properties };
}

function queryAll(db, collection) {
  return db.runTransaction((tx) => tx.query(collection, []));
}
function readDoc(db, collection, id) {
  return db.runTransaction((tx) => tx.get(collection, id));
}

async function markRequest(db, actor, requestId, now, status, lastError) {
  await db.runTransaction(async (tx) => {
    const doc = await tx.get("uiRequests", requestId);
    if (!doc) throw new DomainError("REQUEST_NOT_FOUND");
    if (status === "approved" && doc.status === "approved") return;
    if (doc.status === "rejected") throw new DomainError("REQUEST_NOT_PENDING", { status: doc.status });
    tx.update("uiRequests", requestId, {
      status,
      resolvedBy: actor.userId,
      resolvedAt: now,
      lastError: lastError || null,
    });
    if ((status === "approved" || status === "rejected") && doc.lockId) {
      const lock = await tx.get("uiRequests", doc.lockId);
      if (lock && lock.activeRequestId === requestId) {
        tx.update("uiRequests", doc.lockId, {
          status: "clear", activeRequestId: null, clearedAt: now,
        });
      }
    }
  });
}

async function rememberOperation(db, { operationId, command, actor, now, result }) {
  try {
    await db.runTransaction(async (tx) => {
      if (await tx.get("operations", operationId)) return;
      tx.create("operations", operationId, {
        operationId, command, payloadHash: "commit:" + operationId,
        actorUserId: actor.userId, state: "completed", result, at: now,
      });
    });
  } catch (e) {
    if (!String(e.message || e).includes("ALREADY_EXISTS")) throw e;
  }
}

function periodOfRequest(req) {
  const y = Number(req.year);
  const m = Number(req.month) + 1;
  if (!y || !m) return periodOf(new Date().toISOString().slice(0, 10));
  return `${y}-${String(m).padStart(2, "0")}`;
}
function parseJson(raw, fallback) {
  if (raw && typeof raw === "object") return raw;
  try { return JSON.parse(raw || "null") ?? fallback ?? {}; }
  catch { return fallback ?? {}; }
}
function moneyFils(v) {
  if (v == null || v === "") return 0;
  const n = parseAedToFils(v);
  return n == null ? 0 : n;
}
function validDate(v) {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}
function clampDay(iso) {
  const d = Number(String(iso || "").slice(8, 10)) || 1;
  return Math.min(31, Math.max(1, d));
}
function pickAccount(accounts) {
  const live = (accounts || []).filter((a) => a.active !== false);
  return live.find((a) => a.kind === "bank") || live[0] || null;
}
