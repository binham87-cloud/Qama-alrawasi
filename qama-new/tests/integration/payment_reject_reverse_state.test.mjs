/**
 * Payment rejection / reversal state machine + income-detail vs audit projections.
 * Occupancy must never change from payment reject/reverse — only explicit vacate/endTenancy.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshDb, run, bootstrapOwner, seedBuilding, createUser, actorFrom } from "../helpers/commands.mjs";
import { STATUS, RECEIPT_STATE, isFinancialIncomeDetailRow, assertProjectionsDoNotMoveMoney } from "../../src/domain/finance.mjs";
import { buildDashboardFromDump } from "../../functions/services/readModel.mjs";

async function setup() {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const building = await seedBuilding(db, owner);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  return { db, owner, building, yahia };
}

function spaceOcc(db, spaceId) {
  return db.dump("spaces").find((s) => s.id === spaceId);
}
function rentalDoc(db, rentalId) {
  return db.dump("rentals").find((r) => r.id === rentalId);
}
function obligationDoc(db, obligationId) {
  return db.dump("obligations").find((o) => o.id === obligationId);
}
function dashFor(db, building, asOf = "2026-09-15") {
  return buildDashboardFromDump(db, building.period, asOf);
}
function incomeDetailFromDash(dash) {
  return (dash.deposits || []).filter((d) => isFinancialIncomeDetailRow(d));
}
function auditBankHist(dash, receiptId) {
  return (dash.deposits || []).filter((d) => d.fromBankReceipt === true && d.id === receiptId);
}

test("A1: late → pending bank → reject → stays rented/late; collectible again; absent from income detail", async () => {
  const { db, owner, building, yahia } = await setup();
  const spaceId = building.space.spaceId;
  const rentalId = building.rental.rentalId;
  const obligationId = building.obligationId;

  let dash = dashFor(db, building);
  assert.equal(dash.obligations[0].status, STATUS.LATE);
  assert.equal(spaceOcc(db, spaceId).occupancy, "rented");
  assert.equal(rentalDoc(db, rentalId).state, "active");
  assert.equal(obligationDoc(db, obligationId).state, "active");

  const bank = await run(db, actorFrom(yahia), "submitBankReceipt", {
    obligationId, amountFils: 920000, collectionDate: "2026-09-05", bankReference: "A1-PEND",
  });
  dash = dashFor(db, building);
  assert.equal(dash.summary.collectedFils, 0);
  assert.equal(dash.summary.depositedFils, 0);
  assert.equal(dash.summary.holdingFils, 0);
  assert.equal(dash.summary.incomeFils, 0);
  assert.equal(dash.obligations[0].status, STATUS.LATE);
  assert.equal(spaceOcc(db, spaceId).occupancy, "rented");
  // Pending bank must not appear in financial income detail.
  assert.equal(incomeDetailFromDash(dash).filter((d) => d.id === bank.receiptId).length, 0);
  assert.equal(auditBankHist(dash, bank.receiptId).length, 0);

  await run(db, owner, "rejectBankReceipt", { receiptId: bank.receiptId, reason: "رفض A1" });
  dash = dashFor(db, building);
  assert.equal(spaceOcc(db, spaceId).occupancy, "rented");
  assert.equal(rentalDoc(db, rentalId).state, "active");
  assert.equal(rentalDoc(db, rentalId).tenantName, "أحمد");
  assert.equal(obligationDoc(db, obligationId).state, "active");
  assert.equal(dash.obligations[0].paidFils, 0);
  assert.equal(dash.obligations[0].remainingFils, 920000);
  assert.equal(dash.obligations[0].status, STATUS.LATE);
  assert.equal(dash.summary.collectedFils, 0);
  assert.equal(dash.summary.depositedFils, 0);
  assert.equal(dash.summary.incomeFils, 0);

  const hist = auditBankHist(dash, bank.receiptId);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].state, "rejected");
  assert.equal(incomeDetailFromDash(dash).filter((d) => d.id === bank.receiptId).length, 0);

  // Collectible again via cash
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId, amountFils: 200000, collectionDate: "2026-09-06",
  });
  dash = dashFor(db, building);
  assert.equal(dash.obligations[0].status, STATUS.PARTIAL);
  assert.equal(spaceOcc(db, spaceId).occupancy, "rented");

  // And via a new bank transfer
  const bank2 = await run(db, actorFrom(yahia), "submitBankReceipt", {
    obligationId, amountFils: 720000, collectionDate: "2026-09-07", bankReference: "A1-RETRY",
  });
  await run(db, owner, "approveBankReceipt", { receiptId: bank2.receiptId });
  dash = dashFor(db, building);
  assert.equal(dash.obligations[0].status, STATUS.COLLECTED);
  assert.equal(spaceOcc(db, spaceId).occupancy, "rented");
  assert.ok(incomeDetailFromDash(dash).some((d) => d.id === bank2.receiptId));
  assert.equal(incomeDetailFromDash(dash).filter((d) => d.state === "rejected").length, 0);
});

test("A2: partial → pending bank remaining → reject → stays partial; occupancy unchanged", async () => {
  const { db, owner, building, yahia } = await setup();
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 300000, collectionDate: "2026-09-05",
  });
  let dash = dashFor(db, building);
  assert.equal(dash.obligations[0].status, STATUS.PARTIAL);

  const bank = await run(db, actorFrom(yahia), "submitBankReceipt", {
    obligationId: building.obligationId, amountFils: 620000, collectionDate: "2026-09-06", bankReference: "A2",
  });
  await run(db, owner, "rejectBankReceipt", { receiptId: bank.receiptId, reason: "رفض A2" });
  dash = dashFor(db, building);
  assert.equal(dash.obligations[0].paidFils, 300000);
  assert.equal(dash.obligations[0].remainingFils, 620000);
  assert.equal(dash.obligations[0].status, STATUS.PARTIAL);
  assert.equal(spaceOcc(db, building.space.spaceId).occupancy, "rented");
  assert.equal(rentalDoc(db, building.rental.rentalId).tenantName, "أحمد");
  assert.equal(incomeDetailFromDash(dash).filter((d) => d.id === bank.receiptId).length, 0);
  assert.equal(auditBankHist(dash, bank.receiptId).length, 1);
});

test("A3: not-due → pending bank → reject → remains not_due", async () => {
  const { db, owner, building, yahia } = await setup();
  // Before due date (dueDay=1, start Sep 1 — use Aug asOf? Obligation due 2026-09-01.
  // Seed due is day 1; asOf 2026-08-31 is before due.
  const bank = await run(db, actorFrom(yahia), "submitBankReceipt", {
    obligationId: building.obligationId, amountFils: 920000, collectionDate: "2026-08-20", bankReference: "A3",
  });
  await run(db, owner, "rejectBankReceipt", { receiptId: bank.receiptId, reason: "رفض A3" });
  const dash = dashFor(db, building, "2026-08-31");
  assert.equal(dash.obligations[0].status, STATUS.NOT_DUE);
  assert.equal(spaceOcc(db, building.space.spaceId).occupancy, "rented");
  assert.equal(dash.summary.collectedFils, 0);
});

test("A4: late → pending bank → approve → collected + deposited; appears in income detail", async () => {
  const { db, owner, building, yahia } = await setup();
  const bank = await run(db, actorFrom(yahia), "submitBankReceipt", {
    obligationId: building.obligationId, amountFils: 920000, collectionDate: "2026-09-05", bankReference: "A4",
  });
  let dash = dashFor(db, building);
  assert.equal(incomeDetailFromDash(dash).filter((d) => d.id === bank.receiptId).length, 0);

  await run(db, owner, "approveBankReceipt", { receiptId: bank.receiptId });
  dash = dashFor(db, building);
  assert.equal(dash.summary.collectedFils, 920000);
  assert.equal(dash.summary.depositedFils, 920000);
  assert.equal(dash.summary.holdingFils, 0);
  assert.equal(dash.summary.incomeFils, 920000);
  assert.equal(dash.obligations[0].status, STATUS.COLLECTED);
  assert.equal(spaceOcc(db, building.space.spaceId).occupancy, "rented");
  const detail = incomeDetailFromDash(dash).filter((d) => d.id === bank.receiptId);
  assert.equal(detail.length, 1);
  assert.equal(detail[0].state, "approved");
});

test("A5: approved bank → reverse → rented + late; not vacant; removed from income detail; audit retains", async () => {
  const { db, owner, building, yahia } = await setup();
  const bank = await run(db, actorFrom(yahia), "submitBankReceipt", {
    obligationId: building.obligationId, amountFils: 920000, collectionDate: "2026-09-05", bankReference: "A5",
  });
  await run(db, owner, "approveBankReceipt", { receiptId: bank.receiptId });
  await run(db, owner, "reverseReceipt", { receiptId: bank.receiptId, reason: "عكس A5" });

  const dash = dashFor(db, building);
  assert.equal(spaceOcc(db, building.space.spaceId).occupancy, "rented");
  assert.equal(rentalDoc(db, building.rental.rentalId).state, "active");
  assert.equal(rentalDoc(db, building.rental.rentalId).tenantName, "أحمد");
  assert.equal(obligationDoc(db, building.obligationId).state, "active");
  assert.equal(dash.obligations[0].paidFils, 0);
  assert.equal(dash.obligations[0].status, STATUS.LATE);
  assert.equal(dash.summary.collectedFils, 0);
  assert.equal(dash.summary.depositedFils, 0);
  assert.equal(dash.summary.incomeFils, 0);
  // Reversed bank: not in income detail; history filter is recognized|rejected only (reversed absent from deposits hist).
  assert.equal(incomeDetailFromDash(dash).filter((d) => d.id === bank.receiptId).length, 0);
  assert.equal(dash.receipts.find((r) => r.id === bank.receiptId).state, RECEIPT_STATE.REVERSED);
  // Audit: reversed receipt remains in receipts dump (history), not vacant.
  assert.equal(db.dump("receipts").find((r) => r.id === bank.receiptId).state, RECEIPT_STATE.REVERSED);
  assert.ok(db.dump("reversals").some((r) => r.targetId === bank.receiptId));
});

test("A6: cash reverse → occupancy unchanged; status re-derived late", async () => {
  const { db, owner, building, yahia } = await setup();
  const cash = await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 920000, collectionDate: "2026-09-05",
  });
  await run(db, owner, "reverseReceipt", { receiptId: cash.receiptId, reason: "عكس نقد" });
  const dash = dashFor(db, building);
  assert.equal(spaceOcc(db, building.space.spaceId).occupancy, "rented");
  assert.equal(dash.obligations[0].status, STATUS.LATE);
  assert.equal(dash.summary.holdingFils, 0);
  assert.equal(dash.summary.collectedFils, 0);
});

test("B: income detail sum equals deposited; rejected/pending excluded; display-only inert", async () => {
  const { db, owner, building, yahia } = await setup();
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 400000, collectionDate: "2026-09-05",
  });
  const rej = await run(db, actorFrom(yahia), "submitBankReceipt", {
    obligationId: building.obligationId, amountFils: 100000, collectionDate: "2026-09-06", bankReference: "BREJ",
  });
  await run(db, owner, "rejectBankReceipt", { receiptId: rej.receiptId, reason: "رفض" });
  const ok = await run(db, actorFrom(yahia), "submitBankReceipt", {
    obligationId: building.obligationId, amountFils: 520000, collectionDate: "2026-09-07", bankReference: "BOK",
  });
  await run(db, owner, "approveBankReceipt", { receiptId: ok.receiptId });

  const dash = dashFor(db, building);
  const detail = incomeDetailFromDash(dash);
  assert.equal(detail.filter((d) => d.state === "rejected" || d.state === "pending").length, 0);
  assert.ok(detail.some((d) => d.id === ok.receiptId));
  assert.ok(!detail.some((d) => d.id === rej.receiptId));
  // Rejected still in audit history projection
  assert.equal(auditBankHist(dash, rej.receiptId).length, 1);

  const detailSum = detail.reduce((s, d) => s + Number(d.amountFils || 0), 0);
  assert.equal(detailSum, dash.summary.incomeFils);
  assert.equal(dash.summary.incomeFils, dash.summary.depositedFils);

  const proj = assertProjectionsDoNotMoveMoney({
    obligations: db.dump("obligations").filter((o) => o.period === building.period),
    receipts: db.dump("receipts"),
    deposits: dash.deposits,
    expenses: [],
    asOfDate: "2026-09-15",
  });
  assert.equal(proj.ok, true, JSON.stringify(proj.problems));
});

test("B: only endTenancy/vacate may make space vacant — not reject/reverse", async () => {
  const { db, owner, building, yahia } = await setup();
  const bank = await run(db, actorFrom(yahia), "submitBankReceipt", {
    obligationId: building.obligationId, amountFils: 920000, collectionDate: "2026-09-05", bankReference: "VAC",
  });
  await run(db, owner, "approveBankReceipt", { receiptId: bank.receiptId });
  await run(db, owner, "reverseReceipt", { receiptId: bank.receiptId, reason: "عكس" });
  assert.equal(spaceOcc(db, building.space.spaceId).occupancy, "rented");

  await run(db, owner, "setSpaceOccupancy", { spaceId: building.space.spaceId, occupancy: "vacant" });
  assert.equal(spaceOcc(db, building.space.spaceId).occupancy, "vacant");
});

test("A5 uncollectObligation reverses bank and keeps occupancy rented", async () => {
  const { db, owner, building, yahia } = await setup();
  const bank = await run(db, actorFrom(yahia), "submitBankReceipt", {
    obligationId: building.obligationId, amountFils: 920000, collectionDate: "2026-09-05", bankReference: "UNC",
  });
  await run(db, owner, "approveBankReceipt", { receiptId: bank.receiptId });
  await run(db, owner, "uncollectObligation", {
    obligationId: building.obligationId, reason: "إلغاء تحصيل",
  });
  const dash = dashFor(db, building);
  assert.equal(spaceOcc(db, building.space.spaceId).occupancy, "rented");
  assert.equal(dash.obligations[0].status, STATUS.LATE);
  assert.equal(dash.summary.collectedFils, 0);
  assert.equal(db.dump("receipts").find((r) => r.id === bank.receiptId).state, RECEIPT_STATE.REVERSED);
});

test("reload: rejected bank still audit-only; status late; tenant preserved", async () => {
  const { db, owner, building, yahia } = await setup();
  const bank = await run(db, actorFrom(yahia), "submitBankReceipt", {
    obligationId: building.obligationId, amountFils: 110000, collectionDate: "2026-09-05", bankReference: "REL",
  });
  await run(db, owner, "rejectBankReceipt", { receiptId: bank.receiptId, reason: "رفض" });
  const dash1 = dashFor(db, building);
  const dash2 = dashFor(db, building); // reload-equivalent rebuild
  assert.equal(dash2.obligations[0].status, dash1.obligations[0].status);
  assert.equal(dash2.obligations[0].status, STATUS.LATE);
  assert.equal(spaceOcc(db, building.space.spaceId).occupancy, "rented");
  assert.equal(auditBankHist(dash2, bank.receiptId).length, 1);
  assert.equal(incomeDetailFromDash(dash2).filter((d) => d.id === bank.receiptId).length, 0);

  const { bankReceiptHistoryRows: histFn } = await import("../../functions/services/readModel.mjs");
  const rows = histFn({
    receipts: db.dump("receipts"),
    viewerUserId: owner.userId,
    isOwner: true,
    nameOf: () => "x",
    unitName: () => "u",
    spaceName: () => "s",
  });
  assert.ok(rows.some((r) => r.id === bank.receiptId && r.state === "rejected"));
});
