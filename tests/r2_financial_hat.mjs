/**
 * R2 consolidated financial + operational HAT (emulators only).
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
const admin = initializeApp({ projectId }, "r2-hat");
const db = getFirestore(admin);

const BUILD = "qama-unified-final-2026-08-14.6-rc1";
const outDir = "/tmp/r2_hat";
mkdirSync(outDir, { recursive: true });
const report = { build: BUILD, matrix: {}, pass: [], fail: [], errors: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mark = (id, ok, detail) => {
  report.matrix[id] = ok ? "PASS" : "FAIL";
  (ok ? report.pass : report.fail).push({ id, detail });
  console.log(ok ? "PASS" : "FAIL", id, JSON.stringify(detail || {}).slice(0, 400));
};

const monthKey = "2026_7";
const propertyId = "property:legacy:alrawasi";
const unitCanId = "unit:legacy:u_r13";

async function seed() {
  await db.collection("config").doc("system").set({
    financialTruthVersion: 3, financialMigrationV11: { completed: true }, buildId: BUILD,
  });
  await db.collection("users").doc("uid_r2_owner").set({
    userKey: "r2_owner", name: "مدير R2", role: "owner", active: true,
    capabilities: { showCollectionSummary: true },
  });
  await db.collection("users").doc("uid_r2_emp").set({ userKey: "r2_emp", name: "موظف R2", role: "employee", active: true });
  await db.collection("users").doc("uid_r2_emp2").set({ userKey: "r2_emp2", name: "موظف2 R2", role: "employee", active: true });
  await db.collection("authPins").doc("r2_owner").set({ uid: "uid_r2_owner", name: "مدير R2", active: true, sortOrder: 1, ...createPinRecord("1111", 100000) });
  await db.collection("authPins").doc("r2_emp").set({ uid: "uid_r2_emp", name: "موظف R2", active: true, sortOrder: 2, ...createPinRecord("2222", 100000) });
  await db.collection("authPins").doc("r2_emp2").set({ uid: "uid_r2_emp2", name: "موظف2 R2", active: true, sortOrder: 3, ...createPinRecord("3333", 100000) });
  await db.collection("config").doc("permissions").set({
    data: { r2_emp: { allMonths: true, monthWindow: 2 }, r2_emp2: { allMonths: true, monthWindow: 2 } },
    updatedAt: new Date().toISOString(),
  });
  await db.collection("properties").doc(propertyId).set({ id: propertyId, name: "قمة الرواسي", status: "active" });
  await db.collection("units").doc(unitCanId).set({
    id: unitCanId, propertyId, name: "شقة R2", status: "active",
    metadata: { legacyStructuralId: "u_r13" },
  });
  for (const id of [1, 2, 4, 10]) {
    await db.collection("rentableSpaces").doc(`space:legacy:u_r13:${id}`).set({
      id: `space:legacy:u_r13:${id}`, propertyId, unitId: unitCanId,
      name: `شقة R2 / ${id}`, spaceType: "partition", status: "active", partitionId: String(id),
      metadata: { legacyStructuralId: String(id), legacyStructuralKind: "partition" },
      sourceReference: `months/${monthKey}#units/u_r13/partitions/${id}`,
    });
  }
  await db.collection("months").doc(monthKey).set({
    data: {
      units: [{
        id: "u_r13", name: "شقة R2", type: "سكني", color: "#2563eb",
        partitions: [
          { id: 1, rent: 1000, status: "late", tenant: "مستأجر A", phone: "0501111001", paid_amount: 0, version: 0, operationalVersion: 0, start_date: "2026-08-01", due_date: "2026-08-01", contract_end: "2026-09-01" },
          { id: 2, rent: 0, status: "vacant", tenant: "", phone: "", paid_amount: 0, version: 0, operationalVersion: 0, note: "يومي" },
          { id: 4, rent: 1000, status: "late", tenant: "مستأجر بنك", phone: "050444", paid_amount: 0, version: 0, operationalVersion: 0, start_date: "2026-08-01", due_date: "2026-08-01", contract_end: "2026-09-01" },
          { id: 10, rent: 2500, status: "late", tenant: "مستأجر 10", phone: "0501010000", paid_amount: 0, version: 0, operationalVersion: 0, start_date: "2026-08-01", due_date: "2026-08-01", contract_end: "2026-09-01" },
        ],
      }],
      full: [], transactions: [], expenses: [], dailyBookings: [], handovers: [], logs: [],
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
const finance = async () => {
  await btn("المالية");
  await sleep(1000);
  return page.evaluate(() => {
    const t = document.body.innerText;
    const after = (label) => {
      const i = t.indexOf(label); if (i < 0) return null;
      const slice = t.slice(i, i + 90).replace(/\s+/g, " ");
      const m = slice.match(/([0-9][0-9,]*)\s*د\.إ/);
      return { slice, num: m ? Number(m[1].replace(/,/g, "")) : null };
    };
    return {
      textHas: /المستهدف|المحصّل|المودع/.test(t),
      المحصّل: after("المحصّل"),
      المودع: after("المودع"),
      عهدة: after("محصّل ولم يُودع بعد") || after("عهدة"),
    };
  });
};
const finCounts = async () => ({
  cashLots: (await db.collection("cashLots").get()).size,
  collectionEvents: (await db.collection("collectionEvents").get()).size,
  dailyBookings: (await db.collection("dailyBookings").get()).size,
  payments: (await db.collection("payments").get()).size,
});
const mouseClickTextCard = async (includes, maxLen = 400) => {
  const box = await page.evaluate((t, max) => {
    const el = [...document.querySelectorAll("div.card, div")].filter((d) => (d.innerText || "").includes(t) && (d.innerText || "").length < max)
      .sort((a, b) => a.innerText.length - b.innerText.length)[0];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + Math.min(30, r.height / 2) };
  }, includes, maxLen);
  assert.ok(box, `card:${includes}`);
  await page.mouse.click(box.x, box.y);
};
const openUnit = async () => {
  assert.equal(await btn("الوحدات"), true);
  await page.waitForFunction(() => document.body.innerText.includes("شقة R2"), { timeout: 30000 });
  await mouseClickTextCard("شقة R2", 350);
  await page.waitForFunction(() => /مستأجر A|مستأجر بنك/.test(document.body.innerText), { timeout: 30000 });
  await sleep(400);
};
const openEditor = async (needle) => {
  const box = await page.evaluate((t) => {
    const row = [...document.querySelectorAll("div")].filter((d) => {
      const txt = d.innerText || "";
      return txt.includes(t) && (txt.includes("▼") || txt.includes("▲")) && txt.length < 400;
    }).sort((a, b) => a.innerText.length - b.innerText.length)[0];
    if (!row) return null;
    const r = row.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, needle);
  assert.ok(box, `row:${needle}`);
  await page.mouse.click(box.x, box.y);
  await page.waitForFunction(() => [...document.querySelectorAll("div")].some((d) => d.innerText.trim() === "الحالة"), { timeout: 20000 });
  await sleep(400);
};
const confirmCash = async (amount) => page.evaluate((amt) => {
  const inp = [...document.querySelectorAll("input")].find((i) => (i.placeholder || "").includes("تحصيل"));
  if (!inp) return { ok: false, reason: "no_cash_input" };
  inp.value = String(amt);
  inp.dispatchEvent(new Event("input", { bubbles: true }));
  inp.dispatchEvent(new Event("change", { bubbles: true }));
  const b = [...document.querySelectorAll("button")].find((x) => x.innerText.includes("تأكيد استلام المبلغ"));
  if (!b) return { ok: false, reason: "no_confirm" };
  b.click();
  return { ok: true };
}, amount);

try {
  await login("مدير R2", "1111", "لوحة مدير R2");
  const buildOk = await page.evaluate((b) => (document.querySelector('meta[name="qama-build-id"]')?.content || "") === b, BUILD);
  mark("AUTH_owner_pin_build", buildOk, { buildOk });

  const fin0 = await finance();
  mark("FIN_owner_dashboard_cards", !!fin0.textHas, fin0);

  await openUnit();
  await openEditor("مستأجر A");
  const beforeCash = await finCounts();
  const cash = await confirmCash(1000);
  await sleep(5000);
  const afterCash = await finCounts();
  const finCash = await finance();
  mark("CASH_owner_collect_holding", cash.ok && afterCash.cashLots === beforeCash.cashLots + 1 && afterCash.collectionEvents === beforeCash.collectionEvents + 1, {
    cash, beforeCash, afterCash, finCash,
  });

  await openUnit();
  await openEditor("مستأجر A");
  await confirmCash(1000);
  await sleep(3000);
  const afterDup = await finCounts();
  mark("CASH_duplicate_no_mint", afterDup.cashLots === afterCash.cashLots, afterDup);

  await openUnit();
  await openEditor("مستأجر بنك");
  await page.evaluate(() => {
    const method = [...document.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "bank") && [...s.options].some((o) => o.value === "cash"));
    if (method) { method.value = "bank"; method.dispatchEvent(new Event("change", { bubbles: true })); }
  });
  await sleep(400);
  await page.evaluate(() => {
    const amt = [...document.querySelectorAll("input[type=number]")].find((i) => (i.placeholder || "").includes("مبلغ"));
    if (amt) { amt.value = "1000"; amt.dispatchEvent(new Event("input", { bubbles: true })); }
    const b = [...document.querySelectorAll("button")].find((x) => /تحويل|بنك|إرسال/.test(x.innerText) && !x.innerText.includes("تأكيد استلام"));
    b?.click();
  });
  await sleep(4000);
  const bankPending = (await db.collection("payments").get()).docs.map((d) => d.data()).filter((p) => p.method === "bank");
  mark("BANK_submit_no_holding_lot", bankPending.length >= 1 && (await db.collection("cashLots").get()).size === afterCash.cashLots, {
    bankPending: bankPending.length, lots: (await db.collection("cashLots").get()).size,
  });

  await logout();
  await login("موظف R2", "2222", "لوحة موظف R2");
  const empUi = await page.evaluate(() => ({
    hasPerms: document.body.innerText.includes("إدارة صلاحيات"),
    hasRequestsOwnerTab: [...document.querySelectorAll("button")].some((b) => b.innerText.trim() === "الطلبات"),
  }));
  mark("AUTH_employee_no_owner_controls", !empUi.hasPerms, empUi);

  assert.equal(await btn("اليومي") || await btn("📅 اليومي"), true);
  await sleep(600);
  assert.equal(await btn("+ حجز"), true);
  await sleep(400);
  const formResult = await page.evaluate(async () => {
    const sel = [...document.querySelectorAll("select")].find((s) => [...s.options].some((o) => String(o.value).includes("u_r13-2")));
    if (!sel) return { ok: false, reason: "no-select" };
    sel.value = [...sel.options].find((o) => String(o.value).includes("u_r13-2"))?.value || "";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    const guest = [...document.querySelectorAll("input")].find((i) => (i.placeholder || "").includes("نزيل"));
    if (guest) { guest.value = "نزيل R2"; guest.dispatchEvent(new Event("input", { bubbles: true })); }
    const dateInputs = [...document.querySelectorAll("input")].filter((i) => (i.placeholder || "").includes("DD-MM"));
    if (dateInputs[0]) { dateInputs[0].value = "01-08-2026"; dateInputs[0].dispatchEvent(new Event("change", { bubbles: true })); }
    if (dateInputs[1]) { dateInputs[1].value = "05-08-2026"; dateInputs[1].dispatchEvent(new Event("change", { bubbles: true })); }
    const rate = [...document.querySelectorAll("input")].find((i) => (i.placeholder || "").includes("سعر الليلة"));
    if (rate) { rate.value = "100"; rate.dispatchEvent(new Event("input", { bubbles: true })); }
    await new Promise((r) => setTimeout(r, 200));
    const submit = [...document.querySelectorAll("button")].find((b) => b.innerText.includes("إرسال للاعتماد"));
    if (!submit) return { ok: false, reason: "no-submit" };
    submit.click();
    return { ok: true };
  });
  await sleep(3000);
  const pendingDaily = (await db.collection("requests").where("type", "==", "add_daily").get()).docs.map((d) => d.data());
  mark("DAILY_employee_submit_pending", formResult.ok && pendingDaily.some((r) => r.status === "pending") && (await db.collection("dailyBookings").get()).size === 0, {
    formResult, pending: pendingDaily.length,
  });

  await logout();
  await login("مدير R2", "1111", "لوحة مدير R2");
  assert.equal(await btn("الطلبات"), true);
  await sleep(1500);
  const approvedClick = await page.evaluate(() => {
    const card = [...document.querySelectorAll("div.card")].find((c) => /حجز يومي|نزيل R2/.test(c.innerText));
    if (!card) return { ok: false, reason: "no-card" };
    const b = [...card.querySelectorAll("button")].find((x) => x.innerText.includes("اعتماد"));
    if (!b) return { ok: false, reason: "no-approve" };
    b.click();
    return { ok: true };
  });
  await sleep(4000);
  const dailyAfter = (await db.collection("dailyBookings").get()).size;
  const reqAfter = (await db.collection("requests").where("type", "==", "add_daily").get()).docs.map((d) => d.data());
  mark("DAILY_owner_approve_once", approvedClick.ok && dailyAfter === 1 && reqAfter.some((r) => r.status === "approved"), {
    approvedClick, dailyAfter, statuses: reqAfter.map((r) => r.status),
  });

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitBoard("لوحة مدير R2");
  mark("RELOAD_session_persists", await page.evaluate(() => document.body.innerText.includes("لوحة مدير R2")), {});

  await logout();
  await login("موظف2 R2", "3333", "لوحة موظف2 R2");
  const emp2 = await page.evaluate(() => ({
    hasPerms: document.body.innerText.includes("إدارة صلاحيات"),
    lotsHint: document.body.innerText.includes("إدارة صلاحيات"),
  }));
  mark("AUTH_employee_b_isolated", !emp2.hasPerms, emp2);
} catch (e) {
  report.errors.push(String(e?.stack || e));
  mark("HAT_CRASH", false, { error: String(e?.message || e) });
} finally {
  writeFileSync(`${outDir}/report.json`, JSON.stringify(report, null, 2));
  await Promise.race([browser.close(), sleep(5000)]);
}

const fail = report.fail.length;
console.log(JSON.stringify({ build: report.build, pass: report.pass.length, fail, matrix: report.matrix, errors: report.errors.slice(0, 5) }));
process.exit(fail ? 1 : 0);
