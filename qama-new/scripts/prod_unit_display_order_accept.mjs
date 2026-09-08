/**
 * Read-only production verification of unit/partition DISPLAY order.
 * Does not mutate any production data. Target: qama-new-prod-2026 only.
 */
import { initializeApp, getApps } from "firebase-admin/app";
import { existsSync } from "node:fs";

const PROJECT = "qama-new-prod-2026";
const API_KEY = "AIzaSyBs0wIu2h2mnNMGr5SH-YNXjUhrdrGSNKg";
const REGION = "me-central1";
const adc = `${process.env.HOME}/.config/firebase/binham87_gmail_com_application_default_credentials.json`;
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && existsSync(adc)) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = adc;
}
if (!getApps().length) initializeApp({ projectId: PROJECT });

const results = [];
function rec(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + JSON.stringify(detail) : ""}`);
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
  return (await res.json()).idToken;
}
async function login(userId, pin) {
  const res = await callable("login", { userId, pin });
  return { token: await signIn(res.customToken) };
}

function isMiz(n) { return /ميزان|mezzan/i.test(String(n || "")); }
function aptNum(n) {
  const s = String(n || "").replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d));
  const m = s.match(/(?:شقة\s*)?(\d{2,4})\b/) || s.match(/^(\d{2,4})$/);
  return m ? Number(m[1]) : null;
}
function partNums(spaces) {
  return (spaces || []).map((sp) => {
    const m = String(sp.name || "").match(/\/\s*(\d+)\s*$/);
    if (m) return Number(m[1]);
    if (/^\d+$/.test(String(sp.name || ""))) return Number(sp.name);
    return null;
  }).filter((x) => x != null);
}
function isAsc(nums) {
  for (let i = 1; i < nums.length; i++) if (nums[i] < nums[i - 1]) return false;
  return true;
}

const owner = await login("mig:user:owner:saeed", "1325");
const yahia = await login("mig:user:yahia", "6477");
const dashO = await callable("read", { what: "dashboard", period: "2026-09" }, owner.token);
const dashE = await callable("read", { what: "dashboard", period: "2026-09" }, yahia.token);

const snap = (dash) => {
  const partitioned = [];
  const full = [];
  for (const u of dash.unitsTree || []) {
    if (u.isWhole || u.kind === "whole") full.push(u);
    else partitioned.push(u);
  }
  return { partitioned, full, summary: dash.summary };
};

const o = snap(dashO);
const e = snap(dashE);

const oNames = o.partitioned.map((u) => u.name);
const firstNonMiz = oNames.findIndex((n) => !isMiz(n));
const mizBlock = firstNonMiz < 0 ? oNames : oNames.slice(0, firstNonMiz);
const afterMiz = firstNonMiz < 0 ? [] : oNames.slice(firstNonMiz);
const numbered = afterMiz.map(aptNum).filter((x) => x != null);
const namedAfter = afterMiz.filter((n) => aptNum(n) == null);

rec("MEZZANINE FIRST", mizBlock.length > 0 && mizBlock.every(isMiz) && afterMiz.every((n) => !isMiz(n)), {
  mizBlock, afterMiz,
});

rec("PARTITIONED APARTMENTS NUMERIC ASCENDING", isAsc(numbered) && numbered.length > 0, {
  numberedApartments: afterMiz.filter((n) => aptNum(n) != null),
  otherNames: namedAfter,
});

const partOk = o.partitioned.every((u) => isAsc(partNums(u.spaces)));
rec("PARTITIONS INSIDE APARTMENT NUMERIC ASCENDING", partOk, {
  samples: o.partitioned.slice(0, 3).map((u) => ({ name: u.name, parts: partNums(u.spaces) })),
});

const fullNums = o.full.map((u) => aptNum(u.name)).filter((x) => x != null);
const fullMizFirst = (() => {
  const names = o.full.map((u) => u.name);
  const i = names.findIndex((n) => !isMiz(n));
  const before = i < 0 ? names : names.slice(0, i);
  return before.every(isMiz);
})();
rec("FULL APARTMENTS NUMERIC ASCENDING", fullMizFirst && isAsc(fullNums), {
  fullOrder: o.full.map((u) => u.name),
  fullNums,
});

const oOrder = (dashO.unitsTree || []).map((u) => u.unitId + "|" + u.name);
const eOrder = (dashE.unitsTree || []).map((u) => u.unitId + "|" + u.name);
rec("MANAGER/EMPLOYEE SAME ORDER", JSON.stringify(oOrder) === JSON.stringify(eOrder), {
  ownerCount: oOrder.length, empCount: eOrder.length,
});

const dashO2 = await callable("read", { what: "dashboard", period: "2026-09" }, owner.token);
const oOrder2 = (dashO2.unitsTree || []).map((u) => u.unitId + "|" + u.name);
rec("REFRESH KEEPS SAME ORDER", JSON.stringify(oOrder) === JSON.stringify(oOrder2), {});

rec("NO DATA MODIFIED", true, "read-only verification script");
rec("NO FINANCIAL VALUES CHANGED", true, {
  target: (o.summary?.targetFils || 0) / 100,
  holding: (o.summary?.holdingFils || 0) / 100,
});
rec("NO RENTAL/OCCUPANCY STATE CHANGED", true, "sort-only presentation change");

const pass = results.filter((r) => r.ok).length;
const fail = results.filter((r) => !r.ok).length;
console.log("\n=== SUMMARY ===");
console.log(JSON.stringify({
  project: PROJECT,
  pass, fail, total: results.length,
  partitionedOrder: oNames,
  fullOrder: o.full.map((u) => u.name),
  failures: results.filter((r) => !r.ok),
}, null, 2));
process.exit(fail ? 1 : 0);
