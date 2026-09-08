/**
 * Production E2E regression after deposit/finance restore.
 * Target: qama-new-prod-2026 only. Tears down temporary data.
 */
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { existsSync } from "node:fs";
import { dueDateFor, sharedHoldingFils } from "../functions/domain/finance.mjs";

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
function pass(name, detail) { results.push({ ok: true, name, detail }); console.log("PASS ", name, detail ? JSON.stringify(detail) : ""); }
function fail(name, detail) { results.push({ ok: false, name, detail }); console.log("FAIL ", name, detail ? JSON.stringify(detail) : ""); }

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
async function signIn(customToken) {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`;
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: customToken, returnSecureToken: true }) });
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.idToken;
}
async function loginAs(userId, pin) {
  const login = await callable("login", { userId, pin });
  return { token: await signIn(login.customToken), userId };
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
    tenantCollected: ((s.collectedFils ?? s.tenantPaidFils) || 0) / 100,
    company: ((s.companyCollectedFils ?? s.depositedFils) || 0) / 100,
    atEmp: (s.atEmployeesMonthFils || 0) / 100,
    unpaid: ((s.tenantUnpaidFils ?? s.remainingFils) || 0) / 100,
    holding: ((s.sharedEmployeeHoldingFils ?? s.holdingFils) || 0) / 100,
  };
}
function pendingCards(dash) {
  const reqs = (dash.ui?.requests || []).filter((r) => r.status === "pending" && r.type !== "pending_lock");
  const approvals = dash.pendingApprovals || [];
  return { reqs, approvals };
}

const TAG = "regrest_" + Date.now().toString(36);
let owner, yahia;
let spaceId = null;
let rentalId = null;
let obligationId = null;
let depositId = null;
let reqId = null;
let reqId2 = null;

try {
  owner = await loginAs("mig:user:owner:saeed", "1325");
  yahia = await loginAs("mig:user:yahia", "6477");

  // Baseline holding
  let dash = await readDash(owner.token);
  const hold0 = kpi(dash).holding;
  pass("baseline holding readable", { hold0 });

  // Pick a vacant space
  const vacant = (dash.unitsTree || []).flatMap((u) => (u.spaces || []).map((sp) => ({ ...sp, unitId: u.unitId, unitName: u.name })))
    .find((sp) => sp.occupancy === "vacant" || sp.status === "vacant" || (!sp.rentalId && (sp.occupancy === "vacant" || !sp.tenantName)));
  if (!vacant) throw new Error("NO_VACANT_SPACE");
  spaceId = vacant.spaceId || vacant.id;

  // A) Due date: start Sep 2 => due Sep 2
  const created = await cmd(owner.token, "createRental", {
    spaceId,
    tenantName: "REG-TEST-" + TAG,
    contractualAmountFils: 140000,
    dueDayOfMonth: 2,
    startDate: "2026-09-02",
  }, TAG + "-rent");
  rentalId = created.rentalId;
  await cmd(owner.token, "generateObligations", { period: PERIOD }, TAG + "-gen");
  obligationId = `${rentalId}_${PERIOD}`;
  const ob = (await db.collection("obligations").doc(obligationId).get()).data();
  const expectDue = dueDateFor(PERIOD, 2);
  if (ob?.dueDate === "2026-09-02" && expectDue === "2026-09-02") {
    pass("A Sep2 contract -> Sep2 due", { due: ob.dueDate, oct: dueDateFor("2026-10", 2) });
  } else {
    fail("A Sep2 contract -> Sep2 due", { due: ob?.dueDate, expectDue });
  }

  dash = await readDash(owner.token);
  let k = kpi(dash);
  // B) Vacant persistence later — first finance after rental
  if (k.target === 1400 && k.tenantCollected === 0 && k.unpaid === 1400) {
    pass("A finance after rental", k);
  } else fail("A finance after rental", k);

  // Cash 1000
  await cmd(yahia.token, "createCashReceipt", {
    obligationId, amountFils: 100000, collectionDate: "2026-09-02",
  }, TAG + "-cash");
  dash = await readDash(owner.token);
  k = kpi(dash);
  if (k.target === 1400 && k.tenantCollected === 1000 && k.company === 0 && k.atEmp === 1000 && k.unpaid === 400) {
    pass("F finance cash before deposit", k);
  } else fail("F finance cash before deposit", k);

  const holdAfterCash = k.holding;

  // D) Deposit 600 — one pending request
  const dep = await cmd(yahia.token, "submitDeposit", {
    amountFils: 60000,
    depositDate: "2026-09-04",
    destinationAccountId: (dash.accounts || []).find((a) => a.active !== false)?.id,
    note: "REG deposit " + TAG,
    reference: TAG,
  }, TAG + "-dep");
  depositId = dep.depositId;
  reqId = "req_" + TAG + "_dep";
  await cmd(yahia.token, "submitWorkRequest", {
    requestId: reqId,
    type: "add_transaction",
    desc: "إيداع اختبار " + TAG,
    payloadJson: JSON.stringify({ depositId, transaction: { amount: 600, date: "2026-09-04", desc: TAG, depositId } }),
    month: 8, year: 2026,
  }, TAG + "-reqdep");

  // Duplicate work request for same deposit amount/date must fail or not create second pending
  let dupBlocked = false;
  try {
    await cmd(yahia.token, "submitWorkRequest", {
      requestId: "req_" + TAG + "_dep2",
      type: "add_transaction",
      desc: "إيداع اختبار مكرر " + TAG,
      payloadJson: JSON.stringify({ depositId, transaction: { amount: 600, date: "2026-09-04", desc: TAG, depositId } }),
      month: 8, year: 2026,
    }, TAG + "-reqdep2");
  } catch (e) {
    dupBlocked = /DUPLICATE_PENDING|REQUEST_EXISTS/i.test(String(e.message || e.code || e));
  }

  dash = await readDash(owner.token);
  const cards = pendingCards(dash);
  const depReqs = cards.reqs.filter((r) => r.id === reqId || (r.payload?.depositId === depositId));
  const engDep = cards.approvals.filter((p) => p.approvePayload?.depositId === depositId || p.id === depositId);
  // Manager visible as exactly one logical deposit card (work request preferred)
  const logicalDepCards = depReqs.length + (depReqs.length ? 0 : engDep.length);
  if (logicalDepCards === 1 && (dupBlocked || depReqs.length === 1)) {
    pass("D employee deposit -> one Manager request", { depReqs: depReqs.length, engDep: engDep.length, dupBlocked });
  } else {
    fail("D employee deposit -> one Manager request", { depReqs: depReqs.map((r) => r.id), engDep: engDep.map((p) => p.id), dupBlocked });
  }

  k = kpi(dash);
  if (k.holding === holdAfterCash && k.company === 0 && k.atEmp === 1000) {
    pass("D pending deposit zero financial effect", k);
  } else fail("D pending deposit zero financial effect", { k, holdAfterCash });

  // Approve
  await cmd(owner.token, "commitWorkRequest", { requestId: reqId }, TAG + "-commitdep");
  dash = await readDash(owner.token);
  k = kpi(dash);
  if (k.target === 1400 && k.tenantCollected === 1000 && k.company === 600 && k.atEmp === 400 && k.unpaid === 400) {
    pass("F after approve deposit 600", k);
  } else fail("F after approve deposit 600", k);
  if (k.holding === holdAfterCash - 600) {
    pass("D approved deposit reduces shared holding once", { holding: k.holding, expected: holdAfterCash - 600 });
  } else fail("D approved deposit reduces shared holding once", { holding: k.holding, expected: holdAfterCash - 600 });

  // Double approve
  const again = await cmd(owner.token, "commitWorkRequest", { requestId: reqId }, TAG + "-commitdep-again");
  dash = await readDash(owner.token);
  const k2 = kpi(dash);
  if (again.alreadyApplied && k2.company === 600 && k2.holding === k.holding) {
    pass("E double approve no duplicate effect", { again, k2 });
  } else fail("E double approve no duplicate effect", { again, k2 });

  // C) Employee rental update — one request
  reqId2 = "req_" + TAG + "_upd";
  await cmd(yahia.token, "submitWorkRequest", {
    requestId: reqId2,
    type: "update_partition",
    desc: "تعديل اختبار " + TAG,
    payloadJson: JSON.stringify({
      unitId: vacant.unitId, partId: "1",
      fields: { status: "late", rent: 1400, tenant: "REG-TEST-" + TAG, start_date: "2026-09-02", note: TAG },
      spaceId,
    }),
    month: 8, year: 2026,
  }, TAG + "-upd");
  let updDup = false;
  try {
    await cmd(yahia.token, "submitWorkRequest", {
      requestId: "req_" + TAG + "_upd2",
      type: "update_partition",
      desc: "تعديل مكرر " + TAG,
      payloadJson: JSON.stringify({
        unitId: vacant.unitId, partId: "1",
        fields: { status: "late", rent: 1400, tenant: "REG-TEST-" + TAG, start_date: "2026-09-02" },
        spaceId,
      }),
      month: 8, year: 2026,
    }, TAG + "-upd2");
  } catch (e) {
    updDup = /DUPLICATE_PENDING/i.test(String(e.message || e.code || e));
  }
  dash = await readDash(owner.token);
  const updPending = (dash.ui?.requests || []).filter((r) => r.status === "pending" && r.type === "update_partition" && String(r.desc || "").includes(TAG));
  if (updPending.length === 1 && updDup) pass("C employee rental update one request", { ids: updPending.map((r) => r.id) });
  else fail("C employee rental update one request", { count: updPending.length, updDup, ids: updPending.map((r) => r.id) });

  await cmd(owner.token, "resolveWorkRequest", { requestId: reqId2, decision: "rejected" }, TAG + "-upd-rej");

  // B) Vacant
  await cmd(owner.token, "setSpaceOccupancy", { spaceId, occupancy: "vacant" }, TAG + "-vac1");
  // close rental via setSpaceOccupancy should close — also explicit close
  try {
    await cmd(owner.token, "closeRental", { rentalId, endDate: "2026-09-04", reason: "teardown", setVacant: true }, TAG + "-close");
  } catch (e) {
    if (!/ALREADY_CLOSED|NOT_ACTIVE|NOT_FOUND/i.test(String(e.message || e))) throw e;
  }
  dash = await readDash(owner.token);
  const sp = (dash.unitsTree || []).flatMap((u) => u.spaces || []).find((s) => (s.spaceId || s.id) === spaceId);
  const liveTarget = kpi(dash).target;
  // Relogin
  owner = await loginAs("mig:user:owner:saeed", "1325");
  dash = await readDash(owner.token);
  const sp2 = (dash.unitsTree || []).flatMap((u) => u.spaces || []).find((s) => (s.spaceId || s.id) === spaceId);
  const occOk = (sp2?.occupancy === "vacant" || sp2?.status === "vacant") && liveTarget === 0;
  if (occOk) pass("B vacant persistence after refresh/relogin", { occupancy: sp2?.occupancy, target: kpi(dash).target });
  else fail("B vacant persistence after refresh/relogin", { sp: sp2, target: kpi(dash).target });

  // Ghosts still dead
  const rentals = (await db.collection("rentals").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const ghosts = rentals.filter((r) => r.state === "active" && (!r.tenantName || r.tenantName === "—" || r.tenantName === "-"));
  if (ghosts.length === 0) pass("OLD ghost rentals still dead", { n: 0 });
  else fail("OLD ghost rentals still dead", { n: ghosts.length });

  // UI markers: assembled frontend must not use start+1 due fallback
  const { readFileSync } = await import("node:fs");
  const html = readFileSync(new URL("../src/frontend/index.html", import.meta.url), "utf8");
  const badDue = /due_date\s*=\s*addMonthsISO|start_date\s*\?\s*addMonthsISO\([^)]*1\)/.test(html);
  const hasOldTabs = ["الشقق", "المالية", "الطلبات"].every((t) => html.includes(t));
  if (!badDue && hasOldTabs) pass("G old UI due-date + tabs", { badDue, hasOldTabs });
  else fail("G old UI due-date + tabs", { badDue, hasOldTabs });

} catch (e) {
  fail("FATAL", { message: String(e.message || e), stack: e.stack?.split("\n").slice(0, 4) });
} finally {
  // Teardown — preserve August holding; reverse test deposit/receipts; cancel obs; close rental
  try {
    if (!owner) owner = await loginAs("mig:user:owner:saeed", "1325");
    if (depositId) {
      try { await cmd(owner.token, "reverseDeposit", { depositId, reason: "teardown " + TAG }, TAG + "-revdep"); }
      catch (e) { /* may already be rejected */ }
    }
    const receipts = (await db.collection("receipts").where("obligationId", "==", obligationId || "_").get()).docs;
    for (const d of receipts) {
      const r = d.data();
      if (r.state === "recognized") {
        try { await cmd(owner.token, "reverseReceipt", { receiptId: d.id, reason: "teardown " + TAG }, TAG + "-revr-" + d.id.slice(-8)); }
        catch { /* ignore */ }
      }
    }
    if (obligationId) {
      try { await cmd(owner.token, "cancelObligation", { obligationId, reason: "teardown" }, TAG + "-canob"); } catch { /* */ }
    }
    if (rentalId) {
      try { await cmd(owner.token, "closeRental", { rentalId, endDate: "2026-09-04", reason: "teardown", setVacant: true }, TAG + "-cl2"); } catch { /* */ }
    }
    if (spaceId) {
      try { await cmd(owner.token, "setSpaceOccupancy", { spaceId, occupancy: "vacant" }, TAG + "-vac2"); } catch { /* */ }
    }
    if (reqId2) {
      try { await cmd(owner.token, "resolveWorkRequest", { requestId: reqId2, decision: "rejected" }, TAG + "-rej2"); } catch { /* */ }
    }
  } catch (te) {
    console.error("TEARDOWN ERROR", te);
  }
}

const dash = await readDash((await loginAs("mig:user:owner:saeed", "1325")).token);
const finalK = kpi(dash);
const allRec = (await db.collection("receipts").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const allDep = (await db.collection("deposits").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const hold = sharedHoldingFils({ receipts: allRec, deposits: allDep }) / 100;

console.log("\n=== SUMMARY ===");
const ok = results.filter((r) => r.ok).length;
const bad = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ project: PROJECT, pass: ok, fail: bad, total: results.length, finalK, hold }, null, 2));
process.exit(bad ? 1 : 0);
