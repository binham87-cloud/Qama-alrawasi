/**
 * Read model.
 *
 * Derived, never authoritative. It calls the SAME domain module the commands use, so no
 * screen can disagree with a command about a number.
 */
import {
  periodSummary, obligationView, holdingByEmployee, sharedHoldingFils, checkInvariants,
  holdingByPeriodFils, sharedHoldingAllPeriodsFils, holdingByPeriodMap,
  deriveStatus, dueDateFor, liveObligationsForPeriod,
  dailyBookingsTargetFils, paidInstallmentsFilsForPeriod, profitTransfersFils,
  operatingNetFils,
  rentalForPeriod, occupancyForPeriod, rentalCoversPeriod,
  tenantNameForPeriod, tenantPhoneForPeriod, rentAmountForPeriod,
} from "../domain/finance.mjs";
import { canonicalRequestCreatedAt, sortRequestsNewestFirst } from "../domain/request_order.mjs";

/**
 * Attach rent-month Holding(P) + GLOBAL physical shared Holding.
 * liveRentMonthObligationIds scopes monthly attribution (vacated future unpaid → 0).
 * Global Holding stays physical cash truth (all recognized cash − holding deposits).
 */
function attachHoldingProjection(summary, {
  allReceipts, allDeposits, period, liveRentMonthObligationIds = null,
}) {
  const byPeriod = holdingByPeriodFils({
    receipts: allReceipts, deposits: allDeposits, liveRentMonthObligationIds,
  });
  const globalHolding = sharedHoldingAllPeriodsFils({
    receipts: allReceipts, deposits: allDeposits,
  });
  const periodHolding = sharedHoldingFils({
    receipts: allReceipts, deposits: allDeposits, period, liveRentMonthObligationIds,
  });
  const periodRow = byPeriod.find((r) => r.period === period) || {
    period,
    cashCollectedFils: 0,
    approvedHoldingDepositsFils: 0,
    holdingFils: 0,
  };
  const sumMonths = byPeriod.reduce((s, r) => s + Number(r.holdingFils || 0), 0);
  summary.holdingFils = periodHolding;
  summary.sharedEmployeeHoldingFils = periodHolding;
  summary.periodHoldingFils = periodHolding;
  summary.periodCashCollectedFils = periodRow.cashCollectedFils;
  summary.periodApprovedHoldingDepositsFils = periodRow.approvedHoldingDepositsFils;
  summary.globalHoldingFils = globalHolding;
  summary.sharedHoldingAllPeriodsFils = globalHolding;
  summary.holdingByPeriod = byPeriod;
  summary.holdingByPeriodFils = holdingByPeriodMap(byPeriod);
  summary.rentMonthHoldingSumFils = sumMonths;
  summary.unallocatedHoldingFils = globalHolding - sumMonths;
  return { periodHolding, allPeriodsHolding: globalHolding, byPeriod, sumMonths };
}
import { nextCycleStart, renewButtonVisible } from "../domain/rental_cycle.mjs";

/**
 * Fold valid daily booking Target into period summary (payment status is separate).
 *
 * periodSummary.targetFils is an intermediate: obligation due + recognized daily receipts.
 * Dashboard Target replaces that receipt sum with dailyBookingsTargetFils.
 * A recognized daily receipt whose booking row is absent increases Collected and
 * Holding only. It must not be added again on top of the booking list.
 */
export function applyDailyBookingTarget(summary, dailyBookings) {
  const dailyTargetFils = dailyBookingsTargetFils(dailyBookings);
  const dailyPaidFils = Number(summary.dailyPaidFils || 0);
  const obligationTargetFils = Number(summary.targetFils || 0) - dailyPaidFils;
  const obligationUnpaidFils = Number(summary.remainingFils ?? summary.tenantUnpaidFils ?? 0);
  summary.dailyTargetFils = dailyTargetFils;
  summary.obligationTargetFils = obligationTargetFils;
  // ONE canonical Target: monthly recurring + ALL valid daily obligations (paid or unpaid).
  summary.targetFils = obligationTargetFils + dailyTargetFils;
  const dailyUnpaidFils = Math.max(0, dailyTargetFils - dailyPaidFils);
  summary.tenantUnpaidFils = obligationUnpaidFils + dailyUnpaidFils;
  summary.remainingFils = summary.targetFils - Number(summary.collectedFils || 0);
  return summary;
}

/**
 * Monthly operating Net = Income − approved Operating Expenses ONLY.
 * Profit transfers and paid installments are exposed separately for their
 * dedicated UI/history/liquidity tracks — never folded into operating Net.
 */
function applyOperatingNet(summary, { extras, balances }) {
  const profitTransferFils = profitTransfersFils(extras && extras.profits);
  const sched = balances && Array.isArray(balances.installmentSchedule)
    ? balances.installmentSchedule
    : [];
  const period = summary._period || null;
  const paidInstallmentFils = period
    ? paidInstallmentsFilsForPeriod(sched, period)
    : 0;
  summary.profitTransferFils = profitTransferFils;
  // Financing / distribution outflows only — not operating expenses / not in Net.
  summary.paidInstallmentFils = paidInstallmentFils;
  summary.operatingNetFils = operatingNetFils({
    incomeFils: summary.incomeFils,
    expensesFils: summary.expensesFils,
  });
  // Backward-compat aliases — MUST equal operatingNetFils (no profit/installment deduction).
  summary.netAfterProfitFils = summary.operatingNetFils;
  summary.netAfterProfitInstallmentFils = summary.operatingNetFils;
  return summary;
}

export async function buildDashboard({ db, viewer, period, asOfDate }) {
  const [periodObligations, allObligations, receipts, deposits, expenses, spaces, units, users, accounts, allReceipts, allDeposits, rentals] = await Promise.all([
    db.list("obligations", [["period", "==", period]]),
    db.list("obligations", []),
    db.list("receipts", [["period", "==", period]]),
    db.list("deposits", [["period", "==", period]]),
    db.list("expenses", [["period", "==", period]]),
    db.list("spaces", []), db.list("units", []), db.list("users", []), db.list("accounts", []),
    db.list("receipts", []),
    db.list("deposits", []),
    db.list("rentals", []),
  ]);

  const nameOf = (id) => users.find((u) => u.id === id)?.displayName || id;
  const spaceName = (id) => spaces.find((s) => s.id === id)?.name || "—";
  const unitName = (id) => units.find((u) => u.id === id)?.name || "—";

  // Monthly KPIs: live rentals + retained arrears + historically earned (receipts).
  const obligations = periodObligations;
  const liveObs = liveObligationsForPeriod(obligations, rentals, allReceipts);
  // Holding-by-month attribution must consider ALL periods' live/earned obligations,
  // not only the selected month's obligation docs (otherwise other months vanish).
  const liveRentMonthObligationIds = new Set(
    liveObligationsForPeriod(allObligations, rentals, allReceipts).map((o) => o.id),
  );
  // Pass ALL receipts/deposits into periodSummary for Holding(P) via holdingPeriod,
  // while obligation/receipt money for the month still uses period-filtered arrays below.
  const summary = periodSummary({
    obligations: liveObs, receipts, deposits, expenses, asOfDate, holdingPeriod: period,
  });
  // عند الموظفين = rent-month Holding(P). إجمالي = GLOBAL physical shared Holding.
  const { periodHolding, allPeriodsHolding } = attachHoldingProjection(summary, {
    allReceipts, allDeposits, period, liveRentMonthObligationIds,
  });
  const collectedBy = holdingByEmployee({
    receipts: allReceipts, deposits: allDeposits, period, liveRentMonthObligationIds,
  });
  summary.custody = collectedBy;

  // Daily booking targets live in uiPeriods extras (not obligations).
  // periodSummary already folded recognized daily receipts into paid/collected.
  const ui = await buildUiBundle({ db, period });
  const dailyBookings = (ui.extras && ui.extras.dailyBookings) || [];
  summary._period = period;
  applyDailyBookingTarget(summary, dailyBookings);
  const balances = (ui.config && ui.config.balances) || {};
  applyOperatingNet(summary, { extras: ui.extras || {}, balances });
  // Align rent-split at-employees with Holding(P) cover from all deposits (sourcePeriod).
  const holdingCoverAll = allDeposits
    .filter((d) => d.state === "approved" && d.sourceKind !== "external"
      && !(d.fromBankReceipt || d.sourceKind === "bank"))
    .filter((d) => {
      const sp = d.sourcePeriod || d.period;
      return sp === period;
    })
    .reduce((s, d) => s + Number(d.amountFils || 0), 0);
  const externalCover = deposits
    .filter((d) => d.state === "approved" && d.sourceKind === "external")
    .reduce((s, d) => s + Number(d.amountFils || 0), 0);
  const cashOb = Number(summary.cashOnObligationsFils || 0);
  const monthDepositCover = Math.min(holdingCoverAll + externalCover, cashOb);
  summary.atEmployeesMonthFils = cashOb - monthDepositCover;
  summary.companyCollectedFils = Number(summary.bankRecognizedFils || 0) + monthDepositCover;
  summary.depositedFils = summary.companyCollectedFils;
  summary.incomeFils = summary.depositedFils;
  summary.netIncomeFils = summary.incomeFils - Number(summary.expensesFils || 0);

  const problems = checkInvariants({
    ...summary, custody: collectedBy, holdingFils: periodHolding,
  }).problems;
  // Rent-month sum may be < global when cash is unallocated (e.g. orphaned) —
  // never invent Holding from obligations. Global stays physical cash truth.
  if (Number(summary.rentMonthHoldingSumFils || 0) > allPeriodsHolding) {
    problems.push({
      code: "HOLDING_PERIOD_EXCEEDS_GLOBAL",
      detail: "sum(rent-month Holding) > global shared Holding",
    });
  }

  const views = liveObs
    .map((o) => {
      const v = obligationView(o, receipts, asOfDate);
      return { ...v, spaceId: o.spaceId, rentalId: o.rentalId, spaceName: spaceName(o.spaceId), unitName: unitName(o.unitId) };
    });

  const isOwner = viewer.role === "owner";
  const myHolding = periodHolding;
  const shared = periodHolding;

  const visibleDeposits = deposits.filter((d) => isOwner || d.employeeId === viewer.userId);
  const visibleExpenses = expenses.filter((e) =>
    isOwner
    || e.state === "approved"
    || e.submittedBy === viewer.userId
    || e.requestedBy === viewer.userId
  );

  const pendingApprovals = isOwner ? [
    ...receipts.filter((r) => r.state === "pending").map((r) => ({
      id: r.id, title: `تحويل بنكي — ${unitName(r.unitId)} / ${spaceName(r.spaceId)}`,
      subtitle: `${r.tenantNameSnapshot || "—"} · ${nameOf(r.collectorUserId)} · ${r.collectionDate}`,
      amountFils: r.amountFils,
      createdAt: canonicalRequestCreatedAt(r),
      kind: "bank",
      employeeName: nameOf(r.collectorUserId),
      depositDate: r.collectionDate,
      note: r.note || null,
      reference: r.bankReference || null,
      sourceKind: "bank",
      sourceLabel: "تحويل بنكي",
      approveCommand: "approveBankReceipt", approvePayload: { receiptId: r.id },
      rejectCommand: "rejectBankReceipt", rejectPayload: { receiptId: r.id },
    })),
    ...deposits.filter((d) => d.state === "pending").map((d) => ({
      id: d.id, title: `إيداع — ${nameOf(d.employeeId)}`,
      subtitle: `${d.depositDate}${d.reference ? " · " + d.reference : ""}`,
      amountFils: d.amountFils,
      createdAt: canonicalRequestCreatedAt(d),
      kind: "deposit",
      employeeName: nameOf(d.employeeId),
      employeeId: d.employeeId,
      depositDate: d.depositDate,
      note: d.note || null,
      reference: d.reference || null,
      sourceKind: d.sourceKind || "holding",
      sourceLabel: d.sourceKind === "external" ? "إيداع آخر" : "إيداع من العهدة",
      destinationAccountId: d.destinationAccountId || null,
      accountName: accounts.find((a) => a.id === d.destinationAccountId)?.name || null,
      sharedHoldingFils: shared,
      approveCommand: "approveDeposit", approvePayload: { depositId: d.id },
      rejectCommand: "rejectDeposit", rejectPayload: { depositId: d.id },
    })),
    ...expenses.filter((e) => e.state === "pending").map((e) => ({
      id: e.id, title: `مصروف — ${e.reason}`,
      subtitle: `${nameOf(e.submittedBy)} · ${e.expenseDate}`,
      amountFils: e.amountFils,
      createdAt: canonicalRequestCreatedAt(e),
      kind: "expense",
      employeeName: nameOf(e.submittedBy),
      depositDate: e.expenseDate,
      note: e.reason || null,
      approveCommand: "approveExpense", approvePayload: { expenseId: e.id },
      rejectCommand: "rejectExpense", rejectPayload: { expenseId: e.id },
    })),
  ] : [];

  /**
   * Unit tree — the shape the old QAMA screens used: apartment → partitions → tenant.
   * Includes spaces with no obligation (vacant / staff) so the operational picture is
   * complete, while every money figure still comes from the derived views above.
   *
   * Occupancy / tenant / rent for the selected period are resolved from effective-dated
   * rental history — NEVER from live space.occupancy alone (Oct vacate must not paint Sep vacant).
   */
  const liveActiveRental = (spaceId) => rentals.find((r) => r.spaceId === spaceId && r.state === "active") || null;
  const periodRental = (spaceId) => rentalForPeriod(spaceId, rentals, period);
  // Latest cycle across periods — renew button metadata ONLY (never money/status for this period).
  const latestCycleForRental = (rentalId) => {
    if (!rentalId) return null;
    const list = (allObligations || [])
      .filter((o) => o && o.rentalId === rentalId && o.state === "active" && o.baselineExcluded !== true)
      .slice()
      .sort((a, b) => String(a.cycleStart || a.dueDate || a.period || "").localeCompare(
        String(b.cycleStart || b.dueDate || b.period || ""),
      ));
    return list.length ? list[list.length - 1] : null;
  };
  /** Obligation for the dashboard `period` only — never fall back to a prior month. */
  const periodCycleForRental = (rentalId) => {
    if (!rentalId) return null;
    const list = (allObligations || [])
      .filter((o) => o && o.rentalId === rentalId && o.state === "active" && o.baselineExcluded !== true)
      .filter((o) => {
        const op = o.period || String(o.cycleStart || o.dueDate || "").slice(0, 7);
        return op === period;
      });
    if (!list.length) return null;
    list.sort((a, b) => String(a.cycleStart || a.dueDate || "").localeCompare(String(b.cycleStart || b.dueDate || "")));
    return list[list.length - 1];
  };
  const viewFor = (spaceId, rentalId) => {
    if (rentalId) {
      // Period-scoped views only — do not bind September money into an October dashboard.
      const matched = views.find((v) => v.spaceId === spaceId && v.rentalId === rentalId);
      if (matched) return matched;
    }
    // Historical / retained: any period view for this space (arrears after vacate).
    const retained = views.find((v) => v.spaceId === spaceId && Number(v.remainingFils || 0) > 0);
    if (retained) return retained;
    // Paid historical month after vacate — still bind the period obligation view.
    return views.find((v) => v.spaceId === spaceId) || null;
  };
  const spacePartNum = (sp) => {
    const m = String(sp.name || "").match(/\/\s*(\d+)\s*$/);
    if (m) return Number(m[1]);
    if (/^\d+$/.test(String(sp.name || ""))) return Number(sp.name);
    return Number.MAX_SAFE_INTEGER;
  };

  /** Presentation-only unit order: mezzanine first, then apartment number ascending. */
  const arabicDigitMap = { "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9" };
  const normalizeDigits = (s) => String(s || "").replace(/[٠-٩]/g, (d) => arabicDigitMap[d] || d);
  const isMezzanineName = (name) => /ميزان|mezzan/i.test(String(name || ""));
  const apartmentNumber = (name) => {
    const s = normalizeDigits(name);
    const m = s.match(/(?:شقة\s*)?(\d{2,4})\b/) || s.match(/^(\d{2,4})$/);
    return m ? Number(m[1]) : null;
  };
  const mezzanineNumber = (name) => {
    const m = normalizeDigits(name).match(/(\d+)/);
    return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
  };
  const compareUnitsForDisplay = (a, b) => {
    const an = a.name || "";
    const bn = b.name || "";
    const aMiz = isMezzanineName(an);
    const bMiz = isMezzanineName(bn);
    if (aMiz !== bMiz) return aMiz ? -1 : 1;
    if (aMiz && bMiz) {
      return mezzanineNumber(an) - mezzanineNumber(bn)
        || String(an).localeCompare(String(bn), "ar", { numeric: true });
    }
    const aNum = apartmentNumber(an);
    const bNum = apartmentNumber(bn);
    if (aNum != null && bNum != null && aNum !== bNum) return aNum - bNum;
    if (aNum != null && bNum == null) return -1;
    if (aNum == null && bNum != null) return 1;
    return String(an).localeCompare(String(bn), "ar", { numeric: true });
  };

  const unitsTree = units
    .filter((u) => u.active !== false)
    .map((u) => {
      const mySpaces = spaces
        .filter((sp) => sp.unitId === u.id && sp.active !== false)
        .slice()
        .sort((a, b) => spacePartNum(a) - spacePartNum(b) || String(a.name || "").localeCompare(String(b.name || ""), undefined, { numeric: true }))
        .map((sp) => {
          const rental = periodRental(sp.id);
          const liveRental = liveActiveRental(sp.id);
          const periodOcc = occupancyForPeriod({
            space: sp, rentals, period, asOfDate,
          });
          const v = viewFor(sp.id, rental?.id || null);
          const display = spaceDisplay({
            space: sp,
            view: v,
            rental,
            period,
            asOfDate,
            occupancyOverride: periodOcc,
          });
          const periodOb = rental ? periodCycleForRental(rental.id) : null;
          const latestOb = (liveRental && rentalCoversPeriod(liveRental, period))
            ? latestCycleForRental(liveRental.id)
            : (rental ? latestCycleForRental(rental.id) : null);
          const anniversaryDay = Number(
            rental?.dueDayOfMonth
            || periodOb?.anniversaryDay
            || latestOb?.anniversaryDay
            || String(rental?.startDate || "").slice(8, 10),
          ) || null;
          // Period card dates come from THIS period's cycle only (never prior-month fallthrough).
          const cycleStart = periodOb?.cycleStart || periodOb?.dueDate || display.dueDate || null;
          const cycleEnd = periodOb?.cycleEnd || null;
          const nextFrom = latestOb?.cycleStart || latestOb?.dueDate || cycleStart || null;
          const nextStart = nextFrom && anniversaryDay
            ? nextCycleStart(nextFrom, 1, anniversaryDay)
            : (nextFrom ? nextCycleStart(nextFrom, 1) : null);
          const renewVisible = !!(
            liveRental
            && rentalCoversPeriod(liveRental, period)
            && nextStart
            && renewButtonVisible(nextStart, asOfDate, 7)
          );
          // Per-space receipts for the current period — used by the receipt history
          // panel and the Manager حذف الإيصال control. We include ALL states so the
          // history panel can show reversed receipts as cancelled/audited.
          // Operational UI hides archived pre-staff TEST receipts only.
          // Legitimate reversed receipts remain visible for audit.
          const spaceReceipts = receipts
            .filter((r) => r.spaceId === sp.id)
            .filter((r) => r.operationalHidden !== true && r.archivedOperational !== true)
            .map((r) => ({
              id: r.id,
              amountFils: r.amountFils,
              method: r.method,
              state: r.state,
              collectionDate: r.collectionDate,
              collectorName: nameOf(r.collectorUserId),
              note: r.note || null,
              reversedAt: r.reversedAt || null,
              reversedByReversalId: r.reversedByReversalId || null,
            }));

          // Tenant/rent for THIS period: frozen snapshot, then revision — never a later tenant.
          const tenantName = tenantNameForPeriod(rental, period, periodOb?.tenantNameSnapshot);
          const tenantPhone = tenantPhoneForPeriod(rental, period);

          return {
            spaceId: sp.id,
            name: sp.name,
            // Period-aware occupancy (not live space.occupancy).
            occupancy: periodOcc,
            liveOccupancy: sp.occupancy || "vacant",
            rentalId: rental?.id || null,
            rentalState: rental?.state || null,
            // Historical tenant for the selected month — not the live successor tenant.
            tenantName,
            tenantPhone,
            arrearsTenantName: (periodOcc === "vacant" && v?.tenantName) || null,
            // Card "start" for the selected month = this period's cycle start (not contract start alone).
            startDate: cycleStart || rental?.startDate || null,
            contractStartDate: rental?.startDate || null,
            rentalEndDate: rental?.endDate || null,
            dueDayOfMonth: rental?.dueDayOfMonth || null,
            obligationId: v?.obligationId || periodOb?.id || null,
            rentalCycleId: periodOb?.rentalCycleId || periodOb?.id || null,
            cycleStart: cycleStart || null,
            cycleEnd: cycleEnd || null,
            nextCycleStart: nextStart,
            renewVisible,
            dueFils: display.dueFils,
            paidFils: display.paidFils,
            remainingFils: display.remainingFils,
            dueDate: display.dueDate,
            status: display.status,
            receiptCount: v?.receiptCount ?? spaceReceipts.filter((r) => r.state === "recognized").length,
            spaceReceipts,
          };
        });
      const counted = mySpaces.filter((sp) => sp.obligationId);
      return {
        unitId: u.id, name: u.name, kind: u.kind,
        // A whole apartment is one rentable thing, never a fake partition.
        isWhole: u.kind === "whole",
        spaces: mySpaces,
        dueFils: counted.reduce((t, sp) => t + sp.dueFils, 0),
        paidFils: counted.reduce((t, sp) => t + sp.paidFils, 0),
        remainingFils: counted.reduce((t, sp) => t + sp.remainingFils, 0),
        counts: {
          late: mySpaces.filter((sp) => sp.status === "late").length,
          partial: mySpaces.filter((sp) => sp.status === "partial").length,
          collected: mySpaces.filter((sp) => sp.status === "collected").length,
          not_due: mySpaces.filter((sp) => sp.status === "not_due").length,
          vacant: mySpaces.filter((sp) => sp.status === "vacant").length,
          staff: mySpaces.filter((sp) => sp.status === "staff").length,
        },
      };
    })
    .sort(compareUnitsForDisplay);

  return {
    viewer: { userId: viewer.userId, role: viewer.role, displayName: viewer.displayName },
    period,
    summary: {
      ...summary,
      custody: summary.custody.map((c) => ({ ...c, displayName: nameOf(c.userId) })),
      views: undefined,
    },
    problems: isOwner ? problems : problems.filter((p) => p.userId === viewer.userId),
    views,
    unitsTree,
    properties: (await db.list("properties", [])).filter((x) => x.active !== false).map((x) => ({ id: x.id, name: x.name })),
    receipts: receipts.map((r) => ({
      id: r.id, obligationId: r.obligationId, amountFils: r.amountFils, method: r.method,
      state: r.state, collectionDate: r.collectionDate, collectorName: nameOf(r.collectorUserId),
      tenantName: r.tenantNameSnapshot, spaceName: spaceName(r.spaceId), unitName: unitName(r.unitId),
    })),
    // Custody deposits + display-only bank-receipt history (already in Deposited via
    // bankRecognizedFils — DO NOT create a second deposit doc / double-count).
    deposits: [
      ...visibleDeposits.map((d) => ({
        id: d.id, amountFils: d.amountFils, state: d.state, depositDate: d.depositDate,
        createdAt: canonicalRequestCreatedAt(d),
        employeeName: nameOf(d.employeeId), employeeId: d.employeeId,
        reference: d.reference, note: d.note || null,
        sourceKind: d.sourceKind || "holding",
        sourceLabel: d.sourceKind === "external" ? "إيداع آخر" : "إيداع من العهدة",
        accountName: accounts.find((a) => a.id === d.destinationAccountId)?.name || "—",
        destinationAccountId: d.destinationAccountId || null,
        approvedBy: d.approvedBy || null, approvedAt: d.approvedAt || null,
        fromBankReceipt: false,
      })),
      ...bankReceiptHistoryRows({
        receipts,
        viewerUserId: viewer.userId,
        isOwner,
        nameOf,
        unitName,
        spaceName,
      }),
    ],
    expenses: visibleExpenses.map((e) => ({
      id: e.id, amountFils: e.amountFils, reason: e.reason, state: e.state,
      expenseDate: e.expenseDate, submittedByName: nameOf(e.submittedBy),
      category: e.category || "عام",
      maintenanceLinkId: e.maintenanceLinkId || null,
    })),
    accounts: accounts.filter((a) => a.active !== false).map((a) => ({ id: a.id, name: a.name, kind: a.kind })),
    myHolding,
    pendingApprovals,
    availablePeriods: [...new Set((await db.list("obligations", [])).map((o) => o.period))].sort().reverse(),
    ui,
    audit: isOwner
      ? (await db.list("auditEvents", [])).slice(-60).reverse()
          .map((a) => ({ at: a.at, action: a.action, actorName: nameOf(a.actorUserId), amountFils: a.amountFils ?? null }))
      : [],
  };
}

function parseJsonSafe(raw, fallback) {
  if (raw == null) return fallback;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return fallback; }
}

/** Display-only bank receipt rows for deposits[] — never a second financial mutation. */
export function bankReceiptHistoryRows({ receipts, viewerUserId, isOwner, nameOf, unitName, spaceName }) {
  return (receipts || [])
    .filter((r) => (r.state === "recognized" || r.state === "rejected") && r.method === "bank")
    .filter((r) => isOwner || r.collectorUserId === viewerUserId)
    .map((r) => ({
      id: r.id,
      amountFils: r.amountFils,
      state: r.state === "recognized" ? "approved" : "rejected",
      createdAt: canonicalRequestCreatedAt(r),
      depositDate: r.collectionDate || r.approvedAt?.slice?.(0, 10) || r.rejectedAt?.slice?.(0, 10) || null,
      employeeName: nameOf(r.collectorUserId),
      employeeId: r.collectorUserId || null,
      reference: r.bankReference || r.id,
      note: r.note || `تحويل بنكي — ${r.tenantNameSnapshot || "—"} · ${unitName(r.unitId)} / ${spaceName(r.spaceId)}`,
      sourceKind: "bank",
      sourceLabel: "تحويل بنكي",
      accountName: "إيرادات / بنك",
      destinationAccountId: null,
      approvedBy: r.approvedBy || null,
      approvedAt: r.approvedAt || null,
      rejectedBy: r.rejectedBy || null,
      rejectedAt: r.rejectedAt || null,
      fromBankReceipt: true,
      receiptId: r.id,
      tenantName: r.tenantNameSnapshot || null,
      unitName: unitName(r.unitId),
      spaceName: spaceName(r.spaceId),
      paymentSource: "bank_transfer",
    }));
}

/**
 * Occupancy wins for the card label. Money figures for a vacant/staff space still
 * surface historical period numbers when a retained-after-vacate obligation exists,
 * but the status chip stays vacant/staff so move-out never looks "collected" after refresh.
 * A rented space with no obligation yet this period shows late/not_due from rent,
 * never vacant.
 *
 * `occupancyOverride` is the period-aware occupancy (from rental lifecycle). When set,
 * live space.occupancy is ignored for historical months.
 */
function spaceDisplay({ space, view, rental, period, asOfDate, occupancyOverride = null }) {
  const occupancy = occupancyOverride || space.occupancy || "vacant";
  if (occupancy === "staff") {
    if (view && Number(view.remainingFils || 0) > 0) {
      return {
        status: "staff",
        dueFils: view.dueFils,
        paidFils: view.paidFils,
        remainingFils: view.remainingFils,
        dueDate: view.dueDate,
      };
    }
    return { status: "staff", dueFils: 0, paidFils: 0, remainingFils: 0, dueDate: null };
  }
  if (occupancy === "vacant") {
    if (view && Number(view.remainingFils || 0) > 0) {
      return {
        status: "vacant",
        dueFils: view.dueFils,
        paidFils: view.paidFils,
        remainingFils: view.remainingFils,
        dueDate: view.dueDate,
      };
    }
    // Paid historical month after vacate: still show collected money, but vacant chip
    // only when the period truly has no covering rental (override already vacant).
    if (view && Number(view.paidFils || 0) > 0) {
      return {
        status: "vacant",
        dueFils: view.dueFils,
        paidFils: view.paidFils,
        remainingFils: view.remainingFils,
        dueDate: view.dueDate,
      };
    }
    return {
      status: "vacant",
      dueFils: 0,
      paidFils: 0,
      remainingFils: 0,
      dueDate: null,
    };
  }
  if (view) {
    return {
      status: view.status,
      dueFils: view.dueFils,
      paidFils: view.paidFils,
      remainingFils: view.remainingFils,
      dueDate: view.dueDate,
    };
  }
  const dueFils = rentAmountForPeriod(rental, period, null);
  const dueDate = rental && period ? dueDateFor(period, rental.dueDayOfMonth) : null;
  return {
    status: deriveStatus({ dueFils, paidFils: 0, dueDate, asOfDate }),
    dueFils,
    paidFils: 0,
    remainingFils: dueFils,
    dueDate,
  };
}

async function buildUiBundle({ db, period }) {
  let configs = [], requests = [], periods = [];
  try { configs = await db.list("uiConfig", []); } catch { configs = []; }
  try { requests = await db.list("uiRequests", []); } catch { requests = []; }
  try { periods = await db.list("uiPeriods", [["period", "==", period]]); } catch { periods = []; }
  const config = {};
  for (const d of configs) config[d.id] = parseJsonSafe(d.json, d.data || d);
  const extras = periods[0] ? parseJsonSafe(periods[0].extrasJson, periods[0].extras || {}) : {};
  const reqs = requests
    .filter((r) => r.type !== "pending_lock")
    .map((r) => {
      const payload = parseJsonSafe(r.payloadJson, r.payload || {});
      const byKey = r.byKey || null;
      const byUid = r.by || null;
      return {
        id: r.id,
        type: r.type,
        desc: r.desc,
        payload,
        // Prefer short key for old-UI identity (yahia/nader/saeed), keep uid aliases.
        by: byKey || byUid,
        byKey,
        byUid,
        byName: r.byName,
        month: r.month,
        year: r.year,
        status: r.status,
        createdAt: canonicalRequestCreatedAt(r),
        resolvedAt: r.resolvedAt || null,
        approvedAt: r.status === "approved" ? (r.resolvedAt || r.approvedAt || null) : null,
        rejectedAt: r.status === "rejected" ? (r.resolvedAt || r.rejectedAt || null) : null,
        depositId: payload.depositId || (payload.transaction && payload.transaction.depositId) || null,
      };
    });
  return { config, requests: sortRequestsNewestFirst(reqs), extras };
}

/**
 * Sync dashboard for in-memory test repositories (`db.dump(collection)`).
 * Same formulas as buildDashboard — never a second financial truth.
 */
export function buildDashboardFromDump(db, period, asOfDate) {
  const dump = (name) => (typeof db.dump === "function" ? db.dump(name) : []);
  const obligations = dump("obligations").filter((o) => o.period === period);
  const receipts = dump("receipts").filter((r) => r.period === period);
  const deposits = dump("deposits").filter((d) => d.period === period);
  const expenses = dump("expenses").filter((e) => e.period === period);
  const spacesRaw = dump("spaces");
  const units = dump("units");
  const users = dump("users");
  const accounts = dump("accounts");
  const rentals = dump("rentals");

  const nameOf = (id) => users.find((u) => u.id === id)?.displayName || id;
  const spaceName = (id) => spacesRaw.find((s) => s.id === id)?.name || "—";
  const unitName = (id) => units.find((u) => u.id === id)?.name || "—";

  const allReceipts = dump("receipts");
  const allDeposits = dump("deposits");
  const allObligations = dump("obligations");
  const liveObs = liveObligationsForPeriod(obligations, rentals, allReceipts);
  const liveRentMonthObligationIds = new Set(
    liveObligationsForPeriod(allObligations, rentals, allReceipts).map((o) => o.id),
  );
  const summary = periodSummary({
    obligations: liveObs, receipts, deposits, expenses, asOfDate, holdingPeriod: period,
  });
  const { periodHolding, allPeriodsHolding } = attachHoldingProjection(summary, {
    allReceipts, allDeposits, period, liveRentMonthObligationIds,
  });
  const collectedBy = holdingByEmployee({
    receipts: allReceipts, deposits: allDeposits, period, liveRentMonthObligationIds,
  });
  summary.custody = collectedBy;

  const uiPeriods = dump("uiPeriods").filter((p) => p.period === period);
  const extras = uiPeriods[0]
    ? (typeof uiPeriods[0].extrasJson === "string"
      ? (() => { try { return JSON.parse(uiPeriods[0].extrasJson); } catch { return uiPeriods[0].extras || {}; } })()
      : (uiPeriods[0].extras || {}))
    : {};
  const dailyBookings = extras.dailyBookings || [];
  summary._period = period;
  applyDailyBookingTarget(summary, dailyBookings);
  const balDocs = dump("uiConfig").filter((d) => d.id === "balances");
  let balances = {};
  if (balDocs[0]) {
    try {
      balances = typeof balDocs[0].json === "string"
        ? JSON.parse(balDocs[0].json || "{}")
        : (balDocs[0].data || balDocs[0] || {});
    } catch { balances = {}; }
  }
  applyOperatingNet(summary, { extras, balances });

  const holdingCoverAll = allDeposits
    .filter((d) => d.state === "approved" && d.sourceKind !== "external"
      && !(d.fromBankReceipt || d.sourceKind === "bank"))
    .filter((d) => (d.sourcePeriod || d.period) === period)
    .reduce((s, d) => s + Number(d.amountFils || 0), 0);
  const externalCover = deposits
    .filter((d) => d.state === "approved" && d.sourceKind === "external")
    .reduce((s, d) => s + Number(d.amountFils || 0), 0);
  const cashOb = Number(summary.cashOnObligationsFils || 0);
  const monthDepositCover = Math.min(holdingCoverAll + externalCover, cashOb);
  summary.atEmployeesMonthFils = cashOb - monthDepositCover;
  summary.companyCollectedFils = Number(summary.bankRecognizedFils || 0) + monthDepositCover;
  summary.depositedFils = summary.companyCollectedFils;
  summary.incomeFils = summary.depositedFils;
  summary.netIncomeFils = summary.incomeFils - Number(summary.expensesFils || 0);

  const problems = checkInvariants({
    ...summary, custody: collectedBy, holdingFils: periodHolding,
  }).problems;
  if (Number(summary.rentMonthHoldingSumFils || 0) > allPeriodsHolding) {
    problems.push({
      code: "HOLDING_PERIOD_EXCEEDS_GLOBAL",
      detail: "sum(rent-month Holding) > global shared Holding",
    });
  }
  const views = liveObs
    .map((o) => {
      const v = obligationView(o, receipts, asOfDate);
      return { ...v, spaceId: o.spaceId, rentalId: o.rentalId, spaceName: spaceName(o.spaceId), unitName: unitName(o.unitId) };
    });

  // Period-aware space projection (tests + callers must not read live occupancy as history).
  const spaces = spacesRaw.map((sp) => {
    const rental = rentalForPeriod(sp.id, rentals, period);
    const periodOb = rental
      ? allObligations.find((o) => o.rentalId === rental.id && o.period === period && o.state === "active")
      : null;
    const occ = occupancyForPeriod({ space: sp, rentals, period, asOfDate });
    const v = views.find((x) => x.spaceId === sp.id) || null;
    return {
      ...sp,
      liveOccupancy: sp.occupancy || "vacant",
      occupancy: occ,
      rentalId: rental?.id || null,
      tenantName: tenantNameForPeriod(rental, period, periodOb?.tenantNameSnapshot),
      tenantPhone: tenantPhoneForPeriod(rental, period),
      obligationId: v?.obligationId || periodOb?.id || null,
      dueFils: v?.dueFils ?? periodOb?.amountFils ?? rentAmountForPeriod(rental, period, null),
      status: occ === "vacant" || occ === "staff"
        ? occ
        : (v?.status || "not_due"),
    };
  });

  const unitsTree = units
    .filter((u) => u.active !== false)
    .map((u) => {
      const mySpaces = spaces.filter((sp) => sp.unitId === u.id && sp.active !== false);
      return {
        unitId: u.id,
        name: u.name,
        kind: u.kind,
        isWhole: u.kind === "whole",
        spaces: mySpaces.map((sp) => {
          const rental = rentalForPeriod(sp.id, rentals, period);
          const v = views.find((x) => x.spaceId === sp.id) || null;
          const display = spaceDisplay({
            space: sp,
            view: v,
            rental,
            period,
            asOfDate,
            occupancyOverride: sp.occupancy,
          });
          return {
            spaceId: sp.id,
            name: sp.name,
            occupancy: sp.occupancy,
            liveOccupancy: sp.liveOccupancy,
            rentalId: sp.rentalId,
            tenantName: sp.tenantName,
            tenantPhone: sp.tenantPhone || null,
            obligationId: sp.obligationId,
            dueFils: display.dueFils,
            paidFils: display.paidFils,
            remainingFils: display.remainingFils,
            dueDate: display.dueDate,
            status: display.status,
          };
        }),
      };
    });

  return {
    period,
    summary: {
      ...summary,
      custody: summary.custody.map((c) => ({ ...c, displayName: nameOf(c.userId) })),
    },
    custody: summary.custody.map((c) => ({ ...c, displayName: nameOf(c.userId) })),
    problems,
    views,
    obligations: views,
    unitsTree,
    receipts,
    // Same display-only bank history enrichment as buildDashboard (owner view for tests).
    deposits: [
      ...deposits.map((d) => ({ ...d, fromBankReceipt: false })),
      ...bankReceiptHistoryRows({
        receipts,
        viewerUserId: null,
        isOwner: true,
        nameOf,
        unitName,
        spaceName,
      }),
    ],
    expenses,
    accounts,
    spaces,
    units,
    rentals,
    myHolding: periodHolding,
    globalHoldingFils: allPeriodsHolding,
    sharedHoldingAllPeriodsFils: allPeriodsHolding,
    holdingByPeriod: summary.holdingByPeriod,
  };
}

