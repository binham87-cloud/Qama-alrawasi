/**
 * Daily rental requirements on the Firebase emulator only.
 * Open period under test: 2026-10. Never writes 2026-09.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initializeApp, getApps, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getDb } from "../../functions/repositories/firestore.mjs";
import { executeCommand } from "../../functions/commands/index.mjs";
import { buildDashboard } from "../../functions/services/readModel.mjs";

const PROJECT = "qama-new";
const PERIOD = "2026-10";
const CLOSED_PERIOD = "2026-12";
const now = () => new Date().toISOString();

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("REFUSE: FIRESTORE_EMULATOR_HOST is required");
}
if (process.env.GCLOUD_PROJECT === "qama-new-prod-2026" || process.env.GOOGLE_CLOUD_PROJECT === "qama-new-prod-2026") {
  throw new Error("REFUSE: production project");
}

const owner = { userId: "owner-daily", role: "owner", active: true, displayName: "مدير" };
let employeeId = "";
const employee = () => ({ userId: employeeId, role: "employee", active: true, displayName: "يحيى" });

async function wipe(fs) {
  const cols = [
    "users", "properties", "units", "spaces", "rentals", "obligations", "receipts",
    "deposits", "expenses", "accounts", "operations", "auditEvents", "reversals",
    "loginAttempts", "uiPeriods", "uiConfig", "uiRequests",
  ];
  for (const c of cols) {
    const snap = await fs.collection(c).get();
    for (let i = 0; i < snap.docs.length; i += 400) {
      const batch = fs.batch();
      snap.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  }
}

function reader(fs) {
  return {
    async list(collection, wheres = []) {
      let q = fs.collection(collection);
      for (const [f, op, v] of wheres) q = q.where(f, op, v);
      const snap = await q.get();
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    },
  };
}

async function dash(fs, period = PERIOD) {
  const db = reader(fs);
  return buildDashboard({ db, viewer: owner, period, asOfDate: `${period}-15` });
}

async function run(db, actor, command, payload, operationId) {
  return executeCommand({ db, actor, command, payload, operationId, now: now() });
}

function recognizedDaily(receipts, bookingId) {
  return receipts.filter((r) =>
    r.obligationId === `daily:${bookingId}`
    && r.state === "recognized"
    && r.sourceType === "daily_booking");
}

test.before(async () => {
  while (getApps().length) await deleteApp(getApps()[0]);
  initializeApp({ projectId: PROJECT });
  const fs = getFirestore();
  await wipe(fs);
  const db = getDb(fs);
  await db.runTransaction(async (tx) => {
    const { hash, salt } = await tx.hashPin("1325");
    tx.create("users", owner.userId, {
      id: owner.userId, userId: owner.userId, displayName: "مدير", role: "owner",
      active: true, pinHash: hash, pinSalt: salt, createdAt: now(), createdBy: "seed", schemaVersion: 1,
    });
  });
  const created = await run(db, owner, "createUser", {
    displayName: "يحيى", role: "employee", pin: "6477",
  }, "op-daily-yahia");
  employeeId = created.userId;
  await run(db, owner, "createAccount", { name: "بنك", kind: "bank" }, "op-daily-bank");
});

test("daily rental requirements on the emulator", async () => {
  await ownerSaveCreatesOneReceipt();
  await employeeApprovalWaitsForCommit();
  await approvedDepositMovesHolding();
  await cancelReversesOnce();
  await closedPeriodRejectsBooking();
  await collectedRowsHaveReceipts();
});

async function ownerSaveCreatesOneReceipt() {
  const fs = getFirestore();
  const db = getDb(fs);
  const before = await dash(fs);
  const booking = {
    id: "db-owner-400", partId: "102-1", partLabel: "102 / 1", guest: "نزيل",
    startDate: "2026-10-02", endDate: "2026-10-03", nights: 1, nightRate: 400, total: 400,
    by: employeeId, paymentStatus: "unpaid",
  };
  const saved = await run(db, owner, "createDailyBookingPrepaid", {
    period: PERIOD,
    bookingJson: JSON.stringify(booking),
    amountFils: 40000,
    collectionDate: "2026-10-02",
    collectorUserId: employeeId,
    note: "نزيل",
  }, "op-daily-owner-400");
  assert.equal(saved.alreadyApplied, false);
  assert.equal(saved.state, "recognized");

  const retry = await run(db, owner, "createDailyBookingPrepaid", {
    period: PERIOD,
    bookingJson: JSON.stringify(booking),
    amountFils: 40000,
    collectionDate: "2026-10-02",
    collectorUserId: employeeId,
    note: "نزيل",
  }, "op-daily-owner-400-retry");
  assert.equal(retry.alreadyApplied, true);
  assert.equal(retry.receiptId, saved.receiptId);

  const cashAgain = await run(db, employee(), "createDailyCashReceipt", {
    bookingId: "db-owner-400", amountFils: 40000, collectionDate: "2026-10-02", period: PERIOD,
  }, "op-daily-owner-400-cash");
  assert.equal(cashAgain.alreadyApplied, true);
  assert.equal(cashAgain.receiptId, saved.receiptId);

  const receipts = await reader(fs).list("receipts", []);
  assert.equal(recognizedDaily(receipts, "db-owner-400").length, 1);
  assert.equal(recognizedDaily(receipts, "db-owner-400")[0].collectorUserId, employeeId);
  assert.equal(recognizedDaily(receipts, "db-owner-400")[0].method, "cash");

  const after = await dash(fs);
  assert.equal(after.summary.dailyTargetFils, before.summary.dailyTargetFils + 40000);
  assert.equal(after.summary.targetFils, before.summary.targetFils + 40000);
  assert.equal(after.summary.collectedFils, before.summary.collectedFils + 40000);
  assert.equal(after.summary.holdingFils, before.summary.holdingFils + 40000);
  assert.equal(after.summary.depositedFils, before.summary.depositedFils);
  assert.equal(after.summary.targetFils, after.summary.collectedFils + after.summary.remainingFils);
  const who = after.summary.custody.find((r) => r.userId === employeeId);
  assert.equal(who.cashCollectedFils, 40000);

  const extras = JSON.parse((await fs.collection("uiPeriods").doc(`period:${PERIOD}`).get()).data().extrasJson);
  const row = extras.dailyBookings.find((b) => b.id === "db-owner-400");
  assert.equal(row.paymentStatus, "collected");
  assert.equal(row.receiptId, saved.receiptId);
}

async function employeeApprovalWaitsForCommit() {
  const fs = getFirestore();
  const db = getDb(fs);
  const before = await dash(fs);
  const requestId = "req-daily-250";
  await run(db, employee(), "submitWorkRequest", {
    requestId,
    type: "add_daily",
    desc: "حجز يومي 250",
    payloadJson: JSON.stringify({
      booking: {
        id: "client-temp", partId: "102-1", partLabel: "102 / 1", guest: "ضيف",
        startDate: "2026-10-05", endDate: "2026-10-06", nights: 1, nightRate: 250, total: 250,
        paymentStatus: "collected", prepaid: true, by: employeeId,
      },
    }),
    month: 9, year: 2026,
  }, "op-daily-submit-250");

  const pendingReceipts = await reader(fs).list("receipts", [["obligationId", "==", `daily:${requestId}`]]);
  assert.equal(pendingReceipts.length, 0);
  const mid = await dash(fs);
  assert.equal(mid.summary.collectedFils, before.summary.collectedFils);
  assert.equal(mid.summary.targetFils, before.summary.targetFils);
  assert.equal(mid.summary.holdingFils, before.summary.holdingFils);
  const extrasDoc = await fs.collection("uiPeriods").doc(`period:${PERIOD}`).get();
  const extras = JSON.parse(extrasDoc.data().extrasJson);
  assert.equal(extras.dailyBookings.some((b) => b.id === requestId || b.id === "client-temp"), false);

  const rejectedId = "req-daily-reject-100";
  await run(db, employee(), "submitWorkRequest", {
    requestId: rejectedId,
    type: "add_daily",
    desc: "حجز مرفوض",
    payloadJson: JSON.stringify({
      booking: {
        partId: "102-1", guest: "مرفوض", startDate: "2026-10-08", endDate: "2026-10-09",
        nights: 1, total: 100, paymentStatus: "collected",
      },
    }),
    month: 9, year: 2026,
  }, "op-daily-submit-reject");
  await run(db, owner, "resolveWorkRequest", {
    requestId: rejectedId, decision: "rejected",
  }, "op-daily-reject");
  const rejectedReceipts = await reader(fs).list("receipts", [["obligationId", "==", `daily:${rejectedId}`]]);
  assert.equal(rejectedReceipts.length, 0);

  const committed = await run(db, owner, "commitWorkRequest", { requestId }, "op-daily-commit-250");
  assert.equal(committed.status, "approved");
  assert.equal(committed.alreadyApplied, false);
  const replay = await run(db, owner, "commitWorkRequest", { requestId }, "op-daily-commit-250-replay");
  assert.equal(replay.alreadyApplied, true);

  const receipts = await reader(fs).list("receipts", [["obligationId", "==", `daily:${requestId}`]]);
  const live = receipts.filter((r) => r.state === "recognized" && r.sourceType === "daily_booking");
  assert.equal(live.length, 1);
  assert.equal(live[0].amountFils, 25000);
  assert.equal(live[0].collectorUserId, employeeId);
  assert.equal(live[0].method, "cash");

  const after = await dash(fs);
  assert.equal(after.summary.targetFils, before.summary.targetFils + 25000);
  assert.equal(after.summary.collectedFils, before.summary.collectedFils + 25000);
  assert.equal(after.summary.holdingFils, before.summary.holdingFils + 25000);
  assert.equal(after.summary.targetFils, after.summary.collectedFils + after.summary.remainingFils);
  const who = after.summary.custody.find((r) => r.userId === employeeId);
  assert.equal(who.cashCollectedFils, 65000);
}

async function approvedDepositMovesHolding() {
  const fs = getFirestore();
  const db = getDb(fs);
  const before = await dash(fs);
  const account = (await reader(fs).list("accounts", []))[0];
  const pending = await run(db, employee(), "submitDeposit", {
    amountFils: 10000,
    depositDate: "2026-10-10",
    destinationAccountId: account.id,
    sourceKind: "holding",
    sourcePeriod: PERIOD,
    period: PERIOD,
    employeeId: employeeId,
  }, "op-daily-dep-pending");
  assert.equal(pending.state, "pending");
  const whilePending = await dash(fs);
  assert.equal(whilePending.summary.holdingFils, before.summary.holdingFils);
  assert.equal(whilePending.summary.depositedFils, before.summary.depositedFils);
  assert.equal(whilePending.summary.collectedFils, before.summary.collectedFils);

  const approved = await run(db, owner, "approveDeposit", {
    depositId: pending.depositId,
  }, "op-daily-dep-approve");
  assert.equal(approved.state, "approved");
  const after = await dash(fs);
  assert.equal(after.summary.holdingFils, before.summary.holdingFils - 10000);
  assert.equal(after.summary.depositedFils, before.summary.depositedFils + 10000);
  assert.equal(after.summary.collectedFils, before.summary.collectedFils);
  assert.equal(after.summary.targetFils, before.summary.targetFils);
  assert.equal(after.summary.targetFils, after.summary.collectedFils + after.summary.remainingFils);
  const receipts = await reader(fs).list("receipts", []);
  assert.equal(receipts.filter((r) => r.sourceType === "daily_booking" && r.state === "recognized").length, 2);
}

async function cancelReversesOnce() {
  const fs = getFirestore();
  const db = getDb(fs);
  const before = await dash(fs);
  const receipt = (await reader(fs).list("receipts", [["obligationId", "==", "daily:db-owner-400"]]))
    .find((r) => r.state === "recognized");
  await run(db, owner, "reverseReceipt", {
    receiptId: receipt.id, reason: "إلغاء حجز يومي",
  }, "op-daily-reverse-400");
  await assert.rejects(
    () => run(db, owner, "reverseReceipt", {
      receiptId: receipt.id, reason: "إلغاء حجز يومي",
    }, "op-daily-reverse-400-again"),
    (err) => err && err.code === "ALREADY_REVERSED",
  );

  const periodDoc = await fs.collection("uiPeriods").doc(`period:${PERIOD}`).get();
  const extras = JSON.parse(periodDoc.data().extrasJson);
  extras.dailyBookings = extras.dailyBookings.map((b) => (
    b.id === "db-owner-400" ? { ...b, status: "cancelled", paymentStatus: "reversed" } : b
  ));
  await run(db, owner, "savePeriodExtras", {
    period: PERIOD, extrasJson: JSON.stringify(extras),
  }, "op-daily-cancel-row");

  await assert.rejects(
    () => run(db, employee(), "createDailyCashReceipt", {
      bookingId: "db-owner-400", amountFils: 40000, collectionDate: "2026-10-02", period: PERIOD,
    }, "op-daily-cash-after-cancel"),
    (err) => err && err.code === "BOOKING_CANCELLED",
  );

  const after = await dash(fs);
  assert.equal(after.summary.targetFils, before.summary.targetFils - 40000);
  assert.equal(after.summary.collectedFils, before.summary.collectedFils - 40000);
  assert.equal(after.summary.holdingFils, before.summary.holdingFils - 40000);
  assert.equal(after.summary.depositedFils, before.summary.depositedFils);
  assert.equal(after.summary.targetFils, after.summary.collectedFils + after.summary.remainingFils);
  const live = (await reader(fs).list("receipts", [["obligationId", "==", "daily:db-owner-400"]]))
    .filter((r) => r.state === "recognized");
  assert.equal(live.length, 0);
}

async function closedPeriodRejectsBooking() {
  const fs = getFirestore();
  const db = getDb(fs);
  const closed = await run(db, owner, "closeAccountingPeriod", { period: CLOSED_PERIOD }, "op-daily-close-2026-12");
  assert.equal(closed.ready, true);
  await assert.rejects(
    () => run(db, owner, "createDailyBookingPrepaid", {
      period: CLOSED_PERIOD,
      bookingJson: JSON.stringify({
        id: "db-closed", guest: "لا", startDate: "2026-12-01", endDate: "2026-12-02", total: 50,
      }),
      amountFils: 5000,
      collectionDate: "2026-12-01",
    }, "op-daily-closed-booking"),
    (err) => err && err.code === "MONTH_CLOSED",
  );
  const sepReceipts = await reader(fs).list("receipts", [["period", "==", "2026-09"]]);
  const sepPeriods = await fs.collection("uiPeriods").doc("period:2026-09").get();
  const sepClose = await fs.collection("uiConfig").doc("close-state:2026-09").get();
  assert.equal(sepReceipts.length, 0);
  assert.equal(sepPeriods.exists, false);
  assert.equal(sepClose.exists, false);
}

async function collectedRowsHaveReceipts() {
  const fs = getFirestore();
  const periodDoc = await fs.collection("uiPeriods").doc(`period:${PERIOD}`).get();
  const extras = JSON.parse(periodDoc.data().extrasJson);
  const receipts = await reader(fs).list("receipts", [["period", "==", PERIOD]]);
  for (const b of extras.dailyBookings) {
    if (b.status === "cancelled" || b.paymentStatus === "reversed") continue;
    assert.equal(b.paymentStatus, "collected");
    const live = recognizedDaily(receipts, b.id);
    assert.equal(live.length, 1);
    assert.equal(live[0].id, b.receiptId);
    assert.equal(live[0].amountFils, Math.round(Number(b.total) * 100));
  }
}

test("daily card label is driven by paymentStatus", () => {
  const html = readFileSync(new URL("../../src/frontend/index.html", import.meta.url), "utf8");
  const at = html.indexOf('const pay=b.paymentStatus||"unpaid"');
  assert.ok(at > 0);
  const chunk = html.slice(at, at + 280);
  assert.match(chunk, /محصّل \/ لم يودع/);
  assert.equal(chunk.includes("receiptId"), false);
});
