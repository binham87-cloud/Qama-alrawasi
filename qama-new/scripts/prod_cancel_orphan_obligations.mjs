/**
 * Cancel orphan active obligations on closed rentals with no live receipts.
 * Documented operationIds. Does not delete audit history.
 *
 *   OWNER_PIN=… node scripts/prod_cancel_orphan_obligations.mjs
 */
const API_KEY = "AIzaSyBs0wIu2h2mnNMGr5SH-YNXjUhrdrGSNKg";
const REGION = "me-central1";
const PROJECT = "qama-new-prod-2026";
const PIN = process.env.OWNER_PIN;
if (!PIN) { console.error("OWNER_PIN required"); process.exit(2); }

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
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }) });
  return (await res.json()).idToken;
}

import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { existsSync, writeFileSync } from "node:fs";
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

const orphans = [];
for (const o of obligations) {
  if (o.state !== "active") continue;
  const rental = rentals[o.rentalId];
  if (!rental || rental.state === "active") continue;
  const live = receipts.filter((r) => r.obligationId === o.id && (r.state === "recognized" || r.state === "pending"));
  orphans.push({
    obligationId: o.id, rentalId: o.rentalId, rentalState: rental.state,
    spaceId: o.spaceId, amountFils: o.amountFils, liveCount: live.length,
    liveIds: live.map((r) => r.id),
  });
}

writeFileSync("artifacts/investigation-2026-09-05/ORPHAN-OBLIGATIONS-BEFORE.json", JSON.stringify({ at: new Date().toISOString(), orphans }, null, 2));
console.log("orphans", orphans.length, JSON.stringify(orphans, null, 2));

const STAMP = Date.now().toString(36);
const results = [];
for (const o of orphans) {
  if (o.liveCount > 0) {
    results.push({ id: o.obligationId, skipped: true, reason: "has_live_receipts", liveIds: o.liveIds });
    continue;
  }
  try {
    const opId = `orphan-cancel-${STAMP}-${o.obligationId}`.slice(0, 120);
    await callable("command", {
      command: "cancelObligation",
      payload: { obligationId: o.obligationId, reason: "orphan on closed rental — vacate/holding incident cleanup" },
      operationId: opId,
    }, token);
    results.push({ id: o.obligationId, ok: true, operationId: opId });
    console.log("cancelled", o.obligationId, opId);
  } catch (e) {
    results.push({ id: o.obligationId, ok: false, error: String(e.message || e).slice(0, 200) });
    console.log("fail", o.obligationId, e.message);
  }
}
writeFileSync("artifacts/investigation-2026-09-05/ORPHAN-OBLIGATIONS-AFTER.json", JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
console.log(JSON.stringify({ cancelled: results.filter((r) => r.ok).length, skipped: results.filter((r) => r.skipped).length, fail: results.filter((r) => r.ok === false).length }, null, 2));
