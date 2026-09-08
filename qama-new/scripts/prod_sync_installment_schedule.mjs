/**
 * Align installment schedule with proven money evidence only.
 *
 * Proven: installmentBalance 20706 = 200000 − 179294 (ONE debit).
 * The empty-schedule UI previously presented 2026-06-30 as the pay target.
 * Dec-2025 / Mar-2026 were NEVER proven paid — marking them paid was experimental
 * and is reverted here.
 *
 *   OWNER_PIN=… node scripts/prod_sync_installment_schedule.mjs
 *
 * Does not print the PIN.
 */
const API_KEY = "AIzaSyBs0wIu2h2mnNMGr5SH-YNXjUhrdrGSNKg";
const REGION = "me-central1";
const PROJECT = "qama-new-prod-2026";
const PIN = process.env.OWNER_PIN;
if (!PIN) {
  console.error("OWNER_PIN env required");
  process.exit(2);
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
const bal = dash.ui?.config?.balances || {};
const revenueBalance = Number(bal.revenueBalance ?? 0);
const companyBalance = Number(bal.companyBalance ?? 0);
const installmentBalance = Number(bal.installmentBalance ?? 20706);

// Evidence-based: only the June installment that matched the single 179294 debit.
const schedule = [
  { date: "2025-12-31", amount: 179294, paid: false, evidence: "unproven" },
  { date: "2026-03-31", amount: 179294, paid: false, evidence: "unproven" },
  { date: "2026-06-30", amount: 179294, paid: true, evidence: "single_debit_remainder_20706" },
  { date: "2026-09-30", amount: 179294, paid: false, evidence: "upcoming" },
  { date: "2026-12-31", amount: 179294, paid: false, evidence: "upcoming" },
  { date: "2027-03-31", amount: 179294, paid: false, evidence: "upcoming" },
];

await callable("command", {
  command: "upsertUiConfig",
  payload: {
    configId: "balances",
    json: JSON.stringify({
      companyBalance,
      revenueBalance,
      installmentBalance,
      installmentSchedule: schedule,
      installmentScheduleNote: "experimental_repair: only 2026-06-30 marked paid from balance evidence 200000-179294=20706; earlier dates unproven",
    }),
  },
  operationId: `sync-inst-evid-${Date.now()}`.slice(0, 120),
}, token);

const after = await callable("read", { what: "dashboard", period: "2026-09" }, token);
const b2 = after.ui?.config?.balances || {};
console.log(JSON.stringify({
  ok: true,
  classification: "experimental_schedule_repair_evidence_based",
  moneyEvidence: { installmentBalance: b2.installmentBalance, impliedDebits: 1, debitAmount: 179294 },
  schedule: (b2.installmentSchedule || []).map((x) => ({ date: x.date, amount: x.amount, paid: !!x.paid, evidence: x.evidence || null })),
  paidCount: (b2.installmentSchedule || []).filter((x) => x.paid).length,
  nextUnpaid: (b2.installmentSchedule || []).find((x) => !x.paid),
}, null, 2));
