#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, copyFileSync, cpSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const build = "qama-unified-final-2026-08-14.6-rc1";
const stamp = new Date().toISOString();
const outDir = path.join(root, "artifacts", "release", "qama-r2-2026-08-14.6-rc1");
const archivePath = path.join(root, "artifacts", "release", "qama-r2-2026-08-14.6-rc1.tar.gz");

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

mkdirSync(outDir, { recursive: true });
const copies = [
  ["public/index.html", "hosting/index.html"],
  ["index.html", "hosting/index.root.html"],
  ["firestore-v11.rules", "firestore-v11.rules"],
  ["firestore.indexes.json", "firestore.indexes.json"],
  ["firebase.json", "firebase.json"],
  ["package.json", "package.json"],
  ["package-lock.json", "package-lock.json"],
  ["functions/package.json", "functions/package.json"],
  ["functions/index.mjs", "functions/index.mjs"],
  ["scripts/r2_migration_dry_run.mjs", "scripts/r2_migration_dry_run.mjs"],
  ["artifacts/r2_canonical_definitions.json", "artifacts/r2_canonical_definitions.json"],
  ["artifacts/r2_financial_path_inventory.json", "artifacts/r2_financial_path_inventory.json"],
  ["artifacts/r2_month_field_authority.json", "artifacts/r2_month_field_authority.json"],
  ["artifacts/r2_request_authorization_matrix.json", "artifacts/r2_request_authorization_matrix.json"],
  ["artifacts/r2_migration_dry_run.json", "artifacts/r2_migration_dry_run.json"],
  ["artifacts/hat/r2_financial_hat.json", "artifacts/hat/r2_financial_hat.json"],
  ["artifacts/hat/r1_3_pre_r2_hat.json", "artifacts/hat/r1_3_pre_r2_hat.json"],
  ["artifacts/release/DEPLOYMENT_RUNBOOK.md", "DEPLOYMENT_RUNBOOK.md"],
  ["artifacts/release/ROLLBACK.md", "ROLLBACK.md"],
];
for (const [src, dest] of copies) {
  const to = path.join(outDir, dest);
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(path.join(root, src), to);
}
cpSync(path.join(root, "functions"), path.join(outDir, "functions"), {
  recursive: true,
  filter: (src) => !src.includes("node_modules"),
});

const fileList = execSync(`find "${outDir}" -type f | sort`, { encoding: "utf8" }).trim().split("\n").filter(Boolean);
const files = fileList.map((abs) => ({
  path: path.relative(outDir, abs),
  sha256: sha256File(abs),
  bytes: readFileSync(abs).length,
}));

let gitCommit = "WORKING_TREE";
try { gitCommit = execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim(); } catch {}

const manifest = {
  releaseId: build,
  branch: "recovery/qama-prod-2026-08-13.6",
  gitCommit,
  createdAt: stamp,
  productionMutation: false,
  migrationWrite: false,
  deploymentOrder: ["firestore:rules", "firestore:indexes", "functions", "hosting"],
  rollbackReference: "artifacts/release/ROLLBACK.md",
  productionPrerequisites: ["PIN authPins intact", "Firestore export/backup", "Owner-authorized deploy window"],
  testsNote: "See artifacts/r2_verification_report.json after gate run",
  files,
};
writeFileSync(path.join(outDir, "MANIFEST.json"), JSON.stringify(manifest, null, 2));
writeFileSync(path.join(root, "artifacts/r2_release_manifest.json"), JSON.stringify(manifest, null, 2));

execSync(`tar -C "${path.dirname(outDir)}" -czf "${archivePath}" "${path.basename(outDir)}"`);
const archiveSha = sha256File(archivePath);
const verify = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
if (verify !== archiveSha) throw new Error("ARCHIVE_HASH_MISMATCH");
const listing = execSync(`tar -tzf "${archivePath}" | wc -l`, { encoding: "utf8" }).trim();

const integrity = {
  archive: path.relative(root, archivePath),
  archiveSha256: archiveSha,
  fileCount: Number(listing),
  manifestSha256: sha256File(path.join(root, "artifacts/r2_release_manifest.json")),
  runbookSha256: sha256File(path.join(root, "artifacts/release/DEPLOYMENT_RUNBOOK.md")),
  rollbackSha256: sha256File(path.join(root, "artifacts/release/ROLLBACK.md")),
  hostingIndexSha256: sha256File(path.join(root, "public/index.html")),
  rulesSha256: sha256File(path.join(root, "firestore-v11.rules")),
};
writeFileSync(path.join(root, "artifacts/r2_archive_integrity.json"), JSON.stringify(integrity, null, 2));
console.log(JSON.stringify({ ok: true, ...integrity }, null, 2));
