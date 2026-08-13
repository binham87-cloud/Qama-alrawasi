import test from "node:test";
import assert from "node:assert/strict";
import {
  reportingMonthKey, storageMonthKey, storageToReportingMonthKey, reportingToStorageMonthKey, toReportingMonthKey,
} from "../functions/domain/month_keys.mjs";
import {
  resolveLegacyRentableSpace, resolveActiveTenancy, compatibleCycleId,
} from "../functions/domain/legacy_rental_resolver.mjs";
import { blankState, executeCommand } from "../functions/domain/command_processor.mjs";
import { cycleProjection } from "../functions/domain/financial_engine.mjs";

test("month keys: January August September December storage↔reporting", () => {
  assert.equal(storageMonthKey(2026, 0), "2026_0");
  assert.equal(reportingMonthKey(2026, 0), "2026_01");
  assert.equal(storageToReportingMonthKey("2026_0"), "2026_01");
  assert.equal(reportingToStorageMonthKey("2026_01"), "2026_0");

  assert.equal(storageMonthKey(2026, 7), "2026_7");
  assert.equal(reportingMonthKey(2026, 7), "2026_08");
  assert.equal(storageToReportingMonthKey("2026_7"), "2026_08");
  assert.equal(reportingToStorageMonthKey("2026_08"), "2026_7");

  assert.equal(storageToReportingMonthKey("2026_8"), "2026_09");
  assert.equal(reportingToStorageMonthKey("2026_09"), "2026_8");

  assert.equal(storageToReportingMonthKey("2026_11"), "2026_12");
  assert.equal(reportingToStorageMonthKey("2026_12"), "2026_11");

  assert.equal(toReportingMonthKey("2026_08"), "2026_08");
  assert.equal(toReportingMonthKey("2026_8", "calendar"), "2026_08");
  assert.equal(toReportingMonthKey("2026_7", "storage"), "2026_08");
});

const prodShape = () => {
  const propertyId = "property:legacy:alrawasi";
  const unitId = "unit:legacy:aaaaaaaaaaaaaaaaaaaaaaaa";
  const spaceId = "space:legacy:bbbbbbbbbbbbbbbbbbbbbbbb";
  return {
    propertyId, unitId, spaceId,
    units: [{
      id: unitId, propertyId, name: "شقة 101", status: "active",
      metadata: { legacyStructuralId: "101" },
    }],
    spaces: [{
      id: spaceId, propertyId, unitId, name: "شقة 101 / 3", spaceType: "partition", status: "active",
      metadata: { legacyStructuralId: "3" },
      sourceReference: "months/2026_7#units/101/partitions/3",
    }],
    tenancies: [{
      id: "tenancy:aug26:example", spaceId, unitId, propertyId, tenantId: "tenant:aug26:example",
      status: "active", startDate: "2026-08-01",
    }],
  };
};

test("resolver: Production-shaped unit 101 / partition 3 resolves uniquely", () => {
  const { units, spaces } = prodShape();
  const r = resolveLegacyRentableSpace({ spaces, units, legacyUnitId: "101", partitionId: "3", spaceType: "partition" });
  assert.equal(r.ok, true);
  assert.equal(r.space.id, spaces[0].id);
});

test("resolver: ambiguous duplicate partition fails closed", () => {
  const { units, spaces } = prodShape();
  spaces.push({ ...spaces[0], id: "space:legacy:duplicate", sourceReference: "months/2026_7#units/101/partitions/3b" });
  const r = resolveLegacyRentableSpace({ spaces, units, legacyUnitId: "101", partitionId: "3", spaceType: "partition" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "AMBIGUOUS_SPACE");
});

test("resolver: full-flat unique name resolves", () => {
  const propertyId = "property:1";
  const unitId = "unit:legacy:fullmiz1";
  const spaces = [{
    id: "space:legacy:fullmiz1", propertyId, unitId, name: "ميزان ١", spaceType: "full_unit", status: "active",
    metadata: { legacyStructuralId: "miz1" },
    sourceReference: "months/2026_7#full/miz1/rentable-space",
  }];
  const units = [{ id: unitId, propertyId, name: "ميزان ١", metadata: { legacyStructuralId: "miz1" } }];
  const r = resolveLegacyRentableSpace({ spaces, units, legacyUnitId: "miz1", partitionId: null, spaceType: "full_unit" });
  assert.equal(r.ok, true);
  assert.equal(r.space.spaceType, "full_unit");
});

test("on-demand cycle materialization is deterministic and invents zero payments", () => {
  const shape = prodShape();
  const state = blankState();
  state.financialTruthVersion = 3;
  state.canonicalControl = { state: "QAMA_ACTIVE", version: 1 };
  state.units = shape.units;
  state.rentableSpaces = shape.spaces;
  state.tenancies = shape.tenancies;
  state.balances = { company: 49175400, revenue: 7086395, deduction: 9117248 };
  const actor = { id: "yahia", role: "employee", active: true };
  const payload = {
    legacyUnitId: "101", partitionId: "3", reportingMonth: "2026_08",
    contractualAmountFils: 130000, dueDate: "2026-08-01", startDate: "2026-08-01",
    tenantName: "مستأجر تجريبي", legacyStatus: "late", legacyOpeningReservedFils: 0,
  };
  const a = executeCommand(state, "ensureCompatibleCycle", { operationId: "op:ensure:1", payload, actor, now: "2026-08-13T00:00:00.000Z" });
  const b = executeCommand(a.state, "ensureCompatibleCycle", { operationId: "op:ensure:2", payload, actor, now: "2026-08-13T00:00:01.000Z" });
  assert.equal(a.result.cycleId, compatibleCycleId(shape.spaceId, "2026_08"));
  assert.equal(a.result.created, true);
  assert.equal(b.result.created, false);
  assert.equal(b.state.cycles.length, 1);
  assert.equal(b.state.paymentIntents.length, 0);
  assert.equal(b.state.collectionEvents.length, 0);
  assert.equal(b.state.cashLots.length, 0);
});

test("legacy collected opening blocks re-collection without fabricating receipts", () => {
  const shape = prodShape();
  const state = blankState();
  state.financialTruthVersion = 3;
  state.units = shape.units;
  state.rentableSpaces = shape.spaces;
  state.tenancies = shape.tenancies;
  const actor = { id: "yahia", role: "employee", active: true };
  const ensured = executeCommand(state, "ensureCompatibleCycle", {
    operationId: "op:ens:collected",
    payload: {
      legacyUnitId: "101", partitionId: "3", reportingMonth: "2026_08",
      contractualAmountFils: 100000, dueDate: "2026-08-01",
      tenantName: "X", legacyStatus: "collected",
    },
    actor, now: "2026-08-13T00:00:00.000Z",
  });
  const cycle = ensured.state.cycles[0];
  const view = cycleProjection(cycle, ensured.state);
  assert.equal(view.remainingCollectibleFils, 0);
  assert.equal(view.legacyOpeningReservedFils, 100000);
  assert.throws(() => executeCommand(ensured.state, "createCashReceipt", {
    operationId: "op:cash:blocked",
    payload: { cycleId: cycle.id, amountFils: 1000, paymentDate: "2026-08-13" },
    actor, now: "2026-08-13T00:00:00.000Z",
  }), /OVERPAYMENT/);
});

test("first cash collection via legacy identity materializes one cycle", () => {
  const shape = prodShape();
  const state = blankState();
  state.financialTruthVersion = 3;
  state.units = shape.units;
  state.rentableSpaces = shape.spaces;
  state.tenancies = shape.tenancies;
  const actor = { id: "yahia", role: "employee", active: true };
  const payload = {
      legacyUnitId: "101", partitionId: "3", reportingMonth: "2026_08",
      contractualAmountFils: 130000, dueDate: "2026-08-01", startDate: "2026-08-01",
      tenantName: "مستأجر", amountFils: 50000, paymentDate: "2026-08-13", legacyStatus: "late",
    };
  const out = executeCommand(state, "createCashReceipt", {
    operationId: "op:cash:legacy:1",
    payload,
    actor, now: "2026-08-13T00:00:00.000Z",
  });
  assert.equal(out.state.cycles.length, 1);
  assert.equal(out.state.paymentIntents.length, 1);
  assert.equal(out.state.cashLots.length, 1);
  assert.equal(out.result.remainingCollectibleFils, 80000);
  const replay = executeCommand(out.state, "createCashReceipt", {
    operationId: "op:cash:legacy:1",
    payload,
    actor, now: "2026-08-13T00:00:00.000Z",
  });
  assert.equal(replay.replay, true);
  assert.equal(replay.state.paymentIntents.length, 1);
});

test("bank collection via legacy identity does not count pending as collected", () => {
  const shape = prodShape();
  const state = blankState();
  state.financialTruthVersion = 3;
  state.units = shape.units;
  state.rentableSpaces = shape.spaces;
  state.tenancies = shape.tenancies;
  state.balances = { company: 0, revenue: 0, deduction: 0 };
  const employee = { id: "yahia", role: "employee", active: true };
  const owner = { id: "saeed", role: "owner", active: true };
  const bank = executeCommand(state, "createBankPayment", {
    operationId: "op:bank:legacy:1",
    payload: {
      legacyUnitId: "101", partitionId: "3", reportingMonth: "2026_08",
      contractualAmountFils: 130000, dueDate: "2026-08-01",
      tenantName: "مستأجر", amountFils: 130000, paymentDate: "2026-08-13", bankReference: "REF1",
    },
    actor: employee, now: "2026-08-13T00:00:00.000Z",
  });
  assert.equal(bank.result.status, "pending");
  assert.equal(bank.state.collectionEvents.length, 0);
  assert.equal(bank.state.balances.revenue, 0);
  const approved = executeCommand(bank.state, "approveBankPayment", {
    operationId: "op:bank:approve:1",
    payload: { paymentId: bank.result.paymentId },
    actor: owner, now: "2026-08-13T01:00:00.000Z",
  });
  assert.equal(approved.state.balances.revenue, 130000);
  assert.equal(approved.state.collectionEvents.length, 1);
});

test("tenancy ambiguity fails closed", () => {
  const r = resolveActiveTenancy({
    spaceId: "space:1",
    tenancies: [
      { id: "t1", spaceId: "space:1", status: "active", tenantName: "A" },
      { id: "t2", spaceId: "space:1", status: "active", tenantName: "B" },
    ],
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "AMBIGUOUS_TENANCY");
});
