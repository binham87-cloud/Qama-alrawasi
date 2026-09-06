/**
 * Draft partial/paid merge for Old-UI hydrate.
 * Pure — Node-testable. Assembled into the browser bridge.
 *
 * Mid-edit drafts may survive refresh. They must NOT:
 *  - resurrect after reverse/uncollect (reversed receipts present)
 *  - auto-create receipts (applyCollection still requires collectionMethod)
 *  - carry a prior tenant's draft into a new rental (draftForRentalId mismatch)
 *  - paint the card/KPI as confirmed «محصّل» before a recognized receipt exists
 */
export function mergeDraftPartial(mapped, extra, sp) {
  const enginePaid = Number(mapped.paid_amount || 0);
  if (enginePaid > 0 || mapped.partial) {
    return { partial: !!mapped.partial, paid_amount: enginePaid || Number(mapped.paid_amount || 0) };
  }
  const draftPartial = !!extra.partial;
  const draftPaid = Number(extra.paid_amount || 0) || 0;
  if (!draftPartial && draftPaid <= 0) {
    return { partial: false, paid_amount: 0 };
  }
  if (mapped.status === "vacant" || mapped.status === "staff") {
    return { partial: draftPartial, paid_amount: draftPaid };
  }
  const rentalId = (sp && sp.rentalId) || "";
  const draftFor = extra.draftForRentalId != null ? String(extra.draftForRentalId) : null;
  if (draftFor != null && draftFor !== "" && rentalId && draftFor !== rentalId) {
    return { partial: false, paid_amount: 0 };
  }
  const receipts = Array.isArray(sp && sp.spaceReceipts) ? sp.spaceReceipts : [];
  const hasRecognized = receipts.some((r) => r && r.state === "recognized");
  const hasReversed = receipts.some((r) => r && r.state === "reversed");
  if (hasRecognized) return { partial: false, paid_amount: enginePaid };
  // Reversed history must not resurrect a *stale* draft — but an intentional new
  // partial draft after uncollect (extras.partial / paid just set) must survive hydrate
  // so the method picker can appear and applyCollection can run.
  if (hasReversed && !(draftPartial || draftPaid > 0)) {
    return { partial: false, paid_amount: 0 };
  }
  return { partial: draftPartial, paid_amount: draftPaid };
}

/**
 * Preserve in-progress form intent across hydrate without claiming confirmed collection.
 * - Card/KPI status stays on engine money truth (never force status:"collected" without receipt).
 * - `_collectDraft` + collectionMethod let the open editor keep محصّل + method picker.
 */
export function mergeDraftStatus(mapped, extra, sp) {
  const draft = String((extra && extra.status) || "");
  const eng = String((mapped && mapped.status) || "");
  const tenantOk = !!(
    (extra && String(extra.tenant || "").trim()) ||
    (sp && String(sp.tenantName || "").trim())
  );
  const receipts = Array.isArray(sp && sp.spaceReceipts) ? sp.spaceReceipts : [];
  const hasRecognized = receipts.some((r) => r && r.state === "recognized");
  if (hasRecognized) return {};

  const out = {};
  if (extra && extra.collectionMethod) {
    out.collectionMethod = extra.collectionMethod;
  }

  if (!tenantOk) return out;

  // Vacant engine + rented draft (late/pending): show unpaid rented, not collected.
  if ((eng === "vacant" || eng === "staff") && (draft === "late" || draft === "pending")) {
    out.status = draft;
    return out;
  }

  // User chose محصّل in the form but money is not recognized yet — form draft only.
  // Keep status "collected" so a later method pick (cash/bank) still runs applyCollection
  // after hydrate. Cards/KPIs stay unpaid via displayStatus/paidValue + _collectDraft.
  if (draft === "collected") {
    out._collectDraft = true;
    if (eng === "vacant" || eng === "staff") {
      // No rental yet: occupancy intent without confirming cash.
      out.status = "late";
    } else {
      out.status = "collected";
    }
    return out;
  }

  return out;
}
