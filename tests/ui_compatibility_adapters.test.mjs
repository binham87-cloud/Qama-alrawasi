import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html=fs.readFileSync("public/index.html","utf8");

test("UI adapter has stable operation identity, backend error mapping and canonical refresh",()=>{
  assert.match(html,/function stableUiOperationId/);
  assert.match(html,/UI_COMMAND_IN_FLIGHT/);
  assert.match(html,/sendFinancialCommand\(command,operationId,payload/);
  assert.match(html,/refreshCanonicalUi\(result\)/);
  for(const code of ["STALE_OPERATIONAL_ENTITY","STALE_CASH_ALLOCATION","STALE_EVICTION_REQUEST","OVERPAYMENT","INSUFFICIENT_BALANCE","INSUFFICIENT_CUSTODY","ALREADY_PROCESSED","PERMISSION_DENIED","MONTH_CLOSED","INVALID_STATE"]){
    assert.match(html,new RegExp(code));
  }
});

test("visible bank and adjustment actions use backend adapters while legacy guards remain",()=>{
  assert.match(html,/async function createBankPayment[\s\S]*?runUiFinancialCommand\(\{command:"createBankPayment"/);
  assert.match(html,/async function approveBankPayment[\s\S]*?runUiFinancialCommand\(\{command:"approveBankPayment"/);
  assert.match(html,/async function cancelBankPayment[\s\S]*?runUiFinancialCommand\(\{command:"cancelPayment"/);
  assert.match(html,/async function createAdjustment[\s\S]*?runUiFinancialCommand\(\{command:"adjustBalance"/);
  assert.match(html,/async function reverseAdjustment[\s\S]*?runUiFinancialCommand\(\{command:"reverseAdjustment"/);
  assert.match(html,/function blockLegacyFinancialWrite/);
  assert.match(html,/LEGACY_FINANCIAL_WRITE_DISABLED/);
});

test("adapter does not perform local financial projection",()=>{
  const start=html.indexOf("async function runUiFinancialCommand");
  const end=html.indexOf("function blockLegacyFinancialWrite",start);
  const adapter=html.slice(start,end);
  for(const forbidden of ["remainingCollectible","revenueBalance +=","cashHolder =","collectedFils =","depositedFils ="]){
    assert.equal(adapter.includes(forbidden),false,forbidden);
  }
});

test("canonical read callable is the financial refresh authority",()=>{
  assert.match(html,/canonicalReadModelCall=httpsCallable\(functions,"canonicalReadModel"\)/);
  assert.match(html,/await loadCanonicalReadModel\(\)/);
  assert.match(html,/تم تنفيذ العملية، لكن تعذر تحديث العرض/);
  assert.match(html,/S\.canonicalReadModel=model/);
  assert.doesNotMatch(html,/refreshCanonicalUi[\s\S]{0,900}loadBalances\(/);
});

test("tenant cash controls and financial headlines use canonical commands/projections",()=>{
  assert.match(html,/function canonicalCashCollectionControl/);
  assert.match(html,/if\(!cycleId\)throw new Error\("CANONICAL_CYCLE_REQUIRED"\)/);
  assert.match(html,/submitTenantCashCollectionFromUi\(\{cycleId:String\(cycleId\),amount,paymentDate:todayISO\(\),identity:draftIdentity/);
  assert.match(html,/command:"createCashReceipt"/);
  assert.match(html,/canonicalCashCollectionControl\(\{cycleId:cycle\.id/);
  assert.doesNotMatch(html,/canonicalCashCollectionControl\(\{unitId:/);
  assert.match(html,/_canonicalFinancial\.headlines\?\.incomeFils/);
  assert.match(html,/_canonicalFinancial\.headlines\?\.netFils/);
});

test("installment reserve UI uses the explicit canonical internal-transfer command",()=>{
  assert.match(html,/createInstallmentReserveTransfer/);
  assert.match(html,/createBankInstallmentPayment/);
  assert.match(html,/reverseBankInstallmentPayment/);
  assert.match(html,/يُدفع القسط البنكي من حساب احتياطي الأقساط فقط/);
});
