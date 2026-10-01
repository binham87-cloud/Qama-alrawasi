/**
 * READ-ONLY production forensic for September 2026 daily Target + installment logs.
 *
 *   OWNER_PIN=… node scripts/prod_forensic_sept_daily_installment.mjs
 *
 * Never mutates data. Never pays installments. Project: qama-new-prod-2026 only.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API_KEY = "AIzaSyBs0wIu2h2mnNMGr5SH-YNXjUhrdrGSNKg";
const REGION = "me-central1";
const PROJECT = "qama-new-prod-2026";
const PIN = process.env.OWNER_PIN;
if (!PIN) {
  console.error("OWNER_PIN env required (read-only forensic)");
  process.exit(2);
}
if (PROJECT === "qama-alrawasi") {
  console.error("REFUSING legacy project");
  process.exit(1);
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

const login = await callable("login", { userId: "mig:user:owner:saeed", pin: PIN });
const token = await signIn(login.customToken);
const dash = await callable("read", { what: "dashboard", period: "2026-09" }, token);
const s = dash.summary || {};
const extras = (dash.ui && dash.ui.extras) || {};
const bal = (dash.ui && dash.ui.config && dash.ui.config.balances) || {};
const daily = Array.isArray(extras.dailyBookings) ? extras.dailyBookings : [];
const logs = Array.isArray(extras.logs) ? extras.logs : [];
const instLogs = logs.filter((l) => /تم دفع قسط|قسط/.test(String(l.text || "")));

const rows = daily.map((b) => {
  const total = Number(b.total || 0);
  const cancelled = !!(b.cancelled || b.canceled || b.deleted || b.reversed
    || /cancel|deleted|reversed/i.test(String(b.status || "")));
  return {
    id: b.id,
    unitPart: b.partLabel || b.partId,
    startDate: b.startDate,
    endDate: b.endDate,
    nights: b.nights,
    amountAed: total,
    paymentStatus: b.paymentStatus || "unpaid",
    cancelled,
    contributesTarget: !cancelled && total > 0,
    note: "Collected/Holding derived from recognized daily receipts on server, not paymentStatus paint",
  };
});

const dailySumAed = rows.filter((r) => r.contributesTarget).reduce((a, r) => a + r.amountAed, 0);
const report = {
  project: PROJECT,
  mode: "read-only",
  period: "2026-09",
  generatedAt: new Date().toISOString(),
  summary: {
    targetFils: s.targetFils,
    targetAed: (s.targetFils || 0) / 100,
    obligationTargetFils: s.obligationTargetFils,
    obligationTargetAed: (s.obligationTargetFils || 0) / 100,
    dailyTargetFils: s.dailyTargetFils,
    dailyTargetAed: (s.dailyTargetFils || 0) / 100,
    collectedFils: s.collectedFils,
    collectedAed: (s.collectedFils || 0) / 100,
    remainingFils: s.remainingFils,
    remainingAed: (s.remainingFils || 0) / 100,
    dailyPaidFils: s.dailyPaidFils,
    holdingFils: s.holdingFils,
    incomeFils: s.incomeFils,
    expensesFils: s.expensesFils,
    profitTransferFils: s.profitTransferFils,
    paidInstallmentFils: s.paidInstallmentFils,
    netAfterProfitInstallmentFils: s.netAfterProfitInstallmentFils,
  },
  dailyPageSumAed: dailySumAed,
  dailyBookingCount: daily.length,
  dailyBookings: rows,
  installment: {
    installmentBalance: bal.installmentBalance,
    paidCount: (bal.installmentSchedule || []).filter((x) => x && x.paid).length,
    schedule: bal.installmentSchedule || [],
    payments: bal.installmentPayments || [],
    nextUnpaid: (bal.installmentSchedule || []).find((x) => x && !x.paid) || null,
  },
  duplicateInstallmentUiLogs: instLogs.map((l) => ({
    id: l.id,
    at: l.at,
    user: l.user || l.name,
    text: l.text,
  })),
  evidenceNote: {
    screenshotMainVsReconDiffAed: 1200,
    screenshotDailyPageAed: 1350,
    doNotHardcode: true,
  },
};

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "../artifacts");
mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, "forensic-sept-2026-readonly.json");
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  ok: true,
  outPath,
  targetAed: report.summary.targetAed,
  obligationTargetAed: report.summary.obligationTargetAed,
  dailyTargetAed: report.summary.dailyTargetAed,
  dailyPageSumAed: report.dailyPageSumAed,
  dailyBookingCount: report.dailyBookingCount,
  installmentBalance: report.installment.installmentBalance,
  paidCount: report.installment.paidCount,
  duplicateUiLogCount: report.duplicateInstallmentUiLogs.length,
}, null, 2));
