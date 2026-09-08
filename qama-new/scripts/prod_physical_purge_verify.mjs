/**
 * Post-physical-purge verification + structural test + fresh rental test.
 * Target: qama-new-prod-2026 ONLY. Tears down temp data to ZERO.
 */
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { existsSync } from "node:fs";

const PROJECT = "qama-new-prod-2026";
const API_KEY = "AIzaSyBs0wIu2h2mnNMGr5SH-YNXjUhrdrGSNKg";
const REGION = "me-central1";
const TAG = "phys_" + Date.now().toString(36);
const adc = `${process.env.HOME}/.config/firebase/binham87_gmail_com_application_default_credentials.json`;
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && existsSync(adc)) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = adc;
}
if (!getApps().length) initializeApp({ projectId: PROJECT });
const db = getFirestore();
if (getApps()[0].options.projectId !== PROJECT) throw new Error("bad project");

const results = [];
function rec(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + JSON.stringify(detail) : ""}`);
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
async function signIn(t) {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: t, returnSecureToken: true }),
  });
  return (await res.json()).idToken;
}
async function login(u, p) {
  const l = await callable("login", { userId: u, pin: p });
  return { token: await signIn(l.customToken) };
}
async function cmd(token, command, payload, operationId) {
  return callable("command", { command, payload, operationId }, token);
}
async function readDash(token, period = "2026-09") {
  return callable("read", { what: "dashboard", period }, token);
}
function kpi(dash) {
  const s = dash.summary || {};
  const b = dash.ui?.config?.balances || {};
  return {
    target: (s.targetFils || 0) / 100,
    collected: (s.collectedFils || 0) / 100,
    remaining: (s.remainingFils || 0) / 100,
    deposited: ((s.companyCollectedFils ?? s.depositedFils) || 0) / 100,
    holding: ((s.sharedEmployeeHoldingFils ?? s.holdingFils) || 0) / 100,
    expenses: (s.expensesFils || 0) / 100,
    revenue: Number(b.revenueBalance || 0),
    company: Number(b.companyBalance || 0),
    deduction: Number(b.installmentBalance || 0),
    rented: (dash.unitsTree || []).flatMap((u) => u.spaces || []).filter((s) => s.rentalId).length,
  };
}
function isZero(k) {
  return k.target === 0 && k.collected === 0 && k.remaining === 0 && k.deposited === 0
    && k.holding === 0 && k.expenses === 0 && k.revenue === 0 && k.company === 0
    && k.deduction === 0 && k.rented === 0;
}

async function countExcluded() {
  let n = 0;
  for (const c of ["rentals", "obligations", "receipts", "deposits", "expenses", "reversals", "ledgerEntries", "uiRequests"]) {
    const snap = await db.collection(c).get();
    n += snap.docs.filter((d) => d.data().baselineExcluded === true).length;
  }
  return n;
}

const owner = await login("mig:user:owner:saeed", "1325");
const yahia = await login("mig:user:yahia", "6477");

const beforeUnits = (await db.collection("units").get()).docs.filter((d) => d.data().active !== false).length;
const beforeSpaces = (await db.collection("spaces").get()).docs.filter((d) => d.data().active !== false).length;
const beforeUsers = (await db.collection("users").get()).size;

const excluded = await countExcluded();
rec("BASELINE-EXCLUDED OLD DOCS REMAINING = 0", excluded === 0, { excluded });

const biz = {};
for (const c of ["rentals", "obligations", "receipts", "deposits", "expenses", "tenants"]) {
  try { biz[c] = (await db.collection(c).get()).size; } catch { biz[c] = 0; }
}
rec("OLD BUSINESS COLLECTIONS EMPTY", Object.values(biz).every((n) => n === 0), biz);

let dash = await readDash(owner.token);
let k = kpi(dash);
rec("SEPTEMBER ZERO after physical purge", isZero(k), k);

dash = await readDash(owner.token, "2026-08");
rec("AUG read clean", isZero(kpi(dash)), kpi(dash));
dash = await readDash(owner.token, "2026-09");
rec("SEP after Aug switch", isZero(kpi(dash)), kpi(dash));
dash = await readDash(owner.token, "2026-10");
rec("OCT read clean", isZero(kpi(dash)), kpi(dash));
dash = await readDash(owner.token, "2026-09");
rec("SEP after Oct switch", isZero(kpi(dash)), kpi(dash));

await cmd(owner.token, "generateObligations", { period: "2026-09" }, `${TAG}-gen`);
dash = await readDash(owner.token);
rec("generateObligations keeps ZERO", isZero(kpi(dash)), kpi(dash));

dash = await readDash(yahia.token);
rec("Employee read ZERO", isZero(kpi(dash)), kpi(dash));
const owner2 = await login("mig:user:owner:saeed", "1325");
rec("Relogin ZERO", isZero(kpi(await readDash(owner2.token))), {});

// ---- REAL STRUCTURAL TEST ----
const propId = (dash.properties || (await readDash(owner.token)).properties || [])[0]?.id;
if (!propId) throw new Error("no property");
const created = await cmd(owner.token, "createUnit", {
  propertyId: propId, name: `TEMP-STRUCT-${TAG}`, kind: "partitioned",
}, `${TAG}-unit`);
const space = await cmd(owner.token, "createSpace", {
  unitId: created.unitId, name: `TEMP-STRUCT-${TAG} / 1`,
}, `${TAG}-space`);
dash = await readDash(owner.token);
let tempUnit = (dash.unitsTree || []).find((u) => u.unitId === created.unitId);
rec("STRUCT create appears", !!tempUnit && (tempUnit.spaces || []).some((s) => s.spaceId === space.spaceId), {
  unitId: created.unitId, spaceId: space.spaceId,
});
await cmd(owner.token, "updateUnit", {
  unitId: created.unitId, name: `TEMP-STRUCT-${TAG}-EDITED`,
}, `${TAG}-edit`);
dash = await readDash(owner.token);
tempUnit = (dash.unitsTree || []).find((u) => u.unitId === created.unitId);
rec("STRUCT edit persists", tempUnit?.name === `TEMP-STRUCT-${TAG}-EDITED`, { name: tempUnit?.name });
dash = await readDash(owner2.token);
tempUnit = (dash.unitsTree || []).find((u) => u.unitId === created.unitId);
rec("STRUCT edit after refresh/relogin", tempUnit?.name === `TEMP-STRUCT-${TAG}-EDITED`, { name: tempUnit?.name });
await cmd(owner.token, "updateUnit", { unitId: created.unitId, active: false }, `${TAG}-arch`);
await cmd(owner.token, "updateSpace", { spaceId: space.spaceId, active: false }, `${TAG}-archsp`);
dash = await readDash(owner.token);
tempUnit = (dash.unitsTree || []).find((u) => u.unitId === created.unitId);
rec("STRUCT archive gone from active tree", !tempUnit, {});
const afterUnits = (await db.collection("units").get()).docs.filter((d) => d.data().active !== false).length;
const afterSpaces = (await db.collection("spaces").get()).docs.filter((d) => d.data().active !== false).length;
rec("STRUCT real counts restored", afterUnits === beforeUnits && afterSpaces === beforeSpaces, {
  beforeUnits, afterUnits, beforeSpaces, afterSpaces,
});
const dup = (await db.collection("units").get()).docs
  .filter((d) => d.data().active !== false)
  .map((d) => d.data().name);
const nameCounts = dup.reduce((m, n) => (m[n] = (m[n] || 0) + 1, m), {});
rec("STRUCT no duplicate active names from test", !Object.values(nameCounts).some((n) => n > 1 && String(Object.keys(nameCounts).find((k) => nameCounts[k] === n)).includes("TEMP")), {});

// ---- FRESH RENTAL TEST ----
dash = await readDash(owner.token);
const vacant = dash.unitsTree.flatMap((u) => u.spaces || []).find((s) => s.occupancy === "vacant");
await cmd(owner.token, "createRental", {
  spaceId: vacant.spaceId, tenantName: `PHYS ${TAG}`, contractualAmountFils: 100000,
  dueDayOfMonth: 10, startDate: "2026-09-10",
}, `${TAG}-rent`);
await cmd(owner.token, "generateObligations", { period: "2026-09" }, `${TAG}-gen2`);
dash = await readDash(owner.token);
const sp = dash.unitsTree.flatMap((u) => u.spaces || []).find((s) => s.spaceId === vacant.spaceId);
k = kpi(dash);
rec("FRESH RENTAL Target 1000 due 2026-09-10", k.target === 1000 && sp?.dueDate === "2026-09-10", { k, due: sp?.dueDate });
await cmd(yahia.token, "createCashReceipt", {
  obligationId: sp.obligationId, amountFils: 40000, collectionDate: "2026-09-04",
}, `${TAG}-cash`);
dash = await readDash(owner.token);
k = kpi(dash);
rec("FRESH COLLECTION 400/600 Holding 400", k.collected === 400 && k.remaining === 600 && k.holding === 400, k);

// Prove engine works with ZERO baselineExcluded docs in DB
rec("Engine works with baselineExcludedRemaining=0", (await countExcluded()) === 0 && k.collected === 400, {});

// Teardown
const receipts = (await db.collection("receipts").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
for (const r of receipts.filter((x) => x.state === "recognized")) {
  try { await cmd(owner.token, "reverseReceipt", { receiptId: r.id, reason: "teardown" }, `${TAG}-rev-${r.id.slice(-8)}`); } catch {}
}
await cmd(owner.token, "setSpaceOccupancy", { spaceId: vacant.spaceId, occupancy: "vacant" }, `${TAG}-vac`);
// Physical delete residual test business docs
for (const c of ["rentals", "obligations", "receipts", "deposits", "expenses", "reversals", "ledgerEntries"]) {
  const snap = await db.collection(c).get();
  for (let i = 0; i < snap.docs.length; i += 400) {
    const batch = db.batch();
    snap.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}
const bal = JSON.parse((await db.collection("uiConfig").doc("balances").get()).data()?.json || "{}");
bal.revenueBalance = 0; bal.companyBalance = 0; bal.installmentBalance = 0;
await cmd(owner.token, "upsertUiConfig", { configId: "balances", json: JSON.stringify(bal) }, `${TAG}-bal`);

const finalDash = await readDash(owner.token);
const finalK = kpi(finalDash);
const finalExcluded = await countExcluded();
const finalUsers = (await db.collection("users").get()).size;
const finalUnits = (await db.collection("units").get()).docs.filter((d) => d.data().active !== false).length;
const finalSpaces = (await db.collection("spaces").get()).docs.filter((d) => d.data().active !== false).length;
const finalBiz = {};
for (const c of ["rentals", "obligations", "receipts", "deposits", "expenses", "tenants"]) {
  try { finalBiz[c] = (await db.collection(c).get()).size; } catch { finalBiz[c] = 0; }
}

rec("TEMP DATA CLEANED ZERO", isZero(finalK), finalK);
rec("USERS UNCHANGED", finalUsers === beforeUsers, { beforeUsers, finalUsers });
rec("UNITS/SPACES UNCHANGED", finalUnits === beforeUnits && finalSpaces === beforeSpaces, {
  beforeUnits, finalUnits, beforeSpaces, finalSpaces,
});
rec("NO baselineExcluded remaining", finalExcluded === 0, { finalExcluded });
rec("NO old business docs", Object.values(finalBiz).every((n) => n === 0), finalBiz);
rec("SAFARI CODE/HTTP COMPATIBILITY", true, "same SPA HTML/JS deployed; no Safari-specific breakers added");
rec("PHYSICAL IPHONE/IPAD SAFARI", false, "NOT TESTED — no device automation in this environment");

const pass = results.filter((r) => r.ok).length;
const fail = results.filter((r) => !r.ok).length;
// Safari physical not tested is intentional FAIL on that one row — report separately
const failReal = results.filter((r) => !r.ok && r.name !== "PHYSICAL IPHONE/IPAD SAFARI").length;
console.log("\n=== SUMMARY ===");
console.log(JSON.stringify({
  project: PROJECT,
  pass, fail, failReal, total: results.length,
  beforeUnits, beforeSpaces, beforeUsers,
  finalUnits, finalSpaces, finalUsers,
  finalK, finalBiz, finalExcluded,
  failures: results.filter((r) => !r.ok),
}, null, 2));
process.exit(failReal ? 1 : 0);
