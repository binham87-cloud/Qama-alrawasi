/**
 * Physical-retest remaining fixes — SAFE, ID-scoped only.
 *
 * 1) Timestamped backup of business collections
 * 2) Classify receipts; archive proven TEST-only (operationalHidden)
 * 3) Repair MZ3 structure to clean-baseline: reactivate 1,5,8,10; deactivate invented 13-16
 *
 * Does NOT: zero-reset, purge, touch qama-alrawasi, delete ambiguous/real receipts.
 *
 *   node scripts/prod_physical_retest_repair.mjs --dry-run
 *   node scripts/prod_physical_retest_repair.mjs --apply
 */
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const APPLY = process.argv.includes("--apply");
const PROJECT = "qama-new-prod-2026";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").replace(/T/, "T").slice(0, 20) + "Z";
const BACKUP = resolve(ROOT, `artifacts/release/BACKUP-pre-physical-retest-${STAMP}`);

if (!getApps().length) initializeApp({ projectId: PROJECT });
const db = getFirestore();

const COLLECTIONS = [
  "receipts", "deposits", "expenses", "obligations", "rentals",
  "spaces", "units", "uiRequests", "accounts", "users", "auditEvents",
];

function classifyReceipt(r) {
  const tenant = String(r.tenantNameSnapshot || "");
  const note = String(r.note || "");
  const id = String(r.id || "");
  const ref = String(r.bankReference || "");
  const blob = `${id} ${tenant} ${note} ${ref}`;
  if (/STAFFREADY|BOT[\s_-]|CERT|TEMP-|ACC-|staff-(bank|cash|dep|ui)|cert-|dxmtn|rcmtn|iphone|ACCEPT/i.test(blob)) {
    return { cls: "TEST", why: "explicit test/cert/bot/staffready marker in id/tenant/note" };
  }
  if (r.state === "recognized" && /[\u0600-\u06FF]/.test(tenant) && tenant.trim().length >= 2) {
    return { cls: "REAL", why: "recognized cash/bank with Arabic tenant name" };
  }
  if (r.state === "reversed" && /[\u0600-\u06FF]/.test(tenant) && tenant.trim().length >= 2) {
    return { cls: "AMBIGUOUS", why: "reversed with Arabic tenant — leave unchanged" };
  }
  if (/^[A-Za-z0-9 ._-]{1,8}$/.test(tenant.trim()) && r.state === "reversed") {
    return { cls: "AMBIGUOUS", why: "short latin tenant reversed — leave unchanged" };
  }
  if (r.state === "recognized") return { cls: "REAL", why: "recognized without test markers" };
  return { cls: "AMBIGUOUS", why: "insufficient proof for test-only" };
}

async function dumpCollection(name) {
  const snap = await db.collection(name).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function backup() {
  mkdirSync(BACKUP, { recursive: true });
  mkdirSync(resolve(BACKUP, "data"), { recursive: true });
  const inventory = { at: new Date().toISOString(), project: PROJECT, collections: {} };
  for (const name of COLLECTIONS) {
    const rows = await dumpCollection(name);
    writeFileSync(resolve(BACKUP, "data", `${name}.json`), JSON.stringify(rows));
    inventory.collections[name] = { count: rows.length };
    console.log(`backup ${name}: ${rows.length}`);
  }
  writeFileSync(resolve(BACKUP, "INVENTORY.json"), JSON.stringify(inventory, null, 2));
  return inventory;
}

async function classifyAllReceipts() {
  const rows = await dumpCollection("receipts");
  const classified = rows.map((r) => {
    const c = classifyReceipt(r);
    return {
      id: r.id,
      amountAed: (r.amountFils || 0) / 100,
      date: r.collectionDate,
      state: r.state,
      method: r.method,
      collector: r.collectorUserId,
      tenant: r.tenantNameSnapshot,
      obligationId: r.obligationId,
      reversalId: r.reversedByReversalId || null,
      operationalHidden: r.operationalHidden === true,
      cls: c.cls,
      why: c.why,
    };
  });
  return classified;
}

async function archiveTestReceipts(classified) {
  const targets = classified.filter((r) => r.cls === "TEST" && !r.operationalHidden);
  const result = { archived: [], skippedAlreadyHidden: classified.filter((r) => r.cls === "TEST" && r.operationalHidden).map((r) => r.id) };
  for (const r of targets) {
    if (APPLY) {
      await db.collection("receipts").doc(r.id).set({
        operationalHidden: true,
        archivedOperational: true,
        archivedAt: new Date().toISOString(),
        archiveReason: "pre-staff TEST artifact — physical retest cleanup",
        archiveClass: "TEST",
        archiveWhy: r.why,
      }, { merge: true });
    }
    result.archived.push(r.id);
  }
  return result;
}

async function repairMz3() {
  const MZ3 = "mig:unit:unit:legacy:2d158626c4f7a1704daa3e07";
  const baselinePath = resolve(ROOT, "artifacts/clean-baseline-backup-2026-09-04T21-34-33-785Z/spaces.json");
  if (!existsSync(baselinePath)) throw new Error("missing clean baseline spaces snapshot");
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")).filter((s) => s.unitId === MZ3);
  const live = (await db.collection("spaces").where("unitId", "==", MZ3).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const partNum = (name) => {
    const m = String(name || "").match(/\/\s*(\d+)\s*$/);
    return m ? Number(m[1]) : null;
  };
  const baseActive = baseline.filter((s) => s.active !== false).map((s) => partNum(s.name)).filter((n) => n != null).sort((a, b) => a - b);
  const plan = {
    authoritativeActive: baseActive,
    reactivate: [],
    deactivateInvented: [],
    evidence: "clean-baseline-backup-2026-09-04T21-34-33-785Z spaces.json — MZ3 partitions 1-12 all active; no 13-16",
  };
  for (const sp of live) {
    const n = partNum(sp.name);
    if (n == null) continue;
    if (baseActive.includes(n) && sp.active === false) {
      plan.reactivate.push({ id: sp.id, n, name: sp.name });
    }
    if (!baseActive.includes(n) && sp.active !== false) {
      // Invented 13-16 — only BOT closed rental on 16; safe deactivate (no active business).
      plan.deactivateInvented.push({ id: sp.id, n, name: sp.name });
    }
  }
  if (APPLY) {
    for (const x of plan.reactivate) {
      await db.collection("spaces").doc(x.id).set({
        active: true,
        structureRepairedAt: new Date().toISOString(),
        structureRepairReason: "restore clean-baseline MZ3 partition",
      }, { merge: true });
    }
    for (const x of plan.deactivateInvented) {
      await db.collection("spaces").doc(x.id).set({
        active: false,
        structureRepairedAt: new Date().toISOString(),
        structureRepairReason: "deactivate invented test partition not in clean-baseline",
      }, { merge: true });
    }
  }
  return plan;
}

const inventory = await backup();
const classified = await classifyAllReceipts();
writeFileSync(resolve(BACKUP, "receipt-classification.json"), JSON.stringify(classified, null, 2));
const archive = await archiveTestReceipts(classified);
const mz3 = await repairMz3();

const report = {
  at: new Date().toISOString(),
  apply: APPLY,
  backup: BACKUP,
  inventory,
  receipts: {
    total: classified.length,
    test: classified.filter((r) => r.cls === "TEST").length,
    real: classified.filter((r) => r.cls === "REAL").length,
    ambiguous: classified.filter((r) => r.cls === "AMBIGUOUS").length,
    provenTestIds: classified.filter((r) => r.cls === "TEST").map((r) => r.id),
    ambiguousIds: classified.filter((r) => r.cls === "AMBIGUOUS").map((r) => r.id),
    archivedNow: archive.archived,
    alreadyHidden: archive.skippedAlreadyHidden,
  },
  mz3,
};
writeFileSync(resolve(BACKUP, "REPAIR-PLAN.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  apply: APPLY,
  backup: BACKUP,
  testReceipts: report.receipts.test,
  archived: archive.archived.length,
  ambiguousLeft: report.receipts.ambiguous,
  mz3Reactivate: mz3.reactivate.map((x) => x.n),
  mz3Deactivate: mz3.deactivateInvented.map((x) => x.n),
}, null, 2));
if (!APPLY) console.log("DRY RUN only — re-run with --apply to mutate.");
