import { cashLotAvailable, ledgerReplay, monthOf } from "./financial_engine.mjs";

const ORIGIN_COMMANDS = new Set(["createCashReceipt","createBankPayment","createDepositRequest","createCustodyTransfer","requestExpense","refundPayment","correctPayment","cancelPayment"]);
const ENTITY_KEYS = ["paymentIntents","collectionEvents","collectionReversals","unallocatedPayments","allocations","cashLots","cashMovements","depositRequests","custodyTransfers","refunds","expenses","ledger","audit"];

export function reconstructionPlanForMonth(state, monthKey) {
  const plans=(state.reconstructionPlans||[]).filter(x=>x.monthKey===monthKey&&["DRAFT","ACTIVE"].includes(x.status));
  if(plans.length>1)throw new Error("MULTIPLE_RECONSTRUCTION_PLANS");
  return plans[0]||null;
}

function referencedEntity(state,command,payload){
  const find=(list,id)=>id&&(state[list]||[]).find(x=>x.id===id);
  return command==="approveBankPayment"?find("paymentIntents",payload.paymentId)
    :["approveDeposit","rejectDeposit","withdrawDeposit","editDepositRequest"].includes(command)?find("depositRequests",payload.depositRequestId)
    :["confirmCustodyTransfer","rejectCustodyTransfer","reverseCustodyTransfer"].includes(command)?find("custodyTransfers",payload.transferId)
    :["approveExpense","executeExpense","reverseExpense"].includes(command)?find("expenses",payload.expenseId)
    :command==="cancelPayment"?find("paymentIntents",payload.paymentId)
    :["correctPayment","refundPayment"].includes(command)?find("allocations",payload.allocationId)
    :["reverseBankInstallmentPayment"].includes(command)?find("installments",payload.bankInstallmentId)
    :null;
}

function payloadMonth(payload){
  const date=payload.paymentDate||payload.depositDate||payload.effectiveDate||payload.date;
  return date?monthOf(String(date)):payload.monthKey||payload.effectiveMonth||null;
}

export function prepareReconstructionCommand(state,command,ctx){
  if(["createReconstructionPlan","addReconstructionObligation","cancelReconstructionObligation","linkReconstructionObligationStructure","confirmReconstructionStructure","classifyHistoricalException","removeHistoricalException","materializeReconstructionCycles","activateReconstructionPlan","cancelReconstructionPlan","abandonReconstructionAndActivate","createRentalCycle"].includes(command))return null;
  const monthKey=payloadMonth(ctx.payload||{});
  const origin=referencedEntity(state,command,ctx.payload||{});
  const planId=ctx.payload?.reconstructionPlanId?String(ctx.payload.reconstructionPlanId):origin?.reconstructionPlanId||null;
  const boundaryPlan=monthKey?reconstructionPlanForMonth(state,monthKey):null;
  if(boundaryPlan&&ORIGIN_COMMANDS.has(command)&&!planId)throw new Error("RECONSTRUCTION_PLAN_REQUIRED");
  if(!planId)return null;
  const plan=(state.reconstructionPlans||[]).find(x=>x.id===planId);
  if(!plan)throw new Error("RECONSTRUCTION_PLAN_NOT_FOUND");
  if(plan.status!=="DRAFT")throw new Error("RECONSTRUCTION_PLAN_NOT_EDITABLE");
  if(monthKey&&monthKey!==plan.monthKey)throw new Error("RECONSTRUCTION_EFFECTIVE_MONTH_MISMATCH");
  if(ORIGIN_COMMANDS.has(command)&&!String(ctx.payload.reconstructionSourceReference||"").trim())throw new Error("RECONSTRUCTION_SOURCE_REFERENCE_REQUIRED");
  const cycleId=String(ctx.payload?.cycleId||origin?.cycleId||"");
  if(cycleId){const obligation=(plan.reviewedObligations||[]).find(x=>String(x.cycleId||x.obligationId)===cycleId);if(!obligation||obligation.structuralStatus!=="READY_FOR_RECONSTRUCTION")throw new Error("OBLIGATION_STRUCTURAL_CONFIRMATION_REQUIRED");}
  return {planId,monthKey:plan.monthKey,sourceReference:String(ctx.payload.reconstructionSourceReference||origin?.reconstructionSourceReference||"").trim()||null,effectiveDate:ctx.payload.paymentDate||ctx.payload.depositDate||ctx.payload.effectiveDate||ctx.payload.date||origin?.originalEffectiveDate||null};
}

export function attachReconstructionLineage(state,beforeLengths,ctx,meta){
  if(!meta)return;
  const lineage={reconstruction:true,reconstructionPlanId:meta.planId,originalEffectiveDate:meta.effectiveDate,reconstructedAt:ctx.now||new Date().toISOString(),reconstructedBy:ctx.actor.id,reconstructionSourceReference:meta.sourceReference};
  for(const key of ENTITY_KEYS)for(const entity of (state[key]||[]).slice(beforeLengths[key]||0))Object.assign(entity,lineage);
}

export function reconstructionCompletenessAudit(state,planId){
  const plan=(state.reconstructionPlans||[]).find(x=>x.id===planId);
  if(!plan)throw new Error("RECONSTRUCTION_PLAN_NOT_FOUND");
  const month=plan.monthKey, blockers=[], warnings=[];
  const activeObligations=(plan.reviewedObligations||[]).filter(x=>x.planItemStatus!=="CANCELLED"&&x.structuralStatus!=="CANCELLED");
  let hasUnresolvedObligation=false;
  for(const item of activeObligations){
    const represented=Boolean(item.materializedCycleId)||(state.cycles||[]).some(x=>x.id===item.cycleId&&!String(x.status||"").startsWith("cancelled"));
    const excepted=item.historicalException?.status==="HISTORICAL_EXCEPTION"&&item.historicalException?.reconstructionPlanId===planId&&item.historicalException?.projectionEffect==="none";
    if(!represented&&!excepted){hasUnresolvedObligation=true;blockers.push(`RECONSTRUCTION_ITEM_UNRESOLVED:${item.obligationId}`);}
  }
  if(hasUnresolvedObligation)blockers.unshift("STRUCTURAL_CONFIRMATIONS_INCOMPLETE");
  for(const item of plan.historicalFinancialCandidates||[]){
    const represented=Boolean(item.canonicalEventId)||(item.status==="CONFIRMED"&&item.canonicalRepresentationId);
    const excepted=item.historicalException?.status==="HISTORICAL_EXCEPTION"&&item.historicalException?.reconstructionPlanId===planId&&item.historicalException?.projectionEffect==="none";
    if(!represented&&!excepted)blockers.push(`RECONSTRUCTION_FINANCIAL_CANDIDATE_UNRESOLVED:${item.id||item.candidateId}`);
  }
  if(plan.preActivationApproved!==true)blockers.push("OWNER_PREACTIVATION_APPROVAL_REQUIRED");
  if(plan.freezeVerified!==true)blockers.push("FINAL_WRITE_FREEZE_NOT_VERIFIED");
  if(!/^[a-f0-9]{64}$/.test(String(plan.finalSourceHash||"")))blockers.push("FINAL_SOURCE_HASH_REQUIRED");
  const cycles=(state.cycles||[]).filter(x=>x.reportingMonth===month&&!String(x.status||"").startsWith("cancelled"));
  const tagged=(key)=>(state[key]||[]).filter(x=>x.reconstructionPlanId===planId);
  for(const e of tagged("collectionEvents")){
    if(!e.effectiveAt||!e.method)blockers.push(`COLLECTION_INCOMPLETE:${e.id}`);
    if(e.collectionMonth!==month)blockers.push(`COLLECTION_MONTH_MISMATCH:${e.id}`);
  }
  const allocatedCycles=new Set(tagged("allocations").filter(x=>x.status!=="reversed").map(x=>x.cycleId));
  for(const cycle of cycles)if(!allocatedCycles.has(cycle.id))warnings.push(`OBLIGATION_WITHOUT_COLLECTION_INFORMATION:${cycle.id}`);
  for(const p of tagged("paymentIntents"))if(p.method==="bank"&&p.status==="pending")blockers.push(`BANK_APPROVAL_PENDING:${p.id}`);
  for(const d of tagged("depositRequests"))if(d.status==="pending")blockers.push(`DEPOSIT_APPROVAL_PENDING:${d.id}`);
  for(const x of tagged("custodyTransfers"))if(x.status==="pending")blockers.push(`HANDOVER_CONFIRMATION_PENDING:${x.id}`);
  for(const e of tagged("expenses"))if(e.status==="pending")blockers.push(`EXPENSE_APPROVAL_PENDING:${e.id}`);
  for(const u of tagged("unallocatedPayments"))if(u.state==="unresolved")blockers.push(`UNALLOCATED_PAYMENT:${u.id}`);
  const refs=new Map();
  for(const e of [...tagged("collectionEvents"),...tagged("depositRequests"),...tagged("expenses"),...tagged("custodyTransfers")])if(e.reconstructionSourceReference){const a=refs.get(e.reconstructionSourceReference)||[];a.push(e.id);refs.set(e.reconstructionSourceReference,a);}
  for(const [ref,ids] of refs)if(ids.length>1)blockers.push(`DUPLICATE_RECONSTRUCTION_REFERENCE:${ref}:${ids.join(",")}`);
  const openings=[...(state.legacyOpeningStates||[]),...(state.legacyMonthOpenings||[])].filter(x=>x.monthKey===month&&x.batchStatus==="ACTIVE");
  if(openings.length)blockers.push("LEGACY_OPENING_WOULD_DOUBLE_COUNT");
  for(const lot of tagged("cashLots")){
    if(!lot.currentHolder)blockers.push(`CASH_CUSTODIAN_MISSING:${lot.id}`);
    const available=Number(cashLotAvailable(lot,state.cashMovements||[]));
    if(available<0||available>Number(lot.originalAmountFils))blockers.push(`CASH_LOT_BALANCE_INVALID:${lot.id}`);
  }
  try{const replay=ledgerReplay(state.openingBalances||{},state.ledger||[]);for(const [k,v] of Object.entries(state.balances||{}))if(Number(replay[k])!==Number(v))blockers.push(`LEDGER_BALANCE_MISMATCH:${k}`);}catch{blockers.push("LEDGER_REPLAY_FAILED");}
  if(!tagged("collectionEvents").length)warnings.push("NO_COLLECTIONS_ENTERED");
  return {planId,monthKey:month,complete:blockers.length===0,blockers,warnings,counts:{cycles:cycles.length,collections:tagged("collectionEvents").length,deposits:tagged("depositRequests").length,expenses:tagged("expenses").length,handovers:tagged("custodyTransfers").length}};
}
