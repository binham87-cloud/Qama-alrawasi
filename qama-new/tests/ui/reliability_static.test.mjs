/**
 * Static + contract tests for OLD-UI reliability patches.
 * No visual redesign — verifies pending select + unpaid intent wiring.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const html = readFileSync(resolve(root, "src/frontend/index.html"), "utf8");
const bridge = readFileSync(resolve(root, "src/frontend/qama-engine-bridge.js"), "utf8");
const authSrc = readFileSync(resolve(root, "src/frontend/old-qama-shell.html"), "utf8");

test("assembled UI targets qama-new-prod-2026 only", () => {
  assert.match(html, /qama-new-prod-2026/);
  assert.doesNotMatch(html, /qama-alrawasi\.firebaseapp\.com/);
});

test("partition status select includes pending (fixes fake محصّل)", () => {
  assert.match(html, /\["collected","pending","late","vacant","staff"\]/);
  assert.match(authSrc, /\["collected","pending","late","vacant","staff"\]/);
});

test("status change to late clears paid_amount (UI contract)", () => {
  assert.match(html, /paid_amount=0/);
  assert.match(authSrc, /p\.paid_amount=0/);
  assert.match(authSrc, /u\.paid_amount=0/);
});

test("bridge uncollects when late/pending with engine paid>0", () => {
  assert.match(bridge, /uncollectObligation/);
  assert.match(bridge, /maybeUncollect/);
  assert.match(bridge, /unpaidUi/);
  assert.match(bridge, /item\.status === "late"/);
  assert.match(bridge, /item\.status === "pending"/);
});

test("bridge applies per-item isolation so one failure cannot skip uncollect of others", () => {
  assert.match(bridge, /applyEngineDiff item failed/);
});

test("save path re-hydrates from engine after setDoc", () => {
  assert.match(html, /hydrateMonthFromEngine/);
  assert.match(html, /await hydrateMonthFromEngine\(y, m\)/);
});

test("commitWorkRequest path exists for employee approvals", () => {
  assert.match(html, /commitWorkRequest/);
  assert.match(bridge, /commitWorkRequest/);
});

test("login users present", () => {
  assert.match(html, /مدير/);
  assert.match(html, /يحيى/);
  assert.match(html, /نادر/);
});

test("dark old QAMA shell markers present", () => {
  assert.match(html, /#0a0a0a/);
  assert.match(html, /قمة الرواسي/);
  assert.match(html, /الشقق الكاملة|بارتشن/);
});

test("inventory: core mutation entrypoints exist", () => {
  for (const name of [
    "updateP", "updateFull", "saveCurData", "submitRequest",
    "approveRequest", "rejectRequest", "saveMonthData", "loadMonthOnline",
  ]) {
    assert.ok(html.includes(name), "missing " + name);
  }
});

test("Manager bank reject uses rejectBankReceipt path, not resolveWorkRequest alone", () => {
  const src = authSrc;
  const rejAt = src.indexOf("async function rejectRequest(req){");
  assert.ok(rejAt >= 0, "rejectRequest missing in shell");
  const rejSlice = src.slice(rejAt, rejAt + 900);
  assert.match(rejSlice, /engine_approval/);
  assert.match(rejSlice, /_rejectCommand/);
  assert.match(rejSlice, /engineCommand/);
  const engIdx = rejSlice.indexOf("engine_approval");
  const setDocIdx = rejSlice.indexOf('setDoc(doc(db,"requests"');
  assert.ok(engIdx >= 0 && setDocIdx > engIdx, "engine reject must run before requests setDoc");
  const htmlRej = html.indexOf("async function rejectRequest(req){");
  const htmlSlice = html.slice(htmlRej, htmlRej + 900);
  assert.match(htmlSlice, /_rejectCommand/);
  assert.match(htmlSlice, /engineCommand/);
  assert.match(html, /FINANCIAL-CANON-20260913T1855Z/);
  assert.match(authSrc, /d\.state === "rejected"/);
  assert.match(authSrc, /fromBankReceipt === true/);
  const readModel = readFileSync(resolve(root, "functions/services/readModel.mjs"), "utf8");
  assert.match(readModel, /rejectCommand:\s*"rejectBankReceipt"/);
  assert.match(readModel, /bankReceiptHistoryRows/);
  assert.match(readModel, /r\.state === "rejected"/);
});

test("rejected bank history stays visible: liveDep keeps fromBankReceipt rejected; Manager done pins bank_history", () => {
  assert.match(bridge, /fromBankReceipt === true/);
  assert.match(bridge, /d\.state === "rejected"/);
  assert.match(html, /fromBankReceipt === true/);
  assert.match(authSrc, /type==="bank_history"/);
  assert.match(authSrc, /bankDone/);
  assert.match(html, /bankDone/);
  assert.match(authSrc, /\[\.\.\.terminalBank, \.\.\.byReqId\.values\(\), \.\.\.enginePending\]/);
  assert.match(html, /\[\.\.\.terminalBank, \.\.\.byReqId\.values\(\), \.\.\.enginePending\]/);
});

test("month navigation clears stale dash and seeds period obligations for any role", () => {
  assert.match(authSrc, /function changeMonth\(m,y\)\{[\s\S]{0,200}S\._dash\s*=\s*null/);
  assert.match(html, /function changeMonth\(m,y\)\{[\s\S]{0,200}S\._dash\s*=\s*null/);
  assert.match(bridge, /generateObligations/);
  // Must not be owner-only — employees navigating months need the same period seed.
  const refreshAt = bridge.indexOf("async function refreshEngine");
  const refreshSlice = bridge.slice(refreshAt, refreshAt + 500);
  assert.match(refreshSlice, /generateObligations/);
  assert.doesNotMatch(refreshSlice, /role === "owner"[\s\S]{0,120}generateObligations/);
  assert.match(html, /FINANCIAL-CANON-20260913T1855Z/);
  assert.match(bridge, /sp\.cycleStart \|\| sp\.startDate/);
});

test("financial cards derive from canonicalIncomeAed / engine summary — not raw tx reduce", () => {
  assert.match(authSrc, /function canonicalIncomeAed/);
  assert.match(authSrc, /function financiallyEffectiveTxAed/);
  assert.match(authSrc, /_displayOnly/);
  assert.match(html, /canonicalIncomeAed/);
  assert.match(html, /financiallyEffectiveTxAed/);
  // Income/Net must not raw-reduce transactions including rejected bank history.
  assert.doesNotMatch(authSrc, /const totalIncome=txList\.reduce\(\(s,t\)=>s\+Number\(t\.amount/);
  assert.doesNotMatch(authSrc, /const totalTx=data\.transactions\.reduce\(\(s,t\)=>s\+\(Number\(t\.amount\)/);
  assert.doesNotMatch(html, /const totalIncome=txList\.reduce\(\(s,t\)=>s\+Number\(t\.amount/);
  assert.match(bridge, /_displayOnly:\s*!!d\.fromBankReceipt/);
});
