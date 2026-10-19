/**
 * Units cards must separate renewal, payment, and daily occupancy.
 * An unrenewed November continuation is not due and not collected.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { freshDb, run, bootstrapOwner, createUser, actorFrom, opId } from "../helpers/commands.mjs";
import { buildDashboardFromDump } from "../../functions/services/readModel.mjs";

async function contract(db, owner, start, rent = 120000) {
  const prop = await run(db, owner, "createProperty", { name: "قمة", address: "دبي" }, opId("prop"));
  const unit = await run(db, owner, "createUnit", { propertyId: prop.propertyId, name: "شقة 8", kind: "whole" }, opId("unit"));
  const space = await run(db, owner, "createSpace", { unitId: unit.unitId, name: "شقة 8" }, opId("space"));
  const rental = await run(db, owner, "createRental", {
    spaceId: space.spaceId, tenantName: "مستأجر", contractualAmountFils: rent,
    dueDayOfMonth: Number(start.slice(8, 10)), startDate: start,
  }, opId("rent"));
  await run(db, owner, "generateObligations", { period: start.slice(0, 7) }, opId("gen"));
  return { space, rental };
}

function card(db, period, spaceId, asOf) {
  const dash = buildDashboardFromDump(db, period, asOf);
  return dash.unitsTree.flatMap((unit) => unit.spaces).find((space) => space.spaceId === spaceId);
}

test("unrenewed November is not due or collected, and October stays due", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const row = await contract(db, owner, "2026-10-01");
  const oct = card(db, "2026-10", row.space.spaceId, "2026-10-20");
  assert.equal(oct.dueFils, 120000);
  assert.equal(oct.paidFils, 0);
  assert.notEqual(oct.status, "collected");
  assert.notEqual(oct.status, "renewal_required");
  const nov = card(db, "2026-11", row.space.spaceId, "2026-11-02");
  assert.equal(nov.status, "renewal_required");
  assert.equal(nov.dueFils, 0);
  assert.equal(nov.paidFils, 0);
  assert.equal(nov.remainingFils, 0);
  assert.equal(nov.obligationId, null);
  assert.equal(buildDashboardFromDump(db, "2026-11", "2026-11-02").summary.obligationTargetFils, 0);
  assert.equal(buildDashboardFromDump(db, "2026-10", "2026-11-02").summary.targetFils, 120000);
});

test("renewed unpaid, partial, and collected stay distinct", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const row = await contract(db, owner, "2026-10-01");
  const renewed = await run(db, actorFrom(yahia), "renewRentalCycle", {
    rentalId: row.rental.rentalId, asOfDate: "2026-11-01",
  }, opId("renew"));
  const unpaid = card(db, "2026-11", row.space.spaceId, "2026-11-02");
  assert.equal(unpaid.renewalStatus, "confirmed");
  assert.equal(unpaid.dueFils, 120000);
  assert.equal(unpaid.paidFils, 0);
  assert.notEqual(unpaid.status, "collected");
  assert.notEqual(unpaid.status, "renewal_required");
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: renewed.obligationId, amountFils: 40000, collectionDate: "2026-11-02",
  }, opId("part"));
  const partial = card(db, "2026-11", row.space.spaceId, "2026-11-02");
  assert.equal(partial.status, "partial");
  assert.equal(partial.paidFils, 40000);
  assert.equal(partial.remainingFils, 80000);
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: renewed.obligationId, amountFils: 80000, collectionDate: "2026-11-03",
  }, opId("rest"));
  const full = card(db, "2026-11", row.space.spaceId, "2026-11-03");
  assert.equal(full.status, "collected");
  assert.equal(full.paidFils, 120000);
  assert.equal(full.remainingFils, 0);
  assert.equal(card(db, "2026-10", row.space.spaceId, "2026-11-03").paidFils, 0);
});

test("the assembled units screen names renewal, payment, and daily states", () => {
  const html = readFileSync(new URL("../../src/frontend/index.html", import.meta.url), "utf8");
  for (const marker of [
    "يلزم التجديد",
    "مجدَّد — غير محصّل",
    "محصّل جزئياً",
    "🟠 مؤجر يومي",
    "🔵 حجز يومي قادم",
    "data-financial-state",
    "data-daily-state",
    "month-next",
    "month-prev",
    "تجديد للشهر المحدد",
    "btn-manual-renew",
    "لن يُحصَّل مبلغ ولن يُنشأ إيصال",
  ]) {
    assert.equal(html.includes(marker), true, marker);
  }
});
