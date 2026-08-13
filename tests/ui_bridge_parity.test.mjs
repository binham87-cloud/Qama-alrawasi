import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { executeCommand } from "../functions/domain/command_processor.mjs";
import { blankState } from "../functions/domain/command_processor.mjs";

for (const file of ["index.html", "public/index.html"]) {
  const html = fs.readFileSync(file, "utf8");
  test(`${file} — لا PIN ثابت ولا هوية محلية، والشاشات المعتادة هي مسار التشغيل`, () => {
    assert.doesNotMatch(html, /\bpin\s*:\s*["']\d{4}["']/);
    assert.match(html, /signInWithCustomToken/);
    assert.match(html, /httpsCallable\(functions,"pinLogin"\)/);
    assert.doesNotMatch(html, /renderCanonicalOperationalShell|renderCanonicalReconstructionShell/);
    assert.match(html, /function renderApp\(\)/);
  });
}

// ---------- backend: expense categories ----------
const actorMgr = { id: "manager:saeed", uid: "u_owner", role: "owner", active: true };
const actorEmp = { id: "employee:yahia", uid: "u_emp", role: "employee", active: true };
const ctx = (payload, actor, op) => ({ operationId: "op:bridge:" + op, payload, actor, now: "2026-08-12T10:00:00.000Z" });

function freshState() {
  const s = blankState();
  s.balances = { ...s.balances, revenue: 1000000, company: 1000000 };
  return s;
}

test("BE1 requestExpense يقبل unitMaintenance ويحفظ الفئة والموضوع", () => {
  const r = executeCommand(freshState(), "requestExpense",
    ctx({ amountFils: 50000, reason: "تصليح مكيف", category: "unitMaintenance", subject: "شقة 1 / بارتشن 3", monthKey: "2026_7" }, actorEmp, "op1"));
  const e = r.state.expenses.at(-1);
  assert.equal(e.category, "unitMaintenance");
  assert.equal(e.subject, "شقة 1 / بارتشن 3");
  assert.equal(e.status, "pending");
});

test("BE2 facilityMaintenance مميزة عن unitMaintenance", () => {
  const r = executeCommand(freshState(), "requestExpense",
    ctx({ amountFils: 20000, reason: "مصعد", category: "facilityMaintenance", subject: "المصعد", monthKey: "2026_7" }, actorEmp, "op2"));
  assert.equal(r.state.expenses.at(-1).category, "facilityMaintenance");
});

test("BE3 التوافق الرجعي — بلا category تصبح operating", () => {
  const r = executeCommand(freshState(), "requestExpense",
    ctx({ amountFils: 10000, reason: "كهرباء", monthKey: "2026_7" }, actorEmp, "op3"));
  assert.equal(r.state.expenses.at(-1).category, "operating");
  assert.equal(r.state.expenses.at(-1).subject, null);
});

test("BE4 فئة غير معروفة مرفوضة", () => {
  assert.throws(() => executeCommand(freshState(), "requestExpense",
    ctx({ amountFils: 100, reason: "x", category: "hack", monthKey: "2026_7" }, actorEmp, "op4")), /EXPENSE_CATEGORY_INVALID/);
});

test("BE5 الصيانة تتطلب تحديد الوحدة/المرفق", () => {
  assert.throws(() => executeCommand(freshState(), "requestExpense",
    ctx({ amountFils: 100, reason: "x", category: "unitMaintenance", monthKey: "2026_7" }, actorEmp, "op5")), /EXPENSE_SUBJECT_REQUIRED/);
});

test("BE6 الاعتماد يخصم مرة واحدة ويقيّد في السجل", () => {
  let s = executeCommand(freshState(), "requestExpense",
    ctx({ amountFils: 50000, reason: "تصليح", category: "unitMaintenance", subject: "شقة 1", monthKey: "2026_7" }, actorEmp, "op6")).state;
  const id = s.expenses.at(-1).id;
  const before = s.balances.revenue;
  s = executeCommand(s, "approveExpense", ctx({ expenseId: id, account: "revenue", monthKey: "2026_7" }, actorMgr, "op7")).state;
  assert.equal(s.balances.revenue, before - 50000);
  assert.equal(s.expenses.at(-1).status, "active");
  assert.equal(s.expenses.at(-1).category, "unitMaintenance", "الفئة تبقى بعد الاعتماد");
  assert.ok(s.ledger.some((l) => l.sourceId === id && l.direction === "debit"));
});

test("BE7 لا اعتماد مزدوج — لا خصم مرتين", () => {
  let s = executeCommand(freshState(), "requestExpense",
    ctx({ amountFils: 50000, reason: "ت", category: "unitMaintenance", subject: "ش1", monthKey: "2026_7" }, actorEmp, "op8")).state;
  const id = s.expenses.at(-1).id;
  s = executeCommand(s, "approveExpense", ctx({ expenseId: id, account: "revenue", monthKey: "2026_7" }, actorMgr, "op9")).state;
  const after = s.balances.revenue;
  assert.throws(() => executeCommand(s, "approveExpense", ctx({ expenseId: id, account: "revenue", monthKey: "2026_7" }, actorMgr, "op10")), /EXPENSE_NOT_PENDING/);
  assert.equal(s.balances.revenue, after);
});

test("BE8 idempotency — نفس operationId لا يخصم مرتين", () => {
  let s = freshState();
  const c = ctx({ amountFils: 50000, reason: "ت", category: "facilityMaintenance", subject: "مصعد", account: "revenue", monthKey: "2026_7" }, actorMgr, "opSame");
  s = executeCommand(s, "executeExpense", c).state;
  const after = s.balances.revenue;
  const replay = executeCommand(s, "executeExpense", c);
  assert.equal(replay.replay, true);
  assert.equal(replay.state.balances.revenue, after);
});

test("BE9 الموظف لا يعتمد مصروفاً", () => {
  let s = executeCommand(freshState(), "requestExpense",
    ctx({ amountFils: 1000, reason: "ت", monthKey: "2026_7" }, actorEmp, "op11")).state;
  const id = s.expenses.at(-1).id;
  assert.throws(() => executeCommand(s, "approveExpense", ctx({ expenseId: id, account: "revenue" }, actorEmp, "op12")));
});

test("BE10 عكس القيد يسترجع المبلغ للحساب نفسه بلا Math.max", () => {
  let s = freshState();
  s = executeCommand(s, "executeExpense",
    ctx({ amountFils: 50000, reason: "ت", category: "unitMaintenance", subject: "ش1", account: "company", monthKey: "2026_7" }, actorMgr, "op13")).state;
  const id = s.expenses.at(-1).id;
  const mid = s.balances.company;
  s = executeCommand(s, "reverseExpense", ctx({ expenseId: id }, actorMgr, "op14")).state;
  assert.equal(s.balances.company, mid + 50000);
  assert.equal(s.expenses.at(-1).status, "reversed");
});
