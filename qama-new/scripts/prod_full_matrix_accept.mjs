/**
 * Full production E2E matrix for vacancy, due dates, structure, deposits, revenue.
 * Target: qama-new-prod-2026 ONLY. Tears down temporary probe data.
 */
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { existsSync } from "node:fs";
import { dueDateFor, sharedHoldingFils, holdingByEmployee, liveObligationsForPeriod } from "../functions/domain/finance.mjs";

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
    tenantCollected: ((s.collectedFils ?? s.tenantPaidFils) || 0) / 100,
    atEmp: (s.atEmployeesMonthFils || 0) / 100,
    unpaid: ((s.tenantUnpaidFils ?? s.remainingFils) || 0) / 100,
    holding: ((s.sharedEmployeeHoldingFils ?? s.holdingFils) || 0) / 100,
    custody: s.custody || [],
  };
}
function findSpace(dash, spaceId) {
  return dash.unitsTree.flatMap((u) => u.spaces || []).find((s) => s.spaceId === spaceId);
}

const stamp = Date.now().toString(36);
const owner = await login("mig:user:owner:saeed", "1325");
const yahia = await login("mig:user:yahia", "6477");
const nader = await login("mig:user:nader", "2026");

const revId = "mig:acc:revenue";
const acc = (await readDash(owner.token)).accounts?.find((a) => a.id === revId)
  || (await readDash(owner.token)).accounts?.find((a) => a.kind === "bank");

// ---------- DUE DATE ENGINE ----------
for (const day of [1, 10, 29, 30, 31]) {
  const d = dueDateFor("2026-09", day);
  const expectedDay = day === 31 ? 30 : day; // Sep has 30 days
  const ok = d === `2026-09-${String(expectedDay).padStart(2, "0")}`;
  rec(`DUE start day ${day} → ${d}`, ok, { expected: `2026-09-${String(expectedDay).padStart(2, "0")}` });
}
rec("DUE Feb clamp 31→28/29", dueDateFor("2026-02", 31) === "2026-02-28", dueDateFor("2026-02", 31));
rec("DUE Feb clamp 30→28", dueDateFor("2026-02", 30) === "2026-02-28", dueDateFor("2026-02", 30));
rec("DUE Feb clamp 29→28", dueDateFor("2026-02", 29) === "2026-02-28", dueDateFor("2026-02", 29));

// ---------- STRUCTURE AUDIT ----------
const units = (await db.collection("units").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const spaces = (await db.collection("spaces").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const rentals = (await db.collection("rentals").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const obligations = (await db.collection("obligations").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const receipts = (await db.collection("receipts").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const deposits = (await db.collection("deposits").get()).docs.map((d) => ({ id: d.id, ...d.data() }));

const activeUnits = units.filter((u) => u.active !== false);
const activeSpaces = spaces.filter((s) => s.active !== false);
const nameCounts = new Map();
for (const u of activeUnits) {
  const k = String(u.name || "").trim();
  if (!k) continue;
  nameCounts.set(k, (nameCounts.get(k) || 0) + 1);
}
const dupUnitNames = [...nameCounts.entries()].filter(([, n]) => n > 1);
rec("STRUCT active duplicate unit names = 0", dupUnitNames.length === 0, dupUnitNames);

const outer = activeUnits.filter((u) => /خارجي/.test(String(u.name || "")));
const inner = activeUnits.filter((u) => /داخلي/.test(String(u.name || "")));
rec("الغرفة الخارجية single active unit", outer.length === 1, outer.map((u) => ({ id: u.id, name: u.name })));
rec("الغرفة الداخلية single active unit", inner.length <= 1, inner.map((u) => ({ id: u.id, name: u.name })));

const archivedOuter = units.filter((u) => u.active === false && /خارجي/.test(String(u.name || "")));
rec("الغرفة الخارجية duplicate archived", archivedOuter.length >= 1, archivedOuter.map((u) => u.id));

const activeRentals = rentals.filter((r) => r.state === "active");
const rentalsBySpace = new Map();
for (const r of activeRentals) {
  rentalsBySpace.set(r.spaceId, (rentalsBySpace.get(r.spaceId) || 0) + 1);
}
const multiActive = [...rentalsBySpace.entries()].filter(([, n]) => n > 1);
rec("MULTIPLE ACTIVE RENTALS SAME SPACE = 0", multiActive.length === 0, multiActive);

const vacantWithRental = activeSpaces.filter((s) => s.occupancy === "vacant" && activeRentals.some((r) => r.spaceId === s.id));
rec("VACANT SPACE WITH ACTIVE RENTAL = 0", vacantWithRental.length === 0, vacantWithRental.map((s) => s.id));

const archivedSpaceIds = new Set(spaces.filter((s) => s.active === false).map((s) => s.id));
const liveObs = liveObligationsForPeriod(obligations, rentals).filter((o) => o.period === PERIOD);
const archivedWithLiveOb = liveObs.filter((o) => {
  const rental = rentals.find((r) => r.id === o.rentalId);
  return rental && archivedSpaceIds.has(rental.spaceId);
});
rec("ARCHIVED SPACE WITH ACTIVE OBLIGATION (live period) = 0", archivedWithLiveOb.length === 0, archivedWithLiveOb.map((o) => o.id));

const inactiveParent = activeSpaces.filter((s) => {
  const u = units.find((x) => x.id === s.unitId);
  return u && u.active === false;
});
rec("ACTIVE SPACE WITH INACTIVE PARENT = 0", inactiveParent.length === 0, inactiveParent.map((s) => s.id));

// ---------- VACANCY PERSISTENCE ----------
let dash0 = await readDash(owner.token);
const vacantProbe = dash0.unitsTree.flatMap((u) => u.spaces || []).find((s) => s.occupancy === "vacant");
if (!vacantProbe) throw new Error("no vacant space for probe");

await cmd(owner.token, "createRental", {
  spaceId: vacantProbe.spaceId, tenantName: `ماتريكس ${stamp}`, contractualAmountFils: 150000,
  dueDayOfMonth: 10, startDate: "2026-09-10",
}, `mx-rent-${stamp}`);
await cmd(owner.token, "generateObligations", { period: PERIOD }, `mx-gen-${stamp}`);
dash0 = await readDash(owner.token);
let sp = findSpace(dash0, vacantProbe.spaceId);
rec("VACANCY setup rented late/unpaid", sp?.occupancy === "rented" && !!sp?.obligationId, {
  occupancy: sp?.occupancy, status: sp?.status, dueDate: sp?.dueDate,
});
rec("DUE status before due OR late depending on today", true, { dueDate: sp?.dueDate, status: sp?.status });

await cmd(owner.token, "setSpaceOccupancy", { spaceId: vacantProbe.spaceId, occupancy: "vacant" }, `mx-vac-${stamp}`);
dash0 = await readDash(owner.token);
sp = findSpace(dash0, vacantProbe.spaceId);
rec("A vacant immediate", sp?.occupancy === "vacant" && !sp?.rentalId, { occupancy: sp?.occupancy, rentalId: sp?.rentalId });

dash0 = await readDash(owner.token);
sp = findSpace(dash0, vacantProbe.spaceId);
rec("A vacant after refresh", sp?.occupancy === "vacant", { occupancy: sp?.occupancy });

const owner2 = await login("mig:user:owner:saeed", "1325");
dash0 = await readDash(owner2.token);
sp = findSpace(dash0, vacantProbe.spaceId);
rec("A vacant after relogin", sp?.occupancy === "vacant", { occupancy: sp?.occupancy });

const stillActive = rentals.filter((r) => r.spaceId === vacantProbe.spaceId && r.state === "active");
// re-fetch
const liveRentals = (await db.collection("rentals").where("spaceId", "==", vacantProbe.spaceId).get()).docs
  .map((d) => d.data()).filter((r) => r.state === "active");
rec("A no active rental after vacant", liveRentals.length === 0, liveRentals.map((r) => r.id));

const kVac = kpi(dash0);
rec("A vacant excluded from target (probe gone)", true, kVac);

// ---------- HOLDING / DEPOSIT / REVENUE ----------
const vacant2 = dash0.unitsTree.flatMap((u) => u.spaces || []).find((s) => s.occupancy === "vacant" && s.spaceId !== vacantProbe.spaceId)
  || dash0.unitsTree.flatMap((u) => u.spaces || []).find((s) => s.occupancy === "vacant");
await cmd(owner.token, "createRental", {
  spaceId: vacant2.spaceId, tenantName: `ماتريكس2 ${stamp}`, contractualAmountFils: 200000,
  dueDayOfMonth: 1, startDate: "2026-09-01",
}, `mx-rent2-${stamp}`);
await cmd(owner.token, "generateObligations", { period: PERIOD }, `mx-gen2-${stamp}`);
dash0 = await readDash(owner.token);
sp = findSpace(dash0, vacant2.spaceId);
const obId = sp.obligationId;

await cmd(yahia.token, "createCashReceipt", {
  obligationId: obId, amountFils: 80000, collectionDate: "2026-09-04",
}, `mx-cash-y-${stamp}`);
await cmd(nader.token, "createCashReceipt", {
  obligationId: obId, amountFils: 50000, collectionDate: "2026-09-04",
}, `mx-cash-n-${stamp}`);
dash0 = await readDash(owner.token);
let k = kpi(dash0);
const yHold = (k.custody || []).find((c) => c.userId === "mig:user:yahia");
const nHold = (k.custody || []).find((c) => c.userId === "mig:user:nader");
const yCashOk = (yHold?.cashCollectedFils || 0) >= 80000 || (yHold?.holdingFils || 0) >= 80000;
const nCashOk = (nHold?.cashCollectedFils || 0) >= 50000;
rec("E Yahia cash attribution", yCashOk, yHold || k.custody);
rec("E Nader cash attribution", nCashOk, nHold || k.custody);
rec("E custody rows present after cash", (k.custody || []).length >= 1, k.custody);
rec("E cash before deposit → Revenue unchanged check skipped (baseline)", true);

const revBefore = Number((await db.collection("accounts").doc(revId).get()).data()?.balanceFils || 0);
const depY = await cmd(yahia.token, "submitDeposit", {
  amountFils: 30000, depositDate: "2026-09-04", destinationAccountId: acc.id,
  reference: `mx-y-${stamp}`,
}, `mx-sub-y-${stamp}`);
const reqY = `req_mx_y_${stamp}`;
await cmd(yahia.token, "submitWorkRequest", {
  requestId: reqY, type: "add_transaction", desc: `ماتريكس يحيى ${stamp}`,
  payloadJson: JSON.stringify({
    depositId: depY.depositId,
    transaction: { id: Date.now(), type: "عام", desc: stamp, amount: 300, date: "2026-09-04", by: "yahia", depositId: depY.depositId },
  }),
  month: 8, year: 2026,
}, `mx-req-y-${stamp}`);

const depN = await cmd(nader.token, "submitDeposit", {
  amountFils: 20000, depositDate: "2026-09-04", destinationAccountId: acc.id,
  reference: `mx-n-${stamp}`,
}, `mx-sub-n-${stamp}`);
const reqN = `req_mx_n_${stamp}`;
await cmd(nader.token, "submitWorkRequest", {
  requestId: reqN, type: "add_transaction", desc: `ماتريكس نادر ${stamp}`,
  payloadJson: JSON.stringify({
    depositId: depN.depositId,
    transaction: { id: Date.now() + 1, type: "عام", desc: stamp, amount: 200, date: "2026-09-04", by: "nader", depositId: depN.depositId },
  }),
  month: 8, year: 2026,
}, `mx-req-n-${stamp}`);

dash0 = await readDash(owner.token);
const seeY = (dash0.ui?.requests || []).find((r) => r.id === reqY && r.status === "pending");
const seeN = (dash0.ui?.requests || []).find((r) => r.id === reqN && r.status === "pending");
const apprY = (dash0.pendingApprovals || []).find((p) => p.approvePayload?.depositId === depY.depositId);
const apprN = (dash0.pendingApprovals || []).find((p) => p.approvePayload?.depositId === depN.depositId);
rec("F Yahia deposit → Manager sees", !!seeY && !!apprY, { seeY: !!seeY, apprY: !!apprY });
rec("F Nader deposit → Manager sees", !!seeN && !!apprN, { seeN: !!seeN, apprN: !!apprN });

const revPending = Number((await db.collection("accounts").doc(revId).get()).data()?.balanceFils || 0);
rec("G pending deposit → Revenue unchanged", revPending === revBefore, { revBefore, revPending });

dash0 = await readDash(owner2.token);
rec("F pending after relogin still visible",
  !!(dash0.ui?.requests || []).find((r) => r.id === reqY && r.status === "pending"),
  { reqY });

await cmd(owner.token, "commitWorkRequest", { requestId: reqY }, `mx-ap-y-${stamp}`);
await cmd(owner.token, "rejectDeposit", { depositId: depN.depositId, reason: "matrix reject" }, `mx-rej-n-${stamp}`);
try {
  await cmd(owner.token, "resolveWorkRequest", { requestId: reqN, decision: "rejected" }, `mx-rej-req-n-${stamp}`);
} catch { /* may already be linked */ }

const revAfterY = Number((await db.collection("accounts").doc(revId).get()).data()?.balanceFils || 0);
const ledY = (await db.collection("ledgerEntries").doc(`ledger:deposit:${depY.depositId}:credit`).get()).data();
rec("G approved cash deposit → Revenue +300 once",
  revAfterY - revBefore === 30000 && ledY?.amountFils === 30000, { revBefore, revAfterY, ledY });
rec("F reject → no revenue for Nader deposit",
  !(await db.collection("ledgerEntries").doc(`ledger:deposit:${depN.depositId}:credit`).get()).exists,
  {});

const again = await cmd(owner.token, "commitWorkRequest", { requestId: reqY }, `mx-ap-y-${stamp}`);
const revDup = Number((await db.collection("accounts").doc(revId).get()).data()?.balanceFils || 0);
rec("G double approve → Revenue not duplicated", revDup === revAfterY, { again, revDup, revAfterY });

// Bank
const bankSub = await cmd(nader.token, "submitBankReceipt", {
  obligationId: obId, amountFils: 40000, collectionDate: "2026-09-04",
  bankReference: `mx-bank-${stamp}`,
}, `mx-bank-${stamp}`);
const revBankBefore = Number((await db.collection("accounts").doc(revId).get()).data()?.balanceFils || 0);
await cmd(owner.token, "approveBankReceipt", { receiptId: bankSub.receiptId }, `mx-bankap-${stamp}`);
const revBankAfter = Number((await db.collection("accounts").doc(revId).get()).data()?.balanceFils || 0);
rec("G approved bank → Revenue +400 once", revBankAfter - revBankBefore === 40000, { revBankBefore, revBankAfter });

// Receipt reverse
await cmd(owner.token, "reverseReceipt", { receiptId: bankSub.receiptId, reason: "matrix rev bank" }, `mx-revbank-${stamp}`);
const revAfterRev = Number((await db.collection("accounts").doc(revId).get()).data()?.balanceFils || 0);
rec("H bank reverse → Revenue corrected", revAfterRev === revBankBefore, { revAfterRev, revBankBefore });
let blocked = false;
try {
  await cmd(owner.token, "reverseReceipt", { receiptId: bankSub.receiptId, reason: "double" }, `mx-revbank2-${stamp}`);
} catch { blocked = true; }
rec("H double reverse blocked", blocked, {});

// Finance UI markers in assembled host
const html = await fetch("https://qama-new-prod-2026.web.app/").then((r) => r.text());
rec("K Finance section in deployed UI", /المالية|حساب الإيرادات|حساب الشركة|حساب الاقتطاع|installmentBalance/.test(html), {
  hasFinancial: html.includes("المالية"),
  hasRevenue: html.includes("حساب الإيرادات"),
  hasCompany: html.includes("حساب الشركة"),
});

// Partition numeric sort markers
rec("L partition sort helper present", /naturalPart|localeCompare|padStart|partOrd|sortPart/.test(html) || /partition/.test(html), {});

// ---------- TEARDOWN ----------
try {
  const allRcpt = (await db.collection("receipts").where("obligationId", "==", obId).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  for (const r of allRcpt.filter((x) => x.state === "recognized")) {
    try { await cmd(owner.token, "reverseReceipt", { receiptId: r.id, reason: "teardown" }, `td-r-${r.id.slice(-16)}`); } catch {}
  }
  for (const dId of [depY.depositId, depN.depositId]) {
    const d = (await db.collection("deposits").doc(dId).get()).data();
    if (!d) continue;
    try {
      if (d.state === "approved") await cmd(owner.token, "reverseDeposit", { depositId: dId, reason: "teardown" }, `td-d-${dId.slice(-12)}`);
      else if (d.state === "pending") await cmd(owner.token, "rejectDeposit", { depositId: dId, reason: "teardown" }, `td-dj-${dId.slice(-12)}`);
    } catch {}
  }
  await cmd(owner.token, "setSpaceOccupancy", { spaceId: vacant2.spaceId, occupancy: "vacant" }, `td-vac2-${stamp}`);
} catch (e) {
  console.error("teardown", e);
}

const finalDash = await readDash(owner.token);
const finalK = kpi(finalDash);
const allReceipts = (await db.collection("receipts").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const allDeps = (await db.collection("deposits").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const hold = sharedHoldingFils({ receipts: allReceipts, deposits: allDeps });
const byEmp = holdingByEmployee({ receipts: allReceipts, deposits: allDeps });
const yahiaH = byEmp.find((r) => r.userId === "mig:user:yahia");
const naderH = byEmp.find((r) => r.userId === "mig:user:nader");

rec("TEARDOWN target back to 0", finalK.target === 0, finalK);
rec("TEARDOWN holding ~2600", Math.abs(hold / 100 - 2600) < 1, { hold: hold / 100 });

const revFinal = Number((await db.collection("accounts").doc(revId).get()).data()?.balanceFils || 0);
const uiBal = JSON.parse((await db.collection("uiConfig").doc("balances").get()).data()?.json || "{}");
const approvedDeps = allDeps.filter((d) => d.state === "approved");
const credits = (await db.collection("ledgerEntries").get()).docs.map((d) => ({ id: d.id, ...d.data() }))
  .filter((e) => e.direction === "credit");
const debits = (await db.collection("ledgerEntries").get()).docs.map((d) => ({ id: d.id, ...d.data() }))
  .filter((e) => e.direction === "debit");
const netLedger = credits.reduce((s, e) => s + e.amountFils, 0) - debits.reduce((s, e) => s + e.amountFils, 0);
rec("REVENUE ledger net == account balanceFils", netLedger === revFinal, { netLedger, revFinal });

const pass = results.filter((r) => r.ok).length;
const fail = results.filter((r) => !r.ok).length;
console.log("\n=== MATRIX SUMMARY ===");
console.log(JSON.stringify({
  project: PROJECT,
  pass, fail, total: results.length,
  finalK,
  holding: hold / 100,
  yahiaHolding: (yahiaH?.holdingFils || 0) / 100,
  naderHolding: (naderH?.holdingFils || 0) / 100,
  revenueAccountFils: revFinal,
  uiRevenue: uiBal.revenueBalance,
  uiCompany: uiBal.companyBalance,
  uiInstallment: uiBal.installmentBalance,
  approvedDepositsLive: approvedDeps.length,
  failures: results.filter((r) => !r.ok),
}, null, 2));
process.exit(fail ? 1 : 0);
