/**
 * Isolated browser check for the release units screen.
 * Runs only under the Firebase emulators. Never touches production.
 */
import { createRequire } from "node:module";
import { hashPin } from "../../functions/repositories/firestore.mjs";
import { executeCommand } from "../../functions/commands/index.mjs";
import { createFirestoreRepository } from "../../functions/repositories/firestore.mjs";

const project = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT || "";
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  throw new Error("browser workflow refused: emulator hosts are not set");
}
if (project === "qama-alrawasi") {
  throw new Error("browser workflow refused: legacy project");
}

const require = createRequire(new URL("../../package.json", import.meta.url));
const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ projectId: project || "qama-new" });
const firestore = admin.firestore();
firestore.settings({ ignoreUndefinedProperties: true });
const db = createFirestoreRepository(firestore);
const puppeteer = require("puppeteer-core");
const chromePath = process.env.CHROME_PATH
  || "/home/codespace/.cache/ms-playwright/chromium-1148/chrome-linux/chrome";

const results = [];
function note(step, ok, detail = "") {
  results.push({ step, ok, detail });
  console.log((ok ? "PASS" : "FAIL") + " " + step + (detail ? " — " + detail : ""));
  if (!ok) throw new Error(step + (detail ? ": " + detail : ""));
}

async function seedUser(id, displayName, role, pin) {
  const { hash, salt } = await hashPin(pin);
  await firestore.collection("users").doc(id).set({
    id, userId: id, displayName, role, active: true, pinHash: hash, pinSalt: salt,
  });
}

async function run(actor, command, payload, operationId) {
  return executeCommand({
    db, actor, command, payload, operationId, now: "2026-10-18T12:00:00.000Z",
  });
}

async function pressPin(page, pin) {
  for (const digit of pin) {
    const selector = `[data-testid="pin-key-${digit}"]`;
    await page.waitForSelector(selector, { timeout: 10000 });
    await page.click(selector);
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function login(page, label, pin) {
  await page.goto("http://127.0.0.1:5000/", { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector('[data-testid="ui-build-stamp"]');
  await page.evaluate((name) => {
    const button = [...document.querySelectorAll("button")].find((el) => el.textContent.includes(name));
    if (!button) throw new Error("missing user " + name);
    button.click();
  }, label);
  await pressPin(page, pin);
  await page.waitForSelector('[data-testid="btn-logout"]', { timeout: 30000 });
}

const owner = { userId: "mig:user:owner:saeed", role: "owner", active: true, displayName: "مدير" };
const employee = { userId: "mig:user:nader", role: "employee", active: true, displayName: "نادر" };
await seedUser(owner.userId, "مدير", "owner", "1357");
await seedUser(employee.userId, "نادر", "employee", "2468");
await seedUser("mig:user:yahia", "يحيى", "employee", "6477");

const prop = await run(owner, "createProperty", { name: "اختبار الإصدار", address: "محاكي" }, "release-prop-0001");
const unit = await run(owner, "createUnit", { propertyId: prop.propertyId, name: "شقة الاختبار", kind: "partitioned" }, "release-unit-0001");
const space = await run(owner, "createSpace", { unitId: unit.unitId, name: "1" }, "release-space-0001");
await run(owner, "createSpace", { unitId: unit.unitId, name: "9" }, "release-space-0009");
const rental = await run(owner, "createRental", {
  spaceId: space.spaceId, tenantName: "مستأجر أكتوبر", contractualAmountFils: 120000,
  dueDayOfMonth: 1, startDate: "2026-10-01",
}, "release-rent-0001");
await run(owner, "generateObligations", { period: "2026-10" }, "release-gen-0001");
const obligation = (await firestore.collection("obligations").get()).docs
  .map((doc) => ({ id: doc.id, ...doc.data() }))
  .find((row) => row.rentalId === rental.rentalId && row.period === "2026-10");
if (!obligation) throw new Error("missing October obligation");
await run(employee, "createCashReceipt", {
  obligationId: obligation.id, amountFils: 40000, collectionDate: "2026-10-05",
}, "release-partial-0001");

const loginProbe = await fetch(`http://127.0.0.1:5001/${project || "qama-new-prod-2026"}/me-central1/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ data: { userId: employee.userId, pin: "2468" } }),
});
const loginBody = await loginProbe.text();
if (!loginBody.includes("customToken")) {
  throw new Error("login callable failed: " + loginBody.slice(0, 800));
}

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844 });
page.on("dialog", async (dialog) => { await dialog.accept(); });
const logs = [];
page.on("console", (msg) => logs.push(msg.type() + " " + msg.text()));
page.on("pageerror", (err) => logs.push("pageerror " + err.message));

try {
  const states = () => page.$$eval("[data-financial-state]", (els) => els.map((el) => el.getAttribute("data-financial-state")));
  async function openOctoberUnit() {
    await page.click('[data-testid="tab-units"]');
    await page.waitForSelector('[data-testid="unit-card"]', { timeout: 20000 });
    await page.click('[data-testid="unit-card"]');
    await page.waitForSelector('[data-financial-state="partial"]', { timeout: 20000 });
  }
  await login(page, "نادر", "2468");
  note("employee login", true);
  await openOctoberUnit();
  const employeeStates = await states();
  note("employee units show partial collection", employeeStates.includes("partial"), employeeStates.join(",") || "none");
  note("employee units show the vacant partition", employeeStates.includes("vacant"), employeeStates.join(",") || "none");
  await page.click('[data-testid="btn-logout"]');

  await login(page, "مدير", "1357");
  note("manager login", true);
  await openOctoberUnit();
  const octoberStates = await states();
  note("manager October card is partially collected", octoberStates.includes("partial"), octoberStates.join(",") || "none");
  note("manager October shows a vacant partition", octoberStates.includes("vacant"), octoberStates.join(",") || "none");
  await page.click('[data-testid="month-next"]');
  await page.waitForFunction(() => document.body.innerText.includes("نوفمبر"), { timeout: 20000 });
  await page.waitForSelector('[data-testid="unit-card"]', { timeout: 20000 });
  await page.click('[data-testid="unit-card"]');
  await page.waitForSelector("[data-financial-state]", { timeout: 20000 });
  const novemberStates = await states();
  const novemberText = await page.evaluate(() => document.body.innerText);
  note("unrenewed November requires renewal", novemberStates.includes("renewal_required") && novemberText.includes("يلزم التجديد"), novemberStates.join(",") || "none");
  note("unrenewed November is not collected or partially collected", !novemberStates.includes("collected") && !novemberStates.includes("partial"), novemberStates.join(",") || "none");
  await page.click('[data-testid="tab-financial"]');
  await page.waitForSelector('[data-testid="holding-this-month"], [data-testid="tab-financial"]', { timeout: 20000 });
  const financial = await page.evaluate(() => document.body.innerText);
  note("financial dashboard opens", financial.includes("صافي") || financial.includes("الدخل") || financial.includes("المحصّل"));
  await page.click('[data-testid="tab-daily"]');
  await page.waitForSelector('[data-testid="daily-month-total"]', { timeout: 15000 });
  const dailyTotal = await page.$eval('[data-testid="daily-month-total"]', (el) => el.textContent);
  note("daily tab shows one income total", dailyTotal.includes("د.إ"), dailyTotal);
  const served = await page.content();
  note("Arabic duplicate-rent message is in the release UI", served.includes("يمكن تسجيل إيجار شهري جديد"));
} catch (error) {
  console.error(error && error.stack || error);
  if (logs.length) console.error(logs.join("\n"));
  try {
    console.error(await page.evaluate(() => document.body.innerText.slice(0, 1500)));
  } catch { /* page may be closed */ }
  process.exitCode = 1;
} finally {
  await browser.close();
}

if (results.some((row) => !row.ok)) process.exitCode = 1;
console.log("BROWSER_DONE", results.length);
