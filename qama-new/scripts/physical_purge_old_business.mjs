/**
 * Physically DELETE pre-baseline / discarded business docs from qama-new-prod-2026.
 * Backup is the only historical copy. NEVER touches qama-alrawasi.
 *
 * Modes: --dry-run (default) | --apply | --verify
 */
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";

const PROJECT = "qama-new-prod-2026";
const FORBIDDEN = "qama-alrawasi";
const BACKUP = "/workspaces/Qama-alrawasi/qama-new/artifacts/clean-baseline-backup-2026-09-04T21-34-33-785Z";
const TAG = "sep-2026-clean-baseline";
const MODE = process.argv.includes("--apply") ? "apply"
  : process.argv.includes("--verify") ? "verify" : "dry-run";

if (PROJECT === FORBIDDEN) process.exit(1);
const adc = `${process.env.HOME}/.config/firebase/binham87_gmail_com_application_default_credentials.json`;
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && existsSync(adc)) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = adc;
}
if (!getApps().length) initializeApp({ projectId: PROJECT });
const db = getFirestore();
if (getApps()[0].options.projectId !== PROJECT) {
  console.error("PROJECT MISMATCH");
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = `/workspaces/Qama-alrawasi/qama-new/artifacts/physical-purge-${MODE}-${stamp}`;
mkdirSync(outDir, { recursive: true });

function backupOk() {
  if (!existsSync(BACKUP)) return { ok: false, reason: "missing" };
  const meta = JSON.parse(readFileSync(`${BACKUP}/BACKUP_META.json`, "utf8"));
  const files = readdirSync(BACKUP);
  const required = ["rentals.json", "obligations.json", "receipts.json", "deposits.json", "expenses.json", "users.json", "units.json", "spaces.json"];
  for (const f of required) {
    if (!files.includes(f)) return { ok: false, reason: `missing ${f}` };
    JSON.parse(readFileSync(`${BACKUP}/${f}`, "utf8"));
  }
  return { ok: true, meta, fileCount: files.length };
}

async function listAll(col) {
  return (await db.collection(col).get()).docs.map((d) => ({ id: d.id, ref: d.ref, ...d.data() }));
}

function isExcluded(d) {
  return d.baselineExcluded === true || d.baselineTag === TAG;
}

/** Business docs safe to hard-delete (not structure/auth). */
function shouldDelete(col, d) {
  if (isExcluded(d)) return { delete: true, reason: "baselineExcluded/tag" };

  // Post-clean acceptance leftovers and any non-live business residue
  if (col === "rentals") {
    // Clean baseline: no historical rentals remain in production.
    return { delete: true, reason: `rental purge state=${d.state || "n/a"}` };
  }
  if (col === "obligations") {
    // Clean baseline: no historical obligations remain in production.
    return { delete: true, reason: `obligation purge state=${d.state || "n/a"}` };
  }
  if (col === "receipts") {
    return { delete: true, reason: `receipt purge state=${d.state || "n/a"}` };
  }
  if (col === "deposits") {
    return { delete: true, reason: `deposit purge state=${d.state || "n/a"}` };
  }
  if (col === "expenses") {
    return { delete: true, reason: `expense purge state=${d.state || "n/a"}` };
  }
  if (col === "reversals") return { delete: true, reason: "old/reversal business history" };
  if (col === "ledgerEntries") return { delete: true, reason: "old ledger business history" };
  if (col === "uiRequests") {
    if (d.status !== "pending" && d.status !== "processing") return { delete: true, reason: `request status=${d.status}` };
    // reject leftover pending from tests
    if (String(d.id || "").includes("cleanacc_") || String(d.id || "").includes("req_cleanacc")) {
      return { delete: true, reason: "acceptance residue request" };
    }
  }
  return { delete: false };
}

async function plan() {
  const cols = [
    "rentals", "obligations", "receipts", "deposits", "expenses",
    "reversals", "ledgerEntries", "uiRequests",
  ];
  const plan = { before: {}, delete: {}, keep: {}, deleteIds: {} };
  for (const c of cols) {
    const rows = await listAll(c);
    plan.before[c] = rows.length;
    plan.deleteIds[c] = [];
    let del = 0; let keep = 0;
    for (const r of rows) {
      const d = shouldDelete(c, r);
      if (d.delete) {
        del++;
        plan.deleteIds[c].push({ id: r.id, reason: d.reason });
      } else keep++;
    }
    plan.delete[c] = del;
    plan.keep[c] = keep;
  }

  // tenants: no collection — count unique tenantName on rentals being deleted
  const rentals = await listAll("rentals");
  const tenantNames = new Set(rentals.map((r) => String(r.tenantName || "").trim()).filter(Boolean));
  plan.tenants = {
    collectionExists: false,
    uniqueTenantNamesOnRentalsBefore: tenantNames.size,
    note: "No tenants collection; tenant business data lives on rental docs only",
  };

  // Optional: migration / archive business dumps
  for (const c of ["migrationAudit", "migrationRuns", "opsArchives", "months"]) {
    try {
      const rows = await listAll(c);
      plan.before[c] = rows.length;
      plan.deleteIds[c] = rows.map((r) => ({ id: r.id, reason: "migration/archive business dump" }));
      plan.delete[c] = rows.length;
      plan.keep[c] = 0;
    } catch {
      plan.before[c] = 0;
      plan.delete[c] = 0;
      plan.keep[c] = 0;
      plan.deleteIds[c] = [];
    }
  }

  // Preserve counts
  plan.preserve = {
    users: (await listAll("users")).length,
    properties: (await listAll("properties")).length,
    unitsActive: (await listAll("units")).filter((u) => u.active !== false).length,
    unitsTotal: (await listAll("units")).length,
    spacesActive: (await listAll("spaces")).filter((s) => s.active !== false).length,
    spacesTotal: (await listAll("spaces")).length,
    accounts: (await listAll("accounts")).length,
    uiConfig: (await listAll("uiConfig")).length,
  };

  return plan;
}

async function applyDeletes(plan) {
  let deleted = 0;
  const log = {};
  for (const [col, rows] of Object.entries(plan.deleteIds)) {
    log[col] = 0;
    for (let i = 0; i < rows.length; i += 400) {
      const chunk = rows.slice(i, i + 400);
      const batch = db.batch();
      for (const r of chunk) batch.delete(db.collection(col).doc(r.id));
      await batch.commit();
      log[col] += chunk.length;
      deleted += chunk.length;
    }
  }
  return { deleted, log };
}

async function afterCounts() {
  const cols = [
    "rentals", "obligations", "receipts", "deposits", "expenses",
    "reversals", "ledgerEntries", "uiRequests", "tenants",
    "migrationAudit", "migrationRuns", "opsArchives",
  ];
  const out = {};
  for (const c of cols) {
    try { out[c] = (await db.collection(c).get()).size; } catch { out[c] = 0; }
  }
  out.baselineExcludedRemaining = 0;
  for (const c of ["rentals", "obligations", "receipts", "deposits", "expenses", "reversals", "ledgerEntries", "uiRequests"]) {
    const snap = await db.collection(c).get();
    out.baselineExcludedRemaining += snap.docs.filter((d) => d.data().baselineExcluded === true).length;
  }
  out.users = (await db.collection("users").get()).size;
  out.unitsActive = (await db.collection("units").get()).docs.filter((d) => d.data().active !== false).length;
  out.spacesActive = (await db.collection("spaces").get()).docs.filter((d) => d.data().active !== false).length;
  return out;
}

const bak = backupOk();
console.log("BACKUP_VERIFIED", bak.ok, bak.ok ? { files: bak.fileCount, ts: bak.meta.timestamp } : bak);

if (!bak.ok) {
  console.error("REFUSE: backup not verified");
  process.exit(1);
}

if (MODE === "verify") {
  const after = await afterCounts();
  writeFileSync(`${outDir}/verify.json`, JSON.stringify(after, null, 2));
  console.log(JSON.stringify(after, null, 2));
  process.exit(after.baselineExcludedRemaining === 0 ? 0 : 2);
}

const p = await plan();
writeFileSync(`${outDir}/plan.json`, JSON.stringify({
  project: PROJECT, mode: MODE, backup: BACKUP,
  before: p.before, delete: p.delete, keep: p.keep, preserve: p.preserve, tenants: p.tenants,
  deleteSample: Object.fromEntries(Object.entries(p.deleteIds).map(([k, v]) => [k, v.slice(0, 5)])),
}, null, 2));
writeFileSync(`${outDir}/plan-full-ids.json`, JSON.stringify(p.deleteIds, null, 2));

console.log(JSON.stringify({
  mode: MODE, project: PROJECT, backupVerified: true,
  before: p.before, willDelete: p.delete, willKeepLive: p.keep, preserve: p.preserve, tenants: p.tenants,
}, null, 2));

if (MODE === "dry-run") {
  console.log("DRY_RUN_COMPLETE");
  process.exit(0);
}

// Safety: must preserve structure
if (p.preserve.users < 3 || p.preserve.unitsActive < 1 || p.preserve.spacesActive < 1) {
  console.error("REFUSE: structure/users insufficient");
  process.exit(1);
}

const applied = await applyDeletes(p);
const after = await afterCounts();
writeFileSync(`${outDir}/apply.json`, JSON.stringify({ applied, after }, null, 2));
console.log("APPLY_COMPLETE", JSON.stringify({ applied, after }, null, 2));
process.exit(after.baselineExcludedRemaining === 0 ? 0 : 2);
