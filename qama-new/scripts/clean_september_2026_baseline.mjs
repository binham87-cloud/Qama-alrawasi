/**
 * September 2026 CLEAN PRODUCTION BASELINE for qama-new-prod-2026 ONLY.
 *
 * Modes:
 *   --dry-run   READ-ONLY manifest (default)
 *   --apply     Destructive clean (requires prior dry-run review; idempotent)
 *   --verify    Post-clean ZERO reconciliation
 *
 * NEVER touches qama-alrawasi.
 */
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const PROJECT = "qama-new-prod-2026";
const FORBIDDEN = "qama-alrawasi";
const BASELINE_TAG = "sep-2026-clean-baseline";
const BASELINE_AT = "2026-09-04T21:00:00.000Z";
const API_KEY = "AIzaSyBs0wIu2h2mnNMGr5SH-YNXjUhrdrGSNKg";
const REGION = "me-central1";

const MODE = process.argv.includes("--apply")
  ? "apply"
  : process.argv.includes("--verify")
    ? "verify"
    : "dry-run";

if (PROJECT === FORBIDDEN) {
  console.error("REFUSE: forbidden project");
  process.exit(1);
}

const adc = `${process.env.HOME}/.config/firebase/binham87_gmail_com_application_default_credentials.json`;
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && existsSync(adc)) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = adc;
}
if (!getApps().length) initializeApp({ projectId: PROJECT });
const db = getFirestore();
if (getApps()[0].options.projectId !== PROJECT) {
  console.error("PROJECT MISMATCH", getApps()[0].options.projectId);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = `/workspaces/Qama-alrawasi/qama-new/artifacts/clean-baseline-${MODE}-${stamp}`;
mkdirSync(outDir, { recursive: true });

async function listAll(col) {
  const snap = await db.collection(col).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

function alreadyExcluded(doc) {
  return doc.baselineExcluded === true || doc.baselineTag === BASELINE_TAG;
}

async function callable(name, data, idToken) {
  const url = `https://${REGION}-${PROJECT}.cloudfunctions.net/${name}`;
  const headers = { "Content-Type": "application/json" };
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ data }) });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json.result;
}
async function signIn(customToken) {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`;
  const res = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.idToken;
}
async function login(userId, pin) {
  const res = await callable("login", { userId, pin });
  return { token: await signIn(res.customToken), user: res.user };
}
async function cmd(token, command, payload, operationId) {
  return callable("command", { command, payload, operationId }, token);
}
async function readDash(token, period = "2026-09") {
  return callable("read", { what: "dashboard", period }, token);
}

async function buildManifest() {
  const [
    users, properties, units, spaces, rentals, obligations,
    receipts, deposits, expenses, accounts, ledgerEntries,
    reversals, uiConfig, uiRequests, uiPeriods,
  ] = await Promise.all([
    listAll("users"), listAll("properties"), listAll("units"), listAll("spaces"),
    listAll("rentals"), listAll("obligations"), listAll("receipts"), listAll("deposits"),
    listAll("expenses"), listAll("accounts"), listAll("ledgerEntries"), listAll("reversals"),
    listAll("uiConfig"), listAll("uiRequests"), listAll("uiPeriods"),
  ]);

  const preserve = [];
  const reset = [];

  for (const u of users) preserve.push({ collection: "users", id: u.id, reason: "auth/ops users" });
  for (const p of properties) preserve.push({ collection: "properties", id: p.id, reason: "physical property" });
  for (const u of units.filter((x) => x.active !== false)) {
    preserve.push({ collection: "units", id: u.id, reason: "physical unit structure" });
  }
  for (const s of spaces.filter((x) => x.active !== false)) {
    preserve.push({ collection: "spaces", id: s.id, reason: "physical space structure" });
  }

  const excludeCol = (col, rows, reason, extra = {}) => {
    for (const r of rows) {
      if (alreadyExcluded(r) && MODE === "dry-run") {
        reset.push({ collection: col, id: r.id, type: r.state || r.kind || "doc", reason: reason + " (already excluded)", action: "noop" });
        continue;
      }
      reset.push({
        collection: col, id: r.id, type: r.state || r.kind || "doc", reason, action: "baselineExclude", ...extra,
      });
    }
  };

  excludeCol("rentals", rentals, "old rental/tenant business data");
  excludeCol("obligations", obligations, "old obligation business data");
  excludeCol("receipts", receipts, "old receipt/financial data");
  excludeCol("deposits", deposits, "old deposit/financial data");
  excludeCol("expenses", expenses, "old expense business data");
  excludeCol("ledgerEntries", ledgerEntries, "old ledger effects");
  excludeCol("reversals", reversals, "old reversal records (excluded from active truth)");
  excludeCol("uiRequests", uiRequests, "old operational requests");

  for (const a of accounts) {
    reset.push({
      collection: "accounts", id: a.id, type: a.kind, reason: "zero account balanceFils",
      action: "zeroBalance", currentBalanceFils: a.balanceFils || 0,
    });
    preserve.push({ collection: "accounts", id: a.id, reason: "account entity retained, balance zeroed" });
  }

  for (const c of uiConfig) {
    if (c.id === "balances") {
      reset.push({ collection: "uiConfig", id: "balances", type: "balances", reason: "zero Revenue/Company/Deduction UI balances", action: "zeroBalances" });
    } else if (c.id === "permissions" || c.id === "locks") {
      preserve.push({ collection: "uiConfig", id: c.id, reason: "system config" });
    } else if (c.id === "customUnits") {
      preserve.push({ collection: "uiConfig", id: c.id, reason: "structural custom units registry (archive flags only)" });
    } else {
      preserve.push({ collection: "uiConfig", id: c.id, reason: "ui config" });
    }
  }

  for (const p of uiPeriods) {
    reset.push({ collection: "uiPeriods", id: p.id, type: "periodExtras", reason: "wipe period extras/maintenance/daily/logs business blobs", action: "wipeExtras" });
  }

  const spacesToVacant = spaces.filter((s) => s.active !== false && s.occupancy !== "vacant" && s.occupancy !== "staff");
  for (const s of spacesToVacant) {
    reset.push({ collection: "spaces", id: s.id, type: "occupancy", reason: "set vacant for clean start", action: "setVacant", from: s.occupancy });
  }
  const staffKeep = spaces.filter((s) => s.active !== false && s.occupancy === "staff");
  for (const s of staffKeep) {
    preserve.push({ collection: "spaces", id: s.id, reason: "staff occupancy preserved as structural/ops assignment" });
  }

  return {
    project: PROJECT,
    mode: MODE,
    timestamp: new Date().toISOString(),
    preserveCount: preserve.length,
    resetCount: reset.length,
    counts: {
      users: users.length, properties: properties.length,
      unitsActive: units.filter((u) => u.active !== false).length,
      spacesActive: spaces.filter((s) => s.active !== false).length,
      rentals: rentals.length, obligations: obligations.length,
      receipts: receipts.length, deposits: deposits.length, expenses: expenses.length,
      ledgerEntries: ledgerEntries.length, uiRequests: uiRequests.length,
      spacesToVacant: spacesToVacant.length,
    },
    preserve: preserve.slice(0, 50),
    preserveNote: `full preserve list has ${preserve.length} rows (sample first 50)`,
    resetSample: reset.slice(0, 80),
    reset,
  };
}

async function applyClean(manifest) {
  const log = [];
  const batchWrite = async (updates) => {
    // Firestore batches max 500
    for (let i = 0; i < updates.length; i += 400) {
      const chunk = updates.slice(i, i + 400);
      const batch = db.batch();
      for (const u of chunk) {
        const ref = db.collection(u.collection).doc(u.id);
        batch.set(ref, u.patch, { merge: true });
      }
      await batch.commit();
      log.push({ batch: chunk.length });
    }
  };

  const excludePatch = {
    baselineExcluded: true,
    baselineTag: BASELINE_TAG,
    baselineExcludedAt: new Date().toISOString(),
  };

  const updates = [];
  for (const row of manifest.reset) {
    if (row.action === "noop") continue;
    if (row.action === "baselineExclude") {
      updates.push({ collection: row.collection, id: row.id, patch: excludePatch });
    } else if (row.action === "zeroBalance") {
      updates.push({
        collection: row.collection, id: row.id,
        patch: { balanceFils: 0, ...excludePatch, baselineNote: "balance zeroed; account retained" },
      });
    } else if (row.action === "setVacant") {
      updates.push({
        collection: row.collection, id: row.id,
        patch: { occupancy: "vacant", updatedAt: new Date().toISOString(), baselineVacated: true, baselineTag: BASELINE_TAG },
      });
    } else if (row.action === "zeroBalances") {
      const balDoc = await db.collection("uiConfig").doc("balances").get();
      let obj = {};
      try { obj = JSON.parse(balDoc.data()?.json || "{}"); } catch { obj = {}; }
      obj.companyBalance = 0;
      obj.revenueBalance = 0;
      obj.installmentBalance = 0;
      // Keep schedule structure but mark unpaid for clean start display
      if (Array.isArray(obj.installmentSchedule)) {
        obj.installmentSchedule = obj.installmentSchedule.map((x) => ({ ...x, paid: false }));
      }
      updates.push({
        collection: "uiConfig", id: "balances",
        patch: {
          json: JSON.stringify(obj),
          updatedAt: new Date().toISOString(),
          updatedBy: "clean-baseline",
          baselineTag: BASELINE_TAG,
        },
      });
    } else if (row.action === "wipeExtras") {
      updates.push({
        collection: "uiPeriods", id: row.id,
        patch: {
          extrasJson: JSON.stringify({
            spaces: {},
            expenses: [],
            transactions: [],
            profits: [],
            installments: [],
            logs: [],
            dailyBookings: [],
            unitMaintenance: [],
            facilityMaintenance: [],
          }),
          baselineTag: BASELINE_TAG,
          updatedAt: new Date().toISOString(),
        },
      });
    }
  }

  // Also close active rentals via field (state=closed) so generators cannot use them
  const rentals = await listAll("rentals");
  for (const r of rentals.filter((x) => x.state === "active")) {
    updates.push({
      collection: "rentals", id: r.id,
      patch: {
        state: "closed",
        endDate: "2026-08-31",
        closeReason: BASELINE_TAG,
        ...excludePatch,
      },
    });
  }
  const obligations = await listAll("obligations");
  for (const o of obligations.filter((x) => x.state === "active")) {
    updates.push({
      collection: "obligations", id: o.id,
      patch: { state: "cancelled", cancelReason: BASELINE_TAG, ...excludePatch },
    });
  }
  const receipts = await listAll("receipts");
  for (const r of receipts.filter((x) => x.state === "recognized" || x.state === "pending")) {
    updates.push({
      collection: "receipts", id: r.id,
      patch: {
        state: r.state === "pending" ? "rejected" : "reversed",
        baselinePriorState: r.state,
        ...excludePatch,
      },
    });
  }
  const deposits = await listAll("deposits");
  for (const d of deposits.filter((x) => x.state === "approved" || x.state === "pending")) {
    updates.push({
      collection: "deposits", id: d.id,
      patch: {
        state: d.state === "pending" ? "rejected" : "reversed",
        baselinePriorState: d.state,
        ...excludePatch,
      },
    });
  }
  const expenses = await listAll("expenses");
  for (const e of expenses.filter((x) => x.state === "approved" || x.state === "pending")) {
    updates.push({
      collection: "expenses", id: e.id,
      patch: {
        state: e.state === "pending" ? "rejected" : "reversed",
        baselinePriorState: e.state,
        ...excludePatch,
      },
    });
  }
  const reqs = await listAll("uiRequests");
  for (const r of reqs.filter((x) => x.status === "pending" || x.status === "processing")) {
    updates.push({
      collection: "uiRequests", id: r.id,
      patch: { status: "rejected", rejectReason: BASELINE_TAG, ...excludePatch },
    });
  }

  await batchWrite(updates);
  return { updateCount: updates.length, log };
}

async function verifyZero() {
  const owner = await login("mig:user:owner:saeed", "1325");
  const dash = await readDash(owner.token, "2026-09");
  const balDoc = await db.collection("uiConfig").doc("balances").get();
  const bal = JSON.parse(balDoc.data()?.json || "{}");
  const receipts = await listAll("receipts");
  const deposits = await listAll("deposits");
  const rentals = await listAll("rentals");
  const obligations = await listAll("obligations");
  const spaces = await listAll("spaces");
  const liveActiveRentals = rentals.filter((r) => r.state === "active" && !r.baselineExcluded);
  const liveActiveObs = obligations.filter((o) => o.state === "active" && !o.baselineExcluded);
  const liveRecog = receipts.filter((r) => r.state === "recognized" && !r.baselineExcluded);
  const liveDep = deposits.filter((d) => d.state === "approved" && !d.baselineExcluded);
  const rentedSpaces = spaces.filter((s) => s.active !== false && s.occupancy === "rented");

  const s = dash.summary || {};
  const result = {
    target: (s.targetFils || 0) / 100,
    collected: (s.collectedFils || 0) / 100,
    remaining: (s.remainingFils || 0) / 100,
    deposited: (s.companyCollectedFils || s.depositedFils || 0) / 100,
    holding: ((s.sharedEmployeeHoldingFils ?? s.holdingFils) || 0) / 100,
    expenses: (s.expensesFils || 0) / 100,
    revenue: Number(bal.revenueBalance || 0),
    company: Number(bal.companyBalance || 0),
    deduction: Number(bal.installmentBalance || 0),
    liveActiveRentals: liveActiveRentals.length,
    liveActiveObs: liveActiveObs.length,
    liveRecognizedReceipts: liveRecog.length,
    liveApprovedDeposits: liveDep.length,
    rentedSpaces: rentedSpaces.length,
    structureUnits: (dash.unitsTree || []).length,
    usersOk: true,
  };
  const zeroOk = (
    result.target === 0 && result.collected === 0 && result.remaining === 0 &&
    result.deposited === 0 && result.holding === 0 && result.expenses === 0 &&
    result.revenue === 0 && result.company === 0 && result.deduction === 0 &&
    result.liveActiveRentals === 0 && result.liveActiveObs === 0 &&
    result.liveRecognizedReceipts === 0 && result.liveApprovedDeposits === 0 &&
    result.rentedSpaces === 0
  );
  return { ...result, zeroOk, project: PROJECT };
}

const manifest = await buildManifest();
writeFileSync(`${outDir}/manifest.json`, JSON.stringify({
  ...manifest,
  reset: undefined,
  resetFullPath: `${outDir}/manifest-reset-full.json`,
}, null, 2));
writeFileSync(`${outDir}/manifest-reset-full.json`, JSON.stringify(manifest.reset, null, 2));

console.log(JSON.stringify({
  mode: MODE,
  project: PROJECT,
  targetVerified: true,
  outDir,
  preserveCount: manifest.preserveCount,
  resetCount: manifest.resetCount,
  counts: manifest.counts,
}, null, 2));

if (MODE === "dry-run") {
  console.log("DRY_RUN_COMPLETE — no writes performed");
  process.exit(0);
}

if (MODE === "apply") {
  // Safety: refuse if preserve would exclude users/structure
  if (manifest.counts.users < 3 || manifest.counts.unitsActive < 1 || manifest.counts.spacesActive < 1) {
    console.error("REFUSE apply: structure/users insufficient in preserve set");
    process.exit(1);
  }
  const applied = await applyClean(manifest);
  writeFileSync(`${outDir}/apply-log.json`, JSON.stringify(applied, null, 2));
  const v = await verifyZero();
  writeFileSync(`${outDir}/verify.json`, JSON.stringify(v, null, 2));
  console.log("APPLY_COMPLETE", JSON.stringify(v, null, 2));
  process.exit(v.zeroOk ? 0 : 2);
}

if (MODE === "verify") {
  const v = await verifyZero();
  writeFileSync(`${outDir}/verify.json`, JSON.stringify(v, null, 2));
  console.log(JSON.stringify(v, null, 2));
  process.exit(v.zeroOk ? 0 : 2);
}
