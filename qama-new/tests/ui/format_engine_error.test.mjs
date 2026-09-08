/**
 * Evaluate formatEngineError from the bridge source in Node (no Firebase).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const bridge = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../src/frontend/qama-engine-bridge.js"),
  "utf8"
);
const start = bridge.indexOf("function formatEngineError");
const end = bridge.indexOf("\nfunction periodOfMonth");
assert.ok(start > 0 && end > start);
const fnSrc = bridge.slice(start, end);
const ctx = {};
vm.runInNewContext(fnSrc + "\nthis.formatEngineError = formatEngineError;", ctx);
const formatEngineError = ctx.formatEngineError;

test("AMOUNT_EXCEEDS_HOLDING uses details figures", () => {
  const msg = formatEngineError({
    message: "AMOUNT_EXCEEDS_HOLDING",
    details: { holdingFils: 5000, attemptedFils: 10000 },
  });
  assert.match(msg, /العهدة المشتركة/);
  assert.match(msg, /100/);
  assert.match(msg, /50/);
});

test("CUSTODY_RECONCILIATION_ERROR is NOT mapped as exceeds holding", () => {
  const msg = formatEngineError({
    message: "CUSTODY_RECONCILIATION_ERROR",
    details: { holdingFils: -1000 },
  });
  assert.match(msg, /مطابقة العهدة/);
  assert.doesNotMatch(msg, /يتجاوز العهدة/);
});

test("RECEIPT_ALREADY_DEPOSITED explains deposit-first", () => {
  const msg = formatEngineError({ message: "RECEIPT_ALREADY_DEPOSITED", details: {} });
  assert.match(msg, /إيداع معتمد/);
});
