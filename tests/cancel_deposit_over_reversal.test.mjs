import test from "node:test";
import assert from "node:assert/strict";
import { blankState, executeCommand } from "../functions/domain/command_processor.mjs";

const owner = { id: "saeed", role: "owner", active: true };
const exec = (s, cmd, payload, id, actor = owner) =>
  executeCommand(s, cmd, { operationId: id, payload, actor, now: "2026-08-12T00:00:00.000Z" });

test("CDOR01 cancelDeposit throws SETTLEMENT_OVER_REVERSAL when allocation already unsettled", () => {
  const s = blankState();
  s.canonicalControl = { state: "CANONICAL_ACTIVE", version: 1 };
  s.balances = { company: 0, revenue: 100000, deduction: 0 };
  s.depositRequests = [{
    id: "dep:1", status: "approved", allocations: [{ cashLotId: "lot:1", amountFils: 50000 }],
    requestedAmountFils: 50000,
  }];
  s.cashLots = [{ id: "lot:1", originPaymentId: "pay:1", originalAmountFils: 50000, currentHolder: "yahia", status: "held" }];
  s.allocations = [{ id: "alloc:1", paymentId: "pay:1", amountFils: 50000, settledAmountFils: 0, settlementStatus: "unsettled" }];
  s.cashMovements = [];
  assert.throws(
    () => exec(s, "cancelDeposit", { depositRequestId: "dep:1", reason: "خطأ" }, "depcancel:over", owner),
    (e) => String(e.message).includes("SETTLEMENT_OVER_REVERSAL"),
  );
});
