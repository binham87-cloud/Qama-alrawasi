import test from "node:test";
import assert from "node:assert/strict";
import { blankState, executeCommand } from "../functions/domain/command_processor.mjs";
import { monthlyOperationalProjection } from "../functions/domain/canonical_selectors.mjs";
import { cashLotAvailable } from "../functions/domain/financial_engine.mjs";

const month = "2026_08";
const owner = { id: "saeed", role: "owner", active: true };
const employee = { id: "yahia", role: "employee", active: true };

const base = () => {
  const s = blankState();
  s.canonicalControl = { state: "CANONICAL_ACTIVE", version: 8 };
  s.financialTruthVersion = 3;
  s.balances = { company: 0, revenue: 0, deduction: 0 };
  s.rentableSpaces = [{ id: "space:101-3", unitId: "unit:101", status: "active" }];
  return s;
};

const exec = (s, cmd, payload, id, actor = employee) =>
  executeCommand(s, cmd, { operationId: id, payload, actor, now: "2026-08-12T00:00:00.000Z" });

test("DRCP01 deposit cancel restores employee custody in projection", () => {
  let s = base();
  s = exec(s, "setSpaceRental", {
    spaceId: "space:101-3", reportingMonth: month, occupancy: "occupied",
    contractualAmountFils: 130000, dueDate: "2026-08-01", startDate: "2026-08-01", tenantName: "أحمد",
  }, "rental:dr:1").state;
  const cycleId = s.cycles[0].id;
  s = exec(s, "createCashReceipt", { cycleId, amountFils: 130000, paymentDate: "2026-08-05" }, "receipt:dr:1").state;
  const lot = s.cashLots[0];
  s = exec(s, "createDepositRequest", {
    allocations: [{ cashLotId: lot.id, amountFils: 130000 }],
    amountFils: 130000, depositDate: "2026-08-06", monthKey: month,
  }, "deposit:dr:1").state;
  const depId = s.depositRequests[0].id;
  s = exec(s, "approveDeposit", { depositRequestId: depId }, "deposit:approve:dr:1", owner).state;
  assert.equal(monthlyOperationalProjection(s, month, "2026-08-12").cards.receivedNotDepositedFils, 0);
  s = exec(s, "cancelDeposit", { depositRequestId: depId, reason: "خطأ" }, "depcancel:dr:1", owner).state;
  const p = monthlyOperationalProjection(s, month, "2026-08-12");
  assert.equal(p.cards.receivedNotDepositedFils, 130000);
  assert.equal(p.cards.depositedFils, 0);
  const lotAfter = s.cashLots[0];
  assert.equal(cashLotAvailable(lotAfter, s.cashMovements), 130000);
});
