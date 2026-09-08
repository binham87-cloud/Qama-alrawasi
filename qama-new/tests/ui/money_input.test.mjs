import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseAedInputToFils } from "../../src/frontend/moneyInput.mjs";

test("parseAedInputToFils: integer AED", () => {
  assert.equal(parseAedInputToFils("9200"), 920000);
  assert.equal(parseAedInputToFils(9200), 920000);
});

test("parseAedInputToFils: one and two decimal places", () => {
  assert.equal(parseAedInputToFils("9200.2"), 920020);
  assert.equal(parseAedInputToFils("9200.20"), 920020);
});

test("parseAedInputToFils: rejects excess decimals", () => {
  assert.equal(parseAedInputToFils("9200.005"), null);
  assert.equal(parseAedInputToFils("9200.999"), null);
});

test("parseAedInputToFils: rejects negative", () => {
  assert.equal(parseAedInputToFils("-100"), null);
  assert.equal(parseAedInputToFils("-0.01"), null);
});

test("parseAedInputToFils: rejects NaN and Infinity", () => {
  assert.equal(parseAedInputToFils(NaN), null);
  assert.equal(parseAedInputToFils(Infinity), null);
  assert.equal(parseAedInputToFils("not-a-number"), null);
});

test("parseAedInputToFils: no float rounding path", () => {
  assert.equal(parseAedInputToFils("9200.20"), 920020);
  assert.equal(parseAedInputToFils("0.10"), 10);
  assert.equal(parseAedInputToFils("0.1"), 10);
  const floatPath = Math.round(0.1 * 100);
  assert.equal(floatPath, 10);
  assert.equal(parseAedInputToFils("9200.005"), null);
});

test("app.mjs does not use float money conversion", () => {
  const app = readFileSync(new URL("../../src/frontend/app.mjs", import.meta.url), "utf8");
  assert.equal(app.includes("Math.round(Number"), false);
  assert.equal(app.includes("* 100"), false);
  assert.ok(app.includes("parseAedInputToFils"));
});
