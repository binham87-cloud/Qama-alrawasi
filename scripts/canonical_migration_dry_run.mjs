import fs from "node:fs";
import crypto from "node:crypto";

const input = process.argv[2];
if (!input) throw new Error("Usage: node scripts/canonical_migration_dry_run.mjs <firestore-export.json>");
const rawText = fs.readFileSync(input, "utf8");
const sourceHash = crypto.createHash("sha256").update(rawText).digest("hex");
const root = JSON.parse(rawText);

function unwrap(v) {
  if (!v || typeof v !== "object") return v;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  if (v.arrayValue) return (v.arrayValue.values || []).map(unwrap);
  if (v.mapValue) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, unwrap(x)]));
  if (v.fields) return Object.fromEntries(Object.entries(v.fields).map(([k, x]) => [k, unwrap(x)]));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unwrap(x)]));
}

const docs = root.documents && !Array.isArray(root.documents)
  ? Object.entries(root.documents).map(([path, doc]) => ({ path, data: unwrap(doc) }))
  : [];
if (!docs.length) throw new Error("UNSUPPORTED_EXPORT_FORMAT");
const unique = new Map(docs.map((d) => [d.path, d]));
const all = [...unique.values()];

const classification = { VERIFIED: 0, PARTIALLY_VERIFIED: 0, UNVERIFIED: 0, REQUIRES_HUMAN_DECISION: 0 };
const reasons = {};
const reasonsByConfidence = { VERIFIED: {}, PARTIALLY_VERIFIED: {}, UNVERIFIED: {}, REQUIRES_HUMAN_DECISION: {} };
const candidates = [];
const bump = (confidence, reason, path) => { classification[confidence]++; reasons[reason] = (reasons[reason] || 0) + 1; reasonsByConfidence[confidence][reason] = (reasonsByConfidence[confidence][reason] || 0) + 1; candidates.push({ sourcePath: path, sourceHash: crypto.createHash("sha256").update(JSON.stringify(unique.get(path)?.data || {})).digest("hex"), confidence, reason, migrationVersion: "canonical-v2-dry-run" }); };

function legacyReason(data) {
  const p = data.payload || {};
  const fields = p.fields || {};
  const amount = p.amount ?? p.transaction?.amount ?? fields.paid_amount;
  const method = p.method ?? fields.collectionMethod;
  const collector = p.collectedBy ?? fields.collectedBy ?? data.by;
  if (data.conflict === true || p.conflict === true) return "conflicting_evidence";
  if (!(Number(amount) > 0)) return "missing_amount";
  if (!method) return "missing_payment_method";
  if (!collector) return "missing_collector";
  if (!data.approvedAt || data.status !== "approved") return "status_only_or_unapproved_evidence";
  if (String(method).toLowerCase() === "cash" && !(p.cashHolder || fields.cashHolder)) return "missing_cash_lineage";
  if (!(p.depositId || p.transaction?.id || fields.depositId)) return "missing_deposit_linkage";
  return "legacy_aggregate_only";
}

for (const { path, data } of all) {
  if (/bankPayments/.test(path)) {
    if (data.status === "approved" && Number(data.amount) > 0 && data.paymentDate && data.createdBy && data.unitRef) bump("VERIFIED", "approved_bank_complete", path);
    else if (Number(data.amount) > 0 && data.paymentDate) bump("PARTIALLY_VERIFIED", "bank_not_approved_or_actor_missing", path);
    else bump("UNVERIFIED", "bank_incomplete", path);
  } else if (/requests/.test(path) && /update_partition|update_full|add_transaction/.test(String(data.type || ""))) {
    const p = data.payload || {}; const amount = p.amount ?? p.transaction?.amount ?? p.fields?.paid_amount;
    const method = p.method ?? p.fields?.collectionMethod; const actor = p.collectedBy ?? p.fields?.collectedBy ?? data.by;
    const reason = legacyReason(data);
    if (data.status === "approved" && Number(amount) > 0 && method && actor && data.approvedAt) bump("PARTIALLY_VERIFIED", reason, path);
    else bump(reason === "conflicting_evidence" ? "REQUIRES_HUMAN_DECISION" : "UNVERIFIED", reason, path);
  }
}

let legacyInstallmentBalance = null, roleCounts = {};
for (const { path, data } of all) {
  if (/config\/balances/.test(path) && data.installmentBalance != null) legacyInstallmentBalance = Number(data.installmentBalance);
  if (/users/.test(path) && data.role) roleCounts[data.role] = (roleCounts[data.role] || 0) + 1;
}

const number = (v) => Number(v) || 0;
function legacyMonthMetrics(data) {
  const body = data.data || data;
  const entities = [
    ...(body.units || []).flatMap((u) => u.partitions || []),
    ...(body.full || []),
  ];
  const active = entities.filter((x) => !["vacant", "staff"].includes(String(x.status || "")));
  const target = active.reduce((s, x) => s + number(x.rent), 0);
  const tenantReceived = active.reduce((s, x) => s + number(x.paid_amount || (x.status === "collected" ? x.rent : 0)), 0);
  const deposited = (body.transactions || []).filter((x) => !x.reversedAt && x.status !== "reversed").reduce((s, x) => s + number(x.amount), 0);
  const cashReceipts = (body.cashReceipts || []).filter((x) => x.status !== "reversed").reduce((s, x) => s + number(x.amount), 0);
  const handovers = (body.handovers || []).filter((x) => x.status === "confirmed").reduce((s, x) => s + number(x.amount), 0);
  return { target, tenantReceived, deposited, cashReceipts, handovers };
}
const monthTotals = Object.fromEntries(all.filter((d) => /^months\//.test(d.path)).map((d) => [d.path.slice(7), legacyMonthMetrics(d.data)]));
const balanceDoc = all.find((d) => d.path === "config/balances")?.data || {};
const balanceTotals = {
  company: number(balanceDoc.companyBalance),
  revenue: number(balanceDoc.revenueBalance),
  deductionLegacyPhysicalField: number(balanceDoc.installmentBalance),
};

const report = {
  mode: "DRY_RUN_ONLY", input, sourceHash, documentCount: all.length,
  candidateEventCount: candidates.length, skippedCount: all.length - candidates.length,
  classification, reasons, reasonsByConfidence, roleCounts,
  legacyAliasCandidate: { field: "installmentBalance", proposedCanonical: "deductionBalance", value: legacyInstallmentBalance, applied: false, confidence: legacyInstallmentBalance == null ? "UNVERIFIED" : "PARTIALLY_VERIFIED" },
  candidates,
  simulatedPreservation: {
    before: { documentCount: all.length, sourceHash, monthTotals, balances: balanceTotals },
    after: { documentCount: all.length, sourceHash, monthTotals, balances: balanceTotals },
    deltas: { documents: 0, target: 0, collected: 0, custody: 0, balances: 0, relevantMonthTotals: 0 },
    status: "PASS_ZERO_WRITE_DRY_RUN",
  },
  writesPerformed: 0,
  note: "No legacy record was changed and no candidate was promoted to VERIFIED cash history from unit status or deposit.by."
};
console.log(JSON.stringify(report, null, 2));
