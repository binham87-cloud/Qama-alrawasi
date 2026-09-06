/**
 * Regression: vacant persists; closed rentals do not regenerate obligations;
 * clean-reset cancelled records stay dead; monthly KPIs exclude Holding;
 * one active rental / one active obligation per space·period.
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
import { liveObligationsForPeriod, sharedHoldingFils, isPlaceholderTenant } from "../../functions/domain/finance.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const html = readFileSync(resolve(root, "src/frontend/old-qama-shell.html"), "utf8");

async function setup() {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const building = await seedBuilding(db, owner);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "1111" });
  return { db, owner, building, yahia };
}

test("VACANT → REFRESH → STILL VACANT", async () => {
  const { db, owner, building } = await setup();
  await run(db, owner, "setSpaceOccupancy", { spaceId: building.space.spaceId, occupancy: "vacant" });
  const dash = buildDashboardFromDump(db, building.period, "2026-09-15");
  const sp = dash.spaces.find((s) => s.id === building.space.spaceId);
  assert.equal(sp.occupancy, "vacant");
  assert.equal(dash.summary.targetFils, 0);
  assert.equal(dash.summary.counts.late || 0, 0);
});

test("VACANT → GENERATE OBLIGATIONS → STILL VACANT / NO REGEN", async () => {
  const { db, owner, building } = await setup();
  await run(db, owner, "setSpaceOccupancy", { spaceId: building.space.spaceId, occupancy: "vacant" });
  const gen = await run(db, owner, "generateObligations", { period: building.period }, opId("gen-vac"));
  assert.equal(gen.created, 0);
  const dash = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.equal(dash.spaces.find((s) => s.id === building.space.spaceId).occupancy, "vacant");
  assert.equal(dash.summary.targetFils, 0);
  const ob = db.dump("obligations").find((o) => o.id === building.obligationId);
  assert.equal(ob.state, "cancelled");
});

test("CLOSED RENTAL DOES NOT REGENERATE OBLIGATION", async () => {
  const { db, owner, building } = await setup();
  await run(db, owner, "closeRental", {
    rentalId: building.rental.rentalId, endDate: "2026-09-04", reason: "test", setVacant: true,
  });
  const gen = await run(db, owner, "generateObligations", { period: building.period }, opId("gen-closed"));
  assert.equal(gen.created, 0);
  assert.equal(db.dump("obligations").find((o) => o.id === building.obligationId).state, "cancelled");
});

test("OLD CLEAN-RESET RECORDS STAY CANCELLED", async () => {
  const { db, owner, building } = await setup();
  await run(db, owner, "cancelObligation", {
    obligationId: building.obligationId, reason: "تنظيف سبتمبر 2026",
  });
  await run(db, owner, "closeRental", {
    rentalId: building.rental.rentalId, endDate: "2026-08-31", reason: "تنظيف سبتمبر 2026", setVacant: true,
  });
  await run(db, owner, "generateObligations", { period: building.period }, opId("gen-reset"));
  await run(db, owner, "generateObligations", { period: building.period }, opId("gen-reset-2"));
  const ob = db.dump("obligations").find((o) => o.id === building.obligationId);
  assert.equal(ob.state, "cancelled");
  assert.equal(buildDashboardFromDump(db, building.period, "2026-09-15").summary.targetFils, 0);
});

test("ONE ACTIVE RENTAL PER SPACE", async () => {
  const { db, owner, building } = await setup();
  await assert.rejects(
    () => run(db, owner, "createRental", {
      spaceId: building.space.spaceId, tenantName: "آخر", contractualAmountFils: 100000,
      dueDayOfMonth: 1, startDate: "2026-09-01",
    }),
    (e) => e.code === "SPACE_ALREADY_RENTED",
  );
});

test("ONE ACTIVE OBLIGATION PER ACTIVE RENTAL/PERIOD", async () => {
  const { db, owner, building } = await setup();
  const r1 = await run(db, owner, "generateObligations", { period: building.period }, opId("idem1"));
  const r2 = await run(db, owner, "generateObligations", { period: building.period }, opId("idem2"));
  assert.equal(r1.created, 0);
  assert.equal(r2.created, 0);
  const live = liveObligationsForPeriod(
    db.dump("obligations").filter((o) => o.period === building.period),
    db.dump("rentals"),
  );
  assert.equal(live.length, 1);
});

test("NEW RENTAL AFTER VACANCY", async () => {
  const { db, owner, building } = await setup();
  await run(db, owner, "setSpaceOccupancy", { spaceId: building.space.spaceId, occupancy: "vacant" });
  const neu = await run(db, owner, "createRental", {
    spaceId: building.space.spaceId, tenantName: "مستأجر جديد",
    contractualAmountFils: 140000, dueDayOfMonth: 1, startDate: "2026-09-05",
  });
  assert.notEqual(neu.rentalId, building.rental.rentalId);
  const gen = await run(db, owner, "generateObligations", { period: building.period }, opId("gen-new"));
  assert.equal(gen.created, 1);
  const dash = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.equal(dash.summary.targetFils, 140000);
  assert.equal(dash.summary.remainingFils, 140000);
  const old = db.dump("obligations").find((o) => o.id === building.obligationId);
  assert.equal(old.state, "cancelled");
});

test("MONTHLY TARGET = ACTIVE OBLIGATIONS; COLLECTED; REMAINING", async () => {
  const { db, owner, building, yahia } = await setup();
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 200000, collectionDate: "2026-09-05",
  });
  const dash = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.equal(dash.summary.targetFils, 920000);
  assert.equal(dash.summary.collectedFils, 200000);
  assert.equal(dash.summary.remainingFils, 720000);
  assert.equal(dash.summary.targetFils, dash.summary.collectedFils + dash.summary.remainingFils);
});

test("GLOBAL HOLDING EXCLUDED FROM MONTHLY TARGET RECONCILIATION", async () => {
  assert.match(html, /التحصيل الشهري متوازن|المستهدف.*=.*المحصل.*المتبقي/);
  assert.doesNotMatch(html, /المستهدف.*=.*مودع.*\+.*متأخر.*\+.*جزئي.*\+.*عند الموظفين/);
  const { db, owner, building, yahia } = await setup();
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 300000, collectionDate: "2026-09-05",
  });
  const dash = buildDashboardFromDump(db, building.period, "2026-09-15");
  const holding = sharedHoldingFils({ receipts: db.dump("receipts"), deposits: db.dump("deposits") });
  assert.equal(holding, 300000);
  // Target equation does not involve holding
  assert.equal(dash.summary.targetFils, dash.summary.collectedFils + dash.summary.remainingFils);
  assert.notEqual(dash.summary.targetFils, dash.summary.collectedFils + holding);
});

test("placeholder tenant cannot create rental", async () => {
  assert.equal(isPlaceholderTenant("—"), true);
  assert.equal(isPlaceholderTenant(""), true);
  assert.equal(isPlaceholderTenant("أحمد"), false);
  const { db, owner, building } = await setup();
  await run(db, owner, "setSpaceOccupancy", { spaceId: building.space.spaceId, occupancy: "vacant" });
  await assert.rejects(
    () => run(db, owner, "createRental", {
      spaceId: building.space.spaceId, tenantName: "—", contractualAmountFils: 100000,
      dueDayOfMonth: 1, startDate: "2026-09-01",
    }),
    (e) => e.code === "TENANT_REQUIRED",
  );
});
