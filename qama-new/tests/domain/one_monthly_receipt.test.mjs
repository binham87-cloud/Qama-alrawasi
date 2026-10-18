import test from "node:test";
import assert from "node:assert/strict";
import {
  DomainError,
  assertNoSecondMonthlyRental,
  monthlyRentalReceiptBlocksSpace,
  monthlyRentBlockedMessage,
} from "../../functions/domain/finance.mjs";

const SPACE = "space-1";
const UNIT = "unit-1";

function receipt(overrides) {
  return {
    id: "rcpt-1",
    spaceId: SPACE,
    unitId: UNIT,
    period: "2026-10",
    obligationId: "ob-a",
    state: "recognized",
    amountFils: 120000,
    sourceType: null,
    ...overrides,
  };
}

test("a recognized receipt on another contract blocks the same space and month", () => {
  assert.equal(monthlyRentalReceiptBlocksSpace({
    receipt: receipt({}), spaceId: SPACE, unitId: UNIT, period: "2026-10", obligationId: "ob-b",
  }), true);
  assert.throws(
    () => assertNoSecondMonthlyRental({
      receipts: [receipt({})],
      spaceId: SPACE, unitId: UNIT, period: "2026-10", obligationId: "ob-b",
    }),
    (err) => err instanceof DomainError
      && err.code === "MONTHLY_RENT_ALREADY_RECORDED"
      && err.details.message === monthlyRentBlockedMessage("2026-10-31"),
  );
});

test("the same obligation, another month, a reversal, and a daily booking do not block", () => {
  const rows = [
    receipt({ obligationId: "ob-a" }),
    receipt({ id: "rcpt-rev", state: "reversed" }),
    receipt({ id: "rcpt-daily", sourceType: "daily_booking", obligationId: "daily:1" }),
    receipt({ id: "rcpt-nov", period: "2026-11", obligationId: "ob-nov" }),
    receipt({ id: "rcpt-other", spaceId: "space-2", obligationId: "ob-other" }),
  ];
  assertNoSecondMonthlyRental({
    receipts: rows, spaceId: SPACE, unitId: UNIT, period: "2026-10", obligationId: "ob-a",
  });
  assert.equal(monthlyRentalReceiptBlocksSpace({
    receipt: receipt({ state: "pending", obligationId: "ob-closed" }),
    spaceId: SPACE, unitId: UNIT, period: "2026-10", obligationId: "ob-new",
  }), true);
});
