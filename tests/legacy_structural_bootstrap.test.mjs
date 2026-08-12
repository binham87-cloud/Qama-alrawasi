import test from "node:test";
import assert from "node:assert/strict";
import { buildLegacyStructuralBootstrapPlan } from "../functions/domain/legacy_structural_bootstrap.mjs";

const source = {
  units: [
    { id: "A", name: "Building A / Unit A", type: "family", partitions: [
      { id: 1, rent: 9999, paid_amount: 9999, status: "collected", tenant: "Must not migrate", due_date: "2040-01-01" },
      { id: 2, status: "late", rent: 1234 },
    ] },
    { id: "B", name: "Building A / Unit B", type: "shared", partitions: [{ id: "x" }] },
  ],
  full: [{ id: "C", rent: 5000, paid_amount: 5000, status: "collected", tenant: "Must not migrate" }],
  expenses: [{ amount: 100 }], transactions: [{ amount: 200 }], handovers: [{ amount: 300 }],
};
const args = { legacyMonthData: source, sourceDocumentPath: "months/2040_0", property: { legacyKey: "property-a", name: "Property A" } };

test("LSB01 dynamically maps only physical structure", () => {
  const plan = buildLegacyStructuralBootstrapPlan(args);
  assert.deepEqual(plan.counts, { properties: 1, units: 3, rentableSpaces: 4, skipped: 0, conflicts: 0 });
  assert.equal(plan.financialEffect.collectionEvents, 0);
  const serialized = JSON.stringify(plan.entities);
  for (const forbidden of ["9999", "collected", "Must not migrate", "2040-01-01", "paid_amount"]) assert.equal(serialized.includes(forbidden), false);
});

test("LSB02 stable IDs and hashes are deterministic and size-independent", () => {
  const first = buildLegacyStructuralBootstrapPlan(args);
  const second = buildLegacyStructuralBootstrapPlan(args);
  assert.deepEqual(first, second);
  const expanded = buildLegacyStructuralBootstrapPlan({ ...args, legacyMonthData: { ...source, units: [...source.units, { id: "D", name: "Unit D", partitions: [] }] } });
  assert.equal(expanded.counts.units, 4);
  assert.equal(expanded.entities.units[0].id, first.entities.units[0].id);
});

test("LSB03 ambiguous duplicate structural identity is blocked, not guessed", () => {
  const plan = buildLegacyStructuralBootstrapPlan({ ...args, legacyMonthData: { units: [...source.units, { id: "A", name: "Conflicting A", partitions: [{ id: 9 }] }], full: [] } });
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].reason, "DUPLICATE_STRUCTURAL_UNIT_ID");
  assert.equal(plan.entities.units.filter((x) => x.metadata.legacyStructuralId === "A").length, 1);
});

test("LSB04 property identity must be explicitly established", () => {
  assert.throws(() => buildLegacyStructuralBootstrapPlan({ ...args, property: {} }), /PROPERTY_IDENTITY_CONFIRMATION_REQUIRED/);
});

