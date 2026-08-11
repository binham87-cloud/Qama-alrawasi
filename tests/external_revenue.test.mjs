import test from "node:test";
import assert from "node:assert/strict";
import { blankState, executeCommand } from "../functions/domain/command_processor.mjs";
import { managerMonthlyReport } from "../functions/domain/canonical_selectors.mjs";

const manager={id:"manager",role:"manager",active:true};
const employee={id:"employee",role:"employee",active:true};
const payload={amountFils:125000,date:"2026-08-10",source:"بيع أثاث قديم",reason:"إيراد حقيقي غير مرتبط بمستأجر"};
const run=(state,command,operationId,p=payload,actor=manager)=>executeCommand(state,command,{operationId:`external-revenue-test:${operationId}`,payload:p,actor,now:"2026-08-10T01:00:00.000Z"});

test("ER01/ER07 valid other income is ledger-backed and increases Revenue",()=>{
  const s=blankState(); s.balances.revenue=500000;
  const {state,result}=run(s,"recordExternalRevenue","er01");
  assert.equal(result.amountFils,125000); assert.equal(state.balances.revenue,625000);
  assert.equal(state.externalRevenues.length,1); assert.equal(state.ledger.length,1); assert.equal(state.audit.length,1);
});
test("ER02 employee is denied",()=>assert.throws(()=>run(blankState(),"recordExternalRevenue","er02",payload,employee),/MANAGER_REQUIRED/));
test("ER03 non-positive amount is denied",()=>assert.throws(()=>run(blankState(),"recordExternalRevenue","er03",{...payload,amountFils:0}),/AMOUNT_MUST_BE_POSITIVE/));
test("ER04 missing source is denied",()=>assert.throws(()=>run(blankState(),"recordExternalRevenue","er04",{...payload,source:""}),/SOURCE_REQUIRED/));
test("ER05 missing reason is denied",()=>assert.throws(()=>run(blankState(),"recordExternalRevenue","er05",{...payload,reason:""}),/REASON_REQUIRED/));
test("ER06 same operation replay is exactly once",()=>{
  const first=run(blankState(),"recordExternalRevenue","er06");
  const second=run(first.state,"recordExternalRevenue","er06");
  assert.equal(second.replay,true); assert.equal(second.state.externalRevenues.length,1); assert.equal(second.state.ledger.length,1);
});
test("ER08-ER10 tenant and custody projections remain unchanged",()=>{
  const s=blankState(); s.cycles.push({id:"c1",unitId:"u1",tenant:"T",baseAmountFils:300000,reportingMonth:"2026_08",dueDate:"2026-08-01",status:"open",financialVersion:0});
  const before=managerMonthlyReport(s,"2026_08","2026-08-10");
  const afterState=run(s,"recordExternalRevenue","er08").state;
  const after=managerMonthlyReport(afterState,"2026_08","2026-08-10");
  assert.deepEqual(after.cards,before.cards); assert.equal(after.accounting.externalRevenueFils,125000);
});
test("ER11 valid reversal debits the same Revenue flow",()=>{
  const s=blankState(); s.balances.revenue=200000;
  const first=run(s,"recordExternalRevenue","er11");
  const reversed=run(first.state,"reverseExternalRevenue","er11-rev",{externalRevenueId:first.result.externalRevenueId,reason:"إدخال خاطئ"});
  assert.equal(reversed.state.balances.revenue,200000); assert.equal(reversed.state.externalRevenues[0].status,"reversed"); assert.equal(reversed.state.ledger.length,2);
});
test("ER12 a second economic reversal is denied",()=>{
  const s=blankState(); s.balances.revenue=200000; const first=run(s,"recordExternalRevenue","er12");
  const rev=run(first.state,"reverseExternalRevenue","er12-r1",{externalRevenueId:first.result.externalRevenueId,reason:"خطأ"});
  assert.throws(()=>run(rev.state,"reverseExternalRevenue","er12-r2",{externalRevenueId:first.result.externalRevenueId,reason:"مرة ثانية"}),/ALREADY_REVERSED/);
});
test("ER13 Rules retain backend-only direct-write guard",async()=>{
  const fs=(await import("node:fs")).default; const rules=fs.readFileSync("firestore-v11.rules","utf8");
  assert.match(rules,/match \/externalRevenues\/\{id\}[\s\S]*?allow write: if false/);
});
test("ER14 report classifies Other Income separately from tenant Collected",()=>{
  const state=run(blankState(),"recordExternalRevenue","er14").state; const report=managerMonthlyReport(state,"2026_08","2026-08-10");
  assert.equal(report.cards.collectedFils,0); assert.equal(report.accounting.externalRevenueFils,125000); assert.equal(report.accounting.externalRevenue[0].source,payload.source);
});
test("tenant-linked payload cannot bypass rent workflows",()=>assert.throws(()=>run(blankState(),"recordExternalRevenue","er-tenant",{...payload,cycleId:"cycle-1"}),/TENANT_REVENUE_WORKFLOW_REQUIRED/));
test("reversal requires enough Revenue balance",()=>{
  const first=run(blankState(),"recordExternalRevenue","er-insufficient"); first.state.balances.revenue=0;
  assert.throws(()=>run(first.state,"reverseExternalRevenue","er-insufficient-r",{externalRevenueId:first.result.externalRevenueId,reason:"خطأ"}),/INSUFFICIENT_BALANCE/);
});
