import fs from "node:fs/promises";
import process from "node:process";

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error("الاستخدام: node scripts/compare_exports.mjs before.json after.json");
  process.exit(1);
}
const before = JSON.parse(await fs.readFile(beforePath, "utf8"));
const after = JSON.parse(await fs.readFile(afterPath, "utf8"));
const problems = [];

function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function verifyOriginal(path, oldValue, newValue) {
  if (Array.isArray(oldValue)) {
    if (!Array.isArray(newValue)) { problems.push(`${path}: تحولت المصفوفة إلى نوع آخر`); return; }
    if (newValue.length < oldValue.length) problems.push(`${path}: نقص طول المصفوفة ${oldValue.length} -> ${newValue.length}`);
    for (let i = 0; i < oldValue.length; i += 1) verifyOriginal(`${path}[${i}]`, oldValue[i], newValue[i]);
    return;
  }
  if (oldValue && typeof oldValue === "object") {
    if (!newValue || typeof newValue !== "object" || Array.isArray(newValue)) { problems.push(`${path}: اختفى الكائن أو تغير نوعه`); return; }
    for (const key of Object.keys(oldValue)) {
      if (!(key in newValue)) problems.push(`${path}.${key}: الحقل مفقود`);
      else verifyOriginal(`${path}.${key}`, oldValue[key], newValue[key]);
    }
    return;
  }
  if (!same(oldValue, newValue)) problems.push(`${path}: تغيرت القيمة من ${JSON.stringify(oldValue)} إلى ${JSON.stringify(newValue)}`);
}

for (const [docPath, oldDoc] of Object.entries(before.documents || {})) {
  if (!(docPath in (after.documents || {}))) problems.push(`${docPath}: المستند مفقود بالكامل`);
  else verifyOriginal(docPath, oldDoc, after.documents[docPath]);
}

const beforeCount = Object.keys(before.documents || {}).length;
const afterCount = Object.keys(after.documents || {}).length;
console.log(`قبل: ${beforeCount} مستند | بعد: ${afterCount} مستند`);
if (problems.length) {
  console.error(`فشل حفظ البيانات: ${problems.length} اختلافاً يمس بيانات أصلية.`);
  problems.slice(0, 200).forEach((x) => console.error(`- ${x}`));
  if (problems.length > 200) console.error(`... و${problems.length - 200} اختلافاً إضافياً`);
  process.exit(2);
}
console.log("نجح: كل مستند وحقل وقيمة أصلية ما زالت موجودة بلا تغيير. الإضافات الجديدة مسموحة.");
