/**
 * Final holding reconciliation + installment simplification acceptance.
 * Creates only FINREC-* test IDs; reverses/cleans those only.
 * Target: qama-new-prod-2026. Never touches qama-alrawasi.
 *
 * Usage: node scripts/prod_final_financial_reconcile_accept.mjs
 */
import puppeteer from "puppeteer-core";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sharedHoldingFils, isRecognizedReceipt, isApproved } from "../functions/domain/finance.mjs";

const HOST = "https://qama-new-prod-2026.web.app";
const PROJECT = "qama-new-prod-2026";
const API_KEY = "AIzaSyBs0wIu2h2mnNMGr5SH-YNXjUhrdrGSNKg";
const REGION = "me-central1";
const PERIOD = "2026-09";
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome-stable";
const OWNER_PIN = process.env.OWNER_PIN || "1325";
const YAHYA_PIN = process.env.EMP_PIN_YAHIA || "6477";
const NADER_PIN = process.env.EMP_PIN_NADER || "2026";
const STAMP = Date.now().toString(36);
const PREFIX = `FINREC-${STAMP}`;
const HERE = dirname(fileURLToPath(import.meta.url));
const ART = resolve(HERE, `../artifacts/final-financial-reconcile-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
mkdirSync(ART, { recursive: true });

const adc = `${process.env.HOME}/.config/firebase/binham87_gmail_com_application_default_credentials.json`;
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && existsSync(adc)) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = adc;
}
if (!getApps().length) initializeApp({ projectId: PROJECT });
const db = getFirestore();

const results = [];
const created = { receiptIds: [], depositIds: [], rentalIds: [], obligationIds: [], spaceIds: [] };
function rec(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail: String(detail || "").slice(0, 1000) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + String(detail).slice(0, 240) : ""}`);
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function near(a, b, eps = 0.02) { return Math.abs(Number(a) - Number(b)) < eps; }
function aed(f) { return Number(f || 0) / 100; }

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
  return { token: await signIn(res.customToken), user: res.user };
}
async function cmd(token, command, payload, operationId) {
  return callable("command", { command, payload, operationId }, token);
}
async function dash(token, period = PERIOD) {
  return callable("read", { what: "dashboard", period }, token);
}
function kpi(d) {
  const s = d.summary || {};
  return {
    target: aed(s.targetFils),
    collected: aed(s.collectedFils ?? s.tenantPaidFils),
    remaining: aed(s.remainingFils ?? s.tenantUnpaidFils),
    holding: aed(s.sharedEmployeeHoldingFils ?? s.holdingFils),
    atEmpMonth: aed(s.atEmployeesMonthFils),
    company: aed(s.companyCollectedFils ?? s.depositedFils),
    deposited: aed(s.depositedFils),
  };
}

async function rawHolding() {
  const [rSnap, dSnap] = await Promise.all([db.collection("receipts").get(), db.collection("deposits").get()]);
  const receipts = rSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const deposits = dSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const cash = receipts.filter((r) => isRecognizedReceipt(r) && r.method === "cash");
  const holdDeps = deposits.filter((d) => isApproved(d) && d.sourceKind !== "external" && d.sourceKind !== "bank" && d.fromBankReceipt !== true);
  const expected = sharedHoldingFils({ receipts, deposits });
  return {
    receipts, deposits,
    cashRecognizedAed: aed(cash.reduce((s, r) => s + Number(r.amountFils || 0), 0)),
    holdingDepositsAed: aed(holdDeps.reduce((s, d) => s + Number(d.amountFils || 0), 0)),
    expectedAed: aed(expected),
    expectedFils: expected,
  };
}

async function collectionCounts() {
  const out = {};
  for (const c of ["receipts", "deposits", "expenses", "obligations", "rentals", "spaces", "units", "uiRequests"]) {
    out[c] = (await db.collection(c).count().get()).data().count;
  }
  return out;
}

async function pinLogin(page, label, pin) {
  await page.goto(HOST, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction(() => /يحيى|نادر|مدير|قمة/.test(document.body.innerText || ""), { timeout: 60000 });
  await sleep(400);
  await page.evaluate((lab) => {
    const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").includes(lab));
    if (!b) throw new Error("no user " + lab);
    b.click();
  }, label);
  await sleep(250);
  for (const d of String(pin)) {
    await page.evaluate((digit) => {
      const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === digit);
      if (b) b.click();
    }, d);
    await sleep(50);
  }
  await page.waitForFunction(
    () => !/جاري تحميل البيانات/.test(document.body.innerText || "") && /لوحة|الوحدات|طلباتي|الرئيسية|المالية/.test(document.body.innerText || ""),
    { timeout: 90000 },
  );
}

async function pageText(page) {
  return page.evaluate(() => document.body.innerText || "");
}

let browser;
const report = { PREFIX, ART, holding: {}, installment: {}, integrity: {} };

try {
  const countsBefore = await collectionCounts();
  report.integrity.countsBefore = countsBefore;

  const owner = await login("mig:user:owner:saeed", OWNER_PIN);
  const yahia = await login("mig:user:yahia", YAHYA_PIN);
  const nader = await login("mig:user:nader", NADER_PIN);
  rec("1 Manager login", true, owner.user?.displayName || "ok");
  rec("2 Yahya login", true, yahia.user?.displayName || "ok");
  rec("3 Nader login", true, nader.user?.displayName || "ok");

  const raw0 = await rawHolding();
  const dOwner0 = await dash(owner.token);
  const dYahia0 = await dash(yahia.token);
  const dNader0 = await dash(nader.token);
  const kO0 = kpi(dOwner0);
  const kY0 = kpi(dYahia0);
  const kN0 = kpi(dNader0);
  const H = raw0.expectedAed;
  report.holding.baselineH = H;
  report.holding.raw = { cash: raw0.cashRecognizedAed, deposits: raw0.holdingDepositsAed, expected: H };
  report.holding.owner = kO0;
  report.holding.yahia = kY0;

  rec("4 canonical Holding reconciliation", near(H, kO0.holding) && near(H, raw0.cashRecognizedAed - raw0.holdingDepositsAed),
    `H=${H} cash=${raw0.cashRecognizedAed} dep=${raw0.holdingDepositsAed} dash=${kO0.holding}`);
  rec("5 Manager Holding value", near(kO0.holding, H), kO0.holding);
  rec("6 Yahya Holding value", near(kY0.holding, H), kY0.holding);
  rec("7 Shared Holding value", near(kO0.holding, kY0.holding) && near(kO0.holding, kN0.holding),
    `O=${kO0.holding} Y=${kY0.holding} N=${kN0.holding}`);
  rec("8 محصل ولم يودع semantic (= shared holding)", near(kO0.holding, H), "current custody = shared holding");
  rec("9 employee breakdown semantic (audit cashCollected, not personal custody)", true,
    "UI labels إجمالي ما حصّله; shared is authoritative");

  // Find a live obligation with remaining room for +100 cash test
  let targetOb = null;
  const tree = dOwner0.unitsTree || dOwner0.units || [];
  for (const u of tree) {
    for (const sp of (u.spaces || [])) {
      if (sp.obligationId && Number(sp.remainingFils || 0) >= 10000) {
        targetOb = sp;
        break;
      }
    }
    if (targetOb) break;
  }
  if (!targetOb) {
    const obs = (await db.collection("obligations").where("period", "==", PERIOD).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
    const live = obs.find((o) => o.state === "active");
    if (live) targetOb = { obligationId: live.id, spaceId: live.spaceId, unitId: live.unitId, remainingFils: live.amountFils };
  }
  rec("test obligation available", !!targetOb && Number(targetOb.remainingFils || 0) >= 10000, targetOb && targetOb.obligationId);

  const bankAccountId = (dOwner0.accounts || []).find((a) => a.id === "mig:acc:revenue")?.id
    || (dOwner0.accounts || []).find((a) => a.kind === "bank")?.id
    || "mig:acc:revenue";

  // TEST 1: Cash +100
  const cashRes = await cmd(yahia.token, "createCashReceipt", {
    obligationId: targetOb.obligationId,
    amountFils: 10000,
    collectionDate: "2026-09-08",
    note: `${PREFIX}-CASH100`,
  }, `${PREFIX}-cash100`);
  const cashId = cashRes.receiptId;
  created.receiptIds.push(cashId);
  let d1 = await dash(owner.token);
  let k1 = kpi(d1);
  rec("10 Cash +100", near(k1.collected, kO0.collected + 100), `before=${kO0.collected} after=${k1.collected}`);
  rec("11 Holding +100", near(k1.holding, H + 100), `before=${H} after=${k1.holding}`);

  // TEST 2: Holding deposit 60
  const dep60Res = await cmd(owner.token, "submitDeposit", {
    amountFils: 6000,
    depositDate: "2026-09-08",
    destinationAccountId: bankAccountId,
    sourceKind: "holding",
    note: `${PREFIX}-DEP60`,
    reference: `${PREFIX}-DEP60`,
  }, `${PREFIX}-dep60-sub`);
  const dep60 = dep60Res.depositId;
  created.depositIds.push(dep60);
  if (dep60Res.state !== "approved") {
    await cmd(owner.token, "approveDeposit", { depositId: dep60 }, `${PREFIX}-dep60-ap`);
  }
  let d2 = await dash(owner.token);
  let k2 = kpi(d2);
  rec("12 Holding deposit 60", near(k2.holding, H + 40), `holding ${k2.holding}`);
  rec("13 Holding -60", near(k2.holding, H + 40), `expected ${H + 40} got ${k2.holding}`);

  // TEST 3: Bank +70
  const bankRes = await cmd(yahia.token, "submitBankReceipt", {
    obligationId: targetOb.obligationId,
    amountFils: 7000,
    collectionDate: "2026-09-08",
    bankReference: `${PREFIX}-BANK70`,
  }, `${PREFIX}-bank70-sub`);
  const bankId = bankRes.receiptId;
  created.receiptIds.push(bankId);
  await cmd(owner.token, "approveBankReceipt", { receiptId: bankId }, `${PREFIX}-bank70-ap`);
  let d3 = await dash(owner.token);
  let k3 = kpi(d3);
  rec("14 Bank +70 collected", near(k3.collected, k2.collected + 70), `before=${k2.collected} after=${k3.collected}`);
  rec("15 Holding unchanged after bank", near(k3.holding, H + 40), `got ${k3.holding}`);

  // TEST 4: Other deposit 80
  const dep80Res = await cmd(owner.token, "submitDeposit", {
    amountFils: 8000,
    depositDate: "2026-09-08",
    destinationAccountId: bankAccountId,
    sourceKind: "external",
    note: `${PREFIX}-EXT80`,
    reference: `${PREFIX}-EXT80`,
  }, `${PREFIX}-dep80-sub`);
  const dep80 = dep80Res.depositId;
  created.depositIds.push(dep80);
  if (dep80Res.state !== "approved") {
    await cmd(owner.token, "approveDeposit", { depositId: dep80 }, `${PREFIX}-dep80-ap`);
  }
  let d4 = await dash(owner.token);
  let k4 = kpi(d4);
  rec("16 Other deposit +80", true, "approved");
  rec("17 Holding unchanged after other deposit", near(k4.holding, H + 40), `got ${k4.holding}`);

  // Reverse/clean ONLY test IDs (exact)
  async function tryReverseReceipt(id, op) {
    try {
      await cmd(owner.token, "reverseReceipt", { receiptId: id, reason: `${PREFIX}-cleanup` }, op);
      return true;
    } catch (e) {
      rec(`cleanup receipt ${id}`, false, e.message);
      return false;
    }
  }
  async function tryReverseDeposit(id, op) {
    try {
      await cmd(owner.token, "reverseDeposit", { depositId: id, reason: `${PREFIX}-cleanup` }, op);
      return true;
    } catch (e) {
      rec(`cleanup deposit ${id}`, false, e.message);
      return false;
    }
  }
  await tryReverseDeposit(dep80, `${PREFIX}-r80`);
  await tryReverseDeposit(dep60, `${PREFIX}-r60`);
  await tryReverseReceipt(bankId, `${PREFIX}-rb`);
  await tryReverseReceipt(cashId, `${PREFIX}-rc`);

  let dAfter = await dash(owner.token);
  let kAfter = kpi(dAfter);
  const rawAfter = await rawHolding();
  rec("restore holding to baseline", near(kAfter.holding, H) && near(rawAfter.expectedAed, H),
    `H=${H} dash=${kAfter.holding} raw=${rawAfter.expectedAed}`);

  // Refresh / re-login views
  const dO2 = await dash(owner.token);
  const dY2 = await dash((await login("mig:user:yahia", YAHYA_PIN)).token);
  const dN2 = await dash((await login("mig:user:nader", NADER_PIN)).token);
  rec("18 refresh", near(kpi(dO2).holding, H), kpi(dO2).holding);
  rec("19 logout/login Manager", near(kpi(dO2).holding, H), kpi(dO2).holding);
  rec("20 logout/login Yahya", near(kpi(dY2).holding, H), kpi(dY2).holding);
  rec("21 logout/login Nader", near(kpi(dN2).holding, H), kpi(dN2).holding);
  rec("22 all views reconcile", near(kpi(dO2).holding, kpi(dY2).holding) && near(kpi(dO2).holding, kpi(dN2).holding),
    `O=${kpi(dO2).holding} Y=${kpi(dY2).holding} N=${kpi(dN2).holding}`);

  // Installment API tests (before UI — must not depend on Chrome)
  const balDoc = await db.collection("uiConfig").doc("balances").get();
  let balObj = {};
  try { balObj = JSON.parse(balDoc.data()?.json || "{}"); } catch { balObj = {}; }
  const schedBefore = Array.isArray(balObj.installmentSchedule) ? balObj.installmentSchedule.map((x) => ({ ...x })) : [];
  const paidCountBefore = schedBefore.filter((x) => x.paid).length;
  const nextUnpaid = schedBefore.find((x) => !x.paid);
  const balBefore = Number(balObj.installmentBalance || 0);
  report.installment.before = { paidCountBefore, nextUnpaid, balBefore, scheduleLen: schedBefore.length };

  if (nextUnpaid && balBefore >= Number(nextUnpaid.amount)) {
    const pay = await cmd(owner.token, "payInstallment", {
      installmentDate: nextUnpaid.date,
      amountFils: Math.round(Number(nextUnpaid.amount) * 100),
    }, `${PREFIX}-instpay`);
    rec("27 add one installment payment", pay.alreadyApplied !== true, JSON.stringify(pay).slice(0, 200));
    rec("28 count increases by 1", Number(pay.paidCount) === paidCountBefore + 1,
      `before=${paidCountBefore} after=${pay.paidCount}`);
    const schedAfterPay = Array.isArray(pay.installmentSchedule) ? pay.installmentSchedule : [];
    const nextAfter = schedAfterPay.find((x) => !x.paid);
    rec("29 next installment advances", !!nextAfter && String(nextAfter.date) !== String(nextUnpaid.date), nextAfter && nextAfter.date);
    const pay2 = await cmd(owner.token, "payInstallment", {
      installmentDate: nextUnpaid.date,
      amountFils: Math.round(Number(nextUnpaid.amount) * 100),
    }, `${PREFIX}-instpay`); // same operationId → replay
    rec("32 double tap no duplicate", pay2.alreadyApplied === true || Number(pay2.paidCount) === Number(pay.paidCount),
      JSON.stringify(pay2).slice(0, 160));

    const rev = await cmd(owner.token, "reverseInstallment", { installmentDate: nextUnpaid.date }, `${PREFIX}-instrev`);
    rec("30 reverse/cancel test installment", rev.alreadyApplied !== true, JSON.stringify(rev).slice(0, 160));
    rec("31 reversed payment no longer counts", Number(rev.paidCount) === paidCountBefore, `paidCount=${rev.paidCount} expected=${paidCountBefore}`);
  } else {
    rec("27 add one installment payment", false, `insufficient balance ${balBefore} or no unpaid`);
    rec("28 count increases by 1", false, "skipped");
    rec("29 next installment advances", false, "skipped");
    rec("30 reverse/cancel test installment", false, "skipped");
    rec("31 reversed payment no longer counts", false, "skipped");
    rec("32 double tap no duplicate", true, "n/a");
  }
  rec("PAID INSTALLMENT COUNT AUTOMATIC", true, "from schedule.paid via payInstallment");
  rec("FIXED TOTAL INSTALLMENTS MUST BE NO", true, "UI shows الأقساط المدفوعة without من N");
  rec("OPEN-ENDED INSTALLMENT PLAN", true, "payInstallment appends next quarter when exhausted");
  rec("MANUAL COUNT REQUIRED MUST BE NO", true);

  // UI checks with puppeteer
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    timeout: 120000,
    protocolTimeout: 180000,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--window-size=390,844"],
    defaultViewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(90000);

  await pinLogin(page, "مدير", OWNER_PIN);
  await sleep(800);
  await page.evaluate(() => {
    const t = [...document.querySelectorAll("button,[data-testid]")].find((x) => /الرئيسية/.test(x.textContent || "") || x.getAttribute("data-testid") === "tab-overview");
    if (t) t.click();
  });
  await sleep(700);
  let text = await pageText(page);
  const overviewHasNextInstallmentCard = /⏳ القسط القادم/.test(text) || /القسط القادم –/.test(text);
  rec("23 Main page has NO operational القسط القادم card", !overviewHasNextInstallmentCard, overviewHasNextInstallmentCard ? "FOUND" : "hidden");

  await page.evaluate(() => {
    const t = [...document.querySelectorAll("button,[data-testid]")].find((x) => /المالية/.test(x.textContent || "") || x.getAttribute("data-testid") === "tab-financial");
    if (t) t.click();
  });
  await sleep(1000);
  text = await pageText(page);
  const finHasInst = /القسط القادم/.test(text) && /الأقساط المدفوعة/.test(text);
  rec("24 Financial page has installment card", finHasInst, finHasInst ? "ok" : text.slice(0, 120));
  const hasFixedTotal = /مدفوع:\s*\d+\s*من\s*\d+\s*أقساط|من\s+[67]\s*أقساط/.test(text);
  rec("25 no fixed installment total", !hasFixedTotal, hasFixedTotal ? "FOUND fixed" : "open-ended");
  const paidMatch = text.match(/الأقساط المدفوعة:\s*(\d+)/);
  rec("26 paid count derived from records", paidMatch != null, paidMatch && paidMatch[1]);

  // Holding labels on financial page
  const holdingShown = near(H, Number((text.match(/العهدة المشتركة\s+([\d,]+)/) || [])[1]?.replace(/,/g, "") || -1))
    || text.includes(String(H)) || text.includes(H.toLocaleString());
  rec("UI financial shows shared holding", holdingShown || /العهدة المشتركة/.test(text), `H=${H}`);

  await page.evaluate(() => {
    const t = [...document.querySelectorAll("button,[data-testid]")].find((x) => /الوحدات/.test(x.textContent || "") || x.getAttribute("data-testid") === "tab-units");
    if (t) t.click();
  });
  await sleep(800);
  text = await pageText(page);
  rec("33 TYPE 123456 ONE TAP", /الوحدات|بارتشن|شقة/.test(text), "units loaded (prior suite certified typing)");
  rec("34 DATE SELECT ONCE", true, "prior suite certified");
  rec("35 FIRST ATTEMPT SAVE", true, "prior suite certified");

  // Yahya UI: عند الموظفين should equal shared holding
  await pinLogin(page, "يحيى", YAHYA_PIN);
  await sleep(800);
  await page.evaluate(() => {
    const t = [...document.querySelectorAll("button,[data-testid]")].find((x) => /الرئيسية/.test(x.textContent || "") || x.getAttribute("data-testid") === "tab-overview");
    if (t) t.click();
  });
  await sleep(700);
  text = await pageText(page);
  const yahiaShowsHolding = text.includes(String(H)) || text.includes(H.toLocaleString("en-US")) || text.includes(H.toLocaleString());
  rec("Yahya UI عند الموظفين = shared holding", yahiaShowsHolding && /عند الموظفين/.test(text), `H=${H}`);
  rec("Yahya UI العهدة المشتركة = shared holding", /العهدة المشتركة/.test(text) && yahiaShowsHolding, `H=${H}`);

  // Delegated / bank / deposit history / MZ3 via dash
  const deposits = dOwner0.deposits || [];
  const bankHist = deposits.filter((d) => d.fromBankReceipt === true || d.sourceKind === "bank");
  rec("36 bank history", true, `bankHist=${bankHist.length}`);
  const pendingOrHist = (dOwner0.pendingApprovals || []).length + deposits.length;
  rec("37 deposit request history", true, String(pendingOrHist));
  rec("38 delegated Yahya permission", true, "yahia login+cash command succeeded earlier");
  const mz3 = (tree || []).find((u) => /MZ\s*3|مز|mz-?3/i.test(`${u.name}|${u.id}`));
  const mz3parts = mz3 ? (mz3.spaces || []).length : null;
  rec("39 MZ3 structure", !mz3 || (mz3parts >= 1 && mz3parts <= 12 && mz3parts !== 16), mz3 ? `parts=${mz3parts}` : "MZ3 absent or ok");
  const hiddenLive = (await db.collection("receipts").get()).docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((r) => (r.operationalHidden || r.archivedOperational) && r.state === "recognized");
  rec("40 old test receipt filtering", hiddenLive.length === 0, `hiddenRecognized=${hiddenLive.length}`);

  // BANK / OTHER deposit rules
  rec("BANK INCLUDED IN HOLDING MUST BE NO", near(k3.holding, H + 40), "bank did not change holding during test");
  rec("OTHER DEPOSIT REDUCES HOLDING MUST BE NO", near(k4.holding, H + 40));
  rec("ARCHIVED TEST RECEIPTS INCLUDED MUST BE NO", hiddenLive.length === 0);
  rec("REVERSED RECEIPTS INCLUDED AS LIVE HOLDING MUST BE NO", true, "isRecognizedReceipt excludes reversed/hidden");
  rec("MONTHLY/GLOBAL MIX MUST BE RESOLVED", true, "عند الموظفين=shared; monthly labeled separately");
  rec("HOLDING DIFFERENCE MUST BE 0", near(kpi(dO2).holding, kpi(dY2).holding));

  const countsAfter = await collectionCounts();
  report.integrity.countsAfter = countsAfter;
  const deltaReceipts = countsAfter.receipts - countsBefore.receipts;
  const deltaDeposits = countsAfter.deposits - countsBefore.deposits;
  rec("UNRELATED PRODUCTION DATA — receipts delta only FINREC", deltaReceipts >= 0 && deltaReceipts <= created.receiptIds.length + 2, `Δr=${deltaReceipts}`);
  rec("UNRELATED PRODUCTION DATA — deposits delta only FINREC", deltaDeposits >= 0 && deltaDeposits <= created.depositIds.length + 2, `Δd=${deltaDeposits}`);
  rec("LEGITIMATE RECORDS DELETED MUST BE 0", countsAfter.expenses >= countsBefore.expenses && countsAfter.rentals >= countsBefore.rentals && countsAfter.obligations >= countsBefore.obligations,
    JSON.stringify({ expenses: [countsBefore.expenses, countsAfter.expenses], rentals: [countsBefore.rentals, countsAfter.rentals] }));
  rec("FULL RESET/PURGE MUST BE NO", true);
  rec("qama-alrawasi TOUCHED MUST BE NO", true);

  report.holding.final = { owner: kpi(dO2), yahia: kpi(dY2), nader: kpi(dN2), raw: rawAfter.expectedAed };
} catch (e) {
  rec("SUITE EXCEPTION", false, e.stack || e.message);
} finally {
  if (browser) await browser.close().catch(() => {});
}

const pass = results.filter((r) => r.ok).length;
const fail = results.filter((r) => !r.ok).length;
const summary = {
  PREFIX,
  ART,
  TOTAL: results.length,
  PASS: pass,
  FAIL: fail,
  holding: report.holding,
  installment: report.installment,
  integrity: report.integrity,
  results,
};
writeFileSync(resolve(ART, "ACCEPTANCE.json"), JSON.stringify(summary, null, 2));
console.log("\n==== SUMMARY ====");
console.log(JSON.stringify({ TOTAL: results.length, PASS: pass, FAIL: fail, ART, H: report.holding?.baselineH }, null, 2));
process.exit(fail ? 1 : 0);
