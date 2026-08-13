import crypto from "node:crypto";

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
};

const stableJson = (value) => JSON.stringify(canonicalize(value));
const sha256 = (value) => crypto.createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");
const normalize = (value) => String(value ?? "").trim().normalize("NFKC");
const deterministicId = (kind, sourceReference) => `${kind}:legacy:${sha256(sourceReference).slice(0, 24)}`;

const FINANCIAL_FIELDS = Object.freeze([
  "rent", "paid_amount", "status", "partial", "collectedBy", "collectedAt",
  "collectionMethod", "rent_type", "start_date", "due_date", "end_date",
  "contract_end", "cycle_anchor", "cycle_i", "elec_amount", "elec_paid",
]);

function structuralMetadata({ legacyId, sourceReference, sourceRecordHash, bootstrapKey, extra = {} }) {
  return {
    legacyStructuralId: normalize(legacyId),
    sourceReference,
    sourceRecordHash,
    structuralBootstrapKey: bootstrapKey,
    evidenceClassification: "legacy_physical_structure_only",
    ...extra,
  };
}

export function buildLegacyStructuralBootstrapPlan({ legacyMonthData, sourceDocumentPath, property }) {
  if (!legacyMonthData || typeof legacyMonthData !== "object") throw new Error("LEGACY_SOURCE_INVALID");
  const sourcePath = normalize(sourceDocumentPath);
  if (!/^months\/[A-Za-z0-9_-]+$/.test(sourcePath)) throw new Error("LEGACY_SOURCE_PATH_INVALID");
  const propertyName = normalize(property?.name);
  const propertyLegacyKey = normalize(property?.legacyKey);
  if (!propertyName || !propertyLegacyKey) throw new Error("PROPERTY_IDENTITY_CONFIRMATION_REQUIRED");

  const sourceStructure = {
    units: Array.isArray(legacyMonthData.units) ? legacyMonthData.units : [],
    full: Array.isArray(legacyMonthData.full) ? legacyMonthData.full : [],
  };
  const sourceStructureHash = sha256(sourceStructure);
  const bootstrapKey = `legacy-structure:${sourcePath}:${sourceStructureHash}`;
  const propertySource = `${sourcePath}#structural-property/${propertyLegacyKey}`;
  const propertyId = deterministicId("property", propertySource);
  const entities = {
    properties: [{
      id: propertyId,
      name: propertyName,
      code: normalize(property.code),
      address: normalize(property.address),
      sourceReference: propertySource,
      sourceRecordHash: sha256({ legacyKey: propertyLegacyKey, name: propertyName, code: normalize(property.code), address: normalize(property.address) }),
      metadata: structuralMetadata({ legacyId: propertyLegacyKey, sourceReference: propertySource, sourceRecordHash: sha256(propertyLegacyKey), bootstrapKey }),
    }],
    units: [],
    rentableSpaces: [],
  };
  const skipped = [];
  const conflicts = [];
  const seenUnitKeys = new Map();
  const seenUnitNames = new Map();

  const registerUnit = ({ legacyId, name, unitType, kind, sourceReference, record }) => {
    const key = normalize(legacyId);
    const displayName = normalize(name) || key;
    if (!key) { skipped.push({ sourceReference, reason: "MISSING_STRUCTURAL_UNIT_ID" }); return null; }
    if (seenUnitKeys.has(key)) { conflicts.push({ sourceReference, reason: "DUPLICATE_STRUCTURAL_UNIT_ID", conflictsWith: seenUnitKeys.get(key) }); return null; }
    const normalizedName = displayName.toLocaleLowerCase("ar");
    if (seenUnitNames.has(normalizedName)) { conflicts.push({ sourceReference, reason: "DUPLICATE_STRUCTURAL_UNIT_NAME", conflictsWith: seenUnitNames.get(normalizedName) }); return null; }
    seenUnitKeys.set(key, sourceReference); seenUnitNames.set(normalizedName, sourceReference);
    const unitId = deterministicId("unit", `${propertySource}|${kind}|${key}`);
    const sourceRecordHash = sha256({ id: key, name: displayName, type: normalize(unitType), kind });
    entities.units.push({
      id: unitId, propertyId, name: displayName, unitType: normalize(unitType) || kind,
      sourceReference, sourceRecordHash,
      metadata: structuralMetadata({ legacyId: key, sourceReference, sourceRecordHash, bootstrapKey, extra: { legacyStructuralKind: kind } }),
    });
    return { unitId, key, displayName, record };
  };

  for (const unit of sourceStructure.units) {
    const sourceReference = `${sourcePath}#units/${normalize(unit?.id)}`;
    const registered = registerUnit({ legacyId: unit?.id, name: unit?.name, unitType: unit?.type, kind: "partitioned_unit", sourceReference, record: unit });
    if (!registered) continue;
    const partitions = Array.isArray(unit?.partitions) ? unit.partitions : [];
    const seenSpaces = new Set();
    for (const partition of partitions) {
      const legacySpaceId = normalize(partition?.id);
      const spaceSource = `${sourceReference}/partitions/${legacySpaceId}`;
      if (!legacySpaceId) { skipped.push({ sourceReference: spaceSource, reason: "MISSING_STRUCTURAL_SPACE_ID" }); continue; }
      if (seenSpaces.has(legacySpaceId)) { conflicts.push({ sourceReference: spaceSource, reason: "DUPLICATE_SPACE_ID_WITHIN_UNIT" }); continue; }
      seenSpaces.add(legacySpaceId);
      const spaceId = deterministicId("space", `${registered.unitId}|partition|${legacySpaceId}`);
      const sourceRecordHash = sha256({ unitLegacyId: registered.key, partitionLegacyId: legacySpaceId });
      entities.rentableSpaces.push({
        id: spaceId, propertyId, unitId: registered.unitId, name: `${registered.displayName} / ${legacySpaceId}`, spaceType: "partition",
        sourceReference: spaceSource, sourceRecordHash,
        metadata: structuralMetadata({ legacyId: legacySpaceId, sourceReference: spaceSource, sourceRecordHash, bootstrapKey }),
      });
    }
  }

  for (const full of sourceStructure.full) {
    const key = normalize(full?.id);
    const sourceReference = `${sourcePath}#full/${key}`;
    const registered = registerUnit({ legacyId: key, name: key, unitType: "full_unit", kind: "full_unit", sourceReference, record: full });
    if (!registered) continue;
    const spaceSource = `${sourceReference}/rentable-space`;
    const spaceId = deterministicId("space", `${registered.unitId}|full_unit|${key}`);
    const sourceRecordHash = sha256({ unitLegacyId: key, spaceType: "full_unit" });
    entities.rentableSpaces.push({
      id: spaceId, propertyId, unitId: registered.unitId, name: registered.displayName, spaceType: "full_unit",
      sourceReference: spaceSource, sourceRecordHash,
      metadata: structuralMetadata({ legacyId: key, sourceReference: spaceSource, sourceRecordHash, bootstrapKey }),
    });
  }

  return {
    sourceDocumentPath: sourcePath,
    sourceStructureHash,
    bootstrapKey,
    entities,
    skipped,
    conflicts,
    counts: {
      properties: entities.properties.length,
      units: entities.units.length,
      rentableSpaces: entities.rentableSpaces.length,
      skipped: skipped.length,
      conflicts: conflicts.length,
    },
    excludedFinancialFields: [...FINANCIAL_FIELDS],
    financialEffect: Object.freeze({ collectionEvents: 0, deposits: 0, expenses: 0, ledgerMovements: 0, custodyMovements: 0, bankInstallments: 0, reserveTransfers: 0, refunds: 0 }),
  };
}

export function entityBootstrapFingerprint(entity) {
  return sha256({
    id: entity.id, propertyId: entity.propertyId || null, unitId: entity.unitId || null,
    name: entity.name, code: entity.code || "", address: entity.address || "",
    unitType: entity.unitType || "", spaceType: entity.spaceType || "",
    sourceReference: entity.sourceReference, sourceRecordHash: entity.sourceRecordHash,
  });
}

export const legacyStructuralBootstrapInternals = Object.freeze({ deterministicId, stableJson, sha256, FINANCIAL_FIELDS });
