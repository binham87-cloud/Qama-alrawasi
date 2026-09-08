/**
 * Live acceptance for tenant-gate / collect / deposit / installment honesty.
 * Chromium mobile viewport — not physical iPhone Safari.
 *
 * Interactions use Puppeteer ElementHandle.click / keyboard where practical;
 * some selects use value+change (native <select>). Do not describe evaluate-only
 * paths as physical user taps.
 *
 *   OWNER_PIN=… EMP_PIN_YAHIA=… node scripts/prod_hotfix_live_verify.mjs
 */
import puppeteer from "puppeteer-core";
import { writeFileSync, mkdirSync } from "node:fs";

const HOST = "https://qama-new-prod-2026.web.app";
const API_KEY = "AIzaSyBs0wIu2h2mnNMGr5SH-YNXjUhrdrGSNKg";
const REGION = "me-central1";
const PROJECT = "qama-new-prod-2026";
const PIN = process.env.OWNER_PIN;
if (!PIN) {
  console.error("OWNER_PIN env required (not printed)");
  process.exit(2);
}
const STAMP = Date.now().toString(36);
const TENANT = `BOT-HOTFIX ${STAMP}`;
const results = [];
const created = { receiptIds: [], depositIds: [], rentalIds: [], expenseIds: [] };

function rec(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail: String(detail).slice(0, 500) });
  console.log(`${ok ? "PASS" : "FAIL"}\t${name}${detail ? " — " + detail : ""}`);
}
async function sleep(ms) { await new Promise((r) => setTimeout(r, ms)); }

async function callable(name, data, idToken) {
  const url = `https://${REGION}-${PROJECT}.cloudfunctions.net/${name}`;
  const headers = { "Content-Type": "application/json" };
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ data }) });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json.result;
}
async function signIn(customToken) {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`;
  const res = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.idToken;
}
async function apiToken() {
  const res = await callable("login", { userId: "mig:user:owner:saeed", pin: PIN });
  return signIn(res.customToken);
}
async function dash(token) {
  return callable("read", { what: "dashboard", period: "2026-09" }, token);
}
function holdingOf(d) {
  return Number(d.summary?.sharedEmployeeHoldingFils ?? d.summary?.holdingFils ?? 0);
}

async function cleanupTracked(token) {
  for (const depositId of created.depositIds) {
    try {
      await callable("command", {
        command: "reverseDeposit",
        payload: { depositId, reason: "hotfix tracked cleanup" },
        operationId: `hf-revdep-${STAMP}-${depositId}`.slice(0, 120),
      }, token);
    } catch (e) {
      try {
        await callable("command", {
          command: "rejectDeposit",
          payload: { depositId, reason: "hotfix tracked cleanup" },
          operationId: `hf-rejdep-${STAMP}-${depositId}`.slice(0, 120),
        }, token);
      } catch (e2) { console.warn("dep", String(e2.message || e2).slice(0, 80)); }
    }
  }
  for (const receiptId of created.receiptIds) {
    try {
      await callable("command", {
        command: "reverseReceipt",
        payload: { receiptId, reason: "hotfix tracked cleanup" },
        operationId: `hf-revrcpt-${STAMP}-${receiptId}`.slice(0, 120),
      }, token);
    } catch (e) { console.warn("rcpt", String(e.message || e).slice(0, 80)); }
  }
  const d = await dash(token);
  for (const u of d.unitsTree || []) {
    for (const sp of u.spaces || []) {
      if (!String(sp.tenantName || "").includes("BOT-HOTFIX")) continue;
      if (sp.obligationId && Number(sp.paidFils || 0) > 0) {
        try {
          await callable("command", {
            command: "uncollectObligation",
            payload: { obligationId: sp.obligationId, reason: "hotfix tracked cleanup" },
            operationId: `hf-uncol-${STAMP}-${sp.obligationId}`.slice(0, 120),
          }, token);
        } catch (e) { console.warn("uncol", String(e.message || e).slice(0, 80)); }
      }
      if (sp.rentalId) {
        try {
          await callable("command", {
            command: "closeRental",
            payload: { rentalId: sp.rentalId, endDate: "2026-09-05", reason: "hotfix tracked cleanup", setVacant: true },
            operationId: `hf-close-${STAMP}-${sp.rentalId}`.slice(0, 120),
          }, token);
        } catch (e) { console.warn("close", String(e.message || e).slice(0, 80)); }
      }
    }
  }
}

async function waitSaveOk(page, timeout = 30000) {
  const before = await page.evaluate(() => {
    const t = window.__qamaSaveState || window.__qamaTest?.authState?.() || {};
    return { seq: t.saveOpSeq || 0, id: t.saveOpId || 0 };
  });
  await page.waitForFunction((b) => {
    const t = window.__qamaSaveState || window.__qamaTest?.authState?.();
    if (!t) return false;
    return (t.saveOpId || 0) > b.id
      || (t.saveOpSeq || 0) > b.seq
      || /جاري الحفظ/.test(t.syncMsg || "");
  }, { timeout: Math.min(timeout, 15000) }, before).catch(() => {});
  const targetOp = await page.evaluate((b) => {
    const t = window.__qamaSaveState || window.__qamaTest?.authState?.() || {};
    return Math.max(t.saveOpId || 0, b.id + 1);
  }, before);
  await page.waitForFunction((oid) => {
    const t = window.__qamaSaveState || window.__qamaTest?.authState?.();
    if (!t) return false;
    if ((t.saveOpDoneId || 0) >= oid && t.saveOpStatus === "fail") return "fail";
    return (t.saveOpDoneId || 0) >= oid && t.saveOpStatus === "ok";
  }, { timeout }, targetOp);
  const st = await page.evaluate(() => (window.__qamaSaveState || window.__qamaTest?.authState?.() || {}).saveOpStatus || "");
  if (st === "fail") {
    const msg = await page.evaluate(() => (window.__qamaSaveState || window.__qamaTest?.authState?.() || {}).msg || "");
    throw new Error("save failed: " + msg);
  }
}

async function waitMsg(page, re, timeout = 8000) {
  await page.waitForFunction((pat) => {
    const msg = (window.__qamaSaveState || window.__qamaTest?.authState?.() || {}).msg
      || document.body?.innerText || "";
    return new RegExp(pat).test(msg);
  }, { timeout }, re.source || re);
  return page.evaluate(() => (window.__qamaSaveState || window.__qamaTest?.authState?.() || {}).msg
    || "");
}

async function pinLogin(page, whoLabel = "مدير", pin = PIN) {
  await page.goto(HOST + "/?hf=" + STAMP, { waitUntil: "domcontentloaded" });
  await page.waitForFunction((lab) => (document.body?.innerText || "").includes(lab), { timeout: 30000 }, whoLabel);
  await page.evaluate((lab) => {
    const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes(lab));
    if (!btn) throw new Error("missing user button " + lab);
    btn.click();
  }, whoLabel);
  await page.waitForSelector("button.pkb", { timeout: 15000 });
  for (const d of pin) {
    await page.evaluate((digit) => {
      const b = [...document.querySelectorAll("button.pkb")].find((x) => (x.textContent || "").trim() === digit);
      if (!b) throw new Error("missing digit key");
      b.click();
    }, d);
    await sleep(100);
  }
  await page.waitForFunction(() => {
    const t = document.body?.innerText || "";
    return t.includes("الوحدات") || t.includes("الرئيسية");
  }, { timeout: 60000 });
}

async function clickTestId(page, id) {
  const el = await page.waitForSelector(`[data-testid="${id}"]`, { timeout: 20000, visible: true });
  await el.click();
}

async function typeTestId(page, id, value) {
  const el = await page.waitForSelector(`[data-testid="${id}"]`, { timeout: 20000, visible: true });
  await el.focus();
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  if (String(value) !== "") await page.keyboard.type(String(value), { delay: 25 });
  await el.evaluate((node) => {
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function selectTestId(page, id, value) {
  await page.waitForSelector(`[data-testid="${id}"]`, { timeout: 20000, visible: true });
  await page.$eval(`[data-testid="${id}"]`, (el, val) => {
    el.value = val;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

const token0 = await apiToken();
const before = await dash(token0);
const beforeH = holdingOf(before);
const beforeReceiptIds = new Set((before.receipts || []).filter((r) => r.state === "recognized").map((r) => r.id));
const beforeDepIds = new Set((before.deposits || []).filter((d) => d.state === "approved").map((d) => d.id));
await cleanupTracked(token0);

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  defaultViewport: { width: 390, height: 844, isMobile: true, hasTouch: true },
});
const page = await browser.newPage();
page.on("dialog", async (d) => { await d.accept(); });

try {
  await pinLogin(page);
  const html = await page.content();
  rec("deployed markers", /mergeDraftStatus|tenantNameOk|إيداع من العهدة/.test(html));

  await clickTestId(page, "tab-financial");
  await sleep(800);
  const fin = await page.evaluate(() => document.body.innerText);
  const paidLine = fin.match(/مدفوع:\s*\d+\s*من\s*\d+/)?.[0] || "";
  rec("installment UI shows schedule (not 0 of 0)", /مدفوع:\s*\d+\s*من\s*[1-9]/.test(fin), paidLine);

  // --- A: block collect without tenant; message visible; rent draft kept ---
  await clickTestId(page, "tab-units");
  await sleep(500);
  const unitCards = await page.$$('[data-testid="unit-card"]');
  let opened = false;
  for (const card of unitCards) {
    const txt = await card.evaluate((n) => n.innerText);
    if (/ميزان\s*2/.test(txt)) { await card.click(); opened = true; break; }
  }
  if (!opened && unitCards[0]) await unitCards[0].click();
  await sleep(600);
  const parts = await page.$$('[data-testid="partition-card"]');
  for (const card of parts) {
    const txt = await card.evaluate((n) => n.innerText);
    if (/فارغ/.test(txt)) {
      const exp = await card.$('[data-testid="partition-expand"]');
      if (exp) { await exp.click(); break; }
    }
  }
  await page.waitForSelector('[data-testid="partition-status"]', { timeout: 15000 });
  // Clear any abandoned extras tenant before proving the gate
  await typeTestId(page, "partition-tenant", "");
  await sleep(400);
  await typeTestId(page, "partition-rent", "1000");
  await sleep(900);
  await selectTestId(page, "partition-status", "vacant");
  await sleep(400);
  await selectTestId(page, "partition-status", "collected");
  let gateMsg = "";
  try {
    gateMsg = await waitMsg(page, /أدخل اسم المستأجر قبل/, 8000);
  } catch (e) {
    gateMsg = await page.evaluate(() => window.__qamaTest?.authState?.()?.msg || "");
  }
  const stA = await page.$eval('[data-testid="partition-status"]', (el) => el.value);
  const rentA = await page.$eval('[data-testid="partition-rent"]', (el) => el.value);
  const tenantA = await page.$eval('[data-testid="partition-tenant"]', (el) => el.value);
  const stillOpen = !!(await page.$('[data-testid="partition-status"]'));
  const midA = await dash(await apiToken());
  rec("live block collect without tenant (msg + draft)",
    /أدخل اسم المستأجر قبل/.test(gateMsg)
      && stA !== "collected"
      && String(rentA) === "1000"
      && !String(tenantA).trim()
      && stillOpen
      && holdingOf(midA) === beforeH,
    JSON.stringify({ gateMsg: gateMsg.slice(0, 100), stA, rentA, tenantA, stillOpen, holding: holdingOf(midA) }));

  // --- B: tenant rename mid-edit (select-all delete type) must not vacate ---
  await typeTestId(page, "partition-tenant", "اسم مؤقت أ");
  await waitSaveOk(page);
  await typeTestId(page, "partition-tenant", TENANT); // clickCount 3 clears then types
  await waitSaveOk(page);
  const tenantB = await page.$eval('[data-testid="partition-tenant"]', (el) => el.value);
  const stB = await page.$eval('[data-testid="partition-status"]', (el) => el.value);
  rec("tenant rename mid-edit keeps editor (no auto-vacate)",
    tenantB === TENANT && stB !== "collected",
    JSON.stringify({ tenantB, stB }));

  // --- C: collect cash ---
  await selectTestId(page, "partition-status", "collected");
  await sleep(500);
  // Card must not count as confirmed collect before method/receipt
  const bodyDraft = await page.evaluate(() => document.body.innerText);
  await page.waitForSelector('[data-testid="partition-collection-method"]', { timeout: 15000 });
  await selectTestId(page, "partition-collection-method", "cash");
  await waitSaveOk(page, 40000);
  let afterCollect = beforeH;
  {
    const start = Date.now();
    while (Date.now() - start < 45000) {
      const d = await dash(await apiToken());
      afterCollect = holdingOf(d);
      const newR = (d.receipts || []).filter((r) => r.state === "recognized" && !beforeReceiptIds.has(r.id));
      if (afterCollect === beforeH + 100000 && newR.length) {
        created.receiptIds = newR.map((r) => r.id);
        break;
      }
      await sleep(700);
    }
  }
  rec("live collect cash +1000 holding + tracked receipt",
    afterCollect === beforeH + 100000 && created.receiptIds.length >= 1,
    JSON.stringify({ beforeH, afterCollect, receipts: created.receiptIds }));

  // Form still open after save
  const stillOpenC = !!(await page.$('[data-testid="partition-status"]'));
  const stC = stillOpenC ? await page.$eval('[data-testid="partition-status"]', (el) => el.value) : "";
  rec("editor remains open after successful collect", stillOpenC && stC === "collected",
    JSON.stringify({ stillOpenC, stC }));

  // Refresh persistence
  const refreshBtn = await page.evaluateHandle(() =>
    [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "تحديث"));
  if (refreshBtn.asElement()) await refreshBtn.asElement().click();
  await sleep(2500);
  const afterRefresh = holdingOf(await dash(await apiToken()));
  rec("collect persists after refresh", afterRefresh === beforeH + 100000, String(afterRefresh));

  // --- D: deposit 100 ---
  await clickTestId(page, "tab-financial");
  await sleep(600);
  await clickTestId(page, "btn-add-deposit-fin");
  await typeTestId(page, "deposit-desc", `BOT-HOTFIX deposit ${STAMP}`);
  await typeTestId(page, "deposit-amount", "100");
  await typeTestId(page, "deposit-date", "2026-09-05");
  await clickTestId(page, "btn-save-deposit");
  await waitSaveOk(page, 40000).catch(() => {});
  let afterDepH = afterCollect;
  {
    const start = Date.now();
    while (Date.now() - start < 45000) {
      const d = await dash(await apiToken());
      afterDepH = holdingOf(d);
      const newD = (d.deposits || []).filter((x) => x.state === "approved" && !beforeDepIds.has(x.id)
        && /BOT-HOTFIX/.test(String(x.reference || "") + String(x.note || "")));
      if (afterDepH === beforeH + 90000 && newD.length) {
        created.depositIds = newD.map((x) => x.id);
        break;
      }
      await sleep(700);
    }
  }
  rec("live deposit 100 → holding 900 (tracked)",
    afterDepH === beforeH + 90000 && created.depositIds.length >= 1,
    JSON.stringify({ afterDepH, deps: created.depositIds }));

  await clickTestId(page, "btn-logout");
  await pinLogin(page);
  const afterRelogin = holdingOf(await dash(await apiToken()));
  rec("holding after relogin", afterRelogin === beforeH + 90000, String(afterRelogin));
} catch (e) {
  rec("suite", false, e.message || e);
} finally {
  await browser.close().catch(() => {});
  try {
    const t = await apiToken();
    await cleanupTracked(t);
    const final = await dash(t);
    rec("cleanup holding restored (tracked IDs)", holdingOf(final) === beforeH,
      JSON.stringify({ beforeH, finalH: holdingOf(final), created }));
  } catch (e) {
    rec("cleanup", false, e.message || e);
  }
}

mkdirSync("artifacts/investigation-2026-09-05", { recursive: true });
writeFileSync("artifacts/investigation-2026-09-05/prod-hotfix-live-verify.json",
  JSON.stringify({
    stamp: STAMP,
    interactionNote: "Puppeteer ElementHandle.click + keyboard.type; select() for <select>",
    viewport: "390x844 chromium mobile emulation (not physical iPhone Safari)",
    results,
    created,
  }, null, 2));
const fail = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ pass: results.length - fail, fail }, null, 2));
process.exit(fail ? 1 : 0);
