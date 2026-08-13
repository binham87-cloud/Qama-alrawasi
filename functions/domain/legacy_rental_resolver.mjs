/**
 * Deterministic legacy rental identity resolver.
 * Maps familiar month unit/partition/full-flat identity → unique rentableSpace.
 * FAIL CLOSED on ambiguity. Never picks an arbitrary tenant/space.
 */

const normalize = (value) => String(value ?? "").trim().normalize("NFKC");
const lower = (value) => normalize(value).toLocaleLowerCase("ar");

function unitLegacyId(unit) {
  return normalize(unit?.metadata?.legacyStructuralId || unit?.legacyStructuralId || unit?.legacyId || "");
}

function spaceLegacyId(space) {
  return normalize(space?.metadata?.legacyStructuralId || space?.legacyStructuralId || space?.partitionId || space?.legacyId || "");
}

function spaceTypeOf(space) {
  return normalize(space?.spaceType || space?.metadata?.legacyStructuralKind || "");
}

function candidatesForUnit(units, legacyUnitId) {
  const want = normalize(legacyUnitId);
  if (!want) return [];
  const byMeta = units.filter((u) => unitLegacyId(u) === want);
  if (byMeta.length) return byMeta;
  const byIdSuffix = units.filter((u) => {
    const id = normalize(u.id);
    return id === want || id === `unit:legacy:${want}` || id.endsWith(`:${want}`) || id.endsWith(`|${want}`);
  });
  if (byIdSuffix.length) return byIdSuffix;
  const byName = units.filter((u) => {
    const name = lower(u.name);
    return name === lower(want) || name === lower(`شقة ${want}`) || name.endsWith(` ${want}`);
  });
  return byName;
}

function partitionMatches(space, partitionId) {
  const part = normalize(partitionId);
  if (!part) return false;
  if (spaceLegacyId(space) === part) return true;
  if (normalize(space.partitionId) === part) return true;
  const name = normalize(space.name);
  if (name.endsWith(` / ${part}`) || name.endsWith(`/${part}`) || name.endsWith(`#${part}`) || name.endsWith(` ${part}`)) return true;
  const src = normalize(space.sourceReference || space.metadata?.sourceReference || "");
  if (src.includes(`/partitions/${part}`) || src.endsWith(`/partitions/${part}`)) return true;
  return false;
}

/**
 * @param {{ spaces: object[], units?: object[], legacyUnitId: string, partitionId?: string|null, spaceType?: "partition"|"full_unit" }} input
 * @returns {{ ok: true, space: object } | { ok: false, code: string, matches?: number }}
 */
export function resolveLegacyRentableSpace(input) {
  const spaces = Array.isArray(input?.spaces) ? input.spaces : [];
  const units = Array.isArray(input?.units) ? input.units : [];
  const legacyUnitId = normalize(input?.legacyUnitId);
  const partitionId = input?.partitionId == null || input?.partitionId === "" ? null : normalize(input.partitionId);
  const wantType = normalize(input?.spaceType || (partitionId == null ? "full_unit" : "partition"));

  if (!legacyUnitId) return { ok: false, code: "LEGACY_UNIT_ID_REQUIRED" };
  if (!spaces.length) return { ok: false, code: "RENTABLE_SPACE_NOT_FOUND" };

  const unitHits = candidatesForUnit(units, legacyUnitId);
  if (unitHits.length > 1) return { ok: false, code: "AMBIGUOUS_UNIT", matches: unitHits.length };

  let pool = spaces;
  if (unitHits.length === 1) {
    const unitId = unitHits[0].id;
    pool = spaces.filter((s) => normalize(s.unitId) === normalize(unitId));
  } else {
    // No unit registry hit — restrict by name/source containing the legacy unit id.
    pool = spaces.filter((s) => {
      const name = lower(s.name);
      const src = normalize(s.sourceReference || s.metadata?.sourceReference || "");
      return name.includes(lower(legacyUnitId))
        || name.includes(lower(`شقة ${legacyUnitId}`))
        || src.includes(`#units/${legacyUnitId}`)
        || src.includes(`#full/${legacyUnitId}`)
        || src.includes(`/units/${legacyUnitId}`)
        || src.includes(`/full/${legacyUnitId}`);
    });
  }

  if (wantType === "full_unit" || partitionId == null) {
    const full = pool.filter((s) => {
      const t = spaceTypeOf(s);
      return t === "full_unit" || t === "full" || (!spaceLegacyId(s) && !normalize(s.partitionId) && t !== "partition");
    });
    const named = full.length ? full : pool.filter((s) => spaceTypeOf(s) !== "partition");
    if (named.length === 1) return { ok: true, space: named[0] };
    if (named.length > 1) return { ok: false, code: "AMBIGUOUS_SPACE", matches: named.length };
    // Last resort: unique name equality with unit id alone
    const exactName = pool.filter((s) => lower(s.name) === lower(legacyUnitId) || lower(s.name) === lower(`شقة ${legacyUnitId}`));
    if (exactName.length === 1) return { ok: true, space: exactName[0] };
    if (exactName.length > 1) return { ok: false, code: "AMBIGUOUS_SPACE", matches: exactName.length };
    return { ok: false, code: "RENTABLE_SPACE_NOT_FOUND" };
  }

  const parts = pool.filter((s) => partitionMatches(s, partitionId));
  if (parts.length === 1) return { ok: true, space: parts[0] };
  if (parts.length > 1) return { ok: false, code: "AMBIGUOUS_SPACE", matches: parts.length };

  // Unique global name "… / partitionId" across all spaces if unit-scoped pool failed
  if (unitHits.length === 0) {
    const global = spaces.filter((s) => partitionMatches(s, partitionId) && (
      lower(s.name).includes(lower(legacyUnitId)) || normalize(s.sourceReference || "").includes(`/${legacyUnitId}`)
    ));
    if (global.length === 1) return { ok: true, space: global[0] };
    if (global.length > 1) return { ok: false, code: "AMBIGUOUS_SPACE", matches: global.length };
  }
  return { ok: false, code: "RENTABLE_SPACE_NOT_FOUND" };
}

/**
 * Pick the single active tenancy for a space, or fail closed.
 */
export function resolveActiveTenancy({ tenancies, spaceId, tenantName }) {
  const sid = normalize(spaceId);
  const active = (tenancies || []).filter((t) => normalize(t.spaceId) === sid && !["ended", "cancelled", "inactive"].includes(String(t.status || "active")));
  if (active.length === 1) return { ok: true, tenancy: active[0] };
  if (active.length > 1) {
    const name = normalize(tenantName);
    if (!name) return { ok: false, code: "AMBIGUOUS_TENANCY", matches: active.length };
    const byName = active.filter((t) => lower(t.tenantName || t.tenant || "") === lower(name));
    if (byName.length === 1) return { ok: true, tenancy: byName[0] };
    return { ok: false, code: "AMBIGUOUS_TENANCY", matches: active.length };
  }
  return { ok: false, code: "TENANCY_NOT_FOUND" };
}

export function compatibleCycleId(spaceId, reportingMonthKey) {
  return `cycle:${normalize(spaceId)}:${normalize(reportingMonthKey)}`;
}

export const legacyRentalResolverInternals = Object.freeze({ normalize, unitLegacyId, spaceLegacyId, partitionMatches });
