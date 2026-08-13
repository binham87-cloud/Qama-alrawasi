/**
 * R1.1 product contract: visible محصّل requires financial evidence.
 * STATUS ALONE MUST NEVER MINT MONEY; status alone must not clear arrears.
 *
 * Classification of changed expectations vs R1:
 * C = R1-01/02/04 encoded "writable محصّل without money" — obsolete under owner product contract.
 * A = financial anti-mint / vacate preserve / arrears remaining (kept/strengthened).
 * B = occupancy/transfer/employee approval operational contracts.
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

function extractDisplayStatusFn(source) {
  const paidStart = source.indexOf("function paidValue(x){");
  const displayStart = source.indexOf("function displayStatus(x){");
  const displayEnd = source.indexOf("\n// ===== لقطة القيم قبل التعديل", displayStart);
  assert.ok(paidStart > 0 && displayStart > paidStart && displayEnd > displayStart);
  // Minimal stubs so displayStatus can run without the full app runtime.
  const prelude = `
    const S = { year: 2026, month: 7, operationalReadModel: null };
    const NOW_Y = 2026, NOW_M = 7;
    function operationalTenantFinancial(){ return null; }
    function isDatePast(d){ return String(d||"") < "2026-08-13"; }
    function needsAction(){ return false; }
    function dueDateOf(x){ return x?.due_date || ""; }
    function isPartialPaid(x){ return !!x?.partial && remainingValue(x) > 0; }
  `;
  // paidValue through displayStatus inclusive
  const body = source.slice(paidStart, displayEnd);
  // eslint-disable-next-line no-new-func
  return new Function(`${prelude}\n${body}\nreturn { paidValue, remainingValue, displayStatus };`)();
}

const ui = extractDisplayStatusFn(html);

test("R1.1-01 build + html/public sync; occupancy dropdown has no writable محصّل", () => {
  assert.equal(html, publicHtml);
  assert.match(html, /qama-unified-final-2026-08-14\.3/);
  assert.match(html, /occ=\["late","vacant","staff"\]/);
  assert.match(html, /\["late","متأخر"\],\["vacant","فارغ"\],\["staff","موظفين"\]/);
  assert.doesNotMatch(html, /occ=\["collected","late","vacant","staff"\]/);
});

test("R1.1-02 status=collected alone is rejected and mints zero money (A; was C writable)", () => {
  assert.throws(() => applyOwnerRentalPatch(monthDoc({}), {
    target: { entityType: "partition", unitId: "u1", entityId: 1 },
    patch: { status: "collected" },
    baseVersion: 0,
  }, owner), /COLLECTION_REQUIRES_FINANCIAL_COMMAND/);
  // Legacy stale status=collected with paid=0 must not project Actual Collected.
  const legacy = projectLegacyMonthFinance(monthDoc({ status: "collected", paid_amount: 0 }).data, 2026, 7);
  assert.equal(legacy.cards.collectedFils, 0);
  assert.equal(legacy.cards.arrearsFils, money(1000));
});

test("R1.1-03 paid_amount via operational patch remains denied (A)", () => {
  assert.throws(() => applyOwnerRentalPatch(monthDoc({}), {
    target: { entityType: "partition", unitId: "u1", entityId: 1 },
    patch: { paid_amount: 1000 },
    baseVersion: 0,
  }, owner), /OPERATIONAL_FIELD_DENIED/);
});

test("R1.1-04 employee cannot approve operational محصّل without financial command (B; was C)", () => {
  assert.throws(() => applyApprovedBusinessRequest(monthDoc({}), {
    type: "update_partition",
    payload: { unitId: "u1", partId: 1, fields: { status: "collected", tenant: "T" } },
  }, owner), /COLLECTION_REQUIRES_FINANCIAL_COMMAND/);
});

test("R1.1-04b approve strips ephemeral UI fields like _bankUnitRef (B)", () => {
  const out = applyApprovedBusinessRequest(monthDoc({ note: "" }), {
    type: "update_partition",
    payload: {
      unitId: "u1", partId: 1,
      fields: { note: "ملاحظة موظف للاعتماد", _bankUnitRef: "partition:u1:1", _legacyUnitId: "u1" },
    },
  }, owner);
  const part = out.data.units[0].partitions[0];
  assert.equal(part.note, "ملاحظة موظف للاعتماد");
  assert.equal(part.rent, 1000);
  assert.equal(part._bankUnitRef, undefined);
});

test("R1.1-05 sanitize keeps transfer from inventing collected money (B)", () => {
  assert.match(html, /if\(out\.fields\.status==="collected"\|\|out\.fields\.status==="partial"\) out\.fields\.status="late"/);
  assert.match(html, /rentalAllow/);
  assert.match(html, /k\.startsWith\("_"\)/);
});

test("R1.1-06 transfer does not invent/transfer paid; preserves source paid into vacatedCollected (A/B)", () => {
  const doc = {
    data: {
      units: [
        { id: "a", partitions: [{ id: 1, rent: 1200, status: "late", tenant: "Old", paid_amount: 1200, partial: false, version: 0, operationalVersion: 0 }] },
        { id: "b", partitions: [{ id: 2, rent: 0, status: "vacant", tenant: "", version: 0, operationalVersion: 0 }] },
      ],
      full: [],
    },
  };
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
  assert.equal(out.data.vacatedCollected?.[0]?.amount, 1200);
  assert.equal(projectLegacyMonthFinance(out.data, 2026, 7).cards.collectedFils, money(1200));
});

test("R1.1-07 vacate clears residue, preserves proven paid_amount into vacatedCollected (A)", () => {
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
  assert.equal(out.data.vacatedCollected?.[0]?.amount, 500);
  assert.equal(projectLegacyMonthFinance(out.data, 2026, 7).cards.collectedFils, money(500));
});

test("R1.1-08 new tenancy does not inherit paid; historical vacatedCollected remains (A)", () => {
  const vacated = applyOwnerRentalPatch(monthDoc({ status: "late", paid_amount: 900, tenant: "Old" }), {
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
  assert.equal(ui.displayStatus(part), "late");
  assert.equal(projectLegacyMonthFinance(restored.data, 2026, 7).cards.collectedFils, money(900));
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

test("R1.1-09 cash collection increases Actual Collected and Employee Holding (A)", () => {
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

test("R1.1-10 bank collection increases Actual Collected without employee cash holding (A)", () => {
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

test("R1.1-11 duplicate cash operationId does not duplicate money (A)", () => {
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

test("R1.1-12 status collected alone does not invent cycle opening reserved fils (A)", () => {
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

test("R1.1-13 explicit paid opening evidence still blocks over-collection (A)", () => {
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

test("R1.1-14 unpaid status=collected is NOT visible محصّل and stays in arrears (A/B)", () => {
  const unpaid = { rent: 1000, status: "collected", paid_amount: 0, due_date: "2026-08-01", tenant: "U" };
  assert.equal(ui.paidValue(unpaid), 0);
  assert.equal(ui.remainingValue(unpaid), 1000);
  assert.equal(ui.displayStatus(unpaid), "late");
  const proj = projectLegacyMonthFinance({ units: [{ id: "u1", partitions: [unpaid] }], full: [] }, 2026, 7);
  assert.equal(proj.cards.arrearsFils, money(1000));
  assert.equal(proj.cards.collectedFils, 0);
});

test("R1.1-15 partial payment is not fully محصّل; remaining correct (B)", () => {
  const partial = { rent: 1000, status: "late", paid_amount: 400, partial: true, due_date: "2026-08-01" };
  assert.equal(ui.paidValue(partial), 400);
  assert.equal(ui.remainingValue(partial), 600);
  assert.equal(ui.displayStatus(partial), "partial");
  const proj = projectLegacyMonthFinance({ units: [{ id: "u1", partitions: [partial] }], full: [] }, 2026, 7);
  assert.equal(proj.cards.arrearsFils, money(600));
  assert.equal(proj.cards.collectedFils, money(400));
});

test("R1.1-16 full financial evidence yields visible محصّل and leaves arrears (B)", () => {
  const full = { rent: 1000, status: "late", paid_amount: 1000, due_date: "2026-08-01" };
  assert.equal(ui.paidValue(full), 1000);
  assert.equal(ui.remainingValue(full), 0);
  assert.equal(ui.displayStatus(full), "collected");
  const proj = projectLegacyMonthFinance({ units: [{ id: "u1", partitions: [full] }], full: [] }, 2026, 7);
  assert.equal(proj.cards.arrearsFils, 0);
  assert.equal(proj.cards.collectedFils, money(1000));
});

test("R1.1-17 full cash collection then UI status is محصّل via operational remaining (A/B)", () => {
  const state = blankFinancialState();
  const out = executeCommand(state, "createCashReceipt", {
    operationId: "op:r1:fullcash",
    payload: {
      legacyUnitId: "101", partitionId: "3", reportingMonth: "2026_08",
      contractualAmountFils: money(1000), dueDate: "2026-08-01", startDate: "2026-08-01",
      tenantName: "T", amountFils: money(1000), paymentDate: "2026-08-13", legacyStatus: "late",
    },
    actor: employee, now: "2026-08-13T00:00:00.000Z",
  });
  const proj = monthlyOperationalProjection(out.state, "2026_08", "2026-08-13");
  assert.equal(proj.cards.collectedFils, money(1000));
  assert.equal(proj.cards.arrearsFils, 0);
  const row = (proj.details?.target || []).find((x) => Number(x.remainingFils || 0) === 0);
  assert.ok(row);
});

test("R1.1-18 hybrid month keeps uncovered legacy paid_amount in Actual Collected (A)", () => {
  const state = blankFinancialState();
  state.legacyMonthData = {
    units: [{
      id: "u_hat",
      partitions: [
        { id: 1, rent: 1000, status: "late", paid_amount: 0, tenant: "A", due_date: "2026-08-01" },
        { id: 2, rent: 2000, status: "late", paid_amount: 2000, tenant: "B", due_date: "2026-08-01" },
      ],
    }],
    full: [],
    vacatedCollected: [],
  };
  state.legacyMonthYear = 2026;
  state.legacyMonthIndex0 = 7;
  const paid = executeCommand(state, "createCashReceipt", {
    operationId: "op:r1:hybrid",
    payload: {
      legacyUnitId: "101", partitionId: "3", reportingMonth: "2026_08",
      contractualAmountFils: money(1000), dueDate: "2026-08-01", startDate: "2026-08-01",
      tenantName: "A", amountFils: money(1000), paymentDate: "2026-08-13", legacyStatus: "late",
    },
    actor: employee, now: "2026-08-13T00:00:00.000Z",
  });
  // Attach legacy ids matching residual uncovered unit "u_hat|2" while live cycle is for 101/3.
  paid.state.legacyMonthData = state.legacyMonthData;
  paid.state.legacyMonthYear = 2026;
  paid.state.legacyMonthIndex0 = 7;
  const proj = monthlyOperationalProjection(paid.state, "2026_08", "2026-08-13");
  assert.equal(proj.compatibilitySource, "legacy_month_hybrid");
  assert.equal(proj.cards.collectedFils, money(1000) + money(2000));
});
