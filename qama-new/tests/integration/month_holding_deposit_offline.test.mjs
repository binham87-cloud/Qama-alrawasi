/**
 * Month isolation, future-holding after vacancy, deposit durability, offline safety.
 * No production writes. In-memory command harness only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  freshDb, run, bootstrapOwner, seedBuilding, createUser, actorFrom, opId,
} from "../helpers/commands.mjs";
import { buildDashboardFromDump } from "../../functions/services/readModel.mjs";
import { sharedHoldingAllPeriodsFils, RECEIPT_STATE, APPROVAL_STATE } from "../../functions/domain/finance.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const html = readFileSync(resolve(root, "src/frontend/index.html"), "utf8");
const bridge = readFileSync(resolve(root, "src/frontend/qama-engine-bridge.js"), "utf8");

function spaceOn(dash, spaceId) {
  return (dash.unitsTree || [])
    .flatMap((u) => u.spaces || [])
    .find((s) => s.spaceId === spaceId)
    || (dash.spaces || []).find((s) => s.id === spaceId || s.spaceId === spaceId);
}

async function setup() {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const building = await seedBuilding(db, owner);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "1111" });
  await run(db, owner, "updateRentalTenant", {
    rentalId: building.rental.rentalId, tenantName: "Tenant A", effectivePeriod: "2026-09",
  }, opId("setup-tenant"));
  await run(db, owner, "updateRentalRent", {
    rentalId: building.rental.rentalId, contractualAmountFils: 100000, effectivePeriod: "2026-09",
  }, opId("setup-rent"));
  return { db, owner, building, yahia };
}

test("A1 October vacancy does not rewrite September", async () => {
  const { db, owner, building } = await setup();
  const spaceId = building.space.spaceId;
  const before = buildDashboardFromDump(db, "2026-09", "2026-09-20");
  const beforeReceipts = db.dump("receipts").map((r) => r.id);

  await run(db, owner, "generateObligations", { period: "2026-10" }, opId("a1-oct"));
  await run(db, owner, "endTenancy", {
    rentalId: building.rental.rentalId,
    endDate: "2026-10-08",
    reason: "إخلاء أكتوبر",
    arrearsDecision: "retain",
  }, opId("a1-vac"));

  const sep = buildDashboardFromDump(db, "2026-09", "2026-10-08");
  const sp = spaceOn(sep, spaceId);
  assert.equal(sp.occupancy, "rented");
  assert.equal(sp.tenantName, "Tenant A");
  assert.equal(sp.dueFils, 100000);
  assert.equal(sep.summary.targetFils, 100000);
  assert.deepEqual(db.dump("receipts").map((r) => r.id), beforeReceipts);
  assert.equal(sep.summary.collectedFils, before.summary.collectedFils);

  const oct = buildDashboardFromDump(db, "2026-10", "2026-10-08");
  assert.equal(spaceOn(oct, spaceId).occupancy, "vacant");
  assert.equal(db.dump("receipts").filter((r) => r.state === RECEIPT_STATE.REVERSED).length, 0);
});

test("A2 October rent change leaves September at 1000", async () => {
  const { db, owner, building } = await setup();
  await run(db, owner, "generateObligations", { period: "2026-10" }, opId("a2-gen"));
  await run(db, owner, "updateRentalRent", {
    rentalId: building.rental.rentalId,
    contractualAmountFils: 120000,
    effectivePeriod: "2026-10",
  }, opId("a2-rent"));
  const sep = buildDashboardFromDump(db, "2026-09", "2026-10-08");
  const oct = buildDashboardFromDump(db, "2026-10", "2026-10-08");
  assert.equal(spaceOn(sep, building.space.spaceId).dueFils, 100000);
  assert.equal(sep.summary.targetFils, 100000);
  assert.equal(spaceOn(oct, building.space.spaceId).dueFils, 120000);
  assert.equal(oct.summary.targetFils, 120000);
});

test("A3b October phone change leaves September phone", async () => {
  const { db, owner, building } = await setup();
  await run(db, owner, "updateRentalTenant", {
    rentalId: building.rental.rentalId, tenantPhone: "0500000001", effectivePeriod: "2026-09",
  }, opId("a3b-phone0"));
  await run(db, owner, "generateObligations", { period: "2026-10" }, opId("a3b-gen"));
  await run(db, owner, "updateRentalTenant", {
    rentalId: building.rental.rentalId, tenantPhone: "0500000002", effectivePeriod: "2026-10",
  }, opId("a3b-phone"));
  const sep = buildDashboardFromDump(db, "2026-09", "2026-10-08");
  const oct = buildDashboardFromDump(db, "2026-10", "2026-10-08");
  assert.equal(spaceOn(sep, building.space.spaceId).tenantPhone, "0500000001");
  assert.equal(spaceOn(oct, building.space.spaceId).tenantPhone, "0500000002");
});

test("A3 October tenant change leaves September as Tenant A", async () => {
  const { db, owner, building } = await setup();
  await run(db, owner, "generateObligations", { period: "2026-10" }, opId("a3-gen"));
  await run(db, owner, "updateRentalTenant", {
    rentalId: building.rental.rentalId,
    tenantName: "Tenant B",
    effectivePeriod: "2026-10",
  }, opId("a3-ten"));
  const sep = buildDashboardFromDump(db, "2026-09", "2026-10-08");
  const oct = buildDashboardFromDump(db, "2026-10", "2026-10-08");
  assert.equal(spaceOn(sep, building.space.spaceId).tenantName, "Tenant A");
  assert.equal(spaceOn(oct, building.space.spaceId).tenantName, "Tenant B");
});

test("A4 November rent change does not mutate September or October", async () => {
  const { db, owner, building } = await setup();
  await run(db, owner, "generateObligations", { period: "2026-10" }, opId("a4-oct"));
  await run(db, owner, "generateObligations", { period: "2026-11" }, opId("a4-nov"));
  const sepBefore = buildDashboardFromDump(db, "2026-09", "2026-10-08").summary.targetFils;
  const octBefore = buildDashboardFromDump(db, "2026-10", "2026-10-08").summary.targetFils;
  await run(db, owner, "updateRentalRent", {
    rentalId: building.rental.rentalId,
    contractualAmountFils: 150000,
    effectivePeriod: "2026-11",
  }, opId("a4-rent"));
  assert.equal(buildDashboardFromDump(db, "2026-09", "2026-11-02").summary.targetFils, sepBefore);
  assert.equal(buildDashboardFromDump(db, "2026-10", "2026-11-02").summary.targetFils, octBefore);
  assert.equal(buildDashboardFromDump(db, "2026-11", "2026-11-02").summary.targetFils, 150000);
});

test("A5 rebuild and month round-trip keep September identical", async () => {
  const { db, owner, building } = await setup();
  await run(db, owner, "generateObligations", { period: "2026-10" }, opId("a5-oct"));
  await run(db, owner, "endTenancy", {
    rentalId: building.rental.rentalId, endDate: "2026-10-08",
    reason: "إخلاء", arrearsDecision: "retain",
  }, opId("a5-vac"));
  const a = buildDashboardFromDump(db, "2026-09", "2026-10-08");
  const b = buildDashboardFromDump(db, "2026-10", "2026-10-09");
  const c = buildDashboardFromDump(db, "2026-09", "2026-10-10");
  assert.equal(spaceOn(a, building.space.spaceId).occupancy, "rented");
  assert.equal(spaceOn(c, building.space.spaceId).occupancy, "rented");
  assert.equal(spaceOn(c, building.space.spaceId).tenantName, spaceOn(a, building.space.spaceId).tenantName);
  assert.equal(c.summary.targetFils, a.summary.targetFils);
  assert.equal(c.summary.collectedFils, a.summary.collectedFils);
  assert.equal(spaceOn(b, building.space.spaceId).occupancy, "vacant");
});

test("B1 advance November cash leaves rent-month at 0 and global holding at 900", async () => {
  const { db, owner, building, yahia } = await setup();
  await run(db, owner, "generateObligations", { period: "2026-10" }, opId("b1-oct"));
  await run(db, owner, "generateObligations", { period: "2026-11" }, opId("b1-nov"));
  const novOb = db.dump("obligations").find(
    (o) => o.rentalId === building.rental.rentalId && o.period === "2026-11" && o.state === "active",
  );
  assert.ok(novOb);
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: novOb.id, amountFils: 90000, collectionDate: "2026-10-05",
  }, opId("b1-cash"));
  await run(db, owner, "endTenancy", {
    rentalId: building.rental.rentalId, endDate: "2026-10-08",
    reason: "إخلاء قبل نوفمبر", arrearsDecision: "retain",
  }, opId("b1-vac"));

  const nov = buildDashboardFromDump(db, "2026-11", "2026-10-08");
  assert.equal(nov.summary.targetFils, 0);
  assert.equal(nov.summary.collectedFils, 0);
  assert.equal(nov.summary.holdingFils, 0);
  assert.equal(nov.summary.periodCashCollectedFils || 0, 0);
  const receipt = db.dump("receipts").find((r) => r.obligationId === novOb.id);
  assert.equal(receipt.state, RECEIPT_STATE.RECOGNIZED);
  assert.equal(sharedHoldingAllPeriodsFils({
    receipts: db.dump("receipts"), deposits: db.dump("deposits"),
  }), 90000);
  const sep = buildDashboardFromDump(db, "2026-09", "2026-10-08");
  assert.equal(spaceOn(sep, building.space.spaceId).occupancy, "rented");
  assert.equal(sep.summary.targetFils, 100000);
});

test("B2 reversing the advance cash zeros global holding", async () => {
  const { db, owner, building, yahia } = await setup();
  await run(db, owner, "generateObligations", { period: "2026-11" }, opId("b2-nov"));
  const novOb = db.dump("obligations").find(
    (o) => o.rentalId === building.rental.rentalId && o.period === "2026-11",
  );
  const cash = await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: novOb.id, amountFils: 90000, collectionDate: "2026-10-05",
  }, opId("b2-cash"));
  await run(db, owner, "endTenancy", {
    rentalId: building.rental.rentalId, endDate: "2026-10-08",
    reason: "إخلاء", arrearsDecision: "retain",
  }, opId("b2-vac"));
  await run(db, owner, "reverseReceipt", {
    receiptId: cash.receiptId, reason: "استرجاع",
  }, opId("b2-rev"));
  assert.equal(sharedHoldingAllPeriodsFils({
    receipts: db.dump("receipts"), deposits: db.dump("deposits"),
  }), 0);
  const nov = buildDashboardFromDump(db, "2026-11", "2026-10-09");
  assert.equal(nov.summary.holdingFils, 0);
  assert.equal(nov.summary.collectedFils, 0);
});

test("B3 September collection stays after October vacancy", async () => {
  const { db, owner, building, yahia } = await setup();
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 100000, collectionDate: "2026-09-05",
  }, opId("b3-cash"));
  const before = buildDashboardFromDump(db, "2026-09", "2026-09-20");
  await run(db, owner, "generateObligations", { period: "2026-10" }, opId("b3-oct"));
  await run(db, owner, "endTenancy", {
    rentalId: building.rental.rentalId, endDate: "2026-10-08",
    reason: "إخلاء", arrearsDecision: "retain",
  }, opId("b3-vac"));
  const after = buildDashboardFromDump(db, "2026-09", "2026-10-08");
  assert.equal(after.summary.collectedFils, before.summary.collectedFils);
  assert.equal(after.summary.holdingFils, before.summary.holdingFils);
  assert.equal(after.summary.targetFils, before.summary.targetFils);
  assert.equal(db.dump("receipts").filter((r) => r.state === RECEIPT_STATE.RECOGNIZED).length, 1);
});

test("C1-C3 deposit survives rebuild and approved holding applies once", async () => {
  const { db, owner, building, yahia } = await setup();
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 100000, collectionDate: "2026-09-05",
  }, opId("c-cash"));
  const depOp = "c-dep-same-op-01";
  const dep = await run(db, owner, "submitDeposit", {
    amountFils: 40000,
    depositDate: "2026-09-10",
    destinationAccountId: building.account.accountId,
    sourceKind: "holding",
    sourcePeriod: "2026-09",
    period: "2026-09",
    reference: "yahya-dep",
  }, depOp);
  const again = await run(db, owner, "submitDeposit", {
    amountFils: 40000,
    depositDate: "2026-09-10",
    destinationAccountId: building.account.accountId,
    sourceKind: "holding",
    sourcePeriod: "2026-09",
    period: "2026-09",
    reference: "yahya-dep",
  }, depOp);
  assert.equal(again.replay, true);
  assert.equal(db.dump("deposits").filter((d) => d.amountFils === 40000).length, 1);
  const first = buildDashboardFromDump(db, "2026-09", "2026-09-10");
  const second = buildDashboardFromDump(db, "2026-10", "2026-10-01");
  const third = buildDashboardFromDump(db, "2026-09", "2026-10-02");
  assert.ok(first.deposits.some((d) => d.id === dep.depositId && d.state === APPROVAL_STATE.APPROVED));
  assert.ok(third.deposits.some((d) => d.id === dep.depositId));
  assert.equal(first.summary.holdingFils, 60000);
  assert.equal(third.summary.holdingFils, 60000);
  assert.equal(second.summary.holdingFils, 0);
  void second;
});

test("C2 pending employee deposit stays and does not reduce holding", async () => {
  const { db, owner, building, yahia } = await setup();
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 100000, collectionDate: "2026-09-05",
  }, opId("c2-cash"));
  const dep = await run(db, actorFrom(yahia), "submitDeposit", {
    amountFils: 25000,
    depositDate: "2026-09-11",
    destinationAccountId: building.account.accountId,
    sourceKind: "holding",
    sourcePeriod: "2026-09",
    period: "2026-09",
  }, opId("c2-dep"));
  const dash = buildDashboardFromDump(db, "2026-09", "2026-09-11");
  const row = dash.deposits.find((d) => d.id === dep.depositId);
  assert.ok(row);
  assert.equal(row.state, APPROVAL_STATE.PENDING);
  assert.equal(dash.summary.holdingFils, 100000);
  const again = buildDashboardFromDump(db, "2026-09", "2026-09-12");
  assert.ok(again.deposits.some((d) => d.id === dep.depositId && d.state === APPROVAL_STATE.PENDING));
});

test("C4 rejected deposit remains with zero effect", async () => {
  const { db, owner, building, yahia } = await setup();
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 100000, collectionDate: "2026-09-05",
  }, opId("c4-cash"));
  const dep = await run(db, actorFrom(yahia), "submitDeposit", {
    amountFils: 10000,
    depositDate: "2026-09-12",
    destinationAccountId: building.account.accountId,
    sourceKind: "holding",
    sourcePeriod: "2026-09",
    period: "2026-09",
  }, opId("c4-dep"));
  await run(db, owner, "rejectDeposit", { depositId: dep.depositId, reason: "رفض" }, opId("c4-rej"));
  const doc = db.dump("deposits").find((d) => d.id === dep.depositId);
  assert.equal(doc.state, APPROVAL_STATE.REJECTED);
  const dash = buildDashboardFromDump(db, "2026-09", "2026-09-12");
  assert.ok(dash.deposits.some((d) => d.id === dep.depositId && d.state === "rejected"));
  assert.equal(dash.summary.holdingFils, 100000);
});

test("C5 external deposit survives and does not reduce holding", async () => {
  const { db, owner, building, yahia } = await setup();
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 100000, collectionDate: "2026-09-05",
  }, opId("c5-cash"));
  const dep = await run(db, owner, "submitDeposit", {
    amountFils: 30000,
    depositDate: "2026-09-13",
    destinationAccountId: building.account.accountId,
    sourceKind: "external",
    sourcePeriod: "2026-09",
    period: "2026-09",
    reference: "ايداع آخر",
  }, opId("c5-ext"));
  const a = buildDashboardFromDump(db, "2026-09", "2026-09-13");
  const b = buildDashboardFromDump(db, "2026-09", "2026-10-01");
  assert.equal(a.summary.holdingFils, 100000);
  assert.equal(b.summary.holdingFils, 100000);
  assert.ok(b.deposits.some((d) => d.id === dep.depositId && d.sourceKind === "external"));
});

test("D5 lost response retry of the same operationId creates one deposit", async () => {
  const { db, owner, building } = await setup();
  const sameOp = "d5-lost-response-op";
  await run(db, owner, "submitDeposit", {
    amountFils: 5000,
    depositDate: "2026-09-14",
    destinationAccountId: building.account.accountId,
    sourceKind: "external",
    sourcePeriod: "2026-09",
    period: "2026-09",
  }, sameOp);
  const replay = await run(db, owner, "submitDeposit", {
    amountFils: 5000,
    depositDate: "2026-09-14",
    destinationAccountId: building.account.accountId,
    sourceKind: "external",
    sourcePeriod: "2026-09",
    period: "2026-09",
  }, sameOp);
  assert.equal(replay.replay, true);
  assert.equal(db.dump("deposits").length, 1);
});

test("D1 D4 offline financial copy does not claim a local save or auto-reverse deposits", () => {
  assert.match(html, /لا يمكن حفظ العملية المالية بدون اتصال/);
  assert.match(html, /لم يتم الحفظ على السيرفر/);
  assert.match(html, /بانتظار الاتصال/);
  assert.match(html, /لم تتم المزامنة/);
  assert.doesNotMatch(html, /حفظ محلي/);
  assert.match(html, /RECON-CLOSE-POSTVACATE-20261009T0207Z/);
  const fn = bridge.slice(
    bridge.indexOf("async function syncDeletedMoney"),
    bridge.indexOf("async function applyEngineDiff"),
  );
  assert.doesNotMatch(fn, /reverseDeposit|rejectDeposit/);
  assert.match(bridge, /OFFLINE_FINANCIAL_BLOCKED/);
  // S.month is 0-based. October on screen is 9; the command period must be 2026-10.
  assert.match(bridge, /payload\.effectivePeriod = periodOfMonth\(S\.year, S\.month\)/);
  assert.match(bridge, /const effectivePeriod = periodOfMonth\(S\.year, S\.month\)/);
  assert.doesNotMatch(bridge, /\$\{String\(S\.month\)\.padStart\(2, "0"\)\}/);
});
