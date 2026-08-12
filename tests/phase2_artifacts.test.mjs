import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

test("build identity is explicit and both local hosting sources are identical", () => {
  const a = fs.readFileSync("index.html", "utf8");
  const b = fs.readFileSync("public/index.html", "utf8");
  assert.equal(a, b);
  assert.match(a, /qama-build-id" content="qama-phase3d-employee-rental-entry-2026-08-12\.4"/);
  assert.equal(sha("index.html"), sha("public/index.html"));
});

test("legacy migration analyzer performs zero writes and has no unexplained delta", () => {
  // Reproducible, deterministic and sanitized. The sensitive Production export
  // is intentionally not a test dependency and is never distributed.
  const input = "tests/fixtures/migration-sanitized-614.json";
  const output = execFileSync(process.execPath, ["scripts/canonical_migration_dry_run.mjs", input], { encoding: "utf8" });
  const report = JSON.parse(output);
  assert.equal(report.documentCount, 614);
  assert.equal(report.writesPerformed, 0);
  assert.equal(report.simulatedPreservation.status, "PASS_ZERO_WRITE_DRY_RUN");
  assert.deepEqual(report.simulatedPreservation.deltas, { documents: 0, target: 0, collected: 0, custody: 0, balances: 0, relevantMonthTotals: 0 });
  assert.deepEqual(report.classification, { VERIFIED: 7, PARTIALLY_VERIFIED: 138, UNVERIFIED: 371, REQUIRES_HUMAN_DECISION: 0 });
  assert.deepEqual(report.reasonsByConfidence.UNVERIFIED, { missing_amount: 198, missing_payment_method: 168, missing_collector: 5 });
  assert.deepEqual(report.reasonsByConfidence.PARTIALLY_VERIFIED, { missing_cash_lineage: 135, missing_deposit_linkage: 3 });
});
