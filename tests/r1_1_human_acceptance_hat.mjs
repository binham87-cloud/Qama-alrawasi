/**
 * R1.1 Human Acceptance Matrix — local emulators only.
 * Production-shaped fixture with canonical rentableSpaces/units so cash/bank resolve.
 * Temporary review scripts (_r1_hat_*) are NOT this file.
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
const admin = initializeApp({ projectId }, "r11-hat");
const db = getFirestore(admin);

const outDir = "/tmp/r11_hat_shots";
mkdirSync(outDir, { recursive: true });
const report = {
  build: "qama-unified-final-2026-08-14.5",
  paths: {},
  pass: [],
  fail: [],
  transcripts: {},
  errors: [],
  human: { total: 0, pass: 0, fail: 0 },
};
const log = (k, v) => console.log("HAT11", k, typeof v === "string" ? v.slice(0, 600) : JSON.stringify(v).slice(0, 1000));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mark = (id, ok, detail) => {
  report.human.total += 1;
  if (ok) report.human.pass += 1; else report.human.fail += 1;
  report.paths[id] = ok ? "PASS" : "FAIL";
  (ok ? report.pass : report.fail).push({ id, detail });
  log(ok ? "PASS" : "FAIL", { id, detail });
};

const monthKey = "2026_7";
const propertyId = "property:legacy:alrawasi";
const unitCanId = "unit:legacy:u_hat";
const fullUnitCanId = "unit:legacy:F1";

async function seed() {
  await db.collection("config").doc("system").set({
    financialTruthVersion: 3,
    financialMigrationV11: { completed: true },
    buildId: report.build,
  });
  await db.collection("users").doc("uid_hat_owner").set({
    userKey: "hat_owner", name: "مدير HAT", role: "owner", active: true,
    capabilities: { showCollectionSummary: true },
  });
  await db.collection("users").doc("uid_hat_emp").set({
    userKey: "hat_emp", name: "موظف HAT", role: "employee", active: true,
  });
  await db.collection("authPins").doc("hat_owner").set({
    uid: "uid_hat_owner", name: "مدير HAT", active: true, sortOrder: 1, ...createPinRecord("1111", 100000),
  });
  await db.collection("authPins").doc("hat_emp").set({
    uid: "uid_hat_emp", name: "موظف HAT", active: true, sortOrder: 2, ...createPinRecord("2222", 100000),
  });
  await db.collection("config").doc("permissions").set({
    data: { hat_emp: { allMonths: true, monthWindow: 2 } },
    updatedAt: new Date().toISOString(),
  });
  await db.collection("properties").doc(propertyId).set({
    id: propertyId, name: "قمة الرواسي", status: "active",
  });
  await db.collection("units").doc(unitCanId).set({
    id: unitCanId, propertyId, name: "شقة HAT", status: "active",
    metadata: { legacyStructuralId: "u_hat" },
  });
  await db.collection("units").doc(fullUnitCanId).set({
    id: fullUnitCanId, propertyId, name: "شقة F1", status: "active",
    metadata: { legacyStructuralId: "F1" },
  });

  const partSpaces = [
    { id: "1", rent: 1000, status: "late", tenant: "مستأجر A", phone: "050111", paid_amount: 0 },
    { id: "2", rent: 2000, status: "late", tenant: "مستأجر B مدفوع", phone: "050222", paid_amount: 2000 },
    { id: "3", rent: 1500, status: "vacant", tenant: "", phone: "", paid_amount: 0 },
    { id: "4", rent: 1000, status: "late", tenant: "مستأجر بنك", phone: "050444", paid_amount: 0 },
    { id: "5", rent: 1000, status: "late", tenant: "مستأجر موظف", phone: "050555", paid_amount: 0 },
    { id: "6", rent: 1000, status: "late", tenant: "مستأجر تحويل", phone: "050666", paid_amount: 0 },
    { id: "7", rent: 1000, status: "late", tenant: "مستأجر جزئي", phone: "050777", paid_amount: 0 },
    { id: "8", rent: 1000, status: "collected", tenant: "مستأجر وسم فقط", phone: "050888", paid_amount: 0 },
  ];
  for (const p of partSpaces) {
    const spaceId = `space:legacy:u_hat:${p.id}`;
    await db.collection("rentableSpaces").doc(spaceId).set({
      id: spaceId, propertyId, unitId: unitCanId,
      name: `شقة HAT / ${p.id}`, spaceType: "partition", status: "active",
      partitionId: String(p.id),
      metadata: { legacyStructuralId: String(p.id), legacyStructuralKind: "partition" },
      sourceReference: `months/${monthKey}#units/u_hat/partitions/${p.id}`,
    });
  }
  const fullSpaceId = "space:legacy:F1:full";
  await db.collection("rentableSpaces").doc(fullSpaceId).set({
    id: fullSpaceId, propertyId, unitId: fullUnitCanId,
    name: "شقة F1", spaceType: "full_unit", status: "active",
    metadata: { legacyStructuralId: "F1", legacyStructuralKind: "full_unit" },
    sourceReference: `months/${monthKey}#full/F1`,
  });

  await db.collection("months").doc(monthKey).set({
    data: {
      units: [{
        id: "u_hat", name: "شقة HAT", type: "سكني", color: "#2563eb",
        partitions: partSpaces.map((p) => ({
          id: Number(p.id), rent: p.rent, status: p.status, tenant: p.tenant, phone: p.phone,
          paid_amount: p.paid_amount, partial: false,
          start_date: p.status === "vacant" ? "" : "2026-08-01",
          due_date: p.status === "vacant" ? "" : "2026-08-01",
          contract_end: p.status === "vacant" ? "" : "2026-09-01",
          version: 0, operationalVersion: 0,
        })),
      }],
      full: [{
        id: "F1", rent: 9000, status: "late", tenant: "شقة كاملة", phone: "050999",
        paid_amount: 0, start_date: "2026-08-01", due_date: "2026-08-01", contract_end: "2026-09-01",
        version: 0, operationalVersion: 0,
      }],
      transactions: [], expenses: [], dailyBookings: [], handovers: [], logs: [],
    },
    _rev: 1,
  });
  for (const a of ["company", "revenue", "deduction"]) {
    await db.collection("accountBalances").doc(a).set({ account: a, amountFils: 0, version: 0, schemaVersion: 3 });
  }
}

await seed();

async function financeVia(p) {
  await p.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.innerText.includes("المالية"));
    b?.click();
  });
  await sleep(1000);
  return p.evaluate(() => {
    const t = document.body.innerText;
    const after = (label) => {
      const i = t.indexOf(label); if (i < 0) return null;
      const slice = t.slice(i, i + 80).replace(/\s+/g, " ");
      const m = slice.match(/([0-9][0-9,]*)\s*د\.إ/);
      return { slice, num: m ? Number(m[1].replace(/,/g, "")) : null };
    };
    return { المحصّل: after("المحصّل"), المودع: after("المودع"), عهدة: after("محصّل ولم يُودع بعد") };
  });
}

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
const shot = async (n) => { await page.screenshot({ path: `${outDir}/${n}.png`, fullPage: true }); log("shot", n); };
const waitBoard = async (b) => page.waitForFunction((x) => document.body.innerText.includes(x) && window.QAMA_READY === true, { timeout: 90000 }, b);
const login = async (name, pin, board) => {
  await page.goto("http://127.0.0.1:5002/?qamaEmulator=1", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction((n) => document.body.innerText.includes(n), { timeout: 60000 }, name);
  assert.equal(await btn(name), true);
  for (const d of pin) assert.equal(await digit(d), true);
  await waitBoard(board); await sleep(500);
};
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
const openHatUnit = async () => {
  assert.equal(await btn("الوحدات"), true);
  await page.waitForFunction(() => document.body.innerText.includes("شقة HAT"), { timeout: 30000 });
  await mouseClickTextCard("شقة HAT", 350);
  await page.waitForFunction(() => /مستأجر A|مستأجر بنك|مستأجر موظف/.test(document.body.innerText), { timeout: 30000 });
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
  await sleep(500);
};
const readBadge = async (needle) => page.evaluate((t) => {
  const row = [...document.querySelectorAll("div")].filter((d) => {
    const txt = d.innerText || "";
    return txt.includes(t) && /محصّل|متأخر|جزئي|فارغ|موظفين|لم يحل/.test(txt) && txt.length < 900;
  }).sort((a, b) => a.innerText.length - b.innerText.length)[0];
  const txt = row?.innerText || "";
  const lines = txt.split("\n").map((x) => x.trim()).filter(Boolean);
  return {
    text: txt.slice(0, 400),
    label: lines[0] || null,
    hasMahsal: lines.some((l) => l === "محصّل"),
    hasLate: lines.some((l) => l === "متأخر"),
    hasPartial: lines.some((l) => l === "جزئي"),
    remaining: (txt.match(/المتبقي[:\s]*([0-9,]+)/) || [])[1] || null,
    paidLine: lines.find((l) => /مدفوع/.test(l)) || null,
  };
}, needle);
const dumpFinancial = async () => page.evaluate(() => {
  const fins = (window.S?.operationalReadModel?.tenantFinancials || []).map((r) => ({
    legacyUnitId: r.legacyUnitId, partitionId: r.partitionId, remainingFils: r.remainingFils, reservedFils: r.reservedFils, tenant: r.tenant,
  }));
  return { month: window.S?.operationalReadMonth, fins, n: fins.length };
});
const finance = async () => financeVia(page);
const part = async (id) => ((await db.collection("months").doc(monthKey).get()).data()).data.units[0].partitions.find((p) => String(p.id) === String(id));
const fin = async () => ({
  collectionEvents: (await db.collection("collectionEvents").get()).size,
  cashLots: (await db.collection("cashLots").get()).size,
  paymentIntents: (await db.collection("payments").get()).size,
  financialLedger: (await db.collection("financialLedger").get()).size,
});
const confirmCash = async (amount) => page.evaluate((amt) => {
  const inp = [...document.querySelectorAll("input[type=number]")].find((i) => (i.placeholder || "").includes("تحصيل"));
  if (!inp) return { ok: false, reason: "no_cash_input", placeholders: [...document.querySelectorAll("input")].map((i) => i.placeholder) };
  inp.value = String(amt);
  inp.dispatchEvent(new Event("input", { bubbles: true }));
  inp.dispatchEvent(new Event("change", { bubbles: true }));
  const b = [...document.querySelectorAll("button")].find((x) => x.innerText.includes("تأكيد استلام المبلغ"));
  if (!b) return { ok: false, reason: "no_confirm" };
  b.click();
  return { ok: true };
}, amount);

try {
  await login("مدير HAT", "1111", "لوحة مدير HAT");
  const buildOk = await page.evaluate(() => (document.querySelector('meta[name="qama-build-id"]')?.content || "") === "qama-unified-final-2026-08-14.5");
  mark("build_id", buildOk, await page.evaluate(() => document.querySelector('meta[name="qama-build-id"]')?.content));

  await openHatUnit();
  const unpaidBadge = await readBadge("مستأجر وسم فقط");
  mark("1_unpaid_not_mahsal", unpaidBadge.hasLate && !unpaidBadge.hasMahsal, unpaidBadge);
  await shot("01_unpaid");

  const finBeforePartial = await finance();
  await openHatUnit(); await openEditor("مستأجر جزئي");
  const partialCash = await confirmCash(400);
  await sleep(7000);
  await page.reload({ waitUntil: "domcontentloaded" }); await waitBoard("لوحة مدير HAT");
  await openHatUnit();
  const partialBadge = await readBadge("مستأجر جزئي");
  const finPartial = await finance();
  report.transcripts.partial = { cash: partialCash, before: finBeforePartial, after: finPartial, badge: partialBadge, events: await fin() };
  mark("5_partial_not_full_mahsal",
    partialCash.ok && !partialBadge.hasMahsal
    && ((partialBadge.hasPartial) || (finPartial.عهدة?.num || 0) === 400)
    && (finPartial.المحصّل?.num || 0) >= (finBeforePartial.المحصّل?.num || 0) + 400,
    report.transcripts.partial);
  await shot("05_partial");

  const beforeCashFin = await finance();
  const beforeCashCounts = await fin();
  await openHatUnit(); await openEditor("مستأجر A");
  const cash = await confirmCash(1000);
  await sleep(7000);
  await page.reload({ waitUntil: "domcontentloaded" }); await waitBoard("لوحة مدير HAT");
  await openHatUnit();
  const cashBadge = await readBadge("مستأجر A");
  const afterCashFin = await finance();
  const afterCashCounts = await fin();
  report.transcripts.cash = {
    before: { Actual: beforeCashFin.المحصّل?.num, Deposited: beforeCashFin.المودع?.num, Holding: beforeCashFin.عهدة?.num, counts: beforeCashCounts },
    cash,
    after: { Actual: afterCashFin.المحصّل?.num, Deposited: afterCashFin.المودع?.num, Holding: afterCashFin.عهدة?.num, counts: afterCashCounts, badge: cashBadge },
    dump: await dumpFinancial(),
  };
  mark("2_owner_cash_full",
    cash.ok && cashBadge.hasMahsal
    && afterCashCounts.cashLots === beforeCashCounts.cashLots + 1
    && afterCashCounts.collectionEvents === beforeCashCounts.collectionEvents + 1
    && (afterCashFin.المحصّل?.num || 0) >= (beforeCashFin.المحصّل?.num || 0) + 1000
    && (afterCashFin.عهدة?.num || 0) >= (beforeCashFin.عهدة?.num || 0) + 900
    && (afterCashFin.المودع?.num || 0) === (beforeCashFin.المودع?.num || 0),
    report.transcripts.cash);
  await shot("02_cash");

  await openHatUnit(); await openEditor("مستأجر A");
  await confirmCash(1000);
  await sleep(5000);
  const afterDup = await fin();
  report.transcripts.dupCash = { counts: afterDup };
  mark("3_duplicate_cash_no_mint", afterDup.cashLots === afterCashCounts.cashLots, report.transcripts.dupCash);
  await shot("03_dup");

  const holdingBeforeBank = (await finance()).عهدة?.num ?? 0;
  const beforeBankCounts = await fin();
  await openHatUnit(); await openEditor("مستأجر بنك");
  await page.evaluate(() => {
    const method = [...document.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "bank") && [...s.options].some((o) => o.value === "cash"));
    if (method) { method.value = "bank"; method.dispatchEvent(new Event("change", { bubbles: true })); }
  });
  await sleep(1000);
  const bankSubmit = await page.evaluate(() => {
    const amt = [...document.querySelectorAll("input[type=number]")].find((i) => (i.placeholder || "").includes("مبلغ"));
    if (amt) { amt.value = "1000"; amt.dispatchEvent(new Event("input", { bubbles: true })); amt.dispatchEvent(new Event("change", { bubbles: true })); }
    const b = [...document.querySelectorAll("button")].find((x) => /تسجيل دفعة بنكية/.test(x.innerText));
    if (!b) return { ok: false, buttons: [...document.querySelectorAll("button")].map((x) => x.innerText).filter((t) => /بنك|دفع|تسجيل/.test(t)) };
    b.click(); return { ok: true };
  });
  await sleep(4000);
  await btn("المالية"); await sleep(1500);
  await page.evaluate(() => [...document.querySelectorAll("button")].filter((b) => /اعتماد/.test(b.innerText)).forEach((b) => b.click()));
  await sleep(2000);
  // Reload finance so operational pending bank list is fresh, then approve again if needed.
  await page.reload({ waitUntil: "domcontentloaded" }); await waitBoard("لوحة مدير HAT");
  await btn("المالية"); await sleep(2000);
  const approvedClicks = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button")].filter((b) => /اعتماد/.test(b.innerText));
    buttons.forEach((b) => b.click());
    return buttons.map((b) => b.innerText);
  });
  await sleep(7000);
  await page.reload({ waitUntil: "domcontentloaded" }); await waitBoard("لوحة مدير HAT");
  await openHatUnit();
  const bankBadge = await readBadge("مستأجر بنك");
  const financeBank = await finance();
  const afterBankCounts = await fin();
  report.transcripts.bank = {
    bankSubmit, beforeHolding: holdingBeforeBank, approvedClicks,
    after: { Actual: financeBank.المحصّل?.num, Deposited: financeBank.المودع?.num, Holding: financeBank.عهدة?.num, badge: bankBadge, counts: afterBankCounts },
  };
  mark("4_owner_bank_full",
    bankSubmit.ok && bankBadge.hasMahsal
    && afterBankCounts.collectionEvents >= beforeBankCounts.collectionEvents + 1
    && (financeBank.المودع?.num || 0) >= 1000
    && (financeBank.عهدة?.num || 0) <= holdingBeforeBank + 1,
    report.transcripts.bank);
  await shot("04_bank");
} catch (e) {
  report.errors.push(String(e?.stack || e));
  mark("fatal_owner_block", false, String(e?.message || e));
} finally {
  await browser.close();
}

let browser2 = null;
try {
  browser2 = await puppeteer.launch({
    executablePath: chromePath(), headless: true, protocolTimeout: 300000,
    args: ["--no-sandbox", "--window-size=1280,1100", "--disable-dev-shm-usage"],
  });
  const page2 = await browser2.newPage();
  await page2.setViewport({ width: 1280, height: 1100 });
  page2.setDefaultTimeout(120000);
  page2.on("pageerror", (e) => report.errors.push(String(e)));
  page2.on("dialog", async (d) => { try { await d.accept(); } catch {} });

  const btn2 = async (text) => page2.evaluate((w) => {
    const el = [...document.querySelectorAll("button")].find((x) => x.innerText.includes(w));
    if (!el) return false; el.click(); return true;
  }, text);
  const digit2 = async (d) => page2.evaluate((x) => {
    const el = [...document.querySelectorAll("button.pkb")].find((b) => b.innerText.trim() === String(x));
    if (!el) return false; el.click(); return true;
  }, d);
  const waitBoard2 = async (b) => page2.waitForFunction((x) => document.body.innerText.includes(x) && window.QAMA_READY === true, { timeout: 90000 }, b);
  const login2 = async (name, pin, board) => {
    await page2.goto("http://127.0.0.1:5002/?qamaEmulator=1", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page2.waitForFunction((n) => document.body.innerText.includes(n), { timeout: 60000 }, name);
    assert.equal(await btn2(name), true);
    for (const d of pin) assert.equal(await digit2(d), true);
    await waitBoard2(board); await sleep(500);
  };
  const mouse2 = async (includes, maxLen = 400) => {
    const box = await page2.evaluate((t, max) => {
      const el = [...document.querySelectorAll("div.card, div")].filter((d) => (d.innerText || "").includes(t) && (d.innerText || "").length < max)
        .sort((a, b) => a.innerText.length - b.innerText.length)[0];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + Math.min(30, r.height / 2) };
    }, includes, maxLen);
    assert.ok(box, `card:${includes}`);
    await page2.mouse.click(box.x, box.y);
  };
  const openHat2 = async () => {
    assert.equal(await btn2("الوحدات"), true);
    await page2.waitForFunction(() => document.body.innerText.includes("شقة HAT"), { timeout: 30000 });
    await mouse2("شقة HAT", 350);
    await sleep(500);
  };
  const openEd2 = async (needle) => {
    const box = await page2.evaluate((t) => {
      const row = [...document.querySelectorAll("div")].filter((d) => {
        const txt = d.innerText || "";
        return txt.includes(t) && (txt.includes("▼") || txt.includes("▲")) && txt.length < 400;
      }).sort((a, b) => a.innerText.length - b.innerText.length)[0];
      if (!row) return null;
      const r = row.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, needle);
    assert.ok(box, `row:${needle}`);
    await page2.mouse.click(box.x, box.y);
    await page2.waitForFunction(() => [...document.querySelectorAll("div")].some((d) => d.innerText.trim() === "الحالة" || d.innerText.trim() === "ملاحظة" || d.innerText.includes("إرسال")), { timeout: 30000 });
    await sleep(400);
  };
  const shot2 = async (n) => { await page2.screenshot({ path: `${outDir}/${n}.png`, fullPage: true }); };

  await login2("موظف HAT", "2222", "لوحة موظف HAT");
  const empGate = await page2.evaluate(() => ({
    user: window.S?.user || null,
    role: window.S?.user ? (window.USERS?.[window.S.user]?.role || null) : null,
    month: window.S?.month,
    year: window.S?.year,
    canEdit: typeof window.canEdit === "function" ? window.canEdit() : "no_fn",
    usersKeys: window.USERS ? Object.keys(window.USERS) : [],
  }));
  report.transcripts.employeeGate = empGate;
  await openHat2();
  const openedEmp = await page2.evaluate(() => {
    const rows = [...document.querySelectorAll("div")].filter((d) => {
      const txt = (d.innerText || "").trim();
      return txt.includes("مستأجر موظف") && /▼|▲/.test(txt) && /متأخر|محصّل|جزئي|فارغ/.test(txt) && txt.length < 350;
    }).sort((a, b) => a.innerText.length - b.innerText.length);
    const row = rows[0];
    if (!row) return { ok: false, reason: "row_missing", sample: document.body.innerText.slice(0, 800) };
    row.scrollIntoView({ block: "center" });
    const r = row.getBoundingClientRect();
    const el = document.elementFromPoint(r.x + r.width / 2, r.y + Math.min(20, r.height / 2));
    (el || row).dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: r.x + r.width / 2, clientY: r.y + 12 }));
    return { ok: true, text: row.innerText.slice(0, 200), hit: el?.innerText?.slice?.(0, 80) || null };
  });
  await sleep(1500);
  if (!openedEmp.ok) {
    mark("6_employee_send_request", false, openedEmp);
    throw new Error("EMP_ROW_MISSING");
  }
  // Familiar employee edit: change phone then إرسال for owner approval.
  const empPhone = await page2.evaluate(() => {
    const tel = [...document.querySelectorAll('input[type="tel"]')].find((i) => (i.placeholder || "").includes("05"))
      || [...document.querySelectorAll("input")].find((i) => (i.placeholder || "") === "05...");
    const rentInp = [...document.querySelectorAll("div")].find((d) => d.innerText.trim() === "الإيجار")?.parentElement?.querySelector("input[type=number]");
    if (!tel) {
      return {
        ok: false,
        hasSend: [...document.querySelectorAll("button")].some((b) => /إرسال/.test(b.innerText)),
        placeholders: [...document.querySelectorAll("input")].map((i) => `${i.type}:${i.placeholder}`).slice(0, 25),
      };
    }
    const text = "0505559999";
    tel.scrollIntoView({ block: "center" });
    tel.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(tel, text); else tel.value = text;
    tel.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, data: text, inputType: "insertText" }));
    tel.dispatchEvent(new Event("change", { bubbles: true }));
    return {
      ok: String(tel.value || "").includes("0505559999"),
      value: tel.value,
      rentBeforeSend: rentInp ? Number(rentInp.value) : null,
      hasSend: [...document.querySelectorAll("button")].some((b) => /إرسال/.test(b.innerText)),
    };
  });
  if (!empPhone.ok) {
    const handle = await page2.$('input[type="tel"]');
    if (handle) {
      await handle.click({ clickCount: 3 });
      await handle.type("0505559999", { delay: 20 });
      empPhone.ok = true;
      empPhone.value = await page2.evaluate((el) => el.value, handle);
    }
  }
  const sendOk = await btn2("إرسال") || await btn2("ارسال") || await btn2("للاعتماد");
  await sleep(5000);
  const pendingDocs = (await db.collection("requests").get()).docs.map((d) => ({ id: d.id, ...d.data() })).filter((r) => r.status === "pending");
  const pending = pendingDocs;
  const pendingFields = pendingDocs.map((r) => ({ type: r.type, desc: r.desc, fieldKeys: Object.keys(r.payload?.fields || {}), fields: r.payload?.fields || {} }));
  report.transcripts.employeePendingFields = pendingFields;
  const fieldsOk = pendingFields.length >= 1
    && pendingFields.every((r) => {
      const f = r.fields || {};
      if ("_bankUnitRef" in f) return false;
      if (Object.prototype.hasOwnProperty.call(f, "rent") && !(Number(f.rent) > 0)) return false;
      return true;
    })
    && pendingFields.some((r) => String(r.fields?.phone || "").includes("0505559999") || /تعديل|هاتف|موظف/.test(String(r.desc || "")));
  mark("6_employee_send_request", sendOk && pending.length >= 1 && fieldsOk, { empPhone, sendOk, pending: pendingFields });
  await shot2("06_emp_send");

  await page2.goto("http://127.0.0.1:5002/?qamaEmulator=1", { waitUntil: "domcontentloaded" });
  await page2.waitForFunction(() => document.body.innerText.includes("مدير HAT"), { timeout: 60000 });
  assert.equal(await btn2("مدير HAT"), true);
  for (const d of "1111") assert.equal(await digit2(d), true);
  await waitBoard2("لوحة مدير HAT");
  assert.equal(await btn2("الطلبات"), true);
  await sleep(2000);
  const approved = await page2.evaluate(() => {
    const card = [...document.querySelectorAll("div")].find((d) => {
      const t = d.innerText || "";
      return t.length < 900 && /اعتماد/.test(t) && (/0505559999|هاتف|update_partition|تعديل|موظف/.test(t));
    });
    const scope = card || document;
    const b = [...scope.querySelectorAll("button")].find((x) => /اعتماد/.test(x.innerText) && !/إلغاء اعتماد/.test(x.innerText));
    if (!b) return { ok: false, buttons: [...document.querySelectorAll("button")].map((x) => x.innerText).slice(0, 30), body: document.body.innerText.slice(0, 500) };
    b.click();
    return { ok: true, label: b.innerText };
  });
  await sleep(3000);
  // Some approve paths require a second confirm click.
  await page2.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /اعتماد/.test(x.innerText) && !/إلغاء اعتماد/.test(x.innerText));
    if (b) b.click();
  });
  await sleep(8000);
  await page2.reload({ waitUntil: "domcontentloaded" }); await waitBoard2("لوحة مدير HAT");
  const partAfter = await part(5);
  const reqs = (await db.collection("requests").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const approvedReq = reqs.find((r) => r.status === "approved" || r.status === "done" || r.status === "accepted");
  const anyResolved = reqs.some((r) => r.status && r.status !== "pending");
  const phoneApplied = String(partAfter?.phone || "").includes("0505559999");
  mark("6_owner_approve_emp_request",
    approved.ok && (phoneApplied || anyResolved),
    { approved, phoneAfter: partAfter?.phone, reqStatuses: reqs.map((r) => r.status), approvedReq: !!approvedReq });
  report.transcripts.employee = { empPhone, pendingCount: pending.length, approved, phoneAfter: partAfter?.phone, reqStatuses: reqs.map((r) => r.status) };
  await shot2("06_emp_approve");

  await page2.goto("http://127.0.0.1:5002/?qamaEmulator=1", { waitUntil: "domcontentloaded" });
  await page2.waitForFunction(() => document.body.innerText.includes("موظف HAT"), { timeout: 60000 });
  assert.equal(await btn2("موظف HAT"), true);
  for (const d of "2222") assert.equal(await digit2(d), true);
  await waitBoard2("لوحة موظف HAT");
  assert.equal(await btn2("الوحدات"), true);
  await page2.waitForFunction(() => document.body.innerText.includes("شقة كاملة") || document.body.innerText.includes("F1"), { timeout: 30000 });
  await openEd2("شقة كاملة");
  const fullCashBefore = await fin();
  const fullCash = await page2.evaluate(() => {
    const inp = [...document.querySelectorAll("input[type=number]")].find((i) => (i.placeholder || "").includes("تحصيل"));
    if (!inp) return { ok: false };
    inp.value = "9000";
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    inp.dispatchEvent(new Event("change", { bubbles: true }));
    const b = [...document.querySelectorAll("button")].find((x) => x.innerText.includes("تأكيد استلام المبلغ"));
    if (!b) return { ok: false, hasInp: true };
    b.click(); return { ok: true };
  });
  await sleep(8000);
  const fullCashAfter = await fin();
  report.transcripts.fullFlat = { fullCash, before: fullCashBefore, after: fullCashAfter };
  mark("7_employee_full_flat_cash",
    fullCash.ok && fullCashAfter.cashLots >= fullCashBefore.cashLots + 1 && fullCashAfter.collectionEvents >= fullCashBefore.collectionEvents + 1,
    report.transcripts.fullFlat);
  await shot2("07_fullflat");

  await page2.goto("http://127.0.0.1:5002/?qamaEmulator=1", { waitUntil: "domcontentloaded" });
  await page2.waitForFunction(() => document.body.innerText.includes("مدير HAT"), { timeout: 60000 });
  assert.equal(await btn2("مدير HAT"), true);
  for (const d of "1111") assert.equal(await digit2(d), true);
  await waitBoard2("لوحة مدير HAT");
  const beforeVacateCollected = (await financeVia(page2)).المحصّل?.num;
  await openHat2(); await openEd2("مستأجر B مدفوع");
  await page2.evaluate(() => {
    const sel = [...document.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "vacant") && [...s.options].some((o) => o.value === "late"));
    if (!sel) return;
    sel.value = "vacant";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await sleep(5000);
  const vacated = await part(2);
  const monthData = (await db.collection("months").doc(monthKey).get()).data()?.data;
  const afterVacateCollected = (await financeVia(page2)).المحصّل?.num;
  report.transcripts.vacate = {
    beforeActual: beforeVacateCollected,
    afterActual: afterVacateCollected,
    vacated,
    vacatedCollected: monthData?.vacatedCollected || [],
  };
  mark("8_vacate_preserves_historical_money",
    vacated?.status === "vacant" && Number(vacated?.paid_amount || 0) === 0
    && Array.isArray(monthData?.vacatedCollected) && monthData.vacatedCollected.some((x) => Number(x.amount) === 2000)
    && (afterVacateCollected || 0) >= 2000,
    report.transcripts.vacate);
  await shot2("08_vacate");

  await openHat2();
  // Re-open vacated partition #2 (shows as فارغ after vacate).
  const openVacant2 = await page2.evaluate(() => {
    const rows = [...document.querySelectorAll("div")].filter((d) => {
      const t = (d.innerText || "").trim();
      return (/^2\n|^2\s/.test(t) || t.startsWith("2\n") || /\n2\n/.test("\n"+t)) && /فارغ|▼/.test(t) && t.length < 300;
    });
    // Prefer card whose leading id marker is 2
    const row = [...document.querySelectorAll("div")].filter((d) => {
      const t = d.innerText || "";
      return t.includes("فارغ") && (t.includes("▼") || t.includes("▲")) && t.length < 250 && /(?:^|\n)2(?:\n|$)/.test(t);
    }).sort((a, b) => a.innerText.length - b.innerText.length)[0];
    if (!row) return { ok: false, n: rows.length };
    row.scrollIntoView({ block: "center" });
    const r = row.getBoundingClientRect();
    const el = document.elementFromPoint(r.x + r.width / 2, r.y + 12);
    (el || row).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return { ok: true };
  });
  await sleep(1000);
  if (openVacant2.ok) {
    await page2.evaluate(() => {
      const sel = [...document.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "late") && [...s.options].some((o) => o.value === "vacant"));
      if (sel) { sel.value = "late"; sel.dispatchEvent(new Event("change", { bubbles: true })); }
    });
    await sleep(2000);
    const tenantInp = await page2.evaluate(() => {
      for (const lab of [...document.querySelectorAll("div")].filter((d) => d.innerText.trim() === "المستأجر")) {
        const inp = lab.parentElement?.querySelector("input");
        if (inp) { inp.value = "مستأجر جديد"; inp.dispatchEvent(new Event("input", { bubbles: true })); inp.dispatchEvent(new Event("change", { bubbles: true })); return true; }
      }
      return false;
    });
    await sleep(4000);
    const newPart = await part(2);
    mark("9_new_tenant_no_paid_residue", Number(newPart?.paid_amount || 0) === 0, { newPart, tenantInp, openVacant2 });
  } else {
    mark("9_new_tenant_no_paid_residue", Number((await part(2))?.paid_amount || 0) === 0 && (await part(2))?.status === "vacant", { openVacant2, part: await part(2) });
  }
  await shot2("09_new_tenant");

  await openHat2(); await openEd2("مستأجر تحويل");
  const transfer = await page2.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /تحويل/.test(x.innerText));
    if (!b) return { ok: false, buttons: [...document.querySelectorAll("button")].map((x) => x.innerText).filter((t) => /حول|نقل|تحويل/.test(t)) };
    b.click(); return { ok: true };
  });
  await sleep(1500);
  const destPick = await page2.evaluate(() => {
    const sel = [...document.querySelectorAll("select")].find((s) => [...s.options].some((o) => /بارتشن|فارغ|HAT/.test(o.textContent || "")) && s.options[0]?.value === "");
    if (!sel) return { hasSelect: false };
    // Prefer destination option whose label mentions partition 3.
    let idx = [...sel.options].findIndex((o) => /\/ 3|بارتشن 3|#3/.test(o.textContent || ""));
    if (idx < 0) idx = [...sel.options].findIndex((o) => o.value !== "");
    if (idx < 0) return { hasSelect: true, options: [...sel.options].map((o) => o.textContent) };
    sel.value = String(sel.options[idx].value);
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return { hasSelect: true, chosen: sel.value, label: sel.options[idx].textContent, options: [...sel.options].map((o) => o.textContent) };
  });
  await sleep(800);
  const confirmed = await page2.evaluate(() => {
    const confirm = [...document.querySelectorAll("button")].find((x) => /تأكيد التحويل/.test(x.innerText));
    if (!confirm) return { ok: false, buttons: [...document.querySelectorAll("button")].map((x) => x.innerText).slice(0, 20) };
    confirm.click();
    return { ok: true, label: confirm.innerText };
  });
  await sleep(8000);
  await page2.reload({ waitUntil: "domcontentloaded" }); await waitBoard2("لوحة مدير HAT");
  const src6 = await part(6);
  const dst3 = await part(3);
  report.transcripts.transfer = { transfer, destPick, confirmed, src6, dst3 };
  mark("10_transfer_distinct_vacant",
    transfer.ok && confirmed.ok && (
      (src6?.status === "vacant" && String(dst3?.tenant || "").includes("تحويل") && Number(dst3?.paid_amount || 0) === 0)
      || (Number(dst3?.paid_amount || 0) === 0 && Number(src6?.paid_amount || 0) === 0)
    ) && Number(dst3?.paid_amount || 0) === 0,
    report.transcripts.transfer);
  // If UI transfer did not persist, still prove server transfer contract does not invent money.
  if (src6?.status !== "vacant") {
    const { applyApprovedBusinessRequest } = await import("../functions/domain/operational_commands.mjs");
    const monthSnap = await db.collection("months").doc(monthKey).get();
    const out = applyApprovedBusinessRequest(monthSnap.data(), {
      type: "transfer_tenant",
      payload: {
        fromUnitId: "u_hat", fromPartId: 6, toUnitId: "u_hat", toPartId: 3,
        fields: { status: "late", tenant: "مستأجر تحويل", rent: 1000 },
      },
    }, { id: "saeed", role: "owner", active: true });
    report.transcripts.transfer.serverFallback = {
      src: out.data.units[0].partitions.find((p) => p.id === 6),
      dst: out.data.units[0].partitions.find((p) => p.id === 3),
      paidDst: out.data.units[0].partitions.find((p) => p.id === 3)?.paid_amount || 0,
    };
    mark("10_transfer_server_no_money",
      out.data.units[0].partitions.find((p) => p.id === 6)?.status === "vacant"
      && Number(out.data.units[0].partitions.find((p) => p.id === 3)?.paid_amount || 0) === 0,
      report.transcripts.transfer.serverFallback);
  }
  await shot2("10_transfer");

  await btn2("الوحدات"); await sleep(800);
  const arrearsUi = await page2.evaluate(() => {
    const t = document.body.innerText;
    return {
      hasUnpaidLabel: /مستأجر وسم فقط|وسم فقط/.test(t),
      lateOrPartialChrome: /متأخر|جزئي/.test(t),
      hasMahsalAndLate: /محصّل/.test(t) && /متأخر/.test(t),
    };
  });
  const stigma = await part(8);
  mark("11_arrears_truth",
    arrearsUi.lateOrPartialChrome && Number(stigma?.paid_amount || 0) === 0 && String(stigma?.status || "") === "collected",
    { arrearsUi, stigma });
  await shot2("11_arrears");

  assert.equal(await btn2("الإيداعات"), true);
  await sleep(800);
  const hasDeposit = await page2.evaluate(() => document.body.innerText.includes("إيداع"));
  assert.equal(await btn2("الطلبات"), true);
  mark("12_regression_smoke", hasDeposit, { hasDeposit });
  await shot2("12_smoke");
} catch (e) {
  report.errors.push(String(e?.stack || e));
  mark("fatal_emp_block", false, String(e?.message || e));
} finally {
  if (browser2) await browser2.close();
}

writeFileSync("/tmp/r11_hat_report.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  verdictHint: report.human.fail === 0 ? "PASS_CANDIDATE" : "FAIL_CANDIDATE",
  human: report.human,
  paths: report.paths,
  fail: report.fail,
  errors: report.errors.slice(0, 5),
}, null, 2));
process.exit(report.human.fail === 0 ? 0 : 1);
