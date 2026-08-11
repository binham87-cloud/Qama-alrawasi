import { HttpsError, onCall } from "firebase-functions/v2/https";
import { blankState } from "./domain/command_processor.mjs";
import { monthlyOperationalProjection, managerMonthlyReport, employeeOperationalReport } from "./domain/canonical_selectors.mjs";
import { normalizeCanonicalControl } from "./domain/canonical_control.mjs";

const MANAGER_ROLES = new Set(["owner", "manager"]);
const COLLECTIONS = Object.freeze({
  cycles: "rentalCycles", allocations: "paymentAllocations", paymentIntents: "payments", collectionEvents: "collectionEvents", collectionReversals: "collectionReversals", unallocatedPayments: "unallocatedPayments",
  cashLots: "cashLots", cashMovements: "cashMovements", depositRequests: "deposits",
  custodyTransfers: "custodyTransfers", discounts: "discounts", evictions: "evictions",
  refunds: "refunds", expenses: "expenses", externalRevenues: "externalRevenues",
  ownerProfitDistributions: "ownerProfitDistributions", legacyFinancialCorrections: "legacyFinancialCorrections",
  balanceTransfers: "balanceTransfers", adjustments: "balanceAdjustmentsV2",
  installments: "installments", installmentObligations: "installmentObligations", dailyBookings: "dailyBookings", cycleCorrections: "cycleCorrections",
  monthStates: "monthStates", requests: "canonicalRequests", ledger: "financialLedger", audit: "auditEvents",
  legacyMonthOpenings: "legacyMonthOpenings", legacyOpeningStates: "legacyOpeningStates", legacyCycleOpenings: "legacyCycleOpenings", legacyOpeningBalances: "legacyOpeningBalances",
  reconstructionPlans: "reconstructionPlans", monthAuthorities: "monthAuthorities",
  properties: "properties", units: "units", spaces: "rentableSpaces", tenants: "tenants", tenancies: "tenancies",
});

const rows = (snap) => snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
const merge = (...groups) => [...new Map(groups.flat().map((x) => [x.id, x])).values()];
async function by(db, collectionName, field, value) { return rows(await db.collection(collectionName).where(field, "==", value).get()); }
async function containing(db, collectionName, field, value) { return rows(await db.collection(collectionName).where(field, "array-contains", value).get()); }
async function related(db, collectionName, field, values) {
  const out = [];
  // Individual equality queries avoid a global scan and avoid Firestore's
  // `in` operand limit. Independent entities/months do not contend on a read.
  for (const value of new Set(values)) out.push(...await by(db, collectionName, field, value));
  return merge(out);
}

async function loadCanonicalState(db, monthKey, profile, uid) {
  // This callable is the role-filtered projection boundary. The browser never
  // receives balances, ledger, audit, operations, or other employees' expense
  // requests unless the authenticated business role is Owner/Manager.
  const manager = MANAGER_ROLES.has(String(profile.role || ""));
  const state = blankState();
  const systemSnap = await db.collection("config").doc("system").get();
  state.financialTruthVersion = systemSnap.exists ? Number(systemSnap.data().financialTruthVersion || 2) : 2;
  state.legacyMonthOpenings = await by(db, COLLECTIONS.legacyMonthOpenings, "monthKey", monthKey);
  state.legacyOpeningStates = await by(db, COLLECTIONS.legacyOpeningStates, "monthKey", monthKey);
  state.reconstructionPlans = await by(db, COLLECTIONS.reconstructionPlans, "monthKey", monthKey);
  state.monthAuthorities = await by(db, COLLECTIONS.monthAuthorities, "monthKey", monthKey);
  state.legacyCycleOpenings = await by(db, COLLECTIONS.legacyCycleOpenings, "monthKey", monthKey);
  state.cycles = await by(db, COLLECTIONS.cycles, "reportingMonth", monthKey);
  const cycleIds = state.cycles.map((x) => x.id);
  state.allocations = merge(
    await by(db, COLLECTIONS.allocations, "collectionMonth", monthKey),
    await related(db, COLLECTIONS.allocations, "cycleId", cycleIds),
  );
  state.paymentIntents = merge(
    await by(db, COLLECTIONS.paymentIntents, "collectionMonth", monthKey),
    await related(db, COLLECTIONS.paymentIntents, "cycleId", cycleIds),
  );
  state.collectionEvents = merge(await by(db, COLLECTIONS.collectionEvents, "collectionMonth", monthKey), await related(db, COLLECTIONS.collectionEvents, "cycleId", cycleIds));
  state.collectionReversals = await related(db, COLLECTIONS.collectionReversals, "collectionEventId", state.collectionEvents.map((x) => x.id));
  state.unallocatedPayments = await related(db, COLLECTIONS.unallocatedPayments, "collectionEventId", state.collectionEvents.map((x) => x.id));
  state.cashLots = merge(
    await by(db, COLLECTIONS.cashLots, "collectionMonth", monthKey),
    await related(db, COLLECTIONS.cashLots, "originPaymentId", state.paymentIntents.map((x) => x.id)),
  );
  state.cashMovements = await related(db, COLLECTIONS.cashMovements, "cashLotId", state.cashLots.map((x) => x.id));
  [state.discounts, state.evictions, state.dailyBookings] = await Promise.all([
    related(db, COLLECTIONS.discounts, "cycleId", cycleIds),
    related(db, COLLECTIONS.evictions, "cycleId", cycleIds),
    merge(await by(db, COLLECTIONS.dailyBookings, "collectionMonth", monthKey), await related(db, COLLECTIONS.dailyBookings, "cycleId", cycleIds)),
  ]);
  state.refunds = await related(db, COLLECTIONS.refunds, "allocationId", state.allocations.map((x) => x.id));
  [state.depositRequests, state.custodyTransfers] = await Promise.all([
    Promise.all([containing(db, COLLECTIONS.depositRequests, "attributionMonths", monthKey), by(db, COLLECTIONS.depositRequests, "monthKey", monthKey)]).then((x)=>merge(...x)),
    Promise.all([containing(db, COLLECTIONS.custodyTransfers, "attributionMonths", monthKey), by(db, COLLECTIONS.custodyTransfers, "monthKey", monthKey)]).then((x)=>merge(...x)),
  ]);
  state.externalRevenues = manager ? await by(db, COLLECTIONS.externalRevenues, "effectiveMonth", monthKey) : [];
  state.ledger = manager ? await by(db, COLLECTIONS.ledger, "effectiveMonth", monthKey) : [];
  state.expenses = manager
    ? merge(await by(db, COLLECTIONS.expenses, "monthKey", monthKey), await by(db, COLLECTIONS.expenses, "approvedMonth", monthKey))
    : (await by(db, COLLECTIONS.expenses, "requestedByUid", uid)).filter((x) => x.monthKey === monthKey || x.approvedMonth === monthKey);
  state.requests = manager
    ? await by(db, COLLECTIONS.requests, "monthKey", monthKey)
    : (await by(db, COLLECTIONS.requests, "createdByUid", uid)).filter((x) => x.monthKey === monthKey);
  const monthState = await db.collection(COLLECTIONS.monthStates).doc(monthKey).get();
  state.monthStates = monthState.exists ? [{ id: monthState.id, ...monthState.data() }] : [];
  // Manager-only accounting movements are fetched only for their scoped
  // month. They are never queried or returned for employees.
  if (manager) {
    [state.balanceTransfers, state.adjustments, state.installments, state.installmentObligations, state.cycleCorrections, state.ownerProfitDistributions, state.legacyFinancialCorrections] = await Promise.all([
      by(db, COLLECTIONS.balanceTransfers, "effectiveMonth", monthKey),
      by(db, COLLECTIONS.adjustments, "effectiveMonth", monthKey),
      by(db, COLLECTIONS.installments, "effectiveMonth", monthKey),
      by(db, COLLECTIONS.installmentObligations, "effectiveMonth", monthKey),
      by(db, COLLECTIONS.cycleCorrections, "effectiveMonth", monthKey),
      by(db, COLLECTIONS.ownerProfitDistributions, "effectiveMonth", monthKey),
      by(db, COLLECTIONS.legacyFinancialCorrections, "effectiveMonth", monthKey),
    ]);
  }
  if (manager) {
    const balances = await db.collection("accountBalances").get();
    state.balances = { company: 0, revenue: 0, deduction: 0 };
    for (const doc of balances.docs) state.balances[doc.id] = Number(doc.data().amountFils || 0);
    const openings = await db.collection(COLLECTIONS.legacyOpeningBalances).where("batchStatus", "==", "ACTIVE").get();
    for (const doc of openings.docs) state.balances[doc.id] = Number(doc.data().amountFils || state.balances[doc.id] || 0);
  } else {
    state.balances = { company: 0, revenue: 0, deduction: 0 };
    state.balanceTransfers = [];
    state.adjustments = [];
    state.installments = [];
    state.installmentObligations = [];
    state.ownerProfitDistributions = [];
    state.legacyFinancialCorrections = [];
  }
  return { state, manager };
}

export function buildCanonicalReadModel(db) {
  return onCall({ enforceAppCheck: false }, async (request) => {
    if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
    const monthKey = String(request.data?.monthKey || "");
    const asOfDate = String(request.data?.asOfDate || new Date().toISOString().slice(0, 10));
    if (!/^\d{4}_\d{1,2}$/.test(monthKey)) throw new HttpsError("invalid-argument", "MONTH_KEY_INVALID");
    const profileSnap = await db.collection("users").doc(request.auth.uid).get();
    if (!profileSnap.exists) throw new HttpsError("permission-denied", "PROFILE_MISSING");
    const profile = profileSnap.data() || {};
    if (profile.active === false) throw new HttpsError("permission-denied", "PROFILE_DISABLED");
    if (profile.role === "finance") throw new HttpsError("permission-denied", "FINANCE_ROLE_UNMAPPED");

    const { state, manager } = await loadCanonicalState(db, monthKey, profile, request.auth.uid);
    const controlSnap = await db.collection("config").doc("canonicalControl").get();
    const canonicalControl = normalizeCanonicalControl(controlSnap.exists ? controlSnap.data() : null);
    const projection = manager
      ? managerMonthlyReport(state, monthKey, asOfDate)
      : employeeOperationalReport(state, monthKey, asOfDate);
    const operational = monthlyOperationalProjection(state, monthKey, asOfDate);
    return {
      monthKey, asOfDate, role: manager ? "manager" : "employee", projection, canonicalControl: { state: canonicalControl.state, valid: canonicalControl.valid, structuralPreparation: canonicalControl.structuralPreparation },
      tenantFinancials: operational.details.target.map((target) => ({
        ...target,
        payments: operational.details.collected.filter((x) => x.cycleId === target.cycleId),
      })),
      requests: state.requests,
      deposits: state.depositRequests,
      bankPayments: state.paymentIntents.filter((x) => x.method === "bank"),
      externalRevenues: manager ? state.externalRevenues : [],
      ownerProfitDistributions: manager ? state.ownerProfitDistributions : [],
      installmentObligations: manager ? state.installmentObligations : [],
      installmentReserveTransfers: manager ? state.balanceTransfers.filter((x) => x.transferType === "installment_reserve_internal") : [],
      bankInstallments: manager ? state.installments.filter((x) => x.paymentType === "BANK_INSTALLMENT") : [],
      installmentPayments: manager ? state.installments : [],
      legacyFinancialCorrections: manager ? state.legacyFinancialCorrections : [],
      reconstructionPlans: state.reconstructionPlans.map(({legacySnapshotHash,...plan})=>plan),
      rentalCycles: state.cycles,
      structure: {
        properties: rows(await db.collection(COLLECTIONS.properties).get()),
        units: rows(await db.collection(COLLECTIONS.units).get()),
        rentableSpaces: rows(await db.collection(COLLECTIONS.spaces).get()),
        tenants: rows(await db.collection(COLLECTIONS.tenants).get()),
        tenancies: rows(await db.collection(COLLECTIONS.tenancies).get()),
      },
      monthAuthority: state.monthAuthorities.find(x=>x.monthKey===monthKey)||null,
      balances: manager ? state.balances : undefined,
      generatedAt: new Date().toISOString(),
    };
  });
}
