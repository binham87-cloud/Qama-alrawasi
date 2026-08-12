import { cashLotAvailable, requirePositive } from "./financial_engine.mjs";

function lotDate(lot) {
  return String(lot.paymentDate || lot.createdAt || "9999-12-31");
}

export function availableCashLots(state, holderId) {
  return (state.cashLots || [])
    .filter((lot) => lot.currentHolder === holderId)
    .map((lot) => ({ lot, availableFils: cashLotAvailable(lot, state.cashMovements || []) }))
    .filter((item) => item.availableFils > 0)
    .sort((a, b) => lotDate(a.lot).localeCompare(lotDate(b.lot)) || a.lot.id.localeCompare(b.lot.id));
}

// UI suggestion only. The returned lines have no financial effect until the employee
// reviews them and submits them as part of a backend command.
export function suggestCashAllocation(state, holderId, requestedAmountFils) {
  let remaining = requirePositive(requestedAmountFils);
  const allocations = [];
  for (const { lot, availableFils } of availableCashLots(state, holderId)) {
    if (!remaining) break;
    const amountFils = Math.min(availableFils, remaining);
    allocations.push({
      cashLotId: lot.id,
      amountFils,
      availableFils,
      lotVersion: Number(lot.version || 0),
      tenant: lot.tenant || null,
      unitId: lot.unitId || null,
      originPaymentId: lot.originPaymentId,
      paymentDate: lot.paymentDate,
    });
    remaining -= amountFils;
  }
  return { requestedAmountFils, allocations, fullyAllocated: remaining === 0, shortfallFils: remaining };
}

export function validateConfirmedCashAllocation(state, holderId, rawLines, requestedAmountFils) {
  const lines = (rawLines || []).map((line) => ({
    cashLotId: String(line.cashLotId || ""),
    amountFils: requirePositive(line.amountFils),
  }));
  if (!lines.length) throw new Error("CASH_ALLOCATIONS_REQUIRED");
  const requested = requirePositive(requestedAmountFils);
  const seen = new Set();
  let totalFils = 0;
  const snapshots = [];
  for (const line of lines) {
    if (seen.has(line.cashLotId)) throw new Error("DUPLICATE_CASH_LOT_ALLOCATION");
    seen.add(line.cashLotId);
    const lot = (state.cashLots || []).find((x) => x.id === line.cashLotId);
    if (!lot) throw new Error("CASH_LOT_NOT_FOUND");
    const availableFils = cashLotAvailable(lot, state.cashMovements || []);
    if (lot.currentHolder !== holderId || line.amountFils > availableFils) throw new Error("STALE_CASH_ALLOCATION");
    totalFils += line.amountFils;
    snapshots.push({ cashLotId: lot.id, holderId, lotVersion: Number(lot.version || 0), availableFils });
  }
  if (totalFils !== requested) throw new Error("CASH_ALLOCATION_TOTAL_MISMATCH");
  return { lines, totalFils, snapshots };
}

export function assertCashAllocationStillValid(state, lines, snapshots, holderId) {
  if (!Array.isArray(snapshots) || snapshots.length !== lines.length) throw new Error("STALE_CASH_ALLOCATION");
  for (const line of lines) {
    const lot = (state.cashLots || []).find((x) => x.id === line.cashLotId);
    const snapshot = snapshots.find((x) => x.cashLotId === line.cashLotId);
    if (!lot || !snapshot || lot.currentHolder !== holderId || snapshot.holderId !== holderId) throw new Error("STALE_CASH_ALLOCATION");
    const availableFils = cashLotAvailable(lot, state.cashMovements || []);
    if (Number(lot.version || 0) !== Number(snapshot.lotVersion || 0) || availableFils !== snapshot.availableFils || line.amountFils > availableFils) {
      throw new Error("STALE_CASH_ALLOCATION");
    }
  }
  return true;
}
