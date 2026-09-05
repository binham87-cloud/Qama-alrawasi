import { mergeDraftPartial } from "../../src/frontend/draft_partial_merge.mjs";
import assert from "node:assert/strict";

const late0 = { status: "late", partial: false, paid_amount: 0 };

// Mid-edit: keep draft when no receipt history
{
  const r = mergeDraftPartial(late0, { partial: true, paid_amount: 40, draftForRentalId: "r1" }, {
    rentalId: "r1", spaceReceipts: [],
  });
  assert.equal(r.partial, true);
  assert.equal(r.paid_amount, 40);
}

// After reverse/uncollect: do NOT resurrect
{
  const r = mergeDraftPartial(late0, { partial: true, paid_amount: 40, draftForRentalId: "r1" }, {
    rentalId: "r1",
    spaceReceipts: [{ state: "reversed", amountFils: 4000 }],
  });
  assert.equal(r.partial, false);
  assert.equal(r.paid_amount, 0);
}

// New rental cycle: prior draft must not carry
{
  const r = mergeDraftPartial(late0, { partial: true, paid_amount: 40, draftForRentalId: "r-old" }, {
    rentalId: "r-new", spaceReceipts: [],
  });
  assert.equal(r.partial, false);
  assert.equal(r.paid_amount, 0);
}

// Engine paid wins
{
  const r = mergeDraftPartial(
    { status: "late", partial: true, paid_amount: 40 },
    { partial: true, paid_amount: 99 },
    { rentalId: "r1", spaceReceipts: [{ state: "recognized", amountFils: 4000 }] },
  );
  assert.equal(r.partial, true);
  assert.equal(r.paid_amount, 40);
}

// Recognized present but mapped unpaid → discard draft (prefer engine)
{
  const r = mergeDraftPartial(late0, { partial: true, paid_amount: 40 }, {
    rentalId: "r1",
    spaceReceipts: [{ state: "recognized", amountFils: 4000 }],
  });
  assert.equal(r.partial, false);
  assert.equal(r.paid_amount, 0);
}

console.log("PASS draft_partial_merge");
