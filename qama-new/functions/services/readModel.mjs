/**
 * Read model.
 *
 * Derived, never authoritative. It calls the SAME domain module the commands use, so no
 * screen can disagree with a command about a number.
 */
import { periodSummary, obligationView, holdingByEmployee, sharedHoldingFils, checkInvariants, deriveStatus, dueDateFor, liveObligationsForPeriod } from "../domain/finance.mjs";
import { nextCycleStart, renewButtonVisible } from "../domain/rental_cycle.mjs";

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

  // Monthly KPIs count ONLY obligations belonging to a CURRENT active rental.
  const obligations = periodObligations;
  const liveObs = liveObligationsForPeriod(obligations, rentals);
  const summary = periodSummary({ obligations: liveObs, receipts, deposits, expenses, asOfDate });
  const shared = sharedHoldingFils({ receipts: allReceipts, deposits: allDeposits });
  const collectedBy = holdingByEmployee({ receipts: allReceipts, deposits: allDeposits });
  summary.holdingFils = shared;
  summary.sharedEmployeeHoldingFils = shared;
  summary.custody = collectedBy;
  const approvedAll = allDeposits.filter((d) => d.state === "approved").reduce((s, d) => s + Number(d.amountFils || 0), 0);
  const problems = checkInvariants({
    ...summary, approvedDepositsFils: approvedAll, custody: collectedBy, holdingFils: shared,
  }).problems;

  const views = liveObs
    .map((o) => {
      const v = obligationView(o, receipts, asOfDate);
      return { ...v, spaceId: o.spaceId, rentalId: o.rentalId, spaceName: spaceName(o.spaceId), unitName: unitName(o.unitId) };
    });

  const isOwner = viewer.role === "owner";
  const myHolding = shared;

  const visibleDeposits = deposits.filter((d) => isOwner || d.employeeId === viewer.userId);
  const visibleExpenses = expenses.filter((e) => isOwner || e.submittedBy === viewer.userId);

  const pendingApprovals = isOwner ? [
    ...receipts.filter((r) => r.state === "pending").map((r) => ({
      id: r.id, title: `تحويل بنكي — ${unitName(r.unitId)} / ${spaceName(r.spaceId)}`,
      subtitle: `${r.tenantNameSnapshot || "—"} · ${nameOf(r.collectorUserId)} · ${r.collectionDate}`,
      amountFils: r.amountFils,
      approveCommand: "approveBankReceipt", approvePayload: { receiptId: r.id },
      rejectCommand: "rejectBankReceipt", rejectPayload: { receiptId: r.id },
    })),
    ...deposits.filter((d) => d.state === "pending").map((d) => ({
      id: d.id, title: `إيداع — ${nameOf(d.employeeId)}`,
      subtitle: `${d.depositDate}${d.reference ? " · " + d.reference : ""}`,
      amountFils: d.amountFils,
      approveCommand: "approveDeposit", approvePayload: { depositId: d.id },
      rejectCommand: "rejectDeposit", rejectPayload: { depositId: d.id },
    })),
    ...expenses.filter((e) => e.state === "pending").map((e) => ({
      id: e.id, title: `مصروف — ${e.reason}`,
      subtitle: `${nameOf(e.submittedBy)} · ${e.expenseDate}`,
      amountFils: e.amountFils,
      approveCommand: "approveExpense", approvePayload: { expenseId: e.id },
      rejectCommand: "rejectExpense", rejectPayload: { expenseId: e.id },
    })),
  ] : [];

  /**
   * Unit tree — the shape the old QAMA screens used: apartment → partitions → tenant.
   * Includes spaces with no obligation (vacant / staff) so the operational picture is
   * complete, while every money figure still comes from the derived views above.
   */
  const activeRental = (spaceId) => rentals.find((r) => r.spaceId === spaceId && r.state === "active") || null;
  // Prefer the active rental's obligation — never bind a closed-rental orphan by spaceId alone.
  // Latest cycle may belong to a prior calendar period (anniversary span) — still bind it.
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
  const viewFor = (spaceId, rentalId) => {
    if (rentalId) {
      const matched = views.find((v) => v.spaceId === spaceId && v.rentalId === rentalId);
      if (matched) return matched;
      const latest = latestCycleForRental(rentalId);
      if (latest) {
        const v = obligationView(latest, allReceipts, asOfDate);
        return {
          ...v,
          spaceId: latest.spaceId,
          rentalId: latest.rentalId,
          spaceName: spaceName(latest.spaceId),
          unitName: unitName(latest.unitId),
        };
      }
      return null;
    }
    // No active rental → no live obligation for the card (vacant/staff/orphan).
    return null;
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
          const rental = activeRental(sp.id);
          const v = viewFor(sp.id, rental?.id || null);
          const display = spaceDisplay({ space: sp, view: v, rental, period, asOfDate });
          const latestOb = rental ? latestCycleForRental(rental.id) : null;
          const anniversaryDay = Number(
            rental?.dueDayOfMonth
            || latestOb?.anniversaryDay
            || String(rental?.startDate || "").slice(8, 10),
          ) || null;
          const cycleStart = latestOb?.cycleStart || latestOb?.dueDate || null;
          const nextStart = cycleStart && anniversaryDay
            ? nextCycleStart(cycleStart, 1, anniversaryDay)
            : (cycleStart ? nextCycleStart(cycleStart, 1) : null);
          const renewVisible = !!(rental && nextStart && renewButtonVisible(nextStart, asOfDate, 7));
          // Per-space receipts for the current period — used by the receipt history
          // panel and the Manager حذف الإيصال control. We include ALL states so the
          // history panel can show reversed receipts as cancelled/audited.
          const spaceReceipts = receipts
            .filter((r) => r.spaceId === sp.id)
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

          return {
            spaceId: sp.id, name: sp.name, occupancy: sp.occupancy || "vacant",
            rentalId: rental?.id || null,
            tenantName: rental?.tenantName || v?.tenantName || null,
            tenantPhone: rental?.tenantPhone || null,
            startDate: rental?.startDate || null,
            dueDayOfMonth: rental?.dueDayOfMonth || null,
            obligationId: v?.obligationId || null,
            rentalCycleId: latestOb?.rentalCycleId || latestOb?.id || null,
            cycleStart: cycleStart || null,
            cycleEnd: latestOb?.cycleEnd || null,
            nextCycleStart: nextStart,
            renewVisible,
            dueFils: display.dueFils,
            paidFils: display.paidFils,
            remainingFils: display.remainingFils,
            dueDate: display.dueDate,
            status: display.status,
            receiptCount: v?.receiptCount ?? 0,
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
    deposits: visibleDeposits.map((d) => ({
      id: d.id, amountFils: d.amountFils, state: d.state, depositDate: d.depositDate,
      employeeName: nameOf(d.employeeId), reference: d.reference,
      accountName: accounts.find((a) => a.id === d.destinationAccountId)?.name || "—",
    })),
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
    ui: await buildUiBundle({ db, period }),
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

/**
 * Occupancy wins for the card label. Money figures for a vacant/staff space still
 * surface historical period numbers when an obligation exists, but the status chip
 * is vacant/staff so move-out never looks "collected" after refresh.
 * A rented space with no obligation yet this period shows late/not_due from rent,
 * never vacant.
 */
function spaceDisplay({ space, view, rental, period, asOfDate }) {
  const occupancy = space.occupancy || "vacant";
  if (occupancy === "staff") {
    return { status: "staff", dueFils: 0, paidFils: 0, remainingFils: 0, dueDate: null };
  }
  if (occupancy === "vacant") {
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
  const dueFils = rental?.contractualAmountFils ?? 0;
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
    .map((r) => ({
    id: r.id,
    type: r.type,
    desc: r.desc,
    payload: parseJsonSafe(r.payloadJson, r.payload || {}),
    by: r.byKey || r.by,
    byName: r.byName,
    month: r.month,
    year: r.year,
    status: r.status,
    createdAt: r.createdAt,
  })).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return { config, requests: reqs, extras };
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
  const spaces = dump("spaces");
  const units = dump("units");
  const users = dump("users");
  const accounts = dump("accounts");
  const rentals = dump("rentals");

  const nameOf = (id) => users.find((u) => u.id === id)?.displayName || id;
  const spaceName = (id) => spaces.find((s) => s.id === id)?.name || "—";
  const unitName = (id) => units.find((u) => u.id === id)?.name || "—";

  const liveObs = liveObligationsForPeriod(obligations, rentals);
  const summary = periodSummary({ obligations: liveObs, receipts, deposits, expenses, asOfDate });
  const allReceipts = dump("receipts");
  const allDeposits = dump("deposits");
  const shared = sharedHoldingFils({ receipts: allReceipts, deposits: allDeposits });
  const collectedBy = holdingByEmployee({ receipts: allReceipts, deposits: allDeposits });
  summary.holdingFils = shared;
  summary.sharedEmployeeHoldingFils = shared;
  summary.custody = collectedBy;
  const approvedAll = allDeposits.filter((d) => d.state === "approved").reduce((s, d) => s + Number(d.amountFils || 0), 0);
  const problems = checkInvariants({
    ...summary, approvedDepositsFils: approvedAll, custody: collectedBy, holdingFils: shared,
  }).problems;
  const views = liveObs
    .map((o) => {
      const v = obligationView(o, receipts, asOfDate);
      return { ...v, spaceId: o.spaceId, rentalId: o.rentalId, spaceName: spaceName(o.spaceId), unitName: unitName(o.unitId) };
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
    receipts,
    deposits,
    expenses,
    accounts,
    spaces,
    units,
    rentals,
    myHolding: shared,
  };
}

