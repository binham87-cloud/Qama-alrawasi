import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { existsSync } from "node:fs";

const PROJECT = "qama-new-prod-2026";
const adc = `${process.env.HOME}/.config/firebase/binham87_gmail_com_application_default_credentials.json`;
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && existsSync(adc)) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = adc;
}
if (!getApps().length) initializeApp({ projectId: PROJECT });
const db = getFirestore();

function parsePayload(r) {
  let p = r.payloadJson ?? r.payload;
  if (typeof p === "string") {
    try { p = JSON.parse(p); } catch { p = {}; }
  }
  return p || {};
}

const reqs = (await db.collection("uiRequests").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const recent = reqs
  .map((r) => ({ ...r, payload: parsePayload(r) }))
  .filter((r) => {
    const p = r.payload;
    const fields = p.fields || p;
    const blob = JSON.stringify(p) + String(r.desc || "");
    return (
      /202/.test(blob) && (/بارتشن\s*1\b|\/\s*1\b|"partId":\s*1|"partId":"1"/.test(blob) || fields.partId === 1 || fields.partId === "1" || p.partId === 1 || p.partId === "1")
    ) || Number(fields.rent) === 1400 || Number(fields.paid_amount) === 1400;
  })
  .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

console.log("matches", recent.length);
for (const r of recent.slice(0, 10)) {
  const fields = r.payload.fields || r.payload;
  console.log(JSON.stringify({
    id: r.id,
    type: r.type,
    status: r.status,
    desc: r.desc,
    year: r.year,
    month: r.month,
    by: r.byKey || r.by,
    createdAt: r.createdAt,
    resolvedAt: r.resolvedAt,
    lastError: r.lastError || null,
    fields: {
      status: fields.status,
      rent: fields.rent,
      paid_amount: fields.paid_amount,
      partial: fields.partial,
      collectionMethod: fields.collectionMethod,
      start_date: fields.start_date,
      tenant: fields.tenant,
      _spaceId: fields._spaceId,
      _rentalId: fields._rentalId,
      _obligationId: fields._obligationId,
      partId: r.payload.partId,
      unitId: r.payload.unitId,
    },
  }, null, 2));
}

// Find space شقة 202 / 1
const spaces = (await db.collection("spaces").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const sp = spaces.find((s) => s.name === "شقة 202 / 1" || /شقة 202\s*\/\s*1$/.test(s.name || ""));
console.log("SPACE", sp && { id: sp.id, name: sp.name, occupancy: sp.occupancy });

if (sp) {
  const rentals = (await db.collection("rentals").where("spaceId", "==", sp.id).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  console.log("RENTALS", rentals.map((r) => ({ id: r.id, state: r.state, startDate: r.startDate, amount: r.contractualAmountFils, tenant: r.tenantName })));
  const obs = (await db.collection("obligations").where("spaceId", "==", sp.id).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  console.log("OBLIGATIONS", obs.map((o) => ({ id: o.id, period: o.period, state: o.state, amount: o.amountFils, dueDate: o.dueDate, rentalId: o.rentalId })));
  for (const o of obs) {
    const rcpts = (await db.collection("receipts").where("obligationId", "==", o.id).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
    if (rcpts.length) console.log("RECEIPTS for", o.id, rcpts.map((r) => ({ id: r.id, state: r.state, amount: r.amountFils, method: r.method, period: r.period })));
  }
}

// period extras for that space
const periodDoc = (await db.collection("uiPeriods").doc("period:2026-09").get()).data();
if (periodDoc && sp) {
  const extras = typeof periodDoc.extrasJson === "string" ? JSON.parse(periodDoc.extrasJson) : (periodDoc.extras || {});
  console.log("EXTRAS space", extras.spaces?.[sp.id] || null);
}

// recent operations for commitWorkRequest
const ops = (await db.collection("operations").orderBy("at", "desc").limit(40).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
console.log("RECENT OPS", ops.filter((o) => /commit|cash|Work/i.test(o.command || o.id || "")).slice(0, 15).map((o) => ({
  id: o.id, command: o.command, at: o.at, result: o.result, state: o.state,
})));
