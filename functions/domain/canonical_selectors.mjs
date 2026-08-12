import { activeCollectionAmount, cycleProjection, custodyProjection, ledgerReplay } from "./financial_engine.mjs";

const sum = (items, field) => items.reduce((total, item) => total + Number(item[field] || 0), 0);
const openingValue = (opening, modern, legacy) => Number(opening?.[modern] ?? opening?.[legacy] ?? 0);

function activeOpeningMonth(state, monthKey) {
  const authority=(state.monthAuthorities||[]).find(x=>x.monthKey===monthKey&&x.status==="ACTIVE");
  if(authority?.status==="ACTIVE"&&authority.legacyProjectionEffect==="evidence_only_zero")return undefined;
  const matches = [...(state.legacyOpeningStates || []), ...(state.legacyMonthOpenings || [])].filter((opening) => opening.monthKey === monthKey && ["LEGACY_OPENING_STATE", "LEGACY_BOOTSTRAP_MONTH_OPENING"].includes(opening.kind) && opening.batchStatus === "ACTIVE");
  if (matches.length > 1) throw new Error("MULTIPLE_ACTIVE_OPENING_BATCHES");
  const opening = matches[0];
  if (opening?.cutoverTimestamp && String(opening.effectiveAt || `${monthKey.replace("_", "-")}-01`) >= String(opening.cutoverTimestamp)) throw new Error("POST_CUTOVER_OPENING_FORBIDDEN");
  return opening;
}

function openingObligationDetails(state, monthKey) {
  return (state.legacyCycleOpenings || []).filter((item) => item.monthKey === monthKey && item.batchStatus === "ACTIVE").map((item) => ({
    cycleId: item.id, unitId: item.unitRef || null, tenant: item.tenantId ? (item.tenantLabel || null) : null,
    unresolvedTenantIdentity: !item.tenantId, sourceClassification: item.classification,
    dueDate: item.dueDate || null, discountFils: 0, targetFils: Number(item.targetFils || 0),
    reservedFils: Number(item.tenantReceivedReservedFils || 0), remainingFils: item.remainingCollectibleFils == null ? null : Number(item.remainingCollectibleFils),
    sourceLegacyId: item.sourceLegacyId, bootstrapBatchId: item.bootstrapBatchId,
  }));
}

export function monthlyOperationalProjection(state, monthKey, asOfDate) {
  const canonicalEventsActive = Number(state.financialTruthVersion || 2) >= 3;
  const date = String(asOfDate || new Date().toISOString().slice(0, 10));
  const eligible = (state.cycles || []).filter((cycle) => cycle.reportingMonth === monthKey && !["cancelled_eviction", "cancelled_daily", "pending_payment_daily"].includes(cycle.status));
  const liveTargetDetails = eligible.map((cycle) => { const view = cycleProjection(cycle, state); return { cycleId: cycle.id, unitId: cycle.unitId || null, tenant: cycle.tenant || null, dueDate: cycle.dueDate, discountFils: cycle.baseAmountFils - view.targetFils, targetFils: view.targetFils, reservedFils: view.tenantReceivedReservedFils, remainingFils: view.remainingCollectibleFils }; });
  const opening = activeOpeningMonth(state, monthKey);
  const targetDetails = [...openingObligationDetails(state, monthKey), ...liveTargetDetails];

  const explicitCollections = canonicalEventsActive ? (state.collectionEvents || []).filter((event) => event.collectionMonth === monthKey).map((event) => ({ collectionEventId: event.id, allocationId: null, cycleId: event.cycleId, paymentId: event.paymentId, method: event.method, paymentDate: event.effectiveAt, approvalDate: event.approvedAt || null, amountFils: activeCollectionAmount(event, state) })).filter((x) => x.amountFils > 0) : [];
  // Backward-compatible read of schema-v2 canonical allocations only. Schema-v3
  // financial truth is collectionEvents; Legacy status/paid_amount are never read.
  const v2Collections = (state.allocations || []).filter((a) => (!canonicalEventsActive || !(state.collectionEvents || []).some((event) => event.paymentId === a.paymentId)) && a.collectionMonth === monthKey && a.reservationStatus === "active").map((a) => {
    const revenueRefunds = (state.refunds || []).filter((r) => r.allocationId === a.id && r.status === "active" && r.source === "revenue").reduce((s, r) => s + r.amountFils, 0);
    const amountFils = Number(a.settledAmountFils ?? (a.settlementStatus === "settled" ? a.amountFils : 0)) - revenueRefunds;
    const payment = (state.paymentIntents || []).find((p) => p.id === a.paymentId) || {};
    return { allocationId: a.id, cycleId: a.cycleId, paymentId: a.paymentId, method: payment.method, paymentDate: payment.paymentDate, approvalDate: payment.approvedAt || a.settledAt || null, amountFils };
  }).filter((x) => x.amountFils > 0);
  const collectedDetails = [
    ...(openingValue(opening, "collectedFils", "collectedResidualFils") > 0 ? [{ allocationId: `opening:${opening.bootstrapBatchId}`, method: "legacy_opening", amountFils: openingValue(opening, "collectedFils", "collectedResidualFils"), bootstrapBatchId: opening.bootstrapBatchId, classification: opening.classification, attributionStatus: opening.attributionStatus || "aggregate_unallocated" }] : []),
    ...explicitCollections, ...v2Collections,
  ];

  const bankDeposits = explicitCollections.filter((x) => x.method === "bank");
  // يشمل deposit_reversal بمبلغ سالب حتى ينخفض Deposited عند إلغاء إيداع معتمد.
  // الفلترة على != 0 لا > 0، وإلا سقطت حركة العكس بصمت.
  const cashDeposits = canonicalEventsActive ? (state.cashMovements || []).filter((m) => (m.type === "deposit" || m.type === "deposit_reversal") && m.status === "active").map((m) => { const lot = (state.cashLots || []).find((x) => x.id === m.cashLotId) || {}; return { cashMovementId: m.id, cashLotId: m.cashLotId, paymentId: lot.originPaymentId || null, method: "cash", reversal: m.type === "deposit_reversal", amountFils: (m.type === "deposit_reversal" ? -1 : 1) * Number(m.amountFils || 0), collectionMonth: lot.collectionMonth || null, approvalDate: m.at || null }; }).filter((x) => x.collectionMonth === monthKey && x.amountFils !== 0) : [];
  const depositedDetails = [
    ...(openingValue(opening, "depositedFils", "depositedResidualFils") > 0 ? [{ allocationId: `opening-deposited:${opening.bootstrapBatchId}`, method: "legacy_opening", amountFils: openingValue(opening, "depositedFils", "depositedResidualFils"), bootstrapBatchId: opening.bootstrapBatchId, classification: opening.classification }] : []),
    ...bankDeposits, ...cashDeposits, ...(canonicalEventsActive ? [] : v2Collections),
  ];

  const custody = custodyProjection(state);
  const liveCashDetails = (state.cashLots || []).map((lot) => {
    const out = (state.cashMovements || []).filter((m) => m.cashLotId === lot.id && m.status === "active" && ["deposit", "refund", "transfer_out"].includes(m.type)).reduce((s, m) => s + m.amountFils, 0);
    const restored = (state.cashMovements || []).filter((m) => m.cashLotId === lot.id && m.status === "active" && m.type === "reversal").reduce((s, m) => s + m.amountFils, 0);
    return { cashLotId: lot.id, paymentId: lot.originPaymentId, currentHolder: lot.currentHolder, paymentDate: lot.paymentDate, amountFils: lot.originalAmountFils - out + restored };
  }).filter((x) => x.amountFils > 0);
  const cashDetails = [
    ...(openingValue(opening, "employeeHoldingFils", "receivedNotDepositedFils") > 0 ? [{ cashLotId: `opening:${opening.bootstrapBatchId}`, currentHolder: null, amountFils: openingValue(opening, "employeeHoldingFils", "receivedNotDepositedFils"), bootstrapBatchId: opening.bootstrapBatchId, classification: opening.classification, attributionStatus: opening.attributionStatus || "aggregate_unallocated" }] : []),
    ...liveCashDetails,
  ];

  const activeCycleIds = new Set(eligible.filter((cycle) => cycle.status !== "closed_eviction_partial").map((cycle) => cycle.id));
  const arrearsDetails = [...(openingValue(opening, "arrearsFils", "arrearsResidualFils") > 0 ? [{ cycleId: `opening:${opening.bootstrapBatchId}`, unresolvedTenantIdentity: true, remainingFils: openingValue(opening, "arrearsFils", "arrearsResidualFils"), bootstrapBatchId: opening.bootstrapBatchId, classification: opening.classification }] : []), ...liveTargetDetails.filter((x) => activeCycleIds.has(x.cycleId) && x.dueDate <= date && x.remainingFils > 0)];
  const notYetDueDetails = [...(Number(opening?.notYetDueFils || 0) > 0 ? [{ cycleId: `opening:${opening.bootstrapBatchId}`, unresolvedTenantIdentity: true, remainingFils: Number(opening.notYetDueFils), bootstrapBatchId: opening.bootstrapBatchId, classification: opening.classification }] : []), ...liveTargetDetails.filter((x) => activeCycleIds.has(x.cycleId) && x.dueDate > date && x.remainingFils > 0)];
  const partialRemainingDetails = [...(Number(opening?.partialRemainingFils || 0) > 0 ? [{ cycleId: `opening:${opening.bootstrapBatchId}`, remainingFils: Number(opening.partialRemainingFils), bootstrapBatchId: opening.bootstrapBatchId, classification: opening.classification }] : []), ...liveTargetDetails.filter((x) => activeCycleIds.has(x.cycleId) && x.reservedFils > 0 && x.remainingFils > 0)];
  const evictionDetails = eligible.filter((cycle) => Number(cycle.uncollectedAtEvictionFils || 0) > 0).map((cycle) => ({ cycleId: cycle.id, unitId: cycle.unitId || null, tenant: cycle.tenant || null, amountFils: cycle.uncollectedAtEvictionFils }));
  const unallocatedOverpaymentFils = canonicalEventsActive ? (state.unallocatedPayments || []).filter((x) => x.state === "unresolved" && (state.collectionEvents || []).find((e) => e.id === x.collectionEventId)?.collectionMonth === monthKey).reduce((s, x) => s + Number(x.amountFils || 0), 0) : 0;
  const cards = { targetFils: openingValue(opening, "targetFils", "targetResidualFils") + sum(liveTargetDetails, "targetFils"), collectedFils: sum(collectedDetails, "amountFils"), depositedFils: sum(depositedDetails, "amountFils"), receivedNotDepositedFils: sum(cashDetails, "amountFils"), arrearsFils: sum(arrearsDetails, "remainingFils"), notYetDueFils: sum(notYetDueDetails, "remainingFils"), partialRemainingFils: sum(partialRemainingDetails, "remainingFils"), unallocatedOverpaymentFils, uncollectedAtEvictionFils: sum(evictionDetails, "amountFils") };
  return { monthKey, asOfDate: date, cards, details: { target: targetDetails, collected: collectedDetails, deposited: depositedDetails, receivedNotDeposited: cashDetails, arrears: arrearsDetails, notYetDue: notYetDueDetails, partialRemaining: partialRemainingDetails, uncollectedAtEviction: evictionDetails }, custodyByEmployee: custody.byHolder, openingState: opening ? { bootstrapBatchId: opening.bootstrapBatchId, classification: opening.classification, attributionStatus: opening.attributionStatus || null } : null };
}

export function managerMonthlyReport(state, monthKey, asOfDate) {
  const operational = monthlyOperationalProjection(state, monthKey, asOfDate);
  const ledger = (state.ledger || []).filter((entry) => entry.effectiveMonth === monthKey);
  const expenses = (state.expenses || []).filter((expense) => expense.status === "active" && String(expense.approvedAt || "").slice(0, 7).replace("-", "_") === monthKey);
  const externalRevenue = (state.externalRevenues || []).filter((event) => event.effectiveMonth === monthKey);
  const activeExternalRevenueFils = externalRevenue.filter((x) => x.status === "active").reduce((s, x) => s + Number(x.amountFils || 0), 0);
  const expensesFils = expenses.reduce((s, x) => s + Number(x.amountFils || 0), 0);
  // Owner-approved cash-basis tenant income: recognize an approved tenant
  // collection exactly once when received. Deposits are custody/account
  // movements and external revenue is reported separately.
  const incomeFils = operational.cards.collectedFils;
  const openingBalances = state.openingBalances || state.balances || {};
  const replayedBalances = ledgerReplay(openingBalances, state.ledger || []);
  const balanceReplayMatches = Object.keys(state.balances || {}).every((key) => Number(state.balances[key]) === Number(replayedBalances[key]));
  const installmentReserveTransfers = (state.balanceTransfers || []).filter((e) => e.transferType === "installment_reserve_internal" && e.effectiveMonth === monthKey);
  const totalLiquidityFils = Object.values(state.balances || {}).reduce((sum, value) => sum + Number(value || 0), 0);
  const bankInstallments = (state.installments || []).filter((e) => e.paymentType === "BANK_INSTALLMENT" && e.effectiveMonth === monthKey);
  const activeBankInstallmentFils = bankInstallments.filter((e) => e.status === "paid").reduce((sum, e) => sum + Number(e.amountFils || 0), 0);
  return { ...operational, headlines: { incomeFils, expensesFils, netFils: incomeFils - expensesFils, recognitionBasis: "approved_tenant_collections" }, accounting: { balances: { ...state.balances }, totalLiquidityFils, replayedBalances, balanceReplayMatches, ledger, expenses, externalRevenue, externalRevenueFils: activeExternalRevenueFils, ownerProfitDistributions: (state.ownerProfitDistributions || []).filter((e) => e.effectiveMonth === monthKey), installmentReserveTransfers, bankInstallments, bankInstallmentFils: activeBankInstallmentFils, installmentPayments: (state.installments || []).filter((e) => e.effectiveMonth === monthKey), installmentReserveTransferTreatment: "internal_balance_transfer_zero_income_expense_net_liquidity_effect", bankInstallmentTreatment: "separate_liquidity_outflow_zero_income_expense_net_tenant_kpi_effect", installmentNetTreatment: "bank_installment_separate_excluded", legacyFinancialCorrections: (state.legacyFinancialCorrections || []).filter((e) => e.effectiveMonth === monthKey), refunds: state.refunds || [], corrections: state.cycleCorrections || [] } };
}

export function employeeOperationalReport(state, monthKey, asOfDate) { return monthlyOperationalProjection(state, monthKey, asOfDate); }

export function reportExportModel(state, monthKey, asOfDate, audience = "manager") {
  const report = audience === "manager" ? managerMonthlyReport(state, monthKey, asOfDate) : employeeOperationalReport(state, monthKey, asOfDate);
  const rows = [];
  for (const [section, details] of Object.entries(report.details)) for (const detail of details) rows.push({ section, monthKey, ...detail });
  return { audience, monthKey, cards: report.cards, rows, accounting: audience === "manager" ? report.accounting : undefined };
}
