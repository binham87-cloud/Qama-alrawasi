import { mergeDraftPartial, mergeDraftStatus } from "../../src/frontend/draft_partial_merge.mjs";
import assert from "node:assert/strict";

const late0 = { status: "late", partial: false, paid_amount: 0 };

{
  const r = mergeDraftPartial(late0, { partial: true, paid_amount: 40, draftForRentalId: "r1" }, {
    rentalId: "r1", spaceReceipts: [],
  });
  assert.equal(r.partial, true);
  assert.equal(r.paid_amount, 40);
}

{
  // Stale draft with no active partial flags stays cleared after reverse.
  const r = mergeDraftPartial(late0, { partial: false, paid_amount: 0, draftForRentalId: "r1" }, {
    rentalId: "r1",
    spaceReceipts: [{ state: "reversed", amountFils: 4000 }],
  });
  assert.equal(r.partial, false);
  assert.equal(r.paid_amount, 0);
}

{
  // Pre-uncollect partial (no draftReverseGen) after reverse must die.
  const stale = mergeDraftPartial(late0, { partial: true, paid_amount: 40, draftForRentalId: "r1" }, {
    rentalId: "r1",
    spaceReceipts: [{ state: "reversed", amountFils: 10000 }],
  });
  assert.equal(stale.partial, false);
  assert.equal(stale.paid_amount, 0);
}

{
  // Intentional new partial after uncollect (stamped draftReverseGen) survives hydrate.
  const r = mergeDraftPartial(late0, {
    partial: true, paid_amount: 40, draftForRentalId: "r1", draftReverseGen: 1,
  }, {
    rentalId: "r1",
    spaceReceipts: [{ state: "reversed", amountFils: 10000 }],
  });
  assert.equal(r.partial, true);
  assert.equal(r.paid_amount, 40);
}

{
  const r = mergeDraftPartial(late0, { partial: true, paid_amount: 40, draftForRentalId: "r-old" }, {
    rentalId: "r-new", spaceReceipts: [],
  });
  assert.equal(r.partial, false);
  assert.equal(r.paid_amount, 0);
}

{
  const r = mergeDraftPartial(
    { status: "late", partial: true, paid_amount: 40 },
    { partial: true, paid_amount: 99 },
    { rentalId: "r1", spaceReceipts: [{ state: "recognized", amountFils: 4000 }] },
  );
  assert.equal(r.partial, true);
  assert.equal(r.paid_amount, 40);
}

{
  const r = mergeDraftPartial(late0, { partial: true, paid_amount: 40 }, {
    rentalId: "r1",
    spaceReceipts: [{ state: "recognized", amountFils: 4000 }],
  });
  assert.equal(r.partial, false);
  assert.equal(r.paid_amount, 0);
}

// Draft collected must NOT force status collected (no green confirmed card)
{
  const r = mergeDraftStatus(
    { status: "vacant" },
    { status: "collected", tenant: "أحمد", collectionMethod: "" },
    {}
  );
  assert.equal(r._collectDraft, true);
  assert.equal(r.status, "late");
  assert.notEqual(r.status, "collected");
}

{
  const r = mergeDraftStatus(
    { status: "late" },
    { status: "collected", tenant: "أحمد", collectionMethod: "cash" },
    { rentalId: "r1", spaceReceipts: [], tenantName: "أحمد" }
  );
  assert.equal(r._collectDraft, true);
  assert.equal(r.collectionMethod, "cash");
  // Form status must stay collected so recollect-after-uncollect still applies cash.
  // Cards/KPIs remain unpaid via displayStatus/paidValue while _collectDraft is set.
  assert.equal(r.status, "collected");
}

{
  const r = mergeDraftStatus(
    { status: "late" },
    { status: "collected", tenant: "أحمد" },
    { rentalId: "r1", spaceReceipts: [{ state: "recognized" }], tenantName: "أحمد" }
  );
  assert.deepEqual(r, {});
}

// Draft partial without engine money stays form-only (_collectDraft path in UI paidValue → 0)
{
  const r = mergeDraftStatus(
    { status: "late" },
    { status: "collected", tenant: "أحمد", partial: true, paid_amount: 40 },
    { rentalId: "r1", spaceReceipts: [], tenantName: "أحمد" }
  );
  assert.equal(r._collectDraft, true);
}

console.log("PASS draft_partial_merge");
