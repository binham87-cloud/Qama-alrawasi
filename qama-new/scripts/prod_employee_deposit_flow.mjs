/**
 * Live: seed holding → employee UI deposit×2 + expense → manager approve deposit + reject other.
 * Verify balances after refresh/relogin. Cleanup tracked IDs.
 *
 *   OWNER_PIN=… EMP_PIN_YAHIA=… node scripts/prod_employee_deposit_flow.mjs
 */
import puppeteer from "puppeteer-core";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "https://qama-new-prod-2026.web.app";
const API_KEY = "AIzaSyBs0wIu2h2mnNMGr5SH-YNXjUhrdrGSNKg";
const REGION = "me-central1";
const PROJECT = "qama-new-prod-2026";
const PERIOD = "2026-09";
const OWNER_PIN = process.env.OWNER_PIN;
const EMP_PIN = process.env.EMP_PIN_YAHIA || "6477";
if (!OWNER_PIN) {
  console.error("OWNER_PIN env required (not printed)");
  process.exit(2);
}

const STAMP = Date.now().toString(36);
const TENANT = `BOT-EMP-HOLD ${STAMP}`;
const DESC_OK = `BOT-EMP-DEP-OK ${STAMP}`;
const DESC_REJ = `BOT-EMP-DEP-REJ ${STAMP}`;
const DESC_EXP_REJ = `BOT-EMP-EXP-REJ ${STAMP}`;
const ART = resolve(dirname(fileURLToPath(import.meta.url)), "../artifacts/investigation-2026-09-05");
mkdirSync(ART, { recursive: true });

const results = [];
const created = { depositIds: [], requestIds: [], receiptIds: [], rentalIds: [], spaceIds: [], expenseIds: [] };

function rec(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail: String(detail).slice(0, 800) });
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
async function ownerToken() {
  const res = await callable("login", { userId: "mig:user:owner:saeed", pin: OWNER_PIN });
  return signIn(res.customToken);
}
async function empToken() {
  const res = await callable("login", { userId: "mig:user:yahia", pin: EMP_PIN });
  return signIn(res.customToken);
}
async function cmd(token, command, payload, operationId) {
  return callable("command", { command, payload, operationId }, token);
}
async function dash(token) {
  return callable("read", { what: "dashboard", period: PERIOD }, token);
}
function holdingOf(d) {
  return Number(d.summary?.sharedEmployeeHoldingFils ?? d.summary?.holdingFils ?? 0);
}
function approvedDeps(d) {
  return (d.deposits || []).filter((x) => x.state === "approved");
}
function pendingUi(d) {
  return (d.ui?.requests || []).filter((r) => r.status === "pending");
}
function trialPending(d) {
  return pendingUi(d).filter((r) => {
    const blob = JSON.stringify(r);
    return blob.includes(STAMP) || blob.includes(DESC_OK) || blob.includes(DESC_REJ) || blob.includes(DESC_EXP_REJ);
  });
}

async function seedHolding(ownerTok, empTok) {
  const d0 = await dash(ownerTok);
  const space = (d0.unitsTree || []).flatMap((u) => u.spaces || []).find((s) => s.occupancy === "vacant");
  if (!space) throw new Error("no vacant space for holding seed");
  created.spaceIds.push(space.spaceId);
  const rental = await cmd(ownerTok, "createRental", {
    spaceId: space.spaceId,
    tenantName: TENANT,
    contractualAmountFils: 200000,
    dueDayOfMonth: 1,
    startDate: "2026-09-01",
  }, `empflow-rent-${STAMP}`);
  const rentalId = rental.rentalId || rental.id;
  if (rentalId) created.rentalIds.push(rentalId);
  await cmd(ownerTok, "generateObligations", { period: PERIOD }, `empflow-gen-${STAMP}`);
  const d1 = await dash(ownerTok);
  const sp = (d1.unitsTree || []).flatMap((u) => u.spaces || []).find((s) => s.spaceId === space.spaceId);
  if (!sp?.obligationId) throw new Error("no obligation after rental");
  const cash = await cmd(empTok, "createCashReceipt", {
    obligationId: sp.obligationId,
    amountFils: 200000,
    collectionDate: "2026-09-06",
  }, `empflow-cash-${STAMP}`);
  if (cash.receiptId) created.receiptIds.push(cash.receiptId);
  const d2 = await dash(ownerTok);
  return { beforeH: holdingOf(d2), spaceId: space.spaceId, obligationId: sp.obligationId };
}

async function cleanup(token) {
  // Reject leftover trial pending requests
  const d = await dash(token);
  for (const r of trialPending(d)) {
    try {
      await cmd(token, "resolveWorkRequest", {
        requestId: r.id, decision: "rejected",
      }, `empflow-rejreq-${STAMP}-${r.id}`.slice(0, 120));
    } catch (e) {
      console.warn("rejreq", String(e.message || e).slice(0, 80));
    }
  }
  for (const depositId of [...new Set(created.depositIds)]) {
    try {
      await cmd(token, "reverseDeposit", { depositId, reason: "emp-dep flow cleanup" },
        `empflow-revdep-${STAMP}-${depositId}`.slice(0, 120));
    } catch {
      try {
        await cmd(token, "rejectDeposit", { depositId, reason: "emp-dep flow cleanup" },
          `empflow-rejdep-${STAMP}-${depositId}`.slice(0, 120));
      } catch (e2) {
        console.warn("dep", String(e2.message || e2).slice(0, 80));
      }
    }
  }
  // Also reject pending deposits tagged with stamp
  for (const dep of (d.deposits || [])) {
    const blob = JSON.stringify(dep);
    if (!blob.includes(STAMP) && !blob.includes(DESC_OK) && !blob.includes(DESC_REJ)) continue;
    if (dep.state === "approved" && !created.depositIds.includes(dep.id)) {
      created.depositIds.push(dep.id);
      try {
        await cmd(token, "reverseDeposit", { depositId: dep.id, reason: "emp-dep flow cleanup" },
          `empflow-revdep2-${STAMP}-${dep.id}`.slice(0, 120));
      } catch (e) { console.warn("dep2", String(e.message || e).slice(0, 80)); }
    } else if (dep.state === "pending") {
      try {
        await cmd(token, "rejectDeposit", { depositId: dep.id, reason: "emp-dep flow cleanup" },
          `empflow-rejdep2-${STAMP}-${dep.id}`.slice(0, 120));
      } catch (e) { console.warn("dep3", String(e.message || e).slice(0, 80)); }
    }
  }
  for (const receiptId of created.receiptIds) {
    try {
      await cmd(token, "reverseReceipt", { receiptId, reason: "emp-dep flow cleanup" },
        `empflow-revrcpt-${STAMP}-${receiptId}`.slice(0, 120));
    } catch (e) { console.warn("rcpt", String(e.message || e).slice(0, 80)); }
  }
  for (const rentalId of created.rentalIds) {
    try {
      await cmd(token, "closeRental", {
        rentalId, endDate: "2026-09-06", reason: "emp-dep flow cleanup", setVacant: true,
      }, `empflow-close-${STAMP}-${rentalId}`.slice(0, 120));
    } catch (e) { console.warn("close", String(e.message || e).slice(0, 80)); }
  }
  for (const spaceId of created.spaceIds) {
    try {
      await cmd(token, "setSpaceOccupancy", { spaceId, occupancy: "vacant" },
        `empflow-vac-${STAMP}-${spaceId}`.slice(0, 120));
    } catch (e) { console.warn("vac", String(e.message || e).slice(0, 80)); }
  }
}

async function pinLogin(page, who, pin) {
  await page.goto(HOST + "/?empflow=" + STAMP + "&u=" + encodeURIComponent(who), { waitUntil: "domcontentloaded" });
  await page.waitForFunction((lab) => (document.body?.innerText || "").includes(lab), { timeout: 30000 }, who);
  await page.evaluate((lab) => {
    const btn = [...document.querySelectorAll("button")].find((n) => (n.textContent || "").includes(lab));
    if (!btn) throw new Error("no user btn " + lab);
    btn.click();
  }, who);
  await page.waitForSelector("button.pkb", { timeout: 15000 });
  for (const d of String(pin)) {
    await page.evaluate((digit) => {
      const b = [...document.querySelectorAll("button.pkb")].find((x) => (x.textContent || "").trim() === digit);
      if (!b) throw new Error("missing digit " + digit);
      b.click();
    }, d);
    await sleep(100);
  }
  await page.waitForFunction(() => {
    const t = document.body?.innerText || "";
    return t.includes("الوحدات") || t.includes("الرئيسية");
  }, { timeout: 90000 });
}

async function typeTestId(page, id, value) {
  await page.waitForSelector(`[data-testid="${id}"]`, { timeout: 15000 });
  // Date/number fields: set value directly (keyboard typing corrupts <input type=date>).
  await page.$eval(`[data-testid="${id}"]`, (el, val) => {
    el.focus();
    el.value = String(val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, String(value));
}
async function clickTestId(page, id) {
  await page.waitForSelector(`[data-testid="${id}"]`, { timeout: 15000 });
  await page.click(`[data-testid="${id}"]`);
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844 });

let token;
let seededH = 0;
try {
  token = await ownerToken();
  const empTok = await empToken();
  rec("employee API login", true);

  const seed = await seedHolding(token, empTok);
  seededH = seed.beforeH;
  rec("seed holding via cash receipt (≥200 AED)", seededH >= 200000,
    JSON.stringify({ holding: seededH, space: seed.spaceId }));

  const beforeDepIds = new Set(approvedDeps(await dash(token)).map((d) => d.id));

  // --- Employee: two deposits + one expense ---
  await pinLogin(page, "يحيى", EMP_PIN);
  await clickTestId(page, "tab-transactions");
  await sleep(500);

  await clickTestId(page, "btn-add-deposit");
  await typeTestId(page, "deposit-desc", DESC_OK);
  await typeTestId(page, "deposit-amount", "55");
  await typeTestId(page, "deposit-date", "2026-09-06");
  await clickTestId(page, "btn-save-deposit");
  await sleep(2500);

  await clickTestId(page, "btn-add-deposit");
  await typeTestId(page, "deposit-desc", DESC_REJ);
  await typeTestId(page, "deposit-amount", "66");
  await typeTestId(page, "deposit-date", "2026-09-06");
  await clickTestId(page, "btn-save-deposit");
  await sleep(2500);

  await clickTestId(page, "tab-expenses");
  await sleep(400);
  await clickTestId(page, "btn-add-expense");
  await typeTestId(page, "expense-desc", DESC_EXP_REJ);
  await typeTestId(page, "expense-amount", "12");
  await clickTestId(page, "expense-submit");
  await sleep(2500);

  await clickTestId(page, "tab-myrequests");
  await sleep(1200);
  const myText = await page.evaluate(() => document.body.innerText);
  rec("employee sees submitted requests",
    myText.includes(STAMP) || /تم إرسال|قيد|معلق|إيداع|مصروف/.test(myText),
    myText.slice(0, 220));

  let mid = await dash(token);
  const pending = trialPending(mid);
  rec("pending trial requests ≥2 (deposits and/or expense)", pending.length >= 2,
    JSON.stringify(pending.map((r) => ({ id: r.id, type: r.type, status: r.status, dep: r.payload?.depositId || r.payload?.transaction?.depositId || null }))));

  const depOk = pending.find((r) => r.type === "add_transaction" && (
    JSON.stringify(r).includes(DESC_OK) || Number(r.payload?.transaction?.amount) === 55
  ));
  const other = pending.find((r) => r.id !== depOk?.id && (
    r.type === "add_expense" || (r.type === "add_transaction" && Number(r.payload?.transaction?.amount) === 66)
  ));
  for (const r of pending) {
    created.requestIds.push(r.id);
    const depId = r.payload?.depositId || r.payload?.transaction?.depositId;
    if (depId) created.depositIds.push(depId);
  }
  if (!depOk) throw new Error("missing deposit-55 pending request");

  // --- Manager approve deposit-55 by data-reqid; reject other by data-reqid ---
  await clickTestId(page, "btn-logout");
  await pinLogin(page, "مدير", OWNER_PIN);
  await clickTestId(page, "tab-requests");
  await sleep(1500);

  const approvedClick = await page.evaluate((reqId) => {
    const btn = document.querySelector(`[data-testid="req-approve"][data-reqid="${reqId}"]`);
    if (!btn) return "none";
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return reqId;
  }, depOk.id);
  rec("manager clicked approve on deposit req", approvedClick === depOk.id, approvedClick);

  // Wait for approved deposit
  let afterApprove = mid;
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 25000) {
      afterApprove = await dash(token);
      const newDeps = approvedDeps(afterApprove).filter((d) => !beforeDepIds.has(d.id));
      if (newDeps.length >= 1) {
        for (const d of newDeps) {
          if (!created.depositIds.includes(d.id)) created.depositIds.push(d.id);
        }
        break;
      }
      await sleep(500);
    }
  }
  const afterH = holdingOf(afterApprove);
  const newApproved = approvedDeps(afterApprove).filter((d) => !beforeDepIds.has(d.id));
  rec("approved deposit exists + holding −55 AED",
    newApproved.length >= 1 && afterH === seededH - 5500,
    JSON.stringify({
      seededH, afterH, delta: seededH - afterH,
      newApproved: newApproved.map((d) => ({ id: d.id, fils: d.amountFils, note: d.note || d.reference })),
    }));

  // Reject remaining trial (66 deposit or 12 expense) by req id — wait for card after approve refresh
  await sleep(1500);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "تحديث");
    b?.click();
  });
  await sleep(2000);
  await clickTestId(page, "tab-requests");
  await sleep(1000);
  if (other) {
    const rejected = await page.evaluate((reqId) => {
      const btn = document.querySelector(`[data-testid="req-reject"][data-reqid="${reqId}"]`);
      if (!btn) return false;
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return true;
    }, other.id);
    rec("manager clicked reject on other req", rejected, other.id);
  } else {
    rec("manager clicked reject on other req", false, "no other pending id");
  }
  await sleep(3500);

  const afterReject = await dash(token);
  const stillPending = trialPending(afterReject);
  rec("reject reduced pending trial requests",
    stillPending.length < pending.length,
    `before=${pending.length} after=${stillPending.length}`);
  rec("holding unchanged by reject",
    holdingOf(afterReject) === afterH,
    JSON.stringify({ afterH, now: holdingOf(afterReject) }));

  // Refresh
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "تحديث");
    b?.click();
  });
  await sleep(2500);
  const afterRefresh = await dash(token);
  rec("after refresh: approved deposit + holding stable",
    newApproved.every((d) => approvedDeps(afterRefresh).some((x) => x.id === d.id))
      && holdingOf(afterRefresh) === afterH,
    JSON.stringify({ holding: holdingOf(afterRefresh) }));

  // Manager re-login
  await clickTestId(page, "btn-logout");
  await pinLogin(page, "مدير", OWNER_PIN);
  const afterRelogin = await dash(token);
  rec("after manager re-login balances match",
    holdingOf(afterRelogin) === afterH
      && newApproved.every((d) => approvedDeps(afterRelogin).some((x) => x.id === d.id)),
    JSON.stringify({ holding: holdingOf(afterRelogin) }));

  // Employee re-login
  await clickTestId(page, "btn-logout");
  await pinLogin(page, "يحيى", EMP_PIN);
  await clickTestId(page, "tab-myrequests");
  await sleep(1200);
  const empAfter = await page.evaluate(() => document.body.innerText);
  rec("employee re-login myrequests shows history",
    /معتمد|مرفوض|اعتماد|رفض|إيداع|مصروف|تم/.test(empAfter),
    empAfter.slice(0, 180));
} catch (e) {
  rec("suite", false, String(e.message || e));
} finally {
  try {
    if (!token) token = await ownerToken();
    const beforeCleanH = holdingOf(await dash(token));
    await cleanup(token);
    const final = await dash(token);
    const finalH = holdingOf(final);
    // After full cleanup (reverse deposit + reverse cash + vacate) holding should return to pre-seed baseline (0 if we started clean)
    rec("cleanup: trial approved deposits gone",
      created.depositIds.every((id) => !approvedDeps(final).some((d) => d.id === id)),
      JSON.stringify({ cleaned: created.depositIds, beforeCleanH, finalH }));
    rec("cleanup: holding back to 0 (seed reversed)",
      finalH === 0,
      JSON.stringify({ finalH, receiptIds: created.receiptIds, rentalIds: created.rentalIds }));
  } catch (e) {
    rec("cleanup", false, String(e.message || e));
  }
  await browser.close().catch(() => {});
}

const out = {
  stamp: STAMP, created, results,
  pass: results.filter((r) => r.ok).length,
  fail: results.filter((r) => !r.ok).length,
};
writeFileSync(resolve(ART, "prod-employee-deposit-flow.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ pass: out.pass, fail: out.fail, created }, null, 2));
process.exit(out.fail ? 1 : 0);
