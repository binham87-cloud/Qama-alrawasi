/**
 * Final financial reconciliation acceptance — Holding >= 0, Revenue explained,
 * deposit>holding reject, reverse paths, expense/maintenance revenue once.
 * Temp data fully torn down. Target: qama-new-prod-2026 ONLY.
 */
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { existsSync } from "node:fs";
import { sharedHoldingFils } from "../functions/domain/finance.mjs";

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
async function readDash(token, period = PERIOD) {
  return callable("read", { what: "dashboard", period }, token);
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
    revenue: Number(dash?.ui?.config?.balances?.revenueBalance || 0),
  };
}
function bankId(dash) {
  return (dash.accounts || []).find((a) => a.id === "mig:acc:revenue")?.id
    || (dash.accounts || []).find((a) => a.kind === "bank")?.id
    || "mig:acc:revenue";
}

const stamp = `rc${Date.now().toString(36)}`;
const owner = await login("mig:user:owner:saeed", "1325");
const yahia = await login("mig:user:yahia", "6477");
const nader = await login("mig:user:nader", "2026");

let dash = await readDash(owner.token);
let k = kpi(dash);
rec("BASE Holding >= 0", k.holding >= 0, k);
rec("BASE Revenue explained (=0 after repair)", near(k.revenue, 0), k);
rec("BASE Target/Collected/Remaining/Expenses zero",
  near(k.target, 0) && near(k.collected, 0) && near(k.remaining, 0) && near(k.expenses, 0), k);

const receipts0 = (await db.collection("receipts").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const deposits0 = (await db.collection("deposits").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const holdEq = sharedHoldingFils({ receipts: receipts0, deposits: deposits0 });
rec("HOLDING EQUATION matches read", near(holdEq / 100, k.holding), { holdEq: holdEq / 100, kHold: k.holding });
rec("NO live approved deposits", deposits0.filter((d) => d.state === "approved").length === 0,
  deposits0.filter((d) => d.state === "approved").map((d) => d.id));
rec("NO live recognized cash", receipts0.filter((r) => r.method === "cash" && r.state === "recognized").length === 0);

// Count TEMP / dx docs (all states)
const tempReceipts = receipts0.filter((r) => /TEMP|dx-/i.test(JSON.stringify(r)));
const tempDeps = deposits0.filter((d) => /TEMP|dx-|restore-dep-Q/i.test(JSON.stringify(d)));
const tempExps = (await db.collection("expenses").get()).docs
  .map((d) => ({ id: d.id, ...d.data() }))
  .filter((e) => /TEMP|dx-/i.test(JSON.stringify(e)));
const liveTemp = [...tempReceipts, ...tempDeps, ...tempExps].filter((x) =>
  x.state === "approved" || x.state === "recognized" || x.state === "pending");
rec("TEMP live financial effects = 0", liveTemp.length === 0, liveTemp.map((x) => x.id));
console.log("TEMP_RECORDS_FOUND", {
  receipts: tempReceipts.length, deposits: tempDeps.length, expenses: tempExps.length,
  live: liveTemp.length,
  ids: { r: tempReceipts.map((x) => x.id), d: tempDeps.map((x) => x.id), e: tempExps.map((x) => x.id) },
});

// Q deposit audit
const qDeps = deposits0.filter((d) => String(d.reference || "") === "Q" || String(d.note || "") === "Q");
rec("DEPOSIT Q duplicate approved count = 0", qDeps.filter((d) => d.state === "approved").length === 0, qDeps.map((d) => ({ id: d.id, state: d.state })));

const vacant = (dash.unitsTree || []).flatMap((u) => (u.spaces || []).map((s) => ({ ...s, unitName: u.name })))
  .find((s) => s.occupancy === "vacant" || (!s.rentalId && s.occupancy !== "staff"));
if (!vacant) {
  rec("FIND vacant", false, "none");
  console.log(JSON.stringify({ pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length }, null, 2));
  process.exit(1);
}
const acc = bankId(dash);

const rental = await cmd(owner.token, "createRental", {
  spaceId: vacant.spaceId,
  tenantName: `TEMP-RC-${stamp}`,
  contractualAmountFils: 100000,
  startDate: "2026-09-10",
  dueDayOfMonth: 10,
}, `rc-rent-${stamp}`);
await cmd(owner.token, "generateObligations", { period: PERIOD }, `rc-gen-${stamp}`);
dash = await readDash(owner.token);
const space = (dash.unitsTree || []).flatMap((u) => u.spaces || []).find((s) => s.rentalId === rental.rentalId);
const obligationId = space?.obligationId;
rec("TEMP rental ready", !!obligationId, { rentalId: rental.rentalId, obligationId });

// Cash 100 → Holding 100
await cmd(owner.token, "createCashReceipt", {
  obligationId, amountFils: 10000, collectionDate: "2026-09-10",
  note: `TEMP rc cash ${stamp}`, collectorUserId: "mig:user:yahia",
}, `rc-cash-${stamp}`);
dash = await readDash(owner.token);
k = kpi(dash);
rec("Cash 100 → Holding 100", near(k.holding, 100) && near(k.collected, 100), k);

// APPROVE DEPOSIT > HOLDING must FAIL
let overHoldRejected = false;
try {
  await cmd(owner.token, "submitDeposit", {
    amountFils: 20000, depositDate: "2026-09-11", destinationAccountId: acc,
    note: `TEMP over ${stamp}`, reference: `TEMP-OVER-${stamp}`,
    employeeId: "mig:user:yahia",
  }, `rc-over-${stamp}`);
} catch (e) {
  overHoldRejected = /AMOUNT_exceeds_holding|AMOUNT_exceeds_holding|AMOUNT exceeds/i.test(String(e.message || e))
    || /AMOUNT_EXCEEDS_HOLDING/i.test(String(e.message || e));
  rec("APPROVE DEPOSIT > HOLDING", overHoldRejected, String(e.message || e));
}
if (!overHoldRejected) {
  rec("APPROVE DEPOSIT > HOLDING", false, "accepted 20 when holding 10");
}
dash = await readDash(owner.token);
k = kpi(dash);
rec("After rejected oversize: Holding still 100, Revenue 0", near(k.holding, 100) && near(k.revenue, 0), k);

// Valid deposit 40
const dep = await cmd(owner.token, "submitDeposit", {
  amountFils: 4000, depositDate: "2026-09-11", destinationAccountId: acc,
  note: `TEMP ok ${stamp}`, reference: `TEMP-OK-${stamp}`,
  employeeId: "mig:user:yahia",
}, `rc-dep-${stamp}`);
dash = await readDash(owner.token);
k = kpi(dash);
rec("DEPOSIT 40: Holding 60 Revenue 40", near(k.holding, 60) && near(k.revenue, 40), k);
rec("REVENUE EXACTLY-ONCE on deposit", near(k.revenue, 40), k.revenue);

// Path A: deposit reverse then receipt reverse
await cmd(owner.token, "reverseDeposit", {
  depositId: dep.depositId, reason: `rc revdep ${stamp}`,
}, `rc-revdep-${stamp}`);
dash = await readDash(owner.token);
k = kpi(dash);
rec("DEPOSIT REVERSAL restores Holding/Revenue", near(k.holding, 100) && near(k.revenue, 0), k);

let doubleRev = false;
try {
  await cmd(owner.token, "reverseDeposit", {
    depositId: dep.depositId, reason: "again",
  }, `rc-revdep2-${stamp}`);
  doubleRev = true;
} catch (e) {
  rec("DOUBLE-REVERSAL deposit", /ALREADY_REVERSED/i.test(String(e.message || e)), String(e.message || e));
}
if (doubleRev) rec("DOUBLE-REVERSAL deposit", false, "accepted");

const cashId = `rcpt:rc-cash-${stamp}`;
await cmd(owner.token, "reverseReceipt", {
  receiptId: cashId, reason: `rc revrec after dep ${stamp}`,
}, `rc-revrec-${stamp}`);
dash = await readDash(owner.token);
k = kpi(dash);
rec("RECEIPT REVERSAL AFTER DEPOSIT REVERSAL Holding 0", near(k.holding, 0) && near(k.collected, 0), k);

// Path B: cash then reverse receipt before deposit
await cmd(owner.token, "createCashReceipt", {
  obligationId, amountFils: 5000, collectionDate: "2026-09-12",
  note: `TEMP rc cashB ${stamp}`, collectorUserId: "mig:user:nader",
}, `rc-cashB-${stamp}`);
dash = await readDash(owner.token);
rec("Path B cash Holding 50", near(kpi(dash).holding, 50), kpi(dash));
await cmd(owner.token, "reverseReceipt", {
  receiptId: `rcpt:rc-cashB-${stamp}`, reason: `rc pathB ${stamp}`,
}, `rc-revrecB-${stamp}`);
dash = await readDash(owner.token);
rec("Path B receipt reverse before deposit Holding 0", near(kpi(dash).holding, 0), kpi(dash));

// Expense / maintenance revenue
const revBefore = kpi(dash).revenue;
const exp = await cmd(owner.token, "submitExpense", {
  amountFils: 1000, reason: `TEMP rc exp ${stamp}`, category: "عام",
  expenseDate: "2026-09-12", paidFromAccountId: acc,
}, `rc-exp-${stamp}`);
dash = await readDash(owner.token);
rec("EXPENSE REVENUE DEBIT", near(kpi(dash).revenue, revBefore - 10) && near(kpi(dash).expenses, 10), kpi(dash));
await cmd(owner.token, "reverseExpense", {
  expenseId: exp.expenseId, reason: `rc revexp ${stamp}`,
}, `rc-revexp-${stamp}`);
dash = await readDash(owner.token);
rec("EXPENSE REVERSAL RESTORE", near(kpi(dash).revenue, revBefore) && near(kpi(dash).expenses, 0), kpi(dash));

const maint = await cmd(owner.token, "submitExpense", {
  amountFils: 2000, reason: `TEMP rc maint ${stamp}`, category: "صيانة",
  expenseDate: "2026-09-12", paidFromAccountId: acc, maintenanceLinkId: `m-${stamp}`,
}, `rc-maint-${stamp}`);
dash = await readDash(owner.token);
rec("MAINTENANCE REVENUE DEBIT", near(kpi(dash).revenue, revBefore - 20) && near(kpi(dash).expenses, 20), kpi(dash));
await cmd(owner.token, "reverseExpense", {
  expenseId: maint.expenseId, reason: `rc revmaint ${stamp}`,
}, `rc-revmaint-${stamp}`);
dash = await readDash(owner.token);
rec("MAINTENANCE REVERSAL RESTORE", near(kpi(dash).revenue, revBefore) && near(kpi(dash).expenses, 0), kpi(dash));

// Teardown rental
try {
  await cmd(owner.token, "closeRental", {
    rentalId: rental.rentalId, endDate: "2026-09-12", reason: "rc teardown", setVacant: true,
  }, `rc-close-${stamp}`);
} catch (e) { console.log("close", e.message); }

// Reverse any leftover live TEMP
dash = await readDash(owner.token);
for (const e of (dash.expenses || [])) {
  if (/TEMP rc/i.test(e.reason || "") && e.state === "approved") {
    try { await cmd(owner.token, "reverseExpense", { expenseId: e.id, reason: "teardown" }, `rc-fin-e-${e.id}`); } catch (_e) {}
  }
}
for (const d of (dash.deposits || [])) {
  if (/TEMP/i.test(`${d.reference || ""}${d.note || ""}`) && d.state === "approved") {
    try { await cmd(owner.token, "reverseDeposit", { depositId: d.id, reason: "teardown" }, `rc-fin-d-${d.id}`); } catch (_e) {}
  }
}
for (const r of (dash.receipts || [])) {
  if (/TEMP rc/i.test(r.note || "") && r.state === "recognized") {
    try { await cmd(owner.token, "reverseReceipt", { receiptId: r.id, reason: "teardown" }, `rc-fin-r-${r.id}`); } catch (_e) {}
  }
}

// Multi-user + month switch + relogin
const owner2 = await login("mig:user:owner:saeed", "1325");
const y2 = await login("mig:user:yahia", "6477");
const n2 = await login("mig:user:nader", "2026");
const kOwner = kpi(await readDash(owner2.token));
const kY = kpi(await readDash(y2.token));
const kN = kpi(await readDash(n2.token));
const kAug = kpi(await readDash(owner2.token, "2026-08"));
const kOct = kpi(await readDash(owner2.token, "2026-10"));
const kSep2 = kpi(await readDash(owner2.token, "2026-09"));

rec("MANAGER FINAL Holding>=0 Revenue0 zeros",
  kOwner.holding >= 0 && near(kOwner.holding, 0) && near(kOwner.revenue, 0)
  && near(kOwner.target, 0) && near(kOwner.collected, 0) && near(kOwner.expenses, 0), kOwner);
rec("YAHIA FINAL totals aligned",
  near(kY.target, kOwner.target) && near(kY.collected, kOwner.collected) && near(kY.holding, kOwner.holding), kY);
rec("NADER FINAL totals aligned",
  near(kN.target, kOwner.target) && near(kN.collected, kOwner.collected) && near(kN.holding, kOwner.holding), kN);
rec("MONTH Aug empty", near(kAug.target, 0) && near(kAug.expenses, 0), kAug);
rec("MONTH Oct clean", near(kOct.target, 0), kOct);
rec("MONTH Sep after switch", near(kSep2.holding, 0) && near(kSep2.revenue, 0), kSep2);

const pass = results.filter((r) => r.ok).length;
const fail = results.filter((r) => !r.ok).length;
console.log("\n=== SUMMARY ===");
console.log(JSON.stringify({
  project: PROJECT, pass, fail, total: results.length,
  manager: kOwner, yahia: kY, nader: kN,
  failures: results.filter((r) => !r.ok),
}, null, 2));
process.exit(fail ? 1 : 0);
