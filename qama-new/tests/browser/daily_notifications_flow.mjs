/**
 * Mobile browser check for daily checkout notices.
 * Emulator only. Never calls production.
 */
import { createRequire } from "node:module";
import { hashPin, createFirestoreRepository } from "../../functions/repositories/firestore.mjs";
import { executeCommand } from "../../functions/commands/index.mjs";
import { dubaiParts, dailyExpiryNotice } from "../../functions/domain/daily_notifications.mjs";

const project = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT || "";
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  throw new Error("browser workflow refused: emulator hosts are not set");
}
if (project === "qama-alrawasi") throw new Error("browser workflow refused: legacy project");

const require = createRequire(new URL("../../package.json", import.meta.url));
const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ projectId: project || "qama-new-prod-2026" });
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
    db, actor, command, payload, operationId, now: new Date().toISOString(),
  });
}

function addDays(iso, days) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

async function pressPin(page, pin) {
  for (const digit of pin) {
    const selector = `[data-testid="pin-key-${digit}"]`;
    await page.waitForSelector(selector, { timeout: 10000 });
    await page.click(selector);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const dubai = dubaiParts(new Date());
const endDate = dubai.date;
const startDate = addDays(endDate, -1);
const bookingId = "daily-notice-browser-1";
const booking = {
  id: bookingId,
  partId: "full-notice",
  partLabel: "شقة التنبيه / بارتشن 1",
  unitName: "شقة التنبيه",
  partName: "1",
  guest: "نزيل التنبيه",
  startDate,
  endDate,
  checkoutTime: "00:01",
  total: 180,
};
const expected = dailyExpiryNotice(booking, new Date());
if (!expected) throw new Error("fixture is outside the notice window");

const owner = { userId: "mig:user:owner:saeed", role: "owner", active: true, displayName: "مدير" };
const employee = { userId: "mig:user:nader", role: "employee", active: true, displayName: "نادر" };
await seedUser(owner.userId, "مدير", "owner", "1357");
await seedUser(employee.userId, "نادر", "employee", "2468");
await seedUser("mig:user:yahia", "يحيى", "employee", "6477");
const created = await run(owner, "createDailyBookingPrepaid", {
  period: endDate.slice(0, 7),
  amountFils: 18000,
  collectionDate: startDate,
  bookingJson: JSON.stringify(booking),
}, "daily-notice-prepaid-0001");

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
page.on("dialog", async (dialog) => { await dialog.accept(); });
const logs = [];
page.on("console", (msg) => logs.push(msg.type() + " " + msg.text()));
page.on("pageerror", (err) => logs.push("pageerror " + err.message));

try {
  await page.goto("http://127.0.0.1:5000/", { waitUntil: "networkidle0", timeout: 40000 });
  await page.waitForSelector('[data-testid="ui-build-stamp"]', { timeout: 20000 });
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((el) => el.textContent.includes("نادر")), { timeout: 20000 });
  note("user list", true);
  await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((el) => el.textContent.includes("نادر"));
    if (!button) throw new Error("missing employee");
    button.click();
  });
  await page.waitForSelector('[data-testid="pin-key-1"]', { timeout: 15000 });
  note("pin screen", true);
  await pressPin(page, "2468");
  await page.waitForSelector('[data-testid="btn-logout"]', { timeout: 30000 });
  await page.waitForSelector('[data-testid="btn-daily-notices"]', { timeout: 15000 });
  await page.waitForSelector('[data-testid="daily-notice-count"]', { timeout: 20000 });
  const count = await page.$eval('[data-testid="daily-notice-count"]', (el) => el.textContent.trim());
  note("unread count", Number(count) >= 1, count);
  await page.click('[data-testid="btn-daily-notices"]');
  await page.waitForSelector(`[data-notice-kind="${expected.kind}"]`, { timeout: 10000 });
  const text = await page.$eval('[data-testid="daily-notice-panel"]', (el) => el.innerText);
  note("place", text.includes("شقة التنبيه"));
  note("guest", text.includes("نزيل التنبيه"));
  note("stay", text.includes(startDate.split("-").reverse().join("/")) && text.includes(endDate.split("-").reverse().join("/")));
  note("checkout clock", text.includes("00:01"));
  note("status", text.includes("الحالة:"));
  await page.click('[data-testid="daily-notice-item"]');
  await page.waitForSelector(`[data-booking-id="${bookingId}"]`, { timeout: 20000 });
  const status = await page.$eval(`[data-booking-id="${bookingId}"]`, (el) => el.getAttribute("data-stay-status"));
  note("opened booking", status === "overdue" || status === "occupied", status);

  await page.click('[data-testid="btn-daily-notices"]');
  await page.waitForSelector('[data-testid="notice-extend-date"]');
  const extendedEnd = addDays(endDate, 5);
  await page.$eval('[data-testid="notice-extend-date"]', (el, value) => {
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, extendedEnd);
  await page.click('[data-testid="notice-extend"]');
  await page.waitForFunction((id) => {
    const card = document.querySelector(`[data-booking-id="${id}"]`);
    return card && card.getAttribute("data-stay-status") !== "overdue";
  }, { timeout: 20000 }, bookingId);
  note("extended", true, extendedEnd);

  await page.click('[data-testid="daily-confirm-checkout"]');
  await page.waitForSelector('[data-testid="daily-checked-out"]', { timeout: 20000 });
  const departed = await page.$eval(`[data-booking-id="${bookingId}"]`, (el) => el.getAttribute("data-stay-status"));
  note("checked out", departed === "checked_out", departed);
  await page.waitForFunction(() => !document.querySelector('[data-notice-kind="overdue"]'), { timeout: 10000 });
  note("notice cleared", true);

  const receipts = (await firestore.collection("receipts").get()).docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((row) => row.bookingId === bookingId || row.obligationId === `daily:${bookingId}`);
  note("one daily receipt", receipts.length === 1 && receipts[0].id === created.receiptId && receipts[0].amountFils === 18000, String(receipts.length));
  const stored = await firestore.collection("uiPeriods").doc(`period:${endDate.slice(0, 7)}`).get();
  const row = JSON.parse(stored.get("extrasJson")).dailyBookings.find((item) => item.id === bookingId);
  note("checkout stored", !!row.checkedOutAt && row.endDate === extendedEnd && Number(row.total) === 180);
  console.log(JSON.stringify({ ok: true, results }, null, 2));
} catch (err) {
  console.error(err && err.stack || err);
  console.error(logs.slice(-30).join("\n"));
  try {
    const text = await page.evaluate(() => document.body.innerText.slice(0, 1500));
    console.error("PAGE\n" + text);
  } catch (_e) {}
  process.exitCode = 1;
} finally {
  await browser.close();
}
