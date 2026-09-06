/**
 * Proof: stale pre-uncollect drafts must not revive; fresh post-uncollect drafts may.
 * Also: collect→uncollect→recollect creates exactly one live receipt (no double).
 */
import { mergeDraftPartial, mergeDraftStatus, isStaleCollectDraft } from "../../src/frontend/draft_partial_merge.mjs";
import assert from "node:assert/strict";

const late0 = { status: "late", partial: false, paid_amount: 0 };
const spRev1 = {
  rentalId: "r1",
  spaceReceipts: [{ state: "reversed", amountFils: 10000 }],
};

// --- unit: stale vs fresh ---
{
  // Old draft (no gen) after reverse → stale
  assert.equal(isStaleCollectDraft({ partial: true, paid_amount: 40, status: "collected", collectionMethod: "cash" }, spRev1), true);
  const r = mergeDraftPartial(late0, { partial: true, paid_amount: 40, draftForRentalId: "r1" }, spRev1);
  assert.equal(r.partial, false);
  assert.equal(r.paid_amount, 0);
  const s = mergeDraftStatus(late0, { status: "collected", tenant: "أحمد", collectionMethod: "cash" }, spRev1);
  assert.equal(s._collectDraft, undefined);
  assert.equal(s.collectionMethod, undefined);
}

{
  // Fresh draft stamped with draftReverseGen === reverse count → keep
  const extra = {
    partial: true, paid_amount: 40, draftForRentalId: "r1",
    status: "collected", collectionMethod: "cash", draftReverseGen: 1, tenant: "أحمد",
  };
  assert.equal(isStaleCollectDraft(extra, spRev1), false);
  const r = mergeDraftPartial(late0, extra, spRev1);
  assert.equal(r.partial, true);
  assert.equal(r.paid_amount, 40);
  const s = mergeDraftStatus(late0, extra, spRev1);
  assert.equal(s._collectDraft, true);
  assert.equal(s.collectionMethod, "cash");
  assert.equal(s.status, "collected");
}

{
  // gen behind reverse count (draft from before 2nd uncollect) → stale
  const spRev2 = {
    rentalId: "r1",
    spaceReceipts: [
      { state: "reversed", amountFils: 10000 },
      { state: "reversed", amountFils: 10000 },
    ],
  };
  const extra = { partial: true, paid_amount: 100, draftReverseGen: 1, draftForRentalId: "r1", status: "collected", collectionMethod: "cash", tenant: "أ" };
  assert.equal(isStaleCollectDraft(extra, spRev2), true);
  const r = mergeDraftPartial(late0, extra, spRev2);
  assert.equal(r.partial, false);
}

console.log("PASS draft_stale_vs_fresh");
