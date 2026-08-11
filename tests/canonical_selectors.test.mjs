import test from "node:test";
import assert from "node:assert/strict";
import { blankState, executeCommand } from "../functions/domain/command_processor.mjs";
import { money } from "../functions/domain/financial_engine.mjs";
import { managerMonthlyReport, monthlyOperationalProjection } from "../functions/domain/canonical_selectors.mjs";

const manager={id:"manager_1",role:"owner",active:true}; const employee={id:"employee_1",role:"employee",active:true};
const ctx=(operationId,actor,payload,now="2026-08-02T10:00:00.000Z")=>({operationId,actor,payload,now});
function fixture(){const state=blankState();state.openingBalances={company:0,revenue:0,deduction:0};state.cycles.push({id:"cycle:selector:1",unitId:"unit:101",tenant:"Tenant",baseAmountFils:money(3000),reportingMonth:"2026_07",dueDate:"2026-07-30",status:"open_late",financialVersion:0});return state;}

test("operational cards equal the sum of their drill-down details",()=>{
  let state=fixture();({state}=executeCommand(state,"createCashReceipt",ctx("op:sel:cash1",employee,{cycleId:"cycle:selector:1",amountFils:money(1000),paymentDate:"2026-07-30"})));
  let view=monthlyOperationalProjection(state,"2026_07","2026-08-02");
  assert.equal(view.cards.targetFils,view.details.target.reduce((s,x)=>s+x.targetFils,0));
  assert.equal(view.cards.receivedNotDepositedFils,view.details.receivedNotDeposited.reduce((s,x)=>s+x.amountFils,0));
  assert.equal(view.cards.arrearsFils,view.details.arrears.reduce((s,x)=>s+x.remainingFils,0));
  ({state}=executeCommand(state,"createDepositRequest",ctx("op:sel:dep1",employee,{allocations:[{cashLotId:"lot:op:sel:cash1",amountFils:money(400)}],depositDate:"2026-08-02"})));
  ({state}=executeCommand(state,"approveDeposit",ctx("op:sel:depapp1",manager,{depositRequestId:"dep:op:sel:dep1"})));
  view=monthlyOperationalProjection(state,"2026_07","2026-08-02");
  assert.equal(view.cards.collectedFils,money(400));assert.equal(view.cards.collectedFils,view.details.collected.reduce((s,x)=>s+x.amountFils,0));assert.equal(view.cards.receivedNotDepositedFils,money(600));
});

test("manager report reuses the canonical operational projection",()=>{
  const state=fixture();const view=monthlyOperationalProjection(state,"2026_07","2026-07-01");const report=managerMonthlyReport(state,"2026_07","2026-07-01");assert.deepEqual(report.cards,view.cards);assert.deepEqual(report.details,view.details);
});
