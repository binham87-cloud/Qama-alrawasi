import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const forbiddenPaths = [
  ".netlify", "netlify.toml", "firestore-debug.log",
  "scripts/add_mizan1_full_unit.mjs", "scripts/audit_july_custody_live.mjs",
  "scripts/classify_north_ocean_advance.mjs", "scripts/close_legacy_custody.mjs",
  "scripts/remove_july_104_deposit.mjs", "scripts/reopen_july_custody.mjs",
  "scripts/provision_pin_users_from_legacy.mjs", "scripts/phase2_readonly_audit.mjs",
  "scripts/migrate_financial_v11.mjs", "scripts/import_legacy_export.mjs"
];

test("CH01 superseded deployment and direct-Legacy mutation artifacts stay absent", () => {
  for (const path of forbiddenPaths) assert.equal(fs.existsSync(path), false, path);
});

test("CH02 Firebase runtime entry points resolve and Hosting sources remain identical", () => {
  const config = JSON.parse(fs.readFileSync("firebase.json", "utf8"));
  const functionsPackage = JSON.parse(fs.readFileSync(`${config.functions.source}/package.json`, "utf8"));
  for (const path of [
    `${config.functions.source}/${functionsPackage.main}`,
    config.firestore.rules,
    config.firestore.indexes,
    `${config.hosting.public}/index.html`
  ]) assert.equal(fs.existsSync(path), true, path);
  assert.equal(fs.readFileSync("index.html", "utf8"), fs.readFileSync("public/index.html", "utf8"));
});

test("CH03 cycle identity resolves via financialCommand, never a client cycles collection", () => {
  const html = fs.readFileSync("public/index.html", "utf8");
  assert.match(html, /ensureCompatibleCycle/);
  assert.match(html, /legacyCollectionPayload/);
  assert.doesNotMatch(html, /collection\(db,\s*"cycles"\)/);
  assert.doesNotMatch(html, /collection\(db,"rentalCycles"\)/);
});

test("CH04 removed migration/import commands cannot return through package scripts", () => {
  const scripts = JSON.parse(fs.readFileSync("package.json", "utf8")).scripts || {};
  const text = JSON.stringify(scripts);
  for (const forbidden of ["migrate_financial_v11", "import_legacy_export", "migrate:apply", "legacy:import-apply"])
    assert.equal(text.includes(forbidden), false, forbidden);
});
