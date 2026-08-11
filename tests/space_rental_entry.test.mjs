import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { blankState, executeCommand } from "../functions/domain/command_processor.mjs";
import { monthlyOperationalProjection } from "../functions/domain/canonical_selectors.mjs";

const month="2026_7";
const owner={id:"saeed",role:"owner",active:true};
const employee={id:"yahia",role:"employee",active:true};

// هيكل قائم: عقار + وحدة + مساحتان. لا يُنشأ من جديد في أي اختبار.
const seed=()=>{
  const s=blankState();
  s.canonicalControl={state:"CANONICAL_ACTIVE",version:8};
  s.financialTruthVersion=3;
  s.balances={company:49175400,revenue:7086395,deduction:9117248};
  s.openingBalances=structuredClone(s.balances);
  s.properties=[{id:"property:1",name:"قمة الرواسي",status:"active"}];
  s.units=[{id:"unit:101",propertyId:"property:1",name:"شقة 101",status:"active"}];
  s.rentableSpaces=[
    {id:"space:101-3",unitId:"unit:101",propertyId:"property:1",name:"بارتشن 3",partitionId:"3",status:"active"},
    {id:"space:101-4",unitId:"unit:101",propertyId:"property:1",name:"بارتشن 4",partitionId:"4",status:"active"}
  ];
  return s;
};
const occupied={spaceId:"space:101-3",reportingMonth:month,occupancy:"occupied",
  contractualAmountFils:130000,dueDate:"2026-08-01",startDate:"2026-08-01",
  tenantName:"أحمد",tenantPhone:"0501234567"};
const run=(state,payload,id="rental:1",actor=employee)=>
  executeCommand(state,"setSpaceRental",{operationId:id,payload,actor,now:"2026-08-12T00:00:00.000Z"});

test("SR01 employee records current rental without recreating structure",()=>{
  const before=seed(), out=run(before,occupied), s=out.state;
  assert.equal(s.properties.length,1);
  assert.equal(s.units.length,1);
  assert.equal(s.rentableSpaces.length,2);           // لم يُنشأ هيكل جديد
  assert.equal(s.cycles.length,1);
  assert.equal(s.cycles[0].baseAmountFils,130000);
  assert.equal(s.cycles[0].dueDate,"2026-08-01");
  assert.equal(s.cycles[0].origin,"employee_rental_entry");
});

test("SR02 rental entry creates zero financial effect",()=>{
  const before=seed(), s=run(before,occupied).state;
  for(const key of ["allocations","paymentIntents","collectionEvents","cashLots","cashMovements",
                    "depositRequests","custodyTransfers","expenses","ledger","refunds","installments"])
    assert.equal(s[key].length,0,key+" must stay empty");
  assert.deepEqual(s.balances,before.balances);      // الأرصدة التاريخية محفوظة
});

test("SR03 occupied unpaid obligation contributes to Target and appears as arrears",()=>{
  const s=run(seed(),occupied).state;
  const p=monthlyOperationalProjection(s,month,"2026-08-12");
  assert.equal(p.cards.targetFils,130000);           // المستهدف ليس صفراً
  assert.equal(p.cards.collectedFils,0);
  assert.equal(p.cards.depositedFils,0);
  assert.equal(p.cards.arrearsFils,130000);          // متأخر
});

test("SR04 vacant space creates no obligation and no Target",()=>{
  const s=run(seed(),{spaceId:"space:101-4",reportingMonth:month,occupancy:"vacant"},"rental:vacant").state;
  assert.equal(s.cycles.filter(x=>x.status!=="cancelled").length,0);
  const p=monthlyOperationalProjection(s,month,"2026-08-12");
  assert.equal(p.cards.targetFils,0);
});

test("SR05 re-saving the same space never duplicates entities",()=>{
  let out=run(seed(),occupied,"rental:a");
  out=run(out.state,{...occupied,contractualAmountFils:150000},"rental:b");
  assert.equal(out.state.cycles.length,1);           // تحديث لا تكرار
  assert.equal(out.state.tenants.length,1);
  assert.equal(out.state.tenancies.length,1);
  assert.equal(out.state.cycles[0].baseAmountFils,150000);
});

test("SR06 retry with same operationId is exactly-once replay",()=>{
  let out=run(seed(),occupied,"rental:same");
  out=run(out.state,occupied,"rental:same");
  assert.equal(out.replay,true);
  assert.equal(out.state.cycles.length,1);
});

test("SR07 unknown tenant name is marked unresolved and never fabricated",()=>{
  const s=run(seed(),{...occupied,tenantName:""},"rental:unknown").state;
  assert.equal(s.cycles[0].unresolvedTenantIdentity,true);
  assert.equal(s.tenants[0].identityStatus,"unresolved");
  assert.match(s.tenants[0].name,/غير محدد/);
});

test("SR08 invalid rent, due date or occupancy is rejected",()=>{
  assert.throws(()=>run(seed(),{...occupied,contractualAmountFils:0},"rental:inv:1"),/CONTRACTUAL_AMOUNT_INVALID/);
  assert.throws(()=>run(seed(),{...occupied,dueDate:"01-08-2026"},"rental:inv:2"),/DUE_DATE_INVALID/);
  assert.throws(()=>run(seed(),{...occupied,occupancy:"maybe"},"rental:inv:3"),/OCCUPANCY_INVALID/);
  assert.throws(()=>run(seed(),{...occupied,spaceId:"space:none"},"rental:inv:4"),/RENTABLE_SPACE_NOT_FOUND/);
});

test("SR09 rental data cannot be rewritten after financial activity",()=>{
  const s=run(seed(),occupied).state;
  s.cycles[0].financialVersion=1;
  assert.throws(()=>run(s,{...occupied,contractualAmountFils:1},"rental:after"),/CYCLE_HAS_FINANCIAL_ACTIVITY/);
});

test("SR10 due-date correction is manager-only, needs a reason, and is audited",()=>{
  const s=run(seed(),occupied).state;
  const cycleId=s.cycles[0].id;
  assert.throws(()=>executeCommand(s,"correctCycleDueDate",
    {operationId:"duedate:employee:1",payload:{cycleId,dueDate:"2026-08-31",reason:"x"},actor:employee}),/MANAGER_REQUIRED/);
  assert.throws(()=>executeCommand(s,"correctCycleDueDate",
    {operationId:"duedate:noreason:1",payload:{cycleId,dueDate:"2026-08-31",reason:""},actor:owner}),/REASON_REQUIRED/);
  const out=executeCommand(s,"correctCycleDueDate",
    {operationId:"duedate:accepted:1",payload:{cycleId,dueDate:"2026-08-31",reason:"تصحيح من المالك"},actor:owner});
  const c=out.state.cycles[0];
  assert.equal(c.dueDate,"2026-08-31");
  assert.equal(c.previousDueDate,"2026-08-01");      // القيمة السابقة محفوظة
  assert.equal(c.dueDateHistory.length,1);
  assert.equal(out.state.audit.filter(x=>x.action==="cycle_due_date_corrected").length,1);
});

test("SR11 due-date correction changes arrears/not-yet-due classification",()=>{
  const s=run(seed(),occupied).state;
  const early=monthlyOperationalProjection(s,month,"2026-08-12");
  assert.equal(early.cards.arrearsFils,130000);
  const out=executeCommand(s,"correctCycleDueDate",
    {operationId:"duedate:future:1",payload:{cycleId:s.cycles[0].id,dueDate:"2026-08-31",reason:"نهاية الشهر"},actor:owner});
  const after=monthlyOperationalProjection(out.state,month,"2026-08-12");
  assert.equal(after.cards.arrearsFils,0);
  assert.equal(after.cards.notYetDueFils,130000);
  assert.equal(after.cards.targetFils,130000);       // المستهدف لا يتغير
});

test("SR12 UI exposes no technical canonical IDs in the entry form",()=>{
  const html=fs.readFileSync(new URL("../index.html",import.meta.url),"utf8");
  assert.match(html,/setSpaceRental/);
  assert.match(html,/فارغ/);
  assert.match(html,/متأخر/);
  assert.doesNotMatch(html,/prompt\("معرّف الدورة/);
});
