/**
 * Assembled Old-QAMA UI rental path via Chromium against production hosting.
 * Exercises اسم المستأجر → p.tenant → bridge createRental.
 * Does NOT claim physical iPhone Safari PASS.
 */
import puppeteer from "puppeteer-core";

const HOST = "https://qama-new-prod-2026.web.app";
const API_KEY = "AIzaSyBs0wIu2h2mnNMGr5SH-YNXjUhrdrGSNKg";
const REGION = "me-central1";
const PROJECT = "qama-new-prod-2026";
const PIN = process.env.OWNER_PIN;
if (!PIN) {
  console.error("OWNER_PIN env required");
  process.exit(2);
}
const STAMP = Date.now().toString(36);
const START = "2026-09-05";
const results = [];
const logs = [];

function rec(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || "" });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail != null && detail !== "" ? " — " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""}`);
}

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
async function apiLogin() {
  const res = await callable("login", { userId: "mig:user:owner:saeed", pin: PIN });
  return signIn(res.customToken);
}
async function cleanupBot(token) {
  const dash = await callable("read", { what: "dashboard", period: "2026-09" }, token);
  for (const u of dash.unitsTree || []) {
    for (const sp of u.spaces || []) {
      if (!/BOT RENT/i.test(sp.tenantName || "")) continue;
      if (sp.rentalId) {
        try {
          await callable("command", {
            command: "closeRental",
            payload: { rentalId: sp.rentalId, endDate: START, reason: "browser harness cleanup", setVacant: true },
            operationId: `br-close-${STAMP}-${sp.rentalId}`.slice(0, 120),
          }, token);
        } catch (e) { console.warn("close", e.message || e); }
      }
      try {
        await callable("command", {
          command: "setSpaceOccupancy",
          payload: { spaceId: sp.spaceId, occupancy: "vacant" },
          operationId: `br-vac-${STAMP}-${sp.spaceId}`.slice(0, 120),
        }, token);
      } catch (e) { console.warn("vac", e.message || e); }
    }
  }
}

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--window-size=390,844"],
  defaultViewport: { width: 390, height: 844, isMobile: true, hasTouch: true },
});
const page = await browser.newPage();
page.setDefaultTimeout(90000);
page.on("console", (msg) => {
  const t = msg.text();
  if (/qama-rent|TENANT_REQUIRED|createRental|لم يُحفظ|تعذر|IDEMPOTENCY/.test(t)) logs.push(t);
});

try {
  await page.goto(HOST + "/?ui=" + STAMP, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (document.body?.innerText || "").includes("مدير"), { timeout: 30000 });
  const html = await page.content();
  rec("deployed mustClose", html.includes("mustClose"));
  rec("deployed اسم المستأجر", html.includes("اسم المستأجر"));

  // Click owner button by exact label fragment
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button.btn")].find((b) => (b.textContent || "").includes("مدير"));
    if (!btn) throw new Error("owner button missing");
    btn.click();
  });
  await page.waitForSelector("button.pkb", { timeout: 15000 });
  for (const d of PIN) {
    await page.evaluate((digit) => {
      const b = [...document.querySelectorAll("button.pkb")].find((x) => x.textContent.trim() === digit);
      if (!b) throw new Error("missing digit " + digit);
      b.click();
    }, d);
    await new Promise((r) => setTimeout(r, 120));
  }

  await page.waitForFunction(() => {
    const t = document.body?.innerText || "";
    return t.includes("الوحدات") || t.includes("الرئيسية");
  }, { timeout: 60000 });
  rec("owner login via keypad", true);

  // Units tab
  await page.evaluate(() => {
    const t = [...document.querySelectorAll("button,div")].find((n) => (n.textContent || "").trim() === "الوحدات");
    if (t) t.click();
  });
  await page.waitForFunction(() => (document.body?.innerText || "").includes("بارتشن") || (document.body?.innerText || "").includes("شقة"), { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1200));

  // Open first unit card
  await page.evaluate(() => {
    const card = document.querySelector(".card.btn") || [...document.querySelectorAll(".card")].find((c) => /بارتشن|ميزان|شقة/.test(c.textContent || ""));
    if (!card) throw new Error("no unit card");
    card.click();
  });
  await new Promise((r) => setTimeout(r, 1000));

  // Open a vacant partition editor (or first expander)
  const which = await page.evaluate(() => {
    const all = [...document.querySelectorAll("div")];
    const vacantRow = all.find((d) => {
      const t = d.textContent || "";
      return t.includes("فارغ") && t.includes("▼") && t.length < 80;
    });
    if (vacantRow) { vacantRow.click(); return "vacant"; }
    const any = all.find((d) => (d.textContent || "").includes("▼") && (d.textContent || "").length < 80);
    if (any) { any.click(); return "any"; }
    return null;
  });
  rec("open partition editor", !!which, which || "none");
  await new Promise((r) => setTimeout(r, 700));

  const filled = await page.evaluate((start) => {
    const byPh = (ph) => [...document.querySelectorAll("input")].find((i) => (i.getAttribute("placeholder") || "") === ph);
    const tenant = byPh("اسم المستأجر...");
    if (!tenant) return { ok: false, reason: "tenant placeholder missing" };
    const setNative = (el, v) => {
      const proto = el instanceof HTMLInputElement
        ? window.HTMLInputElement.prototype
        : window.HTMLSelectElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(el, v);
      else el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    setNative(tenant, "BOT RENT TEST");
    const rentInp = [...document.querySelectorAll("input[type=number]")].find((i) => {
      const lab = i.parentElement?.previousSibling || i.parentElement;
      return true;
    });
    // First number input in the form grid is rent
    const nums = [...document.querySelectorAll("input[type=number]")];
    if (nums[0]) setNative(nums[0], "100");
    const dates = [...document.querySelectorAll("input[type=date]")];
    if (dates[0]) setNative(dates[0], start);
    const phone = byPh("05...");
    if (phone) setNative(phone, "0500000000");
    const note = byPh("ملاحظات عن المستأجر...");
    if (note) setNative(note, "BOT RENT TEST");
    const statusSel = [...document.querySelectorAll("select")].find((s) =>
      [...s.options].some((o) => o.value === "vacant") && [...s.options].some((o) => o.value === "late")
    );
    if (statusSel) setNative(statusSel, "late");
    return {
      ok: true,
      tenant: tenant.value,
      rent: nums[0]?.value || null,
      start: dates[0]?.value || null,
      status: statusSel?.value || null,
    };
  }, START);
  rec("UI tenant/rent/start before save", filled.ok && filled.tenant === "BOT RENT TEST", filled);

  // Wait for bridge save (status change triggers immediate saveCurData)
  await new Promise((r) => setTimeout(r, 5000));
  const bodyText = await page.evaluate(() => document.body.innerText || "");
  const tenantRequired = /TENANT_REQUIRED/.test(bodyText) || logs.some((l) => /TENANT_REQUIRED/.test(l));
  const idem = /IDEMPOTENCY_PAYLOAD_MISMATCH/.test(bodyText) || logs.some((l) => /IDEMPOTENCY/.test(l));
  const onlineFail = /تعذر الحفظ أونلاين/.test(bodyText);
  const savedOk = /تم الحفظ/.test(bodyText) || logs.some((l) => /\[qama-rent\] createRental/.test(l));
  rec("no TENANT_REQUIRED", !tenantRequired);
  rec("no IDEMPOTENCY_PAYLOAD_MISMATCH", !idem);
  rec("no تعذر الحفظ أونلاين hard-fail", !onlineFail || savedOk, onlineFail ? "banner seen" : "ok");
  rec("bridge createRental log or save success", savedOk || logs.some((l) => /createRental/.test(l)), logs.slice(-5));

  console.log("TRACE logs", logs);
} catch (e) {
  rec("browser harness", false, String(e && e.message || e));
} finally {
  await browser.close();
}

try {
  const token = await apiLogin();
  await cleanupBot(token);
  rec("BOT cleanup after browser", true);
} catch (e) {
  rec("BOT cleanup after browser", false, String(e && e.message || e));
}

const fail = results.filter((r) => !r.ok);
console.log("FAIL COUNT:", fail.length);
if (fail.length) {
  console.log(fail);
  process.exitCode = 1;
} else {
  console.log("ASSEMBLED UI BROWSER RENTAL PATH: PASS (Chromium — not physical iPhone)");
}
