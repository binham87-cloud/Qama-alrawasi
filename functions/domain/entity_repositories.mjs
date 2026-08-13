import { FieldValue } from "firebase-admin/firestore";
import { blankState, executeCommand } from "./command_processor.mjs";
import { SCHEMA_VERSION } from "./financial_engine.mjs";
import { assertCanonicalCommandAllowed } from "./canonical_control.mjs";

// One Firestore document per entity/event. No financial array is stored in an
// aggregate document. Collection names are deliberately explicit so Rules,
// exports and the independent auditor can reason about each source separately.
export const ENTITY_COLLECTIONS = Object.freeze({
  cycles: "rentalCycles",
  allocations: "paymentAllocations",
  paymentIntents: "payments",
  collectionEvents: "collectionEvents",
  // collectionReversals: reserved schema — live reversals use refunds + deposit_reversal cashMovements
  collectionReversals: "collectionReversals",
  unallocatedPayments: "unallocatedPayments",
  cashLots: "cashLots",
  cashMovements: "cashMovements",
  depositRequests: "deposits",
  custodyTransfers: "custodyTransfers",
  discounts: "discounts",
  evictions: "evictions",
  refunds: "refunds",
  expenses: "expenses",
  externalRevenues: "externalRevenues",
  ownerProfitDistributions: "ownerProfitDistributions",
  balanceTransfers: "balanceTransfers",
  adjustments: "balanceAdjustmentsV2",
  installments: "installments",
  installmentObligations: "installmentObligations",
  legacyFinancialCorrections: "legacyFinancialCorrections",
  dailyBookings: "dailyBookings",
  cycleCorrections: "cycleCorrections",
  monthStates: "monthStates",
  requests: "canonicalRequests",
  ledger: "financialLedger",
  audit: "auditEvents",
  reconstructionPlans: "reconstructionPlans",
  monthAuthorities: "monthAuthorities",
});

const MUTABLE_ENTITY_KEYS = new Set([
  "cycles", "allocations", "paymentIntents", "cashLots", "depositRequests",
  "custodyTransfers", "discounts", "expenses", "installmentObligations", "monthStates", "requests",
  "reconstructionPlans", "monthAuthorities",
]);
const EVENT_KEYS = new Set([
  "collectionEvents", "collectionReversals", "unallocatedPayments", "cashMovements", "evictions", "refunds", "balanceTransfers", "adjustments",
  "installments", "dailyBookings", "cycleCorrections", "externalRevenues", "ownerProfitDistributions", "legacyFinancialCorrections", "ledger", "audit",
]);
const ACCOUNT_KEYS = ["company", "revenue", "deduction"];
const clone = (x) => structuredClone(x);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function refFor(db, key, id) {
  return db.collection(ENTITY_COLLECTIONS[key]).doc(String(id));
}

async function getDoc(tx, db, key, id, required = true) {
  const snap = await tx.get(refFor(db, key, id));
  if (!snap.exists) {
    if (required) throw new Error(`${key.toUpperCase()}_NOT_FOUND`);
    return null;
  }
  return { id: snap.id, ...snap.data() };
}

async function getWhere(tx, db, key, field, value) {
  const snap = await tx.get(db.collection(ENTITY_COLLECTIONS[key]).where(field, "==", value));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function collectionRows(tx,db,name){const snap=await tx.get(db.collection(name));return snap.docs.map(d=>({id:d.id,...d.data()}));}
const mergeRows=(...groups)=>[...new Map(groups.flat().map(x=>[x.id,x])).values()];

async function validateReconstructionStructureLink(tx,db,payload){
  const required=async(collection,id,code)=>{const snap=await tx.get(db.collection(collection).doc(String(id||"")));if(!snap.exists)throw new Error(`${code}_NOT_FOUND`);const data={id:snap.id,...snap.data()};if(data.status!=="active")throw new Error(`${code}_INACTIVE`);return data;};
  const property=await required("properties",payload.propertyId,"PROPERTY");const unit=await required("units",payload.unitId,"UNIT");const space=await required("rentableSpaces",payload.spaceId,"RENTABLE_SPACE");const tenant=await required("tenants",payload.tenantId,"TENANT");const tenancy=await required("tenancies",payload.tenancyId,"TENANCY");
  if(unit.propertyId!==property.id||space.propertyId!==property.id||space.unitId!==unit.id)throw new Error("STRUCTURAL_HIERARCHY_MISMATCH");
  if(tenancy.propertyId!==property.id||tenancy.unitId!==unit.id||tenancy.spaceId!==space.id||tenancy.tenantId!==tenant.id)throw new Error("TENANCY_REFERENCE_MISMATCH");
}

async function loadBalances(tx, db, accounts) {
  const balances = { company: 0, revenue: 0, deduction: 0 };
  const versions = {};
  for (const account of accounts) {
    const snap = await tx.get(db.collection("accountBalances").doc(account));
    balances[account] = snap.exists ? Number(snap.data().amountFils || 0) : 0;
    versions[account] = snap.exists ? Number(snap.data().version || 0) : 0;
  }
  return { balances, versions };
}

async function loadCycleScope(tx, db, state, cycleId) {
  state.cycles.push(await getDoc(tx, db, "cycles", cycleId));
  state.allocations.push(...await getWhere(tx, db, "allocations", "cycleId", cycleId));
  state.collectionEvents.push(...await getWhere(tx, db, "collectionEvents", "cycleId", cycleId));
  state.discounts.push(...await getWhere(tx, db, "discounts", "cycleId", cycleId));
}

async function loadLotScope(tx, db, state, lotId) {
  const lot = await getDoc(tx, db, "cashLots", lotId);
  if (!state.cashLots.some((x) => x.id === lot.id)) state.cashLots.push(lot);
  state.cashMovements.push(...(await getWhere(tx, db, "cashMovements", "cashLotId", lotId)).filter((m) => !state.cashMovements.some((x) => x.id === m.id)));
  const allocationId = `alloc:${String(lot.originPaymentId).slice(4)}`;
  const allocation = await getDoc(tx, db, "allocations", allocationId, false);
  if (allocation && !state.allocations.some((x) => x.id === allocation.id)) state.allocations.push(allocation);
  const payment = await getDoc(tx, db, "paymentIntents", lot.originPaymentId, false);
  if (payment && !state.paymentIntents.some((x) => x.id === payment.id)) state.paymentIntents.push(payment);
  if (payment) {
    state.collectionEvents.push(...(await getWhere(tx, db, "collectionEvents", "paymentId", payment.id)).filter((e) => !state.collectionEvents.some((x) => x.id === e.id)));
    state.unallocatedPayments.push(...(await getWhere(tx, db, "unallocatedPayments", "paymentId", payment.id)).filter((e) => !state.unallocatedPayments.some((x) => x.id === e.id)));
  }
  return lot;
}

async function loadCommandState(tx, db, command, payload) {
  const state = blankState();
  const systemSnap = await tx.get(db.collection("config").doc("system"));
  const controlSnap = await tx.get(db.collection("config").doc("canonicalControl"));
  state.financialTruthVersion = systemSnap.exists ? Number(systemSnap.data().financialTruthVersion || 2) : 2;
  state.systemConfig = systemSnap.exists ? systemSnap.data() : {};
  state.canonicalControl = controlSnap.exists ? controlSnap.data() : null;
  const accounts = new Set();
  switch (command) {
    case "createReconstructionPlan": { state.reconstructionPlans.push(...await getWhere(tx,db,"reconstructionPlans","monthKey",payload.monthKey)); const a=await getDoc(tx,db,"monthAuthorities",payload.monthKey,false);if(a)state.monthAuthorities.push(a); break; }
    case "activateReconstructionPlan": { const plan=await getDoc(tx,db,"reconstructionPlans",payload.reconstructionPlanId);state.reconstructionPlans.push(plan);const a=await getDoc(tx,db,"monthAuthorities",plan.monthKey,false);if(a)state.monthAuthorities.push(a);for(const key of ["collectionEvents","paymentIntents","unallocatedPayments","depositRequests","custodyTransfers","expenses"])state[key].push(...await getWhere(tx,db,key,"reconstructionPlanId",plan.id));state.cycles.push(...await getWhere(tx,db,"cycles","reportingMonth",plan.monthKey));state.ledger.push(...await getWhere(tx,db,"ledger","reconstructionPlanId",plan.id)); break; }
    case "addReconstructionObligation":
    case "cancelReconstructionObligation":
    case "linkReconstructionObligationStructure":
    case "confirmReconstructionStructure":
    case "classifyHistoricalException":
    case "removeHistoricalException": { const plan=await getDoc(tx,db,"reconstructionPlans",payload.reconstructionPlanId);state.reconstructionPlans.push(plan);const a=await getDoc(tx,db,"monthAuthorities",plan.monthKey,false);if(a)state.monthAuthorities.push(a);if(command==="linkReconstructionObligationStructure")await validateReconstructionStructureLink(tx,db,payload);if(command==="cancelReconstructionObligation"){const o=(plan.reviewedObligations||[]).find(x=>x.obligationId===payload.obligationId);if(o){const c=await getDoc(tx,db,"cycles",o.cycleId,false);if(c)state.cycles.push(c);}}break; }
    case "materializeReconstructionCycles": { const plan=await getDoc(tx,db,"reconstructionPlans",payload.reconstructionPlanId);state.reconstructionPlans.push(plan);const a=await getDoc(tx,db,"monthAuthorities",plan.monthKey,false);if(a)state.monthAuthorities.push(a);for(const obligation of plan.reviewedObligations||[]){if(obligation.structuralStatus==="READY_FOR_RECONSTRUCTION"&&obligation.canonicalStructureStatus==="LINKED")await validateReconstructionStructureLink(tx,db,{propertyId:obligation.canonicalPropertyId,unitId:obligation.canonicalUnitId,spaceId:obligation.canonicalSpaceId,tenantId:obligation.canonicalTenantId,tenancyId:obligation.canonicalTenancyId});const cycle=await getDoc(tx,db,"cycles",obligation.cycleId,false);if(cycle&&!state.cycles.some(x=>x.id===cycle.id))state.cycles.push(cycle);}break; }
    case "createRentalCycle": { const existing=await getDoc(tx,db,"cycles",payload.cycleId||payload.id,false);if(existing)state.cycles.push(existing);break; }
    case "cancelReconstructionPlan": { const plan=await getDoc(tx,db,"reconstructionPlans",payload.reconstructionPlanId);state.reconstructionPlans.push(plan);const a=await getDoc(tx,db,"monthAuthorities",plan.monthKey,false);if(a)state.monthAuthorities.push(a);break; }
    case "abandonReconstructionAndActivate": {
      const plan=await getDoc(tx,db,"reconstructionPlans",payload.reconstructionPlanId);state.reconstructionPlans.push(plan);const month=plan.monthKey;
      const authority=await getDoc(tx,db,"monthAuthorities",month,false);if(authority)state.monthAuthorities.push(authority);
      state.cleanStartInventory={properties:(await collectionRows(tx,db,"properties")).length,units:(await collectionRows(tx,db,"units")).length,rentableSpaces:(await collectionRows(tx,db,"rentableSpaces")).length,tenants:(await collectionRows(tx,db,"tenants")).length,tenancies:(await collectionRows(tx,db,"tenancies")).length};
      state.cycles.push(...await getWhere(tx,db,"cycles","reportingMonth",month));
      state.allocations.push(...await getWhere(tx,db,"allocations","collectionMonth",month));
      state.paymentIntents.push(...await getWhere(tx,db,"paymentIntents","collectionMonth",month));
      state.collectionEvents.push(...await getWhere(tx,db,"collectionEvents","collectionMonth",month));
      state.cashLots.push(...await getWhere(tx,db,"cashLots","collectionMonth",month));
      state.depositRequests.push(...mergeRows(await getWhere(tx,db,"depositRequests","monthKey",month),await getWhere(tx,db,"depositRequests","approvedMonth",month)));
      state.custodyTransfers.push(...await getWhere(tx,db,"custodyTransfers","monthKey",month));
      state.expenses.push(...mergeRows(await getWhere(tx,db,"expenses","monthKey",month),await getWhere(tx,db,"expenses","approvedMonth",month)));
      state.externalRevenues.push(...await getWhere(tx,db,"externalRevenues","effectiveMonth",month));
      state.ownerProfitDistributions.push(...await getWhere(tx,db,"ownerProfitDistributions","effectiveMonth",month));
      state.balanceTransfers.push(...await getWhere(tx,db,"balanceTransfers","effectiveMonth",month));
      state.adjustments.push(...await getWhere(tx,db,"adjustments","effectiveMonth",month));
      state.installments.push(...await getWhere(tx,db,"installments","effectiveMonth",month));
      state.installmentObligations.push(...await getWhere(tx,db,"installmentObligations","effectiveMonth",month));
      state.legacyFinancialCorrections.push(...await getWhere(tx,db,"legacyFinancialCorrections","effectiveMonth",month));
      state.dailyBookings.push(...await getWhere(tx,db,"dailyBookings","collectionMonth",month));
      state.ledger.push(...await getWhere(tx,db,"ledger","effectiveMonth",month));
      break;
    }
    case "createDailyBooking": { const key = String(payload.paymentDate || "").slice(0, 7).replace("-", "_"); const ms = await getDoc(tx, db, "monthStates", key, false); if (ms) state.monthStates.push(ms); break; }
    case "refundDailyBooking": { const booking = await getDoc(tx, db, "dailyBookings", payload.bookingId); state.dailyBookings.push(booking); await loadCycleScope(tx, db, state, booking.cycleId); const payments = await getWhere(tx, db, "paymentIntents", "cycleId", booking.cycleId); state.paymentIntents.push(...payments); for (const payment of payments) { const allocations = await getWhere(tx, db, "allocations", "paymentId", payment.id); state.allocations.push(...allocations); for (const alloc of allocations) state.refunds.push(...await getWhere(tx, db, "refunds", "allocationId", alloc.id)); if (payment.method === "cash") await loadLotScope(tx, db, state, `lot:${payment.operationId}`); } accounts.add("revenue"); break; }
    case "createCashReceipt":
    case "createBankPayment":
    case "approveDiscount":
    case "approveEviction":
      await loadCycleScope(tx, db, state, payload.cycleId);
      if (command === "createCashReceipt" || command === "createBankPayment") { const key = String(payload.paymentDate || "").slice(0, 7).replace("-", "_"); const ms = await getDoc(tx, db, "monthStates", key, false); if (ms) state.monthStates.push(ms); }
      break;
    case "approveBankPayment": { const payment = await getDoc(tx, db, "paymentIntents", payload.paymentId); state.paymentIntents.push(payment); await loadCycleScope(tx, db, state, payment.cycleId); const ms = await getDoc(tx, db, "monthStates", payment.collectionMonth, false); if (ms) state.monthStates.push(ms); accounts.add("revenue"); break; }
    case "cancelPayment": { const payment = await getDoc(tx, db, "paymentIntents", payload.paymentId); state.paymentIntents.push(payment); const allocations = await getWhere(tx, db, "allocations", "paymentId", payment.id); state.allocations.push(...allocations); for (const alloc of allocations) { state.refunds.push(...await getWhere(tx, db, "refunds", "allocationId", alloc.id)); await loadCycleScope(tx, db, state, alloc.cycleId); } if (payment.method === "cash") await loadLotScope(tx, db, state, `lot:${payment.operationId}`); accounts.add("revenue"); break; }
    case "correctPayment": { const alloc = await getDoc(tx, db, "allocations", payload.allocationId); state.allocations.push(alloc); state.paymentIntents.push(await getDoc(tx, db, "paymentIntents", alloc.paymentId)); await loadCycleScope(tx, db, state, alloc.cycleId); if (payload.newCycleId && payload.newCycleId !== alloc.cycleId) await loadCycleScope(tx, db, state, payload.newCycleId); break; }
    case "createDepositRequest":
    case "createCustodyTransfer":
      for (const line of payload.allocations || []) await loadLotScope(tx, db, state, line.cashLotId); break;
    case "editDepositRequest": { const dep = await getDoc(tx, db, "depositRequests", payload.depositRequestId); state.depositRequests.push(dep); for (const line of payload.allocations || []) await loadLotScope(tx, db, state, line.cashLotId); break; }
    case "rejectDeposit":
    case "withdrawDeposit": state.depositRequests.push(await getDoc(tx, db, "depositRequests", payload.depositRequestId)); break;
    case "approveDeposit": { const dep = await getDoc(tx, db, "depositRequests", payload.depositRequestId); state.depositRequests.push(dep); for (const line of dep.allocations || []) await loadLotScope(tx, db, state, line.cashLotId); accounts.add("revenue"); break; }
    case "confirmCustodyTransfer": { const transfer = await getDoc(tx, db, "custodyTransfers", payload.transferId); state.custodyTransfers.push(transfer); for (const line of transfer.allocations || []) await loadLotScope(tx, db, state, line.cashLotId); break; }
    case "rejectCustodyTransfer": state.custodyTransfers.push(await getDoc(tx, db, "custodyTransfers", payload.transferId)); break;
    case "reverseCustodyTransfer": { const transfer = await getDoc(tx, db, "custodyTransfers", payload.transferId); state.custodyTransfers.push(transfer); for (const line of transfer.allocations || []) { await loadLotScope(tx, db, state, line.cashLotId); const children = await getWhere(tx, db, "cashLots", "parentLotId", line.cashLotId); for (const child of children) await loadLotScope(tx, db, state, child.id); } break; }
    case "requestDiscount":
    case "requestEviction": await loadCycleScope(tx, db, state, payload.cycleId); break;
    case "approveDiscountRequest": { const discount = await getDoc(tx, db, "discounts", payload.discountId); state.discounts.push(discount); await loadCycleScope(tx, db, state, discount.cycleId); break; }
    case "reverseDiscount": { const discount = await getDoc(tx, db, "discounts", payload.discountId); state.discounts.push(discount); await loadCycleScope(tx, db, state, discount.cycleId); break; }
    case "approveEvictionRequest": { const eviction = await getDoc(tx, db, "evictions", payload.evictionId); state.evictions.push(eviction); await loadCycleScope(tx, db, state, eviction.cycleId); break; }
    case "refundPayment": { const alloc = await getDoc(tx, db, "allocations", payload.allocationId); state.allocations.push(alloc); state.refunds.push(...await getWhere(tx, db, "refunds", "allocationId", alloc.id)); const payment = await getDoc(tx, db, "paymentIntents", alloc.paymentId); state.paymentIntents.push(payment); await loadCycleScope(tx, db, state, alloc.cycleId); if (payment.method === "cash") await loadLotScope(tx, db, state, `lot:${payment.operationId}`); accounts.add("revenue"); break; }
    case "transferBalance": accounts.add(payload.source); accounts.add(payload.destination); break;
    case "createInstallmentReserveTransfer": accounts.add("company"); accounts.add("deduction"); break;
    case "reverseBalanceTransfer": { const transfer = await getDoc(tx, db, "balanceTransfers", payload.transferId); state.balanceTransfers.push(transfer); accounts.add(transfer.source); accounts.add(transfer.destination); break; }
    case "reverseInstallmentReserveTransfer": { const transfer = await getDoc(tx, db, "balanceTransfers", payload.transferId); state.balanceTransfers.push(transfer); accounts.add("company"); accounts.add("deduction"); break; }
    case "requestExpense": break;
    case "recordExternalRevenue": accounts.add("revenue"); break;
    case "reverseExternalRevenue": { const event = await getDoc(tx, db, "externalRevenues", payload.externalRevenueId); state.externalRevenues.push(event); accounts.add("revenue"); break; }
    case "createOwnerProfitDistribution": { accounts.add(payload.sourceAccount); const key=String(payload.date||"").slice(0,7).replace("-","_"); const ms=await getDoc(tx,db,"monthStates",key,false); if(ms)state.monthStates.push(ms); break; }
    case "reverseOwnerProfitDistribution": { const event = await getDoc(tx, db, "ownerProfitDistributions", payload.ownerProfitDistributionId); state.ownerProfitDistributions.push(event); accounts.add(event.sourceAccount); break; }
    case "adjustInstallmentObligation": { const obligation = await getDoc(tx, db, "installmentObligations", payload.obligationId); state.installmentObligations.push(obligation); state.installments.push(...await getWhere(tx, db, "installments", "obligationId", payload.obligationId)); break; }
    case "createLegacyFinancialCorrection": if (payload.direction !== "none") accounts.add(payload.account); break;
    case "approveExpense": { const expense = await getDoc(tx, db, "expenses", payload.expenseId); state.expenses.push(expense); accounts.add(payload.account); break; }
    case "executeExpense":
    case "adjustBalance":
    case "payInstallment": accounts.add(payload.account); if (command === "payInstallment") state.installments.push(...await getWhere(tx, db, "installments", "obligationId", payload.obligationId)); break;
    case "reverseExpense": { const expense = await getDoc(tx, db, "expenses", payload.expenseId); state.expenses.push(expense); accounts.add(expense.account); break; }
    case "reverseAdjustment": { const adjustment = await getDoc(tx, db, "adjustments", payload.adjustmentId); state.adjustments.push(adjustment); accounts.add(adjustment.account); break; }
    case "reverseInstallment": { const installment = await getDoc(tx, db, "installments", payload.installmentId); state.installments.push(installment); accounts.add(installment.account); break; }
    case "createBankInstallmentPayment": accounts.add("deduction"); break;
    case "reverseBankInstallmentPayment": { const installment = await getDoc(tx, db, "installments", payload.bankInstallmentId); state.installments.push(installment); accounts.add("deduction"); break; }
    case "closeMonth":
    case "forceCloseMonth": { const ms = await getDoc(tx, db, "monthStates", payload.monthKey, false); if (ms) state.monthStates.push(ms); state.depositRequests.push(...await getWhere(tx, db, "depositRequests", "monthKey", payload.monthKey)); state.paymentIntents.push(...await getWhere(tx, db, "paymentIntents", "collectionMonth", payload.monthKey)); state.custodyTransfers.push(...await getWhere(tx, db, "custodyTransfers", "monthKey", payload.monthKey)); state.requests.push(...await getWhere(tx, db, "requests", "monthKey", payload.monthKey)); break; }
    case "reopenMonth": state.monthStates.push(await getDoc(tx, db, "monthStates", payload.monthKey)); break;
    case "setSpaceRental": {
      const spaceId = String(payload.spaceId || "");
      const monthKey = String(payload.reportingMonth || "");
      const space = await loadStructuralDoc(tx, db, "rentableSpaces", spaceId);
      state.rentableSpaces.push(space);
      const cycleId = `cycle:${spaceId}:${monthKey}`;
      const cycle = await getDoc(tx, db, "cycles", cycleId, false);
      if (cycle) state.cycles.push(cycle);
      const tenancy = await loadStructuralDoc(tx, db, "tenancies", `tenancy:${spaceId}`, false);
      if (tenancy) state.tenancies.push(tenancy);
      const tenant = await loadStructuralDoc(tx, db, "tenants", `tenant:${spaceId}`, false);
      if (tenant) state.tenants.push(tenant);
      break;
    }
    case "correctCycleDueDate":
      await loadCycleScope(tx, db, state, payload.cycleId);
      break;
    case "cancelDeposit": {
      const dep = await getDoc(tx, db, "depositRequests", payload.depositRequestId);
      state.depositRequests.push(dep);
      for (const line of dep.allocations || []) await loadLotScope(tx, db, state, line.cashLotId);
      if (dep.status === "approved") accounts.add("revenue");
      break;
    }

    default: throw new Error("UNKNOWN_COMMAND");
  }
  let reconstructionPlanId=payload.reconstructionPlanId||null;
  if(!reconstructionPlanId){for(const key of ["paymentIntents","allocations","depositRequests","custodyTransfers","expenses","installments"]){const found=(state[key]||[]).find(x=>x.reconstructionPlanId);if(found){reconstructionPlanId=found.reconstructionPlanId;break;}}}
  if(reconstructionPlanId&&!state.reconstructionPlans.some(x=>x.id===reconstructionPlanId)){const plan=await getDoc(tx,db,"reconstructionPlans",reconstructionPlanId);state.reconstructionPlans.push(plan);const authority=await getDoc(tx,db,"monthAuthorities",plan.monthKey,false);if(authority)state.monthAuthorities.push(authority);}
  const loaded = await loadBalances(tx, db, accounts);
  state.balances = loaded.balances;
  return { state, accounts, balanceVersions: loaded.versions };
}


const STRUCTURAL_SIDE_COLLECTIONS = Object.freeze({
  rentableSpaces: "rentableSpaces",
  tenants: "tenants",
  tenancies: "tenancies",
});

async function loadStructuralDoc(tx, db, collection, id, required = true) {
  const snap = await tx.get(db.collection(collection).doc(String(id)));
  if (!snap.exists) {
    if (required) throw new Error(`${collection.toUpperCase()}_NOT_FOUND`);
    return null;
  }
  return { id: snap.id, ...snap.data() };
}

function persistStructuralSideDiff(tx, db, before, after) {
  for (const [key, collection] of Object.entries(STRUCTURAL_SIDE_COLLECTIONS)) {
    const oldMap = indexById(before[key] || []);
    for (const entity of after[key] || []) {
      const prior = oldMap.get(entity.id);
      if (prior && same(prior, entity)) continue;
      const ref = db.collection(collection).doc(String(entity.id));
      if (!prior) tx.create(ref, { ...clone(entity), schemaVersion: SCHEMA_VERSION });
      else tx.set(ref, { ...clone(entity), schemaVersion: SCHEMA_VERSION }, { merge: false });
    }
  }
}

function indexById(items) { return new Map((items || []).map((x) => [x.id, x])); }

function persistDiff(tx, db, before, after, accounts, balanceVersions, operationId) {
  for (const key of Object.keys(ENTITY_COLLECTIONS)) {
    if (key === "ledger" || key === "audit" || MUTABLE_ENTITY_KEYS.has(key) || EVENT_KEYS.has(key)) {
      const oldMap = indexById(before[key]);
      for (const entity of after[key] || []) {
        const prior = oldMap.get(entity.id);
        if (prior && same(prior, entity)) continue;
        const ref = refFor(db, key, entity.id);
        if (EVENT_KEYS.has(key) && !prior) tx.create(ref, { ...clone(entity), schemaVersion: SCHEMA_VERSION });
        else if (!prior) tx.create(ref, { ...clone(entity), schemaVersion: SCHEMA_VERSION });
        else tx.set(ref, { ...clone(entity), schemaVersion: SCHEMA_VERSION }, { merge: false });
      }
    }
  }
  for (const account of accounts) {
    if (before.balances[account] === after.balances[account]) continue;
    tx.set(db.collection("accountBalances").doc(account), {
      account, amountFils: after.balances[account], version: (balanceVersions[account] || 0) + 1,
      updatedByOperationId: operationId, updatedAt: FieldValue.serverTimestamp(), schemaVersion: SCHEMA_VERSION,
    }, { merge: false });
  }
}

export async function executeRepositoryCommand({ db, tx, command, operationId, payloadHash, payload, actor, now }) {
  const loaded = await loadCommandState(tx, db, command, payload);
  assertCanonicalCommandAllowed({ control: loaded.state.canonicalControl, command, payload, state: loaded.state, actor });
  const before = clone(loaded.state);
  const executed = executeCommand(loaded.state, command, { operationId, payloadHash, payload, actor, now });
  persistDiff(tx, db, before, executed.state, loaded.accounts, loaded.balanceVersions, operationId);
  persistStructuralSideDiff(tx, db, before, executed.state);
  return executed.result;
}
