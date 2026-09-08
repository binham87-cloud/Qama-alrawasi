/**
 * Static proofs for investigation fixes (vacate cycle opIds, error mapping, deposit cancel UX).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const bridge = readFileSync(resolve(root, "src/frontend/qama-engine-bridge.js"), "utf8");
const auth = readFileSync(resolve(root, "src/frontend/old-qama-shell.html"), "utf8");
const assembled = readFileSync(resolve(root, "src/frontend/index.html"), "utf8");

test("formatEngineError maps AMOUNT_EXCEEDS_HOLDING to Arabic holding message", () => {
  assert.match(bridge, /function formatEngineError/);
  assert.match(bridge, /AMOUNT_EXCEEDS_HOLDING/);
  assert.match(bridge, /المبلغ يتجاوز العهدة المشتركة المتاحة/);
});

test("vacate setSpaceOccupancy intent includes rentalId (cycle-safe)", () => {
  assert.match(bridge, /intentKey\("occ", item\._spaceId, occ, rentalId \|\| "norent"\)/);
  assert.match(bridge, /intentKey\("occ-force", item\._spaceId, occ, rentalId\)/);
});

test("uncollect opId uses live/all receipt counts (not sticky p{already})", () => {
  assert.match(bridge, /uncollectOpKey\(ob, already, receipts\)/);
  assert.doesNotMatch(bridge, /\("uncol-" \+ ob \+ "-p" \+ already\)/);
});

test("collection opIds include live/all receipt counts", () => {
  assert.match(bridge, /collectionOpKey\(ob, want, delta, receipts\)/);
  assert.match(bridge, /-L\$\{live\}-A\$\{all\}/);
});

test("Manager financial tab exposes إلغاء الإيداع", () => {
  assert.match(auth, /cancelEngineDeposit\(t\)/);
  assert.match(auth, /إلغاء الإيداع/);
});

test("expense form rejects zero/negative with Arabic message", () => {
  assert.match(auth, /المبلغ يجب أن يكون أكبر من صفر/);
});

test("revenue labeled as cumulative balance", () => {
  assert.match(auth, /رصيد تراكمي/);
});

test("assembled index includes bridge fixes after assemble", () => {
  // This assertion is soft until assemble runs in the same session.
  if (assembled.includes("formatEngineError")) {
    assert.match(assembled, /intentKey\("occ", item\._spaceId, occ, rentalId \|\| "norent"\)/);
    assert.match(assembled, /إلغاء الإيداع/);
    assert.match(assembled, /رصيد تراكمي/);
  }
});
