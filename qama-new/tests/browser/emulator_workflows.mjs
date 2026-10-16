/**
 * Isolated browser workflows against the local Firebase emulators only.
 * Refuses to start unless the Firestore emulator is the process target.
 * Never points at qama-new-prod-2026 or the legacy project.
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

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ projectId: project || "qama-new" });
const firestore = admin.firestore();
firestore.settings({ ignoreUndefinedProperties: true });
const db = createFirestoreRepository(firestore);

const chromePath = process.env.CHROME_PATH
  || "/tmp/chrome/linux-155.0.8059.79/chrome-linux64/chrome";
const puppeteer = require("/workspaces/Qama-alrawasi/node_modules/puppeteer-core");

const NADER_PIN = "2468";
const SAEED_PIN = "1357";
const results = [];

function note(step, ok, detail = "") {
  results.push({ step, ok, detail });
  console.log((ok ? "PASS" : "FAIL") + " " + step + (detail ? " — " + detail : ""));
}

async function seedUser(id, displayName, role, pin) {
  const { hash, salt } = await hashPin(pin);
  await firestore.collection("users").doc(id).set({
    id, userId: id, displayName, role, active: true, pinHash: hash, pinSalt: salt,
  });
}

const owner = { userId: "mig:user:owner:saeed", role: "owner", active: true, displayName: "مدير" };
const employee = { userId: "mig:user:nader", role: "employee", active: true, displayName: "نادر" };

async function run(actor, command, payload, operationId) {
  return executeCommand({
    db, actor, command, payload, operationId, now: new Date().toISOString(),
  });
}

async function clickTestId(page, id) {
  await page.waitForSelector(`[data-testid="${id}"]`, { timeout: 10000 });
  await page.evaluate((testId) => {
    const el = document.querySelector(`[data-testid="${testId}"]`);
    if (!el) throw new Error("missing " + testId);
    el.click();
  }, id);
}

async function pressPin(page, pin) {
  for (const digit of pin) {
    await page.evaluate((d) => {
      const button = [...document.querySelectorAll("button")].find((el) => el.textContent.trim() === d);
      if (!button) throw new Error("missing pin key " + d);
      button.click();
    }, digit);
    await new Promise((r) => setTimeout(r, 80));
  }
}

async function login(page, label, pin) {
  await page.goto("http://127.0.0.1:5000/", { waitUntil: "networkidle0", timeout: 30000 });
  await page.waitForSelector('[data-testid="ui-build-stamp"]');
  const stamp = await page.$eval('[data-testid="ui-build-stamp"]', (el) => el.textContent);
  if (!stamp.includes("QAMA-STABLE-20261015T1830Z")) throw new Error("unexpected stamp " + stamp);
  await page.evaluate((name) => {
    const button = [...document.querySelectorAll("button")].find((el) => el.textContent.includes(name));
    if (!button) throw new Error("missing user " + name);
    button.click();
  }, label);
  await pressPin(page, pin);
  await page.waitForSelector('[data-testid="btn-logout"]', { timeout: 20000 });
}

await seedUser(employee.userId, "نادر", "employee", NADER_PIN);
await seedUser(owner.userId, "مدير", "owner", SAEED_PIN);
const prop = await run(owner, "createProperty", { name: "اختبار معزول", address: "محاكي" }, "browser-prop-0001");
const unit = await run(owner, "createUnit", { propertyId: prop.propertyId, name: "شقة 202", kind: "partitioned" }, "browser-unit-0001");
const space = await run(owner, "createSpace", { unitId: unit.unitId, name: "5" }, "browser-space-0001");
await run(employee, "submitWorkRequest", {
  requestId: "req_browser_pending",
  type: "update_partition",
  desc: "تحصيل اختبار المتصفح",
  month: 8,
  year: 2026,
  payloadJson: JSON.stringify({
    unitId: unit.unitId,
    partId: 5,
    fields: {
      status: "collected", rent: 900, paid_amount: 900, tenant: "مستأجر اختبار", start_date: "2026-09-01",
      collectionMethod: "cash", _spaceId: space.spaceId, _unitId: unit.unitId,
    },
  }),
}, "browser-submit-0001");

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
page.on("dialog", async (dialog) => {
  if (dialog.type() === "prompt") await dialog.accept("إعادة فتح اختبار معزول");
  else await dialog.accept();
});
const logs = [];
page.on("console", (msg) => logs.push(msg.type() + " " + msg.text()));
page.on("pageerror", (err) => logs.push("pageerror " + err.message));

try {
  await login(page, "نادر", NADER_PIN);
  note("employee PIN login", true);
  await page.click('[data-testid="tab-myrequests"]');
  await page.waitForFunction(() => document.body.innerText.includes("تحصيل اختبار المتصفح"), { timeout: 20000 });
  note("employee sees the pending request", true);

  await page.click('[data-testid="btn-logout"]');
  await login(page, "مدير", SAEED_PIN);
  note("manager PIN login", true);
  await page.click('[data-testid="tab-requests"]');
  await page.waitForFunction(() => document.body.innerText.includes("التقديم الأصلي"), { timeout: 20000 });
  note("manager sees revision history", true);

  await run(employee, "reviseWorkRequest", {
    requestId: "req_browser_pending",
    expectedVersion: 1,
    reason: "تصحيح المبلغ قبل الاعتماد",
    payloadJson: JSON.stringify({
      unitId: unit.unitId,
      partId: 5,
      fields: {
        status: "partial", rent: 900, tenant: "مستأجر اختبار", start_date: "2026-09-01",
        paid_amount: 400, partial: true, collectionMethod: "cash",
        _spaceId: space.spaceId, _unitId: unit.unitId,
      },
    }),
  }, "browser-revise-0001");
  await page.click('[data-testid="req-approve"]');
  await page.waitForFunction(() => document.body.innerText.includes("تغيّر الطلب بعد فتحه"), { timeout: 20000 });
  note("stale approval is rejected", true);

  await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((el) => el.textContent.includes("🔄"));
    if (!button) throw new Error("missing request refresh");
    button.click();
  });
  await page.waitForFunction(() => document.body.innerText.includes("تصحيح المبلغ قبل الاعتماد"), { timeout: 20000 });
  note("manager sees the latest correction", true);
  await page.click('[data-testid="req-approve"]');
  await page.waitForFunction(() => document.body.innerText.includes("تم اعتماد الطلب"), { timeout: 25000 });
  const receipts = (await firestore.collection("receipts").get()).docs.map((d) => d.data());
  const recognized = receipts.filter((r) => r.state === "recognized");
  if (recognized.length !== 1 || recognized[0].amountFils !== 40000) {
    throw new Error("receipts " + JSON.stringify(recognized.map((r) => [r.id, r.amountFils, r.state])));
  }
  note("latest approval creates one partial receipt", true, "40000 fils");
  await page.waitForNetworkIdle({ idleTime: 800, timeout: 20000 }).catch(() => {});

  await page.click('[data-testid="tab-overview"]');
  await page.waitForSelector('[data-testid="month-close-card"]');
  await clickTestId(page, "btn-review-close");
  await page.waitForFunction(() => document.body.innerText.includes("يمكن الإقفال"), { timeout: 20000 });
  note("month close review allows a clean test month", true);
  await clickTestId(page, "btn-close-month");
  await page.waitForFunction(() => document.body.innerText.includes("أُقفل الشهر"), { timeout: 20000 });
  note("close a test month", true);
  await page.click('[data-testid="tab-overview"]');
  await clickTestId(page, "btn-reopen-month");
  await page.waitForFunction(() => document.body.innerText.includes("أُعيد فتح الشهر"), { timeout: 20000 });
  note("reopen a test month", true);

  await page.evaluate(() => {
    const next = [...document.querySelectorAll("button")].find((el) => el.textContent.trim() === "›");
    if (!next) throw new Error("missing next month");
    next.click();
  });
  await clickTestId(page, "btn-review-close");
  await page.waitForFunction(() => document.body.innerText.includes("يمكن الإقفال"), { timeout: 20000 });
  note("a later month still reviews after reopen", true);
} catch (error) {
  note("browser workflow", false, error && error.message ? error.message : String(error));
  const ids = await page.evaluate(() => [...document.querySelectorAll("[data-testid]")].map((el) => el.getAttribute("data-testid")).slice(0, 40)).catch(() => []);
  console.log("testids", ids.join(","));
  console.log(logs.slice(-30).join("\n"));
  throw error;
} finally {
  await browser.close();
  console.log(JSON.stringify(results, null, 2));
}
