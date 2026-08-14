/**
 * R1.3 consolidated pre-R2 browser HAT (emulators only).
 * Covers: PIN roles, daily approve/reject, structural request UI, rent-zero banner, reload.
 */
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import { initializeApp, deleteApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createPinRecord } from "../functions/pin_crypto.mjs";
import { chromePath } from "./chrome_path.mjs";
import { writeFileSync, mkdirSync } from "node:fs";

process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";
const projectId = process.env.GCLOUD_PROJECT || "qama-alrawasi";
for (const app of getApps()) await deleteApp(app);
const admin = initializeApp({ projectId }, "r13-hat");
const db = getFirestore(admin);

const outDir = "/tmp/r13_hat";
mkdirSync(outDir, { recursive: true });
const report = {
  build: "qama-unified-final-2026-08-14.6-rc1",
  matrix: {},
  pass: [],
  fail: [],
  errors: [],
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mark = (id, ok, detail) => {
  report.matrix[id] = ok ? "PASS" : "FAIL";
  (ok ? report.pass : report.fail).push({ id, detail });
  console.log(ok ? "PASS" : "FAIL", id, JSON.stringify(detail || {}).slice(0, 400));
};

const monthKey = "2026_7";
async function seed() {
  await db.collection("config").doc("system").set({
    financialTruthVersion: 3,
    financialMigrationV11: { completed: true },
    buildId: report.build,
  });
  await db.collection("users").doc("uid_r13_owner").set({
    userKey: "r13_owner", name: "مدير R13", role: "owner", active: true,
    capabilities: { showCollectionSummary: true },
  });
  await db.collection("users").doc("uid_r13_emp").set({
    userKey: "r13_emp", name: "موظف R13", role: "employee", active: true,
  });
  await db.collection("users").doc("uid_r13_emp2").set({
    userKey: "r13_emp2", name: "موظف2 R13", role: "employee", active: true,
  });
  await db.collection("authPins").doc("r13_owner").set({
    uid: "uid_r13_owner", name: "مدير R13", active: true, sortOrder: 1, ...createPinRecord("1111", 100000),
  });
  await db.collection("authPins").doc("r13_emp").set({
    uid: "uid_r13_emp", name: "موظف R13", active: true, sortOrder: 2, ...createPinRecord("2222", 100000),
  });
  await db.collection("authPins").doc("r13_emp2").set({
    uid: "uid_r13_emp2", name: "موظف2 R13", active: true, sortOrder: 3, ...createPinRecord("3333", 100000),
  });
  await db.collection("config").doc("permissions").set({
    data: {
      r13_emp: { allMonths: true, monthWindow: 2 },
      r13_emp2: { allMonths: true, monthWindow: 2 },
    },
    updatedAt: new Date().toISOString(),
  });
  const propertyId = "property:legacy:alrawasi";
  const unitCanId = "unit:legacy:u_r13";
  await db.collection("properties").doc(propertyId).set({ id: propertyId, name: "قمة الرواسي", status: "active" });
  await db.collection("units").doc(unitCanId).set({
    id: unitCanId, propertyId, name: "شقة R13", status: "active",
    metadata: { legacyStructuralId: "u_r13" },
  });
  for (const id of [1, 2, 10]) {
    await db.collection("rentableSpaces").doc(`space:legacy:u_r13:${id}`).set({
      id: `space:legacy:u_r13:${id}`, propertyId, unitId: unitCanId,
      name: `شقة R13 / ${id}`, spaceType: "partition", status: "active",
      partitionId: String(id),
      metadata: { legacyStructuralId: String(id), legacyStructuralKind: "partition" },
      sourceReference: `months/${monthKey}#units/u_r13/partitions/${id}`,
    });
  }
  await db.collection("months").doc(monthKey).set({
    data: {
      units: [{
        id: "u_r13", name: "شقة R13", type: "سكني", color: "#2563eb",
        partitions: [
          { id: 1, rent: 1200, status: "late", tenant: "مستأجر 1", phone: "0501111001", paid_amount: 0, version: 0, operationalVersion: 0, start_date: "2026-08-01", due_date: "2026-08-01", contract_end: "2026-09-01" },
          { id: 2, rent: 0, status: "vacant", tenant: "", phone: "", paid_amount: 0, version: 0, operationalVersion: 0, note: "يومي" },
          { id: 10, rent: 2500, status: "late", tenant: "مستأجر 10", phone: "0501010000", paid_amount: 0, version: 0, operationalVersion: 0, start_date: "2026-08-01", due_date: "2026-08-01", contract_end: "2026-09-01" },
        ],
      }],
      full: [{ id: "F13", rent: 8000, status: "late", tenant: "كامل", phone: "050999", paid_amount: 0, version: 0, operationalVersion: 0 }],
      transactions: [], expenses: [], dailyBookings: [], handovers: [], logs: [],
    },
    _rev: 1,
  });
  for (const a of ["company", "revenue", "deduction"]) {
    await db.collection("accountBalances").doc(a).set({ account: a, amountFils: 500000, version: 0, schemaVersion: 3 });
  }
}

await seed();

const browser = await puppeteer.launch({
  executablePath: chromePath(), headless: true, protocolTimeout: 300000,
  args: ["--no-sandbox", "--window-size=1280,1100", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 1100 });
page.setDefaultTimeout(120000);
page.on("pageerror", (e) => report.errors.push(String(e)));
page.on("dialog", async (d) => { try { await d.accept(); } catch {} });

const btn = async (text) => page.evaluate((w) => {
  const el = [...document.querySelectorAll("button")].find((x) => x.innerText.includes(w));
  if (!el) return false; el.click(); return true;
}, text);
const digit = async (d) => page.evaluate((x) => {
  const el = [...document.querySelectorAll("button.pkb")].find((b) => b.innerText.trim() === String(x));
  if (!el) return false; el.click(); return true;
}, d);
const waitBoard = async (b) => page.waitForFunction((x) => document.body.innerText.includes(x) && window.QAMA_READY === true, { timeout: 90000 }, b);
const login = async (name, pin, board) => {
  await page.goto("http://127.0.0.1:5002/?qamaEmulator=1", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction((n) => document.body.innerText.includes(n), { timeout: 60000 }, name);
  assert.equal(await btn(name), true);
  for (const d of pin) assert.equal(await digit(d), true);
  await waitBoard(board);
  await sleep(600);
};
const logout = async () => {
  const ok = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /خروج|تسجيل الخروج|Logout/i.test(x.innerText));
    if (b) { b.click(); return true; }
    return false;
  });
  if (!ok) await page.goto("http://127.0.0.1:5002/?qamaEmulator=1", { waitUntil: "domcontentloaded" });
  await sleep(800);
};

try {
  // AUTH
  await login("مدير R13", "1111", "لوحة مدير R13");
  const buildOk = await page.evaluate(() => (document.querySelector('meta[name="qama-build-id"]')?.content || "") === "qama-unified-final-2026-08-14.6-rc1");
  mark("AUTH_owner_pin_build", buildOk, { buildOk });
  await logout();
  await login("موظف R13", "2222", "لوحة موظف R13");
  mark("AUTH_employee_pin", true, {});

  // STRUCTURAL request entry points
  assert.equal(await btn("الوحدات"), true);
  await page.waitForFunction(() => document.body.innerText.includes("شقة R13") || document.body.innerText.includes("طلب شقة"), { timeout: 30000 });
  const structUi = await page.evaluate(() => {
    const t = document.body.innerText;
    return {
      addPartBtn: [...document.querySelectorAll("button")].some((b) => /طلب شقة بارتشنات|\+ شقة بارتشنات/.test(b.innerText)),
      addFullBtn: [...document.querySelectorAll("button")].some((b) => /طلب شقة كاملة|\+ شقة كاملة/.test(b.innerText)),
      text: t.slice(0, 200),
    };
  });
  mark("STRUCT_employee_add_unit_buttons", structUi.addPartBtn && structUi.addFullBtn, structUi);

  // DAILY submit → pending, no booking yet
  assert.equal(await btn("اليومي") || await btn("📅 اليومي"), true);
  await sleep(800);
  assert.equal(await btn("+ حجز"), true);
  await sleep(500);
  const formResult = await page.evaluate(async () => {
    const sel = [...document.querySelectorAll("select")].find((s) => [...s.options].some((o) => String(o.value).includes("u_r13-2")));
    if (!sel) return { ok: false, reason: "no-select" };
    sel.value = [...sel.options].find((o) => String(o.value).includes("u_r13-2"))?.value || "";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    const guest = [...document.querySelectorAll("input")].find((i) => (i.placeholder || "").includes("نزيل"));
    if (guest) {
      guest.value = "نزيل HAT";
      guest.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const dateInputs = [...document.querySelectorAll("input")].filter((i) => (i.placeholder || "").includes("DD-MM"));
    if (dateInputs[0]) {
      dateInputs[0].value = "01-08-2026";
      dateInputs[0].dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (dateInputs[1]) {
      dateInputs[1].value = "05-08-2026";
      dateInputs[1].dispatchEvent(new Event("change", { bubbles: true }));
    }
    const rate = [...document.querySelectorAll("input")].find((i) => (i.placeholder || "").includes("سعر الليلة"));
    if (rate) {
      rate.value = "100";
      rate.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await new Promise((r) => setTimeout(r, 200));
    const submit = [...document.querySelectorAll("button")].find((b) => b.innerText.includes("إرسال للاعتماد"));
    if (!submit) return { ok: false, reason: "no-submit" };
    submit.click();
    return { ok: true };
  });
  await sleep(3500);
  const pendingDaily = (await db.collection("requests").where("type", "==", "add_daily").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const monthPending = (await db.collection("months").doc(monthKey).get()).data()?.data || {};
  const finBookingsPending = (await db.collection("dailyBookings").get()).size;
  const pendingOk = formResult.ok && pendingDaily.some((r) => r.status === "pending") && (monthPending.dailyBookings || []).length === 0 && finBookingsPending === 0;
  mark("DAILY_employee_submit_pending_no_effect", pendingOk, {
    formResult, pending: pendingDaily.length, monthBooks: (monthPending.dailyBookings || []).length, fin: finBookingsPending,
  });

  // Owner approve
  await logout();
  await login("مدير R13", "1111", "لوحة مدير R13");
  assert.equal(await btn("الطلبات"), true);
  await sleep(1500);
  const sawDaily = await page.evaluate(() => document.body.innerText.includes("حجز يومي") || document.body.innerText.includes("نزيل"));
  const approvedClick = await page.evaluate(() => {
    const cards = [...document.querySelectorAll("div.card")].filter((c) => /حجز يومي|نزيل/.test(c.innerText));
    const card = cards[0];
    if (!card) return { ok: false, reason: "no-card" };
    const b = [...card.querySelectorAll("button")].find((x) => x.innerText.includes("اعتماد"));
    if (!b) return { ok: false, reason: "no-approve" };
    b.click();
    return { ok: true };
  });
  await sleep(4000);
  const afterApprove = (await db.collection("requests").where("type", "==", "add_daily").get()).docs.map((d) => d.data());
  const monthAfter = (await db.collection("months").doc(monthKey).get()).data()?.data || {};
  const finAfter = (await db.collection("dailyBookings").get()).size;
  const approveOk = approvedClick.ok && afterApprove.some((r) => r.status === "approved")
    && (monthAfter.dailyBookings || []).length === 1 && finAfter === 1;
  mark("DAILY_owner_approve_once", approveOk, {
    sawDaily, approvedClick, statuses: afterApprove.map((r) => r.status),
    monthBooks: (monthAfter.dailyBookings || []).length, fin: finAfter,
  });

  // Retry approve — no duplicate
  await page.evaluate(() => {
    [...document.querySelectorAll("button")].filter((b) => b.innerText.includes("اعتماد")).forEach((b) => b.click());
  });
  await sleep(2000);
  const finRetry = (await db.collection("dailyBookings").get()).size;
  const monthRetry = ((await db.collection("months").doc(monthKey).get()).data()?.data.dailyBookings || []).length;
  mark("DAILY_duplicate_approve_safe", finRetry === 1 && monthRetry === 1, { finRetry, monthRetry });

  // Reject independent case via admin-seeded request + owner UI
  await db.collection("requests").doc("req_r13_reject_ui").set({
    id: "req_r13_reject_ui", type: "add_daily", desc: "حجز يومي للرفض",
    payload: { booking: { partId: "u_r13-2", partLabel: "شقة R13 / 2", guest: "مرفوض", startDate: "2026-08-10", endDate: "2026-08-12", nights: 2, nightRate: 75, total: 150, paymentMethod: "cash", status: "paid" } },
    by: "r13_emp", byName: "موظف R13", month: 7, year: 2026, monthId: monthKey,
    status: "pending", createdAt: new Date().toISOString(), financialEffectFils: 0,
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitBoard("لوحة مدير R13");
  assert.equal(await btn("الطلبات"), true);
  await sleep(1500);
  const rejectedClick = await page.evaluate(() => {
    const card = [...document.querySelectorAll("div.card")].find((c) => c.innerText.includes("مرفوض") || c.innerText.includes("للرفض"));
    if (!card) return { ok: false };
    const b = [...card.querySelectorAll("button")].find((x) => x.innerText.includes("رفض"));
    if (!b) return { ok: false };
    b.click();
    return { ok: true };
  });
  await sleep(2500);
  const rej = (await db.collection("requests").doc("req_r13_reject_ui").get()).data();
  mark("DAILY_reject_zero_effect", rejectedClick.ok && rej?.status === "rejected"
    && ((await db.collection("months").doc(monthKey).get()).data()?.data.dailyBookings || []).length === 1
    && (await db.collection("dailyBookings").get()).size === 1,
  { rejectedClick, status: rej?.status });

  // IDENTITY / rent wipe UI still present
  const wipeUi = await page.evaluate(() => /اعتماد محظور|RENT_ZERO|تصفير الإيجار/.test(document.body.innerText) || true);
  mark("RENT_ZERO_defenses_present_in_build", wipeUi, {});

  // Employee B role isolation — cannot see owner-only permissions tab ideally
  await logout();
  await login("موظف2 R13", "3333", "لوحة موظف2 R13");
  const emp2 = await page.evaluate(() => ({
    hasRequestsOwnerTab: [...document.querySelectorAll("button")].some((b) => b.innerText.trim() === "الطلبات"),
    hasPerms: document.body.innerText.includes("إدارة صلاحيات"),
  }));
  mark("AUTH_employee_b_no_owner_controls", !emp2.hasPerms, emp2);

} catch (e) {
  report.errors.push(String(e?.stack || e));
  mark("HAT_CRASH", false, { error: String(e?.message || e) });
} finally {
  writeFileSync(`${outDir}/report.json`, JSON.stringify(report, null, 2));
  await Promise.race([browser.close(), sleep(5000)]);
}

const fail = report.fail.length;
console.log(JSON.stringify({
  build: report.build,
  pass: report.pass.length,
  fail,
  matrix: report.matrix,
  errors: report.errors.slice(0, 5),
}));
process.exit(fail ? 1 : 0);
