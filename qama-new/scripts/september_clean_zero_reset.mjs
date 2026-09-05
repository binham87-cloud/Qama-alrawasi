/**
 * September 2026 clean-zero reset for qama-new-prod-2026.
 *
 * Modes:
 *   --inventory   READ-ONLY counts + classification (default)
 *   --apply       Controlled reset via canonical commands + period extras wipe
 *   --verify      Post-reset verification
 *   --reentry-test Create then tear down one sample rental
 *
 * NEVER targets qama-alrawasi. Period isolation: 2026-09 only.
 */
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { existsSync } from "node:fs";
import { dueDateFor } from "../functions/domain/finance.mjs";

const PROJECT = "qama-new-prod-2026";
const PERIOD = "2026-09";
const PRIOR = "2026-08";
const API_KEY = "AIzaSyBs0wIu2h2mnNMGr5SH-YNXjUhrdrGSNKg";
const REGION = "me-central1";
const MODE = process.argv.includes("--apply")
  ? "apply"
  : process.argv.includes("--verify")
    ? "verify"
    : process.argv.includes("--reentry-test")
      ? "reentry"
      : "inventory";

const adcPath = `${process.env.HOME}/.config/firebase/binham87_gmail_com_application_default_credentials.json`;
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && existsSync(adcPath)) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = adcPath;
}
if (!getApps().length) initializeApp({ projectId: PROJECT });
const db = getFirestore();

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
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
async function readDash(token, period) {
  return callable("read", { what: "dashboard", period }, token);
}

async function listAll(col) {
  const snap = await db.collection(col).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

function byPeriod(rows, period) {
  return rows.filter((r) => r.period === period);
}
function countBy(rows, key = "state") {
  const m = {};
  for (const r of rows) {
    const k = r[key] || "(none)";
    m[k] = (m[k] || 0) + 1;
  }
  return m;
}

function sharedHolding(receipts, deposits) {
  let cash = 0;
  for (const r of receipts) {
    if (r.state === "recognized" && r.method === "cash") cash += Number(r.amountFils || 0);
  }
  let dep = 0;
  for (const d of deposits) {
    if (d.state === "approved") dep += Number(d.amountFils || 0);
  }
  return cash - dep;
}

async function inventory() {
  const [
    rentals, obligations, receipts, deposits, expenses, spaces,
    uiRequests, uiPeriods, reversals,
  ] = await Promise.all([
    listAll("rentals"),
    listAll("obligations"),
    listAll("receipts"),
    listAll("deposits"),
    listAll("expenses"),
    listAll("spaces"),
    listAll("uiRequests"),
    listAll("uiPeriods"),
    listAll("reversals"),
  ]);

  const sepObs = byPeriod(obligations, PERIOD);
  const augObs = byPeriod(obligations, PRIOR);
  const sepRcpt = byPeriod(receipts, PERIOD);
  const augRcpt = byPeriod(receipts, PRIOR);
  const sepDep = byPeriod(deposits, PERIOD);
  const augDep = byPeriod(deposits, PRIOR);
  const sepExp = byPeriod(expenses, PERIOD);
  const augExp = byPeriod(expenses, PRIOR);

  const activeRentals = rentals.filter((r) => r.state === "active");
  // Rentals that would generate Sep obligations (startDate <= 2026-09)
  const activeForSep = activeRentals.filter((r) => String(r.startDate || "").slice(0, 7) <= PERIOD);

  const sepReqs = uiRequests.filter((r) => {
    if (r.period === PERIOD) return true;
    if (Number(r.year) === 2026 && Number(r.month) === 8) return true; // 0-based? check
    if (Number(r.year) === 2026 && Number(r.month) === 9) return true;
    const p = r.payloadJson || r.payload || {};
    try {
      const parsed = typeof p === "string" ? JSON.parse(p) : p;
      if (parsed?.period === PERIOD) return true;
    } catch { /* ignore */ }
    return false;
  });
  // Prefer year/month fields used by UI (month is 0-based in old UI: Sep = 8)
  const sepUiReqs = uiRequests.filter((r) => {
    const y = Number(r.year);
    const m = Number(r.month);
    // Old QAMA uses 0-based month index: September = 8
    return y === 2026 && (m === 8 || m === 9);
  });

  const sepPeriodDoc = uiPeriods.find((p) => p.period === PERIOD || p.id === `period:${PERIOD}`);
  let extrasSpaces = 0;
  let dailyBookings = 0;
  let extrasMeta = {};
  if (sepPeriodDoc) {
    try {
      const extras = typeof sepPeriodDoc.extrasJson === "string"
        ? JSON.parse(sepPeriodDoc.extrasJson)
        : (sepPeriodDoc.extrasJson || sepPeriodDoc.extras || {});
      extrasSpaces = Object.keys(extras.spaces || {}).length;
      dailyBookings = (extras.dailyBookings || []).length;
      extrasMeta = {
        expenses: (extras.expenses || []).length,
        transactions: (extras.transactions || []).length,
        logs: (extras.logs || []).length,
        profits: (extras.profits || []).length,
        installments: (extras.installments || []).length,
        unitMaintenance: (extras.unitMaintenance || []).length,
        facilityMaintenance: (extras.facilityMaintenance || []).length,
        dailyBookings,
        spacesWithExtras: extrasSpaces,
      };
    } catch (e) {
      extrasMeta = { parseError: String(e.message || e) };
    }
  }

  const holdingAll = sharedHolding(receipts, deposits);
  const holdingExSep = sharedHolding(
    receipts.filter((r) => r.period !== PERIOD),
    deposits.filter((d) => d.period !== PERIOD),
  );
  const sepCashRec = sepRcpt.filter((r) => r.state === "recognized" && r.method === "cash")
    .reduce((s, r) => s + Number(r.amountFils || 0), 0);
  const sepDepApproved = sepDep.filter((d) => d.state === "approved")
    .reduce((s, d) => s + Number(d.amountFils || 0), 0);

  const rentedSpaces = spaces.filter((s) => s.active !== false && s.occupancy === "rented");
  const vacantSpaces = spaces.filter((s) => s.active !== false && (s.occupancy === "vacant" || !s.occupancy));
  const staffSpaces = spaces.filter((s) => s.active !== false && s.occupancy === "staff");

  const crossMonthRisk = [];
  for (const r of activeRentals) {
    if (String(r.startDate || "").slice(0, 7) < PERIOD) {
      crossMonthRisk.push({
        kind: "active_rental_started_before_sep",
        rentalId: r.id,
        startDate: r.startDate,
        spaceId: r.spaceId,
        note: "Closing for Sep clean-start preserves rental doc as closed; Aug obligations untouched",
      });
    }
  }

  return {
    project: PROJECT,
    period: PERIOD,
    mode: MODE,
    holding: {
      model: "GLOBAL event-based (all recognized cash − all approved deposits)",
      currentFils: holdingAll,
      afterRemovingSepContributionFils: holdingExSep,
      sepRecognizedCashFils: sepCashRec,
      sepApprovedDepositFils: sepDepApproved,
      sepNetHoldingContributionFils: sepCashRec - sepDepApproved,
    },
    rentals: {
      activeTotal: activeRentals.length,
      activeThatAffectSep: activeForSep.length,
      byState: countBy(rentals),
      startedInSep: rentals.filter((r) => String(r.startDate || "").slice(0, 7) === PERIOD).length,
      startedBeforeSepStillActive: activeRentals.filter((r) => String(r.startDate || "").slice(0, 7) < PERIOD).length,
    },
    obligations: {
      september: { total: sepObs.length, byState: countBy(sepObs) },
      august: { total: augObs.length, byState: countBy(augObs), paidTouched: "DO_NOT_TOUCH" },
    },
    receipts: {
      september: { total: sepRcpt.length, byState: countBy(sepRcpt), byMethod: countBy(sepRcpt, "method") },
      august: { total: augRcpt.length, byState: countBy(augRcpt) },
    },
    deposits: {
      september: { total: sepDep.length, byState: countBy(sepDep) },
      august: { total: augDep.length, byState: countBy(augDep) },
    },
    expenses: {
      september: { total: sepExp.length, byState: countBy(sepExp) },
      august: { total: augExp.length, byState: countBy(augExp) },
    },
    reversals: {
      total: reversals.length,
      sepTargets: reversals.filter((r) => {
        const t = String(r.targetId || "");
        return t.includes("_2026-09") || String(r.createdAt || "").startsWith("2026-09");
      }).length,
    },
    spaces: {
      active: spaces.filter((s) => s.active !== false).length,
      rented: rentedSpaces.length,
      vacant: vacantSpaces.length,
      staff: staffSpaces.length,
    },
    uiRequests: {
      septemberish: sepUiReqs.length,
      byStatus: countBy(sepUiReqs, "status"),
      sampleMonths: [...new Set(sepUiReqs.map((r) => `${r.year}-${r.month}`))].slice(0, 10),
    },
    extras: extrasMeta,
    dailyBookings: dailyBookings,
    crossMonthRiskCount: crossMonthRisk.length,
    crossMonthRiskSample: crossMonthRisk.slice(0, 5),
  };
}

async function applyReset(token) {
  const stamp = Date.now().toString(36);
  const log = [];
  const fail = [];

  const tryCmd = async (command, payload, oid) => {
    try {
      const r = await cmd(token, command, payload, oid);
      log.push({ command, ok: true, payload: summarize(payload), r: summarize(r) });
      return r;
    } catch (e) {
      const msg = String(e.message || e);
      // Idempotent skips
      if (/ALREADY_REVERSED|RENTAL_ALREADY_CLOSED|RENTAL_NOT_ACTIVE|OBLIGATION_NOT_ACTIVE|DEPOSIT_NOT_PENDING|EXPENSE_NOT_PENDING|REQUEST_NOT_PENDING|OBLIGATION_HAS_RECEIPTS/.test(msg)) {
        log.push({ command, ok: true, skipped: msg, payload: summarize(payload) });
        return null;
      }
      fail.push({ command, error: msg, payload: summarize(payload) });
      return null;
    }
  };
  function summarize(x) {
    if (!x || typeof x !== "object") return x;
    const o = {};
    for (const [k, v] of Object.entries(x)) {
      if (typeof v === "string" && v.length > 80) o[k] = v.slice(0, 80) + "…";
      else o[k] = v;
    }
    return o;
  }

  const [rentals, obligations, receipts, deposits, expenses, spaces, uiRequests] = await Promise.all([
    listAll("rentals"),
    listAll("obligations"),
    listAll("receipts"),
    listAll("deposits"),
    listAll("expenses"),
    listAll("spaces"),
    listAll("uiRequests"),
  ]);

  // Snapshot holding before
  const holdBefore = sharedHolding(receipts, deposits);
  const holdExSep = sharedHolding(
    receipts.filter((r) => r.period !== PERIOD),
    deposits.filter((d) => d.period !== PERIOD),
  );

  // 1) Reverse/reject September financial events FIRST (so obligations can cancel).
  // Deposits BEFORE receipts: deposited cash receipts refuse reverse until deposit is reversed.
  const sepDep = byPeriod(deposits, PERIOD);
  for (const d of sepDep) {
    if (d.state === "approved") {
      await tryCmd("reverseDeposit", { depositId: d.id, reason: "تنظيف سبتمبر 2026" }, `sep-reset-revdep-${d.id}-${stamp}`);
    } else if (d.state === "pending") {
      await tryCmd("rejectDeposit", { depositId: d.id, reason: "تنظيف سبتمبر 2026" }, `sep-reset-rejdep-${d.id}-${stamp}`);
    }
  }

  const sepRcpt = byPeriod(receipts, PERIOD);
  for (const r of sepRcpt) {
    if (r.state === "recognized") {
      await tryCmd("reverseReceipt", { receiptId: r.id, reason: "تنظيف سبتمبر 2026 — إعادة تشغيل الشهر" }, `sep-reset-revrcpt-${r.id}-${stamp}`);
    } else if (r.state === "pending") {
      await tryCmd("rejectBankReceipt", { receiptId: r.id, reason: "تنظيف سبتمبر 2026" }, `sep-reset-rejrcpt-${r.id}-${stamp}`);
    }
  }

  const sepExp = byPeriod(expenses, PERIOD);
  for (const e of sepExp) {
    if (e.state === "approved") {
      await tryCmd("reverseExpense", { expenseId: e.id, reason: "تنظيف سبتمبر 2026" }, `sep-reset-revexp-${e.id}-${stamp}`);
    } else if (e.state === "pending") {
      await tryCmd("rejectExpense", { expenseId: e.id, reason: "تنظيف سبتمبر 2026" }, `sep-reset-rejexp-${e.id}-${stamp}`);
    }
  }

  // 2) Cancel September obligations (active only; receipts should be cleared)
  const sepObs = byPeriod(obligations, PERIOD).filter((o) => o.state === "active");
  for (const o of sepObs) {
    await tryCmd("cancelObligation", { obligationId: o.id, reason: "تنظيف سبتمبر 2026" }, `sep-reset-canob-${o.id}-${stamp}`);
  }

  // 3) Close ALL active rentals (Sep clean restart — employees re-enter)
  //    Preserves rental documents as closed; does not delete. Aug obligations stay.
  const active = rentals.filter((r) => r.state === "active");
  for (const r of active) {
    await tryCmd("closeRental", {
      rentalId: r.id,
      endDate: "2026-08-31",
      reason: "تنظيف سبتمبر 2026 — إعادة إدخال العقود يدوياً",
      setVacant: true,
    }, `sep-reset-close-${r.id}-${stamp}`);
  }

  // 4) Force all rentable spaces vacant (staff kept as staff)
  for (const s of spaces.filter((x) => x.active !== false)) {
    if (s.occupancy === "staff") continue;
    if (s.occupancy !== "vacant") {
      await tryCmd("setSpaceOccupancy", { spaceId: s.id, occupancy: "vacant" }, `sep-reset-vac-${s.id}-${stamp}`);
    }
  }

  // 5) Reject pending September UI work requests
  const sepUiReqs = uiRequests.filter((r) => {
    const y = Number(r.year);
    const m = Number(r.month);
    return y === 2026 && (m === 8 || m === 9) && (r.status === "pending" || r.status === "processing");
  });
  for (const req of sepUiReqs) {
    await tryCmd("resolveWorkRequest", { requestId: req.id, decision: "rejected" }, `sep-reset-rejreq-${req.id}-${stamp}`);
  }

  // 6) Wipe September UI extras (archive empty clean month shell) — keep structure keys empty
  const cleanExtras = {
    spaces: {},
    expenses: [],
    transactions: [],
    profits: [],
    installments: [],
    logs: [{
      id: Date.now(),
      text: "تنظيف سبتمبر 2026 — شهر تشغيل صفري",
      at: new Date().toISOString(),
      by: "system",
    }],
    dailyBookings: [],
    unitMaintenance: [],
    facilityMaintenance: [],
    _septemberReset: {
      at: new Date().toISOString(),
      reason: "owner clean-zero September 2026",
      priorHoldingFils: holdBefore,
      expectedHoldingAfterSepRemoved: holdExSep,
    },
  };
  await tryCmd("savePeriodExtras", {
    period: PERIOD,
    extrasJson: JSON.stringify(cleanExtras),
  }, `sep-reset-extras-${stamp}`);

  // Archive note on Firestore (non-destructive evidence)
  await db.collection("opsArchives").doc(`september-reset-${PERIOD}-${stamp}`).set({
    id: `september-reset-${PERIOD}-${stamp}`,
    project: PROJECT,
    period: PERIOD,
    at: new Date().toISOString(),
    holdBefore,
    holdExSep,
    commandLogCount: log.length,
    failCount: fail.length,
    failures: fail.slice(0, 50),
  });

  return { holdBefore, holdExSep, logCount: log.length, failCount: fail.length, failures: fail };
}

async function verify(token) {
  const dash = await readDash(token, PERIOD);
  const aug = await readDash(token, PRIOR);

  const [
    rentals, obligations, receipts, deposits, expenses, spaces, uiRequests,
  ] = await Promise.all([
    listAll("rentals"),
    listAll("obligations"),
    listAll("receipts"),
    listAll("deposits"),
    listAll("expenses"),
    listAll("spaces"),
    listAll("uiRequests"),
  ]);

  const sepObsActive = byPeriod(obligations, PERIOD).filter((o) => o.state === "active");
  const sepRcptLive = byPeriod(receipts, PERIOD).filter((r) => r.state === "recognized" || r.state === "pending");
  const sepDepLive = byPeriod(deposits, PERIOD).filter((d) => d.state === "approved" || d.state === "pending");
  const sepExpLive = byPeriod(expenses, PERIOD).filter((e) => e.state === "approved" || e.state === "pending");
  const activeRentals = rentals.filter((r) => r.state === "active");
  const nonStaff = spaces.filter((s) => s.active !== false && s.occupancy !== "staff");
  const allVacant = nonStaff.every((s) => s.occupancy === "vacant" || !s.occupancy);
  const pendingReqs = uiRequests.filter((r) => {
    const y = Number(r.year);
    const m = Number(r.month);
    return y === 2026 && (m === 8 || m === 9) && (r.status === "pending" || r.status === "processing");
  });

  const rentedOnDash = [];
  for (const u of dash.unitsTree || []) {
    for (const sp of u.spaces || []) {
      if (sp.occupancy === "rented" || (sp.status && !["vacant", "staff"].includes(sp.status) && sp.rentalId)) {
        rentedOnDash.push({ name: sp.name, status: sp.status, occupancy: sp.occupancy, rentalId: sp.rentalId });
      }
    }
  }

  const hold = sharedHolding(receipts, deposits);
  const holdExSep = sharedHolding(
    receipts.filter((r) => r.period !== PERIOD),
    deposits.filter((d) => d.period !== PERIOD),
  );

  const augObsActive = byPeriod(obligations, PRIOR).filter((o) => o.state === "active").length;
  const augRcptRec = byPeriod(receipts, PRIOR).filter((r) => r.state === "recognized").length;

  return {
    september: {
      activeRentals: activeRentals.length,
      activeObligations: sepObsActive.length,
      liveReceipts: sepRcptLive.length,
      liveDeposits: sepDepLive.length,
      liveExpenses: sepExpLive.length,
      pendingRequests: pendingReqs.length,
      summary: {
        dueFils: dash.summary?.dueFils ?? dash.summary?.targetFils,
        collectedFils: dash.summary?.collectedFils,
        remainingFils: dash.summary?.remainingFils,
        depositedFils: dash.summary?.depositedFils,
        expensesFils: dash.summary?.expensesFils,
        holdingFils: dash.summary?.holdingFils ?? dash.summary?.sharedEmployeeHoldingFils,
      },
      rentedOnDash: rentedOnDash.length,
      rentedSample: rentedOnDash.slice(0, 5),
      allNonStaffVacant: allVacant,
    },
    august: {
      activeObligations: augObsActive,
      recognizedReceipts: augRcptRec,
      summaryCollected: aug.summary?.collectedFils,
      note: "August figures must remain non-zero if historically paid",
    },
    holding: {
      currentFils: hold,
      excludingSepRecordsFils: holdExSep,
      matchesExSep: hold === holdExSep,
    },
  };
}

async function reentryTest(token) {
  const stamp = Date.now().toString(36);
  const dash = await readDash(token, PERIOD);
  // Pick first vacant non-staff space
  let space = null;
  for (const u of dash.unitsTree || []) {
    for (const sp of u.spaces || []) {
      if (sp.occupancy === "vacant" || (!sp.occupancy && sp.status === "vacant")) {
        space = sp;
        break;
      }
    }
    if (space) break;
  }
  if (!space) throw new Error("NO_VACANT_SPACE");

  await cmd(token, "setSpaceOccupancy", { spaceId: space.spaceId, occupancy: "rented" }, `reentry-occ-${stamp}`);
  const rental = await cmd(token, "createRental", {
    spaceId: space.spaceId,
    tenantName: "اختبار إعادة إدخال",
    contractualAmountFils: 100000,
    dueDayOfMonth: 1,
    startDate: "2026-09-01",
  }, `reentry-rent-${stamp}`);
  await cmd(token, "generateObligations", { period: PERIOD }, `reentry-gen-${stamp}`);
  let after = await readDash(token, PERIOD);
  let found = null;
  for (const u of after.unitsTree || []) {
    for (const sp of u.spaces || []) {
      if (sp.spaceId === space.spaceId) found = sp;
    }
  }
  const ok =
    found &&
    found.dueDayOfMonth === 1 &&
    found.dueDate === dueDateFor(PERIOD, 1) &&
    found.obligationId &&
    found.startDate === "2026-09-01";

  // Tear down test
  if (found?.obligationId) {
    try {
      await cmd(token, "cancelObligation", { obligationId: found.obligationId, reason: "إزالة اختبار إعادة الإدخال" }, `reentry-can-${stamp}`);
    } catch (e) { /* ignore */ }
  }
  await cmd(token, "closeRental", {
    rentalId: rental.rentalId,
    endDate: "2026-09-01",
    reason: "إزالة اختبار إعادة الإدخال",
    setVacant: true,
  }, `reentry-close-${stamp}`);

  const cleaned = await verify(token);
  return {
    spaceId: space.spaceId,
    spaceName: space.name,
    dueDayOfMonth: found?.dueDayOfMonth,
    dueDate: found?.dueDate,
    status: found?.status,
    reentryOk: !!ok,
    cleanAfterTeardown: cleaned.september.activeRentals === 0 && cleaned.september.activeObligations === 0,
  };
}

// ---- main ----
const inv = await inventory();
console.log("=== INVENTORY ===");
console.log(JSON.stringify(inv, null, 2));

if (MODE === "inventory") {
  process.exit(0);
}

const owner = await login("mig:user:owner:saeed", "1325");

if (MODE === "apply") {
  console.log("=== APPLY ===");
  const result = await applyReset(owner.token);
  console.log(JSON.stringify(result, null, 2));
  console.log("=== VERIFY AFTER APPLY ===");
  console.log(JSON.stringify(await verify(owner.token), null, 2));
}

if (MODE === "verify") {
  console.log("=== VERIFY ===");
  console.log(JSON.stringify(await verify(owner.token), null, 2));
}

if (MODE === "reentry") {
  console.log("=== REENTRY TEST ===");
  console.log(JSON.stringify(await reentryTest(owner.token), null, 2));
  console.log("=== VERIFY AFTER REENTRY ===");
  console.log(JSON.stringify(await verify(owner.token), null, 2));
}
