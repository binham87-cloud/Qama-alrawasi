import test from "node:test";
import assert from "node:assert/strict";
import { freshDb, run, bootstrapOwner, seedBuilding, createUser, actorFrom } from "../helpers/commands.mjs";
import { buildDashboardFromDump } from "../../functions/services/readModel.mjs";
import { STATUS } from "../../src/domain/finance.mjs";

test("scenario: full owner workflow through read model", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const building = await seedBuilding(db, owner);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });

  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 900000, collectionDate: "2026-09-05",
  });
  const dash = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.equal(dash.obligations.length, 1);
  assert.equal(dash.obligations[0].status, STATUS.PARTIAL);
  assert.equal(dash.summary.targetFils, 920000);
});

test("scenario: employee partial then collect remaining", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const building = await seedBuilding(db, owner);
  const emp = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });

  await run(db, actorFrom(emp), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 900000, collectionDate: "2026-09-05",
  });
  await run(db, actorFrom(emp), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 20000, collectionDate: "2026-09-06",
  });
  const dash = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.equal(dash.obligations[0].status, STATUS.COLLECTED);
  assert.equal(dash.summary.remainingFils, 0);
});

test("scenario: bank approval increases collected and deposited", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const building = await seedBuilding(db, owner);
  const emp = await createUser(db, owner, { displayName: "نادر", role: "employee", pin: "2026" });

  const bank = await run(db, actorFrom(emp), "submitBankReceipt", {
    obligationId: building.obligationId, amountFils: 920000, collectionDate: "2026-09-05", bankReference: "BNK1",
  });
  await run(db, owner, "approveBankReceipt", { receiptId: bank.receiptId });
  const dash = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.equal(dash.summary.collectedFils, 920000);
  assert.equal(dash.summary.depositedFils, 920000);
  assert.equal(dash.summary.holdingFils, 0);
});

test("scenario: multi-collector deposit and monthly summary", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const building = await seedBuilding(db, owner);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const nader = await createUser(db, owner, { displayName: "نادر", role: "employee", pin: "2026" });

  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 500000, collectionDate: "2026-09-05",
  });
  await run(db, actorFrom(nader), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 400000, collectionDate: "2026-09-05",
  });
  const dep = await run(db, actorFrom(yahia), "submitDeposit", {
    amountFils: 300000, depositDate: "2026-09-06", destinationAccountId: building.account.accountId,
  });
  await run(db, owner, "approveDeposit", { depositId: dep.depositId });

  const dash = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.equal(dash.summary.holdingFils, 600000);
  assert.equal(dash.custody.find((c) => c.userId === yahia.userId).cashCollectedFils, 500000);
  assert.equal(dash.custody.find((c) => c.userId === nader.userId).cashCollectedFils, 400000);
  assert.equal(dash.summary.collectedFils, 900000);
  assert.equal(dash.summary.remainingFils, 20000);
});
