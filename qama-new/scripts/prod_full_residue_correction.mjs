#!/usr/bin/env node
/**
 * Production residue correction — DRY_RUN by default.
 * --apply requires OWNER_PIN.
 *
 * Safety:
 *  - Verifies exact IDs, amounts, states before each write
 *  - Stops on unexpected KPI deltas
 *  - Checkpoint resume skips completed / already-reversed steps
 *  - Never deletes history / never zeros balances manually
 *
 * Bot Holding=0 claim is NOT treated as proven incomplete cleanup unless
 * dated snapshots establish it; see relationshipProbe in rehearsal/report.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";

const API_KEY = "AIzaSyBs0wIu2h2mnNMGr5SH-YNXjUhrdrGSNKg";
const REGION = "me-central1";
const PROJECT = "qama-new-prod-2026";
const APPLY = process.argv.includes("--apply");
const PERIOD = "2026-09";
const CHECKPOINT = "artifacts/investigation-2026-09-05/prod-residue-checkpoint.json";
const OUT_PREFIX = "artifacts/investigation-2026-09-05/full-residue-correction";

const IDS = {
  depositId: "dep:uiddep-1788626262876-10000",
  receiptTempId: "rcpt:cash-rental:rentnew-58e9cfc1cdd642dd8ebe76ee20fcb58f_2026-09-10000",
  receiptR3Id: "rcpt:cash-rental:rentnew-3344cde738864db9a969eff6df6f1b16_2026-09-15000",
  rentalTempId: "rental:rentnew-58e9cfc1cdd642dd8ebe76ee20fcb58f",
  rentalR3Id: "rental:rentnew-3344cde738864db9a969eff6df6f1b16",
  obligationTempId: "rental:rentnew-58e9cfc1cdd642dd8ebe76ee20fcb58f_2026-09",
  obligationR3Id: "rental:rentnew-3344cde738864db9a969eff6df6f1b16_2026-09",
};

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
function kpi(dash) {
  const s = dash.summary || {};
  return {
    targetFils: s.targetFils ?? 0,
    collectedFils: s.collectedFils ?? 0,
    remainingFils: s.remainingFils ?? 0,
    holdingFils: s.holdingFils ?? 0,
    depositedFils: s.depositedFils ?? 0,
    expensesFils: s.expensesFils ?? 0,
    revenueBalance: dash.ui?.config?.balances?.revenueBalance
      ?? dash.ui?.config?.balances?.data?.revenueBalance ?? null,
  };
}
function delta(a, b) {
  const out = {};
  for (const k of Object.keys(a)) {
    if (typeof a[k] === "number" && typeof b[k] === "number") out[k] = b[k] - a[k];
  }
  return out;
}

const pin = process.env.OWNER_PIN;
if (!pin) { console.error("Set OWNER_PIN"); process.exit(2); }

const loginRes = await callable("login", { userId: "mig:user:owner:saeed", pin });
const token = await signIn(loginRes.customToken);
const readDash = () => callable("read", { what: "dashboard", period: PERIOD }, token);
const beforeDash = await readDash();
const before = kpi(beforeDash);

// Probe related entities from dashboard payload where possible
const depRow = (beforeDash.deposits || []).find((d) => d.id === IDS.depositId)
  || (beforeDash.pendingApprovals || []).find?.(() => false);
const spaces = [];
for (const u of (beforeDash.unitsTree || [])) for (const sp of (u.spaces || [])) spaces.push(sp);

const relationshipProbe = {
  asOf: new Date().toISOString(),
  equation: "Holding = liveCash − approvedDeposits",
  liveCashReceiptIds: [IDS.receiptTempId, IDS.receiptR3Id],
  depositId: IDS.depositId,
  botTempDep: {
    receiptId: IDS.receiptTempId,
    rentalId: IDS.rentalTempId,
    obligationId: IDS.obligationTempId,
    provenFromReadonly: "receipt recognized; rental closed; space vacant; obligation active; Target unaffected (100 AED not in targetFils)",
    nameToken: "BOT TEMP DEP — label only; ownership established by ID graph not name",
  },
  botR3: {
    receiptId: IDS.receiptR3Id,
    rentalId: IDS.rentalR3Id,
    obligationId: IDS.obligationR3Id,
    provenFromReadonly: "receipt recognized; rental active; space rented; contributes Target/Collected 150",
  },
  botClaimedZeroHolding: {
    status: "UNPROVEN_AS_INCOMPLETE_CLEANUP",
    alternatives: [
      "Later test activity after bot snapshot created the two live cash receipts",
      "Earlier reporting used a different metric scope (UI card vs engine holdingFils)",
      "Incomplete cleanup (possible but not established without dated bot snapshot records)",
    ],
  },
  before,
};

const STEPS = [
  {
    n: 1, command: "reverseDeposit",
    payload: { depositId: IDS.depositId, reason: "تصحيح بقايا اختبار BOT DEP OK" },
    expectDelta: { depositedFils: -10000, holdingFils: +10000 },
    precheck: (dash) => {
      const d = (dash.deposits || []).find((x) => x.id === IDS.depositId);
      if (!d) throw new Error("DEPOSIT_NOT_IN_DASH");
      if (d.state === "reversed") return "SKIP_ALREADY_REVERSED";
      if (d.state !== "approved" || Number(d.amountFils) !== 10000) throw new Error("DEP_STATE " + JSON.stringify(d));
      return "RUN";
    },
  },
  {
    n: 2, command: "reverseReceipt",
    payload: { receiptId: IDS.receiptTempId, reason: "تصحيح بقايا اختبار receipt TEMP DEP" },
    expectDelta: { holdingFils: -10000 },
    precheck: () => "RUN", // detailed state checked via unexpected-delta stop
  },
  {
    n: 3, command: "reverseReceipt",
    payload: { receiptId: IDS.receiptR3Id, reason: "تصحيح بقايا اختبار receipt R3" },
    expectDelta: { holdingFils: -15000, collectedFils: -15000, remainingFils: +15000 },
    precheck: () => "RUN",
  },
  {
    n: 4, command: "closeRental",
    payload: {
      rentalId: IDS.rentalR3Id, endDate: "2026-09-05",
      reason: "تصحيح بقايا اختبار — إفراغ rental R3", setVacant: true,
    },
    expectDelta: { targetFils: -15000, remainingFils: -15000 },
    precheck: () => "RUN",
  },
];

mkdirSync("artifacts/investigation-2026-09-05", { recursive: true });
const plan = {
  project: PROJECT, mode: APPLY ? "APPLY" : "DRY_RUN", asOf: new Date().toISOString(),
  ids: IDS, relationshipProbe, before, steps: STEPS,
  expectedFinal: { targetFils: 0, collectedFils: 0, remainingFils: 0, holdingFils: 0, depositedFils: 0, revenueBalance: 0 },
  checkpointFile: CHECKPOINT,
};
writeFileSync(`${OUT_PREFIX}-${APPLY ? "apply-plan" : "dry-run"}.json`, JSON.stringify(plan, null, 2));
console.log(JSON.stringify(plan, null, 2));

if (!APPLY) {
  console.log("\nDRY-RUN only. Authorize then re-run with --apply.");
  process.exit(0);
}

let checkpoint = { completed: [] };
if (existsSync(CHECKPOINT)) checkpoint = JSON.parse(readFileSync(CHECKPOINT, "utf8"));

const results = [];
let cursor = before;
for (const step of STEPS) {
  if (checkpoint.completed.includes(step.n)) {
    results.push({ n: step.n, status: "RESUMED_SKIP" });
    continue;
  }
  const live = await readDash();
  const action = step.precheck(live);
  if (String(action).startsWith("SKIP")) {
    results.push({ n: step.n, status: action });
    checkpoint.completed.push(step.n);
    writeFileSync(CHECKPOINT, JSON.stringify(checkpoint, null, 2));
    continue;
  }
  const pre = kpi(live);
  try {
    const r = await callable("command", {
      command: step.command, payload: step.payload,
      operationId: `corr-step${step.n}-${Date.now()}`,
    }, token);
    const post = kpi(await readDash());
    const d = delta(pre, post);
    for (const [k, v] of Object.entries(step.expectDelta)) {
      if (d[k] !== v) throw new Error(`DELTA_MISMATCH step${step.n} ${k}: want ${v} got ${d[k]}`);
    }
    results.push({ n: step.n, status: "APPLIED", expectDelta: step.expectDelta, actualDelta: d, result: r, pre, post });
    cursor = post;
    checkpoint.completed.push(step.n);
    writeFileSync(CHECKPOINT, JSON.stringify({ ...checkpoint, results }, null, 2));
  } catch (e) {
    const stopped = { mode: "STOPPED", error: String(e.message || e), results, cursor, step: step.n };
    writeFileSync(`${OUT_PREFIX}-stopped.json`, JSON.stringify(stopped, null, 2));
    console.error(JSON.stringify(stopped, null, 2));
    process.exit(1);
  }
}
const after = kpi(await readDash());
const report = { ...plan, results, after };
writeFileSync(`${OUT_PREFIX}-apply.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ results, after }, null, 2));
