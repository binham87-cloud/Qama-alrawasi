/**
 * Production acceptance: employee deposit → Manager visibility + 4-bucket finance.
 * Safe temp data; tears down. Target: qama-new-prod-2026 only.
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
    collected: ((s.companyCollectedFils ?? s.depositedFils) || 0) / 100,
    atEmp: (s.atEmployeesMonthFils || 0) / 100,
    unpaid: ((s.tenantUnpaidFils ?? s.remainingFils) || 0) / 100,
    holding: ((s.sharedEmployeeHoldingFils ?? s.holdingFils) || 0) / 100,
  };
}
function eqOk(k) {
  return Math.abs(k.target - (k.collected + k.atEmp + k.unpaid)) < 0.02;
}

const stamp = Date.now().toString(36);
const owner = await login("mig:user:owner:saeed", "1325");
const yahia = await login("mig:user:yahia", "6477");
const nader = await login("mig:user:nader", "2026");

// --- Repair orphan pending work request (10500 > holding) ---
const ownerDash0 = await readDash(owner.token);
const failedReq = (ownerDash0.ui?.requests || []).find((r) =>
  r.type === "add_transaction" && r.status === "pending" && Number(r.payload?.transaction?.amount) === 10500);
if (failedReq) {
  try {
    await cmd(owner.token, "resolveWorkRequest", {
      requestId: failedReq.id, decision: "rejected",
    }, `rej-orphan-${stamp}`);
    rec("REPAIR orphan 10500 request → rejected", true, failedReq.id);
  } catch (e) {
    rec("REPAIR orphan 10500 request → rejected", false, String(e.message || e));
  }
} else {
  rec("REPAIR orphan 10500 request → rejected", true, "none pending");
}

// Stuck processing partition request
const stuck = (ownerDash0.ui?.requests || []).find((r) => r.status === "processing");
if (stuck) {
  try {
    await cmd(owner.token, "resolveWorkRequest", {
      requestId: stuck.id, decision: "rejected",
    }, `rej-stuck-${stamp}`);
    rec("REPAIR stuck processing request", true, stuck.id);
  } catch (e) {
    rec("REPAIR stuck processing request", false, String(e.message || e));
  }
}

const acc = (ownerDash0.accounts || []).find((a) => a.kind === "bank") || (ownerDash0.accounts || [])[0];
const space = ownerDash0.unitsTree.flatMap((u) => u.spaces).find((s) => s.occupancy === "vacant");
if (!space || !acc) throw new Error("need vacant space + account");

// A) Create rental 1400
const rental = await cmd(owner.token, "createRental", {
  spaceId: space.spaceId, tenantName: "قبول إيداع", contractualAmountFils: 140000,
  dueDayOfMonth: 1, startDate: "2026-09-01",
}, `dep-rent-${stamp}`);
await cmd(owner.token, "generateObligations", { period: PERIOD }, `dep-gen-${stamp}`);
let dash = await readDash(owner.token);
const sp = dash.unitsTree.flatMap((u) => u.spaces).find((s) => s.spaceId === space.spaceId);
const obId = sp.obligationId;
rec("A create rental 1400", !!obId && kpi(dash).target === 1400, kpi(dash));

// B) Employee cash 1000
await cmd(yahia.token, "createCashReceipt", {
  obligationId: obId, amountFils: 100000, collectionDate: "2026-09-04",
}, `dep-cash-${stamp}`);
dash = await readDash(owner.token);
let k = kpi(dash);
rec("B cash 1000 → target 1400 collected 0 atEmp 1000 unpaid 400",
  k.target === 1400 && k.collected === 0 && k.atEmp === 1000 && k.unpaid === 400 && eqOk(k), k);

// C) Employee submitDeposit 600 pending — Manager must see
const dep = await cmd(yahia.token, "submitDeposit", {
  amountFils: 60000, depositDate: "2026-09-04", destinationAccountId: acc.id,
  reference: `acc-dep-${stamp}`, note: "قبول",
}, `dep-sub-${stamp}`);
const reqId = `req_dep_acc_${stamp}`;
await cmd(yahia.token, "submitWorkRequest", {
  requestId: reqId,
  type: "add_transaction",
  desc: `إيداع قبول: ${stamp} - 600 د.إ`,
  payloadJson: JSON.stringify({
    depositId: dep.depositId,
    transaction: { id: Date.now(), type: "عام", desc: `قبول ${stamp}`, amount: 600, date: "2026-09-04", by: "yahia", depositId: dep.depositId },
  }),
  month: 8, year: 2026,
}, `dep-req-${stamp}`);

dash = await readDash(owner.token);
k = kpi(dash);
const pendingDep = (dash.deposits || []).find((d) => d.id === dep.depositId);
const pendingAppr = (dash.pendingApprovals || []).find((p) => p.approvePayload?.depositId === dep.depositId);
const pendingReq = (dash.ui?.requests || []).find((r) => r.id === reqId && r.status === "pending");
rec("C pending deposit visible to Manager (deposit+approvals+request)",
  pendingDep?.state === "pending" && !!pendingAppr && !!pendingReq, {
    depState: pendingDep?.state, approval: !!pendingAppr, request: !!pendingReq, kpi: k,
  });
rec("C pending has zero financial effect",
  k.collected === 0 && k.atEmp === 1000 && k.unpaid === 400, k);

// D) Manager approve
const revAccBefore = (await db.collection("accounts").doc("mig:acc:revenue").get()).data();
const revBalBefore = Number(revAccBefore?.balanceFils || 0);
const uiBalBeforeDoc = await db.collection("uiConfig").doc("balances").get();
let uiRevBefore = 0;
try { uiRevBefore = Number(JSON.parse(uiBalBeforeDoc.data()?.json || "{}").revenueBalance || 0); } catch { /* ignore */ }

await cmd(owner.token, "commitWorkRequest", { requestId: reqId }, `dep-commit-${stamp}`);
dash = await readDash(owner.token);
k = kpi(dash);
rec("D approve → collected 600 atEmp 400 unpaid 400",
  k.target === 1400 && k.collected === 600 && k.atEmp === 400 && k.unpaid === 400 && eqOk(k), k);

const ledgerCredit = (await db.collection("ledgerEntries").doc(`ledger:deposit:${dep.depositId}:credit`).get()).data();
const revAccAfter = (await db.collection("accounts").doc("mig:acc:revenue").get()).data();
const revBalAfter = Number(revAccAfter?.balanceFils || 0);
const uiBalAfterDoc = await db.collection("uiConfig").doc("balances").get();
let uiRevAfter = 0;
try { uiRevAfter = Number(JSON.parse(uiBalAfterDoc.data()?.json || "{}").revenueBalance || 0); } catch { /* ignore */ }
rec("D revenue ledger credit once (+600)",
  ledgerCredit?.direction === "credit" && ledgerCredit?.amountFils === 60000 &&
  ledgerCredit?.accountId === "mig:acc:revenue" &&
  revBalAfter - revBalBefore === 60000,
  { ledgerCredit, revBalBefore, revBalAfter, uiRevBefore, uiRevAfter });
rec("D UI حساب الإيرادات +600",
  Math.abs((uiRevAfter - uiRevBefore) - 600) < 0.02,
  { uiRevBefore, uiRevAfter });

// E) Re-read
dash = await readDash(owner.token);
k = kpi(dash);
rec("E refresh persistence",
  k.target === 1400 && k.collected === 600 && k.atEmp === 400 && k.unpaid === 400, k);

// F) Second pending deposit reject
const dep2 = await cmd(yahia.token, "submitDeposit", {
  amountFils: 10000, depositDate: "2026-09-04", destinationAccountId: acc.id,
  reference: `acc-dep2-${stamp}`,
}, `dep-sub2-${stamp}`);
const before = kpi(await readDash(owner.token));
await cmd(owner.token, "rejectDeposit", { depositId: dep2.depositId, reason: "رفض قبول" }, `dep-rej-${stamp}`);
const after = kpi(await readDash(owner.token));
rec("F reject → no money change",
  before.collected === after.collected && before.atEmp === after.atEmp && before.holding === after.holding,
  { before, after });

// G) Double approve
const again = await cmd(owner.token, "commitWorkRequest", { requestId: reqId }, `dep-commit-${stamp}`);
dash = await readDash(owner.token);
k = kpi(dash);
rec("G double approve no duplicate",
  (again.alreadyApplied === true || again.status === "approved") && k.collected === 600, { again, k });

// Bank path
const bankSub = await cmd(nader.token, "submitBankReceipt", {
  obligationId: obId, amountFils: 20000, collectionDate: "2026-09-04",
  bankReference: `bank-${stamp}`,
}, `dep-bank-${stamp}`);
let kPend = kpi(await readDash(owner.token));
rec("BANK pending zero company collected change", kPend.collected === 600, kPend);
const bankRevBefore = Number((await db.collection("accounts").doc("mig:acc:revenue").get()).data()?.balanceFils || 0);
await cmd(owner.token, "approveBankReceipt", { receiptId: bankSub.receiptId }, `dep-bankap-${stamp}`);
dash = await readDash(owner.token);
k = kpi(dash);
rec("BANK approve → collected +200 (800), unpaid 200, atEmp 400",
  k.collected === 800 && k.atEmp === 400 && k.unpaid === 200 && eqOk(k), k);
const bankLedger = (await db.collection("ledgerEntries").doc(`ledger:bank_receipt:${bankSub.receiptId}:credit`).get()).data();
const bankRevAfter = Number((await db.collection("accounts").doc("mig:acc:revenue").get()).data()?.balanceFils || 0);
rec("BANK revenue ledger +200 once",
  bankLedger?.amountFils === 20000 && bankRevAfter - bankRevBefore === 20000,
  { bankLedger, bankRevBefore, bankRevAfter });

// Collector audit
const receipts = (await db.collection("receipts").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const yCash = receipts.filter((r) => r.state === "recognized" && r.method === "cash" && r.collectorUserId === "mig:user:yahia" && r.period === PERIOD)
  .reduce((s, r) => s + Number(r.amountFils || 0), 0);
const nBank = receipts.filter((r) => r.state === "recognized" && r.method === "bank" && r.collectorUserId === "mig:user:nader" && r.period === PERIOD)
  .reduce((s, r) => s + Number(r.amountFils || 0), 0);
rec("COLLECTOR audit yahia cash / nader bank", yCash >= 100000 && nBank >= 20000, { yCash: yCash / 100, nBank: nBank / 100 });

// Vacancy / ghost still dead
const activeGhost = (await db.collection("rentals").where("state", "==", "active").get()).docs
  .filter((d) => !d.data().tenantName || d.data().tenantName === "—").length;
rec("OLD ghost rentals still dead", activeGhost === 0, { activeGhost });

// Tear down
try {
  // reverse bank + cash on probe obligation, reverse deposit, cancel/close
  const liveRcpt = receipts.filter((r) => r.obligationId === obId && r.state === "recognized");
  for (const r of liveRcpt) {
    try { await cmd(owner.token, "reverseReceipt", { receiptId: r.id, reason: "teardown" }, `td-rev-${r.id.slice(-20)}`); } catch {}
  }
  const deps = (await db.collection("deposits").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  for (const d of deps.filter((x) => x.id === dep.depositId || x.id === dep2.depositId)) {
    try {
      if (d.state === "approved") await cmd(owner.token, "reverseDeposit", { depositId: d.id, reason: "teardown" }, `td-revd-${d.id.slice(-12)}`);
      else if (d.state === "pending") await cmd(owner.token, "rejectDeposit", { depositId: d.id, reason: "teardown" }, `td-rejd-${d.id.slice(-12)}`);
    } catch {}
  }
  await cmd(owner.token, "setSpaceOccupancy", { spaceId: space.spaceId, occupancy: "vacant" }, `td-vac-${stamp}`);
} catch (e) {
  console.error("teardown", e);
}

const finalDash = await readDash(owner.token);
const finalK = kpi(finalDash);
const allReceipts = (await db.collection("receipts").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const allDeps = (await db.collection("deposits").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const hold = sharedHoldingFils({ receipts: allReceipts, deposits: allDeps });
rec("TEARDOWN clean September target 0", finalK.target === 0, finalK);
rec("TEARDOWN holding preserved ~2600", Math.abs(hold / 100 - 2600) < 1, { hold: hold / 100 });

const pass = results.filter((r) => r.ok).length;
const fail = results.filter((r) => !r.ok).length;
console.log("\n=== SUMMARY ===");
console.log(JSON.stringify({ project: PROJECT, pass, fail, total: results.length, finalK, holding: hold / 100 }, null, 2));
process.exit(fail ? 1 : 0);
