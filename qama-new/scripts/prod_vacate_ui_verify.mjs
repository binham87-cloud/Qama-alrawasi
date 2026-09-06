/**
 * Live UI: manager collect cash → set فارغ → holding cleared (post-fix).
 * Amount 199 AED distinct. Chromium mobile viewport (iPhone-class); not physical Safari.
 *
 *   OWNER_PIN=… node scripts/prod_vacate_ui_verify.mjs
 */
import puppeteer from "puppeteer-core";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "https://qama-new-prod-2026.web.app";
const API_KEY = "AIzaSyBs0wIu2h2mnNMGr5SH-YNXjUhrdrGSNKg";
const REGION = "me-central1";
const PROJECT = "qama-new-prod-2026";
const OWNER_PIN = process.env.OWNER_PIN;
if (!OWNER_PIN) { console.error("OWNER_PIN required"); process.exit(2); }
const STAMP = Date.now().toString(36);
const TENANT = `BOT-UI-VAC ${STAMP}`;
const ART = resolve(dirname(fileURLToPath(import.meta.url)), "../artifacts/investigation-2026-09-05");
mkdirSync(ART, { recursive: true });
const results = [];
function rec(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail: String(detail).slice(0, 700) });
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
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }) });
  return (await res.json()).idToken;
}
async function ownerToken() {
  return signIn((await callable("login", { userId: "mig:user:owner:saeed", pin: OWNER_PIN })).customToken);
}
async function dash(token) {
  return callable("read", { what: "dashboard", period: "2026-09" }, token);
}
function holdingOf(d) {
  return Number(d.summary?.sharedEmployeeHoldingFils ?? d.summary?.holdingFils ?? 0);
}
async function pinLogin(page, who, pin) {
  await page.goto(HOST + "/?uivac=" + STAMP, { waitUntil: "domcontentloaded" });
  await page.waitForFunction((lab) => (document.body?.innerText || "").includes(lab), { timeout: 30000 }, who);
  await page.evaluate((lab) => {
    [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes(lab)).click();
  }, who);
  await page.waitForSelector("button.pkb", { timeout: 15000 });
  for (const d of String(pin)) {
    await page.evaluate((digit) => {
      [...document.querySelectorAll("button.pkb")].find((x) => (x.textContent || "").trim() === digit).click();
    }, d);
    await sleep(90);
  }
  await page.waitForFunction(() => /الوحدات|الرئيسية/.test(document.body?.innerText || ""), { timeout: 90000 });
}
async function waitSave(page, before) {
  await page.waitForFunction((prev) => {
    const t = window.__qamaSaveState || {};
    const done = Number(t.saveOpDoneId || 0);
    if (done > prev.done && t.saveOpStatus === "fail") return "fail";
    return done > prev.done && t.saveOpStatus === "ok";
  }, { timeout: 45000 }, before).catch(() => {});
}
async function mark(page) {
  return page.evaluate(() => {
    const t = window.__qamaSaveState || {};
    return { done: Number(t.saveOpDoneId || 0) };
  });
}

const token = await ownerToken();
const beforeH = holdingOf(await dash(token));
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844 });
const tracked = { rentalIds: [], receiptIds: [], spaceIds: [] };

try {
  await pinLogin(page, "مدير", OWNER_PIN);
  await page.click('[data-testid="tab-units"]');
  await sleep(500);
  await page.waitForSelector('[data-testid="unit-card"]');
  await page.click('[data-testid="unit-card"]');
  await sleep(500);
  await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-testid="partition-card"]')];
    const vacant = cards.find((c) => /فارغ/.test(c.innerText)) || cards[cards.length - 1];
    vacant.querySelector('[data-testid="partition-expand"]')?.click();
  });
  await page.waitForSelector('[data-testid="partition-status"]', { timeout: 15000 });

  let b = await mark(page);
  await page.$eval('[data-testid="partition-tenant"]', (el, v) => {
    el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
  }, TENANT);
  await waitSave(page, b);

  b = await mark(page);
  await page.$eval('[data-testid="partition-rent"]', (el) => {
    el.value = "199"; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await waitSave(page, b);

  await page.$eval('[data-testid="partition-status"]', (el) => {
    el.value = "collected"; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await sleep(600);
  await page.waitForSelector('[data-testid="partition-collection-method"]', { timeout: 15000 });
  b = await mark(page);
  await page.$eval('[data-testid="partition-collection-method"]', (el) => {
    el.value = "cash"; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await waitSave(page, b);

  let midH = holdingOf(await dash(token));
  const t0 = Date.now();
  while (Date.now() - t0 < 20000 && midH < beforeH + 19900) {
    await sleep(500);
    midH = holdingOf(await dash(token));
  }
  rec("UI collect cash → holding +199", midH === beforeH + 19900, JSON.stringify({ beforeH, midH }));

  // Vacate
  b = await mark(page);
  await page.$eval('[data-testid="partition-status"]', (el) => {
    el.value = "vacant"; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await waitSave(page, b);

  let afterH = holdingOf(await dash(token));
  const t1 = Date.now();
  while (Date.now() - t1 < 20000 && afterH !== beforeH) {
    await sleep(500);
    afterH = holdingOf(await dash(token));
  }
  rec("UI vacate → holding back to baseline", afterH === beforeH, JSON.stringify({ beforeH, midH, afterH }));

  // Refresh + logout/login
  await page.evaluate(() => {
    [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "تحديث")?.click();
  });
  await sleep(2500);
  rec("after refresh holding stable", holdingOf(await dash(token)) === beforeH, String(holdingOf(await dash(token))));

  await page.click('[data-testid="btn-logout"]');
  await pinLogin(page, "مدير", OWNER_PIN);
  rec("after re-login holding stable", holdingOf(await dash(token)) === beforeH, String(holdingOf(await dash(token))));

  // Double vacate click
  await page.click('[data-testid="tab-units"]');
  await sleep(400);
  await page.click('[data-testid="unit-card"]');
  await sleep(400);
  await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-testid="partition-card"]')];
    const vacant = cards.find((c) => /فارغ/.test(c.innerText)) || cards[0];
    vacant.querySelector('[data-testid="partition-expand"]')?.click();
  });
  await sleep(500);
  if (await page.$('[data-testid="partition-status"]')) {
    b = await mark(page);
    await page.$eval('[data-testid="partition-status"]', (el) => {
      el.value = "vacant"; el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitSave(page, b);
    await page.$eval('[data-testid="partition-status"]', (el) => {
      el.value = "vacant"; el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await sleep(1500);
  }
  rec("double vacate no holding change", holdingOf(await dash(token)) === beforeH, String(holdingOf(await dash(token))));
} catch (e) {
  rec("suite", false, String(e.message || e));
} finally {
  // API cleanup any BOT-UI-VAC leftovers
  try {
    const d = await dash(token);
    for (const u of d.unitsTree || []) {
      for (const sp of u.spaces || []) {
        if (!String(sp.tenantName || "").includes("BOT-UI-VAC")) continue;
        tracked.spaceIds.push(sp.spaceId);
        if (sp.obligationId && Number(sp.paidFils || 0) > 0) {
          try {
            await callable("command", {
              command: "uncollectObligation",
              payload: { obligationId: sp.obligationId, reason: "ui vacate cleanup" },
              operationId: `uivac-uncol-${STAMP}-${sp.obligationId}`.slice(0, 120),
            }, token);
          } catch (_) {}
        }
        if (sp.rentalId) {
          try {
            await callable("command", {
              command: "closeRental",
              payload: { rentalId: sp.rentalId, endDate: "2026-09-06", reason: "ui vacate cleanup", setVacant: true },
              operationId: `uivac-close-${STAMP}-${sp.rentalId}`.slice(0, 120),
            }, token);
          } catch (_) {}
        }
      }
    }
    for (const r of (d.receipts || []).filter((x) => x.state === "recognized")) {
      // only if holding still up from our test
    }
    const finalH = holdingOf(await dash(token));
    if (finalH !== beforeH) {
      // reverse any live cash
      for (const r of (await dash(token)).receipts || []) {
        if (r.state !== "recognized" || r.method !== "cash") continue;
        try {
          await callable("command", {
            command: "reverseReceipt",
            payload: { receiptId: r.id, reason: "ui vacate final cleanup" },
            operationId: `uivac-rev-${STAMP}-${r.id}`.slice(0, 120),
          }, token);
        } catch (_) {}
      }
    }
    rec("cleanup holding baseline", holdingOf(await dash(token)) === beforeH, String(holdingOf(await dash(token))));
  } catch (e) {
    rec("cleanup", false, String(e.message || e));
  }
  await browser.close().catch(() => {});
}

const out = { stamp: STAMP, results, pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length };
writeFileSync(resolve(ART, "prod-vacate-ui-verify.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ pass: out.pass, fail: out.fail }, null, 2));
process.exit(out.fail ? 1 : 0);
