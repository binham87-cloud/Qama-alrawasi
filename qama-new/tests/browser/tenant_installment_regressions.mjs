/**
 * Regression: tenant required before collect; deposit from holding; installment schedule persists.
 * Emulator only. Real UI clicks — engine/Firestore reads are verification-only.
 *
 *   firebase emulators:exec --project qama-new-prod-2026 \
 *     --only firestore,auth,functions,hosting \
 *     "node seed/seed_bridge_ui.mjs && node tests/browser/tenant_installment_regressions.mjs"
 */
import puppeteer from "puppeteer-core";
import { initializeApp, getApps, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOST = process.env.FIREBASE_HOSTING_EMULATOR_HOST || "127.0.0.1:5000";
const PROJECT = process.env.GCLOUD_PROJECT || "qama-new-prod-2026";
const HERE = dirname(fileURLToPath(import.meta.url));
const ART = resolve(HERE, "../../artifacts/investigation-2026-09-05");
mkdirSync(ART, { recursive: true });

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error("BLOCKED: need emulator");
  process.exit(2);
}
while (getApps().length) await deleteApp(getApps()[0]);
initializeApp({ projectId: PROJECT });
const db = getFirestore();
const results = [];
function rec(name, status, detail = "") {
  results.push({ name, status, detail: String(detail).slice(0, 500) });
  console.log(`${status}\t${name}${detail ? " — " + detail : ""}`);
}

async function sleep(ms) { await new Promise((r) => setTimeout(r, ms)); }

async function markSave(page) {
  return page.evaluate(() => {
    const t = window.__qamaSaveState || window.__qamaTest?.authState?.() || {};
    return { seq: t.saveOpSeq || 0, id: t.saveOpId || 0, done: t.saveOpDoneId || 0 };
  });
}

async function waitOnline(page, ms = 45000, before = null) {
  const b = before || await markSave(page);
  await page.waitForFunction((prev) => {
    const t = window.__qamaSaveState || window.__qamaTest?.authState?.() || {};
    const done = Number(t.saveOpDoneId || 0);
    if (done > prev.done && t.saveOpStatus === "fail") return "fail";
    return done > prev.done && t.saveOpStatus === "ok";
  }, { timeout: ms }, b);
  const st = await page.evaluate(() => (window.__qamaSaveState || window.__qamaTest?.authState?.() || {}).saveOpStatus || "");
  if (st === "fail") throw new Error("save failed (op status fail)");
}

async function typeTestIdSave(page, id, value) {
  const b = await markSave(page);
  await typeTestId(page, id, value);
  await waitOnline(page, 45000, b);
}

async function selectTestIdSave(page, id, value) {
  const b = await markSave(page);
  await selectTestId(page, id, value);
  await waitOnline(page, 45000, b);
}

async function pinLogin(page, who, pin) {
  await page.goto(`http://${HOST}/`, { waitUntil: "networkidle0" });
  await page.evaluate((label) => {
    const btn = [...document.querySelectorAll("button")].find((n) => (n.textContent || "").includes(label));
    if (!btn) throw new Error("no " + label);
    btn.click();
  }, who);
  await page.waitForFunction(() => /أدخل الرقم السري/.test(document.body.innerText), { timeout: 8000 });
  for (const d of pin) {
    await page.evaluate((digit) => {
      const b = [...document.querySelectorAll("button.pkb,button")].find((x) => (x.textContent || "").trim() === digit);
      b?.click();
    }, d);
    await sleep(80);
  }
  // Cold emulator load + dashboard hydrate often exceeds 15s; keep bound to authState.
  await page.waitForFunction(() => {
    const t = window.__qamaTest?.authState?.();
    return t && t.screen === "app" && t.user && t.hasDash && !t.loading;
  }, { timeout: 90000 });
}

async function clickTestId(page, id) {
  await page.waitForSelector(`[data-testid="${id}"]`, { timeout: 15000 });
  await page.evaluate((tid) => {
    const el = document.querySelector(`[data-testid="${tid}"]`);
    if (!el) throw new Error("missing " + tid);
    el.click();
  }, id);
}

async function selectTestId(page, id, value) {
  await page.waitForSelector(`[data-testid="${id}"]`, { timeout: 15000 });
  await page.evaluate((tid, val) => {
    const el = document.querySelector(`[data-testid="${tid}"]`);
    if (!el) throw new Error("missing " + tid);
    el.value = val;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, id, value);
}

async function typeTestId(page, id, value) {
  await page.waitForSelector(`[data-testid="${id}"]`, { timeout: 15000 });
  await page.evaluate((tid, val) => {
    const el = document.querySelector(`[data-testid="${tid}"]`);
    if (!el) throw new Error("missing " + tid);
    el.focus();
    el.value = String(val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, id, value);
}

async function kpi() {
  const receipts = (await db.collection("receipts").get()).docs.map((d) => d.data());
  const deposits = (await db.collection("deposits").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const liveCash = receipts.filter((r) => r.state === "recognized" && r.method === "cash")
    .reduce((s, r) => s + Number(r.amountFils || 0), 0);
  const apprDep = deposits.filter((d) => d.state === "approved")
    .reduce((s, r) => s + Number(r.amountFils || 0), 0);
  return {
    liveCash,
    liveReceipts: receipts.filter((r) => r.state === "recognized").length,
    holding: liveCash - apprDep,
    apprDep,
    deposits,
  };
}

async function waitHolding(targetFils, timeoutMs = 25000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = await kpi();
    if (last.holding === targetFils) return last;
    await sleep(400);
  }
  return last;
}

async function openVacantPartition(page) {
  await clickTestId(page, "tab-units");
  await sleep(400);
  await page.waitForSelector('[data-testid="unit-card"]', { timeout: 15000 });
  await page.click('[data-testid="unit-card"]');
  await sleep(500);
  const clicked = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-testid="partition-card"]')];
    const vacant = cards.find((c) => /فارغ/.test(c.innerText)) || cards.find((c) => c.getAttribute("data-part-id") === "2") || cards[cards.length - 1];
    if (!vacant) return null;
    vacant.querySelector('[data-testid="partition-expand"]')?.click();
    return vacant.getAttribute("data-part-id");
  });
  if (!clicked) throw new Error("no vacant partition");
  await page.waitForSelector('[data-testid="partition-status"]', { timeout: 10000 });
  return clicked;
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
page.on("dialog", async (d) => { await d.accept(); });

try {
  await pinLogin(page, "مدير", "1325");

  // --- A: collect without tenant must NOT create receipt ---
  {
    const before = await kpi();
    await openVacantPartition(page);
    await typeTestId(page, "partition-rent", "1000");
    await waitOnline(page);
    await selectTestId(page, "partition-status", "collected");
    await sleep(800);
    const msg = await page.evaluate(() => window.__qamaTest?.authState?.()?.msg || "");
    const body = await page.evaluate(() => document.body.innerText);
    const stVal = await page.$eval('[data-testid="partition-status"]', (el) => el.value).catch(() => "");
    const rentVal = await page.$eval('[data-testid="partition-rent"]', (el) => el.value).catch(() => "");
    const after = await kpi();
    const blocked = (/مستأجر/.test(msg) || /مستأجر/.test(body))
      && after.liveReceipts === before.liveReceipts
      && stVal !== "collected"
      && String(rentVal) === "1000";
    rec("UI block collect without tenant (draft rent kept)", blocked ? "PASS" : "FAIL",
      JSON.stringify({ msg: String(msg).slice(0, 100), stVal, rentVal, receiptsBefore: before.liveReceipts, after: after.liveReceipts }));
  }

  // --- A2: tenant rename (clear→newtype) must not vacate or reverse money ---
  {
    const before = await kpi();
    await typeTestId(page, "partition-tenant", "اسم قديم للتجربة");
    await waitOnline(page);
    await typeTestId(page, "partition-rent", "1000");
    await waitOnline(page);
    await selectTestId(page, "partition-status", "collected");
    await sleep(400);
    await page.waitForSelector('[data-testid="partition-collection-method"]', { timeout: 15000 });
    await selectTestId(page, "partition-collection-method", "cash");
    await waitOnline(page);
    const mid = await waitHolding(before.holding + 100000, 25000);
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="partition-tenant"]');
      el.focus();
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await sleep(300);
    await typeTestId(page, "partition-tenant", "اسم جديد بعد المسح");
    await waitOnline(page);
    const after = await kpi();
    const tenant = await page.$eval('[data-testid="partition-tenant"]', (el) => el.value);
    const st = await page.$eval('[data-testid="partition-status"]', (el) => el.value);
    const ok = after.holding === mid.holding
      && after.liveReceipts === mid.liveReceipts
      && tenant === "اسم جديد بعد المسح"
      && st === "collected";
    rec("Tenant rename (clear→newtype) keeps collect/holding", ok ? "PASS" : "FAIL",
      JSON.stringify({ holding: after.holding, midH: mid.holding, tenant, st, receipts: after.liveReceipts }));
  }

  // --- B: uncollect (late) then recollect cash → holding restored to +1000 from zero ---
  {
    const beforeUn = await kpi();
    await selectTestIdSave(page, "partition-status", "late");
    const afterUn = await waitHolding(0, 25000);
    const unOk = afterUn.holding === 0 && afterUn.liveReceipts === 0;
    rec("Uncollect after rename collect clears holding", unOk ? "PASS" : "FAIL",
      JSON.stringify({ before: beforeUn.holding, after: afterUn.holding, receipts: afterUn.liveReceipts }));

    await selectTestId(page, "partition-status", "collected");
    await sleep(500);
    await page.waitForSelector('[data-testid="partition-collection-method"]', { timeout: 15000 });
    await selectTestIdSave(page, "partition-collection-method", "cash");
    const after = await waitHolding(100000);
    const st = await page.$eval('[data-testid="partition-status"]', (el) => el.value);
    const ok = after.holding === 100000 && st === "collected";
    rec("UI recollect cash after uncollect restores 1000 AED", ok ? "PASS" : "FAIL",
      JSON.stringify({ after: after.holding, st }));

    // Refresh persistence
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "تحديث");
      b?.click();
    });
    await sleep(1500);
    const mid = await kpi();
    rec("Collect persists after refresh", mid.holding === 100000 ? "PASS" : "FAIL",
      JSON.stringify({ holding: mid.holding }));
  }

  // --- C: UI deposit 100 from holding (owner uses المالية → + إيداع) ---
  {
    const before = await kpi();
    await clickTestId(page, "tab-financial");
    await sleep(600);
    await clickTestId(page, "btn-add-deposit-fin");
    await sleep(400);
    await typeTestId(page, "deposit-desc", "اختبار إيداع 100 من العهدة");
    await typeTestId(page, "deposit-amount", "100");
    await typeTestId(page, "deposit-date", "2026-09-05");
    await clickTestId(page, "btn-save-deposit");
    const after = await waitHolding(before.holding - 10000, 30000);
    const ok = after.holding === before.holding - 10000 && after.apprDep === before.apprDep + 10000;
    rec("UI deposit 100: holding -100 deposited +100", ok ? "PASS" : "FAIL",
      JSON.stringify({ beforeH: before.holding, afterH: after.holding, beforeDep: before.apprDep, afterDep: after.apprDep }));

    // Over-deposit must fail without partial effect
    await clickTestId(page, "btn-add-deposit-fin");
    await sleep(300);
    await typeTestId(page, "deposit-desc", "تجاوز عهدة");
    await typeTestId(page, "deposit-amount", String(Math.floor(after.holding / 100) + 500));
    await clickTestId(page, "btn-save-deposit");
    await sleep(1200);
    const over = await kpi();
    const overMsg = await page.evaluate(() => window.__qamaTest?.authState?.()?.msg || document.body.innerText);
    rec("Over-deposit rejected (no partial)",
      over.holding === after.holding && /عهدة|يتجاوز|HOLDING/i.test(overMsg) ? "PASS" : "FAIL",
      JSON.stringify({ holding: over.holding, msg: String(overMsg).slice(0, 120) }));
  }

  // --- D: empty server schedule restores defaults; pay once; persist ---
  {
    await page.evaluate(async () => {
      await window.__qamaTest.engineCommand("upsertUiConfig", {
        configId: "balances",
        json: JSON.stringify({
          companyBalance: 0,
          revenueBalance: 0,
          installmentBalance: 200000,
          installmentSchedule: [],
        }),
      }, window.__qamaTest.opId("bal-empty"));
    });
    await page.reload({ waitUntil: "networkidle0" });
    await pinLogin(page, "مدير", "1325");
    await clickTestId(page, "tab-financial");
    await sleep(900);
    const body = await page.evaluate(() => document.body.innerText);
    const hasScheduleUi = /مدفوع:\s*0\s*من\s*[1-9]/.test(body) || /من\s*6\s*أقساط/.test(body);
    const balBefore = await page.evaluate(async () => {
      const d = await window.__qamaTest.refreshEngine(2026, 8);
      const b = d.ui?.config?.balances;
      return b?.data || b || {};
    });
    await page.waitForSelector('[data-testid="btn-pay-installment"]', { timeout: 10000 });
    await clickTestId(page, "btn-pay-installment");
    await sleep(2000);
    // Double-click spam while/after
    await page.evaluate(() => {
      const b = document.querySelector('[data-testid="btn-pay-installment"]');
      b?.click(); b?.click();
    });
    await sleep(1500);
    const body2 = await page.evaluate(() => document.body.innerText);
    const paidUi = /مدفوع:\s*1\s*من/.test(body2);
    const bal = await page.evaluate(async () => {
      const d = await window.__qamaTest.refreshEngine(2026, 8);
      const b = d.ui?.config?.balances;
      return b?.data || b || {};
    });
    const schedule = Array.isArray(bal.installmentSchedule) ? bal.installmentSchedule : [];
    const paidCount = schedule.filter((x) => x.paid).length;
    const balOk = Number(bal.installmentBalance) === 200000 - 179294;
    rec("Installment: restore empty→defaults, pay once, persist",
      hasScheduleUi && paidUi && paidCount === 1 && balOk ? "PASS" : "FAIL",
      JSON.stringify({ hasScheduleUi, paidUi, paidCount, bal: bal.installmentBalance, balBefore: balBefore.installmentBalance, schedLen: schedule.length }));

    // Relogin
    await clickTestId(page, "btn-logout");
    await pinLogin(page, "مدير", "1325");
    await clickTestId(page, "tab-financial");
    await sleep(900);
    const body3 = await page.evaluate(() => document.body.innerText);
    const persistUi = /مدفوع:\s*1\s*من/.test(body3);
    const bal2 = await page.evaluate(async () => {
      const d = await window.__qamaTest.refreshEngine(2026, 8);
      const b = d.ui?.config?.balances;
      return b?.data || b || {};
    });
    const paid2 = (bal2.installmentSchedule || []).filter((x) => x.paid).length;
    rec("Installment paid persists after relogin",
      persistUi && paid2 === 1 && Number(bal2.installmentBalance) === 20706 ? "PASS" : "FAIL",
      JSON.stringify({ persistUi, paid2, bal: bal2.installmentBalance }));
  }
} catch (e) {
  rec("suite", "FAIL", String(e.message || e));
} finally {
  await browser.close().catch(() => {});
}

writeFileSync(resolve(ART, "tenant-installment-regressions.json"), JSON.stringify({ results }, null, 2));
const fail = results.filter((r) => r.status === "FAIL").length;
console.log(JSON.stringify({ pass: results.length - fail, fail }, null, 2));
process.exit(fail ? 1 : 0);
