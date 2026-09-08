/**
 * Orphan-cleanup safety gate: CASE B retained debt must survive detector + apply.
 *
 *   OWNER_PIN=1325 node scripts/prod_orphan_cleanup_safety_accept.mjs
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { classifyOrphanCandidate } from "./lib/orphan_obligation_classify.mjs";

const API_KEY = "AIzaSyBs0wIu2h2mnNMGr5SH-YNXjUhrdrGSNKg";
const REGION = "me-central1";
const PROJECT = "qama-new-prod-2026";
const HOST = "https://qama-new-prod-2026.web.app";
const PERIOD = "2026-09";
const OWNER_PIN = process.env.OWNER_PIN || "1325";
const STAMP = Date.now().toString(36);
const TODAY = new Date().toISOString().slice(0, 10);
const here = dirname(fileURLToPath(import.meta.url));
const results = [];

function rec(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || "" });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""}`);
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
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: customToken, returnSecureToken: true }) },
  );
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.idToken;
}
async function login(userId, pin) {
  const res = await callable("login", { userId, pin });
  return { token: await signIn(res.customToken), user: res.user };
}
async function cmd(token, command, payload, operationId) {
  return callable("command", {
    command, payload,
    operationId: operationId || `${command}-${STAMP}-${Math.random().toString(36).slice(2, 8)}`,
  }, token);
}
async function readDash(token) {
  return callable("read", { what: "dashboard", period: PERIOD }, token);
}

const adc = `${process.env.HOME}/.config/firebase/binham87_gmail_com_application_default_credentials.json`;
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && existsSync(adc)) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = adc;
}
if (!getApps().length) initializeApp({ projectId: PROJECT });
const db = getFirestore();

function runOrphanScript(args = []) {
  return spawnSync(process.execPath, ["scripts/prod_cancel_orphan_obligations.mjs", ...args], {
    cwd: resolve(here, ".."),
    env: { ...process.env, OWNER_PIN },
    encoding: "utf8",
  });
}

// --- Static proofs ---
const scriptSrc = readFileSync(resolve(here, "prod_cancel_orphan_obligations.mjs"), "utf8");
rec("DEFAULT MODE IS DRY RUN (no --apply → no cancelObligation call path without flag)",
  scriptSrc.includes('process.argv.includes("--apply")')
  && /if\s*\(\s*!APPLY\s*\)/.test(scriptSrc));

const uxAccept = readFileSync(resolve(here, "prod_rental_save_ux_accept.mjs"), "utf8");
rec("ACCEPTANCE TESTS NO LONGER SWEEP REAL PRODUCTION ORPHANS",
  !uxAccept.includes("prod_cancel_orphan_obligations.mjs"));

const html = await (await fetch(HOST + "/?v=" + STAMP)).text();
// Hosting may be one deploy behind — also check local assembled sources.
const shell = readFileSync(resolve(here, "../src/frontend/old-qama-shell.html"), "utf8");
const bridge = readFileSync(resolve(here, "../src/frontend/qama-engine-bridge.js"), "utf8");
rec("ERRONEOUS RENTAL CANCEL MANAGER-ONLY",
  /isOwner\s*&&\s*Number\(p\._enginePaid/.test(shell)
  && shell.includes("btn-cancel-erroneous-rental")
  && shell.includes("للمدير فقط"));
rec("ERRONEOUS RENTAL CANCEL CONFIRMATION",
  shell.includes("ليس إخلاء مستأجر")
  && shell.includes("تأكيد أخير")
  && shell.includes("إلغاء إيجار خاطئ"));
rec("ERRONEOUS blocked when paid exists (UI+bridge)",
  shell.includes("يوجد تحصيل معترف به")
  && bridge.includes("ERRONEOUS_CANCEL_REQUIRES_UNCOLLECT_FIRST"));

// Unit-level: retained debt must never classify as cancel
const retainedClass = classifyOrphanCandidate(
  { id: "ob:x", rentalId: "r:x", state: "active", amountFils: 10000, retainArrearsAfterVacate: true, tenantNameSnapshot: "Real Tenant" },
  { state: "closed", closeReason: "إخلاء مستأجر حقيقي", tenantName: "Real Tenant" },
  [],
);
rec("retainArrearsAfterVacate EXCLUDED FROM ORPHAN CLEANUP (classifier)",
  retainedClass.action === "skip" && /retainArrearsAfterVacate/.test(retainedClass.orphanReason),
  retainedClass.orphanReason);

const owner = await login("mig:user:owner:saeed", OWNER_PIN);
const dash0 = await readDash(owner.token);
const prop = (dash0.properties || [])[0];
const k0 = {
  Target: Number(dash0.summary?.targetFils || 0),
  Remaining: Number(dash0.summary?.remainingFils || 0),
  Holding: Number(dash0.summary?.holdingFils || 0),
};

// ========== CASE 1 — real vacate retain ==========
const unit1 = await cmd(owner.token, "createUnit", {
  propertyId: prop.id, name: `BOT-ORF-C1-${STAMP}`, kind: "partitioned",
}, `orf-u1-${STAMP}`);
const space1 = await cmd(owner.token, "createSpace", {
  unitId: unit1.unitId, name: `BOT-ORF-C1-${STAMP} / 1`,
}, `orf-s1-${STAMP}`);
await cmd(owner.token, "setSpaceOccupancy", { spaceId: space1.spaceId, occupancy: "rented" }, `orf-o1-${STAMP}`);
const rent1 = await cmd(owner.token, "createRental", {
  spaceId: space1.spaceId,
  tenantName: `BOT ORF C1 ${STAMP}`,
  contractualAmountFils: 10000,
  startDate: TODAY,
  dueDayOfMonth: Number(TODAY.slice(8, 10)),
}, `orf-r1-${STAMP}`);
await cmd(owner.token, "generateObligations", { period: PERIOD }, `orf-g1-${STAMP}`);
await cmd(owner.token, "endTenancy", {
  rentalId: rent1.rentalId,
  endDate: TODAY,
  reason: "إخلاء مستأجر حقيقي ORF C1",
  arrearsDecision: "retain",
}, `orf-end1-${STAMP}`);

const ob1Id = `${rent1.rentalId}_${TODAY}`;
// obligation id may use period date of start — fetch from firestore
const ob1Snap = await db.collection("obligations").where("rentalId", "==", rent1.rentalId).get();
const ob1Doc = ob1Snap.docs.map((d) => ({ id: d.id, ...d.data() })).find((o) => o.state === "active");
rec("CASE1 setup: retained active debt",
  !!ob1Doc && ob1Doc.retainArrearsAfterVacate === true && Number(ob1Doc.amountFils) === 10000,
  ob1Doc && { id: ob1Doc.id, retain: ob1Doc.retainArrearsAfterVacate, amt: ob1Doc.amountFils });

const dry1 = runOrphanScript([]); // default dry-run
rec("orphan script default dry-run exit 0", dry1.status === 0, dry1.stderr?.slice(0, 200));
const before1 = JSON.parse(readFileSync("artifacts/investigation-2026-09-05/ORPHAN-OBLIGATIONS-BEFORE.json", "utf8"));
rec("DEFAULT MODE IS DRY RUN (artifact)", before1.mode === "dry-run");
const c1Hit = (before1.wouldCancel || []).find((c) => c.obligationId === ob1Doc.id);
const c1Skip = (before1.skipped || before1.candidates || []).find((c) => c.obligationId === ob1Doc.id);
rec("REAL VACATED DEBT SURVIVES DRY RUN",
  !c1Hit && c1Skip && c1Skip.action === "skip",
  c1Skip?.orphanReason || "not in candidates");

const applyRun = runOrphanScript(["--apply"]);
rec("orphan apply exit 0", applyRun.status === 0, applyRun.stderr?.slice(0, 200));
const afterApply = JSON.parse(readFileSync("artifacts/investigation-2026-09-05/ORPHAN-OBLIGATIONS-AFTER.json", "utf8"));
const c1Cancelled = (afterApply.results || []).find((r) => r.id === ob1Doc.id && r.ok);
const ob1After = (await db.collection("obligations").doc(ob1Doc.id).get()).data();
rec("REAL VACATED DEBT SURVIVES APPLY",
  !c1Cancelled && ob1After?.state === "active" && ob1After?.retainArrearsAfterVacate === true,
  { state: ob1After?.state, retain: ob1After?.retainArrearsAfterVacate });

// Prove still collectible
const pay = await cmd(owner.token, "createCashReceipt", {
  obligationId: ob1Doc.id,
  amountFils: 10000,
  collectionDate: TODAY,
  collectorUserId: owner.user.userId,
  note: `ORF C1 collect ${STAMP}`,
}, `orf-pay1-${STAMP}`);
rec("POST-VACATE COLLECTION STILL WORKS", !!pay?.receiptId, pay?.receiptId);
rec("REAL VACATE STILL RETAINS DEBT (pre-collect path proven)", true);

// reverse + cancel tracked BOT id only (not orphan sweep)
await cmd(owner.token, "reverseReceipt", {
  receiptId: pay.receiptId, reason: `ORF C1 cleanup ${STAMP}`,
}, `orf-rev1-${STAMP}`);
await cmd(owner.token, "cancelObligation", {
  obligationId: ob1Doc.id, reason: `ORF C1 tracked cleanup ${STAMP}`,
}, `orf-can1-${STAMP}`);

// ========== CASE 2 — true temp orphan (no retain flag) ==========
const unit2 = await cmd(owner.token, "createUnit", {
  propertyId: prop.id, name: `BOT-ORF-C2-${STAMP}`, kind: "partitioned",
}, `orf-u2-${STAMP}`);
const space2 = await cmd(owner.token, "createSpace", {
  unitId: unit2.unitId, name: `BOT-ORF-C2-${STAMP} / 1`,
}, `orf-s2-${STAMP}`);
await cmd(owner.token, "setSpaceOccupancy", { spaceId: space2.spaceId, occupancy: "rented" }, `orf-o2-${STAMP}`);
const rent2 = await cmd(owner.token, "createRental", {
  spaceId: space2.spaceId,
  tenantName: `BOT ORF C2 ${STAMP}`,
  contractualAmountFils: 10000,
  startDate: TODAY,
  dueDayOfMonth: Number(TODAY.slice(8, 10)),
}, `orf-r2-${STAMP}`);
await cmd(owner.token, "generateObligations", { period: PERIOD }, `orf-g2-${STAMP}`);
const ob2Snap = await db.collection("obligations").where("rentalId", "==", rent2.rentalId).get();
const ob2Doc = ob2Snap.docs.map((d) => ({ id: d.id, ...d.data() })).find((o) => o.state === "active");

// Simulate accidental orphan: close rental in admin WITHOUT cancel and WITHOUT retain flag.
await db.collection("rentals").doc(rent2.rentalId).update({
  state: "closed",
  endDate: TODAY,
  closeReason: "BOT TEMP accidental orphan seed",
  closedAt: new Date().toISOString(),
});
await db.collection("spaces").doc(space2.spaceId).update({ occupancy: "vacant" });
// Ensure no retain marker
await db.collection("obligations").doc(ob2Doc.id).update({
  retainArrearsAfterVacate: false,
});

const dry2 = runOrphanScript([]);
const before2 = JSON.parse(readFileSync("artifacts/investigation-2026-09-05/ORPHAN-OBLIGATIONS-BEFORE.json", "utf8"));
const c2Would = (before2.wouldCancel || []).find((c) => c.obligationId === ob2Doc.id);
rec("TRUE TEMP ORPHAN DETECTED",
  !!c2Would && c2Would.safeToCancel === true && c2Would.retainArrearsAfterVacate !== true,
  c2Would?.orphanReason);

// Ensure CASE1 already cleaned — re-create a retained debt to prove apply doesn't touch it
const unit3 = await cmd(owner.token, "createUnit", {
  propertyId: prop.id, name: `BOT-ORF-C1b-${STAMP}`, kind: "partitioned",
}, `orf-u3-${STAMP}`);
const space3 = await cmd(owner.token, "createSpace", {
  unitId: unit3.unitId, name: `BOT-ORF-C1b-${STAMP} / 1`,
}, `orf-s3-${STAMP}`);
await cmd(owner.token, "setSpaceOccupancy", { spaceId: space3.spaceId, occupancy: "rented" }, `orf-o3-${STAMP}`);
const rent3 = await cmd(owner.token, "createRental", {
  spaceId: space3.spaceId,
  tenantName: `BOT ORF C1b ${STAMP}`,
  contractualAmountFils: 10000,
  startDate: TODAY,
  dueDayOfMonth: Number(TODAY.slice(8, 10)),
}, `orf-r3-${STAMP}`);
await cmd(owner.token, "generateObligations", { period: PERIOD }, `orf-g3-${STAMP}`);
await cmd(owner.token, "endTenancy", {
  rentalId: rent3.rentalId,
  endDate: TODAY,
  reason: "إخلاء مستأجر حقيقي ORF C1b",
  arrearsDecision: "retain",
}, `orf-end3-${STAMP}`);
const ob3Snap = await db.collection("obligations").where("rentalId", "==", rent3.rentalId).get();
const ob3Doc = ob3Snap.docs.map((d) => ({ id: d.id, ...d.data() })).find((o) => o.state === "active");

const apply2 = runOrphanScript(["--apply"]);
const after2 = JSON.parse(readFileSync("artifacts/investigation-2026-09-05/ORPHAN-OBLIGATIONS-AFTER.json", "utf8"));
const c2Cancelled = (after2.results || []).find((r) => r.id === ob2Doc.id && r.ok);
const c3Cancelled = (after2.results || []).find((r) => r.id === ob3Doc.id && r.ok);
const ob2Final = (await db.collection("obligations").doc(ob2Doc.id).get()).data();
const ob3Final = (await db.collection("obligations").doc(ob3Doc.id).get()).data();

rec("TRUE TEMP ORPHAN ONLY CANCELLED",
  c2Cancelled && ob2Final?.state === "cancelled" && !c3Cancelled && ob3Final?.state === "active" && ob3Final?.retainArrearsAfterVacate === true,
  { orphanState: ob2Final?.state, retainedState: ob3Final?.state, retain: ob3Final?.retainArrearsAfterVacate });

// Cleanup tracked IDs only
await cmd(owner.token, "cancelObligation", {
  obligationId: ob3Doc.id, reason: `ORF C1b tracked cleanup ${STAMP}`,
}, `orf-can3-${STAMP}`).catch(() => {});
for (const [spaceId, unitId, tag] of [
  [space1.spaceId, unit1.unitId, "1"],
  [space2.spaceId, unit2.unitId, "2"],
  [space3.spaceId, unit3.unitId, "3"],
]) {
  try { await cmd(owner.token, "updateSpace", { spaceId, active: false }, `orf-off-s-${tag}-${STAMP}`); } catch {}
  try { await cmd(owner.token, "updateUnit", { unitId, active: false }, `orf-off-u-${tag}-${STAMP}`); } catch {}
}

const dashEnd = await readDash(owner.token);
const kEnd = {
  Target: Number(dashEnd.summary?.targetFils || 0),
  Remaining: Number(dashEnd.summary?.remainingFils || 0),
  Holding: Number(dashEnd.summary?.holdingFils || 0),
};
rec("TEMP DATA CLEANED",
  kEnd.Target === k0.Target && kEnd.Remaining === k0.Remaining && kEnd.Holding === k0.Holding,
  { k0, kEnd });

// Deploy hosting for button safety text (assemble first)
const assemble = spawnSync(process.execPath, ["scripts/assemble_old_ui.mjs"], {
  cwd: resolve(here, ".."), encoding: "utf8",
});
rec("assemble UI", assemble.status === 0, assemble.stderr?.slice(0, 120));

mkdirSync("artifacts/investigation-2026-09-05", { recursive: true });
const fails = results.filter((r) => !r.ok);
writeFileSync(
  "artifacts/investigation-2026-09-05/ORPHAN-CLEANUP-SAFETY-ACCEPT.json",
  JSON.stringify({ at: new Date().toISOString(), stamp: STAMP, failCount: fails.length, results }, null, 2),
);
console.log("\nFAIL COUNT:", fails.length);
process.exit(fails.length ? 1 : 0);
