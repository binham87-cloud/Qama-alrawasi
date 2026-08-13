import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const rules = fs.readFileSync(new URL("../firestore-v11.rules", import.meta.url), "utf8");
const fn = fs.readFileSync(new URL("../functions/index.mjs", import.meta.url), "utf8");
const cryptoCode = fs.readFileSync(new URL("../functions/pin_crypto.mjs", import.meta.url), "utf8");

test("واجهة الدخول تستخدم PIN وFirebase custom token", () => {
  assert.match(html, /function renderHome\(/);
  assert.match(html, /function pinPress\(/);
  assert.match(html, /httpsCallable\(functions,"pinLogin"\)/);
  assert.match(html, /signInWithCustomToken/);
  assert.doesNotMatch(html, /signInWithEmailAndPassword/);
});

test("لا توجد أرقام PIN ثابتة أو حقول كلمة مرور داخل HTML", () => {
  assert.doesNotMatch(html, /\bpin\s*:\s*["']\d{4}["']/i);
  assert.doesNotMatch(html, /type\s*:\s*["']password["']/i);
});

test("PIN الخام لا يُحفظ في مستند Firebase", () => {
  assert.match(cryptoCode, /pbkdf2Sync/);
  assert.match(cryptoCode, /timingSafeEqual/);
  assert.doesNotMatch(fn, /tx\.set\([\s\S]{0,300}\bpin\s*:/);
});

test("قواعد Firestore تمنع العميل من قراءة مادة PIN", () => {
  assert.match(rules, /match \/authPins\/\{userKey\} \{ allow read, write: if false; \}/);
});

test("فتح شهر موجود لا يعيد بناءه ولا يدمج حذفاً تلقائياً", () => {
  const start = html.indexOf("async function loadMonthOnline");
  const end = html.indexOf("async function saveMonthData", start);
  const block = html.slice(start, end);
  assert.match(block, /if\(snap\.exists\(\)\)/);
  assert.match(block, /memPut\(k,finalData,finalRev\)/);
  assert.doesNotMatch(block, /isOldAutoFilledMonth/);
  assert.doesNotMatch(block, /isBlankMonth\(data\)/);
  assert.doesNotMatch(block, /mergeCustomUnits\(data/);
});

test("الدمج التلقائي للوحدات لا يحذف وحدات موجودة", () => {
  const start = html.indexOf("function mergeCustomUnits");
  const end = html.indexOf("async function loadMonthOnline", start);
  const block = html.slice(start, end);
  assert.doesNotMatch(block, /data\.units\s*=\s*data\.units\.filter/);
  assert.doesNotMatch(block, /data\.full\s*=\s*data\.full\.filter/);
});

test("HTML لا يحتوي بيانات وحدات أو مستخدمين أو أرصدة افتراضية", () => {
  assert.doesNotMatch(html, /\bBASE_UNITS\b|\bBASE_FULL\b|APRIL_MIGRATION/);
  assert.doesNotMatch(html, /S\.user\s*===\s*["'](?:saeed|yahia|nader)["']/);
  assert.match(html, /const USERS=\{\}/);
});

test("الموظف يرسل للاعتماد دائماً ولا يوجد حفظ مباشر", () => {
  assert.match(html, /const needsApproval=!isOwner/);
  assert.doesNotMatch(html, /تم الحفظ مباشرة|صلاحية كاملة \(بدون اعتماد\)|حفظ مباشر/);
});

test("تشغيل البنك يعتمد على bankPayments فقط", () => {
  assert.doesNotMatch(html, /_legacyBank|\.bankDeposited/);
  assert.match(html, /function bankPaymentsFor/);
});

test("طلب تحديث وحدة قديمة لا يحتوي undefined", () => {
  const start = html.indexOf("function _diffFields");
  const end = html.indexOf("// ===== تحقق الحجوزات اليومية", start);
  const source = html.slice(start, end).trim();
  const diffFields = Function(`${source}; return _diffFields;`)();
  const oldUnit = { id: "102", status: "late", rent: 9000 };
  const updated = { ...oldUnit, status: "collected", collectedBy: "yahia", collectedAt: "2026-08-08T00:00:00.000Z" };
  const diff = diffFields(updated, oldUnit);
  const hasUndefined = value => value === undefined || (value && typeof value === "object" && Object.values(value).some(hasUndefined));
  assert.equal(hasUndefined(diff), false);
  assert.equal(diff.originalFields.collectedBy, "");
  assert.equal(diff.originalFields.collectedAt, "");
});

test("العهدة لا يعاد اختراعها من حالات الوحدات القديمة أو علامة شهر يدوية", () => {
  const start = html.indexOf("function custody(d, user)");
  const end = html.indexOf("// ===== المعادلة الأساسية", start);
  const block = html.slice(start, end);
  assert.doesNotMatch(block, /custodyClosed/);
  assert.match(block, /cashReceipts/);
  assert.doesNotMatch(block, /allItems\(d\).*collectedBy/);
  assert.match(block, /const rawRemaining=r2\(recv\+hvIn-hvOut-dep\)/);
  assert.match(block, /const remaining=Math\.max\(0,rawRemaining\)/);
  assert.match(block, /received:r2\(recv\)/);
  assert.match(block, /deposited:r2\(dep\)/);
});

test("التحصيل القديم مجهول الموظف يظهر باسم صادق لا ينسبه لموظف", () => {
  assert.match(html, /if\(k==="legacy"\)return "تحصيل سابق قبل تفعيل اسم الموظف"/);
});

test("تبويبة المالية ظاهرة مباشرة بعد الرئيسية للمدير على الهاتف", () => {
  assert.match(html, /const tabs=isOwner\?\["overview","financial","transactions","requests"/);
});

test("الملخص المالي يفضّل الإسقاط التشغيلي Collected/Deposited ولا يخلط العهدة", () => {
  assert.match(html, /function actualCollected\(d\)\{ const value=card\("collectedFils"\); return value!==null\?value:netDepositedForKPI\(d\); \}/);
  assert.match(html, /const value=card\("depositedFils"\)/);
  assert.match(html, /const value=card\("receivedNotDepositedFils"\)/);
  assert.match(html, /operationalReadModelCall=httpsCallable/);
});

test("المستهدف التعاقدي لا يعتمد على حالة دفع الوحدة", () => {
  const start = html.indexOf("function inTarget(x)");
  const end = html.indexOf("function bookingWasPaid", start);
  const block = html.slice(start, end);
  assert.doesNotMatch(block, /displayStatus/);
  assert.match(block, /x\.status==="vacant" \|\| x\.status==="staff"/);
  assert.match(block, /start && start>monthEnd/);
  assert.match(block, /end && end<monthStart/);
});

test("محرك التوازن لا يستدعي المتأخر أو الجزئي أو لم يحل عليه", () => {
  const start = html.indexOf("function balanceCheck(d)");
  const end = html.indexOf("return { num, r2", start);
  const block = html.slice(start, end);
  assert.doesNotMatch(block, /late\(d\)|notDue\(d\)|partialRemaining\(d\)/);
  assert.match(block, /const T=target\(d\)/);
  assert.match(block, /const DEP=netDepositedForKPI\(d\)/);
});

test("الوحدة المحسوم وضعها في الشهر الحالي لا تعود إلى بطاقة انتهاء المدة", () => {
  const start = html.indexOf("function needsAction(x)");
  const end = html.indexOf("function paidValue", start);
  const block = html.slice(start, end);
  assert.match(block, /lastRenewedKey===getMonthKey\(S\.year,S\.month\)/);
});

test("بطاقة قرارات انتهاء المدة لا تظهر في الشهور التاريخية", () => {
  const marker = html.indexOf("إيجارات معلّقة بسبب انتهاء المدة — بطاقة تنبيه فقط");
  const block = html.slice(marker, marker + 700);
  assert.match(block, /if\(S\.year!==NOW_Y\|\|S\.month!==NOW_M\)return null/);
});

test("الموظف يجلب طلباته فقط ولا يقرأ الأرصدة المالية", () => {
  assert.match(html, /where\("by","==",S\.user\)/);
  assert.match(rules, /match \/config\/balances \{\s*allow read:\s*if isFinance\(\)/);
  assert.match(rules, /allow read: if isFinance\(\) \|\| \(isStaff\(\) && resource\.data\.by == myKey\(\)\)/);
});
