/**
 * Month navigation / period isolation — Sep ↔ Oct must never share payment state.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  freshDb, run, bootstrapOwner, seedBuilding, createUser, actorFrom, opId,
} from "../helpers/commands.mjs";
import { buildDashboardFromDump } from "../../functions/services/readModel.mjs";
import { STATUS } from "../../functions/domain/finance.mjs";

async function setup() {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const building = await seedBuilding(db, owner);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "1111" });
  return { db, owner, building, yahia };
}

test("month nav: active Sep rental seeds Oct unpaid; no duplicate; vacant stays vacant", async () => {
  const { db, owner, building } = await setup();
  const first = await run(db, owner, "generateObligations", { period: "2026-10" }, opId("mn-oct-1"));
  assert.equal(first.created, 1);
  const second = await run(db, owner, "generateObligations", { period: "2026-10" }, opId("mn-oct-2"));
  assert.equal(second.created, 0);
  const oct = db.dump("obligations").filter(
    (o) => o.period === "2026-10" && o.rentalId === building.rental.rentalId && o.state === "active",
  );
  assert.equal(oct.length, 1);
  assert.equal(oct[0].dueDate, "2026-10-01");

  // Close rental → no further period seed
  await run(db, owner, "endTenancy", {
    rentalId: building.rental.rentalId,
    endDate: "2026-10-01",
    reason: "إخلاء اختبار",
    arrearsDecision: "retain",
  }, opId("mn-end"));
  const nov = await run(db, owner, "generateObligations", { period: "2026-11" }, opId("mn-nov"));
  assert.equal(nov.created, 0);
});

test("month nav: Sep paid stays on Sep; Oct totals scoped; Sep↔Oct↔Sep preserves Sep", async () => {
  const { db, owner, building, yahia } = await setup();
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: building.obligationId, amountFils: 920000, collectionDate: "2026-09-05",
  });

  const snapSep = () => {
    const d = buildDashboardFromDump(db, "2026-09", "2026-09-20");
    const ob = d.obligations.find((o) => o.obligationId === building.obligationId);
    return {
      obligationId: ob.obligationId,
      paidFils: ob.paidFils,
      status: ob.status,
      dueDate: ob.dueDate,
      collected: d.summary.collectedFils,
      remaining: d.summary.remainingFils,
    };
  };
  const before = snapSep();
  assert.equal(before.status, STATUS.COLLECTED);
  assert.equal(before.paidFils, 920000);

  await run(db, owner, "generateObligations", { period: "2026-10" }, opId("mn-gen-oct"));
  const octEarly = buildDashboardFromDump(db, "2026-10", "2026-09-20");
  const octOb = octEarly.obligations.find((o) => o.rentalId === building.rental.rentalId);
  assert.ok(octOb);
  assert.notEqual(octOb.obligationId, building.obligationId);
  assert.equal(octOb.paidFils, 0);
  assert.equal(octOb.dueDate, "2026-10-01");
  assert.equal(octOb.status, STATUS.NOT_DUE);
  assert.equal(octEarly.summary.collectedFils, 0);

  const octDue = buildDashboardFromDump(db, "2026-10", "2026-10-01");
  assert.equal(octDue.obligations.find((o) => o.obligationId === octOb.obligationId).status, STATUS.LATE);

  const afterOct = snapSep();
  assert.deepEqual(afterOct, before);

  // Simulate reload on Oct
  const octReload = buildDashboardFromDump(db, "2026-10", "2026-10-15");
  assert.equal(octReload.obligations.find((o) => o.obligationId === octOb.obligationId).paidFils, 0);
  assert.equal(octReload.summary.collectedFils, 0);

  // Back to Sep — exact original values
  assert.deepEqual(snapSep(), before);
});
