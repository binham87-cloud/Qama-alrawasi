#!/usr/bin/env node
/**
 * READ-ONLY against legacy qama-alrawasi.
 * Writes ONLY to qama-new-prod-2026 (or --dry-run).
 *
 * Deterministic IDs: mig:<entity>:<legacyId>
 * Does NOT copy paid_amount / status / holding as financial truth.
 * Collection events → receipts; cycle baseAmountFils → frozen obligations.
 */
import { createHash, randomBytes, scryptSync } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { initializeApp, getApps, applicationDefault, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d = null) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};

const SOURCE_PROJECT = opt("--source", "qama-alrawasi");
const TARGET_PROJECT = opt("--target", "qama-new-prod-2026");
const EXPORT_DIR = resolve(opt("--export-dir", ""));
const REPORT_DIR = resolve(opt("--report-dir", "./migration-report"));
const DRY = flag("--dry-run");
const APPLY = flag("--apply");
const PINS_FILE = resolve(opt("--pins-out", `${REPORT_DIR}/NEW-PINS.secret.json`));

if (!EXPORT_DIR || !existsSync(EXPORT_DIR)) {
  console.error("Require --export-dir pointing at live REST export (col-*.json)");
  process.exit(1);
}
if (!DRY && !APPLY) {
  console.error("Pass --dry-run or --apply");
  process.exit(1);
}

const nowIso = () => new Date().toISOString();
const migId = (kind, legacyId) => {
  const safe = String(legacyId).replace(/[^A-Za-z0-9_:.-]/g, "_").slice(0, 100);
  return `mig:${kind}:${safe}`;
};
const sha = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 16);

function loadCol(name) {
  const p = resolve(EXPORT_DIR, `col-${name}.json`);
  if (!existsSync(p)) return [];
  const j = JSON.parse(readFileSync(p, "utf8"));
  return (j.documents || []).map((d) => ({ id: d.id, ...(d.data || {}) }));
}

function reportingToPeriod(rm) {
  // "2026_08" → "2026-08"; also accept "2026-08"
  if (!rm) return null;
  const m = String(rm).match(/^(\d{4})[_-](\d{1,2})$/);
  if (!m) return null;
  return `${m[1]}-${String(m[2]).padStart(2, "0")}`;
}

function aedToFils(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function hashPin(pin) {
  const salt = randomBytes(16).toString("hex");
  const pinHash = scryptSync(String(pin), salt, 64).toString("hex");
  return { pinHash, pinSalt: salt };
}

function genPin() {
  // 6-digit numeric PIN for phone UX; not a demo constant
  return String(100000 + Math.floor(Math.random() * 900000));
}

const report = {
  generatedAt: nowIso(),
  sourceProject: SOURCE_PROJECT,
  targetProject: TARGET_PROJECT,
  mode: DRY ? "dry-run" : "apply",
  oldDocumentCounts: {},
  selected: {},
  skipped: [],
  unverified: [],
  validationIssues: [],
  mapped: {
    properties: [],
    units: [],
    spaces: [],
    rentals: [],
    obligations: [],
    receipts: [],
    deposits: [],
    expenses: [],
    accounts: [],
    users: [],
  },
};

const properties = loadCol("properties");
const units = loadCol("units");
const spaces = loadCol("rentableSpaces");
const tenants = loadCol("tenants");
const tenancies = loadCol("tenancies");
const cycles = loadCol("rentalCycles");
const collectionEvents = loadCol("collectionEvents");
const payments = loadCol("payments");
const deposits = loadCol("deposits");
const expenses = loadCol("expenses");
const users = loadCol("users");
const months = loadCol("months");
const accountsLegacy = loadCol("accountBalances");

for (const [k, arr] of Object.entries({
  properties, units, rentableSpaces: spaces, tenants, tenancies, rentalCycles: cycles,
  collectionEvents, payments, deposits, expenses, users, months, accountBalances: accountsLegacy,
})) {
  report.oldDocumentCounts[k] = arr.length;
}

const tenantById = new Map(tenants.map((t) => [t.id, t]));
const spaceById = new Map(spaces.map((s) => [s.id, s]));
const unitById = new Map(units.map((u) => [u.id, u]));

// Index spaces by legacy structural identity for clean-gen cycles
const spaceByLegacyKey = new Map();
for (const s of spaces) {
  const meta = s.metadata || {};
  const legacyId = meta.legacyStructuralId || meta.legacyPartitionId;
  const unitLegacy = unitById.get(s.unitId)?.metadata?.legacyStructuralId;
  if (s.sourceReference) spaceByLegacyKey.set(s.sourceReference, s);
  if (legacyId != null) {
    spaceByLegacyKey.set(String(legacyId), s);
    if (unitLegacy != null) {
      spaceByLegacyKey.set(`${unitLegacy}:${legacyId}`, s);
      spaceByLegacyKey.set(`part:${unitLegacy}:${legacyId}`, s);
    }
    spaceByLegacyKey.set(`space:${legacyId}`, s);
  }
  if ((s.spaceType === "full_unit" || meta.legacyStructuralKind === "full_unit") && unitLegacy != null) {
    spaceByLegacyKey.set(`full:${unitLegacy}`, s);
    spaceByLegacyKey.set(`full_unit:${unitLegacy}`, s);
  }
}

/** Month occupancy rows: rent/phone/tenant name evidence (NOT paid/status). */
const monthOccupancyBySpaceSrc = new Map();
for (const m of months) {
  const data = m.data || {};
  for (const u of data.units || []) {
    for (const p of u.partitions || []) {
      const src = `months/${m.id}#units/${u.id}/partitions/${p.id}`;
      monthOccupancyBySpaceSrc.set(src, {
        tenant: p.tenant || null,
        phone: p.phone || null,
        rentAed: p.rent ?? null,
        start_date: p.start_date || null,
        monthId: m.id,
      });
    }
  }
  for (const f of data.full || []) {
    const src = `months/${m.id}#full/${f.id}`;
    monthOccupancyBySpaceSrc.set(src, {
      tenant: f.tenant || null,
      phone: f.phone || null,
      rentAed: f.rent ?? null,
      start_date: f.start_date || null,
      monthId: m.id,
    });
    // also common structural refs use units/{id} for full units
    monthOccupancyBySpaceSrc.set(`months/${m.id}#units/${f.id}`, monthOccupancyBySpaceSrc.get(src));
  }
}

function resolveSpaceForCycle(c) {
  if (c.spaceId && spaceById.has(c.spaceId)) return spaceById.get(c.spaceId);
  const identity = String(c.spaceIdentity || "");
  if (identity.startsWith("full:")) {
    const unitLegacy = identity.slice(5);
    if (spaceByLegacyKey.has(`full:${unitLegacy}`)) return spaceByLegacyKey.get(`full:${unitLegacy}`);
  }
  if (identity.startsWith("part:")) {
    const rest = identity.slice(5);
    const idx = rest.lastIndexOf(":");
    if (idx > 0) {
      const unitLegacy = rest.slice(0, idx);
      const partLegacy = rest.slice(idx + 1);
      const k = `${unitLegacy}:${partLegacy}`;
      if (spaceByLegacyKey.has(k)) return spaceByLegacyKey.get(k);
    }
  }
  if (c.legacyUnitId != null && (c.partitionId == null || c.partitionId === "")) {
    const k = `full:${c.legacyUnitId}`;
    if (spaceByLegacyKey.has(k)) return spaceByLegacyKey.get(k);
  }
  if (c.legacyUnitId != null && c.partitionId != null && c.partitionId !== "") {
    const k = `${c.legacyUnitId}:${c.partitionId}`;
    if (spaceByLegacyKey.has(k)) return spaceByLegacyKey.get(k);
  }
  if (c.tenancyId) {
    const ten = tenancies.find((t) => t.id === c.tenancyId);
    if (ten?.spaceId && spaceById.has(ten.spaceId)) return spaceById.get(ten.spaceId);
  }
  return null;
}

function dueDayFrom(dateStr, fallback = 1) {
  if (!dateStr || typeof dateStr !== "string" || dateStr.length < 10) return fallback;
  const d = Number(dateStr.slice(8, 10));
  return Number.isFinite(d) && d >= 1 && d <= 31 ? d : fallback;
}

/* ---------- map structure ---------- */
const propMap = new Map(); // legacyId -> newId
for (const p of properties.filter((x) => (x.status || "active") === "active" || x.status == null)) {
  const id = migId("prop", p.id);
  propMap.set(p.id, id);
  report.mapped.properties.push({
    id,
    name: p.name || p.code || "Property",
    address: p.address || "",
    active: true,
    legacyId: p.id,
    createdAt: p.createdAt || nowIso(),
    createdBy: "migration",
    schemaVersion: 1,
    migrationAudit: { source: SOURCE_PROJECT, legacyPath: `properties/${p.id}`, migratedAt: nowIso() },
  });
}

const unitMap = new Map();
for (const u of units) {
  const propertyId = propMap.get(u.propertyId);
  if (!propertyId) {
    report.skipped.push({ type: "unit", id: u.id, reason: "missing_property" });
    continue;
  }
  const kind =
    (u.metadata?.legacyStructuralKind === "partitioned_unit" || u.unitType) ? "partitioned" : "partitioned";
  // Prefer partitioned if any child space exists that isn't sole full_unit
  const childSpaces = spaces.filter((s) => s.unitId === u.id);
  const onlyFull = childSpaces.length === 1 && childSpaces[0].spaceType === "full_unit";
  const unitKind = onlyFull ? "whole" : "partitioned";
  const id = migId("unit", u.id);
  unitMap.set(u.id, id);
  report.mapped.units.push({
    id,
    propertyId,
    name: u.name || u.metadata?.legacyStructuralId || u.id,
    kind: unitKind,
    active: (u.status || "active") === "active",
    legacyId: u.id,
    createdAt: u.createdAt || nowIso(),
    createdBy: "migration",
    schemaVersion: 1,
    migrationAudit: { source: SOURCE_PROJECT, legacyPath: `units/${u.id}`, migratedAt: nowIso() },
  });
}

const spaceMap = new Map();
for (const s of spaces) {
  const unitId = unitMap.get(s.unitId);
  const propertyId = propMap.get(s.propertyId) || report.mapped.units.find((u) => u.id === unitId)?.propertyId;
  if (!unitId || !propertyId) {
    report.skipped.push({ type: "space", id: s.id, reason: "missing_unit_or_property" });
    report.validationIssues.push({ issue: "missing_unit_references", spaceId: s.id });
    continue;
  }
  const id = migId("space", s.id);
  spaceMap.set(s.id, id);
  let occupancy = "vacant";
  if (s.occupancy === "occupied") occupancy = "rented";
  else if (s.occupancy === "vacant") occupancy = "vacant";
  else if (s.occupancy === "staff") occupancy = "staff";
  report.mapped.spaces.push({
    id,
    unitId,
    propertyId,
    name: s.name || s.metadata?.legacyStructuralId || s.id,
    occupancy,
    active: (s.status || "active") === "active",
    legacyId: s.id,
    createdAt: s.createdAt || nowIso(),
    createdBy: "migration",
    schemaVersion: 1,
    migrationAudit: { source: SOURCE_PROJECT, legacyPath: `rentableSpaces/${s.id}`, migratedAt: nowIso() },
  });
}

/* ---------- rentals from tenancies ---------- */
const rentalBySpace = new Map(); // newSpaceId -> rental
const rentalByLegacyTenancy = new Map();
const rentalByLegacySpace = new Map();

for (const ten of tenancies) {
  const newSpaceId = spaceMap.get(ten.spaceId);
  if (!newSpaceId) {
    report.skipped.push({ type: "tenancy", id: ten.id, reason: "space_not_mapped" });
    continue;
  }
  const spaceDoc = report.mapped.spaces.find((s) => s.id === newSpaceId);
  const legacySpace = spaceById.get(ten.spaceId);
  const tenant = tenantById.get(ten.tenantId);

  // Prefer real month tenant name over placeholder "شاغل غير محدد"
  const monthEv =
    monthOccupancyBySpaceSrc.get(legacySpace?.sourceReference) ||
    monthOccupancyBySpaceSrc.get(String(legacySpace?.sourceReference || "").replace("months/2026_7", "months/2026_8")) ||
    null;
  let tenantName = monthEv?.tenant || tenant?.displayName || tenant?.name || "UNKNOWN_TENANT";
  if (tenantName === "شاغل غير محدد" && monthEv?.tenant) tenantName = monthEv.tenant;
  const tenantPhone = monthEv?.phone || tenant?.phone || null;

  // Rent from cycles linked by space (not unreliable tenancy:legacy:* ids)
  const relatedCycles = cycles.filter((c) => {
    const sp = resolveSpaceForCycle(c);
    return sp && sp.id === ten.spaceId;
  });
  const openCycles = relatedCycles
    .filter((c) => String(c.status || "").startsWith("open"))
    .sort((a, b) => String(b.reportingMonth || "").localeCompare(String(a.reportingMonth || "")));
  const anyCycles = relatedCycles
    .filter((c) => c.baseAmountFils != null)
    .sort((a, b) => String(b.reportingMonth || "").localeCompare(String(a.reportingMonth || "")));

  let rentFils = openCycles[0]?.baseAmountFils ?? anyCycles[0]?.baseAmountFils ?? null;
  let dueDay = dueDayFrom(openCycles[0]?.dueDate || anyCycles[0]?.dueDate || ten.startDate, 1);
  let unverifiedRent = false;
  if (rentFils == null || rentFils <= 0) {
    const aed = monthEv?.rentAed;
    const fromMonth = aedToFils(aed);
    if (fromMonth != null && fromMonth > 0) {
      rentFils = fromMonth;
      report.unverified.push({
        type: "rental_rent",
        tenancyId: ten.id,
        reason: "MIGRATION_UNVERIFIED_RENT_FROM_MONTH_ROW_NOT_CYCLE",
        rentFils,
      });
      unverifiedRent = true;
    } else {
      unverifiedRent = true;
      rentFils = 0;
      report.unverified.push({
        type: "rental_rent",
        tenancyId: ten.id,
        reason: "MIGRATION_UNVERIFIED_NO_CYCLE_BASE_AMOUNT",
      });
    }
  }
  if (rentFils < 0) {
    report.validationIssues.push({ issue: "negative_money", tenancyId: ten.id, rentFils });
    continue;
  }

  const state = ten.status === "active" && !ten.endDate ? "active" : "closed";
  if (state === "active" && rentalBySpace.has(newSpaceId)) {
    report.validationIssues.push({
      issue: "duplicate_active_space_rental",
      spaceId: ten.spaceId,
      existing: rentalBySpace.get(newSpaceId),
      tenancyId: ten.id,
    });
    report.skipped.push({ type: "tenancy", id: ten.id, reason: "duplicate_active_on_space" });
    continue;
  }

  const id = migId("rental", ten.id);
  const rental = {
    id,
    propertyId: spaceDoc.propertyId,
    unitId: spaceDoc.unitId,
    spaceId: newSpaceId,
    tenantName: String(tenantName).slice(0, 160),
    tenantPhone: tenantPhone ? String(tenantPhone).slice(0, 40) : null,
    contractualAmountFils: rentFils,
    dueDayOfMonth: dueDay,
    startDate: (ten.startDate || monthEv?.start_date || "2026-08-01").toString().slice(0, 10),
    endDate: ten.endDate ? String(ten.endDate).slice(0, 10) : null,
    state,
    securityDepositFils: 0,
    createdAt: ten.createdAt || nowIso(),
    createdBy: "migration",
    schemaVersion: 1,
    migrationAudit: {
      source: SOURCE_PROJECT,
      legacyPath: `tenancies/${ten.id}`,
      legacyTenantId: ten.tenantId,
      rentSource: unverifiedRent ? "MIGRATION_UNVERIFIED" : "rentalCycles.baseAmountFils",
      migratedAt: nowIso(),
    },
  };
  if (state === "closed") {
    rental.closedBy = "migration";
    rental.closedAt = ten.endDate || nowIso();
    rental.closeReason = "legacy_tenancy_ended";
  }
  report.mapped.rentals.push(rental);
  rentalByLegacyTenancy.set(ten.id, rental);
  rentalByLegacySpace.set(ten.spaceId, rental);
  if (state === "active") {
    rentalBySpace.set(newSpaceId, rental);
    spaceDoc.occupancy = "rented";
  }
}

/* ---------- obligations from cycles (frozen snapshots) ---------- */
const obligationIds = new Set();
for (const c of cycles) {
  const period = reportingToPeriod(c.reportingMonth);
  if (!period) {
    report.skipped.push({ type: "cycle", id: c.id, reason: "bad_reporting_month" });
    continue;
  }
  if (c.baseAmountFils == null || !Number.isFinite(Number(c.baseAmountFils))) {
    report.unverified.push({ type: "cycle", id: c.id, reason: "MIGRATION_UNVERIFIED_NO_BASE_AMOUNT" });
    continue;
  }
  const amountFils = Number(c.baseAmountFils);
  if (amountFils < 0) {
    report.validationIssues.push({ issue: "negative_money", cycleId: c.id, amountFils });
    continue;
  }
  if (String(c.status || "").includes("cancel")) {
    report.skipped.push({ type: "cycle", id: c.id, reason: "cancelled_cycle" });
    continue;
  }

  let rental =
    (c.tenancyId && rentalByLegacyTenancy.get(c.tenancyId)) ||
    null;
  const sp = resolveSpaceForCycle(c);
  if (!rental && sp) rental = rentalByLegacySpace.get(sp.id) || null;
  if (!rental) {
    report.unverified.push({
      type: "obligation",
      cycleId: c.id,
      reason: "MIGRATION_UNVERIFIED_NO_RENTAL_LINK",
      period,
      amountFils,
    });
    continue;
  }

  const id = `${rental.id}_${period}`;
  if (obligationIds.has(id)) {
    // Prefer clean-gen / higher evidence: keep first, flag duplicate
    report.validationIssues.push({ issue: "duplicate_obligation_period", id, cycleId: c.id });
    report.skipped.push({ type: "cycle", id: c.id, reason: "duplicate_period_for_rental" });
    continue;
  }
  obligationIds.add(id);
  report.mapped.obligations.push({
    id,
    rentalId: rental.id,
    propertyId: rental.propertyId,
    unitId: rental.unitId,
    spaceId: rental.spaceId,
    period,
    amountFils,
    dueDate: (c.dueDate && String(c.dueDate).slice(0, 10)) || `${period}-01`,
    tenantNameSnapshot: rental.tenantName,
    state: "active",
    createdAt: c.createdAt || nowIso(),
    createdBy: "migration",
    schemaVersion: 1,
    migrationAudit: {
      source: SOURCE_PROJECT,
      legacyPath: `rentalCycles/${c.id}`,
      legacyStatusIgnored: c.status,
      migratedAt: nowIso(),
    },
  });
}

/* ---------- receipts from collectionEvents only (proven) ---------- */
const receiptKeys = new Set();
const paymentById = new Map(payments.map((p) => [p.id, p]));
for (const ev of collectionEvents) {
  if (ev.status && ev.status !== "active") {
    report.skipped.push({ type: "collectionEvent", id: ev.id, reason: `status_${ev.status}` });
    continue;
  }
  const amountFils = Number(ev.amountFils);
  if (!Number.isFinite(amountFils) || amountFils <= 0) {
    report.validationIssues.push({ issue: "bad_receipt_amount", id: ev.id, amountFils });
    continue;
  }
  const period = reportingToPeriod(ev.collectionMonth);
  let rental =
    (ev.tenancyId && rentalByLegacyTenancy.get(ev.tenancyId)) ||
    null;
  if (!rental && ev.cycleId) {
    const c = cycles.find((x) => x.id === ev.cycleId);
    if (c) {
      const sp = resolveSpaceForCycle(c);
      if (c.tenancyId) rental = rentalByLegacyTenancy.get(c.tenancyId);
      if (!rental && sp) rental = rentalByLegacySpace.get(sp.id);
      if (!period && c.reportingMonth) {
        // fallthrough
      }
    }
  }
  const usePeriod = period || reportingToPeriod(cycles.find((x) => x.id === ev.cycleId)?.reportingMonth);
  if (!rental || !usePeriod) {
    report.unverified.push({
      type: "receipt",
      id: ev.id,
      reason: "MIGRATION_UNVERIFIED_CANNOT_LINK_OBLIGATION",
      amountFils,
    });
    continue;
  }
  const obligationId = `${rental.id}_${usePeriod}`;
  if (!obligationIds.has(obligationId)) {
    // Create frozen obligation from receipt+rent if cycle missing — but amount unknown → unverified skip
    report.unverified.push({
      type: "receipt",
      id: ev.id,
      reason: "MIGRATION_UNVERIFIED_OBLIGATION_MISSING_FOR_PERIOD",
      obligationId,
      amountFils,
    });
    continue;
  }

  const pay = paymentById.get(ev.paymentId);
  const method = (ev.method || pay?.method || "cash") === "bank" ? "bank" : "cash";
  const id = migId("rcpt", ev.id);
  if (receiptKeys.has(id)) {
    report.validationIssues.push({ issue: "duplicate_financial_events", id });
    continue;
  }
  receiptKeys.add(id);

  const collectorUserId = migId("user", ev.collectorId || ev.createdBy || "unknown");
  report.mapped.receipts.push({
    id,
    obligationId,
    rentalId: rental.id,
    propertyId: rental.propertyId,
    unitId: rental.unitId,
    spaceId: rental.spaceId,
    period: usePeriod,
    tenantNameSnapshot: rental.tenantName,
    amountFils,
    collectionDate: (ev.effectiveAt || pay?.paymentDate || ev.createdAt || nowIso()).toString().slice(0, 10),
    method,
    collectorUserId,
    state: "recognized",
    note: "migrated_from_legacy_collectionEvent",
    createdAt: ev.createdAt || nowIso(),
    createdBy: "migration",
    schemaVersion: 1,
    migrationAudit: {
      source: SOURCE_PROJECT,
      legacyPath: `collectionEvents/${ev.id}`,
      legacyPaymentId: ev.paymentId || null,
      migratedAt: nowIso(),
    },
  });
}

/* ---------- accounts (new) + map approved deposits/expenses cautiously ---------- */
const revenueAccId = "mig:acc:revenue";
const companyAccId = "mig:acc:company";
report.mapped.accounts.push(
  {
    id: revenueAccId, name: "الإيرادات", kind: "bank", active: true,
    createdAt: nowIso(), createdBy: "migration", schemaVersion: 1,
    migrationAudit: { source: SOURCE_PROJECT, note: "new_schema_account", migratedAt: nowIso() },
  },
  {
    id: companyAccId, name: "الشركة", kind: "company", active: true,
    createdAt: nowIso(), createdBy: "migration", schemaVersion: 1,
    migrationAudit: { source: SOURCE_PROJECT, note: "new_schema_account", migratedAt: nowIso() },
  },
);

for (const d of deposits) {
  const amountFils = Number(d.requestedAmountFils ?? d.amountFils);
  if (!Number.isFinite(amountFils) || amountFils <= 0) {
    report.skipped.push({ type: "deposit", id: d.id, reason: "bad_amount" });
    continue;
  }
  // External/direct deposits without employee custody don't map cleanly to NEW custody model
  if (d.sourceType === "EXTERNAL" || d.direct === true) {
    report.unverified.push({
      type: "deposit",
      id: d.id,
      reason: "MIGRATION_UNVERIFIED_EXTERNAL_OR_DIRECT_NOT_EVENT_CUSTODY",
      amountFils,
      legacyStatus: d.status,
    });
    continue;
  }
  let state = "pending";
  if (d.status === "approved") state = "approved";
  else if (d.status === "rejected") state = "rejected";
  else if (d.status === "reversed") state = "reversed";
  const id = migId("dep", d.id);
  report.mapped.deposits.push({
    id,
    employeeId: migId("user", d.createdBy || "unknown"),
    amountFils,
    depositDate: (d.depositDate || d.createdAt || nowIso()).toString().slice(0, 10),
    period: reportingToPeriod(d.monthKey) || (d.depositDate || "").toString().slice(0, 7) || "2026-08",
    destinationAccountId: revenueAccId,
    note: d.note || "migrated_legacy_deposit",
    reference: d.reference || null,
    state,
    createdAt: d.createdAt || nowIso(),
    createdBy: "migration",
    schemaVersion: 1,
    migrationAudit: { source: SOURCE_PROJECT, legacyPath: `deposits/${d.id}`, migratedAt: nowIso() },
  });
}

for (const e of expenses) {
  const amountFils = Number(e.amountFils);
  if (!Number.isFinite(amountFils) || amountFils <= 0) {
    report.skipped.push({ type: "expense", id: e.id, reason: "bad_amount" });
    continue;
  }
  // Only migrate if we have date-like evidence; status 'active' ~ approved in legacy
  const id = migId("exp", e.id);
  const state = e.status === "active" || e.status === "approved" ? "approved" : "pending";
  report.mapped.expenses.push({
    id,
    amountFils,
    reason: String(e.reason || "legacy_expense").slice(0, 300),
    category: String(e.category || "operating").slice(0, 60),
    expenseDate: (e.expenseDate || e.approvedAt || e.createdAt || nowIso()).toString().slice(0, 10),
    period: reportingToPeriod(e.approvedMonth) || (e.approvedAt || "").toString().slice(0, 7) || "2026-08",
    paidFromAccountId: e.account === "company" ? companyAccId : revenueAccId,
    submittedBy: migId("user", e.createdBy || e.approvedBy || "unknown"),
    state,
    createdAt: e.createdAt || nowIso(),
    createdBy: "migration",
    schemaVersion: 1,
    migrationAudit: { source: SOURCE_PROJECT, legacyPath: `expenses/${e.id}`, migratedAt: nowIso() },
  });
}

/* ---------- archive unverified financial totals from months ---------- */
let monthPaidResidue = 0;
for (const m of months) {
  const data = m.data || {};
  const walk = (rows, kind) => {
    for (const row of rows || []) {
      if (row.paid_amount != null || row.status != null) {
        monthPaidResidue++;
        report.unverified.push({
          type: "legacy_month_row",
          monthId: m.id,
          kind,
          rowId: row.id,
          reason: "MIGRATION_UNVERIFIED_MUTABLE_PAID_OR_STATUS_NOT_IMPORTED",
          paid_amount: row.paid_amount ?? null,
          status: row.status ?? null,
          rent: row.rent ?? null,
        });
      }
      if (row.partitions) walk(row.partitions, "partition");
    }
  };
  walk(data.units, "unit");
  walk(data.full, "full");
}

/* ---------- users (new PINs, no legacy pin copy) ---------- */
const pinSecrets = { generatedAt: nowIso(), warning: "Store securely. Not committed. Legacy PINs were NOT copied.", users: [] };
const roleMap = { owner: "owner", manager: "owner", finance: "employee", employee: "employee" };

for (const u of users.filter((x) => x.active !== false)) {
  const key = u.userKey || u.id?.replace(/^qama_/, "") || u.id;
  const role = roleMap[u.role] || "employee";
  // Prefer single owner: saeed
  const isOwner = key === "saeed" || u.role === "owner" || u.role === "manager";
  const id = isOwner && key === "saeed" ? `mig:user:owner:${key}` : migId("user", key);
  const pin = genPin();
  const { pinHash, pinSalt } = hashPin(pin);
  report.mapped.users.push({
    id,
    userId: id,
    displayName: u.name || key,
    role: isOwner && key === "saeed" ? "owner" : role === "owner" && key !== "saeed" ? "employee" : role,
    active: true,
    pinHash,
    pinSalt,
    pinUpdatedAt: nowIso(),
    createdAt: nowIso(),
    createdBy: "migration",
    schemaVersion: 1,
    migrationAudit: {
      source: SOURCE_PROJECT,
      legacyPath: `users/${u.id}`,
      legacyUserKey: key,
      pinMigrated: false,
      migratedAt: nowIso(),
    },
  });
  pinSecrets.users.push({ userId: id, displayName: u.name || key, role: report.mapped.users.at(-1).role, pin });
}

// Ensure owner exists
if (!report.mapped.users.some((u) => u.role === "owner")) {
  const pin = genPin();
  const { pinHash, pinSalt } = hashPin(pin);
  const id = "mig:user:owner:bootstrap";
  report.mapped.users.push({
    id, userId: id, displayName: "Owner", role: "owner", active: true,
    pinHash, pinSalt, pinUpdatedAt: nowIso(),
    createdAt: nowIso(), createdBy: "migration", schemaVersion: 1,
    migrationAudit: { source: "bootstrap", migratedAt: nowIso() },
  });
  pinSecrets.users.push({ userId: id, displayName: "Owner", role: "owner", pin });
}

/* ---------- duplicate tenant names check ---------- */
const nameCounts = new Map();
for (const r of report.mapped.rentals.filter((x) => x.state === "active")) {
  nameCounts.set(r.tenantName, (nameCounts.get(r.tenantName) || 0) + 1);
}
for (const [name, n] of nameCounts) {
  if (n > 1) report.validationIssues.push({ issue: "duplicate_tenants_name", tenantName: name, count: n });
}

report.selected = {
  properties: report.mapped.properties.length,
  units: report.mapped.units.length,
  spaces: report.mapped.spaces.length,
  activeRentals: report.mapped.rentals.filter((r) => r.state === "active").length,
  closedRentals: report.mapped.rentals.filter((r) => r.state === "closed").length,
  tenantsApprox: new Set(report.mapped.rentals.map((r) => r.tenantName)).size,
  obligations: report.mapped.obligations.length,
  receipts: report.mapped.receipts.length,
  deposits: report.mapped.deposits.length,
  expenses: report.mapped.expenses.length,
  accounts: report.mapped.accounts.length,
  users: report.mapped.users.length,
  skipped: report.skipped.length,
  unverified: report.unverified.length,
  validationIssues: report.validationIssues.length,
  monthPaidResidueArchived: monthPaidResidue,
};

mkdirSync(REPORT_DIR, { recursive: true });
writeFileSync(resolve(REPORT_DIR, "migration-report.json"), JSON.stringify(report, null, 2));
writeFileSync(resolve(REPORT_DIR, "migration-mapped.json"), JSON.stringify(report.mapped, null, 2));
writeFileSync(PINS_FILE, JSON.stringify(pinSecrets, null, 2), { mode: 0o600 });
writeFileSync(resolve(REPORT_DIR, "legacy-financial-archive-note.json"), JSON.stringify({
  note: "Legacy mutable paid_amount/status/holding were NOT imported as truth.",
  archiveCollections: ["months", "payments", "cashLots", "paymentAllocations", "accountBalances", "bankPayments"],
  exportDir: EXPORT_DIR,
  unverifiedCount: report.unverified.length,
}, null, 2));

console.log(JSON.stringify({ ok: true, mode: report.mode, selected: report.selected, reportDir: REPORT_DIR }, null, 2));

if (DRY) process.exit(0);

/* ---------- APPLY to target ---------- */
function initTarget() {
  if (getApps().length) return;
  // Prefer explicit ADC file used by this environment.
  const adcPath = `${process.env.HOME}/.config/firebase/binham87_gmail_com_application_default_credentials.json`;
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && existsSync(adcPath)) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = adcPath;
  }
  initializeApp({ projectId: TARGET_PROJECT });
}

initTarget();
const db = getFirestore();

async function upsert(col, doc) {
  const ref = db.collection(col).doc(doc.id);
  await ref.set(doc, { merge: false });
  // migration audit record
  await db.collection("migrationAudit").doc(`${col}_${doc.id}`.replace(/\//g, "_")).set({
    collection: col,
    docId: doc.id,
    legacy: doc.migrationAudit || null,
    writtenAt: nowIso(),
    migrationRunId: `run:${TARGET_PROJECT}:2026-09-02`,
  }, { merge: true });
}

const batches = [
  ["properties", report.mapped.properties],
  ["units", report.mapped.units],
  ["spaces", report.mapped.spaces],
  ["rentals", report.mapped.rentals],
  ["obligations", report.mapped.obligations],
  ["receipts", report.mapped.receipts],
  ["accounts", report.mapped.accounts],
  ["deposits", report.mapped.deposits],
  ["expenses", report.mapped.expenses],
  ["users", report.mapped.users],
];

let written = 0;
for (const [col, docs] of batches) {
  for (const doc of docs) {
    await upsert(col, doc);
    written++;
    if (written % 50 === 0) console.log("written", written, col);
  }
  console.log("done", col, docs.length);
}

await db.collection("migrationRuns").doc("run:2026-09-02-qama-new-prod").set({
  id: "run:2026-09-02-qama-new-prod",
  sourceProject: SOURCE_PROJECT,
  targetProject: TARGET_PROJECT,
  completedAt: nowIso(),
  selected: report.selected,
  idempotent: true,
}, { merge: true });

console.log(JSON.stringify({ applied: true, written, pinsFile: PINS_FILE }, null, 2));
