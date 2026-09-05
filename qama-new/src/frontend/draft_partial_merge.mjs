/**
 * Draft partial/paid merge for Old-UI hydrate.
 * Pure — Node-testable. Assembled into the browser bridge.
 *
 * Mid-edit drafts may survive refresh. They must NOT:
 *  - resurrect after reverse/uncollect (reversed receipts present)
 *  - auto-create receipts (applyCollection still requires collectionMethod)
 *  - carry a prior tenant's draft into a new rental (draftForRentalId mismatch)
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
  if (hasReversed) return { partial: false, paid_amount: 0 };
  return { partial: draftPartial, paid_amount: draftPaid };
}
