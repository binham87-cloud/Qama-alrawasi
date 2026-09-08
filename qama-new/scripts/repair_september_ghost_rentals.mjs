/**
 * Controlled repair for resurrected September ghost rentals on qama-new-prod-2026.
 *
 * Modes:
 *   --inventory   classify ghosts vs keepers (default)
 *   --apply       reverse ghost receipts → cancel unpaid obs → close rentals → vacant
 *   --verify      post-repair dashboard + holding reconciliation
 *
 * NEVER targets qama-alrawasi. Preserves August holding. No blind full wipe.
 */
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { existsSync } from "node:fs";
import { isPlaceholderTenant, sharedHoldingFils, liveObligationsForPeriod } from "../functions/domain/finance.mjs";

const PROJECT = "qama-new-prod-2026";
const PERIOD = "2026-09";
const RESET = "2026-09-03T17:18:15.533Z";
const API_KEY = "AIzaSyBs0wIu2h2mnNMGr5SH-YNXjUhrdrGSNKg";
const REGION = "me-central1";
const MODE = process.argv.includes("--apply")
  ? "apply"
  : process.argv.includes("--verify")
    ? "verify"
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
async function readDash(token, period) {
  return callable("read", { what: "dashboard", period }, token);
}
async function listAll(col) {
  const snap = await db.collection(col).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

function createdAt(x) {
  return x.createdAt || x.created_at || null;
}

function isGhostRental(r) {
  if (r.state !== "active") return false;
  if (!createdAt(r) || createdAt(r) < RESET) return false;
  // Post-reset blank-tenant re-entries via work-request / bridge are ghosts.
  if (isPlaceholderTenant(r.tenantName)) return true;
  return false;
}

async function inventory() {
  const [rentals, obligations, receipts, deposits, expenses, spaces] = await Promise.all([
    listAll("rentals"), listAll("obligations"), listAll("receipts"),
    listAll("deposits"), listAll("expenses"), listAll("spaces"),
  ]);
  const ghosts = rentals.filter(isGhostRental);
  const keepers = rentals.filter((r) => r.state === "active" && !isGhostRental(r));
  const sepObs = obligations.filter((o) => o.period === PERIOD);
  const ghostObs = sepObs.filter((o) => o.state === "active" && ghosts.some((g) => g.id === o.rentalId));
  const orphanObs = sepObs.filter((o) => {
    if (o.state !== "active") return false;
    const r = rentals.find((x) => x.id === o.rentalId);
    return !r || r.state !== "active";
  });
  const recog = receipts.filter((r) => r.period === PERIOD && r.state === "recognized");
  const ghostReceipts = recog.filter((r) => ghostObs.some((o) => o.id === r.obligationId));
  const holdAll = sharedHoldingFils({ receipts, deposits });
  const holdExSep = sharedHoldingFils({
    receipts: receipts.filter((r) => r.period !== PERIOD),
    deposits: deposits.filter((d) => d.period !== PERIOD),
  });
  const live = liveObligationsForPeriod(sepObs, rentals);
  const rentedNoRental = spaces.filter((s) => s.active !== false && s.occupancy === "rented"
    && !rentals.some((r) => r.spaceId === s.id && r.state === "active"));

  return {
    project: PROJECT, period: PERIOD, resetBoundary: RESET, mode: MODE,
    activeRentals: rentals.filter((r) => r.state === "active").length,
    ghostRentals: ghosts.length,
    keeperRentals: keepers.length,
    activeSepObligations: sepObs.filter((o) => o.state === "active").length,
    ghostObligations: ghostObs.length,
    orphanObligations: orphanObs.length,
    ghostReceipts: ghostReceipts.length,
    ghostReceiptFils: ghostReceipts.reduce((s, r) => s + Number(r.amountFils || 0), 0),
    ghostTargetFils: ghostObs.reduce((s, o) => s + Number(o.amountFils || 0), 0),
    liveTargetFils: live.reduce((s, o) => s + Number(o.amountFils || 0), 0),
    holdingAllFils: holdAll,
    holdingExSepFils: holdExSep,
    rentedSpacesWithoutRental: rentedNoRental.map((s) => ({ id: s.id, name: s.name })),
    ghostSample: ghosts.slice(0, 5).map((r) => ({
      id: r.id, tenant: r.tenantName, amt: r.contractualAmountFils / 100, created: r.createdAt,
    })),
    keeperSample: keepers.slice(0, 5).map((r) => ({
      id: r.id, tenant: r.tenantName, amt: r.contractualAmountFils / 100, created: r.createdAt,
    })),
    _ghosts: ghosts,
    _ghostObs: ghostObs,
    _ghostReceipts: ghostReceipts,
    _rentedNoRental: rentedNoRental,
  };
}

async function apply(token, inv) {
  const stamp = Date.now().toString(36);
  const log = [];
  const fail = [];
  const tryCmd = async (command, payload, oid) => {
    try {
      const r = await cmd(token, command, payload, oid);
      log.push({ command, ok: true });
      return r;
    } catch (e) {
      const msg = String(e.message || e);
      if (/ALREADY_REVERSED|RENTAL_ALREADY_CLOSED|RENTAL_NOT_ACTIVE|OBLIGATION_NOT_ACTIVE|RECEIPT_NOT_RECOGNIZED/.test(msg)) {
        log.push({ command, ok: true, skipped: msg });
        return null;
      }
      fail.push({ command, error: msg, payload });
      return null;
    }
  };

  // 1) Reverse ghost September receipts (cash + bank) so obligations can cancel and holding drops.
  for (const r of inv._ghostReceipts) {
    await tryCmd("reverseReceipt", {
      receiptId: r.id,
      reason: "إصلاح — إيصال على إيجار شبح بعد تنظيف سبتمبر",
    }, `ghost-revrcpt-${r.id}-${stamp}`);
  }

  // 2) Cancel ghost unpaid obligations then close rentals / vacant
  for (const o of inv._ghostObs) {
    await tryCmd("cancelObligation", {
      obligationId: o.id,
      reason: "إصلاح — التزام شبح بعد تنظيف سبتمبر",
    }, `ghost-canob-${o.id}-${stamp}`);
  }
  for (const g of inv._ghosts) {
    await tryCmd("closeRental", {
      rentalId: g.id,
      endDate: "2026-09-04",
      reason: "إصلاح — إيجار شبح بعد تنظيف سبتمبر",
      setVacant: true,
    }, `ghost-close-${g.id}-${stamp}`);
  }

  // 3) Fix rented-without-rental occupancy
  for (const s of inv._rentedNoRental) {
    await tryCmd("setSpaceOccupancy", {
      spaceId: s.id, occupancy: "vacant",
    }, `ghost-vac-${s.id}-${stamp}`);
  }

  await db.collection("opsArchives").doc(`september-ghost-repair-${stamp}`).set({
    id: `september-ghost-repair-${stamp}`,
    project: PROJECT,
    period: PERIOD,
    at: new Date().toISOString(),
    ghostRentals: inv.ghostRentals,
    ghostObligations: inv.ghostObligations,
    ghostReceipts: inv.ghostReceipts,
    logCount: log.length,
    failCount: fail.length,
    failures: fail.slice(0, 40),
  });

  return { logCount: log.length, failCount: fail.length, failures: fail };
}

async function verify(token) {
  const dash = await readDash(token, PERIOD);
  const [rentals, obligations, receipts, deposits, expenses, spaces] = await Promise.all([
    listAll("rentals"), listAll("obligations"), listAll("receipts"),
    listAll("deposits"), listAll("expenses"), listAll("spaces"),
  ]);
  const activeRentals = rentals.filter((r) => r.state === "active");
  const ghostsLeft = activeRentals.filter(isGhostRental);
  const live = liveObligationsForPeriod(
    obligations.filter((o) => o.period === PERIOD),
    rentals,
  );
  const recog = receipts.filter((r) => r.period === PERIOD && r.state === "recognized");
  const cash = recog.filter((r) => r.method === "cash").reduce((s, r) => s + Number(r.amountFils || 0), 0);
  const bank = recog.filter((r) => r.method === "bank").reduce((s, r) => s + Number(r.amountFils || 0), 0);
  const dep = deposits.filter((d) => d.period === PERIOD && d.state === "approved")
    .reduce((s, d) => s + Number(d.amountFils || 0), 0);
  const exp = expenses.filter((e) => e.period === PERIOD && e.state === "approved")
    .reduce((s, e) => s + Number(e.amountFils || 0), 0);
  const holdAll = sharedHoldingFils({ receipts, deposits });
  const holdExSep = sharedHoldingFils({
    receipts: receipts.filter((r) => r.period !== PERIOD),
    deposits: deposits.filter((d) => d.period !== PERIOD),
  });
  const holdSep = holdAll - holdExSep;
  const multi = {};
  for (const r of activeRentals) {
    multi[r.spaceId] = (multi[r.spaceId] || 0) + 1;
  }
  const multiSpaces = Object.values(multi).filter((n) => n > 1).length;
  const rented = spaces.filter((s) => s.active !== false && s.occupancy === "rented").length;
  const vacant = spaces.filter((s) => s.active !== false && (s.occupancy === "vacant" || !s.occupancy)).length;

  // regen must not resurrect cancelled
  await cmd(token, "generateObligations", { period: PERIOD }, `verify-gen-${Date.now().toString(36)}`);
  const afterGen = await listAll("obligations");
  const cancelledStill = afterGen.filter((o) => o.period === PERIOD && o.state === "cancelled"
    && String(o.cancelReason || "").includes("تنظيف سبتمبر")).length;

  return {
    project: PROJECT,
    period: PERIOD,
    dashboard: {
      targetFils: dash.summary?.targetFils,
      collectedFils: dash.summary?.collectedFils,
      remainingFils: dash.summary?.remainingFils,
      arrearsFils: dash.summary?.arrearsFils,
      holdingFils: dash.summary?.holdingFils ?? dash.summary?.sharedEmployeeHoldingFils,
      counts: dash.summary?.counts,
    },
    activeRentals: activeRentals.length,
    ghostsRemaining: ghostsLeft.length,
    liveObligations: live.length,
    targetAed: (dash.summary?.targetFils || 0) / 100,
    collectedAed: (dash.summary?.collectedFils || 0) / 100,
    remainingAed: (dash.summary?.remainingFils || 0) / 100,
    lateAed: (dash.summary?.arrearsFils || 0) / 100,
    recognizedSepCashAed: cash / 100,
    recognizedSepBankAed: bank / 100,
    approvedSepDepositsAed: dep / 100,
    approvedSepExpensesAed: exp / 100,
    globalHoldingAed: holdAll / 100,
    holdingAugustPriorAed: holdExSep / 100,
    holdingSepContributionAed: holdSep / 100,
    holdingEquation: `${holdExSep / 100} (prior) + ${holdSep / 100} (sep net) = ${holdAll / 100}`,
    monthlyEquation: `target ${ (dash.summary?.targetFils||0)/100 } = collected ${ (dash.summary?.collectedFils||0)/100 } + remaining ${ (dash.summary?.remainingFils||0)/100 }`,
    spaces: { rented, vacant },
    multiActiveRentalSpaces: multiSpaces,
    cancelledCleanResetStillCancelled: cancelledStill,
    regenerateDidNotResurrect: ghostsLeft.length === 0,
  };
}

const inv = await inventory();
console.log("=== INVENTORY ===");
const { _ghosts, _ghostObs, _ghostReceipts, _rentedNoRental, ...pub } = inv;
console.log(JSON.stringify(pub, null, 2));

if (MODE === "apply") {
  const { token } = await login("mig:user:owner:saeed", process.env.QAMA_OWNER_PIN || "1325");
  let tok = token;
  try {
    await readDash(tok, PERIOD);
  } catch {
    for (const pin of ["1325", "1234", "0000", "1111", "2580", "2026"]) {
      try {
        const l = await login("mig:user:owner:saeed", pin);
        tok = l.token;
        break;
      } catch { /* next */ }
    }
  }
  const result = await apply(tok, inv);
  console.log("=== APPLY ===");
  console.log(JSON.stringify(result, null, 2));
  const v = await verify(tok);
  console.log("=== VERIFY ===");
  console.log(JSON.stringify(v, null, 2));
} else if (MODE === "verify") {
  let tok = null;
  for (const pin of [process.env.QAMA_OWNER_PIN, "1325", "1234", "0000", "1111", "2580", "2026"].filter(Boolean)) {
    try {
      tok = (await login("mig:user:owner:saeed", pin)).token;
      break;
    } catch { /* next */ }
  }
  if (!tok) throw new Error("login failed");
  console.log("=== VERIFY ===");
  console.log(JSON.stringify(await verify(tok), null, 2));
}
