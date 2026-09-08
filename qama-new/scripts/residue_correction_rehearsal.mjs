#!/usr/bin/env node
/**
 * Isolated residue-correction rehearsal against Firebase emulators.
 * Seeds prod-shaped relationships, verifies preconditions, applies steps with
 * checkpoint resume, stops on unexpected KPI deltas, skips already-reversed.
 *
 * Does NOT touch production.
 *
 *   firebase emulators:exec --project qama-new-prod-2026 \
 *     --only firestore,auth,functions \
 *     "node seed/seed_residue_rehearsal.mjs > /tmp/reh-seed.json \
 *      && node scripts/residue_correction_rehearsal.mjs"
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { initializeApp, getApps, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { initializeApp as initClient, deleteApp as delClient } from "firebase/app";
import { getAuth as getClientAuth, connectAuthEmulator, signInWithCustomToken } from "firebase/auth";
import { getFunctions, connectFunctionsEmulator, httpsCallable } from "firebase/functions";
import { buildDashboard } from "../functions/services/readModel.mjs";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error("REFUSED: emulator only");
  process.exit(2);
}

const PROJECT = process.env.GCLOUD_PROJECT || "qama-new-prod-2026";
const PERIOD = "2026-09";
const CHECKPOINT = "artifacts/investigation-2026-09-05/residue-rehearsal-checkpoint.json";
const OUT = "artifacts/investigation-2026-09-05/residue-rehearsal-report.json";
const FORCE = process.argv.includes("--fresh");

while (getApps().length) await deleteApp(getApps()[0]);
initializeApp({ projectId: PROJECT });
const firestore = getFirestore();
const auth = getAuth();

const readerDb = {
  async list(collection, wheres = []) {
    let q = firestore.collection(collection);
    for (const [f, op, v] of wheres) q = q.where(f, op, v);
    const snap = await q.get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  },
  async getUser(userId) {
    const snap = await firestore.collection("users").doc(String(userId)).get();
    return snap.exists ? { id: snap.id, ...snap.data() } : null;
  },
  async listActiveUsers() {
    const snap = await firestore.collection("users").where("active", "==", true).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  },
};

function kpiFromDash(dash) {
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

async function dash() {
  const viewer = { userId: "mig:user:owner:saeed", role: "owner", active: true, displayName: "مدير" };
  return buildDashboard({ db: readerDb, viewer, period: PERIOD, asOfDate: "2026-09-28" });
}

function delta(before, after) {
  const out = {};
  for (const k of Object.keys(before)) {
    if (typeof before[k] === "number" && typeof after[k] === "number") out[k] = after[k] - before[k];
    else out[k] = { before: before[k], after: after[k] };
  }
  return out;
}

function assertEq(actual, expected, label) {
  for (const [k, v] of Object.entries(expected)) {
    if (actual[k] !== v) {
      throw new Error(`UNEXPECTED ${label}: ${k} expected ${v} got ${actual[k]}`);
    }
  }
}

// Discover rehearsal records by reference/tenant (seed wrote them)
const deposits = await readerDb.list("deposits");
const receipts = await readerDb.list("receipts");
const rentals = await readerDb.list("rentals");
const obligations = await readerDb.list("obligations");
const spaces = await readerDb.list("spaces");

const dep = deposits.find((d) => d.reference === "REH DEP OK");
const rcptTemp = receipts.find((r) => r.state === "recognized" && r.amountFils === 10000
  && rentals.find((x) => x.id === r.rentalId && x.tenantName === "REH TEMP DEP"));
const rcptR3 = receipts.find((r) => r.state === "recognized" && r.amountFils === 15000
  && rentals.find((x) => x.id === r.rentalId && x.tenantName === "REH R3 TENANT"));
const rentalTemp = rentals.find((r) => r.tenantName === "REH TEMP DEP");
const rentalR3 = rentals.find((r) => r.tenantName === "REH R3 TENANT");
const obTemp = obligations.find((o) => o.rentalId === rentalTemp?.id);
const obR3 = obligations.find((o) => o.rentalId === rentalR3?.id);
const spaceTemp = spaces.find((s) => s.id === rentalTemp?.spaceId);
const spaceR3 = spaces.find((s) => s.id === rentalR3?.spaceId);

const ids = {
  depositId: dep?.id,
  receiptTempId: rcptTemp?.id,
  receiptR3Id: rcptR3?.id,
  rentalTempId: rentalTemp?.id,
  rentalR3Id: rentalR3?.id,
  obligationTempId: obTemp?.id,
  obligationR3Id: obR3?.id,
  spaceTempId: spaceTemp?.id,
  spaceR3Id: spaceR3?.id,
};

const relationshipProbe = {
  botTempDepShape: {
    receipt: rcptTemp && { id: rcptTemp.id, state: rcptTemp.state, amountFils: rcptTemp.amountFils, obligationId: rcptTemp.obligationId },
    rental: rentalTemp && { id: rentalTemp.id, state: rentalTemp.state, endDate: rentalTemp.endDate, tenantName: rentalTemp.tenantName },
    obligation: obTemp && { id: obTemp.id, state: obTemp.state, dueFils: obTemp.dueFils ?? obTemp.amountFils },
    space: spaceTemp && { id: spaceTemp.id, occupancy: spaceTemp.occupancy, name: spaceTemp.name },
    note: "Prod analog: recognized cash + closed rental + vacant space + obligation may remain active; Target excludes it when rental not live.",
  },
  botR3Shape: {
    receipt: rcptR3 && { id: rcptR3.id, state: rcptR3.state, amountFils: rcptR3.amountFils },
    rental: rentalR3 && { id: rentalR3.id, state: rentalR3.state, tenantName: rentalR3.tenantName },
    obligation: obR3 && { id: obR3.id, state: obR3.state },
    space: spaceR3 && { id: spaceR3.id, occupancy: spaceR3.occupancy },
  },
  deposit: dep && { id: dep.id, state: dep.state, amountFils: dep.amountFils, reference: dep.reference },
};

if (!dep || !rcptTemp || !rcptR3 || !rentalR3) {
  console.error("SEED_INCOMPLETE", ids);
  process.exit(1);
}

const before = kpiFromDash(await dash());
assertEq(before, {
  targetFils: 15000, collectedFils: 15000, remainingFils: 0,
  holdingFils: 15000, depositedFils: 10000,
}, "baseline KPI");

const STEPS = [
  {
    n: 1, command: "reverseDeposit",
    payload: { depositId: dep.id, reason: "reh reverse dep" },
    pre: async () => {
      const d = (await firestore.doc(`deposits/${dep.id}`).get()).data();
      if (d.state === "reversed") return "SKIP_ALREADY_REVERSED";
      if (d.state !== "approved" || d.amountFils !== 10000) throw new Error("DEP_PRECONDITION " + JSON.stringify(d));
      return "RUN";
    },
    expectDelta: { depositedFils: -10000, holdingFils: +10000, targetFils: 0, collectedFils: 0, remainingFils: 0 },
  },
  {
    n: 2, command: "reverseReceipt",
    payload: { receiptId: rcptTemp.id, reason: "reh reverse temp cash" },
    pre: async () => {
      const r = (await firestore.doc(`receipts/${rcptTemp.id}`).get()).data();
      if (r.state === "reversed") return "SKIP_ALREADY_REVERSED";
      if (r.state !== "recognized" || r.amountFils !== 10000) throw new Error("RCPT_TEMP_PRE " + JSON.stringify(r));
      return "RUN";
    },
    expectDelta: { holdingFils: -10000, depositedFils: 0, targetFils: 0, collectedFils: 0, remainingFils: 0 },
  },
  {
    n: 3, command: "reverseReceipt",
    payload: { receiptId: rcptR3.id, reason: "reh reverse r3 cash" },
    pre: async () => {
      const r = (await firestore.doc(`receipts/${rcptR3.id}`).get()).data();
      if (r.state === "reversed") return "SKIP_ALREADY_REVERSED";
      if (r.state !== "recognized" || r.amountFils !== 15000) throw new Error("RCPT_R3_PRE " + JSON.stringify(r));
      return "RUN";
    },
    expectDelta: { holdingFils: -15000, collectedFils: -15000, remainingFils: +15000, targetFils: 0, depositedFils: 0 },
  },
  {
    n: 4, command: "closeRental",
    payload: {
      rentalId: rentalR3.id, endDate: "2026-09-05", reason: "reh vacate r3", setVacant: true,
    },
    pre: async () => {
      const r = (await firestore.doc(`rentals/${rentalR3.id}`).get()).data();
      if (r.state === "closed") return "SKIP_ALREADY_CLOSED";
      if (r.state !== "active") throw new Error("RENTAL_R3_PRE " + JSON.stringify(r));
      return "RUN";
    },
    expectDelta: { targetFils: -15000, remainingFils: -15000, collectedFils: 0, holdingFils: 0, depositedFils: 0 },
  },
];

let checkpoint = { completed: [], steps: [] };
if (!FORCE && existsSync(CHECKPOINT)) {
  checkpoint = JSON.parse(readFileSync(CHECKPOINT, "utf8"));
}

const clientApp = initClient({ apiKey: "demo", projectId: PROJECT, appId: "reh" }, "reh");
const clientAuth = getClientAuth(clientApp);
const fns = getFunctions(clientApp, "me-central1");
connectAuthEmulator(clientAuth, "http://127.0.0.1:9099", { disableWarnings: true });
connectFunctionsEmulator(fns, "127.0.0.1", 5001);

const token = await auth.createCustomToken("mig:user:owner:saeed");
await signInWithCustomToken(clientAuth, token);
const commandFn = httpsCallable(fns, "command");

const stepResults = [];
let cursor = before;

for (const step of STEPS) {
  if (checkpoint.completed.includes(step.n)) {
    stepResults.push({ n: step.n, status: "RESUMED_SKIP", command: step.command });
    continue;
  }
  const action = await step.pre();
  if (action.startsWith("SKIP")) {
    stepResults.push({ n: step.n, status: action, command: step.command });
    checkpoint.completed.push(step.n);
    writeFileSync(CHECKPOINT, JSON.stringify(checkpoint, null, 2));
    continue;
  }
  const preKpi = kpiFromDash(await dash());
  try {
    const result = await commandFn({
      command: step.command,
      payload: step.payload,
      operationId: `reh-step${step.n}-${Date.now()}`,
    });
    const postKpi = kpiFromDash(await dash());
    const d = delta(preKpi, postKpi);
    // Compare only keys listed in expectDelta
    for (const [k, v] of Object.entries(step.expectDelta)) {
      if (d[k] !== v) {
        throw new Error(`DELTA_MISMATCH step${step.n} ${k}: expected ${v} got ${d[k]} (pre=${JSON.stringify(preKpi)} post=${JSON.stringify(postKpi)})`);
      }
    }
    stepResults.push({
      n: step.n, status: "APPLIED", command: step.command,
      expectDelta: step.expectDelta, actualDelta: d, preKpi, postKpi,
      result: result.data,
    });
    cursor = postKpi;
    checkpoint.completed.push(step.n);
    checkpoint.steps = stepResults;
    mkdirSync("artifacts/investigation-2026-09-05", { recursive: true });
    writeFileSync(CHECKPOINT, JSON.stringify(checkpoint, null, 2));
  } catch (e) {
    const report = {
      mode: "REHEARSAL_STOPPED",
      error: String(e.message || e),
      ids, relationshipProbe, before, cursor, stepResults, failedStep: step.n,
    };
    writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.error(JSON.stringify(report, null, 2));
    await delClient(clientApp);
    process.exit(1);
  }
}

const after = kpiFromDash(await dash());
const finalExpected = {
  targetFils: 0, collectedFils: 0, remainingFils: 0,
  holdingFils: 0, depositedFils: 0, expensesFils: 0,
};
assertEq(after, finalExpected, "final KPI");

// Interrupt-resume proof: re-run should skip all
const resumeProbe = [];
for (const step of STEPS) {
  const action = await step.pre();
  resumeProbe.push({ n: step.n, action });
}

const report = {
  mode: "REHEARSAL_OK",
  asOf: new Date().toISOString(),
  ids,
  relationshipProbe,
  before,
  after,
  expectedFinal: finalExpected,
  stepResults,
  resumeProbe,
  note: "BOT TEMP DEP analog: closed rental + vacant space + active obligation with recognized cash; Target unaffected by that 100 AED. Names are rehearsal labels — ownership inferred from state graph not name tokens.",
};
mkdirSync("artifacts/investigation-2026-09-05", { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await delClient(clientApp);
