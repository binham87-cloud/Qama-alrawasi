import test from "node:test";
import assert from "node:assert/strict";
import { classifyOrphanCandidate } from "../../scripts/lib/orphan_obligation_classify.mjs";

test("retained post-vacate debt is never orphan", () => {
  const r = classifyOrphanCandidate(
    {
      id: "ob1",
      rentalId: "r1",
      state: "active",
      amountFils: 200000,
      retainArrearsAfterVacate: true,
      tenantNameSnapshot: "أحمد",
    },
    { state: "closed", closeReason: "إخلاء من زر مستقل", tenantName: "أحمد" },
    [],
  );
  assert.equal(r.action, "skip");
  assert.match(r.orphanReason, /retainArrearsAfterVacate/);
  assert.equal(r.safeToCancel, false);
});

test("active on closed rental alone is not enough (fail closed)", () => {
  const r = classifyOrphanCandidate(
    {
      id: "ob2",
      rentalId: "r2",
      state: "active",
      amountFils: 10000,
      tenantNameSnapshot: "مستأجر حقيقي",
    },
    { state: "closed", closeReason: "manual close", tenantName: "مستأجر حقيقي" },
    [],
  );
  assert.equal(r.action, "skip");
  assert.match(r.orphanReason, /unproven/);
});

test("proven BOT orphan without retain may cancel", () => {
  const r = classifyOrphanCandidate(
    {
      id: "ob3",
      rentalId: "r3",
      state: "active",
      amountFils: 10100,
      retainArrearsAfterVacate: false,
      tenantNameSnapshot: "BOT UX2 mtqcs15p",
    },
    { state: "closed", closeReason: "BOT TEMP accidental orphan seed", tenantName: "BOT UX2 mtqcs15p" },
    [],
  );
  assert.equal(r.action, "cancel");
  assert.equal(r.safeToCancel, true);
});

test("real vacate closeReason blocks cancel even without retain flag", () => {
  const r = classifyOrphanCandidate(
    {
      id: "ob4",
      rentalId: "r4",
      state: "active",
      amountFils: 10000,
      tenantNameSnapshot: "BOT ORF",
    },
    { state: "closed", closeReason: "إخلاء مستأجر حقيقي", tenantName: "BOT ORF" },
    [],
  );
  assert.equal(r.action, "skip");
  assert.match(r.orphanReason, /real vacate/);
});
