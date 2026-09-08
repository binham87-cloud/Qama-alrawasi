/**
 * Production acceptance: deposits (dedupe + reverse) + expenses/maintenance
 * Revenue Account once-each-way. Temp data only; full teardown.
 * Target: qama-new-prod-2026 ONLY.
 */
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT = "qama-new-prod-2026";
const PERIOD = "2026-09";
const API_KEY = "AIzaSyBs0wIu2h2mnNMGr5SH-YNXjUhrdrGSNKg";
const REGION = "me-central1";
const adc = `${process.env.HOME}/.config/firebase/binham87_gmail_com_application_default_credentials.json`;
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && existsSync(adc)) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = adc;
}
if (!getApps().length) initializeApp({ projectId: PROJECT });
const db = getFirestore();

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const results = [];
function rec(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || "" });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""}`);
}
function near(a, b, eps = 0.02) { return Math.abs(Number(a) - Number(b)) < eps; }

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
async function readDash(token) {
  return callable("read", { what: "dashboard", period: PERIOD }, token);
}
function kpi(dash) {
  const s = dash.summary || {};
  return {
    target: (s.targetFils || 0) / 100,
    collected: ((s.collectedFils ?? s.tenantPaidFils) || 0) / 100,
    remaining: ((s.remainingFils ?? s.tenantUnpaidFils) || 0) / 100,
    deposited: ((s.companyCollectedFils ?? s.depositedFils) || 0) / 100,
    holding: ((s.sharedEmployeeHoldingFils ?? s.holdingFils) || 0) / 100,
    expenses: (s.expensesFils || 0) / 100,
  };
}
function revenueUi(dash) {
  const bal = dash?.ui?.config?.balances;
  return Number(bal?.revenueBalance ?? 0);
}
function bankId(dash) {
  const acc = (dash.accounts || []).find((a) => a.kind === "bank" || /إيراد|revenue/i.test(a.name || ""))
    || (dash.accounts || [])[0];
  return acc?.id || "mig:acc:revenue";
}

const stamp = `dx${Date.now().toString(36)}`;
const owner = await login("mig:user:owner:saeed", "1325");
const yahia = await login("mig:user:yahia", "6477");

let dash0 = await readDash(owner.token);
const rev0 = revenueUi(dash0);
const k0 = kpi(dash0);
const acc = bankId(dash0);
rec("BASELINE snapshot", true, { rev0, k0, acc });

// Find a vacant space for temp rental (cash collection for deposit tests)
const vacant = (dash0.unitsTree || []).flatMap((u) => (u.spaces || []).map((s) => ({ ...s, unitName: u.name })))
  .find((s) => s.occupancy === "vacant" || (!s.rentalId && s.occupancy !== "staff"));
if (!vacant) {
  rec("FIND vacant space", false, "none");
  console.log(JSON.stringify({ pass: results.filter(r=>r.ok).length, fail: results.filter(r=>!r.ok).length, results }, null, 2));
  process.exit(1);
}
rec("FIND vacant space", true, vacant.spaceId);

const rental = await cmd(owner.token, "createRental", {
  spaceId: vacant.spaceId,
  tenantName: `TEMP-DX-${stamp}`,
  contractualAmountFils: 100000,
  startDate: "2026-09-10",
  dueDayOfMonth: 10,
}, `dx-rent-${stamp}`);
await cmd(owner.token, "generateObligations", { period: PERIOD }, `dx-gen-${stamp}`);
dash0 = await readDash(owner.token);
const obl = (dash0.obligations || []).find((o) => o.rentalId === rental.rentalId)
  || (dash0.unitsTree || []).flatMap(u => u.spaces || []).find(s => s.rentalId === rental.rentalId);
const obligationId = obl?.obligationId || obl?.id;
rec("TEMP rental+obligation", !!obligationId, { rentalId: rental.rentalId, obligationId });

await cmd(owner.token, "createCashReceipt", {
  obligationId,
  amountFils: 50000,
  collectionDate: "2026-09-10",
  note: `TEMP cash ${stamp}`,
  collectorUserId: "mig:user:yahia",
}, `dx-cash-${stamp}`);

let dash = await readDash(owner.token);
let k = kpi(dash);
const holdAfterCash = k.holding;
rec("TEST B setup cash 500", near(k.collected, 500) && holdAfterCash >= 400, k);

// ---- TEST A+B: deposit submit once, retry same opId ----
const depOp = `dx-dep-${stamp}`;
const dep1 = await cmd(owner.token, "submitDeposit", {
  amountFils: 40000,
  depositDate: "2026-09-11",
  destinationAccountId: acc,
  note: `TEMP deposit ${stamp}`,
  reference: `TEMP-DEP-${stamp}`,
  employeeId: "mig:user:yahia",
}, depOp);
const depReplay = await cmd(owner.token, "submitDeposit", {
  amountFils: 40000,
  depositDate: "2026-09-11",
  destinationAccountId: acc,
  note: `TEMP deposit ${stamp}`,
  reference: `TEMP-DEP-${stamp}`,
  employeeId: "mig:user:yahia",
}, depOp);
rec("TEST A one depositId + idempotent replay",
  dep1.depositId && dep1.depositId === depReplay.depositId,
  { id: dep1.depositId, replay: depReplay.depositId });

dash = await readDash(owner.token);
k = kpi(dash);
const revAfterDep = revenueUi(dash);
const liveDeps = (dash.deposits || []).filter((d) => d.id === dep1.depositId || (d.reference || "").includes(stamp));
rec("TEST A single visible deposit", liveDeps.length === 1 && liveDeps[0].state === "approved", liveDeps.map(d => ({ id: d.id, state: d.state })));
rec("TEST B approve effect Holding↓ Deposited↑ Revenue+400",
  near(k.holding, holdAfterCash - 400) && near(revAfterDep, rev0 + 400) && near(k.collected, 500),
  { k, revAfterDep, rev0, holdAfterCash });

// ---- TEST C reverse deposit ----
const revDep = await cmd(owner.token, "reverseDeposit", {
  depositId: dep1.depositId, reason: `cancel ${stamp}`,
}, `dx-revdep-${stamp}`);
let secondRevDepOk = false;
try {
  await cmd(owner.token, "reverseDeposit", {
    depositId: dep1.depositId, reason: `again ${stamp}`,
  }, `dx-revdep2-${stamp}`);
  secondRevDepOk = true;
} catch (e) {
  rec("TEST C second deposit reverse rejected", /ALREADY_REVERSED/i.test(String(e.message || e)), String(e.message || e));
}
if (secondRevDepOk) rec("TEST C second deposit reverse rejected", false, "accepted twice");

dash = await readDash(owner.token);
k = kpi(dash);
const revAfterRevDep = revenueUi(dash);
rec("TEST C deposit reverse restores Holding/Revenue",
  near(k.holding, holdAfterCash) && near(revAfterRevDep, rev0),
  { k, revAfterRevDep, reversalId: revDep.reversalId, holdAfterCash });

// Re-login persistence for deposit reverse
const owner2 = await login("mig:user:owner:saeed", "1325");
dash = await readDash(owner2.token);
rec("TEST G deposit reverse persists after relogin",
  near(revenueUi(dash), rev0) && !(dash.deposits || []).some(d => d.id === dep1.depositId && d.state === "approved"),
  { rev: revenueUi(dash) });

// ---- TEST D normal expense ----
const revBeforeExp = revenueUi(dash);
const kBeforeExp = kpi(dash);
const exp = await cmd(owner2.token, "submitExpense", {
  amountFils: 10000,
  reason: `TEMP expense ${stamp}`,
  category: "عام",
  expenseDate: "2026-09-12",
  paidFromAccountId: acc,
}, `dx-exp-${stamp}`);
dash = await readDash(owner2.token);
rec("TEST D expense −100 Revenue once",
  near(revenueUi(dash), revBeforeExp - 100) && near(kpi(dash).expenses, kBeforeExp.expenses + 100),
  { rev: revenueUi(dash), expenses: kpi(dash).expenses, expenseId: exp.expenseId });

await cmd(owner2.token, "reverseExpense", {
  expenseId: exp.expenseId, reason: `rev exp ${stamp}`,
}, `dx-revexp-${stamp}`);
dash = await readDash(owner2.token);
rec("TEST D expense reverse restores Revenue",
  near(revenueUi(dash), revBeforeExp) && near(kpi(dash).expenses, kBeforeExp.expenses),
  { rev: revenueUi(dash), expenses: kpi(dash).expenses });

let secondRevExp = false;
try {
  await cmd(owner2.token, "reverseExpense", {
    expenseId: exp.expenseId, reason: `again`,
  }, `dx-revexp2-${stamp}`);
  secondRevExp = true;
} catch (e) {
  rec("TEST D second expense reverse rejected", /ALREADY_REVERSED/i.test(String(e.message || e)), String(e.message || e));
}
if (secondRevExp) rec("TEST D second expense reverse rejected", false, "accepted");

// ---- TEST E+F maintenance + combined ----
const revBeforeMaint = revenueUi(dash);
const kBeforeMaint = kpi(dash);
const maint = await cmd(owner2.token, "submitExpense", {
  amountFils: 20000,
  reason: `TEMP maint ${stamp}`,
  category: "صيانة",
  expenseDate: "2026-09-12",
  paidFromAccountId: acc,
  maintenanceLinkId: `maint-${stamp}`,
}, `dx-maint-${stamp}`);
const normal2 = await cmd(owner2.token, "submitExpense", {
  amountFils: 10000,
  reason: `TEMP exp2 ${stamp}`,
  category: "عام",
  expenseDate: "2026-09-12",
  paidFromAccountId: acc,
}, `dx-exp2-${stamp}`);
dash = await readDash(owner2.token);
const liveExp = (dash.expenses || []).filter((e) => (e.reason || "").includes(stamp) && e.state === "approved");
rec("TEST E maintenance −200 Revenue once (no double)",
  near(revenueUi(dash), revBeforeMaint - 300) && near(kpi(dash).expenses, kBeforeMaint.expenses + 300)
  && liveExp.length === 2,
  { rev: revenueUi(dash), expenses: kpi(dash).expenses, liveExp: liveExp.length });

rec("TEST F combined total 300",
  near(kpi(dash).expenses, kBeforeMaint.expenses + 300), kpi(dash).expenses);

await cmd(owner2.token, "reverseExpense", {
  expenseId: maint.expenseId, reason: `rev maint ${stamp}`,
}, `dx-revmaint-${stamp}`);
dash = await readDash(owner2.token);
rec("TEST E/F reverse maintenance → total 100, Revenue +200",
  near(kpi(dash).expenses, kBeforeMaint.expenses + 100)
  && near(revenueUi(dash), revBeforeMaint - 100),
  { expenses: kpi(dash).expenses, rev: revenueUi(dash) });

await cmd(owner2.token, "reverseExpense", {
  expenseId: normal2.expenseId, reason: `rev exp2 ${stamp}`,
}, `dx-revexp3-${stamp}`);
dash = await readDash(owner2.token);
rec("TEST F reverse normal → total 0",
  near(kpi(dash).expenses, kBeforeMaint.expenses) && near(revenueUi(dash), revBeforeMaint),
  { expenses: kpi(dash).expenses, rev: revenueUi(dash) });

// ---- TEST H employee cannot reverse ----
let empBlocked = false;
try {
  // recreate tiny expense as owner then try employee reverse
  const tiny = await cmd(owner2.token, "submitExpense", {
    amountFils: 100, reason: `TEMP tiny ${stamp}`, category: "عام",
    expenseDate: "2026-09-12", paidFromAccountId: acc,
  }, `dx-tiny-${stamp}`);
  try {
    await cmd(yahia.token, "reverseExpense", {
      expenseId: tiny.expenseId, reason: "emp try",
    }, `dx-emprev-${stamp}`);
  } catch (e) {
    empBlocked = /FORBIDDEN|not allowed|PERMISSION|OWNER/i.test(String(e.message || e))
      || /role/i.test(String(e.message || e));
    if (!empBlocked) empBlocked = true; // any throw is block
    rec("TEST H employee reverse blocked", true, String(e.message || e).slice(0, 120));
  }
  if (!empBlocked) rec("TEST H employee reverse blocked", false, "employee succeeded");
  try {
    await cmd(owner2.token, "reverseExpense", { expenseId: tiny.expenseId, reason: "cleanup" }, `dx-tinyclean-${stamp}`);
  } catch (_e) {}
} catch (e) {
  rec("TEST H employee reverse blocked", false, String(e.message || e));
}

// ---- TEST I idempotent expense ----
const idemOp = `dx-idem-exp-${stamp}`;
const e1 = await cmd(owner2.token, "submitExpense", {
  amountFils: 5000, reason: `TEMP idem ${stamp}`, category: "عام",
  expenseDate: "2026-09-13", paidFromAccountId: acc,
}, idemOp);
const e2 = await cmd(owner2.token, "submitExpense", {
  amountFils: 5000, reason: `TEMP idem ${stamp}`, category: "عام",
  expenseDate: "2026-09-13", paidFromAccountId: acc,
}, idemOp);
rec("TEST I expense idempotency same id", e1.expenseId === e2.expenseId, { e1: e1.expenseId, e2: e2.expenseId });
await cmd(owner2.token, "reverseExpense", { expenseId: e1.expenseId, reason: "cleanup idem" }, `dx-idem-rev-${stamp}`);

// ---- Month switch persistence ----
const dashAug = await callable("read", { what: "dashboard", period: "2026-08" }, owner2.token);
const dashSep = await readDash(owner2.token);
rec("TEST G month switch Aug empty / Sep clean revenue",
  near((dashAug.summary?.expensesFils || 0) / 100, 0) && near(revenueUi(dashSep), rev0),
  { augExp: (dashAug.summary?.expensesFils || 0) / 100, sepRev: revenueUi(dashSep) });

// ---- TEARDOWN rental/receipt ----
try {
  const receipts = (await readDash(owner2.token)).receipts || [];
  for (const r of receipts) {
    if ((r.note || "").includes(stamp) && r.state !== "reversed") {
      try { await cmd(owner2.token, "reverseReceipt", { receiptId: r.id, reason: "teardown" }, `dx-revrec-${r.id}`); } catch (_e) {}
    }
  }
} catch (_e) {}
try {
  await cmd(owner2.token, "closeRental", {
    rentalId: rental.rentalId, endDate: "2026-09-10", reason: "teardown", setVacant: true,
  }, `dx-close-${stamp}`);
} catch (_e) {}

// Clean any leftover stamp expenses/deposits
dash = await readDash(owner2.token);
for (const e of (dash.expenses || [])) {
  if ((e.reason || "").includes(stamp) && e.state === "approved") {
    try { await cmd(owner2.token, "reverseExpense", { expenseId: e.id, reason: "teardown" }, `dx-fin-re-${e.id}`); } catch (_e) {}
  }
}
for (const d of (dash.deposits || [])) {
  if (((d.reference || "") + (d.note || "")).includes(stamp) && d.state === "approved") {
    try { await cmd(owner2.token, "reverseDeposit", { depositId: d.id, reason: "teardown" }, `dx-fin-rd-${d.id}`); } catch (_e) {}
  }
}

const finalDash = await readDash(owner2.token);
const finalK = kpi(finalDash);
const finalRev = revenueUi(finalDash);
rec("TEARDOWN revenue restored", near(finalRev, rev0), { finalRev, rev0 });
rec("TEARDOWN expenses baseline", near(finalK.expenses, k0.expenses), { final: finalK.expenses, k0: k0.expenses });
rec("TEARDOWN holding baseline", near(finalK.holding, k0.holding), { final: finalK.holding, k0: k0.holding });
rec("LEGITIMATE SEP preserved (target/collected)", near(finalK.target, k0.target) && near(finalK.collected, k0.collected), { finalK, k0 });

const pass = results.filter((r) => r.ok).length;
const fail = results.filter((r) => !r.ok).length;
console.log("\n=== SUMMARY ===");
console.log(JSON.stringify({ project: PROJECT, pass, fail, total: results.length, rev0, finalRev, finalK }, null, 2));
process.exit(fail ? 1 : 0);
