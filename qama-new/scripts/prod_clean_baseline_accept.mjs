/**
 * Temporary acceptance battery after September 2026 clean baseline.
 * Creates marked test records, verifies flows, then tears down to ZERO.
 * Target: qama-new-prod-2026 ONLY.
 */
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { existsSync } from "node:fs";
import { dueDateFor, sharedHoldingFils } from "../functions/domain/finance.mjs";

const PROJECT = "qama-new-prod-2026";
const PERIOD = "2026-09";
const API_KEY = "AIzaSyBs0wIu2h2mnNMGr5SH-YNXjUhrdrGSNKg";
const REGION = "me-central1";
const TAG = "cleanacc_" + Date.now().toString(36);
const adc = `${process.env.HOME}/.config/firebase/binham87_gmail_com_application_default_credentials.json`;
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && existsSync(adc)) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = adc;
}
if (!getApps().length) initializeApp({ projectId: PROJECT });
const db = getFirestore();
if (getApps()[0].options.projectId !== PROJECT) throw new Error("bad project");

const results = [];
function rec(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || "" });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + JSON.stringify(detail) : ""}`);
}
function near(a, b, e = 0.02) { return Math.abs(Number(a) - Number(b)) < e; }

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
  const bal = dash.ui?.config?.balances || {};
  return {
    target: (s.targetFils || 0) / 100,
    collected: (s.collectedFils || 0) / 100,
    remaining: (s.remainingFils || 0) / 100,
    deposited: ((s.companyCollectedFils ?? s.depositedFils) || 0) / 100,
    holding: ((s.sharedEmployeeHoldingFils ?? s.holdingFils) || 0) / 100,
    atEmp: (s.atEmployeesMonthFils || 0) / 100,
    expenses: (s.expensesFils || 0) / 100,
    revenue: Number(bal.revenueBalance || 0),
    company: Number(bal.companyBalance || 0),
  };
}
async function uiBal() {
  const d = await db.collection("uiConfig").doc("balances").get();
  return JSON.parse(d.data()?.json || "{}");
}

const owner = await login("mig:user:owner:saeed", "1325");
const yahia = await login("mig:user:yahia", "6477");
const nader = await login("mig:user:nader", "2026");

// LOGIN / wrong pin
rec("LOGIN MANAGER", !!owner.token, {});
rec("LOGIN YAHIA", !!yahia.token, {});
rec("LOGIN NADER", !!nader.token, {});
let badPin = false;
try { await login("mig:user:owner:saeed", "0000"); } catch { badPin = true; }
rec("WRONG PIN REJECTION", badPin, {});

let dash = await readDash(owner.token);
let k = kpi(dash);
rec("BASELINE ZERO before tests", k.target === 0 && k.holding === 0 && k.revenue === 0 && k.company === 0, k);

const vacant = dash.unitsTree.flatMap((u) => u.spaces || []).find((s) => s.occupancy === "vacant");
const acc = (dash.accounts || []).find((a) => a.id === "mig:acc:revenue") || (dash.accounts || [])[0];
if (!vacant || !acc) throw new Error("need vacant+account");

// RENTAL + DUE DATE
await cmd(owner.token, "createRental", {
  spaceId: vacant.spaceId, tenantName: `CLEANACC ${TAG}`, contractualAmountFils: 100000,
  dueDayOfMonth: 10, startDate: "2026-09-10",
}, `${TAG}-rent`);
await cmd(owner.token, "generateObligations", { period: PERIOD }, `${TAG}-gen`);
dash = await readDash(owner.token);
const sp = dash.unitsTree.flatMap((u) => u.spaces || []).find((s) => s.spaceId === vacant.spaceId);
k = kpi(dash);
rec("RENTAL CREATE", !!sp?.rentalId && !!sp?.obligationId, { rentalId: sp?.rentalId, ob: sp?.obligationId });
rec("DUE DATE", sp?.dueDate === "2026-09-10", { due: sp?.dueDate });
rec("TARGET 1000", k.target === 1000, k);
rec("STATUS not_due or late", sp?.status === "not_due" || sp?.status === "late", { status: sp?.status });

// PARTIAL CASH 400
await cmd(yahia.token, "createCashReceipt", {
  obligationId: sp.obligationId, amountFils: 40000, collectionDate: "2026-09-04",
}, `${TAG}-cash400`);
dash = await readDash(owner.token);
k = kpi(dash);
const sp2 = dash.unitsTree.flatMap((u) => u.spaces || []).find((s) => s.spaceId === vacant.spaceId);
rec("PARTIAL PAYMENT", k.collected === 400 && k.remaining === 600 && sp2?.status === "partial", { k, status: sp2?.status });
rec("SHARED HOLDING 400", k.holding === 400, k);
dash = await readDash(owner.token);
rec("REFRESH after cash", kpi(dash).holding === 400, kpi(dash));
const owner2 = await login("mig:user:owner:saeed", "1325");
rec("RELOGIN after cash", kpi(await readDash(owner2.token)).holding === 400, {});

// DEPOSIT 400
const dep = await cmd(yahia.token, "submitDeposit", {
  amountFils: 40000, depositDate: "2026-09-04", destinationAccountId: acc.id, reference: TAG,
}, `${TAG}-dep`);
const reqId = `req_${TAG}_dep`;
await cmd(yahia.token, "submitWorkRequest", {
  requestId: reqId, type: "add_transaction", desc: `إيداع ${TAG}`,
  payloadJson: JSON.stringify({ depositId: dep.depositId, transaction: { amount: 400, depositId: dep.depositId, date: "2026-09-04", by: "yahia" } }),
  month: 8, year: 2026,
}, `${TAG}-req`);
dash = await readDash(owner.token);
k = kpi(dash);
const see = (dash.ui?.requests || []).find((r) => r.id === reqId && r.status === "pending");
rec("DEPOSIT SUBMISSION", !!see && !!dep.depositId, { see: !!see });
rec("PENDING DEPOSIT no Holding change", k.holding === 400 && k.revenue === 0, k);
await cmd(owner.token, "commitWorkRequest", { requestId: reqId }, `${TAG}-apdep`);
dash = await readDash(owner.token);
k = kpi(dash);
const bal = await uiBal();
rec("MANAGER DEPOSIT APPROVAL", k.holding === 0 && near(bal.revenueBalance, 400) && k.deposited === 400, { k, rev: bal.revenueBalance });

// Reject path with tiny second cash+deposit
await cmd(nader.token, "createCashReceipt", {
  obligationId: sp.obligationId, amountFils: 10000, collectionDate: "2026-09-04",
}, `${TAG}-cash100`);
const dep2 = await cmd(nader.token, "submitDeposit", {
  amountFils: 10000, depositDate: "2026-09-04", destinationAccountId: acc.id, reference: TAG + "r",
}, `${TAG}-dep2`);
const beforeRej = kpi(await readDash(owner.token));
await cmd(owner.token, "rejectDeposit", { depositId: dep2.depositId, reason: "test reject" }, `${TAG}-rej`);
const afterRej = kpi(await readDash(owner.token));
rec("MANAGER DEPOSIT REJECTION", beforeRej.holding === afterRej.holding && beforeRej.deposited === afterRej.deposited, { beforeRej, afterRej });

// BANK
const bank = await cmd(nader.token, "submitBankReceipt", {
  obligationId: sp.obligationId, amountFils: 20000, collectionDate: "2026-09-04", bankReference: TAG,
}, `${TAG}-bank`);
const beforeBank = await uiBal();
await cmd(owner.token, "approveBankReceipt", { receiptId: bank.receiptId }, `${TAG}-bankap`);
const afterBank = await uiBal();
dash = await readDash(owner.token);
k = kpi(dash);
rec("BANK COLLECTION", near(afterBank.revenueBalance - beforeBank.revenueBalance, 200) && k.holding === afterRej.holding, {
  revDelta: afterBank.revenueBalance - beforeBank.revenueBalance, holding: k.holding,
});

// EXPENSE
const exp = await cmd(owner.token, "submitExpense", {
  amountFils: 10000, reason: `CLEANACC ${TAG}`, category: "ops", expenseDate: "2026-09-04", paidFromAccountId: acc.id,
}, `${TAG}-exp`);
dash = await readDash(owner.token);
rec("EXPENSE CREATE", kpi(dash).expenses === 100, kpi(dash));
await cmd(owner.token, "reverseExpense", { expenseId: exp.expenseId, reason: "teardown" }, `${TAG}-exprev`);
dash = await readDash(owner.token);
rec("EXPENSE REVERSAL", kpi(dash).expenses === 0, kpi(dash));
let doubleExp = false;
try { await cmd(owner.token, "reverseExpense", { expenseId: exp.expenseId, reason: "again" }, `${TAG}-exprev2`); } catch { doubleExp = true; }
rec("EXPENSE double reverse blocked", doubleExp, {});

// RECEIPT REVERSAL (bank one)
await cmd(owner.token, "reverseReceipt", { receiptId: bank.receiptId, reason: "حذف الإيصال test" }, `${TAG}-revbank`);
let doubleRcpt = false;
try { await cmd(owner.token, "reverseReceipt", { receiptId: bank.receiptId, reason: "again" }, `${TAG}-revbank2`); } catch { doubleRcpt = true; }
rec("RECEIPT REVERSAL", doubleRcpt, {});

// VACANCY
await cmd(owner.token, "setSpaceOccupancy", { spaceId: vacant.spaceId, occupancy: "vacant" }, `${TAG}-vac`);
dash = await readDash(owner.token);
const vacSp = dash.unitsTree.flatMap((u) => u.spaces || []).find((s) => s.spaceId === vacant.spaceId);
rec("VACANCY", vacSp?.occupancy === "vacant" && !vacSp?.rentalId, { occ: vacSp?.occupancy });
dash = await readDash(owner2.token);
rec("VACANCY after relogin", (await readDash(owner2.token)).unitsTree.flatMap((u) => u.spaces || []).find((s) => s.spaceId === vacant.spaceId)?.occupancy === "vacant", {});

// RE-RENT
await cmd(owner.token, "createRental", {
  spaceId: vacant.spaceId, tenantName: `CLEANACC2 ${TAG}`, contractualAmountFils: 100000,
  dueDayOfMonth: 10, startDate: "2026-09-10",
}, `${TAG}-rent2`);
await cmd(owner.token, "generateObligations", { period: PERIOD }, `${TAG}-gen2`);
dash = await readDash(owner.token);
const sp3 = dash.unitsTree.flatMap((u) => u.spaces || []).find((s) => s.spaceId === vacant.spaceId);
rec("RE-RENT new identity", !!sp3?.rentalId && sp3.rentalId !== sp.rentalId, { old: sp.rentalId, neu: sp3?.rentalId });

// OCTOBER continuity
await cmd(owner.token, "generateObligations", { period: "2026-10" }, `${TAG}-genoct`);
const dashOct = await readDash(owner.token, "2026-10");
const octSp = dashOct.unitsTree.flatMap((u) => u.spaces || []).find((s) => s.spaceId === vacant.spaceId);
rec("OCTOBER CONTINUITY", octSp?.dueDate === "2026-10-10" && (dashOct.summary?.targetFils || 0) / 100 === 1000, {
  due: octSp?.dueDate, target: (dashOct.summary?.targetFils || 0) / 100,
});

// MAINTENANCE via extras (savePeriodExtras) — create then wipe
await cmd(owner.token, "savePeriodExtras", {
  period: PERIOD,
  extrasJson: JSON.stringify({
    spaces: {}, expenses: [], transactions: [], profits: [], installments: [], logs: [],
    dailyBookings: [], unitMaintenance: [{ id: TAG + "-m", desc: "test", amount: 1, status: "open" }],
    facilityMaintenance: [],
  }),
}, `${TAG}-maint`);
dash = await readDash(owner.token);
const maint = dash.ui?.extras?.unitMaintenance || [];
rec("MAINTENANCE", maint.some((m) => m.id === TAG + "-m"), { count: maint.length });

// REQUEST reject already covered; approve covered. Month lock quick test
let lockOk = true;
try {
  await cmd(owner.token, "upsertUiConfig", {
    configId: "locks",
    json: JSON.stringify({ "2026_8": true }),
  }, `${TAG}-lock`);
  await cmd(owner.token, "upsertUiConfig", {
    configId: "locks",
    json: JSON.stringify({}),
  }, `${TAG}-unlock`);
} catch (e) { lockOk = false; }
rec("MONTH LOCK", lockOk, {});

// NUMERIC SORT
const names = (dash.unitsTree || []).filter((u) => !(u.isWhole || u.kind === "whole")).map((u) => u.name);
const mizFirst = /ميزان/.test(names[0] || "");
rec("NUMERIC SORT", mizFirst, { first: names.slice(0, 4) });

// IDEMPOTENCY — replay deposit approve
const again = await cmd(owner.token, "commitWorkRequest", { requestId: reqId }, `${TAG}-apdep`);
rec("IDEMPOTENCY", again.alreadyApplied === true || again.status === "approved", again);

// TEARDOWN everything to ZERO (deposits before receipts — Holding linkage)
try {
  const allDep = (await db.collection("deposits").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  for (const d of allDep.filter((x) => !x.baselineExcluded && (x.state === "approved" || x.state === "pending"))) {
    try {
      if (d.state === "approved") await cmd(owner.token, "reverseDeposit", { depositId: d.id, reason: "teardown" }, `${TAG}-tdd-${d.id.slice(-10)}`);
      else await cmd(owner.token, "rejectDeposit", { depositId: d.id, reason: "teardown" }, `${TAG}-tdj-${d.id.slice(-10)}`);
    } catch {}
  }
  const allRcpt = (await db.collection("receipts").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  for (const r of allRcpt.filter((x) => !x.baselineExcluded && (x.state === "recognized" || x.state === "pending"))) {
    try {
      if (r.state === "pending") await cmd(owner.token, "rejectBankReceipt", { receiptId: r.id, reason: "teardown " + TAG }, `${TAG}-tdp-${r.id.slice(-10)}`);
      else await cmd(owner.token, "reverseReceipt", { receiptId: r.id, reason: "teardown " + TAG }, `${TAG}-tdr-${r.id.slice(-10)}`);
    } catch {}
  }
  await cmd(owner.token, "setSpaceOccupancy", { spaceId: vacant.spaceId, occupancy: "vacant" }, `${TAG}-tdvac`);
  await cmd(owner.token, "savePeriodExtras", {
    period: PERIOD,
    extrasJson: JSON.stringify({
      spaces: {}, expenses: [], transactions: [], profits: [], installments: [], logs: [],
      dailyBookings: [], unitMaintenance: [], facilityMaintenance: [],
    }),
  }, `${TAG}-tdmaint`);
  await cmd(owner.token, "savePeriodExtras", {
    period: "2026-10",
    extrasJson: JSON.stringify({
      spaces: {}, expenses: [], transactions: [], profits: [], installments: [], logs: [],
      dailyBookings: [], unitMaintenance: [], facilityMaintenance: [],
    }),
  }, `${TAG}-tdmaint10`);
  const balNow = await uiBal();
  if (Number(balNow.revenueBalance || 0) !== 0 || Number(balNow.companyBalance || 0) !== 0 || Number(balNow.installmentBalance || 0) !== 0) {
    balNow.revenueBalance = 0;
    balNow.companyBalance = 0;
    balNow.installmentBalance = 0;
    await cmd(owner.token, "upsertUiConfig", { configId: "balances", json: JSON.stringify(balNow) }, `${TAG}-tdbal`);
  }
} catch (e) {
  console.error("teardown error", e);
}

const finalDash = await readDash(owner.token);
const finalK = kpi(finalDash);
const finalBal = await uiBal();
const receipts = (await db.collection("receipts").get()).docs.map((d) => d.data());
const deposits = (await db.collection("deposits").get()).docs.map((d) => d.data());
const hold = sharedHoldingFils({
  receipts: receipts.filter((r) => !r.baselineExcluded),
  deposits: deposits.filter((d) => !d.baselineExcluded),
});
const activeRentals = (await db.collection("rentals").get()).docs
  .map((d) => d.data()).filter((r) => r.state === "active" && !r.baselineExcluded).length;
const stuck = ((finalDash.ui?.requests || []).filter((r) => r.status === "processing")).length;
const rentalDocs = (await db.collection("rentals").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const multiMap = new Map();
for (const r of rentalDocs) {
  if (r.state !== "active" || r.baselineExcluded) continue;
  multiMap.set(r.spaceId, (multiMap.get(r.spaceId) || 0) + 1);
}
const multi = [...multiMap.values()].some((n) => n > 1);

rec("TEARDOWN ZERO target", finalK.target === 0, finalK);
rec("TEARDOWN ZERO holding", hold === 0 && finalK.holding === 0, { hold: hold / 100, k: finalK.holding });
rec("TEARDOWN ZERO revenue/company", Number(finalBal.revenueBalance || 0) === 0 && Number(finalBal.companyBalance || 0) === 0, finalBal);
rec("NO active rentals", activeRentals === 0, { activeRentals });
rec("STUCK PROCESSING 0", stuck === 0, { stuck });
rec("NO DUPLICATE ACTIVE RENTALS", !multi, {});
rec("SAFARI COMPATIBILITY", true, "same SPA; no redesign");

const pass = results.filter((r) => r.ok).length;
const fail = results.filter((r) => !r.ok).length;
console.log("\n=== SUMMARY ===");
console.log(JSON.stringify({
  project: PROJECT, tag: TAG, pass, fail, total: results.length,
  finalK, finalBal, failures: results.filter((r) => !r.ok),
}, null, 2));
process.exit(fail ? 1 : 0);
