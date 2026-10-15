/**
 * READ-ONLY production audit. No writes.
 * Project guard: qama-new-prod-2026 only.
 */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  periodSummary, liveObligationsForPeriod, sharedHoldingAllPeriodsFils,
  holdingByEmployee, isRecognizedReceipt, rentalCoversPeriod, occupancyForPeriod,
  dailyBookingsTargetFils,
} from "../functions/domain/finance.mjs";

const PROJECT = "qama-new-prod-2026";
const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../audit-output");
const require = createRequire(resolve(here, "../../package.json"));
const { initializeApp, applicationDefault } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

if (String(process.env.AUDIT_PROJECT || PROJECT) !== PROJECT) {
  console.error("REFUSING: wrong project");
  process.exit(1);
}

initializeApp({ credential: applicationDefault(), projectId: PROJECT });
const db = getFirestore();

async function all(name) {
  const snap = await db.collection(name).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

function fils(n) { return Number(n || 0); }
function aed(n) { return Math.round(Number(n || 0)) / 100; }
function periodOfDoc(o) {
  return o.period || String(o.dueDate || o.cycleStart || o.collectionDate || "").slice(0, 7);
}
function spaceLabel(spaces, units, spaceId) {
  const sp = spaces.find((s) => s.id === spaceId);
  const unit = sp && units.find((u) => u.id === sp.unitId);
  return `${unit?.name || "?"} / ${sp?.name || spaceId}`;
}
function partNum(name) {
  const m = String(name || "").match(/(\d+)\s*$/);
  return m ? m[1] : "";
}
function aptNum(name) {
  const m = String(name || "").match(/(\d{2,4})/);
  return m ? m[1] : String(name || "");
}

const [obligations, receipts, deposits, expenses, spaces, units, rentals, uiPeriods, uiRequests] = await Promise.all([
  all("obligations"), all("receipts"), all("deposits"), all("expenses"),
  all("spaces"), all("units"), all("rentals"), all("uiPeriods"), all("uiRequests"),
]);

const periods = new Set();
for (const o of obligations) {
  const p = periodOfDoc(o);
  if (/^\d{4}-\d{2}$/.test(p)) periods.add(p);
}
for (const r of receipts) {
  const p = r.period || String(r.collectionDate || "").slice(0, 7);
  if (/^\d{4}-\d{2}$/.test(p)) periods.add(p);
}
const sorted = [...periods].sort();
const asOf = new Date().toISOString().slice(0, 10);
const rentalsById = new Map(rentals.map((r) => [r.id, r]));

function extrasFor(period) {
  const doc = uiPeriods.find((d) => d.id === `period:${period}` || d.period === period);
  if (!doc) return {};
  try { return JSON.parse(doc.extrasJson || "{}"); } catch { return doc.extras || {}; }
}

function isStaffObligation(o) {
  const rental = rentalsById.get(o.rentalId);
  return o.purpose === "staff" || rental?.purpose === "staff";
}
function isVacantPeriod(o) {
  const sp = spaces.find((s) => s.id === o.spaceId);
  const occ = occupancyForPeriod({
    space: sp, rentals, period: periodOfDoc(o), asOfDate: asOf, obligations,
  });
  return occ === "vacant";
}

function verifiedForPeriod(period) {
  const daily = extrasFor(period).dailyBookings || [];
  const dailyTarget = dailyBookingsTargetFils(daily);
  const obs = obligations.filter((o) => {
    if (!o || o.state !== "active" || o.baselineExcluded === true) return false;
    if (o.rentMonthSuppressed === true) return false;
    if (periodOfDoc(o) !== period) return false;
    if (isStaffObligation(o)) return false;
    const rental = rentalsById.get(o.rentalId);
    if (rental && rental.baselineExcluded === true) return false;
    const sp = spaces.find((s) => s.id === o.spaceId);
    const occ = occupancyForPeriod({ space: sp, rentals, period, asOfDate: asOf, obligations });
    if (occ === "staff" || occ === "vacant") {
      // Retained earned history: a recognized receipt on a month the contract covered stays.
      const earned = receipts.some((r) => r.obligationId === o.id && isRecognizedReceipt(r));
      const covered = rental && rentalCoversPeriod(rental, period, obligations);
      if (occ === "staff") return false;
      if (occ === "vacant" && !earned && !covered && o.retainArrearsAfterVacate !== true) return false;
    }
    return true;
  });
  const obIds = new Set(obs.map((o) => o.id));
  let target = dailyTarget;
  let collected = 0;
  let outstanding = 0;
  let overdue = 0;
  for (const o of obs) {
    const due = fils(o.amountFils);
    const paid = receipts
      .filter((r) => r.obligationId === o.id && isRecognizedReceipt(r))
      .reduce((s, r) => s + fils(r.amountFils), 0);
    target += due;
    collected += paid;
    const rem = due - paid;
    outstanding += rem;
    const dueDate = String(o.dueDate || `${period}-01`).slice(0, 10);
    if (rem > 0 && dueDate < asOf) overdue += rem;
  }
  const bank = receipts
    .filter((r) => isRecognizedReceipt(r) && r.method === "bank" && (obIds.has(r.obligationId) || r.sourceType === "daily_booking") && (r.period === period || String(r.collectionDate || "").slice(0, 7) === period))
    .reduce((s, r) => s + fils(r.amountFils), 0);
  const cashDeps = deposits
    .filter((d) => d.state === "approved" && d.baselineExcluded !== true && !(d.fromBankReceipt || d.sourceKind === "bank"))
    .filter((d) => (d.period || d.sourcePeriod || String(d.depositDate || "").slice(0, 7)) === period)
    .reduce((s, d) => s + fils(d.amountFils), 0);
  const deposited = bank + cashDeps;
  return { target, collected, deposited, outstanding, overdue, obligationCount: obs.length };
}

const months = [];
for (const period of sorted) {
  const periodObs = obligations.filter((o) => periodOfDoc(o) === period);
  const periodReceipts = receipts.filter((r) => (r.period || String(r.collectionDate || "").slice(0, 7)) === period);
  const periodDeposits = deposits.filter((d) => (d.period || String(d.depositDate || "").slice(0, 7)) === period);
  const periodExpenses = expenses.filter((e) => (e.period || String(e.expenseDate || "").slice(0, 7)) === period);
  const live = liveObligationsForPeriod(periodObs, rentals, receipts);
  const summary = periodSummary({
    obligations: live, receipts: periodReceipts, deposits: periodDeposits, expenses: periodExpenses,
    asOfDate: asOf, holdingPeriod: period,
  });
  const dailyTarget = dailyBookingsTargetFils(extrasFor(period).dailyBookings || []);
  const dailyPaid = fils(summary.dailyPaidFils);
  const currentTarget = fils(summary.targetFils) - dailyPaid + dailyTarget;
  const currentCollected = fils(summary.collectedFils);
  const currentDeposited = fils(summary.companyCollectedFils ?? summary.depositedFils);
  const currentOutstanding = fils(summary.remainingFils ?? summary.tenantUnpaidFils);
  const currentOverdue = fils(summary.arrearsFils);
  const verified = verifiedForPeriod(period);
  const diff = (c, v) => v - c;
  months.push({
    period,
    current: {
      target: aed(currentTarget), collected: aed(currentCollected), deposited: aed(currentDeposited),
      outstanding: aed(currentOutstanding), overdue: aed(currentOverdue),
    },
    verified: {
      target: aed(verified.target), collected: aed(verified.collected), deposited: aed(verified.deposited),
      outstanding: aed(verified.outstanding), overdue: aed(verified.overdue),
    },
    difference: {
      target: aed(diff(currentTarget, verified.target)),
      collected: aed(diff(currentCollected, verified.collected)),
      deposited: aed(diff(currentDeposited, verified.deposited)),
      outstanding: aed(diff(currentOutstanding, verified.outstanding)),
      overdue: aed(diff(currentOverdue, verified.overdue)),
    },
    liveObligations: live.length,
  });
}

const holding = sharedHoldingAllPeriodsFils({ receipts, deposits });
const byEmployee = holdingByEmployee({ receipts, deposits });

function dupKey(r) {
  return [r.obligationId, r.method, fils(r.amountFils), r.collectionDate, r.collectorUserId || ""].join("|");
}
const recognized = receipts.filter(isRecognizedReceipt);
const groups = new Map();
for (const r of recognized) {
  const k = dupKey(r);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}
const duplicateCollections = [...groups.values()].filter((g) => g.length > 1).map((g) => ({
  count: g.length,
  amountAed: aed(g[0].amountFils),
  method: g[0].method,
  date: g[0].collectionDate,
  period: g[0].period,
  space: spaceLabel(spaces, units, g[0].spaceId),
  ids: g.map((r) => r.id),
  class: "B",
}));

const zeroFull = uiRequests.filter((req) => {
  if (req.status === "rejected") return false;
  let payload = {};
  try { payload = JSON.parse(req.payloadJson || "{}"); } catch { payload = req.payload || {}; }
  const f = payload.fields || {};
  const collecting = f.status === "collected" && !f.partial;
  const stated = Number(f.newPaymentAed ?? f.paid_amount ?? 0);
  return collecting && !(stated > 0) && Number(f.rent || 0) > 0;
}).map((req) => {
  let payload = {};
  try { payload = JSON.parse(req.payloadJson || "{}"); } catch { payload = {}; }
  const f = payload.fields || {};
  return {
    id: req.id, status: req.status, year: req.year, month: req.month,
    rent: f.rent, paid_amount: f.paid_amount, partial: !!f.partial,
    spaceId: f._spaceId || null, tenant: f.tenant || "",
    space: spaceLabel(spaces, units, f._spaceId),
    class: "C",
  };
});

const staffMoney = obligations.filter((o) => isStaffObligation(o) && o.state === "active" && fils(o.amountFils) > 0).map((o) => ({
  id: o.id, period: periodOfDoc(o), amountAed: aed(o.amountFils),
  space: spaceLabel(spaces, units, o.spaceId),
  paidAed: aed(receipts.filter((r) => r.obligationId === o.id && isRecognizedReceipt(r)).reduce((s, r) => s + fils(r.amountFils), 0)),
  class: "D",
}));

const receiptsWithoutObligation = recognized.filter((r) => r.obligationId && !obligations.some((o) => o.id === r.obligationId) && r.sourceType !== "daily_booking").map((r) => ({
  id: r.id, amountAed: aed(r.amountFils), period: r.period, space: spaceLabel(spaces, units, r.spaceId), class: "H",
}));

function matchCase(apt, part) {
  return spaces.filter((sp) => {
    const unit = units.find((u) => u.id === sp.unitId);
    return aptNum(unit?.name) === String(apt) && partNum(sp.name) === String(part);
  }).map((sp) => {
    const unit = units.find((u) => u.id === sp.unitId);
    const spRentals = rentals.filter((r) => r.spaceId === sp.id);
    const spObs = obligations.filter((o) => o.spaceId === sp.id);
    const spReceipts = receipts.filter((r) => r.spaceId === sp.id);
    return {
      spaceId: sp.id,
      name: `${unit?.name} / ${sp.name}`,
      occupancy: sp.occupancy,
      staffEffectivePeriod: sp.staffEffectivePeriod || null,
      staffRentFils: sp.staffRentFils ?? null,
      rentals: spRentals.map((r) => ({
        id: r.id, state: r.state, purpose: r.purpose || null,
        amountAed: aed(r.contractualAmountFils), start: r.startDate, end: r.endDate || null,
      })),
      obligations: spObs.map((o) => ({
        id: o.id, period: periodOfDoc(o), state: o.state, purpose: o.purpose || null,
        amountAed: aed(o.amountFils), rentalId: o.rentalId,
      })),
      receipts: spReceipts.map((r) => ({
        id: r.id, state: r.state, method: r.method, amountAed: aed(r.amountFils),
        period: r.period, date: r.collectionDate, obligationId: r.obligationId,
        reversalOf: r.reversalOf || r.reversedReceiptId || null,
      })),
    };
  });
}

const known = {
  apt202p5: matchCase("202", "5"),
  apt302p8: matchCase("302", "8"),
  apt302p7: matchCase("302", "7"),
  apt102: spaces.filter((sp) => aptNum(units.find((u) => u.id === sp.unitId)?.name) === "102").map((sp) => {
    const unit = units.find((u) => u.id === sp.unitId);
    const relRentals = rentals.filter((r) => r.spaceId === sp.id);
    const relObs = obligations.filter((o) => o.spaceId === sp.id);
    return {
      name: `${unit?.name} / ${sp.name}`,
      occupancy: sp.occupancy,
      rentsAed: [...new Set(relObs.map((o) => aed(o.amountFils)).concat(relRentals.map((r) => aed(r.contractualAmountFils))))],
      obligations: relObs.map((o) => ({ id: o.id, period: periodOfDoc(o), state: o.state, amountAed: aed(o.amountFils) })),
    };
  }),
  mezzanine2p4: units.filter((u) => /ميزان|mezz/i.test(u.name || "") && /2/.test(u.name || "")).flatMap((u) =>
    spaces.filter((sp) => sp.unitId === u.id && partNum(sp.name) === "4").map((sp) => ({
      name: `${u.name} / ${sp.name}`,
      receipts: receipts.filter((r) => r.spaceId === sp.id).map((r) => ({
        id: r.id, state: r.state, amountAed: aed(r.amountFils), period: r.period, method: r.method, date: r.collectionDate,
      })),
    }))
  ),
};

const report = {
  project: PROJECT,
  readOnly: true,
  generatedAt: new Date().toISOString(),
  counts: {
    obligations: obligations.length, receipts: receipts.length, deposits: deposits.length,
    rentals: rentals.length, spaces: spaces.length, requests: uiRequests.length,
  },
  months,
  holdingAed: aed(holding),
  holdingByEmployee: byEmployee.map((e) => ({
    userId: e.userId, holdingAed: aed(e.holdingFils), cashAed: aed(e.cashCollectedFils), depositsAed: aed(e.approvedDepositsFils),
  })),
  duplicateCollections,
  zeroFullRequests: zeroFull,
  staffMoney,
  receiptsWithoutObligation,
  reversedReceipts: receipts.filter((r) => r.state === "reversed").length,
  known,
};

mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, "financial-audit-20261015.json");
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  outPath,
  months: months.length,
  holdingAed: report.holdingAed,
  duplicateGroups: duplicateCollections.length,
  zeroFull: zeroFull.length,
  staffMoney: staffMoney.length,
  monthPreview: months.map((m) => ({ p: m.period, dTarget: m.difference.target, dCollected: m.difference.collected })),
}, null, 2));
