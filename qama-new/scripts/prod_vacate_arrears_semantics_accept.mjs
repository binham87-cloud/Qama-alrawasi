/**
 * CASE A vs CASE B vacate/arrears semantics on qama-new-prod-2026.
 * Temp rentals only. Cleans up afterward.
 *
 *   OWNER_PIN=1325 node scripts/prod_vacate_arrears_semantics_accept.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";

const API_KEY = "AIzaSyBs0wIu2h2mnNMGr5SH-YNXjUhrdrGSNKg";
const REGION = "me-central1";
const PROJECT = "qama-new-prod-2026";
const HOST = "https://qama-new-prod-2026.web.app";
const PERIOD = "2026-09";
const OWNER_PIN = process.env.OWNER_PIN || "1325";
const STAMP = Date.now().toString(36);
const TODAY = new Date().toISOString().slice(0, 10);
const results = [];

function rec(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || "" });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
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
  return callable("command", {
    command,
    payload,
    operationId: operationId || `${command}-${STAMP}-${Math.random().toString(36).slice(2, 8)}`,
  }, token);
}
async function readDash(token) {
  return callable("read", { what: "dashboard", period: PERIOD }, token);
}
function kpi(dash) {
  const s = dash.summary || {};
  return {
    Target: Number(s.targetFils != null ? s.targetFils : (s.dueFils || 0)),
    Remaining: Number(s.remainingFils || 0),
    Holding: Number(s.holdingFils || 0),
  };
}
function findSpace(dash, spaceId) {
  for (const u of dash.unitsTree || []) {
    for (const sp of u.spaces || []) if (sp.spaceId === spaceId) return sp;
  }
  return null;
}
async function getObligation(token, obligationId) {
  // dashboard views carry obligationId; fall back to command surface via space card
  const dash = await readDash(token);
  const v = (dash.views || []).find((x) => x.obligationId === obligationId);
  return { dash, view: v || null };
}

const owner = await login("mig:user:owner:saeed", OWNER_PIN);
const dash0 = await readDash(owner.token);
const prop = (dash0.properties || [])[0];
const k0 = kpi(dash0);
rec("baseline dashboard", !!prop, JSON.stringify(k0));

const html = await (await fetch(HOST + "/")).text();
rec("UI: unpaid vacate uses endTenancy retain (not closeRental branch)",
  html.includes('arrearsDecision:"retain"')
  && html.includes("إخلاء من زر مستقل")
  && !html.includes("Fully unpaid/reversed — closeRental"),
  "hosting assembled");
rec("UI: erroneous cancel button present",
  html.includes("btn-cancel-erroneous-rental") || html.includes("إلغاء إيجار خاطئ"),
  "CASE A control");
rec("UI message متأخرات ستبقى present", html.includes("متأخرات ستبقى") || html.includes("ستبقى مسجّلة"));

const unitA = await cmd(owner.token, "createUnit", {
  propertyId: prop.id, name: `BOT-SEM-A-${STAMP}`, kind: "partitioned",
}, `sem-ua-${STAMP}`);
const spaceA = await cmd(owner.token, "createSpace", {
  unitId: unitA.unitId, name: `BOT-SEM-A-${STAMP} / 1`,
}, `sem-sa-${STAMP}`);
await cmd(owner.token, "setSpaceOccupancy", { spaceId: spaceA.spaceId, occupancy: "rented" }, `sem-oa-${STAMP}`);
const rentA = await cmd(owner.token, "createRental", {
  spaceId: spaceA.spaceId,
  tenantName: `BOT SEM A ${STAMP}`,
  contractualAmountFils: 10000,
  startDate: TODAY,
  dueDayOfMonth: Number(TODAY.slice(8, 10)),
}, `sem-ra-${STAMP}`);
await cmd(owner.token, "generateObligations", { period: PERIOD }, `sem-ga-${STAMP}`);
let dash = await readDash(owner.token);
let spA = findSpace(dash, spaceA.spaceId);
const obA = spA?.obligationId;
rec("TEST1 setup: obligation active", !!obA && spA?.remainingFils === 10000, JSON.stringify({
  occupancy: spA?.occupancy, remaining: spA?.remainingFils, obA,
}));
const kBeforeA = kpi(dash);

// CASE A — erroneous cancel via closeRental (cancels unpaid)
await cmd(owner.token, "closeRental", {
  rentalId: rentA.rentalId,
  endDate: TODAY,
  reason: "إلغاء إيجار خاطئ SEM A",
  setVacant: true,
}, `sem-close-a-${STAMP}`);
dash = await readDash(owner.token);
spA = findSpace(dash, spaceA.spaceId);
const kAfterA = kpi(dash);
const viewA = (dash.views || []).find((v) => v.obligationId === obA);
rec("TEST1 ERRONEOUS: space vacant", spA?.occupancy === "vacant" && spA?.status === "vacant");
rec("TEST1 ERRONEOUS: obligation not in live views", !viewA, viewA ? "still live" : "gone");
rec("TEST1 ERRONEOUS: Target/Remaining dropped by 100",
  kAfterA.Target === kBeforeA.Target - 10000 && kAfterA.Remaining === kBeforeA.Remaining - 10000,
  `before=${JSON.stringify(kBeforeA)} after=${JSON.stringify(kAfterA)}`);
rec("TEST1 ERRONEOUS: card remaining 0", Number(spA?.remainingFils || 0) === 0);

// CASE B — real vacate with debt
const unitB = await cmd(owner.token, "createUnit", {
  propertyId: prop.id, name: `BOT-SEM-B-${STAMP}`, kind: "partitioned",
}, `sem-ub-${STAMP}`);
const spaceB = await cmd(owner.token, "createSpace", {
  unitId: unitB.unitId, name: `BOT-SEM-B-${STAMP} / 1`,
}, `sem-sb-${STAMP}`);
await cmd(owner.token, "setSpaceOccupancy", { spaceId: spaceB.spaceId, occupancy: "rented" }, `sem-ob-${STAMP}`);
const rentB = await cmd(owner.token, "createRental", {
  spaceId: spaceB.spaceId,
  tenantName: `BOT SEM B ${STAMP}`,
  contractualAmountFils: 10000,
  startDate: TODAY,
  dueDayOfMonth: Number(TODAY.slice(8, 10)),
}, `sem-rb-${STAMP}`);
await cmd(owner.token, "generateObligations", { period: PERIOD }, `sem-gb-${STAMP}`);
dash = await readDash(owner.token);
let spB = findSpace(dash, spaceB.spaceId);
const obB = spB?.obligationId;
const kBeforeB = kpi(dash);
rec("TEST2 setup: unpaid due", !!obB && Number(spB?.remainingFils) === 10000);

await cmd(owner.token, "endTenancy", {
  rentalId: rentB.rentalId,
  endDate: TODAY,
  reason: "إخلاء مستأجر حقيقي SEM B",
  arrearsDecision: "retain",
}, `sem-end-b-${STAMP}`);
dash = await readDash(owner.token);
spB = findSpace(dash, spaceB.spaceId);
const kAfterB = kpi(dash);
const viewB = (dash.views || []).find((v) => v.obligationId === obB);
rec("TEST2 REAL VACATE: space vacant", spB?.occupancy === "vacant" && spB?.status === "vacant");
rec("TEST2 REAL VACATE: no active rentalId on card", !spB?.rentalId);
rec("TEST2 DEBT RETAINED: obligation still in views", !!viewB && Number(viewB.remainingFils) === 10000,
  JSON.stringify(viewB && { remaining: viewB.remainingFils, tenant: viewB.tenantName }));
rec("TEST2 DEBT RETAINED: Target/Remaining unchanged by vacate",
  kAfterB.Target === kBeforeB.Target && kAfterB.Remaining === kBeforeB.Remaining,
  `before=${JSON.stringify(kBeforeB)} after=${JSON.stringify(kAfterB)}`);
rec("TEST2 DEBT RETAINED: vacant card shows remaining 100",
  Number(spB?.remainingFils) === 10000 && !!spB?.obligationId,
  JSON.stringify({ rem: spB?.remainingFils, ob: spB?.obligationId, tenant: spB?.tenantName }));

// Future obligation generation must not recreate for closed rental
try {
  await cmd(owner.token, "renewRentalCycle", {
    rentalId: rentB.rentalId, asOfDate: TODAY, earlyWindowDays: 7,
  }, `sem-renew-b-${STAMP}`);
  rec("TEST2 FUTURE GEN STOPS: renew on closed rental rejected", false, "renew succeeded unexpectedly");
} catch (e) {
  rec("TEST2 FUTURE GEN STOPS: renew on closed rental rejected",
    /RENTAL|CLOSED|NOT_ACTIVE|NOT_FOUND/i.test(String(e.message || e)),
    String(e.message || e).slice(0, 120));
}

// Post-vacate collection
const collect = await cmd(owner.token, "createCashReceipt", {
  obligationId: obB,
  amountFils: 10000,
  collectionDate: TODAY,
  collectorUserId: owner.user.userId,
  note: `SEM B collect retained ${STAMP}`,
}, `sem-pay-b-${STAMP}`);
dash = await readDash(owner.token);
spB = findSpace(dash, spaceB.spaceId);
const viewB2 = (dash.views || []).find((v) => v.obligationId === obB);
const kPay = kpi(dash);
rec("TEST2 POST-VACATE COLLECT: receipt created", !!collect?.receiptId, collect?.receiptId || "");
rec("TEST2 POST-VACATE COLLECT: remaining settled",
  Number(spB?.remainingFils || 0) === 0 || (viewB2 && Number(viewB2.remainingFils) === 0),
  JSON.stringify({ cardRem: spB?.remainingFils, viewRem: viewB2?.remainingFils }));
rec("TEST2 POST-VACATE COLLECT: vacancy preserved", spB?.occupancy === "vacant");
rec("TEST2 POST-VACATE COLLECT: settles once (Remaining dropped 100)",
  kPay.Remaining === kAfterB.Remaining - 10000,
  JSON.stringify(kPay));

// Double-pay must fail
try {
  await cmd(owner.token, "createCashReceipt", {
    obligationId: obB,
    amountFils: 10000,
    collectionDate: TODAY,
    collectorUserId: owner.user.userId,
  }, `sem-pay2-b-${STAMP}`);
  rec("TEST2 no double settle", false, "second receipt accepted");
} catch (e) {
  rec("TEST2 no double settle", /EXCEED|REMAINING|AMOUNT|PAID|FULL/i.test(String(e.message || e)),
    String(e.message || e).slice(0, 120));
}

// Cleanup — reverse test collection (drop holding), then deactivate probes
if (collect?.receiptId) {
  try {
    await cmd(owner.token, "reverseReceipt", {
      receiptId: collect.receiptId,
      reason: `SEM B cleanup reverse ${STAMP}`,
    }, `sem-rev-b-${STAMP}`);
  } catch (e) { console.warn("reverseReceipt", e.message || e); }
}
// After reverse, retained obligation is unpaid again — cancel via close path is already closed;
// cancel the orphan retained obligation so Remaining returns to baseline.
try {
  await cmd(owner.token, "cancelObligation", {
    obligationId: obB,
    reason: `SEM B cleanup cancel retained ${STAMP}`,
  }, `sem-can-b-${STAMP}`);
} catch (e) { console.warn("cancelObligation", e.message || e); }

for (const [spaceId, unitId, tag] of [
  [spaceA.spaceId, unitA.unitId, "a"],
  [spaceB.spaceId, unitB.unitId, "b"],
]) {
  try {
    await cmd(owner.token, "updateSpace", { spaceId, active: false }, `sem-off-sp-${tag}-${STAMP}`);
  } catch (e) { console.warn("space deactivate", e.message || e); }
  try {
    await cmd(owner.token, "updateUnit", { unitId, active: false }, `sem-off-u-${tag}-${STAMP}`);
  } catch (e) { console.warn("unit deactivate", e.message || e); }
}

const dashEnd = await readDash(owner.token);
const kEnd = kpi(dashEnd);
rec("TEMP DATA CLEANED: KPI near baseline",
  kEnd.Target === k0.Target && kEnd.Remaining === k0.Remaining && kEnd.Holding === k0.Holding,
  `base=${JSON.stringify(k0)} end=${JSON.stringify(kEnd)}`);

const fails = results.filter((r) => !r.ok);
mkdirSync("artifacts/investigation-2026-09-05", { recursive: true });
writeFileSync(
  "artifacts/investigation-2026-09-05/VACATE-ARREARS-SEMANTICS-ACCEPT.json",
  JSON.stringify({ at: new Date().toISOString(), stamp: STAMP, results, failCount: fails.length, k0, kEnd }, null, 2),
);
console.log("\nFAIL COUNT:", fails.length);
process.exit(fails.length ? 1 : 0);
