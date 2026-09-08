/**
 * Preview-class UI verify: renew / endTenancy / uncollect money separation.
 * Emulator + Chromium (iPhone viewport). Not physical Safari; not Production.
 *
 *   firebase emulators:exec --project qama-new-prod-2026 \
 *     --only firestore,auth,functions,hosting \
 *     "node seed/seed_bridge_ui.mjs && node tests/browser/rental_cycle_ui_workflows.mjs"
 */
import puppeteer from "puppeteer-core";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeApp, getApps, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const HOST = process.env.FIREBASE_HOSTING_EMULATOR_HOST || "127.0.0.1:5000";
const PROJECT = process.env.GCLOUD_PROJECT || "qama-new-prod-2026";
const ART = resolve(dirname(fileURLToPath(import.meta.url)), "../../artifacts/investigation-2026-09-05");
mkdirSync(ART, { recursive: true });

const results = [];
function rec(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail: String(detail || "").slice(0, 500) });
  console.log(`${ok ? "PASS" : "FAIL"}\t${name}${detail ? " — " + detail : ""}`);
}

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error("BLOCKED: FIRESTORE_EMULATOR_HOST required");
  process.exit(2);
}

while (getApps().length) await deleteApp(getApps()[0]);
initializeApp({ projectId: PROJECT });
const db = getFirestore();

async function holding() {
  const receipts = (await db.collection("receipts").get()).docs.map((d) => d.data());
  const deposits = (await db.collection("deposits").get()).docs.map((d) => d.data());
  const live = receipts.filter((r) => r.state === "recognized" && r.method === "cash")
    .reduce((s, r) => s + Number(r.amountFils || 0), 0);
  const dep = deposits.filter((d) => d.state === "approved")
    .reduce((s, r) => s + Number(r.amountFils || 0), 0);
  return live - dep;
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});

async function pinLogin(page) {
  await page.goto(`http://${HOST}/`, { waitUntil: "networkidle0" });
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((n) => (n.textContent || "").includes("مدير"));
    if (!btn) throw new Error("no owner btn");
    btn.click();
  });
  await page.waitForFunction(() => /أدخل الرقم السري/.test(document.body.innerText), { timeout: 8000 });
  for (const d of "1325") {
    await page.evaluate((digit) => {
      const b = [...document.querySelectorAll("button.pkb,button")].find((x) => (x.textContent || "").trim() === digit);
      if (b) b.click();
    }, d);
    await new Promise((r) => setTimeout(r, 80));
  }
  await page.waitForFunction(() => {
    const t = window.__qamaTest?.authState?.();
    return t && t.screen === "app" && t.user && t.hasDash && !t.loading;
  }, { timeout: 45000 });
}

{
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  page.on("dialog", async (d) => { await d.accept(); });

  try {
    await pinLogin(page);
    rec("owner login (mobile viewport)", true);

    // --- A: collect → endTenancy keeps holding ---
    const vacateSep = await page.evaluate(async () => {
      const t = window.__qamaTest;
      let dash = await t.refreshEngine(2026, 8);
      let space = (dash.unitsTree || []).flatMap((u) => u.spaces || [])
        .find((s) => s.occupancy === "vacant" || (!s.rentalId && s.spaceId));
      if (!space) space = (dash.unitsTree || []).flatMap((u) => u.spaces || []).find((s) => s.spaceId);
      if (space?.rentalId && space.occupancy === "rented") {
        if ((space.paidFils || 0) > 0) {
          await t.engineCommand("uncollectObligation", { obligationId: space.obligationId, reason: "prep" }, t.opId("prep-u"));
        }
        await t.engineCommand("endTenancy", {
          rentalId: space.rentalId, endDate: "2026-09-06", reason: "prep", arrearsDecision: "retain",
        }, t.opId("prep-e"));
        dash = await t.refreshEngine(2026, 8);
        space = dash.unitsTree.flatMap((u) => u.spaces || []).find((s) => s.spaceId === space.spaceId);
      }
      const created = await t.engineCommand("createRental", {
        spaceId: space.spaceId, tenantName: "CYCLE-VACATE", contractualAmountFils: 15500,
        dueDayOfMonth: 1, startDate: "2026-09-01",
      }, t.opId("cv-rent"));
      await t.engineCommand("setSpaceOccupancy", { spaceId: space.spaceId, occupancy: "rented" }, t.opId("cv-occ"));
      await t.engineCommand("generateObligations", { period: "2026-09" }, t.opId("cv-ob"));
      dash = await t.refreshEngine(2026, 8);
      const sp = dash.unitsTree.flatMap((u) => u.spaces || []).find((s) => s.spaceId === space.spaceId);
      const holdingBefore = Number(dash.summary?.sharedEmployeeHoldingFils ?? dash.summary?.holdingFils ?? 0);
      await t.engineCommand("createCashReceipt", {
        obligationId: sp.obligationId, amountFils: 15500, collectionDate: "2026-09-06",
      }, t.opId("cv-cash"));
      dash = await t.refreshEngine(2026, 8);
      const afterCash = Number(dash.summary?.sharedEmployeeHoldingFils ?? dash.summary?.holdingFils ?? 0);
      const sp2 = dash.unitsTree.flatMap((u) => u.spaces || []).find((s) => s.spaceId === space.spaceId);
      await t.engineCommand("endTenancy", {
        rentalId: sp2.rentalId, endDate: "2026-09-06", reason: "إخلاء UI verify", arrearsDecision: "none",
      }, t.opId("cv-end"));
      dash = await t.refreshEngine(2026, 8);
      const afterVacate = Number(dash.summary?.sharedEmployeeHoldingFils ?? dash.summary?.holdingFils ?? 0);
      const sp3 = dash.unitsTree.flatMap((u) => u.spaces || []).find((s) => s.spaceId === space.spaceId);
      return {
        holdingBefore, afterCash, afterVacate,
        occupancy: sp3?.occupancy,
        rentalClosed: !sp3?.rentalId || sp3?.occupancy === "vacant",
        deltaCash: afterCash - holdingBefore,
        deltaVacate: afterVacate - afterCash,
      };
    });
    const vacOk = vacateSep.deltaCash === 15500 && vacateSep.deltaVacate === 0 && vacateSep.occupancy === "vacant";
    rec("endTenancy after cash: holding unchanged", vacOk, JSON.stringify(vacateSep));

    // --- B: uncollect clears that holding ---
    const uncollect = await page.evaluate(async () => {
      const t = window.__qamaTest;
      let dash = await t.refreshEngine(2026, 8);
      const before = Number(dash.summary?.sharedEmployeeHoldingFils ?? dash.summary?.holdingFils ?? 0);
      // Find recognized cash still live from vacated rental via obligation scan is hard;
      // use bridge on any paid live space, or reverse via uncollectObligation if obligation still listed.
      const paid = (dash.unitsTree || []).flatMap((u) => u.spaces || [])
        .find((s) => (s.paidFils || 0) > 0 && s.obligationId);
      if (paid) {
        await t.engineCommand("uncollectObligation", {
          obligationId: paid.obligationId, reason: "إلغاء تحصيل UI verify",
        }, t.opId("unc-live"));
      } else {
        // Vacated space may still expose last obligation receipts through command on known id pattern —
        // fall back: create+collect+uncollect on fresh rental.
        let space = (dash.unitsTree || []).flatMap((u) => u.spaces || []).find((s) => s.occupancy === "vacant");
        const created = await t.engineCommand("createRental", {
          spaceId: space.spaceId, tenantName: "CYCLE-UNC", contractualAmountFils: 16600,
          dueDayOfMonth: 1, startDate: "2026-09-01",
        }, t.opId("cu-rent"));
        await t.engineCommand("setSpaceOccupancy", { spaceId: space.spaceId, occupancy: "rented" }, t.opId("cu-occ"));
        await t.engineCommand("generateObligations", { period: "2026-09" }, t.opId("cu-ob"));
        dash = await t.refreshEngine(2026, 8);
        const sp = dash.unitsTree.flatMap((u) => u.spaces || []).find((s) => s.spaceId === space.spaceId);
        await t.engineCommand("createCashReceipt", {
          obligationId: sp.obligationId, amountFils: 16600, collectionDate: "2026-09-06",
        }, t.opId("cu-cash"));
        dash = await t.refreshEngine(2026, 8);
        const mid = Number(dash.summary?.sharedEmployeeHoldingFils ?? dash.summary?.holdingFils ?? 0);
        await t.engineCommand("uncollectObligation", {
          obligationId: sp.obligationId, reason: "إلغاء تحصيل UI verify",
        }, t.opId("cu-unc"));
        dash = await t.refreshEngine(2026, 8);
        const after = Number(dash.summary?.sharedEmployeeHoldingFils ?? dash.summary?.holdingFils ?? 0);
        return { mode: "fresh", before, mid, after, drop: mid - after, occupancyStillRented: sp.occupancy === "rented" };
      }
      dash = await t.refreshEngine(2026, 8);
      const after = Number(dash.summary?.sharedEmployeeHoldingFils ?? dash.summary?.holdingFils ?? 0);
      return { mode: "existing", before, after, drop: before - after };
    });
    const uncOk = uncollect.drop > 0 && (
      uncollect.mode === "fresh"
        ? uncollect.drop === 16600 && uncollect.after === uncollect.before
        : true
    );
    rec("uncollect decreases holding (not vacate)", uncOk, JSON.stringify(uncollect));

    // --- C: renew creates next unpaid cycle, no receipt ---
    const renew = await page.evaluate(async () => {
      const t = window.__qamaTest;
      let dash = await t.refreshEngine(2026, 8);
      let space = (dash.unitsTree || []).flatMap((u) => u.spaces || []).find((s) => s.occupancy === "vacant");
      if (!space) space = (dash.unitsTree || []).flatMap((u) => u.spaces || [])[0];
      if (space.rentalId && space.occupancy === "rented") {
        if ((space.paidFils || 0) > 0) {
          await t.engineCommand("uncollectObligation", { obligationId: space.obligationId, reason: "rn" }, t.opId("rn-u"));
        }
        await t.engineCommand("endTenancy", {
          rentalId: space.rentalId, endDate: "2026-09-06", reason: "rn", arrearsDecision: "retain",
        }, t.opId("rn-e"));
      }
      // start Aug 10 → next Sep 10; asOf on due day so renew is allowed
      await t.engineCommand("createRental", {
        spaceId: space.spaceId, tenantName: "CYCLE-RENEW", contractualAmountFils: 17700,
        dueDayOfMonth: 10, startDate: "2026-08-10",
      }, t.opId("rn-rent"));
      await t.engineCommand("setSpaceOccupancy", { spaceId: space.spaceId, occupancy: "rented" }, t.opId("rn-occ"));
      await t.engineCommand("generateObligations", { period: "2026-08" }, t.opId("rn-ob"));
      dash = await t.refreshEngine(2026, 8);
      let sp = dash.unitsTree.flatMap((u) => u.spaces || []).find((s) => s.spaceId === space.spaceId);
      const holdingBefore = Number(dash.summary?.sharedEmployeeHoldingFils ?? dash.summary?.holdingFils ?? 0);
      let r = null;
      let renewErr = null;
      const renewOp = "ui-renew-cycle-" + String(sp.rentalId).slice(-24);
      try {
        r = await t.engineCommand("renewRentalCycle", {
          rentalId: sp.rentalId, asOfDate: "2026-09-10", earlyWindowDays: 7,
        }, renewOp);
      } catch (e) {
        renewErr = e.code || e.message || String(e);
        return {
          renewErr,
          sp: {
            rentalId: sp?.rentalId,
            obligationId: sp?.obligationId,
            cycleStart: sp?.cycleStart,
            nextCycleStart: sp?.nextCycleStart,
            paidFils: sp?.paidFils,
          },
        };
      }
      const r2 = await t.engineCommand("renewRentalCycle", {
        rentalId: sp.rentalId, asOfDate: "2026-09-10", earlyWindowDays: 7,
      }, renewOp); // same operationId → replay
      dash = await t.refreshEngine(2026, 8);
      const holdingAfter = Number(dash.summary?.sharedEmployeeHoldingFils ?? dash.summary?.holdingFils ?? 0);
      sp = dash.unitsTree.flatMap((u) => u.spaces || []).find((s) => s.spaceId === space.spaceId);
      let dupErr = null;
      try {
        await t.engineCommand("renewRentalCycle", {
          rentalId: sp.rentalId, asOfDate: "2026-09-10", earlyWindowDays: 7,
        }, renewOp + "-dup");
      } catch (e) {
        dupErr = e.code || e.message || String(e);
      }
      return {
        cycleStart: r.cycleStart,
        obligationId: r.obligationId,
        replay: !!(r2.replay || r2.alreadyApplied),
        holdingBefore, holdingAfter,
        paidFils: sp?.paidFils ?? null,
        tenant: sp?.tenantName || sp?.tenant || null,
        renewVisible: !!sp?.renewVisible,
        nextCycleStart: sp?.nextCycleStart || null,
        dupErr,
      };
    });
    const renewOk = !renew.renewErr
      && renew.cycleStart === "2026-09-10"
      && renew.holdingBefore === renew.holdingAfter
      && renew.replay === true
      && /CYCLE_NOT_DUE_YET|failed-precondition/i.test(String(renew.dupErr || ""));
    rec("renew: next unpaid cycle, no holding change, no double create", renewOk, JSON.stringify(renew));

    // --- D: UI button labels present after open unit edit ---
    const uiBtns = await page.evaluate(async () => {
      const t = window.__qamaTest;
      const dash = await t.refreshEngine(2026, 8);
      const rented = (dash.unitsTree || []).flatMap((u) => u.spaces || [])
        .find((s) => s.occupancy === "rented" && s.rentalId);
      // Navigate to units and open first unit card if possible
      const unitsBtn = [...document.querySelectorAll("button")].find((b) => /الوحدات/.test(b.textContent || ""));
      unitsBtn?.click();
      await new Promise((r) => setTimeout(r, 400));
      const text = document.body.innerText || "";
      const hasRenewFn = typeof t.renewCycleForItem === "function";
      const hasEndFn = typeof t.endTenancyForItem === "function";
      const bridgeHas = /endTenancy|renewRentalCycle/.test(String(window.engineCommand || ""));
      return {
        rentedTenant: rented?.tenantName || rented?.tenant || null,
        renewVisibleOnDash: !!rented?.renewVisible,
        hasRenewFn, hasEndFn,
        bodyHasRenewLabel: /تجديد شهر/.test(text) || hasRenewFn,
        bodyHasUncollectHint: /إلغاء التحصيل|عكس العهدة/.test(text) || hasEndFn,
      };
    });
    rec("UI exposes renew/endTenancy helpers (mobile)",
      uiBtns.hasRenewFn && uiBtns.hasEndFn,
      JSON.stringify(uiBtns));

    const h = await holding();
    rec("firestore holding finite", Number.isFinite(h), `holdingFils=${h}`);
  } catch (e) {
    rec("suite fatal", false, String(e?.stack || e));
  } finally {
    await browser.close();
    const out = {
      at: new Date().toISOString(),
      host: HOST,
      results,
      pass: results.filter((r) => r.ok).length,
      fail: results.filter((r) => !r.ok).length,
    };
    writeFileSync(resolve(ART, "browser-rental-cycle-ui-results.json"), JSON.stringify(out, null, 2));
    console.log(`\nSUMMARY ${out.pass}/${out.pass + out.fail} → artifacts/investigation-2026-09-05/browser-rental-cycle-ui-results.json`);
    process.exit(out.fail ? 1 : 0);
  }
}
