/**
 * Production repair: archive structural duplicates + backfill missing revenue ledger.
 * Scoped to qama-new-prod-2026. Idempotent.
 *
 * Modes: --dry-run (default) | --apply
 */
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { existsSync } from "node:fs";

const PROJECT = "qama-new-prod-2026";
const APPLY = process.argv.includes("--apply");
const adc = `${process.env.HOME}/.config/firebase/binham87_gmail_com_application_default_credentials.json`;
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && existsSync(adc)) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = adc;
}
if (!getApps().length) initializeApp({ projectId: PROJECT });
const db = getFirestore();
const API_KEY = "AIzaSyBs0wIu2h2mnNMGr5SH-YNXjUhrdrGSNKg";
const REGION = "me-central1";

async function callable(name, data, idToken) {
  const res = await fetch(`https://${REGION}-${PROJECT}.cloudfunctions.net/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) },
    body: JSON.stringify({ data }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return j.result;
}
async function signIn(t) {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: t, returnSecureToken: true }),
  });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.idToken;
}
async function cmd(token, command, payload, operationId) {
  return callable("command", { command, payload, operationId }, token);
}

const DUP_UNITS = [
  // Keep legacy physical rooms; archive later custom clones (spaces already inactive).
  { archive: "unit:unit-u_1779391565240", keep: "mig:unit:unit:legacy:3488eebab0f677f0e11aafdd", name: "غرفة السطح الخارجي" },
  { archive: "unit:unit-u_1779391584043", keep: "mig:unit:unit:legacy:e075c3e14d580982e94254d3", name: "غرفة السطح الداخلي" },
];
const ORPHAN_UNIT = "unit:createUnit-82d14bc4ae6948d19ffd4c1f57b2d38c"; // VERIFY-TEMP inactive parent with active space

console.log(APPLY ? "APPLY mode" : "DRY-RUN mode");

const login = await callable("login", { userId: "mig:user:owner:saeed", pin: "1325" });
const token = await signIn(login.customToken);
const report = { archivedUnits: [], customUnitsMarked: false, revenueBackfilled: [], skipped: [] };

for (const row of DUP_UNITS) {
  const u = await db.collection("units").doc(row.archive).get();
  if (!u.exists) { report.skipped.push({ id: row.archive, reason: "missing" }); continue; }
  if (u.data().active === false) { report.skipped.push({ id: row.archive, reason: "already_inactive" }); continue; }
  console.log("archive unit", row.archive, "keep", row.keep);
  if (APPLY) {
    await cmd(token, "updateUnit", { unitId: row.archive, active: false }, "repair-arch-" + row.archive.slice(-12));
  }
  report.archivedUnits.push(row);
}

const orphan = await db.collection("units").doc(ORPHAN_UNIT).get();
if (orphan.exists && orphan.data().active === false) {
  const spaces = await db.collection("spaces").where("unitId", "==", ORPHAN_UNIT).get();
  for (const d of spaces.docs) {
    if (d.data().active === false) continue;
    console.log("deactivate orphan space", d.id);
    if (APPLY) {
      await cmd(token, "updateSpace", { spaceId: d.id, active: false }, "repair-archsp-" + d.id.slice(-10));
    }
    report.archivedUnits.push({ archiveSpace: d.id });
  }
}

// Mark customUnits clones removed from April 2026 onward
const cuDoc = await db.collection("uiConfig").doc("customUnits").get();
if (cuDoc.exists) {
  let parsed = {};
  try { parsed = JSON.parse(cuDoc.data().json || "{}"); } catch { parsed = {}; }
  const units = parsed.units || [];
  let changed = false;
  for (const id of ["u_1779391565240", "u_1779391584043", "u_1779391527677"]) {
    const e = units.find((x) => x.id === id);
    if (e && (e._removedY == null)) {
      e._removedY = 2026; e._removedM = 3; changed = true;
      console.log("mark customUnit removed", id);
    }
  }
  if (changed && APPLY) {
    await db.collection("uiConfig").doc("customUnits").set({
      json: JSON.stringify(parsed),
      updatedAt: new Date().toISOString(),
      updatedBy: "mig:user:owner:saeed",
    }, { merge: true });
    report.customUnitsMarked = true;
  } else if (changed) {
    report.customUnitsMarked = "dry-run";
  }
}

// Revenue backfill for approved deposits missing credit ledger
const deps = (await db.collection("deposits").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const approved = deps.filter((d) => d.state === "approved");
for (const d of approved) {
  const entryId = (`ledger:deposit:${d.id}:credit`).slice(0, 140);
  const exists = await db.collection("ledgerEntries").doc(entryId).get();
  if (exists.exists) { report.skipped.push({ deposit: d.id, reason: "ledger_exists" }); continue; }
  console.log("backfill revenue for deposit", d.id, d.amountFils / 100);
  if (APPLY) {
    // Use reverse+re-approve is unsafe. Write ledger + account via admin, matching command semantics.
    const accRef = db.collection("accounts").doc("mig:acc:revenue");
    await db.runTransaction(async (tx) => {
      const acc = await tx.get(accRef);
      const prev = Number(acc.data()?.balanceFils || 0);
      tx.set(accRef, { balanceFils: prev + Number(d.amountFils || 0) }, { merge: true });
      tx.set(db.collection("ledgerEntries").doc(entryId), {
        id: entryId,
        accountId: "mig:acc:revenue",
        direction: "credit",
        amountFils: d.amountFils,
        sourceType: "deposit",
        sourceId: d.id,
        note: "backfill approved deposit revenue",
        at: new Date().toISOString(),
        schemaVersion: 1,
        createdBy: "mig:user:owner:saeed",
        createdAt: new Date().toISOString(),
      });
    });
    const bal = await db.collection("uiConfig").doc("balances").get();
    if (bal.exists) {
      let obj = {};
      try { obj = JSON.parse(bal.data().json || "{}"); } catch { obj = {}; }
      obj.revenueBalance = Math.round(((Number(obj.revenueBalance) || 0) + d.amountFils / 100) * 100) / 100;
      await db.collection("uiConfig").doc("balances").set({
        json: JSON.stringify(obj),
        updatedAt: new Date().toISOString(),
        updatedBy: "mig:user:owner:saeed",
      }, { merge: true });
    }
  }
  report.revenueBackfilled.push({ depositId: d.id, amountAed: d.amountFils / 100 });
}

console.log(JSON.stringify(report, null, 2));
