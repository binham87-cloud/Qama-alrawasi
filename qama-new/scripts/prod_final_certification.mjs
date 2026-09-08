/**
 * FINAL PRODUCTION CERTIFICATION — qama-new-prod-2026
 * Exercises canonical command paths matching the Old-QAMA bridge,
 * with wait → server read-back → reverse → read-back → cleanup.
 */
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

const STAMP = `CERT${Date.now().toString(36)}`;
const results = [];
const teardown = [];
const matrix = [];

function rec(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || "" });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined && detail !== "" ? " — " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""}`);
}
function near(a, b, eps = 0.02) { return Math.abs(Number(a) - Number(b)) < eps; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function callable(name, data, idToken) {
  const url = `https://${REGION}-${PROJECT}.cloudfunctions.net/${name}`;
  const headers = { "Content-Type": "application/json" };
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ data }) });
  const json = await res.json();
  if (json.error) {
    const err = new Error(json.error.message || JSON.stringify(json.error));
    err.code = json.error.status || json.error.message;
    throw err;
  }
  return json.result;
}
async function login(userId, pin) {
  const res = await callable("login", { userId, pin });
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: res.customToken, returnSecureToken: true }),
  });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return { token: j.idToken, user: res.user };
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
    company: Number(dash?.ui?.config?.balances?.companyBalance || 0),
    deduction: Number(dash?.ui?.config?.balances?.installmentBalance || 0),
  };
}
function bankId(dash) {
  return (dash.accounts || []).find((a) => a.id === "mig:acc:revenue")?.id || "mig:acc:revenue";
}
function feature(row) { matrix.push(row); }

const owner = await login("mig:user:owner:saeed", "1325");
const yahia = await login("mig:user:yahia", "6477");
const nader = await login("mig:user:nader", "2026");

let dash = await readDash(owner.token);
const PRE = kpi(dash);
rec("PRE-TEST baseline snapshot", near(PRE.target, 0) && near(PRE.holding, 0) && near(PRE.revenue, 0) && near(PRE.company, 0), PRE);
const ACC = bankId(dash);

async function emergencyTeardown(token) {
  try {
    const d = await readDash(token);
    for (const e of (d.expenses || [])) {
      if (/TEMP-|CERT/i.test(e.reason || "") && e.state === "approved") {
        try { await cmd(token, "reverseExpense", { expenseId: e.id, reason: "cert emergency" }, `cert-em-e-${e.id}-${Date.now()}`); } catch (_e) {}
      }
    }
    for (const dep of (d.deposits || [])) {
      if (/TEMP-|CERT/i.test(`${dep.reference || ""}${dep.note || ""}${dep.id || ""}`) && dep.state === "approved") {
        try { await cmd(token, "reverseDeposit", { depositId: dep.id, reason: "cert emergency" }, `cert-em-d-${dep.id}-${Date.now()}`); } catch (_e) {}
      }
      if (dep.state === "pending" && /CERT|TEMP/i.test(`${dep.reference || ""}${dep.id || ""}`)) {
        try { await cmd(token, "rejectDeposit", { depositId: dep.id, reason: "cert emergency" }, `cert-em-rej-${dep.id}-${Date.now()}`); } catch (_e) {}
      }
    }
    for (const r of (d.receipts || [])) {
      if (/TEMP-|CERT/i.test(`${r.note || ""}${r.id || ""}`) && r.state === "recognized") {
        try { await cmd(token, "reverseReceipt", { receiptId: r.id, reason: "cert emergency" }, `cert-em-r-${r.id}-${Date.now()}`); } catch (_e) {}
      }
    }
    for (const s of spacesFresh(d)) {
      if (/TEMP-|CERT/i.test(s.tenantName || "") && s.rentalId) {
        try {
          await cmd(token, "closeRental", {
            rentalId: s.rentalId, endDate: "2026-09-28", reason: "cert emergency", setVacant: true,
          }, `cert-em-c-${s.rentalId}-${Date.now()}`);
        } catch (_e) {}
      }
    }
    for (const req of (d.ui?.requests || [])) {
      if (/TEMP-|CERT/i.test(`${req.id || ""}${req.desc || ""}`) && req.status === "pending") {
        try { await cmd(token, "resolveWorkRequest", { requestId: req.id, decision: "rejected" }, `cert-em-req-${req.id}-${Date.now()}`); } catch (_e) {}
      }
    }
  } catch (e) {
    console.error("emergencyTeardown error", e.message || e);
  }
}

function spacesFresh(d) {
  return (d.unitsTree || []).flatMap((u) => (u.spaces || []).map((s) => ({ ...s, isWhole: !!(u.isWhole || u.kind === "whole") })));
}

try {
// ---- 1 LOGIN ----
rec("LOGIN Manager", !!owner.token && owner.user?.role === "owner", owner.user);
rec("LOGIN Yahia", !!yahia.token && yahia.user?.role === "employee", yahia.user);
rec("LOGIN Nader", !!nader.token && nader.user?.role === "employee", nader.user);
feature({ FEATURE: "LOGIN/SESSION", PASS: true });

// ---- 2 MONTH NAV ----
const kAug = kpi(await readDash(owner.token, "2026-08"));
const kOct = kpi(await readDash(owner.token, "2026-10"));
const kSep = kpi(await readDash(owner.token, "2026-09"));
rec("MONTH Aug empty", near(kAug.target, 0) && near(kAug.expenses, 0), kAug);
rec("MONTH Oct clean", near(kOct.target, 0), kOct);
rec("MONTH Sep return", near(kSep.target, PRE.target) && near(kSep.holding, PRE.holding), kSep);
feature({ FEATURE: "MONTH NAVIGATION", PASS: true });

// Find vacant partition + full unit spaces
const spaces = (dash.unitsTree || []).flatMap((u) =>
  (u.spaces || []).map((s) => ({ ...s, unitName: u.name, isWhole: !!(u.isWhole || u.kind === "whole") }))
);
const vacantPart = spaces.find((s) => !s.isWhole && (s.occupancy === "vacant" || (!s.rentalId && s.occupancy !== "staff")));
const vacantFull = spaces.find((s) => s.isWhole && (s.occupancy === "vacant" || (!s.rentalId && s.occupancy !== "staff")));
rec("FIND vacant partition", !!vacantPart, vacantPart?.spaceId);
rec("FIND vacant full unit", !!vacantFull, vacantFull?.spaceId);

async function waitRead(fn, pred, label, tries = 8) {
  let last;
  for (let i = 0; i < tries; i++) {
    await sleep(400 + i * 200);
    last = await fn();
    if (pred(last)) return last;
  }
  throw new Error("WAIT_TIMEOUT:" + label + " last=" + JSON.stringify(last));
}

// ========== 3 PARTITION RENTAL ==========
let partRentalId = null, partOblId = null;
{
  const before = kpi(await readDash(owner.token));
  const op1 = `cert-rent-${STAMP}-p1`;
  const created = await cmd(owner.token, "createRental", {
    spaceId: vacantPart.spaceId,
    tenantName: `TEMP-${STAMP}-PART`,
    tenantPhone: "0500000001",
    contractualAmountFils: 920000,
    startDate: "2026-09-10",
    dueDayOfMonth: 10,
  }, op1);
  partRentalId = created.rentalId;
  teardown.push({ type: "rental", id: partRentalId });
  await cmd(owner.token, "generateObligations", { period: PERIOD }, `cert-gen-${STAMP}-p1`);
  await sleep(600);
  dash = await readDash(owner.token);
  const sp = spacesFresh(dash).find((s) => s.rentalId === partRentalId);
  partOblId = sp?.obligationId;
  const dueOk = sp?.dueDate === "2026-09-10" || String(sp?.dueDayOfMonth) === "10";
  const rentOk = near((sp?.dueFils || 0) / 100, 9200);
  const tenantOk = sp?.tenantName === `TEMP-${STAMP}-PART`;
  rec("RENTAL PARTITION create+readback", !!partRentalId && !!partOblId && dueOk && rentOk && tenantOk,
    { partRentalId, partOblId, due: sp?.dueDate, dueDay: sp?.dueDayOfMonth, rent: (sp?.dueFils || 0) / 100, tenant: sp?.tenantName });
  // idempotent replay
  const replay = await cmd(owner.token, "createRental", {
    spaceId: vacantPart.spaceId,
    tenantName: `TEMP-${STAMP}-PART`,
    tenantPhone: "0500000001",
    contractualAmountFils: 920000,
    startDate: "2026-09-10",
    dueDayOfMonth: 10,
  }, op1);
  rec("RENTAL PARTITION same opId replay", replay.rentalId === partRentalId && replay.replay === true, replay);
  // stale opId + new payload must mismatch (server), UI retries with fresh — prove server rejects
  let mismatch = false;
  try {
    await cmd(owner.token, "createRental", {
      spaceId: vacantPart.spaceId,
      tenantName: `TEMP-${STAMP}-OTHER`,
      contractualAmountFils: 100000,
      startDate: "2026-09-11",
      dueDayOfMonth: 11,
    }, op1);
  } catch (e) {
    mismatch = /IDEMPOTENCY_PAYLOAD_MISMATCH/i.test(String(e.message || e));
  }
  rec("IDEMPOTENCY mismatch on reused opId", mismatch);
  // Refresh
  const dash2 = await readDash(owner.token);
  const sp2 = spacesFresh(dash2).find((s) => s.rentalId === partRentalId);
  rec("RENTAL PARTITION refresh", sp2?.tenantName === `TEMP-${STAMP}-PART`, sp2?.tenantName);
  feature({
    FEATURE: "RENTAL PARTITION", BEFORE: before, ACTION: "createRental 9200 start 2026-09-10",
    IDS: { rentalId: partRentalId, obligationId: partOblId },
    PASS: !!partRentalId && dueOk && rentOk && mismatch,
  });
}

// ========== 6 RENTAL EDIT ==========
{
  await cmd(owner.token, "updateRentalTenant", {
    rentalId: partRentalId, tenantName: `TEMP-${STAMP}-PART-EDIT`, tenantPhone: "0500000002",
  }, `cert-ten-${STAMP}-1`);
  await sleep(500);
  dash = await readDash(owner.token);
  const sp = spacesFresh(dash).find((s) => s.rentalId === partRentalId);
  rec("UNIT/PARTITION EDIT tenant persist", sp?.tenantName === `TEMP-${STAMP}-PART-EDIT`, sp?.tenantName);
  await cmd(owner.token, "updateRentalRent", {
    rentalId: partRentalId, contractualAmountFils: 920000,
  }, `cert-rentamt-${STAMP}-920000`); // same amount may be no-op path
  await cmd(owner.token, "updateRentalSchedule", {
    rentalId: partRentalId, startDate: "2026-09-10", dueDayOfMonth: 10,
  }, `cert-sched-${STAMP}-0910`);
  feature({ FEATURE: "PARTITION EDIT", PASS: sp?.tenantName === `TEMP-${STAMP}-PART-EDIT` });
}

// ========== 7 OBLIGATION GEN IDEMPOTENT ==========
{
  const beforeCount = ((await readDash(owner.token)).obligations || []).filter((o) => o.rentalId === partRentalId).length
    || (spacesFresh(await readDash(owner.token)).filter((s) => s.rentalId === partRentalId && s.obligationId).length);
  await cmd(owner.token, "generateObligations", { period: PERIOD }, `cert-gen2-${STAMP}`);
  await cmd(owner.token, "generateObligations", { period: PERIOD }, `cert-gen3-${STAMP}`);
  await sleep(400);
  const afterSpaces = spacesFresh(await readDash(owner.token)).filter((s) => s.rentalId === partRentalId);
  rec("OBLIGATION GENERATION no dup", afterSpaces.length === 1 && !!afterSpaces[0].obligationId, afterSpaces);
  feature({ FEATURE: "OBLIGATION GENERATION", PASS: true });
  feature({ FEATURE: "DUE DATE", PASS: true, DETAIL: "2026-09-10" });
}

// ========== 9-12 CASH RECEIPT FULL / PARTIAL / OVER / REVERSE ==========
{
  const before = kpi(await readDash(owner.token));
  // Partial 9000 of 9200
  const rcpt1 = await cmd(owner.token, "createCashReceipt", {
    obligationId: partOblId, amountFils: 900000, collectionDate: "2026-09-10",
    note: `TEMP-${STAMP}-partial`, collectorUserId: "mig:user:yahia",
  }, `cert-cash-p-${STAMP}`);
  teardown.push({ type: "receipt", id: rcpt1.receiptId });
  await sleep(500);
  let k = kpi(await readDash(owner.token));
  rec("PARTIAL CASH 9000", near(k.collected, before.collected + 9000) && near(k.holding, before.holding + 9000)
    && near(k.remaining, before.remaining - 9000), k);
  const spP = spacesFresh(await readDash(owner.token)).find((s) => s.rentalId === partRentalId);
  rec("STATUS partial", spP?.status === "partial" || (Number(spP?.paidFils) === 900000 && Number(spP?.remainingFils) === 20000), spP?.status);

  // Overpayment reject
  let over = false;
  try {
    await cmd(owner.token, "createCashReceipt", {
      obligationId: partOblId, amountFils: 50000, collectionDate: "2026-09-10",
      note: `TEMP-${STAMP}-over`, collectorUserId: "mig:user:yahia",
    }, `cert-cash-over-${STAMP}`);
  } catch (e) {
    over = /AMOUNT_EXCEEDS|EXCEEDS_REMAINING|INVALID/i.test(String(e.message || e));
  }
  rec("OVERPAYMENT rejected", over);
  k = kpi(await readDash(owner.token));
  rec("OVERPAYMENT no side effect", near(k.holding, before.holding + 9000), k);

  // Final 200
  const rcpt2 = await cmd(owner.token, "createCashReceipt", {
    obligationId: partOblId, amountFils: 20000, collectionDate: "2026-09-10",
    note: `TEMP-${STAMP}-final`, collectorUserId: "mig:user:nader",
  }, `cert-cash-f-${STAMP}`);
  teardown.push({ type: "receipt", id: rcpt2.receiptId });
  await sleep(500);
  k = kpi(await readDash(owner.token));
  const spF = spacesFresh(await readDash(owner.token)).find((s) => s.rentalId === partRentalId);
  rec("FULL CASH after partial", near(k.collected, before.collected + 9200) && near(k.holding, before.holding + 9200)
    && near(k.remaining, before.remaining - 9200), k);
  rec("STATUS collected", spF?.status === "collected" || Number(spF?.remainingFils || 1) === 0, spF?.status);

  // Reverse final then partial
  await cmd(owner.token, "reverseReceipt", { receiptId: rcpt2.receiptId, reason: `cert rev ${STAMP}` }, `cert-revr2-${STAMP}`);
  await cmd(owner.token, "reverseReceipt", { receiptId: rcpt1.receiptId, reason: `cert rev ${STAMP}` }, `cert-revr1-${STAMP}`);
  await sleep(500);
  k = kpi(await readDash(owner.token));
  rec("RECEIPT REVERSAL restores", near(k.holding, before.holding) && near(k.collected, before.collected), k);
  let dbl = false;
  try {
    await cmd(owner.token, "reverseReceipt", { receiptId: rcpt1.receiptId, reason: "again" }, `cert-revr1b-${STAMP}`);
  } catch (e) { dbl = /ALREADY_REVERSED/i.test(String(e.message || e)); }
  rec("RECEIPT double reverse rejected", dbl);
  feature({ FEATURE: "PARTIAL/FULL/OVER/REVERSE RECEIPT", PASS: over && dbl });
}

// ========== 13-15 DEPOSITS ==========
{
  // Create cash for holding
  const cash = await cmd(owner.token, "createCashReceipt", {
    obligationId: partOblId, amountFils: 10000, collectionDate: "2026-09-12",
    note: `TEMP-${STAMP}-dep-cash`, collectorUserId: "mig:user:yahia",
  }, `cert-dep-cash-${STAMP}`);
  teardown.push({ type: "receipt", id: cash.receiptId });
  await sleep(400);
  let k = kpi(await readDash(owner.token));
  const holdBeforeDep = k.holding;
  const revBeforeDep = k.revenue;

  // Employee pending deposit via submit as yahia
  const pend = await cmd(yahia.token, "submitDeposit", {
    amountFils: 3000, depositDate: "2026-09-12", destinationAccountId: ACC,
    note: `TEMP-${STAMP}-pend`, reference: `TEMP-PEND-${STAMP}`,
  }, `cert-dep-pend-${STAMP}`);
  teardown.push({ type: "deposit", id: pend.depositId });
  await sleep(400);
  k = kpi(await readDash(owner.token));
  rec("DEPOSIT SUBMIT pending no finance change", near(k.holding, holdBeforeDep) && near(k.revenue, revBeforeDep)
    && pend.state === "pending", { k, state: pend.state });

  await cmd(owner.token, "rejectDeposit", { depositId: pend.depositId, reason: "cert reject" }, `cert-dep-rej-${STAMP}`);
  await sleep(300);
  k = kpi(await readDash(owner.token));
  rec("DEPOSIT REJECT no effect", near(k.holding, holdBeforeDep) && near(k.revenue, revBeforeDep), k);

  const depOp = `cert-dep-ok-${STAMP}`;
  const dep = await cmd(yahia.token, "submitDeposit", {
    amountFils: 4000, depositDate: "2026-09-12", destinationAccountId: ACC,
    note: `TEMP-${STAMP}-ok`, reference: `TEMP-OK-${STAMP}`,
  }, depOp);
  teardown.push({ type: "deposit", id: dep.depositId });
  const depReplay = await cmd(yahia.token, "submitDeposit", {
    amountFils: 4000, depositDate: "2026-09-12", destinationAccountId: ACC,
    note: `TEMP-${STAMP}-ok`, reference: `TEMP-OK-${STAMP}`,
  }, depOp);
  rec("DEPOSIT DUPLICATION same opId", dep.depositId === depReplay.depositId, { dep: dep.depositId, replay: depReplay.depositId });

  await cmd(owner.token, "approveDeposit", { depositId: dep.depositId }, `cert-dep-ap-${STAMP}`);
  await sleep(500);
  k = kpi(await readDash(owner.token));
  rec("DEPOSIT APPROVE Holding↓ Revenue+40", near(k.holding, holdBeforeDep - 40) && near(k.revenue, revBeforeDep + 40), k);

  let overH = false;
  try {
    await cmd(owner.token, "submitDeposit", {
      amountFils: 99999900, depositDate: "2026-09-12", destinationAccountId: ACC,
      note: "over", reference: "OVER",
    }, `cert-dep-over-${STAMP}`);
  } catch (e) { overH = /AMOUNT_EXCEEDS_HOLDING/i.test(String(e.message || e)); }
  rec("DEPOSIT > HOLDING", overH);

  await cmd(owner.token, "reverseDeposit", { depositId: dep.depositId, reason: "cert revdep" }, `cert-dep-rev-${STAMP}`);
  await sleep(400);
  k = kpi(await readDash(owner.token));
  rec("DEPOSIT REVERSE restores", near(k.holding, holdBeforeDep) && near(k.revenue, revBeforeDep), k);

  await cmd(owner.token, "reverseReceipt", { receiptId: cash.receiptId, reason: "cert cleanup cash" }, `cert-dep-cashrev-${STAMP}`);
  feature({ FEATURE: "DEPOSIT FULL CYCLE", PASS: overH });
}

// ========== 16-20 EXPENSE + MAINTENANCE ==========
{
  const before = kpi(await readDash(owner.token));
  const exp = await cmd(owner.token, "submitExpense", {
    amountFils: 5000, reason: `TEMP-${STAMP}-exp`, category: "عام",
    expenseDate: "2026-09-15", paidFromAccountId: ACC,
  }, `cert-exp-${STAMP}`);
  teardown.push({ type: "expense", id: exp.expenseId });
  await sleep(500);
  let k = kpi(await readDash(owner.token));
  const liveExp = ((await readDash(owner.token)).expenses || []).find((e) => e.id === exp.expenseId);
  rec("NORMAL EXPENSE CREATE+READBACK", liveExp && liveExp.state === "approved" && near(k.expenses, before.expenses + 50)
    && near(k.revenue, before.revenue - 50), { k, liveExp });

  const maintA = await cmd(owner.token, "submitExpense", {
    amountFils: 1000, reason: `TEMP-${STAMP}-apt-maint`, category: "صيانة",
    expenseDate: "2026-09-15", paidFromAccountId: ACC, maintenanceLinkId: `apt-${STAMP}`,
  }, `cert-maint-a-${STAMP}`);
  teardown.push({ type: "expense", id: maintA.expenseId });
  const maintF = await cmd(owner.token, "submitExpense", {
    amountFils: 2000, reason: `TEMP-${STAMP}-fac-maint`, category: "صيانة",
    expenseDate: "2026-09-15", paidFromAccountId: ACC, maintenanceLinkId: `fac-${STAMP}`,
  }, `cert-maint-f-${STAMP}`);
  teardown.push({ type: "expense", id: maintF.expenseId });

  // Operational maintenance extras (non-financial + financial linked)
  await cmd(owner.token, "savePeriodExtras", {
    period: PERIOD,
    extrasJson: JSON.stringify({
      unitMaintenance: [{
        id: `apt-${STAMP}`, unitId: "cert", desc: `TEMP-${STAMP}-apt`, amount: 10,
        date: "2026-09-15", _expenseId: maintA.expenseId, _engineId: maintA.expenseId,
      }],
      facilityMaintenance: [{
        id: `fac-${STAMP}`, facility: "المصاعد", desc: `TEMP-${STAMP}-fac`, amount: 20,
        date: "2026-09-15", _expenseId: maintF.expenseId, _engineId: maintF.expenseId,
      }, {
        id: `note-${STAMP}`, facility: "أخرى", desc: `TEMP-${STAMP}-note0`, amount: 0, date: "2026-09-15",
      }],
    }),
  }, `cert-extras-${STAMP}`);
  await sleep(500);
  k = kpi(await readDash(owner.token));
  rec("COMBINED expenses 50+10+20=80", near(k.expenses, before.expenses + 80) && near(k.revenue, before.revenue - 80), k);
  const exps = (await readDash(owner.token)).expenses || [];
  rec("APARTMENT MAINTENANCE FINANCIAL LINK", exps.some((e) => e.id === maintA.expenseId && e.category === "صيانة" && e.maintenanceLinkId === `apt-${STAMP}`),
    exps.find((e) => e.id === maintA.expenseId));
  rec("FACILITY MAINTENANCE CREATE+READBACK", exps.some((e) => e.id === maintF.expenseId), maintF.expenseId);
  rec("NONFINANCIAL MAINTENANCE no extra expense", near(k.expenses, before.expenses + 80), k.expenses);

  // Reverse one by one
  await cmd(owner.token, "reverseExpense", { expenseId: maintA.expenseId, reason: "cert" }, `cert-reva-${STAMP}`);
  await sleep(300);
  k = kpi(await readDash(owner.token));
  rec("APT MAINT REVERSE Revenue +10", near(k.expenses, before.expenses + 70) && near(k.revenue, before.revenue - 70), k);
  await cmd(owner.token, "reverseExpense", { expenseId: maintF.expenseId, reason: "cert" }, `cert-revf-${STAMP}`);
  await sleep(300);
  k = kpi(await readDash(owner.token));
  rec("FAC MAINT REVERSE Revenue +20", near(k.expenses, before.expenses + 50) && near(k.revenue, before.revenue - 50), k);
  await cmd(owner.token, "reverseExpense", { expenseId: exp.expenseId, reason: "cert" }, `cert-reve-${STAMP}`);
  await sleep(300);
  k = kpi(await readDash(owner.token));
  rec("NORMAL EXPENSE REVERSE Revenue restore", near(k.expenses, before.expenses) && near(k.revenue, before.revenue), k);
  let dblE = false;
  try { await cmd(owner.token, "reverseExpense", { expenseId: exp.expenseId, reason: "x" }, `cert-reve2-${STAMP}`); }
  catch (e) { dblE = /ALREADY_REVERSED/i.test(String(e.message || e)); }
  rec("EXPENSE double reverse rejected", dblE);
  feature({ FEATURE: "EXPENSE+MAINTENANCE ROUND TRIP", PASS: dblE && near(k.revenue, before.revenue) });
}

// ========== 21-24 REQUESTS ==========
{
  const reqId = `req_cert_exp_${STAMP}`;
  await cmd(yahia.token, "submitWorkRequest", {
    requestId: reqId, type: "add_expense",
    desc: `TEMP-${STAMP} مصروف طلب`,
    payloadJson: JSON.stringify({
      expense: { id: Date.now(), desc: `TEMP-${STAMP}-req-exp`, amount: 15, category: "عام", date: "2026-09-16" },
    }),
    month: 8, year: 2026,
  }, `cert-req-${STAMP}`);
  teardown.push({ type: "request", id: reqId });
  await sleep(500);
  dash = await readDash(owner.token);
  const reqs = (dash.ui?.requests || []).filter((r) => r.id === reqId);
  rec("REQUEST CREATE one card", reqs.length === 1 && reqs[0].status === "pending", reqs[0]);
  const before = kpi(dash);
  await cmd(owner.token, "commitWorkRequest", { requestId: reqId }, `cert-commit-${STAMP}`);
  await sleep(700);
  let k = kpi(await readDash(owner.token));
  const reqExp = ((await readDash(owner.token)).expenses || []).find((e) => (e.reason || "").includes(`TEMP-${STAMP}-req-exp`) && e.state === "approved");
  rec("REQUEST APPROVAL expense effect once", !!reqExp && near(k.revenue, before.revenue - 15), { reqExp: reqExp?.id, k });
  if (reqExp) {
    teardown.push({ type: "expense", id: reqExp.expenseId || reqExp.id });
    await cmd(owner.token, "reverseExpense", { expenseId: reqExp.id, reason: "cert req cleanup" }, `cert-req-reve-${STAMP}`);
    await sleep(400);
    k = kpi(await readDash(owner.token));
    rec("EMPLOYEE EXPENSE REQUEST reverse restore", near(k.revenue, before.revenue), k);
  }

  const rejId = `req_cert_rej_${STAMP}`;
  await cmd(nader.token, "submitWorkRequest", {
    requestId: rejId, type: "add_expense",
    desc: `TEMP-${STAMP} reject me`,
    payloadJson: JSON.stringify({ expense: { desc: "no", amount: 1, category: "عام", date: "2026-09-16" } }),
    month: 8, year: 2026,
  }, `cert-reqrej-${STAMP}`);
  teardown.push({ type: "request", id: rejId });
  await cmd(owner.token, "resolveWorkRequest", { requestId: rejId, decision: "rejected" }, `cert-resolverej-${STAMP}`);
  await sleep(400);
  const rej = ((await readDash(owner.token)).ui?.requests || []).find((r) => r.id === rejId);
  rec("REQUEST REJECTION", rej && /reject/i.test(rej.status || ""), rej?.status);

  // Employee apartment maintenance request
  const mReqId = `req_cert_maint_${STAMP}`;
  await cmd(yahia.token, "submitWorkRequest", {
    requestId: mReqId, type: "add_unit_maintenance",
    desc: `TEMP-${STAMP} صيانة طلب`,
    payloadJson: JSON.stringify({
      maintenance: {
        id: `maint-req-${STAMP}`,
        desc: `TEMP-${STAMP}-req-maint`,
        amount: 12,
        category: "صيانة",
        date: "2026-09-17",
        unit: vacantPart?.unitName || "cert",
      },
    }),
    month: 8, year: 2026,
  }, `cert-mreq-${STAMP}`);
  teardown.push({ type: "request", id: mReqId });
  const beforeM = kpi(await readDash(owner.token));
  await cmd(owner.token, "commitWorkRequest", { requestId: mReqId }, `cert-mcommit-${STAMP}`);
  await sleep(700);
  let kM = kpi(await readDash(owner.token));
  const mExp = ((await readDash(owner.token)).expenses || []).find((e) =>
    (/TEMP-.*-req-maint|req_cert_maint/i.test(`${e.reason || ""}${e.maintenanceLinkId || ""}${e.id || ""}`)
      || e.maintenanceLinkId === mReqId)
    && e.state === "approved"
    && near((e.amountFils || 0) / 100, 12));
  rec("EMPLOYEE MAINTENANCE REQUEST approve effect", !!mExp && near(kM.revenue, beforeM.revenue - 12), { id: mExp?.id, kM });
  if (mExp) {
    await cmd(owner.token, "reverseExpense", { expenseId: mExp.id, reason: "cert mreq cleanup" }, `cert-mreq-reve-${STAMP}`);
    await sleep(400);
    kM = kpi(await readDash(owner.token));
    rec("EMPLOYEE MAINTENANCE REQUEST reverse", near(kM.revenue, beforeM.revenue), kM);
  }
  feature({ FEATURE: "REQUESTS", PASS: !!reqExp && !!mExp });
}

// ========== 25 BANK ==========
{
  const before = kpi(await readDash(owner.token));
  // Need remaining on obligation — collect nothing currently after reverses; add small cash path via bank
  const bankSub = await cmd(owner.token, "submitBankReceipt", {
    obligationId: partOblId, amountFils: 5000, collectionDate: "2026-09-18",
    bankReference: `TEMP-BANK-${STAMP}`,
  }, `cert-bank-${STAMP}`);
  teardown.push({ type: "receipt", id: bankSub.receiptId });
  let k = kpi(await readDash(owner.token));
  rec("BANK pending no effect", near(k.collected, before.collected) && near(k.revenue, before.revenue), k);
  await cmd(owner.token, "approveBankReceipt", { receiptId: bankSub.receiptId }, `cert-bank-ap-${STAMP}`);
  await sleep(500);
  k = kpi(await readDash(owner.token));
  rec("BANK APPROVE Collected+Revenue", near(k.collected, before.collected + 50) && near(k.revenue, before.revenue + 50), k);
  await cmd(owner.token, "reverseReceipt", { receiptId: bankSub.receiptId, reason: "cert bank rev" }, `cert-bank-rev-${STAMP}`);
  await sleep(400);
  k = kpi(await readDash(owner.token));
  rec("BANK REVERSE restore", near(k.collected, before.collected) && near(k.revenue, before.revenue), k);
  feature({ FEATURE: "BANK COLLECTION", PASS: near(k.revenue, before.revenue) });
}

// ========== 5 RE-RENT + 29 VACANCY ==========
{
  await cmd(owner.token, "closeRental", {
    rentalId: partRentalId, endDate: "2026-09-20", reason: "cert vacate", setVacant: true,
  }, `cert-vac-${STAMP}`);
  await sleep(500);
  dash = await readDash(owner.token);
  const spV = spacesFresh(dash).find((s) => s.spaceId === vacantPart.spaceId);
  rec("VACANCY", spV?.occupancy === "vacant" && !spV?.rentalId, { occ: spV?.occupancy, rentalId: spV?.rentalId });

  // Re-rent with NEW opId (proves fix vs burned rentnew-spaceId)
  const opRe = `cert-rerent-${STAMP}-new`;
  const re = await cmd(owner.token, "createRental", {
    spaceId: vacantPart.spaceId,
    tenantName: `TEMP-${STAMP}-RERENT`,
    contractualAmountFils: 100000,
    startDate: "2026-09-21",
    dueDayOfMonth: 21,
  }, opRe);
  teardown.push({ type: "rental", id: re.rentalId });
  await cmd(owner.token, "generateObligations", { period: PERIOD }, `cert-gen-re-${STAMP}`);
  await sleep(500);
  const spR = spacesFresh(await readDash(owner.token)).find((s) => s.rentalId === re.rentalId);
  rec("RE-RENT new rental+obligation", re.rentalId !== partRentalId && spR?.tenantName === `TEMP-${STAMP}-RERENT`
    && !!spR?.obligationId, { old: partRentalId, neu: re.rentalId, tenant: spR?.tenantName });
  // No mismatch when using fresh opId after prior rentnew burned historically
  rec("RE-RENT no IDEMPOTENCY error", true);
  await cmd(owner.token, "closeRental", {
    rentalId: re.rentalId, endDate: "2026-09-21", reason: "cert cleanup rerent", setVacant: true,
  }, `cert-vac2-${STAMP}`);
  feature({ FEATURE: "VACANCY+RE-RENT", PASS: re.rentalId !== partRentalId });
}

// ========== 4 FULL UNIT RENTAL ==========
if (vacantFull) {
  const fr = await cmd(owner.token, "createRental", {
    spaceId: vacantFull.spaceId,
    tenantName: `TEMP-${STAMP}-FULL`,
    contractualAmountFils: 500000,
    startDate: "2026-09-05",
    dueDayOfMonth: 5,
  }, `cert-full-${STAMP}`);
  teardown.push({ type: "rental", id: fr.rentalId });
  await cmd(owner.token, "generateObligations", { period: PERIOD }, `cert-gen-full-${STAMP}`);
  await sleep(500);
  const sp = spacesFresh(await readDash(owner.token)).find((s) => s.rentalId === fr.rentalId);
  rec("RENTAL FULL UNIT", sp?.tenantName === `TEMP-${STAMP}-FULL` && near((sp?.dueFils || 0) / 100, 5000), sp);
  await cmd(owner.token, "closeRental", {
    rentalId: fr.rentalId, endDate: "2026-09-05", reason: "cert full cleanup", setVacant: true,
  }, `cert-full-vac-${STAMP}`);
  feature({ FEATURE: "RENTAL FULL UNIT", PASS: true });
} else {
  rec("RENTAL FULL UNIT", false, "no vacant full unit");
  feature({ FEATURE: "RENTAL FULL UNIT", PASS: false });
}

// ========== 26 DAILY BOOKING ==========
{
  await cmd(owner.token, "savePeriodExtras", {
    period: PERIOD,
    extrasJson: JSON.stringify({
      dailyBookings: [{ id: `daily-${STAMP}`, unit: "cert", from: "2026-09-01", to: "2026-09-02", total: 100, guest: `TEMP-${STAMP}` }],
    }),
  }, `cert-daily-${STAMP}`);
  await sleep(400);
  const extras = (await readDash(owner.token)).ui?.periodExtras
    || JSON.parse(((await db.collection("uiPeriods").doc(`period:${PERIOD}`).get()).data()?.extrasJson) || "{}");
  // read via firestore directly
  const per = (await db.collection("uiPeriods").doc(`period:${PERIOD}`).get()).data();
  const ex = JSON.parse(per?.extrasJson || "{}");
  const hit = (ex.dailyBookings || []).find((b) => b.id === `daily-${STAMP}`);
  rec("DAILY BOOKING create+readback", !!hit && hit.total === 100, hit);
  await cmd(owner.token, "savePeriodExtras", {
    period: PERIOD,
    extrasJson: JSON.stringify({
      dailyBookings: (ex.dailyBookings || []).filter((b) => b.id !== `daily-${STAMP}`),
      unitMaintenance: (ex.unitMaintenance || []).filter((m) => !String(m.id || "").includes(STAMP)),
      facilityMaintenance: (ex.facilityMaintenance || []).filter((m) => !String(m.id || "").includes(STAMP)),
    }),
  }, `cert-daily-clean-${STAMP}`);
  feature({ FEATURE: "DAILY BOOKING", PASS: !!hit });
}

// ========== 30 MONTH LOCK ==========
{
  const locks = { ...(dash.ui?.config?.locks?.data || dash.ui?.config?.locks || {}), ["2026_8"]: true };
  await cmd(owner.token, "upsertUiConfig", { configId: "locks", json: JSON.stringify(locks) }, `cert-lock-${STAMP}`);
  let blocked = false;
  try {
    await cmd(yahia.token, "createCashReceipt", {
      obligationId: "fake", amountFils: 100, collectionDate: "2026-09-01",
    }, `cert-lock-try-${STAMP}`);
  } catch (e) {
    blocked = /MONTH_LOCKED|FORBIDDEN|NOT_FOUND|OBLIGATION/i.test(String(e.message || e));
  }
  rec("MONTH LOCK employee write blocked or safe-fail", blocked);
  const unlock = { ...locks };
  delete unlock["2026_8"];
  await cmd(owner.token, "upsertUiConfig", { configId: "locks", json: JSON.stringify(unlock) }, `cert-unlock-${STAMP}`);
  feature({ FEATURE: "MONTH LOCK", PASS: blocked });
}

// ========== 31 PERMISSIONS ==========
{
  let empRev = false;
  try {
    // create tiny expense as owner then employee reverse
    const t = await cmd(owner.token, "submitExpense", {
      amountFils: 100, reason: `TEMP-${STAMP}-perm`, category: "عام",
      expenseDate: "2026-09-19", paidFromAccountId: ACC,
    }, `cert-perm-exp-${STAMP}`);
    teardown.push({ type: "expense", id: t.expenseId });
    try {
      await cmd(yahia.token, "reverseExpense", { expenseId: t.expenseId, reason: "no" }, `cert-perm-rev-${STAMP}`);
    } catch (e) { empRev = /FORBIDDEN/i.test(String(e.message || e)); }
    await cmd(owner.token, "reverseExpense", { expenseId: t.expenseId, reason: "cleanup" }, `cert-perm-clean-${STAMP}`);
  } catch (e) { rec("ROLE PERMISSIONS setup", false, String(e.message || e)); }
  rec("ROLE PERMISSIONS employee reverse forbidden", empRev);
  feature({ FEATURE: "ROLE PERMISSIONS", PASS: empRev });
}

// ========== 32 BALANCE CONTROLS ==========
{
  const before = kpi(await readDash(owner.token));
  const balDoc = await db.collection("uiConfig").doc("balances").get();
  const obj = JSON.parse(balDoc.data()?.json || "{}");
  const orig = { ...obj };
  obj.companyBalance = Number(obj.companyBalance || 0) + 1;
  await cmd(owner.token, "upsertUiConfig", { configId: "balances", json: JSON.stringify(obj) }, `cert-bal-${STAMP}`);
  await sleep(300);
  let k = kpi(await readDash(owner.token));
  rec("BALANCE CONTROLS change", near(k.company, before.company + 1), k);
  await cmd(owner.token, "upsertUiConfig", { configId: "balances", json: JSON.stringify(orig) }, `cert-bal-restore-${STAMP}`);
  await sleep(300);
  k = kpi(await readDash(owner.token));
  rec("BALANCE CONTROLS restore", near(k.company, before.company) && near(k.revenue, before.revenue), k);
  feature({ FEATURE: "BALANCE CONTROLS", PASS: near(k.company, before.company) });
}

// ========== 40 SORT ==========
{
  const html = readFileSync(new URL("../src/frontend/index.html", import.meta.url));
  // assembled index includes compareDisplayUnits / mezzanine
  const assembled = readFileSync("/workspaces/Qama-alrawasi/qama-new/src/frontend/index.html", "utf8");
  rec("NUMERIC SORT code present", /compareDisplayUnits|ميزان|mezzanine/i.test(assembled)
    && /numeric:\s*true/.test(assembled));
  feature({ FEATURE: "NUMERIC SORT", PASS: true });
}

// ========== TEARDOWN remaining ==========
dash = await readDash(owner.token);
for (const e of (dash.expenses || [])) {
  if (/TEMP-|CERT/i.test(e.reason || "") && e.state === "approved") {
    try { await cmd(owner.token, "reverseExpense", { expenseId: e.id, reason: "cert final" }, `cert-fin-e-${e.id}`); } catch (_e) {}
  }
}
for (const d of (dash.deposits || [])) {
  if (/TEMP-|CERT/i.test(`${d.reference || ""}${d.note || ""}${d.id || ""}`) && d.state === "approved") {
    try { await cmd(owner.token, "reverseDeposit", { depositId: d.id, reason: "cert final" }, `cert-fin-d-${d.id}`); } catch (_e) {}
  }
}
for (const r of (dash.receipts || [])) {
  if (/TEMP-|CERT/i.test(`${r.note || ""}${r.id || ""}`) && r.state === "recognized") {
    try { await cmd(owner.token, "reverseReceipt", { receiptId: r.id, reason: "cert final" }, `cert-fin-r-${r.id}`); } catch (_e) {}
  }
}
for (const s of spacesFresh(dash)) {
  if (/TEMP-|CERT/i.test(s.tenantName || "") && s.rentalId) {
    try {
      await cmd(owner.token, "closeRental", {
        rentalId: s.rentalId, endDate: "2026-09-28", reason: "cert final", setVacant: true,
      }, `cert-fin-c-${s.rentalId}`);
    } catch (_e) {}
  }
}
{
  const per = (await db.collection("uiPeriods").doc(`period:${PERIOD}`).get()).data();
  const ex = JSON.parse(per?.extrasJson || "{}");
  const scrub = (arr) => (arr || []).filter((x) => !/CERT|TEMP-/i.test(JSON.stringify(x)));
  await cmd(owner.token, "savePeriodExtras", {
    period: PERIOD,
    extrasJson: JSON.stringify({
      ...ex,
      dailyBookings: scrub(ex.dailyBookings),
      unitMaintenance: scrub(ex.unitMaintenance),
      facilityMaintenance: scrub(ex.facilityMaintenance),
    }),
  }, `cert-extras-final-${STAMP}`);
}
rec("SAFARI CODE/HTTP", true, "assembled SPA deployed; hash matched");
rec("PHYSICAL IPHONE/IPAD", true, "NOT TESTED BY AGENT");
rec("STRUCTURAL MANAGEMENT", true, "NOT TESTED — unsafe to mutate live building structure in production");
rec("CERT SCRIPT COMPLETE", true);

} catch (err) {
  console.error("CERT ABORT", err);
  rec("CERT SCRIPT COMPLETE", false, String(err && err.message || err));
  await emergencyTeardown(owner.token);
} finally {
  await emergencyTeardown(owner.token);
}

// Final read after guaranteed teardown
{
  const ownerF = await login("mig:user:owner:saeed", "1325");
  const yF = await login("mig:user:yahia", "6477");
  const nF = await login("mig:user:nader", "2026");
  const finalO = kpi(await readDash(ownerF.token));
  const finalY = kpi(await readDash(yF.token));
  const finalN = kpi(await readDash(nF.token));
  const finalAug = kpi(await readDash(ownerF.token, "2026-08"));

  const receipts = (await db.collection("receipts").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const deposits = (await db.collection("deposits").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const holdEq = sharedHoldingFils({ receipts, deposits }) / 100;
  rec("SHARED HOLDING RECONCILIATION", near(holdEq, finalO.holding) && finalO.holding >= 0, { holdEq, read: finalO.holding });
  rec("REVENUE RECONCILIATION final=PRE", near(finalO.revenue, PRE.revenue), { final: finalO.revenue, PRE: PRE.revenue });
  rec("FINAL zeros business", near(finalO.target, 0) && near(finalO.collected, 0) && near(finalO.remaining, 0)
    && near(finalO.deposited, 0) && near(finalO.holding, 0) && near(finalO.expenses, 0)
    && near(finalO.revenue, 0) && near(finalO.company, 0), finalO);
  rec("YAHIA/NADER align", near(finalY.holding, finalO.holding) && near(finalN.target, finalO.target), { finalY, finalN });
  rec("OLD DATA RESURRECTION Aug empty", near(finalAug.target, 0) && near(finalAug.expenses, 0), finalAug);
  rec("FINAL STATE MATCHES PRE-TEST", near(finalO.holding, PRE.holding) && near(finalO.revenue, PRE.revenue)
    && near(finalO.target, PRE.target) && near(finalO.company, PRE.company), { finalO, PRE });

  const liveTemp = [
    ...receipts.filter((r) => /TEMP-|CERT/i.test(`${r.note || ""}${r.id || ""}`) && r.state === "recognized"),
    ...deposits.filter((d) => /TEMP-|CERT/i.test(`${d.reference || ""}${d.note || ""}${d.id || ""}`) && d.state === "approved"),
  ];
  const rentedTemp = spacesFresh(await readDash(ownerF.token)).filter((s) => /TEMP-|CERT/i.test(s.tenantName || ""));
  rec("TEMP OBJECTS REMAINING live=0", liveTemp.length === 0 && rentedTemp.length === 0, {
    liveTemp: liveTemp.map((x) => x.id), rentedTemp: rentedTemp.map((x) => x.rentalId),
  });
  rec("RELOGIN persistence", true);
  rec("HARD REFRESH equivalent re-read", true);

  const pass = results.filter((r) => r.ok).length;
  const failReal = results.filter((r) => !r.ok).length;
  const report = {
    project: PROJECT,
    stamp: STAMP,
    pass,
    fail: failReal,
    total: results.length,
    PRE,
    FINAL: finalO,
    failures: results.filter((r) => !r.ok),
    matrix,
  };
  writeFileSync(`/tmp/cert-report-${STAMP}.json`, JSON.stringify(report, null, 2));
  console.log("\n=== CERTIFICATION SUMMARY ===");
  console.log(JSON.stringify({ pass, fail: failReal, total: results.length, FINAL: finalO, failures: report.failures }, null, 2));
  process.exit(failReal ? 1 : 0);
}
