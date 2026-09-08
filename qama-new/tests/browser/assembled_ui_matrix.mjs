/**
 * Smoke / classification matrix for assembled UI (emulator).
 * Deep workflows live in assembled_ui_workflows.mjs.
 *
 * Each result includes `kind`:
 *   ui_persisted | helper | preflight | seed | static_label
 */
import puppeteer from "puppeteer-core";
import { writeFileSync, mkdirSync } from "node:fs";
import { initializeApp, getApps, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const HOST = process.env.FIREBASE_HOSTING_EMULATOR_HOST || "127.0.0.1:5000";
const PROJECT = process.env.GCLOUD_PROJECT || "qama-new-prod-2026";
const results = [];
function rec(name, status, kind, detail = "") {
  results.push({ name, status, kind, detail: String(detail || "").slice(0, 240) });
  console.log(`${status}\t[${kind}]\t${name}${detail ? " — " + detail : ""}`);
}

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error("BLOCKED: FIRESTORE_EMULATOR_HOST not set");
  process.exit(2);
}

while (getApps().length) await deleteApp(getApps()[0]);
initializeApp({ projectId: PROJECT });
const db = getFirestore();

try {
  const { initializeApp: initClient, deleteApp: delClient } = await import("firebase/app");
  const { getAuth, connectAuthEmulator, signInWithCustomToken } = await import("firebase/auth");
  const { getFunctions, connectFunctionsEmulator, httpsCallable } = await import("firebase/functions");
  const app = initClient({ apiKey: "demo", projectId: PROJECT, appId: "demo-matrix" }, "matrix-preflight");
  const auth = getAuth(app);
  const functions = getFunctions(app, "me-central1");
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  const loginFn = httpsCallable(functions, "login");
  const { data } = await loginFn({ userId: "mig:user:owner:saeed", pin: "1325" });
  await signInWithCustomToken(auth, data.customToken);
  rec("PREFLIGHT login callable + custom token", "PASS", "preflight", data.user?.displayName || "");
  await delClient(app);
} catch (e) {
  rec("PREFLIGHT login callable + custom token", "FAIL", "preflight", String(e.message || e).slice(0, 200));
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});

try {
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  const logs = [];
  page.on("console", (m) => logs.push(m.text()));

  await page.goto(`http://${HOST}/`, { waitUntil: "networkidle0" });
  rec("HOST assembled RTL page", (await page.$eval("html", (el) => el.getAttribute("dir") === "rtl")) ? "PASS" : "FAIL", "static_label");
  const bodyText = await page.evaluate(() => document.body.innerText);
  rec("LOGIN shows Manager", /مدير/.test(bodyText) ? "PASS" : "FAIL", "static_label");
  rec("LOGIN shows Yahya", /يحيى/.test(bodyText) ? "PASS" : "FAIL", "static_label");
  rec("LOGIN shows Nader", /نادر/.test(bodyText) ? "PASS" : "FAIL", "static_label");
  rec("BRIDGE emulator mode log", logs.some((l) => /emulator mode/.test(l)) ? "PASS" : "FAIL", "helper",
    logs.filter((l) => /qama|emulator/i.test(l)).slice(0, 3).join(" | "));

  // Strict PIN login
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((n) => /مدير/.test(n.textContent || ""));
    btn?.click();
  });
  await page.waitForFunction(() => /أدخل الرقم السري/.test(document.body.innerText), { timeout: 8000 });
  for (const d of "1325") {
    await page.evaluate((digit) => {
      const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === digit);
      b?.click();
    }, d);
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    await page.waitForFunction(() => {
      const t = window.__qamaTest?.authState?.();
      return t && t.screen === "app" && !!t.user && t.hasDash === true && t.loading === false
        && !/أدخل الرقم السري|جاري تحميل البيانات/.test(document.body.innerText || "");
    }, { timeout: 30000 });
    const st = await page.evaluate(() => window.__qamaTest.authState());
    rec("OWNER PIN login authenticated+loaded", "PASS", "ui_persisted",
      `user=${st.user} actor=${st.actorId} tabs_ok`);
  } catch (e) {
    const st = await page.evaluate(() => window.__qamaTest?.authState?.() || { text: document.body.innerText.slice(0, 120) });
    rec("OWNER PIN login authenticated+loaded", "FAIL", "ui_persisted", JSON.stringify(st));
  }

  // Helpers (not E2E proof)
  const hook = await page.evaluate(() => {
    const t = window.__qamaTest;
    if (!t) return { ok: false };
    const OB = "rental:rentnew-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_2026-09";
    const pay1 = t.collectionOpKey(OB, 10000, 10000, []);
    const un1 = t.uncollectOpKey(OB, 10000, [{ state: "recognized" }]);
    const pay2 = t.collectionOpKey(OB, 10000, 10000, [{ state: "reversed" }]);
    const un2 = t.uncollectOpKey(OB, 10000, [{ state: "reversed" }, { state: "recognized" }]);
    const sticky = ("uncol-" + OB + "-p10000").slice(0, 120);
    const longOb = "rental:" + "x".repeat(90) + "_2026-09";
    const longKey = t.uncollectOpKey(longOb, 10000, [{ state: "recognized" }, { state: "reversed" }]);
    const errHold = t.formatEngineError({ message: "AMOUNT_EXCEEDS_HOLDING", details: { holdingFils: 5000, attemptedFils: 9000 } });
    const errCust = t.formatEngineError({ message: "CUSTODY_RECONCILIATION_ERROR", details: { sharedHoldingAfterFils: -100 } });
    const keys = Array.from({ length: 20 }, () => t.uncollectOpKey("rental:abc_2026-09", 5000, [{ state: "recognized" }]));
    return {
      ok: true,
      payDiff: pay1 !== pay2, uncolDiff: un1 !== un2, uncolNotSticky: un1 !== sticky,
      longOk: longKey.length <= 120 && /-L1-A2$/.test(longKey),
      errHoldOk: /عهدة|Holding/.test(errHold), errCustDistinct: /مطابقة|سالبة/.test(errCust) && errCust !== errHold,
      retryStable: keys.every((k) => k === keys[0]),
    };
  });
  if (!hook.ok) rec("BRIDGE __qamaTest hook", "FAIL", "helper");
  else {
    rec("BRIDGE __qamaTest hook", "PASS", "helper");
    rec("HELPER receipt keys differ after reverse+recollect", hook.payDiff ? "PASS" : "FAIL", "helper");
    rec("HELPER uncollect keys differ across cycles", hook.uncolDiff ? "PASS" : "FAIL", "helper");
    rec("HELPER uncollect not sticky uncol-ob-p", hook.uncolNotSticky ? "PASS" : "FAIL", "helper");
    rec("HELPER key truncation keeps L/A ≤120", hook.longOk ? "PASS" : "FAIL", "helper");
    rec("HELPER formatEngineError Holding Arabic", hook.errHoldOk ? "PASS" : "FAIL", "helper");
    rec("HELPER formatEngineError Custody distinct", hook.errCustDistinct ? "PASS" : "FAIL", "helper");
    rec("HELPER retry key stability (identical inputs)", hook.retryStable ? "PASS" : "FAIL", "helper",
      "NOT a concurrent transaction test");
  }

  // Tab labels (visibility only)
  const tabs = await page.evaluate(() => document.body.innerText);
  for (const label of ["الوحدات", "المالية", "المصاريف والصيانة", "الطلبات"]) {
    rec(`TAB label visible: ${label}`, tabs.includes(label) ? "PASS" : "FAIL", "static_label");
  }

  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /المالية/.test(x.textContent || "") && (x.textContent || "").length < 20);
    b?.click();
  });
  await new Promise((r) => setTimeout(r, 1000));
  const fin = await page.evaluate(() => document.body.innerText);
  rec("FINANCE shows Holding/عهدة label", /عهدة/.test(fin) ? "PASS" : "FAIL", "static_label");

  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "الوحدات");
    b?.click();
  });
  await new Promise((r) => setTimeout(r, 1200));
  const unitsText = await page.evaluate(() => document.body.innerText);
  const st = await page.evaluate(() => window.__qamaTest.authState());
  rec("UNITS loaded from dash", (st.hasDash && /شقة|101|بارتشن|مستأجر/.test(unitsText)) ? "PASS" : "FAIL", "ui_persisted",
    unitsText.slice(0, 100).replace(/\s+/g, " "));

  // Expense invalid — strict
  const beforeExp = (await db.collection("expenses").get()).size;
  await page.evaluate(() => {
    [...document.querySelectorAll("button")].find((x) => /المصاريف/.test(x.textContent || ""))?.click();
  });
  await new Promise((r) => setTimeout(r, 600));
  await page.evaluate(() => {
    [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "+ مصروف")?.click();
  });
  await new Promise((r) => setTimeout(r, 400));
  await page.evaluate(() => {
    [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "حفظ")?.click();
  });
  await new Promise((r) => setTimeout(r, 600));
  const expDiag = await page.evaluate(() => ({
    msg: window.__qamaTest.authState().msg,
    showAddExp: window.__qamaTest.authState().showAddExp,
    text: document.body.innerText,
  }));
  const afterExp = (await db.collection("expenses").get()).size;
  const expOk = afterExp === beforeExp && expDiag.showAddExp === true
    && /أدخل وصف المصروف|المبلغ يجب أن يكون أكبر من صفر/.test(expDiag.msg || expDiag.text);
  rec("EXPENSE invalid: no record + form open + error", expOk ? "PASS" : "FAIL", "ui_persisted",
    JSON.stringify({ beforeExp, afterExp, showAddExp: expDiag.showAddExp, msg: expDiag.msg }));

  const obs = await db.collection("obligations").get();
  rec("SEED obligation present", obs.size > 0 ? "PASS" : "FAIL", "seed", obs.docs[0]?.id);

  // Gaps deferred to workflows file / still open
  rec("COLLECT→UNCOLLECT UI editor click-path", "NOT TESTED", "ui_persisted", "see assembled_ui_workflows bridge_mediated + open gap for pure select clicks");
  rec("DAILY bookings create/edit", "NOT TESTED", "ui_persisted", "tab open covered in workflows; create booking not automated");
  rec("APPROVE/REJECT employee request", "NOT TESTED", "ui_persisted", "needs employee submit then owner approve");
  rec("MONTH LOCK toggle persist", "NOT TESTED", "ui_persisted", "permissions/lock UI click not fully automated");
  rec("PRINT/EXPORT", "NOT AVAILABLE", "static_label", "no controls in Old UI");

} finally {
  await browser.close();
}

const summary = {
  PASS: results.filter((r) => r.status === "PASS").length,
  FAIL: results.filter((r) => r.status === "FAIL").length,
  "NOT TESTED": results.filter((r) => r.status === "NOT TESTED").length,
  "NOT AVAILABLE": results.filter((r) => r.status === "NOT AVAILABLE").length,
  byKind: {},
};
for (const r of results) {
  summary.byKind[r.kind] ||= { PASS: 0, FAIL: 0, other: 0 };
  if (r.status === "PASS") summary.byKind[r.kind].PASS++;
  else if (r.status === "FAIL") summary.byKind[r.kind].FAIL++;
  else summary.byKind[r.kind].other++;
}
const out = { asOf: new Date().toISOString(), summary, results };
mkdirSync("artifacts/investigation-2026-09-05", { recursive: true });
writeFileSync("artifacts/investigation-2026-09-05/browser-matrix-results.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
if (summary.FAIL > 0) process.exit(1);
