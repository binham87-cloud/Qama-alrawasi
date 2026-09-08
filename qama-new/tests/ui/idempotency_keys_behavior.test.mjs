/**
 * Behavioral proof of frontend opId helpers across collect/uncollect cycles.
 * Does NOT invent operationIds in the test harness for the SUT — it drives the
 * same pure helpers the bridge uses (and asserts the bridge embeds them).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectionOpKey, uncollectOpKey, simulateCollectUncollectCycles, shortOb,
} from "../../src/frontend/idempotency_keys.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const bridge = readFileSync(resolve(root, "src/frontend/qama-engine-bridge.js"), "utf8");

const OB = "rental:rentnew-3344cde738864db9a969eff6df6f1b16_2026-09";
const AMT = 10000;

test("BUG REPRO: old uncol-{ob}-p{already} collides across cycles", () => {
  const old = (already) => (`uncol-${OB}-p${already}`).slice(0, 120);
  assert.equal(old(AMT), old(AMT)); // same key for cycle1 and cycle2 uncollect
});

test("new uncollect keys differ across collect→uncollect→collect→uncollect", () => {
  const { keys } = simulateCollectUncollectCycles(OB, AMT, 2);
  assert.equal(keys.uncol.length, 2);
  assert.notEqual(keys.uncol[0], keys.uncol[1]);
  assert.match(keys.uncol[0], /-L1-A1$/);
  assert.match(keys.uncol[1], /-L1-A2$/);
});

test("collection keys differ after reverse+recollect same amount", () => {
  const { keys } = simulateCollectUncollectCycles(OB, AMT, 2);
  assert.notEqual(keys.pay[0], keys.pay[1]);
  assert.match(keys.pay[0], /-L0-A0$/);
  assert.match(keys.pay[1], /-L0-A1$/); // prior reversed still in list
});

test("retry of same logical collect reuses identical key", () => {
  const receipts = [{ id: "r1", state: "reversed" }];
  const a = collectionOpKey({ obligationId: OB, wantFils: AMT, deltaFils: AMT, receipts });
  const b = collectionOpKey({ obligationId: OB, wantFils: AMT, deltaFils: AMT, receipts });
  assert.equal(a, b);
});

test("retry of same logical uncollect reuses identical key", () => {
  const receipts = [{ id: "r1", state: "recognized" }];
  const a = uncollectOpKey({ obligationId: OB, alreadyFils: AMT, receipts });
  const b = uncollectOpKey({ obligationId: OB, alreadyFils: AMT, receipts });
  assert.equal(a, b);
});

test("keys stay ≤120 with long obligation ids (suffix preserved)", () => {
  const longOb = "rental:" + "x".repeat(80) + "_2026-09";
  const k = uncollectOpKey({
    obligationId: longOb, alreadyFils: AMT,
    receipts: [{ state: "recognized" }, { state: "reversed" }],
  });
  assert.ok(k.length <= 120, k.length);
  assert.match(k, /-L1-A2$/);
  assert.ok(shortOb(longOb).length < longOb.length);
});

test("spaceReceipts semantics: reversed included in all, not live", () => {
  const receipts = [
    { state: "recognized" },
    { state: "reversed" },
    { state: "pending" },
  ];
  const k = collectionOpKey({ obligationId: OB, wantFils: 4000, deltaFils: 4000, receipts });
  assert.match(k, /-L2-A3$/);
});

test("bridge embeds L/A uncollect and collection helpers (not old sticky key)", () => {
  assert.match(bridge, /function uncollectOpKey/);
  assert.match(bridge, /function collectionOpKey/);
  assert.match(bridge, /uncollectOpKey\(ob, already, receipts\)/);
  assert.match(bridge, /collectionOpKey\(ob, want, delta, receipts\)/);
  assert.doesNotMatch(bridge, /\("uncol-" \+ ob \+ "-p" \+ already\)/);
});

test("concurrent identical uncollect key generation is stable", () => {
  const receipts = [{ state: "recognized" }, { state: "reversed" }];
  const keys = Array.from({ length: 50 }, () =>
    uncollectOpKey({ obligationId: OB, alreadyFils: AMT, receipts })
  );
  assert.ok(keys.every((k) => k === keys[0]));
});
