const ALLOWED = Object.freeze({
  partition: new Set(["note", "phone"]),
  full: new Set(["note", "phone"]),
  unit: new Set(["name", "type", "color"]),
});

const RENTAL_FIELDS = Object.freeze(new Set([
  "rent", "status", "tenant", "phone", "note", "deposit",
  "start_date", "end_date", "due_date", "contract_end", "cycle_anchor", "cycle_i",
  "rent_type", "elec_amount", "elec_paid",
]));

// Display/lifecycle occupancy — NOT a financial collection event.
const OCCUPANCY_STATUSES = Object.freeze(new Set(["vacant", "staff", "late", "pending", "expired"]));

const FORBIDDEN_FINANCIAL = Object.freeze(new Set([
  "paid_amount", "partial", "collectionMethod", "collectedBy", "collectedAt",
  "target", "remaining", "collected", "deposited", "cashLots", "transactions",
  "expenses", "ledger", "balances", "discount",
]));

const BUSINESS_REQUEST_TYPES = Object.freeze(new Set([
  "update_partition", "update_full", "transfer_tenant",
  "add_partition", "delete_partition", "add_unit", "delete_unit", "delete_full",
]));

function cleanString(value, max) {
  if (typeof value !== "string") throw new Error("OPERATIONAL_VALUE_INVALID");
  const result = value.trim();
  if (result.length > max) throw new Error("OPERATIONAL_VALUE_TOO_LONG");
  return result;
}

function validatePatch(entityType, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("OPERATIONAL_PATCH_REQUIRED");
  const keys = Object.keys(patch);
  if (!keys.length) throw new Error("OPERATIONAL_PATCH_EMPTY");
  const allowed = ALLOWED[entityType];
  if (!allowed) throw new Error("OPERATIONAL_ENTITY_TYPE_INVALID");
  if (keys.some((key) => FORBIDDEN_FINANCIAL.has(key) || !allowed.has(key))) throw new Error("OPERATIONAL_FIELD_DENIED");
  const out = {};
  for (const key of keys) {
    if (key === "note") out[key] = cleanString(patch[key], 1000);
    else if (key === "phone") out[key] = cleanString(patch[key], 40);
    else if (key === "name") out[key] = cleanString(patch[key], 120);
    else if (key === "type") out[key] = cleanString(patch[key], 40);
    else if (key === "color") {
      if (typeof patch[key] !== "string" || !/^#[0-9a-fA-F]{6}$/.test(patch[key])) throw new Error("OPERATIONAL_COLOR_INVALID");
      out[key] = patch[key];
    }
  }
  return out;
}

function validateRentalPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("OPERATIONAL_PATCH_REQUIRED");
  const keys = Object.keys(patch);
  if (!keys.length) throw new Error("OPERATIONAL_PATCH_EMPTY");
  if (keys.some((key) => FORBIDDEN_FINANCIAL.has(key) || !RENTAL_FIELDS.has(key))) throw new Error("OPERATIONAL_FIELD_DENIED");
  const out = {};
  for (const key of keys) {
    const value = patch[key];
    if (key === "status") {
      const st = String(value || "");
      if (st === "collected" || st === "partial") throw new Error("COLLECTION_REQUIRES_FINANCIAL_COMMAND");
      if (!OCCUPANCY_STATUSES.has(st)) throw new Error("OCCUPANCY_STATUS_INVALID");
      out[key] = st;
    } else if (key === "rent" || key === "deposit" || key === "elec_amount") {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) throw new Error("OPERATIONAL_VALUE_INVALID");
      out[key] = n;
    } else if (key === "elec_paid") {
      out[key] = !!value;
    } else if (key === "cycle_i") {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) throw new Error("OPERATIONAL_VALUE_INVALID");
      out[key] = n;
    } else if (typeof value === "string") {
      out[key] = cleanString(value, key === "note" ? 1000 : 200);
    } else if (value == null) {
      out[key] = "";
    } else {
      throw new Error("OPERATIONAL_VALUE_INVALID");
    }
  }
  return out;
}

function locate(data, target) {
  if (target.entityType === "full") {
    const entity = (data.full || []).find((item) => String(item.id) === String(target.entityId));
    if (!entity) throw new Error("OPERATIONAL_ENTITY_NOT_FOUND");
    return entity;
  }
  const unit = (data.units || []).find((item) => String(item.id) === String(target.unitId || target.entityId));
  if (!unit) throw new Error("OPERATIONAL_ENTITY_NOT_FOUND");
  if (target.entityType === "unit") return unit;
  const entity = (unit.partitions || []).find((item) => String(item.id) === String(target.entityId));
  if (!entity) throw new Error("OPERATIONAL_ENTITY_NOT_FOUND");
  return entity;
}

export function applyOperationalPatch(monthDocument, payload, actor) {
  if (!actor || !["owner", "manager"].includes(actor.role)) throw new Error("MANAGER_REQUIRED");
  const target = payload?.target || {};
  const patch = validatePatch(String(target.entityType || ""), payload?.patch);
  const data = structuredClone(monthDocument?.data || {});
  const entity = locate(data, target);
  const currentVersion = Number(entity.operationalVersion ?? entity.version ?? 0);
  if (!Number.isInteger(payload.baseVersion) || payload.baseVersion !== currentVersion) throw new Error("STALE_OPERATIONAL_ENTITY");
  const before = Object.fromEntries(Object.keys(patch).map((key) => [key, entity[key] ?? null]));
  Object.assign(entity, patch, { operationalVersion: currentVersion + 1 });
  return { data, before, after: patch, version: currentVersion + 1, target };
}

export function applyOwnerRentalPatch(monthDocument, payload, actor) {
  if (!actor || !["owner", "manager"].includes(actor.role)) throw new Error("MANAGER_REQUIRED");
  const target = payload?.target || {};
  const entityType = String(target.entityType || "");
  if (!["partition", "full"].includes(entityType)) throw new Error("OPERATIONAL_ENTITY_TYPE_INVALID");
  const patch = validateRentalPatch(payload?.patch);
  const data = structuredClone(monthDocument?.data || {});
  const entity = locate(data, { ...target, entityType });
  const currentVersion = Number(entity.operationalVersion ?? entity.version ?? 0);
  if (payload.baseVersion != null && Number(payload.baseVersion) !== currentVersion) throw new Error("STALE_OPERATIONAL_ENTITY");
  const before = Object.fromEntries(Object.keys(patch).map((key) => [key, entity[key] ?? null]));
  Object.assign(entity, patch, {
    operationalVersion: currentVersion + 1,
    version: Number(entity.version || 0) + 1,
  });
  return { data, before, after: patch, version: currentVersion + 1, target: { ...target, entityType }, financialEffectFils: 0 };
}

function applyBusinessPayloadToMonth(data, type, payload) {
  if (type === "update_partition") {
    const unit = (data.units || []).find((u) => String(u.id) === String(payload.unitId));
    if (!unit) throw new Error("OPERATIONAL_ENTITY_NOT_FOUND");
    const part = (unit.partitions || []).find((p) => String(p.id) === String(payload.partId));
    if (!part) throw new Error("OPERATIONAL_ENTITY_NOT_FOUND");
    const fields = validateRentalPatch(payload.fields || {});
    Object.assign(part, fields, { version: Number(part.version || 0) + 1, operationalVersion: Number(part.operationalVersion || 0) + 1 });
    return { target: { entityType: "partition", unitId: unit.id, entityId: part.id } };
  }
  if (type === "update_full") {
    const unit = (data.full || []).find((u) => String(u.id) === String(payload.unitId));
    if (!unit) throw new Error("OPERATIONAL_ENTITY_NOT_FOUND");
    const fields = validateRentalPatch(payload.fields || {});
    Object.assign(unit, fields, { version: Number(unit.version || 0) + 1, operationalVersion: Number(unit.operationalVersion || 0) + 1 });
    return { target: { entityType: "full", entityId: unit.id } };
  }
  if (type === "add_partition") {
    const unit = (data.units || []).find((u) => String(u.id) === String(payload.unitId));
    if (!unit) throw new Error("OPERATIONAL_ENTITY_NOT_FOUND");
    const part = payload.part;
    if (!part || part.id == null) throw new Error("OPERATIONAL_VALUE_INVALID");
    if ((unit.partitions || []).some((p) => String(p.id) === String(part.id))) throw new Error("PARTITION_EXISTS");
    unit.partitions = unit.partitions || [];
    unit.partitions.push({ ...part, status: part.status || "vacant", version: 0, operationalVersion: 0 });
    return { target: { entityType: "partition", unitId: unit.id, entityId: part.id } };
  }
  if (type === "delete_partition") {
    const unit = (data.units || []).find((u) => String(u.id) === String(payload.unitId));
    if (!unit) throw new Error("OPERATIONAL_ENTITY_NOT_FOUND");
    const idx = (unit.partitions || []).findIndex((p) => String(p.id) === String(payload.partId));
    if (idx < 0) throw new Error("OPERATIONAL_ENTITY_NOT_FOUND");
    unit.partitions.splice(idx, 1);
    return { target: { entityType: "partition", unitId: unit.id, entityId: payload.partId } };
  }
  if (type === "add_unit") {
    const unit = payload.unit;
    if (!unit || unit.id == null) throw new Error("OPERATIONAL_VALUE_INVALID");
    data.units = data.units || [];
    if (data.units.some((u) => String(u.id) === String(unit.id))) throw new Error("UNIT_EXISTS");
    data.units.push(unit);
    return { target: { entityType: "unit", entityId: unit.id } };
  }
  if (type === "delete_unit") {
    const idx = (data.units || []).findIndex((u) => String(u.id) === String(payload.unitId));
    if (idx < 0) throw new Error("OPERATIONAL_ENTITY_NOT_FOUND");
    data.units.splice(idx, 1);
    return { target: { entityType: "unit", entityId: payload.unitId } };
  }
  if (type === "delete_full") {
    const idx = (data.full || []).findIndex((u) => String(u.id) === String(payload.unitId));
    if (idx < 0) throw new Error("OPERATIONAL_ENTITY_NOT_FOUND");
    data.full.splice(idx, 1);
    return { target: { entityType: "full", entityId: payload.unitId } };
  }
  if (type === "transfer_tenant") {
    const srcUnit = (data.units || []).find((u) => String(u.id) === String(payload.fromUnitId));
    const dstUnit = (data.units || []).find((u) => String(u.id) === String(payload.toUnitId));
    if (!srcUnit || !dstUnit) throw new Error("OPERATIONAL_ENTITY_NOT_FOUND");
    const src = (srcUnit.partitions || []).find((p) => String(p.id) === String(payload.fromPartId));
    const dst = (dstUnit.partitions || []).find((p) => String(p.id) === String(payload.toPartId));
    if (!src || !dst) throw new Error("OPERATIONAL_ENTITY_NOT_FOUND");
    if (!["vacant", "staff"].includes(String(dst.status || ""))) throw new Error("TARGET_OCCUPIED");
    const moveKeys = ["tenant", "phone", "deposit", "note", "start_date", "due_date", "contract_end", "status", "rent", "elec_paid", "elec_amount", "lastRenewedKey"];
    for (const key of moveKeys) {
      if (payload.fields && Object.prototype.hasOwnProperty.call(payload.fields, key)) dst[key] = payload.fields[key];
      else if (src[key] !== undefined) dst[key] = src[key];
    }
    Object.assign(src, { tenant: "", phone: "", status: "vacant", paid_amount: 0, partial: false, collectedBy: "", note: "" });
    return { target: { entityType: "partition", unitId: dstUnit.id, entityId: dst.id } };
  }
  throw new Error("REQUEST_TYPE_UNSUPPORTED");
}

export function applyApprovedBusinessRequest(monthDocument, request, actor) {
  if (!actor || !["owner", "manager"].includes(actor.role)) throw new Error("MANAGER_REQUIRED");
  const type = String(request.type || "");
  if (!BUSINESS_REQUEST_TYPES.has(type)) throw new Error("REQUEST_TYPE_UNSUPPORTED");
  const data = structuredClone(monthDocument?.data || {});
  const applied = applyBusinessPayloadToMonth(data, type, request.payload || {});
  return { data, target: applied.target, financialEffectFils: 0 };
}

export function assertBusinessRequestType(type) {
  if (!BUSINESS_REQUEST_TYPES.has(String(type || ""))) throw new Error("REQUEST_TYPE_UNSUPPORTED");
  return String(type);
}

export const operationalAllowedFields = (entityType) => [...(ALLOWED[entityType] || [])];
export const businessRequestTypes = [...BUSINESS_REQUEST_TYPES];
