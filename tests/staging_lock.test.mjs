import test from "node:test";
import assert from "node:assert/strict";
import { CONTROL_STATES, normalizeCanonicalControl, assertCanonicalCommandAllowed, operationalWriteAllowed } from "../functions/domain/canonical_control.mjs";
import { blankState } from "../functions/domain/command_processor.mjs";

const manager={id:"manager",role:"manager"};
const employee={id:"employee",role:"employee"};
const control=(state)=>({state,version:1});
const financialCommands=["abandonReconstructionAndActivate","classifyHistoricalException","removeHistoricalException","createCashReceipt","createBankPayment","approveBankPayment","cancelPayment","correctPayment","createDepositRequest","editDepositRequest","rejectDeposit","withdrawDeposit","approveDeposit","createCustodyTransfer","confirmCustodyTransfer","rejectCustodyTransfer","reverseCustodyTransfer","requestDiscount","approveDiscountRequest","approveDiscount","refundPayment","createDailyBooking","refundDailyBooking","reverseDiscount","requestEviction","approveEvictionRequest","approveEviction","transferBalance","reverseBalanceTransfer","createInstallmentReserveTransfer","reverseInstallmentReserveTransfer","requestExpense","approveExpense","executeExpense","reverseExpense","recordExternalRevenue","reverseExternalRevenue","createOwnerProfitDistribution","reverseOwnerProfitDistribution","adjustInstallmentObligation","createLegacyFinancialCorrection","adjustBalance","reverseAdjustment","payInstallment","reverseInstallment","createBankInstallmentPayment","reverseBankInstallmentPayment","createReconstructionPlan","confirmReconstructionStructure","activateReconstructionPlan","cancelReconstructionPlan","closeMonth","forceCloseMonth","reopenMonth"];

test("SL01 missing, malformed and unknown control fail closed",()=>{
  for(const value of [null,{}, {state:"CANONICAL_ACTIVE"},{state:"UNKNOWN",version:1},{state:"CANONICAL_ACTIVE",version:0}])assert.deepEqual(normalizeCanonicalControl(value),{state:"MAINTENANCE_LOCKED",valid:false});
});
test("SL02 locked and staged states reject every canonical write command",()=>{
  for(const state of [CONTROL_STATES.MAINTENANCE_LOCKED,CONTROL_STATES.STAGED_READ_ONLY])for(const command of financialCommands)assert.throws(()=>assertCanonicalCommandAllowed({control:control(state),command,payload:{},state:blankState(),actor:manager}),/CANONICAL_WRITES_DENIED/);
});
test("SL03 operational writes are allowed only in CANONICAL_ACTIVE",()=>{
  for(const state of Object.values(CONTROL_STATES))assert.equal(operationalWriteAllowed(control(state)),state===CONTROL_STATES.CANONICAL_ACTIVE);
  assert.equal(operationalWriteAllowed(null),false);
});
test("SL04 reconstruction requires a draft reviewed plan and never implies activation",()=>{
  const state=blankState();state.reconstructionPlans=[{id:"plan",status:"DRAFT",structuralReviewStatus:"APPROVED",reviewedObligations:[{cycleId:"cycle",structuralStatus:"READY_FOR_RECONSTRUCTION"}]}];
  assert.doesNotThrow(()=>assertCanonicalCommandAllowed({control:control(CONTROL_STATES.RECONSTRUCTION_ALLOWED),command:"createCashReceipt",payload:{reconstructionPlanId:"plan",cycleId:"cycle"},state,actor:employee}));
  assert.throws(()=>assertCanonicalCommandAllowed({control:control(CONTROL_STATES.RECONSTRUCTION_ALLOWED),command:"activateReconstructionPlan",payload:{reconstructionPlanId:"plan"},state,actor:manager}),/ACTIVATION_GATE_CLOSED/);
  assert.equal(state.reconstructionPlans[0].status,"DRAFT");
});
test("SL05 structural confirmation is auditable before financial reconstruction",()=>{
  const state=blankState();state.reconstructionPlans=[{id:"plan",status:"DRAFT",structuralReviewStatus:"PENDING",reviewedObligations:[{cycleId:"cycle",structuralStatus:"NEEDS_TENANT_CONFIRMATION"}]}];
  assert.doesNotThrow(()=>assertCanonicalCommandAllowed({control:control(CONTROL_STATES.RECONSTRUCTION_ALLOWED),command:"confirmReconstructionStructure",payload:{reconstructionPlanId:"plan"},state,actor:employee}));
  assert.throws(()=>assertCanonicalCommandAllowed({control:control(CONTROL_STATES.RECONSTRUCTION_ALLOWED),command:"createCashReceipt",payload:{reconstructionPlanId:"plan",cycleId:"cycle"},state,actor:employee}),/OBLIGATION_STRUCTURAL_CONFIRMATION_REQUIRED/);
});
test("SL06 activation review permits only activation; active denies reconstruction control",()=>{
  const state=blankState();state.reconstructionPlans=[{id:"plan",status:"DRAFT",structuralReviewStatus:"APPROVED"}];
  assert.doesNotThrow(()=>assertCanonicalCommandAllowed({control:control(CONTROL_STATES.ACTIVATION_REVIEW),command:"activateReconstructionPlan",payload:{reconstructionPlanId:"plan"},state,actor:manager}));
  assert.throws(()=>assertCanonicalCommandAllowed({control:control(CONTROL_STATES.ACTIVATION_REVIEW),command:"refundPayment",payload:{},state,actor:manager}),/ACTIVATION_REVIEW_WRITE_DENIED/);
  assert.throws(()=>assertCanonicalCommandAllowed({control:control(CONTROL_STATES.CANONICAL_ACTIVE),command:"createReconstructionPlan",payload:{},state,actor:manager}),/RECONSTRUCTION_CONTROL_DENIED/);
});
