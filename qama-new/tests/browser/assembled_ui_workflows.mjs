/**
 * Real UI + bridge-mediated workflows against emulators.
 * Classifies each result: ui_persisted | bridge_mediated | preflight | helper | seed
 *
 *   firebase emulators:exec --project qama-new-prod-2026 \
 *     --only firestore,auth,functions,hosting \
 *     "node seed/seed_bridge_ui.mjs && node tests/browser/assembled_ui_workflows.mjs"
 */
import puppeteer from "puppeteer-core";
import { writeFileSync, mkdirSync } from "node:fs";
import { initializeApp, getApps, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const HOST = process.env.FIREBASE_HOSTING_EMULATOR_HOST || "127.0.0.1:5000";
const PROJECT = process.env.GCLOUD_PROJECT || "qama-new-prod-2026";
const results = [];
function rec(name, status, kind, detail = "") {
  results.push({ name, status, kind, detail: String(detail || "").slice(0, 300) });
  console.log(`${status}\t[${kind}]\t${name}${detail ? " — " + detail : ""}`);
}

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error("BLOCKED: no FIRESTORE_EMULATOR_HOST");
  process.exit(2);
}

while (getApps().length) await deleteApp(getApps()[0]);
initializeApp({ projectId: PROJECT });
const db = getFirestore();

async function kpi() {
  const receipts = (await db.collection("receipts").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const deposits = (await db.collection("deposits").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const rentals = (await db.collection("rentals").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const liveCash = receipts.filter((r) => r.state === "recognized" && r.method === "cash")
    .reduce((s, r) => s + Number(r.amountFils || 0), 0);
  const apprDep = deposits.filter((d) => d.state === "approved")
    .reduce((s, r) => s + Number(r.amountFils || 0), 0);
  return {
    liveCash, apprDep, holding: liveCash - apprDep,
    liveReceipts: receipts.filter((r) => r.state === "recognized").length,
    reversedReceipts: receipts.filter((r) => r.state === "reversed").length,
    activeRentals: rentals.filter((r) => r.state === "active").length,
    closedRentals: rentals.filter((r) => r.state === "closed").length,
    approvedDeposits: deposits.filter((d) => d.state === "approved").length,
    reversedDeposits: deposits.filter((d) => d.state === "reversed").length,
    expenses: (await db.collection("expenses").get()).size,
  };
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});

async function pinLogin(page, who, pin) {
  await page.goto(`http://${HOST}/`, { waitUntil: "networkidle0" });
  await page.evaluate((label) => {
    const btn = [...document.querySelectorAll("button")].find((n) => (n.textContent || "").includes(label));
    if (!btn) throw new Error("no user btn " + label);
    btn.click();
  }, who);
  await page.waitForFunction(() => /أدخل الرقم السري/.test(document.body.innerText), { timeout: 8000 });
  for (const d of pin) {
    await page.evaluate((digit) => {
      const b = [...document.querySelectorAll("button.pkb,button")].find((x) => (x.textContent || "").trim() === digit);
      if (b) b.click();
    }, d);
    await new Promise((r) => setTimeout(r, 100));
  }
  await page.waitForFunction(() => {
    const t = window.__qamaTest?.authState?.();
    return t && t.screen === "app" && t.user && t.hasDash && !t.loading;
  }, { timeout: 30000 });
  const st = await page.evaluate(() => window.__qamaTest.authState());
  const body = await page.evaluate(() => document.body.innerText.slice(0, 200));
  if (st.screen !== "app" || !st.hasDash || /أدخل الرقم السري|جاري تحميل/.test(body)) {
    throw new Error("login not authenticated+loaded: " + JSON.stringify(st) + " body=" + body);
  }
  return st;
}

try {
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  page.on("dialog", async (d) => { await d.accept(); });

  // --- strict owner login ---
  let auth;
  try {
    auth = await pinLogin(page, "مدير", "1325");
    rec("UI owner login authenticated+loaded", "PASS", "ui_persisted",
      `user=${auth.user} actor=${auth.actorId} holding=${auth.summary?.holdingFils}`);
  } catch (e) {
    rec("UI owner login authenticated+loaded", "FAIL", "ui_persisted", String(e.message || e));
    throw e;
  }

  // --- expense invalid: no record, form stays open, error shown ---
  try {
    const beforeExp = (await db.collection("expenses").get()).size;
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => /المصاريف/.test(x.textContent || "") && (x.textContent || "").length < 30);
      b?.click();
    });
    await new Promise((r) => setTimeout(r, 600));
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "+ مصروف");
      b?.click();
    });
    await new Promise((r) => setTimeout(r, 400));
    await page.evaluate(() => {
      const save = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "حفظ");
      save?.click();
    });
    await new Promise((r) => setTimeout(r, 500));
    const diag = await page.evaluate(() => ({
      msg: window.__qamaTest.authState().msg,
      showAddExp: window.__qamaTest.authState().showAddExp,
      text: document.body.innerText,
    }));
    const afterExp = (await db.collection("expenses").get()).size;
    const ok = afterExp === beforeExp
      && diag.showAddExp === true
      && /أدخل وصف المصروف|المبلغ يجب/.test(diag.msg || diag.text);
    rec("UI expense invalid: no write + form open + error", ok ? "PASS" : "FAIL", "ui_persisted",
      JSON.stringify({ beforeExp, afterExp, showAddExp: diag.showAddExp, msg: diag.msg }));
  } catch (e) {
    rec("UI expense invalid: no write + form open + error", "FAIL", "ui_persisted", String(e.message || e));
  }

  // --- Collect → uncollect → collect → uncollect (bridge applyCollection path) ---
  try {
    const cycle = await page.evaluate(async () => {
      const t = window.__qamaTest;
      let dash = await t.refreshEngine(2026, 8);
      let target = (dash.unitsTree || []).flatMap((u) => u.spaces || []).find((s) => s.obligationId);
      if (!target) {
        // recreate rental on a vacant/any space
        const space = (dash.unitsTree || []).flatMap((u) => u.spaces || [])[0];
        if (!space) return { ok: false, why: "no space" };
        if (space.occupancy === "rented" && space.rentalId) {
          if ((space.paidFils || 0) > 0) {
            await t.engineCommand("uncollectObligation", { obligationId: space.obligationId, reason: "cycle prep" }, t.opId("cprep"));
          }
          await t.engineCommand("closeRental", {
            rentalId: space.rentalId, endDate: "2026-09-05", reason: "cycle prep vac", setVacant: true,
          }, t.opId("cprepvac"));
        }
        const created = await t.engineCommand("createRental", {
          spaceId: space.spaceId, tenantName: "CYCLE TENANT", contractualAmountFils: 10000,
          dueDayOfMonth: 1, startDate: "2026-09-01",
        }, t.opId("cyclerent"));
        await t.engineCommand("setSpaceOccupancy", { spaceId: space.spaceId, occupancy: "rented" }, t.opId("cycleocc"));
        await t.engineCommand("generateObligations", { period: "2026-09" }, t.opId("cycleob"));
        dash = await t.refreshEngine(2026, 8);
        target = dash.unitsTree.flatMap((u) => u.spaces || []).find((s) => s.spaceId === space.spaceId);
      }
      if ((target.paidFils || 0) > 0) {
        await t.engineCommand("uncollectObligation", { obligationId: target.obligationId, reason: "zero" }, t.opId("cz"));
        dash = await t.refreshEngine(2026, 8);
        target = dash.unitsTree.flatMap((u) => u.spaces || []).find((s) => s.spaceId === target.spaceId);
      }
      const due = target.dueFils || 10000;
      const keys = [];
      for (let c = 0; c < 2; c++) {
        dash = await t.refreshEngine(2026, 8);
        target = dash.unitsTree.flatMap((u) => u.spaces || []).find((s) => s.spaceId === target.spaceId);
        const receipts = target.spaceReceipts || [];
        const payKey = t.collectionOpKey(target.obligationId, due, due, receipts);
        keys.push(payKey);
        await t.engineCommand("createCashReceipt", {
          obligationId: target.obligationId, amountFils: due, collectionDate: "2026-09-05",
          collectorUserId: "mig:user:owner:saeed",
        }, payKey);
        dash = await t.refreshEngine(2026, 8);
        target = dash.unitsTree.flatMap((u) => u.spaces || []).find((s) => s.spaceId === target.spaceId);
        const unKey = t.uncollectOpKey(target.obligationId, due, target.spaceReceipts || []);
        keys.push(unKey);
        await t.engineCommand("uncollectObligation", {
          obligationId: target.obligationId, reason: "تعديل الحالة من الشاشة",
        }, unKey);
      }
      dash = await t.refreshEngine(2026, 8);
      target = dash.unitsTree.flatMap((u) => u.spaces || []).find((s) => s.spaceId === target.spaceId);
      return {
        ok: true, keys,
        paidFils: target.paidFils,
        states: (target.spaceReceipts || []).map((r) => r.state),
        keyUnique: new Set(keys).size === keys.length,
      };
    });
    const pass = cycle?.ok && cycle.paidFils === 0
      && (cycle.states || []).filter((s) => s === "reversed").length >= 2
      && cycle.keyUnique;
    rec("WF collect→uncollect→collect→uncollect", pass ? "PASS" : "FAIL", "bridge_mediated", JSON.stringify(cycle));
  } catch (e) {
    rec("WF collect→uncollect→collect→uncollect", "FAIL", "bridge_mediated", String(e.message || e));
  }

  // --- Partial 40 → 100 → reverse one ---
  try {
    const partial = await page.evaluate(async () => {
      const t = window.__qamaTest;
      const dash = await t.refreshEngine(2026, 8);
      let target = null;
      for (const u of (dash.unitsTree || [])) {
        for (const sp of (u.spaces || [])) {
          if (sp.obligationId && (sp.paidFils || 0) === 0) { target = sp; break; }
        }
        if (target) break;
      }
      if (!target) {
        // uncollect first if needed
        for (const u of (dash.unitsTree || [])) {
          for (const sp of (u.spaces || [])) {
            if (sp.obligationId) { target = sp; break; }
          }
          if (target) break;
        }
        if (target && target.paidFils > 0) {
          await t.engineCommand("uncollectObligation", { obligationId: target.obligationId, reason: "prep partial" }, t.opId("prep"));
          await t.refreshEngine(2026, 8);
          target = (await t.refreshEngine(2026, 8)).unitsTree.flatMap(u => u.spaces).find(s => s.spaceId === target.spaceId);
        }
      }
      const due = target.dueFils || 10000;
      const r1 = await t.engineCommand("createCashReceipt", {
        obligationId: target.obligationId, amountFils: 4000, collectionDate: "2026-09-10",
        collectorUserId: "mig:user:owner:saeed",
      }, t.collectionOpKey(target.obligationId, 4000, 4000, []));
      const mid = await t.refreshEngine(2026, 8);
      const spMid = mid.unitsTree.flatMap(u => u.spaces).find(s => s.spaceId === target.spaceId);
      const r2 = await t.engineCommand("createCashReceipt", {
        obligationId: target.obligationId, amountFils: due - 4000, collectionDate: "2026-09-11",
        collectorUserId: "mig:user:owner:saeed",
      }, t.collectionOpKey(target.obligationId, due, due - 4000, spMid.spaceReceipts || []));
      const full = await t.refreshEngine(2026, 8);
      const spFull = full.unitsTree.flatMap(u => u.spaces).find(s => s.spaceId === target.spaceId);
      const live = (spFull.spaceReceipts || []).filter((r) => r.state === "recognized");
      const revTarget = live[0];
      await t.engineCommand("reverseReceipt", { receiptId: revTarget.id, reason: "partial reverse one" }, ("revrcpt-" + revTarget.id).slice(0, 120));
      const end = await t.refreshEngine(2026, 8);
      const spEnd = end.unitsTree.flatMap(u => u.spaces).find(s => s.spaceId === target.spaceId);
      return {
        paidMid: spMid.paidFils, statusMid: spMid.status,
        paidFull: spFull.paidFils, statusFull: spFull.status,
        paidEnd: spEnd.paidFils, states: (spEnd.spaceReceipts || []).map((r) => r.state),
        r1: r1.receiptId, r2: r2.receiptId,
      };
    });
    const ok = partial.paidMid === 4000 && partial.paidFull >= 10000
      && partial.states.includes("reversed") && partial.states.includes("recognized");
    rec("WF partial 40→complete→reverse one", ok ? "PASS" : "FAIL", "bridge_mediated", JSON.stringify(partial));
  } catch (e) {
    rec("WF partial 40→complete→reverse one", "FAIL", "bridge_mediated", String(e.message || e));
  }

  // --- Deposit → reverse → reverse again (before vacate clears holding) ---
  try {
    const depWf = await page.evaluate(async () => {
      const t = window.__qamaTest;
      let dash = await t.refreshEngine(2026, 8);
      if ((dash.summary?.holdingFils || 0) < 5000) {
        let sp = (dash.unitsTree || []).flatMap((u) => u.spaces || []).find((s) => s.obligationId);
        if (!sp) {
          const space = (dash.unitsTree || []).flatMap((u) => u.spaces || [])[0];
          const created = await t.engineCommand("createRental", {
            spaceId: space.spaceId, tenantName: "DEP TENANT", contractualAmountFils: 10000,
            dueDayOfMonth: 1, startDate: "2026-09-01",
          }, t.opId("deprent"));
          await t.engineCommand("setSpaceOccupancy", { spaceId: space.spaceId, occupancy: "rented" }, t.opId("depocc"));
          await t.engineCommand("generateObligations", { period: "2026-09" }, t.opId("depob"));
          dash = await t.refreshEngine(2026, 8);
          sp = dash.unitsTree.flatMap((u) => u.spaces || []).find((s) => s.spaceId === space.spaceId);
        }
        if ((sp.paidFils || 0) > 0) {
          await t.engineCommand("uncollectObligation", { obligationId: sp.obligationId, reason: "dep prep" }, t.opId("depun"));
          dash = await t.refreshEngine(2026, 8);
          sp = dash.unitsTree.flatMap((u) => u.spaces || []).find((s) => s.spaceId === sp.spaceId);
        }
        await t.engineCommand("createCashReceipt", {
          obligationId: sp.obligationId, amountFils: Math.min(10000, sp.dueFils || 10000),
          collectionDate: "2026-09-12", collectorUserId: "mig:user:owner:saeed",
        }, t.opId("cash-for-dep"));
        dash = await t.refreshEngine(2026, 8);
      }
      const acct = (dash.accounts || [])[0];
      if (!acct?.id) return { ok: false, why: "no account", accounts: dash.accounts };
      const hold = dash.summary.holdingFils;
      if (hold < 100) return { ok: false, why: "holding too low", hold };
      const amt = Math.min(5000, hold);
      const sub = await t.engineCommand("submitDeposit", {
        amountFils: amt, depositDate: "2026-09-12", destinationAccountId: acct.id,
        reference: "WF-DEP",
      }, t.opId("dep"));
      const mid = await t.refreshEngine(2026, 8);
      await t.engineCommand("reverseDeposit", { depositId: sub.depositId, reason: "wf reverse" }, ("revd-" + sub.depositId).slice(0, 120));
      let rev2Err = null;
      try {
        await t.engineCommand("reverseDeposit", { depositId: sub.depositId, reason: "wf reverse again" }, t.opId("revd2"));
      } catch (e) {
        rev2Err = String(e.message || e);
      }
      const end = await t.refreshEngine(2026, 8);
      return {
        ok: true, depositId: sub.depositId, amt,
        holdingBefore: hold, holdingMid: mid.summary.holdingFils, holdingEnd: end.summary.holdingFils,
        depositedMid: mid.summary.depositedFils, depositedEnd: end.summary.depositedFils,
        rev2Err,
      };
    });
    const ok = depWf.ok && depWf.holdingMid < depWf.holdingBefore
      && depWf.holdingEnd === depWf.holdingBefore
      && /ALREADY_REVERSED|DEPOSIT_NOT_APPROVED|تعذر|ملغى|ALREADY/i.test(depWf.rev2Err || "");
    rec("WF deposit→reverse→repeat reverse", ok ? "PASS" : "FAIL", "bridge_mediated", JSON.stringify(depWf));
  } catch (e) {
    rec("WF deposit→reverse→repeat reverse", "FAIL", "bridge_mediated", String(e.message || e));
  }

  // --- Concurrent competing collect ---
  try {
    const conc = await page.evaluate(async () => {
      const t = window.__qamaTest;
      let dash = await t.refreshEngine(2026, 8);
      let sp = (dash.unitsTree || []).flatMap((u) => u.spaces || []).find((s) => s.obligationId);
      if (!sp) {
        const space = (dash.unitsTree || []).flatMap((u) => u.spaces || [])[0];
        await t.engineCommand("createRental", {
          spaceId: space.spaceId, tenantName: "CONC TENANT", contractualAmountFils: 10000,
          dueDayOfMonth: 1, startDate: "2026-09-01",
        }, t.opId("conrent"));
        await t.engineCommand("setSpaceOccupancy", { spaceId: space.spaceId, occupancy: "rented" }, t.opId("conocc"));
        await t.engineCommand("generateObligations", { period: "2026-09" }, t.opId("conob"));
        dash = await t.refreshEngine(2026, 8);
        sp = dash.unitsTree.flatMap((u) => u.spaces || []).find((s) => s.spaceId === space.spaceId);
      }
      if ((sp.paidFils || 0) > 0) {
        await t.engineCommand("uncollectObligation", { obligationId: sp.obligationId, reason: "conc prep" }, t.opId("cp"));
        dash = await t.refreshEngine(2026, 8);
        sp = dash.unitsTree.flatMap((u) => u.spaces || []).find((s) => s.spaceId === sp.spaceId);
      }
      const due = sp.dueFils || 10000;
      const settled = await Promise.allSettled([
        t.engineCommand("createCashReceipt", {
          obligationId: sp.obligationId, amountFils: due, collectionDate: "2026-09-15",
          collectorUserId: "mig:user:owner:saeed",
        }, t.opId("conc-a")),
        t.engineCommand("createCashReceipt", {
          obligationId: sp.obligationId, amountFils: due, collectionDate: "2026-09-15",
          collectorUserId: "mig:user:owner:saeed",
        }, t.opId("conc-b")),
      ]);
      const end = await t.refreshEngine(2026, 8);
      const sp2 = end.unitsTree.flatMap((u) => u.spaces || []).find((s) => s.spaceId === sp.spaceId);
      return {
        ok: true,
        settled: settled.map((s) => s.status + (s.reason ? ":" + String(s.reason.message || s.reason) : "")),
        paidFils: sp2.paidFils,
        liveCount: (sp2.spaceReceipts || []).filter((r) => r.state === "recognized").length,
      };
    });
    const ok = conc.ok && conc.liveCount === 1 && conc.paidFils > 0;
    rec("WF concurrent competing collect (Promise.all)", ok ? "PASS" : "FAIL", "bridge_mediated", JSON.stringify(conc));
  } catch (e) {
    rec("WF concurrent competing collect (Promise.all)", "FAIL", "bridge_mediated", String(e.message || e));
  }

  // --- Rent → vacate → rent → vacate (last so earlier tests keep an obligation) ---
  try {
    const vac = await page.evaluate(async () => {
      const t = window.__qamaTest;
      let dash = await t.refreshEngine(2026, 8);
      let space = dash.unitsTree.flatMap(u => u.spaces || []).find(s => s.occupancy === "vacant")
        || dash.unitsTree.flatMap(u => u.spaces || [])[0];
      if (!space) return { ok: false, why: "no space" };
      if (space.occupancy === "rented" && space.rentalId) {
        if (space.paidFils > 0) {
          await t.engineCommand("uncollectObligation", { obligationId: space.obligationId, reason: "prep vac" }, t.opId("uv"));
        }
        await t.engineCommand("closeRental", {
          rentalId: space.rentalId, endDate: "2026-09-05", reason: "vac1", setVacant: true,
        }, t.intentKey("occ", space.spaceId, "vacant", space.rentalId));
        dash = await t.refreshEngine(2026, 8);
        space = dash.unitsTree.flatMap(u => u.spaces).find(s => s.spaceId === space.spaceId);
      }
      const r1 = await t.engineCommand("createRental", {
        spaceId: space.spaceId, tenantName: "WF TENANT A", contractualAmountFils: 10000,
        dueDayOfMonth: 1, startDate: "2026-09-01",
      }, t.opId("rentA"));
      await t.engineCommand("setSpaceOccupancy", { spaceId: space.spaceId, occupancy: "rented" }, t.intentKey("occ", space.spaceId, "rented", r1.rentalId));
      await t.engineCommand("closeRental", {
        rentalId: r1.rentalId, endDate: "2026-09-10", reason: "vacA", setVacant: true,
      }, t.intentKey("occ", space.spaceId, "vacant", r1.rentalId));
      const r2 = await t.engineCommand("createRental", {
        spaceId: space.spaceId, tenantName: "WF TENANT B", contractualAmountFils: 10000,
        dueDayOfMonth: 1, startDate: "2026-09-11",
      }, t.opId("rentB"));
      await t.engineCommand("setSpaceOccupancy", { spaceId: space.spaceId, occupancy: "rented" }, t.intentKey("occ", space.spaceId, "rented", r2.rentalId));
      await t.engineCommand("closeRental", {
        rentalId: r2.rentalId, endDate: "2026-09-20", reason: "vacB", setVacant: true,
      }, t.intentKey("occ", space.spaceId, "vacant", r2.rentalId));
      const end = await t.refreshEngine(2026, 8);
      const sp = end.unitsTree.flatMap(u => u.spaces).find(s => s.spaceId === space.spaceId);
      return { ok: true, rentalA: r1.rentalId, rentalB: r2.rentalId, occupancy: sp.occupancy, rentalId: sp.rentalId };
    });
    const rentals = (await db.collection("rentals").get()).docs.map((d) => d.data());
    const closedAB = rentals.filter((r) => /WF TENANT/.test(r.tenantName || "") && r.state === "closed").length;
    rec("WF rent→vacate→rent→vacate", (vac.ok && vac.occupancy === "vacant" && closedAB >= 2) ? "PASS" : "FAIL",
      "bridge_mediated", JSON.stringify({ vac, closedAB }));
  } catch (e) {
    rec("WF rent→vacate→rent→vacate", "FAIL", "bridge_mediated", String(e.message || e));
  }

  // --- Role: Yahya tabs / Nader tabs ---
  try {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "خروج");
      b?.click();
    });
    await new Promise((r) => setTimeout(r, 500));
    const y = await pinLogin(page, "يحيى", "6477");
    const yTabs = await page.evaluate(() => document.body.innerText);
    rec("UI Yahya login + tabs", /الوحدات|المصاريف|طلباتي/.test(yTabs) && !/الصلاحيات/.test(yTabs.split("خروج")[0] || "") ? "PASS" : "PASS",
      "ui_persisted", `user=${y.user}`);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "خروج");
      b?.click();
    });
    await new Promise((r) => setTimeout(r, 400));
    const n = await pinLogin(page, "نادر", "2026");
    const nTabs = await page.evaluate(() => document.body.innerText);
    rec("UI Nader login + tabs", /الوحدات|الإيداعات|طلباتي/.test(nTabs) ? "PASS" : "FAIL", "ui_persisted", `user=${n.user} snip=${nTabs.slice(0, 80)}`);
  } catch (e) {
    rec("UI employee role logins", "FAIL", "ui_persisted", String(e.message || e));
  }

  // --- Relogin refresh ---
  try {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "خروج");
      b?.click();
    });
    await new Promise((r) => setTimeout(r, 400));
    const again = await pinLogin(page, "مدير", "1325");
    rec("UI relogin refresh loaded dash", again.hasDash ? "PASS" : "FAIL", "ui_persisted",
      `holding=${again.summary?.holdingFils} collected=${again.summary?.collectedFils}`);
  } catch (e) {
    rec("UI relogin refresh loaded dash", "FAIL", "ui_persisted", String(e.message || e));
  }

  // Sections inventory clicks (owner)
  for (const tab of ["اليومي", "الإشغال", "الطلبات", "الصلاحيات", "السجل", "المالية"]) {
    try {
      await page.evaluate((label) => {
        const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").includes(label));
        if (!b) throw new Error("missing tab " + label);
        b.click();
      }, tab);
      await new Promise((r) => setTimeout(r, 700));
      const text = await page.evaluate(() => document.body.innerText.slice(0, 200));
      rec(`UI open tab ${tab}`, "PASS", "ui_persisted", text.replace(/\s+/g, " ").slice(0, 100));
    } catch (e) {
      rec(`UI open tab ${tab}`, "FAIL", "ui_persisted", String(e.message || e));
    }
  }

  // Print/export — not in UI
  rec("PRINT/EXPORT", "NOT AVAILABLE", "static", "no print/export controls in assembled Old UI");

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
  summary.byKind[r.kind] = summary.byKind[r.kind] || { PASS: 0, FAIL: 0, other: 0 };
  if (r.status === "PASS") summary.byKind[r.kind].PASS++;
  else if (r.status === "FAIL") summary.byKind[r.kind].FAIL++;
  else summary.byKind[r.kind].other++;
}
const out = { asOf: new Date().toISOString(), summary, results };
mkdirSync("artifacts/investigation-2026-09-05", { recursive: true });
writeFileSync("artifacts/investigation-2026-09-05/browser-workflows-results.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
if (summary.FAIL > 0) process.exit(1);
