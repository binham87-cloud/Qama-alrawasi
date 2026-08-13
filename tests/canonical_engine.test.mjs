import test from "node:test";
import assert from "node:assert/strict";
import { blankState, executeCommand } from "../functions/domain/command_processor.mjs";
import { cardProjection, custodyProjection, cycleProjection, money } from "../functions/domain/financial_engine.mjs";
import { auditCanonical } from "../auditor/canonical_auditor.mjs";

const employee = { id: "employee:yahia", role: "employee", active: true };
const employee2 = { id: "employee:nader", role: "employee", active: true };
const manager = { id: "manager:saeed", role: "owner", active: true };
const ctx = (operationId, actor, payload, now = "2026-07-30T12:00:00.000Z") => ({ operationId, actor, payload, now });
const seeded = () => ({ ...blankState(), cycles: [{ id: "cycle:tenant-a:1", tenancyId: "tenant-a", baseAmountFils: money(3000), reportingMonth: "2026_07", dueDate: "2026-08-10", status: "open_not_due" }] });

test("critical cash reservation then deposit does not reduce remaining twice", () => {
  let state = seeded();
  ({ state } = executeCommand(state, "createCashReceipt", ctx("op:cash:0001", employee, { cycleId: "cycle:tenant-a:1", amountFils: money(1000), paymentDate: "2026-07-30" })));
  assert.deepEqual(cycleProjection(state.cycles[0], state), { targetFils: money(3000), tenantReceivedReservedFils: money(1000), remainingCollectibleFils: money(2000), collectedFils: 0, legacyOpeningReservedFils: 0 });
  assert.equal(custodyProjection(state).totalFils, money(1000));
  ({ state } = executeCommand(state, "createDepositRequest", ctx("op:dep:req:1", employee, { allocations: [{ cashLotId: "lot:op:cash:0001", amountFils: money(1000) }], depositDate: "2026-08-02" })));
  ({ state } = executeCommand(state, "approveDeposit", ctx("op:dep:approve:1", manager, { depositRequestId: "dep:op:dep:req:1" }, "2026-08-02T10:00:00.000Z")));
  assert.deepEqual(cycleProjection(state.cycles[0], state), { targetFils: money(3000), tenantReceivedReservedFils: money(1000), remainingCollectibleFils: money(2000), collectedFils: money(1000), legacyOpeningReservedFils: 0 });
  assert.equal(custodyProjection(state).totalFils, 0);
  assert.equal(state.balances.revenue, money(1000));
  assert.equal(cardProjection(state, "2026_07").collectedFils, money(1000));
});

test("same operation 1x/2x/10x is exactly once", () => {
  let state = seeded(); const commandCtx = ctx("op:cash:idem1", employee, { cycleId: "cycle:tenant-a:1", amountFils: money(500), paymentDate: "2026-07-30" });
  for (let i = 0; i < 10; i++) ({ state } = executeCommand(state, "createCashReceipt", commandCtx));
  assert.equal(state.paymentIntents.length, 1); assert.equal(state.cashLots.length, 1); assert.equal(state.allocations.length, 1);
  assert.equal(cycleProjection(state.cycles[0], state).remainingCollectibleFils, money(2500));
});

test("same operation identity with different payload is rejected", () => {
  let state = seeded(); ({ state } = executeCommand(state, "createCashReceipt", ctx("op:cash:idem2", employee, { cycleId: "cycle:tenant-a:1", amountFils: money(500), paymentDate: "2026-07-30" })));
  assert.throws(() => executeCommand(state, "createCashReceipt", ctx("op:cash:idem2", employee, { cycleId: "cycle:tenant-a:1", amountFils: money(600), paymentDate: "2026-07-30" })), /IDEMPOTENCY_PAYLOAD_MISMATCH/);
});

test("competing collections cannot exceed remaining", () => {
  let base = seeded(); let a = executeCommand(base, "createCashReceipt", ctx("op:cash:a001", employee, { cycleId: "cycle:tenant-a:1", amountFils: money(2000), paymentDate: "2026-07-30" })).state;
  assert.throws(() => executeCommand(a, "createCashReceipt", ctx("op:cash:b001", employee2, { cycleId: "cycle:tenant-a:1", amountFils: money(2000), paymentDate: "2026-07-30" })), /OVERPAYMENT:100000/);
});

test("pending bank has no effect; approval rechecks remaining", () => {
  let state = seeded();
  ({ state } = executeCommand(state, "createBankPayment", ctx("op:bank:req1", employee, { cycleId: "cycle:tenant-a:1", amountFils: money(2000), paymentDate: "2026-07-30" })));
  assert.equal(cycleProjection(state.cycles[0], state).remainingCollectibleFils, money(3000));
  ({ state } = executeCommand(state, "createCashReceipt", ctx("op:cash:comp1", employee2, { cycleId: "cycle:tenant-a:1", amountFils: money(2000), paymentDate: "2026-07-30" })));
  assert.throws(() => executeCommand(state, "approveBankPayment", ctx("op:bank:approve1", manager, { paymentId: "pay:op:bank:req1" })), /OVERPAYMENT:100000/);
});

test("cross-month deposit is attributed to original payment month", () => {
  let state = seeded();
  ({ state } = executeCommand(state, "createCashReceipt", ctx("op:cash:cross1", employee, { cycleId: "cycle:tenant-a:1", amountFils: money(700), paymentDate: "2026-07-30" })));
  ({ state } = executeCommand(state, "createDepositRequest", ctx("op:dep:req:cross", employee, { allocations: [{ cashLotId: "lot:op:cash:cross1", amountFils: money(700) }], depositDate: "2026-08-02" })));
  ({ state } = executeCommand(state, "approveDeposit", ctx("op:dep:approve:cross", manager, { depositRequestId: "dep:op:dep:req:cross" }, "2026-08-02T10:00:00.000Z")));
  assert.equal(cardProjection(state, "2026_07").collectedFils, money(700)); assert.equal(cardProjection(state, "2026_08").collectedFils, 0);
});

test("custody transfer changes holder but not global undeposited", () => {
  let state = seeded();
  ({ state } = executeCommand(state, "createCashReceipt", ctx("op:cash:xfer1", employee, { cycleId: "cycle:tenant-a:1", amountFils: money(1000), paymentDate: "2026-07-30" })));
  ({ state } = executeCommand(state, "createCustodyTransfer", ctx("op:xfer:req1", employee, { to: employee2.id, allocations: [{ cashLotId: "lot:op:cash:xfer1", amountFils: money(1000) }] })));
  assert.equal(custodyProjection(state).byHolder[employee.id], money(1000));
  ({ state } = executeCommand(state, "confirmCustodyTransfer", ctx("op:xfer:confirm1", employee2, { transferId: "xfer:op:xfer:req1" })));
  assert.equal(custodyProjection(state).totalFils, money(1000)); assert.equal(custodyProjection(state).byHolder[employee2.id], money(1000));
});

test("partial custody transfer preserves lineage and leaves the remainder with sender", () => {
  let state = seeded();
  ({ state } = executeCommand(state, "createCashReceipt", ctx("op:cash:xferpartial1", employee, { cycleId: "cycle:tenant-a:1", amountFils: money(3000), paymentDate: "2026-07-30" })));
  ({ state } = executeCommand(state, "createCustodyTransfer", ctx("op:xfer:reqpartial1", employee, { to: employee2.id, allocations: [{ cashLotId: "lot:op:cash:xferpartial1", amountFils: money(1000) }] })));
  ({ state } = executeCommand(state, "confirmCustodyTransfer", ctx("op:xfer:confirmpartial1", employee2, { transferId: "xfer:op:xfer:reqpartial1" })));
  const custody = custodyProjection(state);
  assert.equal(custody.totalFils, money(3000));
  assert.equal(custody.byHolder[employee.id], money(2000));
  assert.equal(custody.byHolder[employee2.id], money(1000));
  assert.equal(state.cashLots.find((x) => x.currentHolder === employee2.id).parentLotId, "lot:op:cash:xferpartial1");
});

test("refund before deposit reduces custody and restores collectible", () => {
  let state = seeded(); ({ state } = executeCommand(state, "createCashReceipt", ctx("op:cash:refund1", employee, { cycleId: "cycle:tenant-a:1", amountFils: money(1000), paymentDate: "2026-07-30" })));
  ({ state } = executeCommand(state, "refundPayment", ctx("op:refund:cash1", manager, { allocationId: "alloc:op:cash:refund1", amountFils: money(400) })));
  assert.equal(custodyProjection(state).totalFils, money(600)); assert.equal(cycleProjection(state.cycles[0], state).remainingCollectibleFils, money(2400));
});

test("independent auditor reconciles canonical scenario", () => {
  let state = seeded(); state.openingBalances = { company: 0, revenue: 0, deduction: 0 };
  ({ state } = executeCommand(state, "createCashReceipt", ctx("op:cash:audit1", employee, { cycleId: "cycle:tenant-a:1", amountFils: money(1000), paymentDate: "2026-07-30" })));
  const result = auditCanonical(state); assert.equal(result.ok, true, JSON.stringify(result.errors)); assert.equal(result.receivedNotDepositedFils, money(1000));
});

test("discount affects one cycle and reversal restores target", () => {
  let state=seeded(); ({state}=executeCommand(state,"approveDiscount",ctx("op:discount:001",manager,{cycleId:"cycle:tenant-a:1",amountFils:money(500),reason:"approved"})));
  assert.equal(cycleProjection(state.cycles[0],state).targetFils,money(2500));
  ({state}=executeCommand(state,"reverseDiscount",ctx("op:discount:rev1",manager,{discountId:"discount:op:discount:001"})));
  assert.equal(cycleProjection(state.cycles[0],state).targetFils,money(3000));
});

test("eviction zero payment cancels target; partial payment records uncollected", () => {
  let zero=seeded(); zero.cycles[0].financialVersion=0;
  ({state:zero}=executeCommand(zero,"approveEviction",ctx("op:evict:zero1",manager,{cycleId:"cycle:tenant-a:1",expectedFinancialVersion:0,reason:"vacated"})));
  assert.equal(zero.cycles[0].status,"cancelled_eviction"); assert.equal(zero.cycles[0].cancelledTargetFils,money(3000));
  let partial=seeded(); partial.cycles[0].financialVersion=0;
  ({state:partial}=executeCommand(partial,"createCashReceipt",ctx("op:cash:evict1",employee,{cycleId:"cycle:tenant-a:1",amountFils:money(1000),paymentDate:"2026-07-30"})));
  ({state:partial}=executeCommand(partial,"approveEviction",ctx("op:evict:part1",manager,{cycleId:"cycle:tenant-a:1",expectedFinancialVersion:1,reason:"vacated"})));
  assert.equal(partial.cycles[0].uncollectedAtEvictionFils,money(2000));
});

test("expense reversal returns same original account", () => {
  let state=seeded();state.balances.revenue=money(5000);
  ({state}=executeCommand(state,"executeExpense",ctx("op:expense:001",manager,{account:"revenue",amountFils:money(600),reason:"repair"})));
  assert.equal(state.balances.revenue,money(4400));
  ({state}=executeCommand(state,"reverseExpense",ctx("op:expense:rev1",manager,{expenseId:"expense:op:expense:001"})));
  assert.equal(state.balances.revenue,money(5000));
});

test("manager can pay installment from any of three balances", () => {
  for(const account of ["company","revenue","deduction"]){let state=seeded();state.balances[account]=money(1000);({state}=executeCommand(state,"payInstallment",ctx(`op:inst:${account}1`,manager,{account,amountFils:money(400),obligationId:`obligation:${account}:001`})));assert.equal(state.balances[account],money(600));}
});

test("month close blocks pending, force closes, then reopens with history", () => {
  let state=seeded();state.requests.push({id:"request:pending:001",monthKey:"2026_07",status:"pending"});
  assert.throws(()=>executeCommand(state,"closeMonth",ctx("op:close:normal1",manager,{monthKey:"2026_07"})),/MONTH_CLOSE_BLOCKED/);
  ({state}=executeCommand(state,"forceCloseMonth",ctx("op:close:force1",manager,{monthKey:"2026_07"})));
  assert.equal(state.monthStates[0].status,"force_closed");assert.deepEqual(state.monthStates[0].history[0].pendingSnapshot,["request:pending:001"]);
  ({state}=executeCommand(state,"reopenMonth",ctx("op:reopen:001",manager,{monthKey:"2026_07",reason:"approved correction"})));
  assert.equal(state.monthStates[0].status,"reopened");assert.equal(state.monthStates[0].history.length,2);
});

test("deposit request edit/reject/resubmit preserves history and has no financial effect", () => {
  let state=seeded();({state}=executeCommand(state,"createCashReceipt",ctx("op:cash:depflow1",employee,{cycleId:"cycle:tenant-a:1",amountFils:money(1000),paymentDate:"2026-07-30"})));
  ({state}=executeCommand(state,"createDepositRequest",ctx("op:dep:flow1",employee,{allocations:[{cashLotId:"lot:op:cash:depflow1",amountFils:money(500)}],depositDate:"2026-08-02"})));
  ({state}=executeCommand(state,"rejectDeposit",ctx("op:dep:reject1",manager,{depositRequestId:"dep:op:dep:flow1",reason:"reference unclear"})));
  ({state}=executeCommand(state,"editDepositRequest",ctx("op:dep:edit1",employee,{depositRequestId:"dep:op:dep:flow1",expectedVersion:2,allocations:[{cashLotId:"lot:op:cash:depflow1",amountFils:money(600)}],depositDate:"2026-08-03"})));
  assert.equal(state.depositRequests[0].status,"pending");assert.equal(state.depositRequests[0].history.length,2);assert.equal(state.balances.revenue,0);assert.equal(custodyProjection(state).totalFils,money(1000));
});

test("custody rejection has no movement and manager reversal requires untouched child lot", () => {
  let state=seeded();({state}=executeCommand(state,"createCashReceipt",ctx("op:cash:xflow1",employee,{cycleId:"cycle:tenant-a:1",amountFils:money(1000),paymentDate:"2026-07-30"})));
  ({state}=executeCommand(state,"createCustodyTransfer",ctx("op:x:reqreject1",employee,{to:employee2.id,allocations:[{cashLotId:"lot:op:cash:xflow1",amountFils:money(200)}]})));
  ({state}=executeCommand(state,"rejectCustodyTransfer",ctx("op:x:reject1",employee2,{transferId:"xfer:op:x:reqreject1",reason:"not received"})));
  assert.equal(custodyProjection(state).byHolder[employee.id],money(1000));
  ({state}=executeCommand(state,"createCustodyTransfer",ctx("op:x:reqconfirm2",employee,{to:employee2.id,allocations:[{cashLotId:"lot:op:cash:xflow1",amountFils:money(300)}]})));
  ({state}=executeCommand(state,"confirmCustodyTransfer",ctx("op:x:confirm2",employee2,{transferId:"xfer:op:x:reqconfirm2"})));
  ({state}=executeCommand(state,"reverseCustodyTransfer",ctx("op:x:reverse2",manager,{transferId:"xfer:op:x:reqconfirm2"})));
  assert.equal(custodyProjection(state).totalFils,money(1000));assert.equal(custodyProjection(state).byHolder[employee.id],money(1000));
});

test("discount and eviction requests enforce stale financial version", () => {
  let state=seeded();state.cycles[0].financialVersion=0;
  ({state}=executeCommand(state,"requestDiscount",ctx("op:disc:req1",employee,{cycleId:"cycle:tenant-a:1",amountFils:money(500),reason:"approved request"})));
  ({state}=executeCommand(state,"approveDiscountRequest",ctx("op:disc:approve1",manager,{discountId:"discount:op:disc:req1"})));
  assert.equal(cycleProjection(state.cycles[0],state).targetFils,money(2500));
  ({state}=executeCommand(state,"requestEviction",ctx("op:ev:req1",employee,{cycleId:"cycle:tenant-a:1",reason:"vacating"})));
  ({state}=executeCommand(state,"createCashReceipt",ctx("op:cash:afterevreq1",employee,{cycleId:"cycle:tenant-a:1",amountFils:money(100),paymentDate:"2026-07-30"})));
  assert.throws(()=>executeCommand(state,"approveEvictionRequest",ctx("op:ev:approve1",manager,{evictionId:"eviction:op:ev:req1"})),/STALE_EVICTION_REQUEST/);
});

test("balance transfer, adjustment and installment reversals restore original accounts once", () => {
  let state=seeded();state.balances={company:money(2000),revenue:money(2000),deduction:money(2000)};
  ({state}=executeCommand(state,"transferBalance",ctx("op:bt:1",manager,{source:"company",destination:"revenue",amountFils:money(500),reason:"allocation"})));
  ({state}=executeCommand(state,"reverseBalanceTransfer",ctx("op:bt:r1",manager,{transferId:"balxfer:op:bt:1"})));assert.deepEqual(state.balances,{company:money(2000),revenue:money(2000),deduction:money(2000)});
  ({state}=executeCommand(state,"adjustBalance",ctx("op:adj:1",manager,{account:"deduction",amountFils:money(100),direction:"increase",reason:"documented"})));
  ({state}=executeCommand(state,"reverseAdjustment",ctx("op:adj:r1",manager,{adjustmentId:"adjustment:op:adj:1"})));assert.equal(state.balances.deduction,money(2000));
  ({state}=executeCommand(state,"payInstallment",ctx("op:inst:1",manager,{account:"revenue",amountFils:money(300),obligationId:"obligation:test:001"})));
  ({state}=executeCommand(state,"reverseInstallment",ctx("op:inst:r1",manager,{installmentId:"installment:op:inst:1"})));assert.equal(state.balances.revenue,money(2000));
  assert.throws(()=>executeCommand(state,"reverseInstallment",ctx("op:inst:r2",manager,{installmentId:"installment:op:inst:1"})),/ALREADY_REVERSED/);
});

test("expense request approval selects account and reversal returns same account", () => {
  let state=seeded();state.balances.company=money(1000);
  ({state}=executeCommand(state,"requestExpense",ctx("op:ex:req1",employee,{amountFils:money(250),reason:"repair"})));
  ({state}=executeCommand(state,"approveExpense",ctx("op:ex:app1",manager,{expenseId:"expense:op:ex:req1",account:"company"})));
  assert.equal(state.balances.company,money(750));
  ({state}=executeCommand(state,"reverseExpense",ctx("op:ex:rev1",manager,{expenseId:"expense:op:ex:req1"})));assert.equal(state.balances.company,money(1000));
});

test("daily cash booking permits housing before deposit and refund follows custody", () => {
  let state=seeded();state.cycles=[];
  ({state}=executeCommand(state,"createDailyBooking",ctx("op:daily:cash1",employee,{tenancyId:"daily:t1",unitId:"unit:1",tenant:"Guest",amountFils:money(500),method:"cash",paymentDate:"2026-07-30"})));
  assert.equal(state.dailyBookings[0].housingAllowed,true);assert.equal(cardProjection(state,"2026_07").targetFils,money(500));assert.equal(cardProjection(state,"2026_07").collectedFils,0);assert.equal(custodyProjection(state).totalFils,money(500));
  ({state}=executeCommand(state,"refundDailyBooking",ctx("op:daily:refund1",manager,{bookingId:"booking:op:daily:cash1",reason:"cancelled"})));
  assert.equal(custodyProjection(state).totalFils,0);assert.equal(cardProjection(state,"2026_07").targetFils,0);
});
