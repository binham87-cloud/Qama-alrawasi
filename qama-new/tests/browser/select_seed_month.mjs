/**
 * The assembled UI opens the calendar month of "today".
 * Emulator seeds for these workflows are September 2026.
 * Click the on-screen month arrows until that label is showing.
 */
const MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];

function parseLabel(text) {
  const m = String(text || "").trim().match(/^(يناير|فبراير|مارس|أبريل|مايو|يونيو|يوليو|أغسطس|سبتمبر|أكتوبر|نوفمبر|ديسمبر) (20\d\d)$/);
  if (!m) return null;
  return { y: Number(m[2]), m: MONTHS.indexOf(m[1]) };
}

export async function selectSeededAccountingMonth(page, label = "سبتمبر 2026") {
  const want = parseLabel(label);
  if (!want) throw new Error("bad month label " + label);
  for (let i = 0; i < 18; i++) {
    const current = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll("div")];
      const hit = nodes.find((n) => n.childElementCount === 0
        && /^(يناير|فبراير|مارس|أبريل|مايو|يونيو|يوليو|أغسطس|سبتمبر|أكتوبر|نوفمبر|ديسمبر) 20\d\d$/.test((n.textContent || "").trim()));
      return hit ? hit.textContent.trim() : "";
    });
    if (current === label) {
      await page.waitForFunction(() => {
        const t = window.__qamaTest?.authState?.();
        return t && !t.loading;
      }, { timeout: 30000 });
      return;
    }
    const cur = parseLabel(current);
    if (!cur) throw new Error("month label missing: " + current);
    const forward = cur.y * 12 + cur.m < want.y * 12 + want.m;
    await page.evaluate((ch) => {
      const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === ch);
      if (!b) throw new Error("missing month arrow " + ch);
      b.click();
    }, forward ? "›" : "‹");
    await page.waitForFunction((prev) => {
      const nodes = [...document.querySelectorAll("div")];
      const hit = nodes.find((n) => n.childElementCount === 0
        && /^(يناير|فبراير|مارس|أبريل|مايو|يونيو|يوليو|أغسطس|سبتمبر|أكتوبر|نوفمبر|ديسمبر) 20\d\d$/.test((n.textContent || "").trim()));
      const t = window.__qamaTest?.authState?.();
      return !!(hit && hit.textContent.trim() !== prev && t && !t.loading);
    }, { timeout: 30000 }, current);
  }
  throw new Error("could not reach " + label);
}

/** Field edits stay local until the on-screen حفظ button. */
export async function commitScreenSave(page, testId) {
  const before = await page.evaluate(() => {
    const t = window.__qamaSaveState || window.__qamaTest?.authState?.() || {};
    return Number(t.saveOpDoneId || 0);
  });
  await page.waitForSelector(`[data-testid="${testId}"]`, { timeout: 15000 });
  await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) throw new Error("missing " + id);
    el.click();
  }, testId);
  await page.waitForFunction((prev) => {
    const t = window.__qamaSaveState || window.__qamaTest?.authState?.() || {};
    const done = Number(t.saveOpDoneId || 0);
    if (done > prev && t.saveOpStatus === "fail") return "fail";
    return done > prev && t.saveOpStatus === "ok";
  }, { timeout: 45000 }, before);
  const st = await page.evaluate(() => (window.__qamaSaveState || window.__qamaTest?.authState?.() || {}).saveOpStatus || "");
  if (st === "fail") {
    const msg = await page.evaluate(() => {
      const t = window.__qamaTest?.authState?.() || {};
      return t.msg || t.syncMsg || "";
    });
    throw new Error("save failed " + msg);
  }
}
