/**
 * Fail-closed orphan classification for post-vacate accounting safety.
 * Shared by prod_cancel_orphan_obligations.mjs and acceptance tests.
 */

/** Close reasons that mean intentional real vacate / retain — never orphan. */
export const REAL_VACATE_REASON_RE =
  /إخلاء|endTenancy|end.?tenancy|retain|متأخرات|move.?out|vacate|تحويل لفارغ|تحويل لموظفين/i;

/** Proven accidental / test markers required before cancel (fail closed). */
export const PROVEN_TEMP_TENANT_RE = /\bBOT\b|\bTEMP\b|\bSEM\b|UX\d*|VERIFY|ACC-/i;
export const PROVEN_TEMP_REASON_RE =
  /إلغاء إيجار خاطئ|erroneous|orphan|BOT|TEMP|SEM|cleanup|test|harness|acceptance|accidental/i;

/**
 * Classify one active obligation against a closed (or missing) rental.
 * @returns {{ action: "cancel"|"skip", orphanReason: string, safeToCancel: boolean, ... }}
 */
export function classifyOrphanCandidate(o, rental, liveReceipts) {
  const tenant = o.tenantNameSnapshot || rental?.tenantName || null;
  const closeReason = rental?.closeReason || null;
  const retain = o.retainArrearsAfterVacate === true;
  const base = {
    obligationId: o.id,
    rentalId: o.rentalId,
    tenant,
    amountFils: o.amountFils,
    retainArrearsAfterVacate: retain,
    closeReason,
    rentalState: rental?.state || null,
    liveCount: (liveReceipts || []).length,
    liveIds: (liveReceipts || []).map((r) => r.id),
    arrearsRemainingFilsSnapshot: o.arrearsRemainingFilsSnapshot ?? null,
  };

  if (o.state !== "active") {
    return { ...base, action: "skip", orphanReason: "not_active", safeToCancel: false };
  }
  if (!rental) {
    return { ...base, action: "skip", orphanReason: "missing_rental_unproven", safeToCancel: false };
  }
  if (rental.state === "active") {
    return { ...base, action: "skip", orphanReason: "rental_still_active", safeToCancel: false };
  }

  // CRITICAL: CASE B retained debt looks like "active on closed rental, 0 receipts".
  if (retain) {
    return {
      ...base,
      action: "skip",
      orphanReason: "retainArrearsAfterVacate — legitimate post-vacate debt",
      safeToCancel: false,
    };
  }
  if (o.arrearsRemainingFilsSnapshot != null && Number(o.arrearsRemainingFilsSnapshot) > 0) {
    return {
      ...base,
      action: "skip",
      orphanReason: "arrearsRemainingFilsSnapshot set — retained debt marker",
      safeToCancel: false,
    };
  }
  if (closeReason && REAL_VACATE_REASON_RE.test(String(closeReason))) {
    return {
      ...base,
      action: "skip",
      orphanReason: "rental closeReason indicates real vacate/retain intent",
      safeToCancel: false,
    };
  }

  const live = liveReceipts || [];
  if (live.length > 0) {
    return {
      ...base,
      action: "skip",
      orphanReason: "has_live_receipts",
      safeToCancel: false,
    };
  }

  const tenantOk = tenant && PROVEN_TEMP_TENANT_RE.test(String(tenant));
  const reasonOk = closeReason && PROVEN_TEMP_REASON_RE.test(String(closeReason));
  if (!tenantOk && !reasonOk) {
    return {
      ...base,
      action: "skip",
      orphanReason: "unproven — active on closed rental is not enough (fail closed)",
      safeToCancel: false,
    };
  }

  return {
    ...base,
    action: "cancel",
    orphanReason: tenantOk && reasonOk
      ? "proven_temp_tenant_and_closeReason + closed rental + no live receipts + not retained"
      : tenantOk
        ? "proven_temp_tenant + closed rental + no live receipts + not retained"
        : "proven_temp_closeReason + closed rental + no live receipts + not retained",
    safeToCancel: true,
  };
}
