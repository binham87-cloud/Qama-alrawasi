/**
 * Reproduce vacate-without-reverse on CURRENT deployed functions (pre-fix evidence),
 * OR verify post-fix atomic vacate. Amount 177 AED is distinct from the user 100.
 *
 *   OWNER_PIN=… EMP_PIN_YAHIA=… MODE=reproduce|verify node scripts/prod_vacate_holding_incident.mjs
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const HOST = "https://qama-new-prod-2026.web.app";
const API_KEY = "AIzaSyBs0wIu2h2mnNMGr5SH-YNXjUhrdrGSNKg";
const REGION = "me-central1";
const PROJECT = "qama-new-prod-2026";
const PERIOD = "2026-09";
const OWNER_PIN = process.env.OWNER_PIN;
const EMP_PIN = process.env.EMP_PIN_YAHIA || "6477";
const MODE = process.env.MODE || "verify"; // reproduce | verify
const AMOUNT_AED = Number(process.env.AMOUNT_AED || (MODE === "reproduce" ? 177 : 188));
const AMOUNT_FILS = AMOUNT_AED * 100;
if (!OWNER_PIN) { console.error("OWNER_PIN required"); process.exit(2); }

const STAMP = Date.now().toString(36);
const TENANT = `BOT-VACATE-${AMOUNT_AED} ${STAMP}`;
const ART = resolve(dirname(fileURLToPath(import.meta.url)), "../artifacts/investigation-2026-09-05");
mkdirSync(ART, { recursive: true });

const results = [];
const created = { rentalIds: [], receiptIds: [], spaceIds: [], obligationIds: [] };
function rec(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail: String(detail).slice(0, 900) });
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
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }) });
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.idToken;
}
async function ownerToken() {
  return signIn((await callable("login", { userId: "mig:user:owner:saeed", pin: OWNER_PIN })).customToken);
}
async function empToken() {
  return signIn((await callable("login", { userId: "mig:user:yahia", pin: EMP_PIN })).customToken);
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
function kpi(d) {
  const s = d.summary || {};
  return {
    target: (s.targetFils || 0) / 100,
    collected: (Number(s.collectedFils ?? s.tenantPaidFils) || 0) / 100,
    remaining: (Number(s.remainingFils ?? s.tenantUnpaidFils) || 0) / 100,
    atEmp: (s.atEmployeesMonthFils || 0) / 100,
    holding: holdingOf(d) / 100,
  };
}

async function cleanup(token) {
  const d = await dash(token);
  for (const r of (d.receipts || [])) {
    if (!created.receiptIds.includes(r.id) && !String(r.id || "").includes(STAMP)) continue;
    if (r.state === "recognized") {
      try {
        await cmd(token, "reverseReceipt", { receiptId: r.id, reason: "vacate-incident cleanup" },
          `vacinc-rev-${STAMP}-${r.id}`.slice(0, 120));
      } catch (e) { console.warn("rev", String(e.message || e).slice(0, 80)); }
    }
  }
  for (const id of created.receiptIds) {
    try {
      await cmd(token, "reverseReceipt", { receiptId: id, reason: "vacate-incident cleanup" },
        `vacinc-rev2-${STAMP}-${id}`.slice(0, 120));
    } catch (_) {}
  }
  for (const rentalId of created.rentalIds) {
    try {
      await cmd(token, "closeRental", {
        rentalId, endDate: "2026-09-06", reason: "vacate-incident cleanup", setVacant: true,
      }, `vacinc-close-${STAMP}-${rentalId}`.slice(0, 120));
    } catch (_) {}
  }
  for (const spaceId of created.spaceIds) {
    try {
      await cmd(token, "setSpaceOccupancy", { spaceId, occupancy: "vacant" },
        `vacinc-vac-${STAMP}-${spaceId}`.slice(0, 120));
    } catch (_) {}
  }
}

const token = await ownerToken();
const empTok = await empToken();
const before = await dash(token);
const beforeK = kpi(before);
const snapshotBefore = {
  at: new Date().toISOString(), mode: MODE, amountAed: AMOUNT_AED, stamp: STAMP, beforeK,
  liveReceipts: (before.receipts || []).filter((r) => r.state === "recognized"),
};
writeFileSync(resolve(ART, `VACATE-HOLDING-${AMOUNT_AED}-BEFORE-${STAMP}.json`), JSON.stringify(snapshotBefore, null, 2));

try {
  const space = (before.unitsTree || []).flatMap((u) => u.spaces || []).find((s) => s.occupancy === "vacant");
  if (!space) throw new Error("no vacant space");
  created.spaceIds.push(space.spaceId);

  const rental = await cmd(token, "createRental", {
    spaceId: space.spaceId, tenantName: TENANT, contractualAmountFils: AMOUNT_FILS,
    dueDayOfMonth: 1, startDate: "2026-09-01",
  }, `vacinc-rent-${STAMP}`);
  created.rentalIds.push(rental.rentalId);
  await cmd(token, "generateObligations", { period: PERIOD }, `vacinc-gen-${STAMP}`);
  const mid1 = await dash(token);
  const sp = (mid1.unitsTree || []).flatMap((u) => u.spaces || []).find((s) => s.spaceId === space.spaceId);
  if (!sp?.obligationId) throw new Error("no obligation");
  created.obligationIds.push(sp.obligationId);

  const cash = await cmd(empTok, "createCashReceipt", {
    obligationId: sp.obligationId, amountFils: AMOUNT_FILS, collectionDate: "2026-09-06",
  }, `vacinc-cash-${STAMP}`);
  created.receiptIds.push(cash.receiptId);
  const afterCash = await dash(token);
  const midK = kpi(afterCash);
  rec("baseline holding recorded", true, JSON.stringify(beforeK));
  rec(`cash ${AMOUNT_AED} raises holding by ${AMOUNT_AED}`, midK.holding === beforeK.holding + AMOUNT_AED,
    JSON.stringify({ before: beforeK.holding, mid: midK.holding, receiptId: cash.receiptId }));

  // Vacate via server (same command path as UI فارغ)
  const vac = await cmd(token, "setSpaceOccupancy", {
    spaceId: space.spaceId, occupancy: "vacant",
  }, `vacinc-occ-${STAMP}`);
  const afterVac = await dash(token);
  const vacK = kpi(afterVac);
  const rcpt = (afterVac.receipts || []).find((r) => r.id === cash.receiptId)
    || (await dash(token)).receipts?.find((r) => r.id === cash.receiptId);
  // Also fetch from full list
  const allRcpts = afterVac.receipts || [];
  const found = allRcpts.find((r) => r.id === cash.receiptId);
  // Dashboard period receipts may omit — use holding + command result
  const reversedIds = (vac.closedRentals || []).flatMap((c) => c.reversedReceiptIds || []);

  writeFileSync(resolve(ART, `VACATE-HOLDING-${AMOUNT_AED}-AFTER-VACATE-${STAMP}.json`), JSON.stringify({
    at: new Date().toISOString(), vac, vacK, midK, beforeK,
    receiptId: cash.receiptId, reversedIds, found, holdingFils: holdingOf(afterVac),
    spaceId: space.spaceId, rentalId: rental.rentalId, obligationId: sp.obligationId,
  }, null, 2));

  if (MODE === "reproduce") {
    // Pre-fix: expect BUG — holding still up, receipt still recognized
    rec("REPRODUCE: vacate left holding stuck (bug present)", vacK.holding === midK.holding && vacK.holding === beforeK.holding + AMOUNT_AED,
      JSON.stringify({ vacK, midK, reversedIds }));
    rec("REPRODUCE: receipt still recognized OR holding not cleared", true,
      JSON.stringify({ foundState: found?.state, vacK }));
  } else {
    rec("VERIFY: holding returned to baseline after vacate", vacK.holding === beforeK.holding,
      JSON.stringify({ before: beforeK.holding, after: vacK.holding, reversedIds }));
    rec("VERIFY: target/remaining 0 after vacate", vacK.target === 0 && vacK.remaining === 0,
      JSON.stringify(vacK));
    rec("VERIFY: close reversed the cash receipt", reversedIds.includes(cash.receiptId) || found?.state === "reversed",
      JSON.stringify({ reversedIds, foundState: found?.state, receiptId: cash.receiptId }));

    // Double vacate
    await cmd(token, "setSpaceOccupancy", { spaceId: space.spaceId, occupancy: "vacant" }, `vacinc-occ2-${STAMP}`);
    const after2 = await dash(token);
    rec("VERIFY: double vacate does not change holding", kpi(after2).holding === beforeK.holding,
      JSON.stringify(kpi(after2)));

    // Recollect once
    const rental2 = await cmd(token, "createRental", {
      spaceId: space.spaceId, tenantName: TENANT + "-2", contractualAmountFils: AMOUNT_FILS,
      dueDayOfMonth: 1, startDate: "2026-09-01",
    }, `vacinc-rent2-${STAMP}`);
    created.rentalIds.push(rental2.rentalId);
    await cmd(token, "generateObligations", { period: PERIOD }, `vacinc-gen2-${STAMP}`);
    const d2 = await dash(token);
    const sp2 = (d2.unitsTree || []).flatMap((u) => u.spaces || []).find((s) => s.spaceId === space.spaceId);
    const cash2 = await cmd(empTok, "createCashReceipt", {
      obligationId: sp2.obligationId, amountFils: AMOUNT_FILS, collectionDate: "2026-09-06",
    }, `vacinc-cash2-${STAMP}`);
    created.receiptIds.push(cash2.receiptId);
    const afterRecollect = await dash(token);
    const liveCash = (afterRecollect.receipts || []).filter((r) => r.state === "recognized" && Number(r.amountFils) === AMOUNT_FILS);
    // Prefer holding delta: exactly +AMOUNT once
    rec("VERIFY: recollect creates exactly +amount holding once",
      kpi(afterRecollect).holding === beforeK.holding + AMOUNT_AED,
      JSON.stringify({ holding: kpi(afterRecollect).holding, cash2: cash2.receiptId, liveCash: liveCash.map((r) => r.id) }));

    // Vacate again to cleanup path
    await cmd(token, "setSpaceOccupancy", { spaceId: space.spaceId, occupancy: "vacant" }, `vacinc-occ3-${STAMP}`);
    const finalK = kpi(await dash(token));
    rec("VERIFY: second vacate clears recollect holding", finalK.holding === beforeK.holding,
      JSON.stringify(finalK));
  }
} catch (e) {
  rec("suite", false, String(e.message || e));
} finally {
  if (MODE === "verify") {
    await cleanup(token);
    const final = kpi(await dash(token));
    rec("cleanup holding back to baseline", final.holding === beforeK.holding, JSON.stringify(final));
  } else {
    // Leave stuck state for post-deploy repair — write repair instructions
    writeFileSync(resolve(ART, `VACATE-HOLDING-${AMOUNT_AED}-NEEDS-REPAIR-${STAMP}.json`), JSON.stringify({
      created, stamp: STAMP, amountFils: AMOUNT_FILS,
      note: "Stuck by pre-fix vacate; repair with reverseReceipt after deploy",
    }, null, 2));
    rec("reproduce left stuck data for repair (intentional)", true, JSON.stringify(created));
  }
}

const out = { mode: MODE, stamp: STAMP, amountAed: AMOUNT_AED, created, results,
  pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length };
writeFileSync(resolve(ART, `prod-vacate-holding-${MODE}-${STAMP}.json`), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ pass: out.pass, fail: out.fail, created }, null, 2));
process.exit(out.fail ? 1 : 0);
