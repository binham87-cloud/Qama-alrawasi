import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { blankState, executeCommand } from "../functions/domain/command_processor.mjs";
import { monthlyOperationalProjection } from "../functions/domain/canonical_selectors.mjs";
import { cashLotAvailable } from "../functions/domain/financial_engine.mjs";

const month="2026_08";   // مفتاح الشهر كما يشتقه المحرك من تاريخ الدفع
const owner={id:"saeed",role:"owner",active:true};
const employee={id:"yahia",role:"employee",active:true};

const base=()=>{
  const s=blankState();
  s.canonicalControl={state:"CANONICAL_ACTIVE",version:8};
  s.financialTruthVersion=3;
  s.balances={company:49175400,revenue:7086395,deduction:9117248};
  s.openingBalances=structuredClone(s.balances);
  s.properties=[{id:"property:1",name:"قمة الرواسي",status:"active"}];
  s.units=[{id:"unit:101",propertyId:"property:1",name:"شقة 101",status:"active"}];
  s.rentableSpaces=[{id:"space:101-3",unitId:"unit:101",propertyId:"property:1",name:"بارتشن 3",status:"active"}];
  return s;
};
const exec=(s,cmd,payload,id,actor=employee)=>
  executeCommand(s,cmd,{operationId:id,payload,actor,now:"2026-08-12T00:00:00.000Z"});

// سيناريو كامل: إيجار → تحصيل كاش → طلب إيداع → اعتماد
function approvedDeposit(){
  let s=base();
  s=exec(s,"setSpaceRental",{spaceId:"space:101-3",reportingMonth:month,occupancy:"occupied",
    contractualAmountFils:130000,dueDate:"2026-08-01",startDate:"2026-08-01",tenantName:"أحمد"},"rental:dep:1").state;
  const cycleId=s.cycles[0].id;
  s=exec(s,"createCashReceipt",{cycleId,amountFils:130000,paymentDate:"2026-08-05"},"receipt:dep:1").state;
  const lot=s.cashLots[0];
  s=exec(s,"createDepositRequest",{allocations:[{cashLotId:lot.id,amountFils:130000}],
    amountFils:130000,depositDate:"2026-08-06",monthKey:month},"deposit:req:1").state;
  const depId=s.depositRequests[0].id;
  s=exec(s,"approveDeposit",{depositRequestId:depId},"deposit:approve:1",owner).state;
  return {state:s,depId,lotId:lot.id};
}

test("DC01 clean August starts with zero deposits",()=>{
  const p=monthlyOperationalProjection(base(),month,"2026-08-12");
  assert.equal(p.cards.depositedFils,0);
});

test("DC02 approved deposit raises Deposited and revenue balance",()=>{
  const {state}=approvedDeposit();
  const p=monthlyOperationalProjection(state,month,"2026-08-12");
  assert.equal(p.cards.depositedFils,130000);
  assert.equal(state.balances.revenue,7086395+130000);
});

test("DC03 manager cancellation reverses the deposit exactly once",()=>{
  const {state,depId}=approvedDeposit();
  const out=exec(state,"cancelDeposit",{depositRequestId:depId,reason:"تم إدخال المبلغ بالخطأ"},"depcancel:1",owner);
  const s=out.state;
  assert.equal(s.depositRequests[0].status,"reversed");
  assert.equal(s.balances.revenue,7086395);                 // الرصيد عاد تماماً
  const p=monthlyOperationalProjection(s,month,"2026-08-12");
  assert.equal(p.cards.depositedFils,0);                    // Deposited عاد صفراً
});

test("DC04 cancellation restores employee cash custody",()=>{
  const {state,depId,lotId}=approvedDeposit();
  const lotBefore=state.cashLots.find(x=>x.id===lotId);
  assert.equal(cashLotAvailable(lotBefore,state.cashMovements),0);   // مودع بالكامل
  const s=exec(state,"cancelDeposit",{depositRequestId:depId,reason:"خطأ"},"depcancel:custody",owner).state;
  const lotAfter=s.cashLots.find(x=>x.id===lotId);
  assert.equal(cashLotAvailable(lotAfter,s.cashMovements),130000);   // عاد للعهدة
});

test("DC05 the same deposit can never be reversed twice",()=>{
  const {state,depId}=approvedDeposit();
  const once=exec(state,"cancelDeposit",{depositRequestId:depId,reason:"خطأ"},"depcancel:a",owner).state;
  assert.throws(()=>exec(once,"cancelDeposit",{depositRequestId:depId,reason:"خطأ"},"depcancel:b",owner),
    /DEPOSIT_ALREADY_CANCELLED/);
  assert.equal(once.balances.revenue,7086395);              // لا خلق ولا فقد للمال
});

test("DC06 retry with the same operationId is exactly-once replay",()=>{
  const {state,depId}=approvedDeposit();
  let out=exec(state,"cancelDeposit",{depositRequestId:depId,reason:"خطأ"},"depcancel:same",owner);
  out=exec(out.state,"cancelDeposit",{depositRequestId:depId,reason:"خطأ"},"depcancel:same",owner);
  assert.equal(out.replay,true);
  assert.equal(out.state.balances.revenue,7086395);
  assert.equal(out.state.audit.filter(x=>x.action==="deposit_reversed").length,1);
});

test("DC07 employee cannot cancel a deposit",()=>{
  const {state,depId}=approvedDeposit();
  assert.throws(()=>exec(state,"cancelDeposit",{depositRequestId:depId,reason:"خطأ"},"depcancel:emp",employee),
    /MANAGER_REQUIRED/);
});

test("DC08 cancellation requires a reason",()=>{
  const {state,depId}=approvedDeposit();
  assert.throws(()=>exec(state,"cancelDeposit",{depositRequestId:depId,reason:"  "},"depcancel:noreason",owner),
    /REASON_REQUIRED/);
});

test("DC09 pending deposit cancellation creates no financial reversal",()=>{
  let s=base();
  s=exec(s,"setSpaceRental",{spaceId:"space:101-3",reportingMonth:month,occupancy:"occupied",
    contractualAmountFils:130000,dueDate:"2026-08-01",startDate:"2026-08-01",tenantName:"أحمد"},"rental:pend:1").state;
  s=exec(s,"createCashReceipt",{cycleId:s.cycles[0].id,amountFils:130000,paymentDate:"2026-08-05"},"receipt:pend:1").state;
  s=exec(s,"createDepositRequest",{allocations:[{cashLotId:s.cashLots[0].id,amountFils:130000}],
    amountFils:130000,depositDate:"2026-08-06",monthKey:month},"deposit:pend:1").state;
  const revenueBefore=s.balances.revenue, ledgerBefore=s.ledger.length;
  const out=exec(s,"cancelDeposit",{depositRequestId:s.depositRequests[0].id,reason:"أُدخل بالخطأ"},"depcancel:pending",owner);
  assert.equal(out.result.reversedFils,0);
  assert.equal(out.state.depositRequests[0].status,"cancelled");
  assert.equal(out.state.balances.revenue,revenueBefore);
  assert.equal(out.state.ledger.length,ledgerBefore);        // لا قيد وهمي
});

test("DC10 original deposit and audit history are preserved",()=>{
  const {state,depId}=approvedDeposit();
  const s=exec(state,"cancelDeposit",{depositRequestId:depId,reason:"تم إدخال المبلغ بالخطأ"},"depcancel:audit",owner).state;
  const dep=s.depositRequests.find(x=>x.id===depId);
  assert.ok(dep);                                            // السجل لم يُحذف
  assert.equal(dep.requestedAmountFils,130000);              // المبلغ الأصلي محفوظ
  assert.equal(dep.cancellationReason,"تم إدخال المبلغ بالخطأ");
  assert.equal(dep.cancelledBy,"saeed");
  assert.ok(dep.cancelledAt);
  assert.equal(dep.reversalOperationId,"depcancel:audit");
  assert.ok(s.audit.some(x=>x.action==="deposit_approved"));  // التاريخ الأصلي باقٍ
  assert.ok(s.audit.some(x=>x.action==="deposit_reversed"));
});

test("DC11 ledger stays balanced after cancellation",()=>{
  const {state,depId}=approvedDeposit();
  const s=exec(state,"cancelDeposit",{depositRequestId:depId,reason:"خطأ"},"depcancel:ledger",owner).state;
  const revenueLedger=s.ledger.filter(x=>x.account==="revenue");
  const net=revenueLedger.reduce((sum,x)=>sum+(x.direction==="credit"?x.amountFils:-x.amountFils),0);
  assert.equal(net,0);                                       // القيد المضاد يوازن الأصل
  assert.ok(s.ledger.some(x=>x.sourceType==="cash_deposit_reversal"));
});

test("DC12 a corrected replacement deposit can be entered afterwards",()=>{
  const {state,depId,lotId}=approvedDeposit();
  let s=exec(state,"cancelDeposit",{depositRequestId:depId,reason:"مبلغ خاطئ"},"depcancel:replace",owner).state;
  s=exec(s,"createDepositRequest",{allocations:[{cashLotId:lotId,amountFils:130000}],
    amountFils:130000,depositDate:"2026-08-07",monthKey:month},"deposit:req:2").state;
  const newId=s.depositRequests.find(x=>x.id!==depId).id;
  s=exec(s,"approveDeposit",{depositRequestId:newId},"deposit:approve:2",owner).state;
  assert.equal(s.balances.revenue,7086395+130000);
  const p=monthlyOperationalProjection(s,month,"2026-08-12");
  assert.equal(p.cards.depositedFils,130000);                // الإيداع الصحيح فقط
});

test("DC13 UI exposes manager-only حذف الإيداع with reason and confirmation",()=>{
  const html=fs.readFileSync(new URL("../index.html",import.meta.url),"utf8");
  assert.match(html,/حذف الإيداع/);
  assert.match(html,/cancelDeposit/);
  assert.match(html,/isOwner&&!depCancelled\(dep\)/);         // للمدير فقط
  assert.match(html,/window\.confirm\("حذف الإيداع/);          // تأكيد إلزامي
  assert.match(html,/سبب الحذف \(إلزامي\)/);                   // سبب إلزامي
  assert.match(html,/ملغي/);                                  // وسم مرئي
});
