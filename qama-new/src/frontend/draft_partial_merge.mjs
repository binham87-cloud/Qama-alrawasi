/**
 * Draft partial/paid merge for Old-UI hydrate.
 * Pure — Node-testable. Assembled into the browser bridge.
 *
 * Mid-edit drafts may survive refresh. They must NOT:
 *  - resurrect after reverse/uncollect (reversed receipts present)
 *  - auto-create receipts (applyCollection still requires collectionMethod)
 *  - carry a prior tenant's draft into a new rental (draftForRentalId mismatch)
 *  - paint the card/KPI as confirmed «محصّل» before a recognized receipt exists
 *
 * draftReverseGen: reverse-count at the moment the *current* collect/partial draft
 * was opened. A draft with missing/older gen than live reverse count is stale
 * (pre-uncollect) and must not reopen method/paid or re-mint money.
 */
export function reverseCount(sp) {
  const receipts = Array.isArray(sp && sp.spaceReceipts) ? sp.spaceReceipts : [];
  return receipts.filter((r) => r && r.state === "reversed").length;
}

export function isStaleCollectDraft(extra, sp) {
  if (!extra) return false;
  const rev = reverseCount(sp);
  if (!(rev > 0)) return false;
  const gen = Number(extra.draftReverseGen);
  // Missing gen after any reverse ⇒ predates the uncollect bookkeeping.
  if (!Number.isFinite(gen)) return true;
  return gen < rev;
}

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
  if (hasRecognized) return { partial: false, paid_amount: enginePaid };
  // Stale pre-uncollect draft (paid/method from before reverse) must die.
  if (isStaleCollectDraft(extra, sp)) {
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
  // Never restore collectionMethod from a pre-uncollect draft.
  if (extra && extra.collectionMethod && !isStaleCollectDraft(extra, sp)) {
    out.collectionMethod = extra.collectionMethod;
  }

  if (!tenantOk) return out;

  if ((eng === "vacant" || eng === "staff") && (draft === "late" || draft === "pending")) {
    out.status = draft;
    return out;
  }

  if (draft === "collected") {
    if (isStaleCollectDraft(extra, sp)) {
      // Pre-uncollect «محصّل» extras must not reopen as collect draft.
      return out;
    }
    // After bank reject / reverse, engine money status wins — never restore a
    // hardcoded «محصّل» from extras when there is no pending bank awaiting approval.
    const pendingBank = receipts.some((r) => r && r.method === "bank" && r.state === "pending");
    if ((eng === "late" || eng === "partial" || eng === "not_due") && !pendingBank) {
      return out;
    }
    // Keep editor intent via _collectDraft only — NEVER force status:"collected"
    // without a recognized receipt (that caused Yahya محصّل vs Manager متأخر).
    out._collectDraft = true;
    return out;
  }

  return out;
}
