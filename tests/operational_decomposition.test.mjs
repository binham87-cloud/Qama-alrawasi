import test from "node:test";
import assert from "node:assert/strict";
import { applyOperationalPatch, operationalAllowedFields } from "../functions/domain/operational_commands.mjs";

const month = () => ({ _rev: 7, data: { units: [{ id: "u1", name: "شقة 101", type: "رجال", color: "#112233", operationalVersion: 2, partitions: [{ id: 8, note: "قديم", phone: "050", operationalVersion: 3, rent: 3000, status: "late", paid_amount: 0 }] }], full: [{ id: "104", note: "", phone: "", operationalVersion: 1, rent: 9000 }] } });
const manager = { id: "saeed", role: "owner" };

test("explicit whitelist preserves an operational note update", () => {
  const result = applyOperationalPatch(month(), { target: { entityType: "partition", unitId: "u1", entityId: 8 }, patch: { note: "جديد" }, baseVersion: 3 }, manager);
  assert.equal(result.data.units[0].partitions[0].note, "جديد");
  assert.equal(result.data.units[0].partitions[0].rent, 3000);
  assert.equal(result.version, 4);
});

test("mixed payload is rejected atomically", () => {
  assert.throws(() => applyOperationalPatch(month(), { target: { entityType: "partition", unitId: "u1", entityId: 8 }, patch: { note: "جديد", rent: 1 }, baseVersion: 3 }, manager), /OPERATIONAL_FIELD_DENIED/);
});

for (const field of ["status", "paid_amount", "remaining", "collected", "cashLots", "transactions", "deposit", "start_date", "due_date", "elec_amount"]) {
  test(`financial injection ${field} is denied`, () => {
    assert.throws(() => applyOperationalPatch(month(), { target: { entityType: "partition", unitId: "u1", entityId: 8 }, patch: { [field]: field === "cashLots" ? [] : 1 }, baseVersion: 3 }, manager), /OPERATIONAL_FIELD_DENIED/);
  });
}

test("stale operational update is rejected", () => {
  assert.throws(() => applyOperationalPatch(month(), { target: { entityType: "partition", unitId: "u1", entityId: 8 }, patch: { phone: "055" }, baseVersion: 2 }, manager), /STALE_OPERATIONAL_ENTITY/);
});

test("employee cannot bypass the existing request workflow", () => {
  assert.throws(() => applyOperationalPatch(month(), { target: { entityType: "full", entityId: "104" }, patch: { note: "x" }, baseVersion: 1 }, { id: "yahia", role: "employee" }), /MANAGER_REQUIRED/);
});

test("allowed fields are positive whitelists", () => {
  assert.deepEqual(operationalAllowedFields("partition").sort(), ["note", "phone"]);
  assert.deepEqual(operationalAllowedFields("unit").sort(), ["color", "name", "type"]);
});
