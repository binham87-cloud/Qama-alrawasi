/**
 * Orphan obligation detector / optional canceller for qama-new-prod-2026.
 *
 * FAIL-CLOSED: prefer leaving junk over erasing legitimate retained debt.
 *
 * Default: DRY RUN ONLY (detect + report, never cancel).
 * Destructive: OWNER_PIN=… node scripts/prod_cancel_orphan_obligations.mjs --apply
 *
 * A CASE B post-vacate retained obligation (active + closed rental + 0 receipts
 * + retainArrearsAfterVacate) is NEVER an orphan.
 */
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { classifyOrphanCandidate } from "./lib/orphan_obligation_classify.mjs";

const API_KEY = "AIzaSyBs0wIu2h2mnNMGr5SH-YNXjUhrdrGSNKg";
const REGION = "me-central1";
const PROJECT = "qama-new-prod-2026";
const PIN = process.env.OWNER_PIN;
if (!PIN) { console.error("OWNER_PIN required"); process.exit(2); }

const APPLY = process.argv.includes("--apply");
const STAMP = Date.now().toString(36);

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
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  return (await res.json()).idToken;
}

const adc = `${process.env.HOME}/.config/firebase/binham87_gmail_com_application_default_credentials.json`;
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && existsSync(adc)) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = adc;
}
if (!getApps().length) initializeApp({ projectId: PROJECT });
const db = getFirestore();

const token = await signIn((await callable("login", { userId: "mig:user:owner:saeed", pin: PIN })).customToken);
const rentals = Object.fromEntries((await db.collection("rentals").get()).docs.map((d) => [d.id, d.data()]));
const receipts = (await db.collection("receipts").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const obligations = (await db.collection("obligations").get()).docs.map((d) => ({ id: d.id, ...d.data() }));

const classified = [];
for (const o of obligations) {
  if (o.state !== "active") continue;
  const rental = rentals[o.rentalId];
  if (rental && rental.state === "active") continue;
  const live = receipts.filter(
    (r) => r.obligationId === o.id && (r.state === "recognized" || r.state === "pending"),
  );
  classified.push(classifyOrphanCandidate(o, rental, live));
}

const toCancel = classified.filter((c) => c.action === "cancel");
const skipped = classified.filter((c) => c.action === "skip");

mkdirSync("artifacts/investigation-2026-09-05", { recursive: true });
writeFileSync("artifacts/investigation-2026-09-05/ORPHAN-OBLIGATIONS-BEFORE.json", JSON.stringify({
  at: new Date().toISOString(),
  mode: APPLY ? "apply" : "dry-run",
  candidates: classified,
  wouldCancel: toCancel,
  skipped,
}, null, 2));

console.log(`MODE: ${APPLY ? "APPLY (destructive)" : "DRY RUN (default)"}`);
console.log(`candidates(closed rental): ${classified.length}`);
console.log(`wouldCancel: ${toCancel.length}`);
console.log(`skipped: ${skipped.length}`);

function printRow(c, label) {
  console.log(`\n[${label}]`);
  console.log(`  obligationId: ${c.obligationId}`);
  console.log(`  rentalId: ${c.rentalId}`);
  console.log(`  tenant: ${c.tenant}`);
  console.log(`  amountFils: ${c.amountFils}`);
  console.log(`  retainArrearsAfterVacate: ${c.retainArrearsAfterVacate}`);
  console.log(`  closeReason: ${c.closeReason}`);
  console.log(`  orphanReason: ${c.orphanReason}`);
  console.log(`  safeToCancel: ${c.safeToCancel}`);
}

for (const c of toCancel) printRow(c, APPLY ? "WILL CANCEL" : "DRY-RUN WOULD CANCEL");
for (const c of skipped.filter((s) =>
  /retainArrears|real vacate|unproven|arrearsRemaining/i.test(s.orphanReason))) {
  printRow(c, "SKIP");
}

const results = [];
if (!APPLY) {
  console.log("\nDry run only — pass --apply to cancel proven temp orphans.");
  for (const c of toCancel) results.push({ id: c.obligationId, dryRun: true, wouldCancel: true, ...c });
  for (const c of skipped) results.push({ id: c.obligationId, dryRun: true, skipped: true, reason: c.orphanReason, ...c });
} else {
  if (toCancel.length === 0) console.log("\nNothing safe to cancel.");
  for (const c of toCancel) {
    printRow(c, "APPLYING CANCEL");
    try {
      const opId = `orphan-cancel-${STAMP}-${c.obligationId}`.slice(0, 120);
      await callable("command", {
        command: "cancelObligation",
        payload: {
          obligationId: c.obligationId,
          reason: `proven temp orphan — ${c.orphanReason}`.slice(0, 300),
        },
        operationId: opId,
      }, token);
      results.push({ id: c.obligationId, ok: true, operationId: opId, ...c });
      console.log("cancelled", c.obligationId, opId);
    } catch (e) {
      results.push({ id: c.obligationId, ok: false, error: String(e.message || e).slice(0, 200), ...c });
      console.log("fail", c.obligationId, e.message);
    }
  }
  for (const c of skipped) results.push({ id: c.obligationId, skipped: true, reason: c.orphanReason, ...c });
}

writeFileSync("artifacts/investigation-2026-09-05/ORPHAN-OBLIGATIONS-AFTER.json", JSON.stringify({
  at: new Date().toISOString(),
  mode: APPLY ? "apply" : "dry-run",
  results,
  cancelled: results.filter((r) => r.ok).length,
  skipped: results.filter((r) => r.skipped).length,
  dryRunWouldCancel: results.filter((r) => r.wouldCancel).length,
}, null, 2));

console.log(JSON.stringify({
  mode: APPLY ? "apply" : "dry-run",
  cancelled: results.filter((r) => r.ok).length,
  dryRunWouldCancel: toCancel.length,
  skipped: skipped.length,
}, null, 2));
