/**
 * Proves frontend-generated operationIds (not harness-fresh IDs) survive
 * collect→uncollect→collect→uncollect against the real command processor.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshDb, run, bootstrapOwner, seedBuilding, createUser, actorFrom } from "../helpers/commands.mjs";
import { buildDashboardFromDump } from "../../functions/services/readModel.mjs";
import {
  collectionOpKey, uncollectOpKey,
} from "../../src/frontend/idempotency_keys.mjs";

test("frontend keys: collect/uncollect/collect/uncollect same amount succeeds", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const building = await seedBuilding(db, owner);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const ob = building.obligationId;
  const actor = actorFrom(yahia);
  let receipts = [];

  for (let cycle = 0; cycle < 2; cycle++) {
    const payKey = collectionOpKey({
      obligationId: ob, wantFils: 10000, deltaFils: 10000, receipts: [...receipts],
    });
    const created = await run(db, actor, "createCashReceipt", {
      obligationId: ob, amountFils: 10000, collectionDate: "2026-09-05",
    }, payKey);
    assert.equal(created.replay, false);
    receipts = db.dump("receipts").filter((r) => r.obligationId === ob);

    const uncolKey = uncollectOpKey({
      obligationId: ob, alreadyFils: 10000, receipts: [...receipts],
    });
    // Sticky old key would be identical every cycle — prove ours differ.
    if (cycle === 1) {
      const sticky = (`uncol-${ob}-p10000`).slice(0, 120);
      assert.notEqual(uncolKey, sticky);
    }
    const unc = await run(db, owner, "uncollectObligation", {
      obligationId: ob, reason: "اختبار دورة",
    }, uncolKey);
    assert.equal(unc.replay, false);
    receipts = db.dump("receipts").filter((r) => r.obligationId === ob);
  }

  const dash = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.equal(dash.summary.collectedFils, 0);
  assert.equal(receipts.filter((r) => r.state === "recognized").length, 0);
  assert.equal(receipts.filter((r) => r.state === "reversed").length, 2);
});

test("BUG: sticky uncol key replays second uncollect without effect path", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const building = await seedBuilding(db, owner);
  const yahia = await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "6477" });
  const ob = building.obligationId;
  // Mirror the previous bridge formula (must be a valid operationId charset).
  const sticky = (`uncol-${ob.replace(/[^A-Za-z0-9_:.-]/g, "")}-p10000`).slice(0, 120);

  const sameReason = "عكس تحصيل";
  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: ob, amountFils: 10000, collectionDate: "2026-09-05",
  }, "pay-cycle-a1");
  await run(db, owner, "uncollectObligation", { obligationId: ob, reason: sameReason }, sticky);

  await run(db, actorFrom(yahia), "createCashReceipt", {
    obligationId: ob, amountFils: 10000, collectionDate: "2026-09-06",
  }, "pay-cycle-b1");
  // Same sticky key + identical payload → silent replay; second collection stays.
  // (Different reason would throw IDEMPOTENCY_PAYLOAD_MISMATCH — also a broken UX.)
  const replay = await run(db, owner, "uncollectObligation", { obligationId: ob, reason: sameReason }, sticky);
  assert.equal(replay.replay, true);
  const dash = buildDashboardFromDump(db, building.period, "2026-09-15");
  assert.equal(dash.summary.collectedFils, 10000, "sticky key left second collection intact");
});
