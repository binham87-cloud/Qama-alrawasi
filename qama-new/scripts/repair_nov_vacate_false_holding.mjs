/**
 * SAFE repair: November false Holding after vacate (qama-new-prod-2026 ONLY).
 *
 * Forensic root cause:
 * - Receipt rcpt:pay-rental:…-w90000… for يعقوب / Nov 900 was created 2026-10-01
 *   via the pay path (NOT by vacancy). Vacate 2026-10-05 kept the receipt → Nov Holding 900.
 * - Separately, unpaid future Nov obligations were retained on vacate → Target pollution.
 *
 * Repair (auditable, no hard-delete):
 * 1) Reverse the proven false cash receipt (linked reversal).
 * 2) Cancel that Nov obligation as future-unpaid-after-vacate.
 * 3) Cancel other retained unpaid Nov obligations whose rental vacated before due.
 *
 *   node scripts/repair_nov_vacate_false_holding.mjs --dry-run
 *   node scripts/repair_nov_vacate_false_holding.mjs --apply
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const APPLY = process.argv.includes("--apply");
const PROJECT = "qama-new-prod-2026";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const RECEIPT_ID = "rcpt:pay-rental:rentnew-194808fa4_b5f7644d5_2026-11-01-w90000-d90000-L0-A0";
const OB_ID = "rental:rentnew-194808fa459342a8b9a8a58b5f7644d5_2026-11-01";
const REASON = "إصلاح عهدة نوفمبر — إيصال نقدي غير صالح قبل الإخلاء (لا تحصيل فعلي)";

const cfg = JSON.parse(readFileSync(`${process.env.HOME}/.config/configstore/firebase-tools.json`, "utf8"));
const token = cfg.tokens.access_token;

function enc(id) { return encodeURIComponent(id); }
function docPath(col, id) {
  return `projects/${PROJECT}/databases/(default)/documents/${col}/${enc(id)}`;
}

async function getDoc(col, id) {
  const res = await fetch(`https://firestore.googleapis.com/v1/${docPath(col, id)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = await res.json();
  if (j.error) return null;
  const out = { id };
  for (const [k, v] of Object.entries(j.fields || {})) {
    if (v.stringValue != null) out[k] = v.stringValue;
    else if (v.integerValue != null) out[k] = Number(v.integerValue);
    else if (v.booleanValue != null) out[k] = v.booleanValue;
    else if (v.timestampValue != null) out[k] = v.timestampValue;
    else if (v.nullValue !== undefined) out[k] = null;
    else out[k] = v;
  }
  return out;
}

async function runQuery(structuredQuery) {
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents:runQuery`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ structuredQuery }),
    },
  );
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error(JSON.stringify(rows).slice(0, 500));
  return rows.filter((r) => r.document).map((r) => {
    const id = decodeURIComponent(r.document.name.split("/").pop());
    const out = { id };
    for (const [k, v] of Object.entries(r.document.fields || {})) {
      if (v.stringValue != null) out[k] = v.stringValue;
      else if (v.integerValue != null) out[k] = Number(v.integerValue);
      else if (v.booleanValue != null) out[k] = v.booleanValue;
      else if (v.timestampValue != null) out[k] = v.timestampValue;
      else if (v.nullValue !== undefined) out[k] = null;
      else out[k] = v;
    }
    return out;
  });
}

async function commit(writes) {
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents:commit`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ writes }),
    },
  );
  const j = await res.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j;
}

function str(v) { return { stringValue: String(v) }; }
function num(v) { return { integerValue: String(Math.trunc(v)) }; }
function bool(v) { return { booleanValue: !!v }; }
function ts(v) { return { timestampValue: new Date(v).toISOString() }; }

const receipt = await getDoc("receipts", RECEIPT_ID);
const ob = await getDoc("obligations", OB_ID);
const novObs = await runQuery({
  from: [{ collectionId: "obligations" }],
  where: { fieldFilter: { field: { fieldPath: "period" }, op: "EQUAL", value: { stringValue: "2026-11" } } },
});

const retainedFuture = [];
for (const o of novObs.filter((x) => x.retainArrearsAfterVacate === true && x.state === "active")) {
  const rental = await getDoc("rentals", o.rentalId);
  if (!rental || rental.state !== "closed") continue;
  const end = String(rental.endDate || "").slice(0, 10);
  const due = String(o.dueDate || "2026-11-01").slice(0, 10);
  if (end && due > end) {
    retainedFuture.push({
      obligationId: o.id, amountFils: o.amountFils, tenant: o.tenantNameSnapshot,
      rentalId: o.rentalId, endDate: end, dueDate: due,
    });
  }
}

const plan = {
  at: new Date().toISOString(),
  mode: APPLY ? "apply" : "dry-run",
  receipt: receipt && {
    id: receipt.id, state: receipt.state, amountFils: receipt.amountFils,
    obligationId: receipt.obligationId, createdAt: receipt.createdAt, collector: receipt.collectorUserId,
  },
  obligation: ob && { id: ob.id, state: ob.state, amountFils: ob.amountFils, retain: !!ob.retainArrearsAfterVacate },
  retainedFutureUnpaidToCancel: retainedFuture,
  actions: [],
};

if (!receipt || receipt.state !== "recognized" || Number(receipt.amountFils) !== 90000) {
  plan.actions.push({ skip: "receipt", detail: "not recognized 900 cash — already repaired or missing" });
} else {
  plan.actions.push({ reverseReceipt: RECEIPT_ID, amountFils: 90000, reason: REASON });
  plan.actions.push({ cancelObligation: OB_ID, reason: "future unpaid after vacate — post reverse" });
}
for (const r of retainedFuture) {
  plan.actions.push({ cancelObligation: r.obligationId, reason: "retained future unpaid on vacate before due", ...r });
}

mkdirSync(resolve(ROOT, "artifacts"), { recursive: true });
const outPath = resolve(ROOT, `artifacts/repair-nov-vacate-holding-${STAMP}.json`);
writeFileSync(outPath, JSON.stringify(plan, null, 2));
console.log(JSON.stringify(plan, null, 2));
console.log("PLAN_WRITTEN", outPath);

if (!APPLY) {
  console.log("DRY-RUN only. Re-run with --apply to mutate.");
  process.exit(0);
}

const now = new Date().toISOString();
const writes = [];
const reversalId = `rev:repair-nov-vacate-${STAMP}:${RECEIPT_ID}`.slice(0, 140);

if (receipt && receipt.state === "recognized" && Number(receipt.amountFils) === 90000) {
  writes.push({
    update: {
      name: docPath("reversals", reversalId),
      fields: {
        id: str(reversalId),
        targetType: str("receipt"),
        targetId: str(RECEIPT_ID),
        amountFils: num(90000),
        reason: str(REASON),
        createdBy: str("mig:user:owner:saeed"),
        createdAt: ts(now),
        repairTag: str("nov-vacate-false-holding-20261005"),
      },
    },
  });
  writes.push({
    update: {
      name: docPath("receipts", RECEIPT_ID),
      fields: {
        state: str("reversed"),
        reversedByReversalId: str(reversalId),
        reversedAt: ts(now),
        repairTag: str("nov-vacate-false-holding-20261005"),
      },
    },
    updateMask: { fieldPaths: ["state", "reversedByReversalId", "reversedAt", "repairTag"] },
  });
  writes.push({
    update: {
      name: docPath("obligations", OB_ID),
      fields: {
        state: str("cancelled"),
        cancelledBy: str("mig:user:owner:saeed"),
        cancelledAt: ts(now),
        cancelReason: str(REASON),
        cancelledAsFutureUnpaidOnVacate: bool(true),
        repairTag: str("nov-vacate-false-holding-20261005"),
      },
    },
    updateMask: {
      fieldPaths: [
        "state", "cancelledBy", "cancelledAt", "cancelReason",
        "cancelledAsFutureUnpaidOnVacate", "repairTag",
      ],
    },
  });
}

for (const r of retainedFuture) {
  writes.push({
    update: {
      name: docPath("obligations", r.obligationId),
      fields: {
        state: str("cancelled"),
        cancelledBy: str("mig:user:owner:saeed"),
        cancelledAt: ts(now),
        cancelReason: str("إصلاح — إلغاء التزام مستقبلي غير مدفوع بعد الإخلاء قبل الاستحقاق"),
        cancelledAsFutureUnpaidOnVacate: bool(true),
        retainArrearsAfterVacate: bool(false),
        repairTag: str("nov-vacate-false-holding-20261005"),
      },
    },
    updateMask: {
      fieldPaths: [
        "state", "cancelledBy", "cancelledAt", "cancelReason",
        "cancelledAsFutureUnpaidOnVacate", "retainArrearsAfterVacate", "repairTag",
      ],
    },
  });
}

writes.push({
  update: {
    name: docPath("auditEvents", `audit:repair-nov-vacate-${STAMP}`),
    fields: {
      id: str(`audit:repair-nov-vacate-${STAMP}`),
      action: str("repair_nov_vacate_false_holding"),
      actorUserId: str("mig:user:owner:saeed"),
      at: ts(now),
      targetType: str("period"),
      targetId: str("2026-11"),
      detail: str(REASON),
      amountFils: num(90000),
      planJson: str(JSON.stringify(plan.actions).slice(0, 900)),
    },
  },
});

if (writes.length) {
  await commit(writes);
  console.log("APPLIED writes", writes.length);
}

const receiptAfter = await getDoc("receipts", RECEIPT_ID);
const obAfter = await getDoc("obligations", OB_ID);
const verify = {
  receiptState: receiptAfter?.state,
  obligationState: obAfter?.state,
  retainedStillActive: (await Promise.all(retainedFuture.map(async (r) => getDoc("obligations", r.obligationId))))
    .filter((o) => o && o.state === "active").map((o) => o.id),
};
writeFileSync(outPath.replace(".json", "-after.json"), JSON.stringify(verify, null, 2));
console.log("VERIFY", JSON.stringify(verify, null, 2));
