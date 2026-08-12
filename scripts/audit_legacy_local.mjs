import fs from "node:fs/promises";
import process from "node:process";

const [localPath, firestorePath] = process.argv.slice(2);
if (!localPath || !firestorePath) {
  console.error("الاستخدام: node scripts/audit_legacy_local.mjs qama-local.json firestore-backup.json");
  process.exit(1);
}
const local = JSON.parse(await fs.readFile(localPath, "utf8"));
const remote = JSON.parse(await fs.readFile(firestorePath, "utf8"));
const docs = remote.documents || {};
const issues = [];

function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  return v;
}
function equal(a, b) { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }
function parseStored(key, value) {
  try { return JSON.parse(value); }
  catch { issues.push(`${key}: القيمة المحلية ليست JSON صالحاً`); return null; }
}

for (const [key, raw] of Object.entries(local.values || {})) {
  if (key.startsWith("qama_month_")) {
    const monthKey = key.slice("qama_month_".length);
    const localMonth = parseStored(key, raw);
    const remoteMonth = docs[`months/${monthKey}`]?.data ?? docs[`months/${monthKey}`];
    if (!remoteMonth) issues.push(`${key}: موجود محلياً ولا يوجد مستند months/${monthKey} في Firebase`);
    else if (!equal(localMonth, remoteMonth)) issues.push(`${key}: النسخة المحلية تختلف عن Firebase وتحتاج مراجعة قبل الانتقال`);
  } else if (key === "qama_permissions") {
    const value = parseStored(key, raw);
    const remoteValue = docs["config/permissions"]?.data;
    if (!equal(value, remoteValue)) issues.push(`${key}: الصلاحيات المحلية تختلف عن Firebase`);
  } else if (key === "qama_custom_units") {
    const value = parseStored(key, raw);
    const remoteValue = docs["config/customUnits"]?.data;
    if (!equal(value, remoteValue)) issues.push(`${key}: الوحدات المحلية تختلف عن Firebase`);
  }
}

if (issues.length) {
  console.error(`توقف: وُجد ${issues.length} اختلافاً قد يحتوي بيانات غير مرفوعة.`);
  issues.forEach((x) => console.error(`- ${x}`));
  process.exit(2);
}
console.log("نجح: لا توجد بيانات شهرية/صلاحيات/وحدات محلية مختلفة عن نسخة Firebase المصدّرة.");
