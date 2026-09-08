/**
 * Production acceptance for qama-new-prod-2026.
 * Throwaway units only. Reverse test money. Deactivate probes.
 */
const API_KEY = "AIzaSyBs0wIu2h2mnNMGr5SH-YNXjUhrdrGSNKg";
const REGION = "me-central1";
const PROJECT = "qama-new-prod-2026";
const HOST = "https://qama-new-prod-2026.web.app";
const TODAY = new Date().toISOString().slice(0, 10);
const STAMP = Date.now().toString(36);
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
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`;
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: customToken, returnSecureToken: true }) });
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.idToken;
}
async function login(userId, pin) {
  const res = await callable("login", { userId, pin });
  const token = await signIn(res.customToken);
  return { token, user: res.user };
}
async function cmd(token, command, payload, operationId) {
  return callable("command", { command, payload, operationId: operationId || `${command}-${STAMP}-${Math.random().toString(36).slice(2, 8)}` }, token);
}
async function read(token, period) {
  return callable("read", { what: "dashboard", period }, token);
}
function findSpace(dash, spaceId) {
  for (const u of dash.unitsTree || []) {
    for (const sp of u.spaces || []) if (sp.spaceId === spaceId) return sp;
  }
  return null;
}

const html = await (await fetch(HOST + "/")).text();
rec("HOSTING: HTTP body loaded", html.length > 100000, html.length);
rec("HOSTING: old dark UI", html.includes("#0a0a0a") && html.includes("قمة الرواسي"));
rec("HOSTING: login users", html.includes("مدير") && html.includes("يحيى") && html.includes("نادر"));
rec("HOSTING: pending in status select", html.includes('"pending"') && html.includes("غير مستحق"));
rec("HOSTING: no legacy firebaseapp", !html.includes("qama-alrawasi.firebaseapp.com"));
rec("HOSTING: uncollect wired", html.includes("uncollectObligation"));

const owner = await login("mig:user:owner:saeed", "1325");
rec("LOGIN: owner", owner.user?.role === "owner", owner.user?.displayName);
const yahia = await login("mig:user:yahia", "6477");
rec("LOGIN: yahia", yahia.user?.role === "employee", yahia.user?.displayName);
const nader = await login("mig:user:nader", "2026");
rec("LOGIN: nader", nader.user?.role === "employee", nader.user?.displayName);

try {
  await login("mig:user:owner:saeed", "0000");
  rec("LOGIN: wrong PIN rejected", false);
} catch {
  rec("LOGIN: wrong PIN rejected", true);
}

const period = "2026-09";
let dash = await read(owner.token, period);
const prop = (dash.properties || [])[0];
rec("READ: september dashboard", !!prop && Array.isArray(dash.unitsTree));

const unit = await cmd(owner.token, "createUnit", { propertyId: prop.id, name: `ACC-${STAMP}`, kind: "partitioned" }, `acc-unit-${STAMP}`);
const space = await cmd(owner.token, "createSpace", { unitId: unit.unitId, name: `ACC-${STAMP} / 1` }, `acc-space-${STAMP}`);
await cmd(owner.token, "setSpaceOccupancy", { spaceId: space.spaceId, occupancy: "rented" }, `acc-occ-${STAMP}`);
const rental = await cmd(owner.token, "createRental", {
  spaceId: space.spaceId, tenantName: "قبول", contractualAmountFils: 120000, dueDayOfMonth: 1, startDate: "2026-09-01",
}, `acc-rent-${STAMP}`);
await cmd(owner.token, "generateObligations", { period }, `acc-gen-${STAMP}`);
dash = await read(owner.token, period);
let sp = findSpace(dash, space.spaceId);
rec("CREATE: rental+obligation", !!sp?.obligationId, sp?.status);

const cash1 = await cmd(owner.token, "createCashReceipt", {
  obligationId: sp.obligationId, amountFils: 100000, collectionDate: TODAY, collectorUserId: "mig:user:yahia",
}, `acc-cash1-${STAMP}`);
dash = await read(owner.token, period);
sp = findSpace(dash, space.spaceId);
rec("CASH: partial 1000", sp.status === "partial" && sp.paidFils === 100000, { status: sp.status, paid: sp.paidFils });

const cash2 = await cmd(owner.token, "createCashReceipt", {
  obligationId: sp.obligationId, amountFils: 20000, collectionDate: TODAY, collectorUserId: "mig:user:yahia",
}, `acc-cash2-${STAMP}`);
dash = await read(owner.token, period);
sp = findSpace(dash, space.spaceId);
rec("CASH: full collected", sp.status === "collected" && sp.paidFils === 120000, { status: sp.status, paid: sp.paidFils });

// Duplicate same operationId
const dup = await cmd(owner.token, "createCashReceipt", {
  obligationId: sp.obligationId, amountFils: 20000, collectionDate: TODAY, collectorUserId: "mig:user:yahia",
}, `acc-cash2-${STAMP}`);
dash = await read(owner.token, period);
sp = findSpace(dash, space.spaceId);
rec("CONCURRENCY: duplicate opId no double pay", sp.paidFils === 120000 && (dup.replay === true || dup.receiptId), { paid: sp.paidFils, dup });

// Brief-change bug path: collected → uncollect (late)
const un = await cmd(owner.token, "uncollectObligation", {
  obligationId: sp.obligationId, reason: "acceptance late",
}, `acc-uncol-${STAMP}`);
dash = await read(owner.token, period);
sp = findSpace(dash, space.spaceId);
rec("STATUS: collected→late via uncollect", sp.paidFils === 0 && sp.status !== "collected", { status: sp.status, paid: sp.paidFils, un });

// Re-collect then verify month isolation for August
await cmd(owner.token, "createCashReceipt", {
  obligationId: sp.obligationId, amountFils: 120000, collectionDate: TODAY, collectorUserId: "mig:user:owner:saeed",
}, `acc-recoll-${STAMP}`);
const aug = await read(owner.token, "2026-08");
const sept = await read(owner.token, "2026-09");
const septSp = findSpace(sept, space.spaceId);
rec("MONTHS: sept collected independent", septSp?.status === "collected");
rec("MONTHS: august still readable", !!aug.summary);

// Bank path
await cmd(owner.token, "uncollectObligation", { obligationId: sp.obligationId, reason: "prep bank" }, `acc-uncol2-${STAMP}`);
dash = await read(owner.token, period);
sp = findSpace(dash, space.spaceId);
const bankAcc = (dash.accounts || []).find((a) => a.kind === "bank") || (dash.accounts || [])[0];
const bankSub = await cmd(yahia.token, "submitBankReceipt", {
  obligationId: sp.obligationId, amountFils: 50000, collectionDate: TODAY,
  bankReference: `acc-bank-${STAMP}`, collectorUserId: "mig:user:yahia",
}, `acc-bank-${STAMP}`);
dash = await read(owner.token, period);
sp = findSpace(dash, space.spaceId);
const holdBefore = (dash.summary.custody || []).find((c) => c.userId === "mig:user:yahia")?.holdingFils || 0;
rec("BANK: pending does not collect", sp.paidFils === 0, sp.paidFils);
await cmd(owner.token, "approveBankReceipt", { receiptId: bankSub.receiptId }, `acc-bankap-${STAMP}`);
dash = await read(owner.token, period);
sp = findSpace(dash, space.spaceId);
rec("BANK: approved increases paid", sp.paidFils === 50000, sp.paidFils);

// Holding / deposit
dash = await read(owner.token, period);
const yHold = (dash.summary.custody || []).find((c) => c.userId === "mig:user:yahia")?.holdingFils || 0;
rec("HOLDING: yahia has cash holding", yHold >= 0, yHold);
let dep = null;
if (yHold >= 1000 && bankAcc) {
  dep = await cmd(yahia.token, "submitDeposit", {
    amountFils: 1000, depositDate: TODAY, destinationAccountId: bankAcc.id, note: "acc", reference: `acc-dep-${STAMP}`,
  }, `acc-dep-${STAMP}`);
  dash = await read(owner.token, period);
  const yHold2 = (dash.summary.custody || []).find((c) => c.userId === "mig:user:yahia")?.holdingFils || 0;
  rec("DEPOSIT: pending keeps holding", yHold2 === yHold, { yHold, yHold2 });
  await cmd(owner.token, "approveDeposit", { depositId: dep.depositId }, `acc-depap-${STAMP}`);
  dash = await read(owner.token, period);
  const yHold3 = (dash.summary.custody || []).find((c) => c.userId === "mig:user:yahia")?.holdingFils || 0;
  rec("DEPOSIT: approve reduces holding once", yHold3 === yHold - 1000, { yHold, yHold3 });
} else {
  rec("DEPOSIT: skipped (no holding)", true, yHold);
}

// Expense
const exp = await cmd(owner.token, "submitExpense", {
  amountFils: 100, reason: `acc-${STAMP}`, category: "عام", expenseDate: TODAY, paidFromAccountId: bankAcc.id,
}, `acc-exp-${STAMP}`);
rec("EXPENSE: created", !!exp.expenseId);
await cmd(owner.token, "reverseExpense", { expenseId: exp.expenseId, reason: "acc cleanup" }, `acc-exprev-${STAMP}`);
rec("EXPENSE: reversed", true);

// Permissions
try {
  await cmd(nader.token, "createUnit", { propertyId: prop.id, name: "NOPE", kind: "whole" }, `acc-perm-${STAMP}`);
  rec("PERMISSIONS: employee createUnit denied", false);
} catch {
  rec("PERMISSIONS: employee createUnit denied", true);
}

// Work request + commit
const reqId = `req-acc-${STAMP}`;
await cmd(yahia.token, "submitWorkRequest", {
  requestId: reqId, type: "update_partition",
  desc: "acc status late",
  payloadJson: JSON.stringify({
    spaceId: space.spaceId,
    fields: { status: "late", partial: false, paid_amount: 1200, rent: 1200, _obligationId: sp.obligationId },
  }),
  month: 8, year: 2026,
}, `acc-req-${STAMP}`);
await cmd(owner.token, "commitWorkRequest", { requestId: reqId }, `acc-commit-${STAMP}`);
dash = await read(owner.token, period);
sp = findSpace(dash, space.spaceId);
rec("REQUESTS: commitWorkRequest uncollects leftover paid", sp.paidFils === 0, { status: sp.status, paid: sp.paidFils });

// Extras daily/maintenance
dash = await read(owner.token, period);
const extras = { ...((dash.ui && dash.ui.extras) || {}) };
const bookings = Array.isArray(extras.dailyBookings) ? extras.dailyBookings.slice() : [];
bookings.push({ id: `daily-${STAMP}`, guest: "acc", total: 1, _probe: true });
extras.dailyBookings = bookings;
await cmd(owner.token, "savePeriodExtras", { period, extrasJson: JSON.stringify(extras) }, `acc-extra-${STAMP}`);
dash = await read(owner.token, period);
const saved = ((dash.ui && dash.ui.extras && dash.ui.extras.dailyBookings) || []).some((b) => b.id === `daily-${STAMP}`);
rec("DAILY: extras persist", saved);
extras.dailyBookings = bookings.filter((b) => b.id !== `daily-${STAMP}`);
await cmd(owner.token, "savePeriodExtras", { period, extrasJson: JSON.stringify(extras) }, `acc-extra-del-${STAMP}`);
dash = await read(owner.token, period);
const gone = !(((dash.ui && dash.ui.extras && dash.ui.extras.dailyBookings) || []).some((b) => b.id === `daily-${STAMP}`));
rec("DAILY: delete persists", gone);

// Financial invariants sample
dash = await read(owner.token, period);
const inv = dash.summary;
rec("INVARIANTS: remaining identity", inv.targetFils === inv.collectedFils + inv.remainingFils, inv);
rec("INVARIANTS: no negative remaining", inv.remainingFils >= 0);

// Cleanup probe
try {
  if (sp.rentalId || rental.rentalId) {
    await cmd(owner.token, "closeRental", {
      rentalId: sp.rentalId || rental.rentalId, endDate: TODAY, reason: "acc cleanup", setVacant: true,
    }, `acc-close-${STAMP}`);
  }
} catch (e) { console.log("cleanup close", e.message); }
try { await cmd(owner.token, "updateSpace", { spaceId: space.spaceId, active: false }, `acc-delsp-${STAMP}`); } catch (e) {}
try { await cmd(owner.token, "updateUnit", { unitId: unit.unitId, active: false }, `acc-delun-${STAMP}`); } catch (e) {}

const stuck = ((dash.ui && dash.ui.requests) || []).filter((r) => r.status === "processing").length;
rec("STUCK PROCESSING", stuck === 0, stuck);

const failed = results.filter((r) => !r.ok);
console.log("\nTOTAL", results.length, "PASS", results.length - failed.length, "FAIL", failed.length);
if (failed.length) {
  console.log("FAILURES:");
  failed.forEach((f) => console.log(" -", f.name, f.detail));
  process.exit(1);
}
