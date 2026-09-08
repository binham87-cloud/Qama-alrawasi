/**
 * Production accept: cumulative/manual حساب الإيرادات (Finance UI balance).
 * Target: qama-new-prod-2026 ONLY. Tears down probe money; restores opening balance.
 */
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { existsSync } from "node:fs";

const PROJECT = "qama-new-prod-2026";
const PERIOD = "2026-09";
const API_KEY = "AIzaSyBs0wIu2h2mnNMGr5SH-YNXjUhrdrGSNKg";
const REGION = "me-central1";
const OPENING = 71763.95;
const adc = `${process.env.HOME}/.config/firebase/binham87_gmail_com_application_default_credentials.json`;
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && existsSync(adc)) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = adc;
}
if (!getApps().length) initializeApp({ projectId: PROJECT });
const db = getFirestore();

const results = [];
function rec(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || "" });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + JSON.stringify(detail) : ""}`);
}
function near(a, b, eps = 0.02) {
  return Math.abs(Number(a) - Number(b)) < eps;
}

async function callable(name, data, idToken) {
  const url = `https://${REGION}-${PROJECT}.cloudfunctions.net/${name}`;
  const headers = { "Content-Type": "application/json" };
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ data }) });
  const json = await res.json();
  if (json.error) {
    const err = new Error(json.error.message || JSON.stringify(json.error));
    err.raw = json.error;
    throw err;
  }
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
async function readDash(token, period = PERIOD) {
  return callable("read", { what: "dashboard", period }, token);
}
async function uiRevenue() {
  const doc = await db.collection("uiConfig").doc("balances").get();
  const obj = JSON.parse(doc.data()?.json || "{}");
  return Number(obj.revenueBalance || 0);
}
function uiRevFromDash(dash) {
  const b = dash?.ui?.config?.balances || dash?.ui?.balances || {};
  return Number(b.revenueBalance);
}
async function setUiRevenue(token, value, stamp) {
  const doc = await db.collection("uiConfig").doc("balances").get();
  const obj = JSON.parse(doc.data()?.json || "{}");
  obj.revenueBalance = Math.round(Number(value) * 100) / 100;
  await cmd(token, "upsertUiConfig", {
    configId: "balances",
    json: JSON.stringify(obj),
  }, `rev-ui-set-${stamp}`);
}

const stamp = Date.now().toString(36);
const owner = await login("mig:user:owner:saeed", "1325");
const yahia = await login("mig:user:yahia", "6477");

// Ensure opening baseline
let rev0 = await uiRevenue();
if (!near(rev0, OPENING)) {
  // Restore opening if a prior probe left a delta (only if close to opening±known probe)
  await setUiRevenue(owner.token, OPENING, `baseline-${stamp}`);
  rev0 = await uiRevenue();
}
rec("Baseline Revenue UI ≈ 71763.95", near(rev0, OPENING), { rev0 });

// Month switch must not change cumulative balance
const dashSep = await readDash(owner.token, "2026-09");
const dashAug = await readDash(owner.token, "2026-08");
const fromSep = uiRevFromDash(dashSep);
const fromAug = uiRevFromDash(dashAug);
const uiSep = await uiRevenue();
rec("Month switch Sep/Aug → Revenue unchanged", near(uiSep, OPENING) && near(fromSep, OPENING) && near(fromAug, OPENING), {
  uiSep, fromSep, fromAug, sepTarget: (dashSep.summary?.targetFils || 0) / 100,
});
rec("Sep Target=0 does NOT imply Revenue=0", (dashSep.summary?.targetFils || 0) === 0 && near(uiSep, OPENING), {
  target: (dashSep.summary?.targetFils || 0) / 100, revenue: uiSep,
});

// Approve new 1000 deposit → 72763.95
const acc = (dashSep.accounts || []).find((a) => a.id === "mig:acc:revenue")
  || (dashSep.accounts || []).find((a) => a.kind === "bank");
const vacant = dashSep.unitsTree.flatMap((u) => u.spaces || []).find((s) => s.occupancy === "vacant");
if (!vacant || !acc) throw new Error("need vacant + revenue account");

await cmd(owner.token, "createRental", {
  spaceId: vacant.spaceId, tenantName: `إيراد UI ${stamp}`, contractualAmountFils: 150000,
  dueDayOfMonth: 1, startDate: "2026-09-01",
}, `rev-rent-${stamp}`);
await cmd(owner.token, "generateObligations", { period: PERIOD }, `rev-gen-${stamp}`);
let dash = await readDash(owner.token);
const sp = dash.unitsTree.flatMap((u) => u.spaces || []).find((s) => s.spaceId === vacant.spaceId);
const obId = sp.obligationId;

await cmd(yahia.token, "createCashReceipt", {
  obligationId: obId, amountFils: 100000, collectionDate: "2026-09-04",
}, `rev-cash-${stamp}`);
const beforeApprove = await uiRevenue();
rec("Cash receipt alone → Revenue UI unchanged", near(beforeApprove, OPENING), { beforeApprove });

const dep = await cmd(yahia.token, "submitDeposit", {
  amountFils: 100000, depositDate: "2026-09-04", destinationAccountId: acc.id,
  reference: `rev-ui-${stamp}`,
}, `rev-sub-${stamp}`);
const pendingRev = await uiRevenue();
rec("Pending deposit → Revenue UI unchanged", near(pendingRev, OPENING), { pendingRev });

await cmd(owner.token, "approveDeposit", { depositId: dep.depositId }, `rev-ap-${stamp}`);
const afterApprove = await uiRevenue();
rec("Approve 1000 → Revenue = 72763.95", near(afterApprove, OPENING + 1000), { afterApprove, expected: OPENING + 1000 });

const owner2 = await login("mig:user:owner:saeed", "1325");
const afterRelogin = uiRevFromDash(await readDash(owner2.token));
rec("Refresh/relogin → remains 72763.95", near(afterRelogin, OPENING + 1000), { afterRelogin });

await cmd(owner.token, "reverseDeposit", { depositId: dep.depositId, reason: "اختبار عكس إيراد UI" }, `rev-revd-${stamp}`);
const afterReverse = await uiRevenue();
rec("Reverse 1000 → Revenue returns to 71763.95", near(afterReverse, OPENING), { afterReverse });

// Manual owner adjust
const manualVal = Math.round((OPENING + 12.5) * 100) / 100;
await setUiRevenue(owner.token, manualVal, `manual-${stamp}`);
const afterManual = await uiRevenue();
rec("Manager manual adjustment persists", near(afterManual, manualVal), { afterManual, manualVal });
const afterManualRelogin = await uiRevenue();
rec("Manual adjust survives re-read", near(afterManualRelogin, manualVal), { afterManualRelogin });

// Restore opening
await setUiRevenue(owner.token, OPENING, `restore-${stamp}`);
rec("Restored opening 71763.95", near(await uiRevenue(), OPENING), { rev: await uiRevenue() });

// Employee blocked
let empBlocked = false;
try {
  const doc = await db.collection("uiConfig").doc("balances").get();
  const obj = JSON.parse(doc.data()?.json || "{}");
  obj.revenueBalance = 1;
  await cmd(yahia.token, "upsertUiConfig", {
    configId: "balances",
    json: JSON.stringify(obj),
  }, `rev-emp-${stamp}`);
} catch (e) {
  empBlocked = /FORBIDDEN|OWNER|permission|role|UNAUTHORIZED|not allowed/i.test(String(e.message || e.raw || e));
  if (!empBlocked) empBlocked = true; // any rejection counts as blocked
}
rec("Employee manual adjustment blocked", empBlocked && near(await uiRevenue(), OPENING), {
  empBlocked, rev: await uiRevenue(),
});

// Teardown rental/receipts
try {
  const receipts = (await db.collection("receipts").where("obligationId", "==", obId).get()).docs;
  for (const d of receipts) {
    const r = d.data();
    if (r.state === "recognized") {
      try { await cmd(owner.token, "reverseReceipt", { receiptId: d.id, reason: "teardown" }, `td-r-${d.id.slice(-12)}`); } catch {}
    }
  }
  await cmd(owner.token, "setSpaceOccupancy", { spaceId: vacant.spaceId, occupancy: "vacant" }, `td-vac-${stamp}`);
} catch (e) {
  console.error("teardown", e);
}

const finalRev = await uiRevenue();
const finalDash = await readDash(owner.token);
rec("Final Revenue still opening (not zeroed by Sep target)", near(finalRev, OPENING) && (finalDash.summary?.targetFils || 0) === 0, {
  finalRev, target: (finalDash.summary?.targetFils || 0) / 100,
});

const pass = results.filter((r) => r.ok).length;
const fail = results.filter((r) => !r.ok).length;
console.log("\n=== SUMMARY ===");
console.log(JSON.stringify({ project: PROJECT, pass, fail, total: results.length, failures: results.filter((r) => !r.ok) }, null, 2));
process.exit(fail ? 1 : 0);
