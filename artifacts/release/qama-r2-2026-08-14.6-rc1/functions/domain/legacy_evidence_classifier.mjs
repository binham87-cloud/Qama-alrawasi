/**
 * R2 historical evidence classifier.
 * Never converts unverifiable legacy state into proven revenue.
 *
 * A = provable canonical history (collectionEvents / ledger / cashLots)
 * B = deterministic legacy-derived (paid_amount / transactions, not minted)
 * C = opening balance / carry-forward
 * D = unverifiable legacy state (status-only, missing evidence)
 * E = contradiction requiring owner review
 */
const num = (x) => Number(x) || 0;

export const EVIDENCE_CLASS = Object.freeze({
  A_CANONICAL: "A",
  B_LEGACY_DERIVED: "B",
  C_OPENING: "C",
  D_UNVERIFIABLE: "D",
  E_CONTRADICTION: "E",
});

function itemsOf(data) {
  const rows = [];
  for (const unit of data?.units || []) {
    for (const part of unit.partitions || []) {
      rows.push({ kind: "partition", unitId: unit.id, entityId: part.id, ...part });
    }
  }
  for (const full of data?.full || []) {
    rows.push({ kind: "full", unitId: full.id, entityId: full.id, ...full });
  }
  return rows;
}

export function classifyLegacySpace(row, canonical = {}) {
  const rent = num(row.rent);
  const paid = num(row.paid_amount);
  const status = String(row.status || "");
  const hasEvent = !!canonical.collectionEventId;
  const reasons = [];

  if (hasEvent) {
    return { classification: EVIDENCE_CLASS.A_CANONICAL, rent, paid, status, reasons: ["canonical_collection_event"] };
  }
  if (canonical.openingFils > 0) {
    return { classification: EVIDENCE_CLASS.C_OPENING, rent, paid, status, reasons: ["opening_residual"] };
  }
  if (paid > rent && rent > 0) {
    reasons.push("paid_amount_exceeds_rent");
    return { classification: EVIDENCE_CLASS.E_CONTRADICTION, rent, paid, status, reasons };
  }
  if (status === "collected" && paid <= 0) {
    reasons.push("status_collected_without_paid_amount");
    return { classification: EVIDENCE_CLASS.D_UNVERIFIABLE, rent, paid, status, reasons };
  }
  if (paid > 0) {
    reasons.push("legacy_paid_amount_without_canonical_event");
    return { classification: EVIDENCE_CLASS.B_LEGACY_DERIVED, rent, paid, status, reasons };
  }
  if (status === "collected") {
    reasons.push("status_collected_zero_paid");
    return { classification: EVIDENCE_CLASS.D_UNVERIFIABLE, rent, paid, status, reasons };
  }
  return { classification: EVIDENCE_CLASS.B_LEGACY_DERIVED, rent, paid, status, reasons: ["operational_fields_only"] };
}

export function classifyLegacyMonth(data, options = {}) {
  const canonicalBySpace = options.canonicalBySpace || {};
  const spaces = itemsOf(data).map((row) => {
    const key = `${row.unitId}|${row.entityId}`;
    return {
      key,
      kind: row.kind,
      unitId: row.unitId,
      entityId: row.entityId,
      tenant: row.tenant || null,
      ...classifyLegacySpace(row, canonicalBySpace[key] || {}),
    };
  });
  const transactions = (data?.transactions || []).map((tx) => ({
    id: tx.id || tx.requestId || null,
    amount: num(tx.amount),
    reversed: !!tx.reversed,
    classification: tx.reversed ? EVIDENCE_CLASS.B_LEGACY_DERIVED : EVIDENCE_CLASS.B_LEGACY_DERIVED,
    reasons: ["month_transactions_compatibility"],
  }));
  const counts = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  for (const space of spaces) counts[space.classification] = (counts[space.classification] || 0) + 1;
  return {
    write: false,
    mintedFils: 0,
    spaces,
    transactions,
    counts,
    conclusion: counts.E
      ? "Owner review required for contradictory legacy rows; nothing minted."
      : counts.D
        ? "Unverifiable collected-status rows preserved without minting revenue."
        : "Legacy rows classified without converting them into canonical events.",
  };
}

export function dryRunLegacyClassification(months = [], options = {}) {
  if (options.write === true) {
    throw new Error("R2_MIGRATION_WRITE_FORBIDDEN");
  }
  const results = months.map((month) => ({
    monthId: month.id,
    ...classifyLegacyMonth(month.data, options),
  }));
  return {
    mode: "dry-run",
    write: false,
    months: results,
    totals: results.reduce((acc, month) => {
      for (const key of Object.keys(month.counts || {})) acc[key] = (acc[key] || 0) + month.counts[key];
      return acc;
    }, { A: 0, B: 0, C: 0, D: 0, E: 0 }),
  };
}
