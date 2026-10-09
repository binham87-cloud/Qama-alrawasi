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

test("vacate occupancy opIds are cycle-safe", () => {
  // A live rental vacates through endTenancy keyed by rentalId, so a later cycle
  // cannot replay the previous close. Staff occupancy after close also includes rentalId.
  // setSpaceOccupancy("occ") runs only when there is no rental, and the key is norent.
  assert.match(bridge, /intentKey\("end-tenancy", rentalId, "retain"\)/);
  assert.match(bridge, /intentKey\("occ-staff", item\._spaceId, rentalId\)/);
  assert.match(bridge, /intentKey\("occ", item\._spaceId, occ, "norent"\)/);
  assert.doesNotMatch(bridge, /intentKey\("occ-force"/);
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
  assert.match(assembled, /formatEngineError/);
  assert.match(assembled, /intentKey\("end-tenancy", rentalId, "retain"\)/);
  assert.match(assembled, /intentKey\("occ-staff", item\._spaceId, rentalId\)/);
  assert.match(assembled, /intentKey\("occ", item\._spaceId, occ, "norent"\)/);
  assert.match(assembled, /إلغاء الإيداع/);
  assert.match(assembled, /رصيد تراكمي/);
});
