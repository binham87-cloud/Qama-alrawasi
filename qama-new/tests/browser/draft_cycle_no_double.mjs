/**
 * Emulator proof: collect → uncollect → refresh must NOT resurrect old draft money;
 * recollect once → exactly +1 live receipt / +rent holding (no double).
 *
 *   firebase emulators:exec --project qama-new-prod-2026 \
 *     --only firestore,auth,functions,hosting \
 *     "node seed/seed_bridge_ui.mjs && node tests/browser/draft_cycle_no_double.mjs"
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
  results.push({ name, status, detail: String(detail).slice(0, 600) });
  console.log(`${status}\t${name}${detail ? " — " + detail : ""}`);
}
async function sleep(ms) { await new Promise((r) => setTimeout(r, ms)); }

async function markSave(page) {
  return page.evaluate(() => {
    const t = window.__qamaSaveState || window.__qamaTest?.authState?.() || {};
    return { done: t.saveOpDoneId || 0 };
  });
}
async function waitOnline(page, ms = 45000, before = null) {
  const b = before || await markSave(page);
  await page.waitForFunction((prev) => {
    const t = window.__qamaSaveState || window.__qamaTest?.authState?.() || {};
    const done = Number(t.saveOpDoneId || 0);
    if (done > prev.done && t.saveOpStatus === "fail") return "fail";
    return done > prev.done && t.saveOpStatus === "ok";
  }, { timeout: ms }, b).catch(() => {});
}

async function pinLogin(page, who, pin) {
  await page.goto(`http://${HOST}/`, { waitUntil: "networkidle0" });
  await page.evaluate((label) => {
    const btn = [...document.querySelectorAll("button")].find((n) => (n.textContent || "").includes(label));
    btn.click();
  }, who);
  await page.waitForFunction(() => /أدخل الرقم السري/.test(document.body.innerText), { timeout: 8000 });
  for (const d of pin) {
    await page.evaluate((digit) => {
      const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === digit);
      b?.click();
    }, d);
    await sleep(60);
  }
  await page.waitForFunction(() => {
    const t = window.__qamaTest?.authState?.();
    return t && t.screen === "app" && t.user && t.hasDash && !t.loading;
  }, { timeout: 90000 });
}

async function selectTestId(page, id, value) {
  await page.waitForSelector(`[data-testid="${id}"]`, { timeout: 15000 });
  await page.evaluate((tid, val) => {
    const el = document.querySelector(`[data-testid="${tid}"]`);
    el.value = val;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, id, value);
}
async function typeTestId(page, id, value) {
  await page.waitForSelector(`[data-testid="${id}"]`, { timeout: 15000 });
  await page.evaluate((tid, val) => {
    const el = document.querySelector(`[data-testid="${tid}"]`);
    el.focus(); el.value = String(val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, id, value);
}
async function selectSave(page, id, value) {
  const b = await markSave(page);
  await selectTestId(page, id, value);
  await waitOnline(page, 30000, b);
}
async function typeSave(page, id, value) {
  const b = await markSave(page);
  await typeTestId(page, id, value);
  await waitOnline(page, 30000, b);
}

async function kpi() {
  const receipts = (await db.collection("receipts").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const deposits = (await db.collection("deposits").get()).docs.map((d) => d.data());
  const live = receipts.filter((r) => r.state === "recognized");
  const reversed = receipts.filter((r) => r.state === "reversed");
  const liveCash = live.filter((r) => r.method === "cash").reduce((s, r) => s + Number(r.amountFils || 0), 0);
  const apprDep = deposits.filter((d) => d.state === "approved").reduce((s, r) => s + Number(r.amountFils || 0), 0);
  return { liveReceipts: live.length, reversed: reversed.length, holding: liveCash - apprDep, liveIds: live.map((r) => r.id) };
}
async function waitHolding(target, ms = 25000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    last = await kpi();
    if (last.holding === target) return last;
    await sleep(400);
  }
  return last;
}

async function openVacant(page) {
  await page.evaluate(() => document.querySelector('[data-testid="tab-units"]')?.click());
  await sleep(400);
  await page.waitForSelector('[data-testid="unit-card"]');
  await page.click('[data-testid="unit-card"]');
  await sleep(500);
  await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-testid="partition-card"]')];
    const vacant = cards.find((c) => /فارغ/.test(c.innerText)) || cards[cards.length - 1];
    vacant.querySelector('[data-testid="partition-expand"]')?.click();
  });
  await page.waitForSelector('[data-testid="partition-status"]', { timeout: 10000 });
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
page.setViewport({ width: 390, height: 844 });

try {
  await pinLogin(page, "مدير", "1325");
  await openVacant(page);
  await typeSave(page, "partition-tenant", "مسودة-دورة-تجربة");
  await typeSave(page, "partition-rent", "1000");

  // Collect
  await selectTestId(page, "partition-status", "collected");
  await sleep(400);
  await page.waitForSelector('[data-testid="partition-collection-method"]');
  await selectSave(page, "partition-collection-method", "cash");
  let k = await waitHolding(100000);
  rec("collect once → holding 1000 / 1 live", k.holding === 100000 && k.liveReceipts === 1 ? "PASS" : "FAIL",
    JSON.stringify(k));

  // Uncollect
  await selectSave(page, "partition-status", "late");
  k = await waitHolding(0);
  rec("uncollect → holding 0 / 0 live / ≥1 reversed", k.holding === 0 && k.liveReceipts === 0 && k.reversed >= 1 ? "PASS" : "FAIL",
    JSON.stringify(k));

  // Refresh — stale draft must NOT resurrect money or collected UI without new method
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "تحديث");
    b?.click();
  });
  await sleep(2500);
  await openVacant(page);
  k = await kpi();
  const st = await page.$eval('[data-testid="partition-status"]', (el) => el.value).catch(() => "");
  const methodEl = await page.$('[data-testid="partition-collection-method"]');
  rec("refresh after uncollect: no live money; status not confirmed collected-with-method",
    k.holding === 0 && k.liveReceipts === 0 && !(st === "collected" && methodEl) ? "PASS" : "FAIL",
    JSON.stringify({ holding: k.holding, live: k.liveReceipts, st, hasMethod: !!methodEl }));

  // Recollect once
  await selectTestId(page, "partition-status", "collected");
  await sleep(500);
  await page.waitForSelector('[data-testid="partition-collection-method"]', { timeout: 15000 });
  await selectSave(page, "partition-collection-method", "cash");
  k = await waitHolding(100000);
  rec("recollect once → holding 1000 / exactly 1 live (no double)",
    k.holding === 100000 && k.liveReceipts === 1 ? "PASS" : "FAIL",
    JSON.stringify({ holding: k.holding, live: k.liveReceipts, reversed: k.reversed, ids: k.liveIds }));

  // Second uncollect + recollect cycle
  await selectSave(page, "partition-status", "late");
  await waitHolding(0);
  await selectTestId(page, "partition-status", "collected");
  await sleep(500);
  await page.waitForSelector('[data-testid="partition-collection-method"]', { timeout: 15000 });
  await selectSave(page, "partition-collection-method", "cash");
  k = await waitHolding(100000);
  rec("second recollect cycle still exactly 1 live",
    k.holding === 100000 && k.liveReceipts === 1 && k.reversed >= 2 ? "PASS" : "FAIL",
    JSON.stringify({ holding: k.holding, live: k.liveReceipts, reversed: k.reversed }));
} catch (e) {
  rec("suite", "FAIL", String(e.message || e));
} finally {
  await browser.close().catch(() => {});
}

writeFileSync(resolve(ART, "draft-cycle-no-double.json"), JSON.stringify({ results }, null, 2));
const fail = results.filter((r) => r.status === "FAIL").length;
console.log(JSON.stringify({ pass: results.length - fail, fail }, null, 2));
process.exit(fail ? 1 : 0);
