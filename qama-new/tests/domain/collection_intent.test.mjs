import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveCollectionPayment, collapseOneRentPerSpacePeriod, liveObligationsForPeriod,
  periodSummary, RECEIPT_STATE,
} from "../../functions/domain/finance.mjs";

test("full collection equals remaining, including after a partial payment", () => {
  const first = resolveCollectionPayment({
    dueFils: 120000, recognizedPaidFils: 0, status: "collected", statedAmountFils: 120000,
  });
  assert.equal(first.error, null);
  assert.equal(first.newPaymentFils, 120000);
  const next = resolveCollectionPayment({
    dueFils: 120000, recognizedPaidFils: 50000, status: "collected", statedAmountFils: 70000,
  });
  assert.equal(next.newPaymentFils, 70000);
  assert.equal(next.remainingFils, 70000);
});

test("full collection of zero while money remains is refused", () => {
  const decision = resolveCollectionPayment({
    dueFils: 120000, recognizedPaidFils: 0, status: "collected", statedAmountFils: 0,
  });
  assert.equal(decision.error, "ZERO_FULL_COLLECTION");
  assert.equal(decision.newPaymentFils, 0);
});

test("full collection that repeats the original rent after a partial is refused", () => {
  const decision = resolveCollectionPayment({
    dueFils: 120000, recognizedPaidFils: 50000, status: "collected", statedAmountFils: 120000,
  });
  assert.equal(decision.error, "FULL_AMOUNT_MUST_EQUAL_REMAINING");
});

test("partial collection rejects zero, negative, and amounts above remaining", () => {
  assert.equal(resolveCollectionPayment({
    dueFils: 120000, recognizedPaidFils: 0, status: "partial", partial: true, statedAmountFils: 0,
  }).error, "PARTIAL_AMOUNT_REQUIRED");
  assert.equal(resolveCollectionPayment({
    dueFils: 120000, recognizedPaidFils: 0, status: "partial", partial: true, statedAmountFils: 130000,
  }).error, "AMOUNT_EXCEEDS_REMAINING");
  const ok = resolveCollectionPayment({
    dueFils: 120000, recognizedPaidFils: 50000, status: "partial", partial: true, statedAmountFils: 20000,
  });
  assert.equal(ok.newPaymentFils, 20000);
});

test("overdue and pending create no payment", () => {
  for (const status of ["late", "pending", "vacant", "staff"]) {
    const decision = resolveCollectionPayment({
      dueFils: 120000, recognizedPaidFils: 0, status, statedAmountFils: 120000,
    });
    assert.equal(decision.newPaymentFils, 0);
    assert.equal(decision.error, null);
  }
});

test("an empty duplicate obligation is omitted and a paid one is kept", () => {
  const a = { id: "a", spaceId: "s", period: "2026-09", state: "active", amountFils: 120000, rentalId: "r1" };
  const b = { id: "b", spaceId: "s", period: "2026-09", state: "active", amountFils: 120000, rentalId: "r2" };
  const receipts = [{ id: "rc", obligationId: "a", state: RECEIPT_STATE.RECOGNIZED, amountFils: 120000, method: "cash" }];
  const rentals = [
    { id: "r1", startDate: "2026-09-01", endDate: "2026-10-04" },
    { id: "r2", startDate: "2026-10-01", endDate: null },
  ];
  const kept = collapseOneRentPerSpacePeriod([a, b], receipts, rentals);
  assert.deepEqual(kept.map((o) => o.id), ["a"]);
});

test("a later non-overlapping tenant in the same month stays in target", () => {
  const a = { id: "a", spaceId: "s", period: "2026-09", state: "active", amountFils: 920000, rentalId: "r1" };
  const b = { id: "b", spaceId: "s", period: "2026-09", state: "active", amountFils: 800000, rentalId: "r2" };
  const receipts = [{ id: "rc", obligationId: "a", state: RECEIPT_STATE.RECOGNIZED, amountFils: 920000, method: "cash" }];
  const rentals = [
    { id: "r1", startDate: "2026-09-01", endDate: "2026-09-20" },
    { id: "r2", startDate: "2026-09-21", endDate: null },
  ];
  const kept = collapseOneRentPerSpacePeriod([a, b], receipts, rentals);
  assert.deepEqual(kept.map((o) => o.id).sort(), ["a", "b"]);
});

test("two paid obligations on one space stay visible so money is not hidden", () => {
  const a = { id: "a", spaceId: "s", period: "2026-09", state: "active", amountFils: 120000, rentalId: "r1" };
  const b = { id: "b", spaceId: "s", period: "2026-09", state: "active", amountFils: 120000, rentalId: "r2" };
  const receipts = [
    { id: "rc1", obligationId: "a", state: RECEIPT_STATE.RECOGNIZED, amountFils: 120000, method: "cash" },
    { id: "rc2", obligationId: "b", state: RECEIPT_STATE.RECOGNIZED, amountFils: 120000, method: "cash" },
  ];
  const kept = collapseOneRentPerSpacePeriod([a, b], receipts);
  assert.equal(kept.length, 2);
});

test("staff purpose obligation is excluded from target and a rented one stays after collection", () => {
  const rented = {
    id: "ob-r", spaceId: "s1", period: "2026-09", state: "active", amountFils: 120000,
    rentalId: "rent-1", dueDate: "2026-09-01",
  };
  const staff = {
    id: "ob-s", spaceId: "s2", period: "2026-09", state: "active", amountFils: 180000,
    rentalId: "rent-2", purpose: "staff", dueDate: "2026-09-01",
  };
  const rentals = [
    { id: "rent-1", spaceId: "s1", state: "active", startDate: "2026-09-01" },
    { id: "rent-2", spaceId: "s2", state: "active", purpose: "staff", startDate: "2026-09-01" },
  ];
  const receipts = [{
    id: "rc", obligationId: "ob-r", state: RECEIPT_STATE.RECOGNIZED, amountFils: 120000, method: "cash", period: "2026-09",
  }];
  const live = liveObligationsForPeriod([rented, staff], rentals, receipts);
  assert.deepEqual(live.map((o) => o.id), ["ob-r"]);
  const summary = periodSummary({
    obligations: live, receipts, deposits: [], expenses: [], asOfDate: "2026-09-20", holdingPeriod: "2026-09",
  });
  assert.equal(summary.targetFils, 120000);
  assert.equal(summary.collectedFils, 120000);
});
