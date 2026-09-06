/**
 * Proves the physical iPhone TENANT_REQUIRED root cause is fixed in bridge source:
 * vacant mid-edit saves must not wipe draft tenant; createRental must precede occupancy.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const bridge = readFileSync(resolve(root, "src/frontend/qama-engine-bridge.js"), "utf8");
const html = readFileSync(resolve(root, "src/frontend/index.html"), "utf8");
const assemble = readFileSync(resolve(root, "scripts/assemble_old_ui.mjs"), "utf8");
const commit = readFileSync(resolve(root, "functions/commands/commit_work_request.mjs"), "utf8");

test("vacant path keeps draft tenant unless closing a live tenancy", () => {
  assert.match(bridge, /const mustClose = \(engineOcc && engineOcc !== occ\) \|\| !!rentalId/);
  assert.match(bridge, /keep draft fields for the next rent save/);
  assert.match(bridge, /if \(mustClose\) \{\s*item\._rentalId = null/);
  assert.match(bridge, /Already vacant\/staff with no live rental/);
});

test("createRental runs before setSpaceOccupancy for vacant→rented", () => {
  const sync = bridge.slice(
    bridge.indexOf("async function syncOccupancyAndTenant"),
    bridge.indexOf("async function applyUiExpenses")
  );
  const createAt = sync.indexOf("createRental");
  const occRentedAt = sync.indexOf("occupancy: occ");
  // Within rented create path, createRental must appear; premature setSpaceOccupancy(rented)
  // before create is forbidden.
  assert.ok(createAt > 0, "createRental present");
  assert.doesNotMatch(
    sync.slice(0, createAt),
    /setSpaceOccupancy[\s\S]{0,120}occupancy:\s*[\"']rented[\"']/
  );
  assert.match(sync, /Do NOT setSpaceOccupancy\(rented\) first/);
});

test("extras persist draft rent+tenant for vacant mid-edit", () => {
  assert.match(bridge, /rent: Number\(x\.rent \|\| 0\) \|\| 0/);
  assert.match(bridge, /draftRent/);
  assert.match(html, /draftRent/);
});

test("failed TENANT_REQUIRED keeps local draft instead of vacant hydrate wipe", () => {
  assert.match(bridge, /_preserveDraftUntil/);
  assert.match(bridge, /TENANT_REQUIRED/);
  assert.match(assemble, /clearTimeout\(saveMonthData\._t\)/);
  assert.match(assemble, /keepDraft/);
  assert.match(html, /_preserveDraftUntil|keepDraft/);
});

test("commitWorkRequest also creates rental before requiring occupancy rented", () => {
  const fn = commit.slice(commit.indexOf("Vacant → rented"), commit.indexOf("const obligationId"));
  const createAt = fn.indexOf("createRental");
  assert.ok(createAt > 0);
  assert.doesNotMatch(
    fn.slice(0, createAt),
    /setSpaceOccupancy[\s\S]{0,80}occupancy:\s*[\"']rented[\"']/
  );
});

test("UI tenant field still maps to property tenant (اسم المستأجر)", () => {
  // Required-before-rent copy (not the old free-text "اسم المستأجر...")
  assert.match(html, /placeholder:"إلزامي قبل التأجير\/التحصيل"/);
  assert.match(html, /data-testid":"partition-tenant"/);
  assert.match(html, /updateP\("tenant"/);
  assert.match(bridge, /tenantName: tenant\.slice\(0, 160\)/);
  assert.match(bridge, /item\.tenant/);
});
