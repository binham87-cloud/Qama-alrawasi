/**
 * Production-shaped legacy month KPI projection.
 * Used when rentalCycles are empty so familiar months/{YYYY_M} rents/transactions
 * remain the compatibility contract without inventing payment entities.
 */
const num = (x) => Number(x) || 0;
const r2 = (x) => Math.round(Number(x) * 100) / 100;
const fils = (aed) => Math.round(Number(aed) * 100);

function allItems(data) {
  const items = [];
  for (const u of data?.units || []) {
    for (const p of u.partitions || []) items.push(p);
  }
  for (const f of data?.full || []) items.push(f);
  return items;
}

function bookingWasPaid(b) {
  if (!b) return false;
  const st = b.status;
  if (st === "pending") return false;
  if (st === "paid" || st === "confirmed") return !!b.paidAt;
  if (st === "cancelled" || st === "refunded") {
    if (typeof b.wasPaid === "boolean") return b.wasPaid;
    return !!b.paidAt;
  }
  return true;
}

function bookingNet(b) {
  if (!bookingWasPaid(b)) return 0;
  return Math.max(0, r2(num(b.total) - num(b.refundAmount)));
}

/** Same contract as familiar UI inTarget (index.html). */
export function legacyInTarget(x, year, monthIndex0) {
  if (!x || !(num(x.rent) > 0)) return false;
  if (x.status === "vacant" || x.status === "staff") return false;
  const mm = String(monthIndex0 + 1).padStart(2, "0");
  const monthStart = `${year}-${mm}-01`;
  const monthEnd = new Date(year, monthIndex0 + 1, 0).toISOString().slice(0, 10);
  const start = String(x.start_date || "").slice(0, 10);
  const end = String(x.contract_end || "").slice(0, 10);
  if (start && start > monthEnd) return false;
  if (end && end < monthStart) return false;
  return true;
}

function received(x) {
  // Actual Collected must come from payment evidence (paid_amount / financial path),
  // never from operational status alone (e.g. status === "collected").
  const paid = num(x.paid_amount);
  const rent = num(x.rent);
  if (paid > 0) return Math.min(paid, rent || paid);
  return 0;
}

function displayLate(x) {
  return String(x.status || "") === "late";
}

/**
 * @param {object} data months/{id}.data
 * @param {number} year
 * @param {number} monthIndex0 0-based
 * @returns {{ cards: object, expensesAed: number, expenseRows: object[], source: string }}
 */
export function projectLegacyMonthFinance(data, year, monthIndex0) {
  const items = allItems(data);
  const daily = r2((data?.dailyBookings || []).reduce((s, b) => s + bookingNet(b), 0));
  let targetAed = 0;
  let collectedAed = 0;
  let arrearsAed = 0;
  const targetDetails = [];
  for (const x of items) {
    if (!legacyInTarget(x, year, monthIndex0)) continue;
    const rent = num(x.rent);
    targetAed += rent;
    const got = received(x);
    collectedAed += got;
    if (displayLate(x)) arrearsAed += Math.max(0, rent - got);
    targetDetails.push({
      cycleId: null,
      unitId: x.unitId || null,
      tenant: x.tenant || null,
      dueDate: x.due_date || null,
      targetFils: fils(rent),
      reservedFils: fils(got),
      remainingFils: fils(Math.max(0, rent - got)),
      source: "legacy_month",
    });
  }
  targetAed = r2(targetAed + daily);
  collectedAed = r2(collectedAed + daily);

  const depositedAed = r2(
    (data?.transactions || []).filter((t) => !t.reversed).reduce((s, t) => s + num(t.amount), 0)
  );

  const expenseRows = [];
  for (const e of data?.expenses || []) {
    if (e?.reversed) continue;
    expenseRows.push({
      id: `legacy-expense:${e.id}`,
      status: "active",
      amountFils: fils(e.amount),
      category: e.category || "operating",
      reason: e.desc || "",
      source: "legacy_month",
      approvedAt: e.date ? `${e.date}T00:00:00.000Z` : null,
    });
  }
  for (const e of data?.unitMaintenance || []) {
    if (e?.reversed) continue;
    expenseRows.push({
      id: `legacy-unit-maint:${e.id}`,
      status: "active",
      amountFils: fils(e.amount),
      category: "unitMaintenance",
      reason: e.desc || "",
      source: "legacy_month",
      approvedAt: e.date ? `${e.date}T00:00:00.000Z` : null,
    });
  }
  for (const e of data?.facilityMaintenance || []) {
    if (e?.reversed) continue;
    expenseRows.push({
      id: `legacy-fac-maint:${e.id}`,
      status: "active",
      amountFils: fils(e.amount),
      category: "facilityMaintenance",
      reason: e.desc || "",
      source: "legacy_month",
      approvedAt: e.date ? `${e.date}T00:00:00.000Z` : null,
    });
  }
  const expensesAed = r2(expenseRows.reduce((s, x) => s + x.amountFils, 0) / 100);

  return {
    source: "legacy_month",
    expensesAed,
    expenseRows,
    cards: {
      targetFils: fils(targetAed),
      collectedFils: fils(collectedAed),
      depositedFils: fils(depositedAed),
      receivedNotDepositedFils: 0,
      arrearsFils: fils(arrearsAed),
      notYetDueFils: 0,
      partialRemainingFils: 0,
      unallocatedOverpaymentFils: 0,
      uncollectedAtEvictionFils: 0,
    },
    details: {
      target: targetDetails,
      collected: collectedAed ? [{ method: "legacy_month", amountFils: fils(collectedAed) }] : [],
      deposited: depositedAed ? [{ method: "legacy_month", amountFils: fils(depositedAed) }] : [],
      receivedNotDeposited: [],
      arrears: [],
      notYetDue: [],
      partialRemaining: [],
      uncollectedAtEviction: [],
    },
  };
}

/** Map familiar UI / historical categories onto engine categories. */
export function normalizeExpenseCategory(raw) {
  const value = String(raw || "operating").trim();
  const aliases = {
    operating: "operating",
    unitMaintenance: "unitMaintenance",
    facilityMaintenance: "facilityMaintenance",
    unit_maintenance: "unitMaintenance",
    facility_maintenance: "facilityMaintenance",
    "صيانة": "operating",
    "إنترنت": "operating",
    "أثاث": "operating",
    "كهرباء": "operating",
    "رواتب": "operating",
    "عام": "operating",
    "أخرى": "operating",
  };
  return aliases[value] || null;
}
