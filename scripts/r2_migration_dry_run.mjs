#!/usr/bin/env node
/**
 * R2 migration dry-run. Default is zero-write.
 * NEVER pass --write in this session. Production mutation is forbidden.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dryRunLegacyClassification } from "../functions/domain/legacy_evidence_classifier.mjs";

if (process.argv.includes("--write") || process.env.R2_MIGRATION_WRITE === "1") {
  console.error("R2_MIGRATION_WRITE_FORBIDDEN: dry-run only");
  process.exit(2);
}

const fixturePath = process.argv.find((a) => a.startsWith("--fixture="))?.slice(10);
const months = fixturePath
  ? JSON.parse(readFileSync(fixturePath, "utf8")).months || []
  : [{
    id: "fixture_2026_7",
    data: {
      units: [{ id: "u1", partitions: [
        { id: 1, rent: 1000, status: "late", paid_amount: 400, tenant: "A" },
        { id: 2, rent: 1000, status: "collected", paid_amount: 0, tenant: "B" },
      ] }],
      full: [],
      transactions: [{ id: "tx1", amount: 400 }],
    },
  }];

const result = dryRunLegacyClassification(months, { write: false });
mkdirSync(new URL("../artifacts", import.meta.url), { recursive: true });
const out = new URL("../artifacts/r2_migration_dry_run.json", import.meta.url);
writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), ...result }, null, 2));
console.log(JSON.stringify({ ok: true, write: false, totals: result.totals, out: "artifacts/r2_migration_dry_run.json" }));
