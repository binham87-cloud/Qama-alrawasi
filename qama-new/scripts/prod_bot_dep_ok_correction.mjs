/**
 * Narrow production CORRECTION for BOT DEP OK residue.
 * Default: DRY-RUN (read-only). Pass --apply to execute reverseDeposit.
 *
 * Target: qama-new-prod-2026 ONLY.
 * Does NOT touch qama-alrawasi.
 * Does NOT delete history — uses auditable reverseDeposit.
 *
 * Auth: OWNER_PIN env (never logged).
 */
import { writeFileSync, mkdirSync } from "node:fs";

const API_KEY = "AIzaSyBs0wIu2h2mnNMGr5SH-YNXjUhrdrGSNKg";
const REGION = "me-central1";
const PROJECT = "qama-new-prod-2026";
const DEP_ID = "dep:uiddep-1788626262876-10000";
const APPLY = process.argv.includes("--apply");
const PERIOD = "2026-09";

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
function kpi(dash) {
  const s = dash.summary || {};
  return {
    targetFils: s.targetFils,
    collectedFils: s.collectedFils,
    companyCollectedFils: s.companyCollectedFils,
    remainingFils: s.remainingFils,
    holdingFils: s.holdingFils,
    depositedFils: s.depositedFils,
    approvedDepositsFils: s.approvedDepositsFils,
    expensesFils: s.expensesFils,
    revenueBalance: dash.ui?.config?.balances?.revenueBalance
      ?? dash.ui?.config?.balances?.data?.revenueBalance
      ?? null,
  };
}

const pin = process.env.OWNER_PIN;
if (!pin) {
  console.error("Set OWNER_PIN (not echoed). Abort.");
  process.exit(2);
}

const owner = await login("mig:user:owner:saeed", pin);
const beforeDash = await callable("read", { what: "dashboard", period: PERIOD }, owner.token);
const before = kpi(beforeDash);
const dep = (beforeDash.deposits || []).find((d) => d.id === DEP_ID);

const plan = {
  project: PROJECT,
  mode: APPLY ? "APPLY" : "DRY_RUN",
  depositId: DEP_ID,
  deposit: dep || null,
  before,
  expectedIfApply: dep && dep.state === "approved" ? {
    depositedFils: before.depositedFils - dep.amountFils,
    approvedDepositsFils: (before.approvedDepositsFils || before.depositedFils) - dep.amountFils,
    holdingFils: before.holdingFils + dep.amountFils,
    revenueBalanceDeltaAed: -(dep.amountFils / 100),
    command: "reverseDeposit",
    reason: "تصحيح بقايا اختبار BOT DEP OK — عكس معتمد مرتبط",
  } : { note: "No approved BOT DEP OK deposit to reverse" },
};

mkdirSync("artifacts/investigation-2026-09-05", { recursive: true });
writeFileSync(
  `artifacts/investigation-2026-09-05/bot-dep-ok-${APPLY ? "apply" : "dry-run"}.json`,
  JSON.stringify(plan, null, 2)
);

console.log(JSON.stringify(plan, null, 2));

if (!APPLY) {
  console.log("\nDRY-RUN only. Re-run with --apply after owner authorization.");
  process.exit(0);
}

if (!dep) throw new Error("BOT DEP OK deposit not found");
if (dep.state === "reversed") {
  console.log("Already reversed — no write.");
  process.exit(0);
}
if (dep.state !== "approved") throw new Error("Unexpected state: " + dep.state);

const result = await callable("command", {
  command: "reverseDeposit",
  payload: { depositId: DEP_ID, reason: "تصحيح بقايا اختبار BOT DEP OK — عكس معتمد مرتبط" },
  operationId: `corr-revdep-botdepok-${Date.now()}`,
}, owner.token);

const afterDash = await callable("read", { what: "dashboard", period: PERIOD }, owner.token);
const after = kpi(afterDash);
const afterDep = (afterDash.deposits || []).find((d) => d.id === DEP_ID);
const report = { ...plan, result, after, afterDeposit: afterDep };
writeFileSync(
  "artifacts/investigation-2026-09-05/bot-dep-ok-apply.json",
  JSON.stringify(report, null, 2)
);
console.log(JSON.stringify({ result, after, afterDeposit: afterDep }, null, 2));
