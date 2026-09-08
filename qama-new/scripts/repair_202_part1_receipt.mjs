/**
 * Repair: re-create the missing recognized cash receipt for approved request
 * req_1788457414772 (شقة 202 / 1, 1400 AED) — original was created then wrongly uncollected.
 * Idempotent: skips if a recognized receipt already covers the obligation.
 */
const API_KEY = "AIzaSyBs0wIu2h2mnNMGr5SH-YNXjUhrdrGSNKg";
const REGION = "me-central1";
const PROJECT = "qama-new-prod-2026";
const OBLIGATION_ID = "rental:rentnew-mig:space:space:legacy:8d506fd1487b6ca1d8c81110_2026-09";
const REQUEST_ID = "req_1788457414772";
const AMOUNT_FILS = 140000;

async function callable(name, data, idToken) {
  const headers = { "Content-Type": "application/json" };
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  const res = await fetch(`https://${REGION}-${PROJECT}.cloudfunctions.net/${name}`, {
    method: "POST", headers, body: JSON.stringify({ data }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json.result;
}
async function signIn(t) {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: t, returnSecureToken: true }),
  });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.idToken;
}

const login = await callable("login", { userId: "mig:user:owner:saeed", pin: "1325" });
const token = await signIn(login.customToken);

const before = await callable("read", { what: "dashboard", period: "2026-09" }, token);
const holdBefore = before.summary?.holdingFils ?? before.summary?.sharedEmployeeHoldingFils;
let spBefore = null;
for (const u of before.unitsTree || []) {
  for (const sp of u.spaces || []) {
    if (sp.name === "شقة 202 / 1") spBefore = sp;
  }
}
console.log(JSON.stringify({ holdBefore, spBefore: spBefore && {
  status: spBefore.status, paidFils: spBefore.paidFils, dueFils: spBefore.dueFils,
  remainingFils: spBefore.remainingFils, obligationId: spBefore.obligationId,
  receipts: (spBefore.spaceReceipts || []).map((r) => ({ id: r.id, state: r.state, amount: r.amountFils })),
} }, null, 2));

const recognized = (spBefore?.spaceReceipts || []).filter((r) => r.state === "recognized");
const paid = recognized.reduce((s, r) => s + Number(r.amountFils || 0), 0);
if (paid >= AMOUNT_FILS) {
  console.log("SKIP: already has recognized coverage", paid);
  process.exit(0);
}

const delta = AMOUNT_FILS - paid;
const oid = `repair-${REQUEST_ID}-cash-${delta}`;
const created = await callable("command", {
  command: "createCashReceipt",
  payload: {
    obligationId: OBLIGATION_ID,
    amountFils: delta,
    collectionDate: "2026-09-01",
    collectorUserId: "mig:user:yahia",
  },
  operationId: oid,
}, token);
console.log("CREATED", created);

const after = await callable("read", { what: "dashboard", period: "2026-09" }, token);
const holdAfter = after.summary?.holdingFils ?? after.summary?.sharedEmployeeHoldingFils;
let spAfter = null;
for (const u of after.unitsTree || []) {
  for (const sp of u.spaces || []) {
    if (sp.name === "شقة 202 / 1") spAfter = sp;
  }
}
console.log(JSON.stringify({
  holdAfter,
  spAfter: {
    status: spAfter?.status,
    paidFils: spAfter?.paidFils,
    dueFils: spAfter?.dueFils,
    remainingFils: spAfter?.remainingFils,
    receipts: (spAfter?.spaceReceipts || []).map((r) => ({ id: r.id, state: r.state, amount: r.amountFils })),
  },
  summary: {
    due: after.summary?.dueFils,
    collected: after.summary?.collectedFils,
    remaining: after.summary?.remainingFils,
  },
}, null, 2));
