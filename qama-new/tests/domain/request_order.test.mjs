import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalRequestCreatedAt, sortRequestsNewestFirst, instantToIso,
} from "../../functions/domain/request_order.mjs";

const T = {
  R1: "2026-10-01T08:00:00.000Z",
  R2: "2026-10-02T08:00:00.000Z",
  R3: "2026-10-03T08:00:00.000Z",
  R4: "2026-10-04T08:00:00.000Z",
};

test("shuffled creation order returns newest first", () => {
  const rows = [
    { id: "R2", createdAt: T.R2 },
    { id: "R4", createdAt: T.R4 },
    { id: "R1", createdAt: T.R1 },
    { id: "R3", createdAt: T.R3 },
  ];
  assert.deepEqual(sortRequestsNewestFirst(rows).map((r) => r.id), ["R4", "R3", "R2", "R1"]);
});

test("later approval does not promote an older request", () => {
  const rows = [
    { id: "R1", createdAt: T.R1, status: "pending" },
    { id: "R2", createdAt: T.R2, status: "approved", resolvedAt: "2026-10-09T22:00:00.000Z", approvedAt: "2026-10-09T22:00:00.000Z" },
    { id: "R3", createdAt: T.R3, status: "pending" },
    { id: "R4", createdAt: T.R4, status: "rejected", resolvedAt: "2026-10-09T23:00:00.000Z", rejectedAt: "2026-10-09T23:00:00.000Z" },
  ];
  assert.deepEqual(sortRequestsNewestFirst(rows).map((r) => r.id), ["R4", "R3", "R2", "R1"]);
});

test("equal timestamps tie-break by id descending", () => {
  const same = "2026-10-05T12:00:00.000Z";
  const rows = [
    { id: "R1", createdAt: same },
    { id: "R3", createdAt: same },
    { id: "R2", createdAt: same },
  ];
  assert.deepEqual(sortRequestsNewestFirst(rows).map((r) => r.id), ["R3", "R2", "R1"]);
});

test("Firestore Timestamp objects sort by instant, not String(object)", () => {
  const oldTs = {
    seconds: Date.parse("2020-01-01T00:00:00.000Z") / 1000,
    nanoseconds: 0,
  };
  const rows = [
    { id: "old", createdAt: oldTs },
    { id: "mid", createdAt: "2026-10-01T00:00:00.000Z" },
  ];
  assert.equal(instantToIso(oldTs), "2020-01-01T00:00:00.000Z");
  assert.deepEqual(sortRequestsNewestFirst(rows).map((r) => r.id), ["mid", "old"]);
  // String() collapses every Firestore Timestamp to the same key, so a localeCompare
  // on that string cannot order two timestamp records.
  const other = { seconds: Date.parse("2026-10-04T00:00:00.000Z") / 1000, nanoseconds: 0 };
  assert.equal(String(oldTs), String(other));
  assert.notEqual(instantToIso(oldTs), instantToIso(other));
  const pair = sortRequestsNewestFirst([
    { id: "older", createdAt: oldTs },
    { id: "newer", createdAt: other },
  ]);
  assert.deepEqual(pair.map((r) => r.id), ["newer", "older"]);
});

test("legacy request without createdAt uses submittedAt and never 'now'", () => {
  const rows = [
    { id: "legacy", submittedAt: "2026-09-01T00:00:00.000Z", resolvedAt: "2026-10-09T23:59:00.000Z" },
    { id: "R4", createdAt: T.R4 },
  ];
  assert.equal(canonicalRequestCreatedAt(rows[0]), "2026-09-01T00:00:00.000Z");
  assert.deepEqual(sortRequestsNewestFirst(rows).map((r) => r.id), ["R4", "legacy"]);
});

test("legacy request with no trusted timestamp sorts oldest", () => {
  const rows = [
    { id: "ghost", status: "approved", resolvedAt: "2099-01-01T00:00:00.000Z" },
    { id: "R1", createdAt: T.R1 },
  ];
  assert.equal(canonicalRequestCreatedAt(rows[0]), "");
  assert.deepEqual(sortRequestsNewestFirst(rows).map((r) => r.id), ["R1", "ghost"]);
});

test("pending and own-history filters keep newest-first inside each section", () => {
  const rows = sortRequestsNewestFirst([
    { id: "R1", createdAt: T.R1, status: "pending", byKey: "yahia" },
    { id: "R2", createdAt: T.R2, status: "approved", byKey: "yahia", resolvedAt: "2026-10-09T22:00:00.000Z" },
    { id: "R3", createdAt: T.R3, status: "pending", byKey: "nader" },
    { id: "R4", createdAt: T.R4, status: "pending", byKey: "yahia" },
  ]);
  const pending = rows.filter((r) => r.status === "pending");
  const yahia = rows.filter((r) => r.byKey === "yahia");
  assert.deepEqual(pending.map((r) => r.id), ["R4", "R3", "R1"]);
  assert.deepEqual(yahia.map((r) => r.id), ["R4", "R2", "R1"]);
});
