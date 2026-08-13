/**
 * R1 operational restoration regressions.
 * محصّل is a familiar occupancy status; Actual Collected stays event-backed only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyOwnerRentalPatch, applyApprovedBusinessRequest } from "../functions/domain/operational_commands.mjs";
import { projectLegacyMonthFinance } from "../functions/domain/legacy_month_projection.mjs";
import { blankState, executeCommand } from "../functions/domain/command_processor.mjs";
import { cycleProjection } from "../functions/domain/financial_engine.mjs";
import { monthlyOperationalProjection } from "../functions/domain/canonical_selectors.mjs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const publicHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const owner = { id: "saeed", role: "owner", active: true };
const employee = { id: "yahia", role: "employee", active: true };
const money = (aed) => Math.round(aed * 100);

function monthDoc(part) {
  return {
    data: {
      units: [{ id: "u1", name: "شقة", partitions: [{ id: 1, rent: 1000, status: "late", tenant: "T", phone: "050", version: 0, operationalVersion: 0, ...part }] }],
      full: [],
      transactions: [],
    },
  };
}

test("R1-01 محصّل is visible again in partition and full status controls", () => {
  assert.equal(html, publicHtml);
  assert.match(html, /occ=\["collected","late","vacant","staff"\]/);
  assert.match(html, /\["collected","محصّل"\],\["late","متأخر"\],\["vacant","فارغ"\],\["staff","موظفين"\]/);
  assert.match(html, /qama-unified-final-2026-08-14\.1/);
});

test("R1-02 status=collected alone creates zero financial movement and zero Actual Collected", () => {
  const before = monthDoc({});
  const out = applyOwnerRentalPatch(before, {
    target: { entityType: "partition", unitId: "u1", entityId: 1 },
    patch: { status: "collected" },
    baseVersion: 0,
  }, owner);
  assert.equal(out.financialEffectFils, 0);
  const part = out.data.units[0].partitions[0];
  assert.equal(part.status, "collected");
  assert.equal(Number(part.paid_amount || 0), 0);
  const legacy = projectLegacyMonthFinance(out.data, 2026, 7);
  assert.equal(legacy.cards.collectedFils, 0);
  assert.equal(legacy.cards.targetFils, money(1000));
  assert.equal(legacy.cards.depositedFils, 0);
});

test("R1-03 paid_amount via operational patch remains denied", () => {
  assert.throws(() => applyOwnerRentalPatch(monthDoc({}), {
    target: { entityType: "partition", unitId: "u1", entityId: 1 },
    patch: { paid_amount: 1000 },
    baseVersion: 0,
  }, owner), /OPERATIONAL_FIELD_DENIED/);
});

test("R1-04 employee update_partition can request operational محصّل without money fields", () => {
  const out = applyApprovedBusinessRequest(monthDoc({}), {
    type: "update_partition",
    payload: { unitId: "u1", partId: 1, fields: { status: "collected", tenant: "T" } },
  }, owner);
  assert.equal(out.financialEffectFils, 0);
  assert.equal(out.data.units[0].partitions[0].status, "collected");
  assert.equal(Number(out.data.units[0].partitions[0].paid_amount || 0), 0);
});

test("R1-05 sanitize keeps transfer from inventing collected money (client contract present)", () => {
  assert.match(html, /if\(out\.fields\.status==="collected"\|\|out\.fields\.status==="partial"\) out\.fields\.status="late"/);
});

test("R1-06 transfer does not invent collected/paid on destination", () => {
  const doc = {
    data: {
      units: [
        { id: "a", partitions: [{ id: 1, rent: 1200, status: "collected", tenant: "Old", paid_amount: 1200, partial: true, version: 0, operationalVersion: 0 }] },
        { id: "b", partitions: [{ id: 2, rent: 0, status: "vacant", tenant: "", version: 0, operationalVersion: 0 }] },
      ],
      full: [],
    },
  };
  // Client sanitize remaps collected→late before submit; server also rejects inventing collected.
  assert.throws(() => applyApprovedBusinessRequest(doc, {
    type: "transfer_tenant",
    payload: {
      fromUnitId: "a", fromPartId: 1, toUnitId: "b", toPartId: 2,
      fields: { status: "collected", tenant: "Old", rent: 1200 },
    },
  }, owner), /COLLECTION_REQUIRES_FINANCIAL_COMMAND/);
  const out = applyApprovedBusinessRequest(doc, {
    type: "transfer_tenant",
    payload: {
      fromUnitId: "a", fromPartId: 1, toUnitId: "b", toPartId: 2,
      fields: { status: "late", tenant: "Old", rent: 1200 },
    },
  }, owner);
  assert.equal(out.financialEffectFils, 0);
  const src = out.data.units[0].partitions[0];
  const dst = out.data.units[1].partitions[0];
  assert.equal(src.status, "vacant");
  assert.equal(Number(src.paid_amount || 0), 0);
  assert.equal(dst.status, "late");
  assert.equal(Number(dst.paid_amount || 0), 0);
  assert.equal(dst.tenant, "Old");
});

test("R1-07 vacate clears display residue but creates no financial events", () => {
  const out = applyOwnerRentalPatch(monthDoc({ status: "late", paid_amount: 500, partial: true, collectedBy: "yahia" }), {
    target: { entityType: "partition", unitId: "u1", entityId: 1 },
    patch: { status: "vacant" },
    baseVersion: 0,
  }, owner);
  assert.equal(out.financialEffectFils, 0);
  const part = out.data.units[0].partitions[0];
  assert.equal(part.status, "vacant");
  assert.equal(part.paid_amount, 0);
  assert.equal(part.partial, false);
  assert.equal(part.collectedBy, "");
});

test("R1-08 new tenancy fields do not inherit prior paid residue via status-only restore", () => {
  const vacated = applyOwnerRentalPatch(monthDoc({ status: "collected", paid_amount: 900, tenant: "Old" }), {
    target: { entityType: "partition", unitId: "u1", entityId: 1 },
    patch: { status: "vacant" },
    baseVersion: 0,
  }, owner);
  const restored = applyOwnerRentalPatch({ data: vacated.data }, {
    target: { entityType: "partition", unitId: "u1", entityId: 1 },
    patch: { status: "late", tenant: "New", start_date: "2026-08-01", due_date: "2026-09-01", rent: 1000 },
    baseVersion: vacated.version,
  }, owner);
  const part = restored.data.units[0].partitions[0];
  assert.equal(part.tenant, "New");
  assert.equal(Number(part.paid_amount || 0), 0);
  assert.equal(projectLegacyMonthFinance(restored.data, 2026, 7).cards.collectedFils, 0);
});

function blankFinancialState() {
  const propertyId = "property:legacy:alrawasi";
  const unitId = "unit:legacy:aaaaaaaaaaaaaaaaaaaaaaaa";
  const spaceId = "space:legacy:bbbbbbbbbbbbbbbbbbbbbbbb";
  const state = blankState();
  state.financialTruthVersion = 3;
  state.units = [{ id: unitId, propertyId, name: "شقة 101", status: "active", metadata: { legacyStructuralId: "101" } }];
  state.rentableSpaces = [{
    id: spaceId, propertyId, unitId, name: "شقة 101 / 3", spaceType: "partition", status: "active",
    metadata: { legacyStructuralId: "3" },
    sourceReference: "months/2026_7#units/101/partitions/3",
  }];
  state.tenancies = [{
    id: "tenancy:r1", spaceId, unitId, propertyId, tenantId: "tenant:r1",
    status: "active", startDate: "2026-08-01",
  }];
  state.balances = { company: 0, revenue: 0, deduction: 0 };
  return state;
}

test("R1-09 cash collection increases Actual Collected and Employee Holding", () => {
  const state = blankFinancialState();
  const out = executeCommand(state, "createCashReceipt", {
    operationId: "op:r1:cash",
    payload: {
      legacyUnitId: "101", partitionId: "3", reportingMonth: "2026_08",
      contractualAmountFils: money(1000), dueDate: "2026-08-01", startDate: "2026-08-01",
      tenantName: "T", amountFils: money(400), paymentDate: "2026-08-13", legacyStatus: "late",
    },
    actor: employee, now: "2026-08-13T00:00:00.000Z",
  });
  assert.equal(out.state.cashLots.length, 1);
  assert.equal(out.state.collectionEvents.length, 1);
  const proj = monthlyOperationalProjection(out.state, "2026_08", "2026-08-13");
  assert.equal(proj.cards.collectedFils, money(400));
  assert.equal(proj.cards.receivedNotDepositedFils, money(400));
  assert.equal(proj.cards.depositedFils, 0);
});

test("R1-10 bank collection increases Actual Collected without employee cash holding", () => {
  const state = blankFinancialState();
  const bank = executeCommand(state, "createBankPayment", {
    operationId: "op:r1:bank",
    payload: {
      legacyUnitId: "101", partitionId: "3", reportingMonth: "2026_08",
      contractualAmountFils: money(1000), dueDate: "2026-08-01", startDate: "2026-08-01",
      tenantName: "T", amountFils: money(300), paymentDate: "2026-08-13", legacyStatus: "late",
    },
    actor: employee, now: "2026-08-13T00:00:00.000Z",
  });
  assert.equal(bank.result.status, "pending");
  const approved = executeCommand(bank.state, "approveBankPayment", {
    operationId: "op:r1:bank:approve",
    payload: { paymentId: bank.result.paymentId },
    actor: owner, now: "2026-08-13T00:01:00.000Z",
  });
  const proj = monthlyOperationalProjection(approved.state, "2026_08", "2026-08-13");
  assert.equal(proj.cards.collectedFils, money(300));
  assert.equal(proj.cards.depositedFils, money(300));
  assert.equal(proj.cards.receivedNotDepositedFils, 0);
  assert.equal(approved.state.cashLots.length, 0);
});

test("R1-11 duplicate cash operationId does not duplicate money", () => {
  const state = blankFinancialState();
  const payload = {
    legacyUnitId: "101", partitionId: "3", reportingMonth: "2026_08",
    contractualAmountFils: money(1000), dueDate: "2026-08-01", startDate: "2026-08-01",
    tenantName: "T", amountFils: money(250), paymentDate: "2026-08-13", legacyStatus: "late",
  };
  const a = executeCommand(state, "createCashReceipt", { operationId: "op:r1:dup", payload, actor: employee, now: "2026-08-13T00:00:00.000Z" });
  const b = executeCommand(a.state, "createCashReceipt", { operationId: "op:r1:dup", payload, actor: employee, now: "2026-08-13T00:00:01.000Z" });
  assert.equal(b.replay, true);
  assert.equal(b.state.paymentIntents.length, 1);
  assert.equal(b.state.cashLots.length, 1);
});

test("R1-12 status collected alone does not invent cycle opening reserved fils", () => {
  const state = blankFinancialState();
  const ensured = executeCommand(state, "ensureCompatibleCycle", {
    operationId: "op:r1:ens",
    payload: {
      legacyUnitId: "101", partitionId: "3", reportingMonth: "2026_08",
      contractualAmountFils: money(1000), dueDate: "2026-08-01",
      tenantName: "X", legacyStatus: "collected",
    },
    actor: employee, now: "2026-08-13T00:00:00.000Z",
  });
  const cycle = ensured.state.cycles[0];
  const view = cycleProjection(cycle, ensured.state);
  assert.equal(view.legacyOpeningReservedFils, 0);
  assert.equal(view.remainingCollectibleFils, money(1000));
});

test("R1-13 explicit paid opening evidence still blocks over-collection", () => {
  const state = blankFinancialState();
  const ensured = executeCommand(state, "ensureCompatibleCycle", {
    operationId: "op:r1:ens:paid",
    payload: {
      legacyUnitId: "101", partitionId: "3", reportingMonth: "2026_08",
      contractualAmountFils: money(1000), dueDate: "2026-08-01",
      tenantName: "X", legacyStatus: "collected",
      legacyOpeningReservedFils: money(1000),
    },
    actor: employee, now: "2026-08-13T00:00:00.000Z",
  });
  const cycle = ensured.state.cycles[0];
  assert.equal(cycleProjection(cycle, ensured.state).remainingCollectibleFils, 0);
  assert.throws(() => executeCommand(ensured.state, "createCashReceipt", {
    operationId: "op:r1:blocked",
    payload: { cycleId: cycle.id, amountFils: 1000, paymentDate: "2026-08-13" },
    actor: employee, now: "2026-08-13T00:00:00.000Z",
  }), /OVERPAYMENT/);
});
