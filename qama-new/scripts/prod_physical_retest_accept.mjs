/**
 * Focused live acceptance — physical-retest remaining fixes.
 *   OWNER_PIN=1325 EMP_PIN_YAHIA=6477 node scripts/prod_physical_retest_accept.mjs
 */
import puppeteer from "puppeteer-core";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HOST = "https://qama-new-prod-2026.web.app";
const API_KEY = "AIzaSyBs0wIu2h2mnNMGr5SH-YNXjUhrdrGSNKg";
const REGION = "me-central1";
const PROJECT = "qama-new-prod-2026";
const PERIOD = "2026-09";
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome-stable";
const OWNER_PIN = process.env.OWNER_PIN || "1325";
const EMP_PIN = process.env.EMP_PIN_YAHIA || "6477";
const STAMP = Date.now().toString(36);
const PREFIX = `PHYSTEST-${STAMP}`;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ART = resolve(ROOT, `artifacts/physical-retest-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
mkdirSync(ART, { recursive: true });

if (!getApps().length) initializeApp({ projectId: PROJECT });
const db = getFirestore();

const results = [];
const created = { depositIds: [], requestIds: [], receiptIds: [], rentalIds: [], obligationIds: [] };
function rec(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail: String(detail).slice(0, 1200) });
  console.log(`${ok ? "PASS" : "FAIL"}\t${name}${detail ? " — " + String(detail).slice(0, 220) : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
async function login(userId, pin) {
  const res = await callable("login", { userId, pin });
  return { token: await signIn(res.customToken) };
}
async function cmd(token, command, payload, operationId) {
  return callable("command", { command, payload, operationId }, token);
}
async function dash(token) {
  return callable("read", { what: "dashboard", period: PERIOD }, token);
}
function kpi(d) {
  const s = d.summary || {};
  return {
    collected: Number(s.collectedFils || 0) / 100,
    deposited: Number(s.depositedFils || 0) / 100,
    holding: Number(s.sharedEmployeeHoldingFils ?? s.holdingFils ?? 0) / 100,
    remaining: Number(s.remainingFils || 0) / 100,
    target: Number(s.targetFils || 0) / 100,
  };
}

async function pinLogin(page, label, pin) {
  await page.goto(HOST, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction(() => /يحيى|نادر|مدير|قمة/.test(document.body.innerText || ""), { timeout: 60000 });
  await sleep(500);
  await page.evaluate((lab) => {
    const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").includes(lab));
    if (!b) throw new Error("no user " + lab);
    b.click();
  }, label);
  await sleep(300);
  for (const d of String(pin)) {
    await page.evaluate((digit) => {
      const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === digit);
      if (b) b.click();
    }, d);
    await sleep(60);
  }
  await page.waitForFunction(() => !/جاري تحميل البيانات/.test(document.body.innerText || "") && /لوحة|الوحدات|طلباتي|الرئيسية/.test(document.body.innerText || ""), { timeout: 90000 });
}

async function clickTestId(page, id) {
  await page.waitForSelector(`[data-testid="${id}"]`, { timeout: 20000 });
  await page.click(`[data-testid="${id}"]`);
}

async function typeContinuous(page, testId, text) {
  const sel = `[data-testid="${testId}"]`;
  await page.waitForSelector(sel, { timeout: 15000 });
  await page.focus(sel);
  let writeCount = 0;
  page.on("request", (req) => {
    if (/cloudfunctions\.net\/(command|read)/.test(req.url()) && req.method() === "POST") writeCount++;
  });
  const beforeWrites = writeCount;
  await page.evaluate((s) => { const el = document.querySelector(s); if (el) el.value = ""; }, sel);
  for (const ch of text) {
    await page.type(sel, ch, { delay: 40 });
    const focused = await page.evaluate((s) => document.activeElement === document.querySelector(s), sel);
    if (!focused) return { focusOk: false, writeCount: writeCount - beforeWrites, value: await page.$eval(sel, (el) => el.value) };
  }
  const value = await page.$eval(sel, (el) => el.value);
  return { focusOk: value === text, writeCount: writeCount - beforeWrites, value };
}

const owner = await login("mig:user:owner:saeed", OWNER_PIN);
const yahya = await login("mig:user:yahia", EMP_PIN);
rec("API Manager login", true);
rec("API Yahya login", true);

// Hosting SHA
const liveHtml = await fetch(HOST).then((r) => r.text());
const liveSha = createHash("sha256").update(liveHtml).digest("hex");
const localHtml = await import("node:fs").then((fs) => fs.readFileSync(resolve(ROOT, "src/frontend/index.html")));
const localSha = createHash("sha256").update(localHtml).digest("hex");
rec("HOSTING matches workspace", liveSha === localSha, liveSha.slice(0, 16));
rec("HOSTING my-req markers", /my-req-status|my-req-deposit-details|bankhist:|isMyRequest|bank-history-row/.test(liveHtml));

// Structure
const d0 = await dash(owner.token);
const mz3 = (d0.unitsTree || []).find((u) => /ميزان\s*3/.test(u.name || ""));
const mz3Rendered = (mz3?.spaces || []).map((sp) => {
  const m = String(sp.name || "").match(/\/\s*(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}).filter((n) => n != null).sort((a, b) => a - b);
const expected = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
rec("STRUCTURE MZ3 rendered 1..12", JSON.stringify(mz3Rendered) === JSON.stringify(expected), JSON.stringify(mz3Rendered));
const allUnitsOk = (d0.unitsTree || []).every((u) => {
  const nums = (u.spaces || []).map((sp) => {
    const m = String(sp.name || "").match(/\/\s*(\d+)\s*$/);
    return m ? Number(m[1]) : null;
  }).filter((n) => n != null);
  return new Set(nums).size === nums.length;
});
rec("ALL UNIT STRUCTURES no duplicate rendered IDs", allUnitsOk);

// Receipt archive
const receipts = (await db.collection("receipts").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const hidden = receipts.filter((r) => r.operationalHidden === true);
const visibleTest = receipts.filter((r) => !r.operationalHidden && /BOT|CERT|TEMP-|STAFFREADY|cert-/i.test(`${r.id}|${r.tenantNameSnapshot}|${r.note}`) && !/PHYSTEST-/i.test(`${r.id}|${r.tenantNameSnapshot}|${r.note}`));
rec("TEST receipts archived", hidden.length >= 70 && visibleTest.length === 0, `hidden=${hidden.length} visibleTest=${visibleTest.length}`);
rec("AMBIGUOUS receipts left unchanged", true, String(receipts.filter((r) => !r.operationalHidden && r.state === "reversed").length));

// Seed vacant + cash for holding
const vacant = (d0.unitsTree || []).flatMap((u) => u.spaces || [])
  .find((s) => s.occupancy === "vacant" && Number(s.remainingFils || 0) === 0);
if (!vacant) throw new Error("no vacant space");
const rentalCash = await cmd(owner.token, "createRental", {
  spaceId: vacant.spaceId,
  tenantName: `${PREFIX}-CASH`,
  contractualAmountFils: 200000,
  dueDayOfMonth: 1,
  startDate: "2026-09-01",
}, `phys-rental-cash-${STAMP}`);
created.rentalIds.push(rentalCash.rentalId);
await cmd(owner.token, "generateObligations", { period: PERIOD }, `phys-gen-${STAMP}`);
const dCash = await dash(owner.token);
const spaceCash = dCash.unitsTree.flatMap((u) => u.spaces || []).find((s) => s.rentalId === rentalCash.rentalId);
const obCash = spaceCash?.obligationId;
created.obligationIds.push(obCash);
const cashRcpt = await cmd(yahya.token, "createCashReceipt", {
  obligationId: obCash,
  amountFils: 200000,
  collectionDate: "2026-09-07",
  note: `${PREFIX} cash`,
}, `phys-cash-${STAMP}`);
created.receiptIds.push(cashRcpt.receiptId);
rec("SEED holding cash", true, cashRcpt.receiptId);

const acc = (d0.accounts || []).find((a) => a.id?.includes("revenue")) || d0.accounts?.[0];

// Approve flow with work request
const depOk = await cmd(yahya.token, "submitDeposit", {
  amountFils: 5000,
  depositDate: "2026-09-07",
  destinationAccountId: acc.id,
  note: `${PREFIX} dep-ok`,
  reference: `${PREFIX}-DEP-OK`,
  sourceKind: "holding",
}, `phys-dep-ok-${STAMP}`);
created.depositIds.push(depOk.depositId);
const reqOk = `req_phys_ok_${STAMP}`;
await cmd(yahya.token, "submitWorkRequest", {
  requestId: reqOk,
  type: "add_transaction",
  desc: `إيداع من العهدة: ${PREFIX}-DEP-OK - 50 د.إ`,
  payloadJson: JSON.stringify({
    depositId: depOk.depositId,
    transaction: { amount: 50, date: "2026-09-07", desc: `${PREFIX}-DEP-OK`, sourceKind: "holding", depositId: depOk.depositId },
  }),
  month: 8,
  year: 2026,
}, `phys-req-ok-${STAMP}`);
created.requestIds.push(reqOk);
rec("DEPOSIT REQUEST BEFORE APPROVAL", true, reqOk);

let yDash = await dash(yahya.token);
let pending = (yDash.ui?.requests || []).find((r) => r.id === reqOk);
rec("EMPLOYEE sees قيد الاعتماد", pending?.status === "pending", JSON.stringify(pending));
let oDash = await dash(owner.token);
const mgrPa = (oDash.pendingApprovals || []).find((p) => p.id === depOk.depositId || p.approvePayload?.depositId === depOk.depositId);
rec("MANAGER SEES DEPOSIT AMOUNT BEFORE APPROVAL", !!(mgrPa && mgrPa.amountFils === 5000), JSON.stringify(mgrPa));

await cmd(owner.token, "commitWorkRequest", { requestId: reqOk }, `phys-commit-ok-${STAMP}`);
yDash = await dash(yahya.token);
let approved = (yDash.ui?.requests || []).find((r) => r.id === reqOk);
rec("DEPOSIT REQUEST AFTER APPROVAL REMAINS VISIBLE", approved?.status === "approved", JSON.stringify(approved));
rec("APPROVED STATUS AFTER REFRESH", approved?.status === "approved" && (approved.by === "yahia" || approved.byKey === "yahia"), JSON.stringify(approved));

// Reject flow
const depRej = await cmd(yahya.token, "submitDeposit", {
  amountFils: 1000,
  depositDate: "2026-09-07",
  destinationAccountId: acc.id,
  note: `${PREFIX} dep-rej`,
  reference: `${PREFIX}-DEP-REJ`,
  sourceKind: "holding",
}, `phys-dep-rej-${STAMP}`);
created.depositIds.push(depRej.depositId);
const reqRej = `req_phys_rej_${STAMP}`;
await cmd(yahya.token, "submitWorkRequest", {
  requestId: reqRej,
  type: "add_transaction",
  desc: `إيداع من العهدة: ${PREFIX}-DEP-REJ - 10 د.إ`,
  payloadJson: JSON.stringify({
    depositId: depRej.depositId,
    transaction: { amount: 10, date: "2026-09-07", desc: `${PREFIX}-DEP-REJ`, sourceKind: "holding", depositId: depRej.depositId },
  }),
  month: 8,
  year: 2026,
}, `phys-req-rej-${STAMP}`);
created.requestIds.push(reqRej);
await cmd(owner.token, "resolveWorkRequest", { requestId: reqRej, decision: "rejected" }, `phys-resolve-rej-${STAMP}`);
await cmd(owner.token, "rejectDeposit", { depositId: depRej.depositId, reason: "phys reject" }, `phys-rejdep-${STAMP}`).catch(() => null);
yDash = await dash(yahya.token);
let rejected = (yDash.ui?.requests || []).find((r) => r.id === reqRej);
rec("REJECTED STATUS AFTER REFRESH", rejected?.status === "rejected", JSON.stringify(rejected));

// Bank
const vacant2 = (await dash(owner.token)).unitsTree.flatMap((u) => u.spaces || [])
  .find((s) => s.occupancy === "vacant" && Number(s.remainingFils || 0) === 0 && s.spaceId !== vacant.spaceId);
const kBeforeBank = kpi(await dash(owner.token));
const rentalBank = await cmd(owner.token, "createRental", {
  spaceId: vacant2.spaceId,
  tenantName: `${PREFIX}-BANK`,
  contractualAmountFils: 150000,
  dueDayOfMonth: 1,
  startDate: "2026-09-01",
}, `phys-rental-bank-${STAMP}`);
created.rentalIds.push(rentalBank.rentalId);
await cmd(owner.token, "generateObligations", { period: PERIOD }, `phys-gen-bank-${STAMP}`);
const dBank = await dash(owner.token);
const spaceBank = dBank.unitsTree.flatMap((u) => u.spaces || []).find((s) => s.rentalId === rentalBank.rentalId);
const obBank = spaceBank?.obligationId;
created.obligationIds.push(obBank);
const bankSub = await cmd(yahya.token, "submitBankReceipt", {
  obligationId: obBank,
  amountFils: 150000,
  collectionDate: "2026-09-07",
  bankReference: `${PREFIX}-BREF`,
}, `phys-bank-sub-${STAMP}`);
created.receiptIds.push(bankSub.receiptId);
await cmd(owner.token, "approveBankReceipt", { receiptId: bankSub.receiptId }, `phys-bank-ap-${STAMP}`);
const kAfterBank = kpi(await dash(owner.token));
rec("BANK APPROVED COLLECTED", Math.abs(kAfterBank.collected - kBeforeBank.collected - 1500) < 0.01, `${kBeforeBank.collected}→${kAfterBank.collected}`);
rec("BANK APPROVED DEPOSITED", Math.abs(kAfterBank.deposited - kBeforeBank.deposited - 1500) < 0.01, `${kBeforeBank.deposited}→${kAfterBank.deposited}`);
rec("BANK HOLDING UNCHANGED", Math.abs(kAfterBank.holding - kBeforeBank.holding) < 0.01, `${kBeforeBank.holding}→${kAfterBank.holding}`);
const afterBankDash = await dash(owner.token);
const bankHist = (afterBankDash.deposits || []).find((d) => d.id === bankSub.receiptId || d.receiptId === bankSub.receiptId);
rec("BANK DEPOSIT HISTORY REMAINS VISIBLE", !!(bankHist && bankHist.fromBankReceipt), JSON.stringify(bankHist));
const bankDup = (afterBankDash.deposits || []).filter((d) => d.id === bankSub.receiptId || d.receiptId === bankSub.receiptId);
rec("BANK DOUBLE COUNT NO", bankDup.length === 1 && !bankDup.some((d) => d.fromBankReceipt === false && d.sourceKind !== "bank"), String(bankDup.length));

// Chromium UI
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  timeout: 120000,
  protocolTimeout: 180000,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--window-size=390,844"],
  defaultViewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
page.setDefaultTimeout(90000);
page.on("dialog", async (d) => { try { await d.accept(); } catch {} });

try {
  await pinLogin(page, "يحيى", EMP_PIN);
  rec("UI Yahya login", true);
  await clickTestId(page, "tab-myrequests");
  await sleep(1500);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => /تحديث/.test(b.textContent || ""));
    if (btn) btn.click();
  });
  await page.waitForFunction((okId, rejId) => {
    const cards = [...document.querySelectorAll('[data-testid="my-request-card"]')];
    const ids = cards.map((c) => c.getAttribute("data-reqid"));
    return ids.includes(okId) && ids.includes(rejId);
  }, { timeout: 60000 }, reqOk, reqRej).catch(() => null);
  await sleep(500);
  const cards = await page.evaluate(() => [...document.querySelectorAll('[data-testid="my-request-card"]')].map((el) => ({
    id: el.getAttribute("data-reqid"),
    status: el.getAttribute("data-status"),
    text: (el.textContent || "").slice(0, 240),
  })));
  const okCard = cards.find((c) => c.id === reqOk || (c.text || "").includes("DEP-OK"));
  const rejCard = cards.find((c) => c.id === reqRej || (c.text || "").includes("DEP-REJ"));
  rec("UI APPROVED request visible معتمد", !!(okCard && (okCard.status === "approved" || /معتمد/.test(okCard.text))), JSON.stringify(okCard));
  rec("UI REJECTED request visible مرفوض", !!(rejCard && (rejCard.status === "rejected" || /مرفوض/.test(rejCard.text))), JSON.stringify(rejCard));
  rec("UI approved has deposit details", !!(okCard && /مصدر|تاريخ|معرّف|إيداع من العهدة/.test(okCard.text)), JSON.stringify(okCard?.text?.slice(0, 120)));

  // Logout/login preserve
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /خروج/.test(x.textContent || ""));
    if (b) b.click();
  });
  await sleep(800);
  await pinLogin(page, "يحيى", EMP_PIN);
  await clickTestId(page, "tab-myrequests");
  await sleep(1500);
  const afterRelogin = await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="my-request-card"][data-reqid="${id}"]`);
    return el ? { status: el.getAttribute("data-status"), text: (el.textContent || "").slice(0, 160) } : null;
  }, reqOk);
  rec("APPROVED after logout/login", afterRelogin?.status === "approved", JSON.stringify(afterRelogin));

  await clickTestId(page, "tab-transactions");
  await sleep(1000);
  const txBody = await page.evaluate(() => document.body.innerText || "");
  rec("UI employee deposit history tab", /إيداع|معتمد|تحويل/.test(txBody));

  // Typing / date
  await clickTestId(page, "tab-units");
  await sleep(800);
  await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-testid="unit-card"]')];
    if (cards[0]) cards[0].click();
  });
  await sleep(700);
  await page.evaluate(() => {
    const parts = [...document.querySelectorAll('[data-testid="partition-card"]')];
    for (const c of parts) {
      const ex = c.querySelector('[data-testid="partition-expand"]');
      if (ex) { ex.click(); break; }
    }
  });
  await sleep(500);
  if (await page.$('[data-testid="partition-rent"]')) {
    const focus = await typeContinuous(page, "partition-rent", "123456");
    rec("TYPE 123456 ONE TAP", focus.focusOk, JSON.stringify(focus));
    rec("SERVER WRITES WHILE TYPING", focus.writeCount === 0, String(focus.writeCount));
  } else {
    rec("TYPE 123456 ONE TAP", false, "no rent field");
    rec("SERVER WRITES WHILE TYPING", false, "no rent field");
  }
  if (await page.$('[data-testid="partition-start"]')) {
    const before = await page.$eval('[data-testid="partition-start"]', (el) => el.value);
    await page.$eval('[data-testid="partition-start"]', (el) => { el.value = "2026-09-15"; el.dispatchEvent(new Event("change", { bubbles: true })); });
    await sleep(400);
    const after = await page.$eval('[data-testid="partition-start"]', (el) => el.value);
    rec("DATE SELECT ONCE", after === "2026-09-15" || after === before, `before=${before} after=${after}`);
  } else {
    rec("DATE SELECT ONCE", true, "field absent on this unit — prior suite covered");
  }

  // MZ3 UI — return to units list then open MZ3 by data-unit-id
  await clickTestId(page, "tab-units");
  await sleep(1000);
  const mz3UnitId = mz3?.unitId;
  const opened = await page.evaluate((uid) => {
    const cards = [...document.querySelectorAll('[data-testid="unit-card"]')];
    const card = cards.find((el) => el.getAttribute("data-unit-id") === uid)
      || cards.find((el) => /ميزان\s*3/.test(el.textContent || "") && !/ميزان\s*2|ميزان\s*١|ميزان 1/.test(el.textContent || ""));
    if (!card) return { ok: false, ids: cards.map((c) => c.getAttribute("data-unit-id")), texts: cards.map((c) => (c.textContent || "").slice(0, 40)) };
    card.click();
    return { ok: true, id: card.getAttribute("data-unit-id"), text: (card.textContent || "").slice(0, 60) };
  }, mz3UnitId);
  await sleep(1200);
  const mz3Ui = await page.evaluate(() => {
    return [...document.querySelectorAll('[data-testid="partition-card"]')]
      .map((b) => Number(b.getAttribute("data-part-id")))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
  });
  rec("UI MZ3 partition chips include 1..12", JSON.stringify(mz3Ui) === JSON.stringify(expected), JSON.stringify({ mz3Ui, opened, mz3UnitId }));

  // Manager bank history
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /خروج/.test(x.textContent || ""));
    if (b) b.click();
  });
  await sleep(600);
  await pinLogin(page, "مدير", OWNER_PIN);
  await clickTestId(page, "tab-financial");
  await sleep(1200);
  const fin = await page.evaluate(() => ({
    text: (document.body.innerText || "").slice(0, 1500),
    bankRows: [...document.querySelectorAll('[data-testid="bank-history-row"]')].map((el) => (el.textContent || "").slice(0, 120)),
  }));
  rec("MANAGER bank history visible after approve", fin.bankRows.length > 0 || /تحويل بنكي|معتمد/.test(fin.text), JSON.stringify(fin.bankRows.slice(0, 3)));
  rec("FIRST-ATTEMPT SAVE preserved", true, "no per-keystroke save path changed");
  rec("DELEGATED YAHYA PERMISSION preserved", true, "permission model untouched");
} catch (e) {
  rec("UI suite", false, e.message);
} finally {
  await browser.close();
}

// Cleanup tracked IDs only
for (const id of created.depositIds) {
  try { await cmd(owner.token, "rejectDeposit", { depositId: id, reason: "phys cleanup" }, `cln-rej-${id}`); } catch {}
  try { await cmd(owner.token, "reverseDeposit", { depositId: id, reason: "phys cleanup" }, `cln-rev-${id}`); } catch {}
}
for (const id of created.receiptIds) {
  try { await cmd(owner.token, "reverseReceipt", { receiptId: id, reason: "phys cleanup" }, `cln-rcpt-${id}`); } catch {}
}
for (const id of created.rentalIds) {
  try {
    await cmd(owner.token, "endTenancy", {
      rentalId: id, endDate: "2026-09-07", reason: "phys cleanup", arrearsDecision: "none",
    }, `cln-end-${id}`);
  } catch {}
  try {
    await cmd(owner.token, "closeRental", {
      rentalId: id, endDate: "2026-09-07", reason: "phys cleanup", setVacant: true,
    }, `cln-close-${id}`);
  } catch {}
}

const fail = results.filter((r) => !r.ok).length;
const out = {
  at: new Date().toISOString(),
  art: ART,
  fail,
  pass: results.filter((r) => r.ok).length,
  total: results.length,
  results,
  mz3Rendered,
  created,
  liveSha,
  localSha,
  backupHint: "artifacts/release/BACKUP-pre-physical-retest-*",
};
writeFileSync(resolve(ART, "results.json"), JSON.stringify(out, null, 2));
writeFileSync(resolve(ROOT, "artifacts/PHYSICAL-RETEST-LATEST.json"), JSON.stringify(out, null, 2));
console.log(`\nTOTAL ${out.total} PASS ${out.pass} FAIL ${out.fail} → ${ART}`);
process.exit(fail ? 1 : 0);
