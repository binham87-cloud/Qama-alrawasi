const ALLOWED = Object.freeze({
  partition: new Set(["note", "phone"]),
  full: new Set(["note", "phone"]),
  unit: new Set(["name", "type", "color"]),
});

const FORBIDDEN_FINANCIAL = new Set([
  "rent", "status", "paid_amount", "partial", "collectionMethod", "deposit",
  "start_date", "end_date", "due_date", "contract_end", "cycle_anchor", "cycle_i",
  "target", "remaining", "collected", "deposited", "cashLots", "transactions",
  "expenses", "ledger", "balances", "discount", "elec_amount", "elec_paid",
]);

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

export const operationalAllowedFields = (entityType) => [...(ALLOWED[entityType] || [])];
