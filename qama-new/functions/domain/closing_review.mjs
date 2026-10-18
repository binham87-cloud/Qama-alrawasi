/**
 * Read-only month-end readiness.
 * Unpaid rent and recorded undeposited holding are notes, not blockers.
 * A blocker is an inconsistency that would make the snapshot untrustworthy.
 */
import { rentalCoversPeriod, sharedHoldingFils, monthlyRenewalCountsInTarget } from "./finance.mjs";

const FINANCIAL_REQUEST_TYPES = new Set([
  "update_partition",
  "update_full",
  "add_transaction",
  "add_expense",
  "add_daily",
  "receipt_correction",
]);

function periodOfRequest(req) {
  const y = Number(req && req.year);
  const m = Number(req && req.month);
  if (!y || !Number.isFinite(m)) return null;
  return `${y}-${String(m + 1).padStart(2, "0")}`;
}

function activeObligations(obligations, period) {
  return (obligations || []).filter((o) =>
    o && o.period === period && o.state === "active" && o.baselineExcluded !== true
  );
}

export function reviewPeriodClose({
  period,
  obligations = [],
  receipts = [],
  deposits = [],
  rentals = [],
  requests = [],
}) {
  const blockers = [];
  const notes = [];
  const live = activeObligations(obligations, period);
  const byRental = new Map();
  for (const ob of live) {
    const list = byRental.get(ob.rentalId) || [];
    list.push(ob);
    byRental.set(ob.rentalId, list);
  }
  for (const [rentalId, list] of byRental) {
    if (list.length > 1) {
      blockers.push({
        code: "DUPLICATE_OBLIGATION",
        period,
        rentalId,
        obligationIds: list.map((o) => o.id),
        message: "أكثر من التزام نشط لنفس العقد في نفس الشهر",
      });
    }
  }

  const spaces = new Set(live.map((o) => o.spaceId).filter(Boolean));
  for (const spaceId of spaces) {
    const covering = (rentals || []).filter((r) =>
      r && r.spaceId === spaceId && r.baselineExcluded !== true && rentalCoversPeriod(r, period, obligations)
    );
    const spaceObs = live.filter((o) => o.spaceId === spaceId);
    if (covering.length > 1 && spaceObs.length > 1) {
      blockers.push({
        code: "OVERLAPPING_CONTRACTS",
        period,
        spaceId,
        rentalIds: covering.map((r) => r.id),
        obligationIds: spaceObs.map((o) => o.id),
        message: "أكثر من عقد يغطي نفس القسم في نفس الشهر",
      });
    }
  }

  const recognized = (receipts || []).filter((r) => r && r.state === "recognized" && r.period === period);
  const obById = new Map((obligations || []).filter(Boolean).map((o) => [o.id, o]));
  const rentalsById = new Map((rentals || []).filter(Boolean).map((r) => [r.id, r]));
  for (const ob of live) {
    if (!monthlyRenewalCountsInTarget(ob, rentalsById.get(ob.rentalId), receipts)) continue;
    const paid = recognized
      .filter((r) => r.obligationId === ob.id)
      .reduce((s, r) => s + Number(r.amountFils || 0), 0);
    if (paid > Number(ob.amountFils || 0)) {
      blockers.push({
        code: "OVERPAID_OBLIGATION",
        period,
        obligationId: ob.id,
        rentalId: ob.rentalId,
        spaceId: ob.spaceId,
        dueFils: Number(ob.amountFils || 0),
        paidFils: paid,
        message: "المحصّل المعترف به أكبر من الالتزام",
      });
    } else if (paid < Number(ob.amountFils || 0)) {
      notes.push({
        code: "ARREARS",
        period,
        obligationId: ob.id,
        spaceId: ob.spaceId,
        remainingFils: Number(ob.amountFils || 0) - paid,
        message: "متبقي مشروع — لا يمنع الإقفال",
      });
    }
  }
  for (const receipt of recognized) {
    if (String(receipt.obligationId || "").startsWith("daily:")) continue;
    const ob = obById.get(receipt.obligationId);
    if (!ob || ob.state === "cancelled") {
      blockers.push({
        code: "ORPHAN_RECEIPT",
        period,
        receiptId: receipt.id,
        obligationId: receipt.obligationId || null,
        message: "إيصال معترف به بلا التزام نشط",
      });
    }
  }

  const pending = (requests || []).filter((r) => {
    if (!r || r.status !== "pending" || r.type === "pending_lock" || !FINANCIAL_REQUEST_TYPES.has(r.type)) return false;
    if (periodOfRequest(r) === period) return true;
    const impactPeriod = r.impact && r.impact.period;
    return impactPeriod === period;
  });
  for (const req of pending) {
    blockers.push({
      code: "PENDING_APPROVAL",
      period,
      requestId: req.id,
      requestType: req.type,
      message: "طلب مالي معلّق يؤثر على الشهر",
    });
  }

  const holdingFils = sharedHoldingFils({ receipts, deposits, period });
  if (holdingFils < 0) {
    blockers.push({
      code: "NEGATIVE_HOLDING",
      period,
      holdingFils,
      message: "العهدة المشتركة سالبة",
    });
  } else if (holdingFils > 0) {
    notes.push({
      code: "UNDEPOSITED_HOLDING",
      period,
      holdingFils,
      message: "عهدة مسجّلة لم تُودَع — لا تمنع الإقفال",
    });
  }

  const approvedDeposits = (deposits || []).filter((d) =>
    d && d.state === "approved" && d.sourceKind !== "external"
    && (d.sourcePeriod === period || d.period === period)
  );
  const depositedFils = approvedDeposits.reduce((s, d) => s + Number(d.amountFils || 0), 0);
  notes.push({
    code: "APPROVED_DEPOSITS",
    period,
    count: approvedDeposits.length,
    depositedFils,
    message: "إيداعات معتمدة مرتبطة بالشهر",
  });

  const counted = live.filter((o) => monthlyRenewalCountsInTarget(o, rentalsById.get(o.rentalId), receipts));
  const dueFils = counted.reduce((s, o) => s + Number(o.amountFils || 0), 0);
  const collectedFils = recognized
    .filter((r) => !String(r.obligationId || "").startsWith("daily:"))
    .reduce((s, r) => s + Number(r.amountFils || 0), 0);

  return {
    period,
    ready: blockers.length === 0,
    blockers,
    notes,
    totals: {
      obligationCount: counted.length,
      dueFils,
      collectedFils,
      remainingFils: Math.max(0, dueFils - collectedFils),
      holdingFils,
      depositedFils,
      pendingRequestCount: pending.length,
    },
  };
}
