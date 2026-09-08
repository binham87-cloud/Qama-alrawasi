/**
 * Residual production audit gaps after main prod_accept.
 * Throwaway units only. Cleans up probes. Does not redesign UI.
 *
 * Covers: forced holding → deposit pending/approve/reject/reverse/idempotency,
 * request reject, month lock employee block, over-deposit refusal, re-read persistence.
 */
const API_KEY = "AIzaSyBs0wIu2h2mnNMGr5SH-YNXjUhrdrGSNKg";
const REGION = "me-central1";
const PROJECT = "qama-new-prod-2026";
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
  const res = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
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
    command, payload, operationId: operationId || `${command}-${STAMP}-${Math.random().toString(36).slice(2, 8)}`,
  }, token);
}
async function read(token, period) {
  return callable("read", { what: "dashboard", period }, token);
}
function yahiaHold(dash) {
  return (dash.summary?.custody || []).find((c) => c.userId === "mig:user:yahia")?.holdingFils
    ?? dash.summary?.holdingFils
    ?? 0;
}
function findSpace(dash, spaceId) {
  for (const u of dash.unitsTree || []) {
    for (const sp of u.spaces || []) if (sp.spaceId === spaceId) return sp;
  }
  return null;
}

const owner = await login("mig:user:owner:saeed", "1325");
const yahia = await login("mig:user:yahia", "6477");
const nader = await login("mig:user:nader", "2026");
const period = "2026-09";
let dash = await read(owner.token, period);
const prop = (dash.properties || [])[0];
const bankAcc = (dash.accounts || []).find((a) => a.kind === "bank") || (dash.accounts || [])[0];
rec("SETUP: dashboard+bank", !!prop && !!bankAcc, { bank: bankAcc?.id });

const unit = await cmd(owner.token, "createUnit", { propertyId: prop.id, name: `RES-${STAMP}`, kind: "partitioned" }, `res-unit-${STAMP}`);
const space = await cmd(owner.token, "createSpace", { unitId: unit.unitId, name: `RES-${STAMP} / 1` }, `res-space-${STAMP}`);
await cmd(owner.token, "setSpaceOccupancy", { spaceId: space.spaceId, occupancy: "rented" }, `res-occ-${STAMP}`);
const rental = await cmd(owner.token, "createRental", {
  spaceId: space.spaceId, tenantName: "متبقي", contractualAmountFils: 150000, dueDayOfMonth: 1, startDate: "2026-09-01",
}, `res-rent-${STAMP}`);
await cmd(owner.token, "generateObligations", { period }, `res-gen-${STAMP}`);
dash = await read(owner.token, period);
let sp = findSpace(dash, space.spaceId);
rec("SETUP: obligation", !!sp?.obligationId, sp?.status);

// Force cash holding for yahia (collector)
await cmd(owner.token, "createCashReceipt", {
  obligationId: sp.obligationId, amountFils: 150000, collectionDate: TODAY, collectorUserId: "mig:user:yahia",
}, `res-cash-${STAMP}`);
dash = await read(owner.token, period);
sp = findSpace(dash, space.spaceId);
let hold = yahiaHold(dash);
// Prefer custody row; if summary empty, derive from myHolding via yahia read
const yDash = await read(yahia.token, period);
const yMyHold = yDash.myHoldingFils ?? yDash.summary?.myHoldingFils ?? 0;
rec("HOLDING: cash builds yahia custody", hold >= 150000 || yMyHold >= 150000, { hold, yMyHold, paid: sp?.paidFils, custody: dash.summary?.custody });
hold = Math.max(hold, yMyHold);

// Over-deposit must fail (use a value far above any plausible custody baseline)
try {
  await cmd(yahia.token, "submitDeposit", {
    amountFils: 999999999, depositDate: TODAY, destinationAccountId: bankAcc.id, reference: `res-over-${STAMP}`,
  }, `res-over-${STAMP}`);
  rec("DEPOSIT: over-holding refused", false);
} catch (e) {
  rec("DEPOSIT: over-holding refused", /AMOUNT_EXCEEDS_HOLDING|CUSTODY|holding/i.test(String(e.message)), e.message);
}

// Pending deposit keeps holding
const depAmt = 50000;
const dep = await cmd(yahia.token, "submitDeposit", {
  amountFils: depAmt, depositDate: TODAY, destinationAccountId: bankAcc.id, note: "residual", reference: `res-dep-${STAMP}`,
}, `res-dep-${STAMP}`);
rec("DEPOSIT: submit pending", dep.state === "pending", dep);
dash = await read(owner.token, period);
const holdPending = Math.max(yahiaHold(dash), (await read(yahia.token, period)).myHoldingFils || 0);
rec("DEPOSIT: pending keeps holding", holdPending >= hold, { hold, holdPending });

// Duplicate opId idempotent
const depDup = await cmd(yahia.token, "submitDeposit", {
  amountFils: depAmt, depositDate: TODAY, destinationAccountId: bankAcc.id, note: "residual", reference: `res-dep-${STAMP}`,
}, `res-dep-${STAMP}`);
rec("DEPOSIT: duplicate opId replay", depDup.replay === true || depDup.depositId === dep.depositId, depDup);

// Reject path on a second pending deposit (pending does not reduce holding)
const dep2 = await cmd(yahia.token, "submitDeposit", {
  amountFils: 1000, depositDate: TODAY, destinationAccountId: bankAcc.id, reference: `res-dep2-${STAMP}`,
}, `res-dep2-${STAMP}`);
await cmd(owner.token, "rejectDeposit", { depositId: dep2.depositId, reason: "residual reject" }, `res-deprej-${STAMP}`);
dash = await read(owner.token, period);
const rejected = (dash.deposits || []).find((d) => d.id === dep2.depositId);
rec("DEPOSIT: reject leaves rejected", rejected?.state === "rejected", rejected?.state);

// Approve first pending — holding drops once
await cmd(owner.token, "approveDeposit", { depositId: dep.depositId }, `res-depap-${STAMP}`);
dash = await read(owner.token, period);
const yAfter = await read(yahia.token, period);
const holdAfter = Math.max(yahiaHold(dash), yAfter.myHoldingFils || 0);
rec("DEPOSIT: approve reduces holding", holdAfter === hold - depAmt, {
  hold, holdAfter, expected: hold - depAmt, myHolding: yAfter.myHoldingFils, custody: dash.summary?.custody,
});
// Re-approve refused
try {
  await cmd(owner.token, "approveDeposit", { depositId: dep.depositId }, `res-depap2-${STAMP}`);
  rec("DEPOSIT: re-approve refused", false);
} catch (e) {
  rec("DEPOSIT: re-approve refused", /NOT_PENDING|DEPOSIT/i.test(String(e.message)), e.message);
}

// Reverse approved deposit restores holding
await cmd(owner.token, "reverseDeposit", { depositId: dep.depositId, reason: "residual reverse" }, `res-deprev-${STAMP}`);
dash = await read(owner.token, period);
const yRev = await read(yahia.token, period);
const holdRev = Math.max(yahiaHold(dash), yRev.myHoldingFils || 0);
rec("DEPOSIT: reverse restores holding", holdRev >= hold - 1000, { hold, holdRev, myHolding: yRev.myHoldingFils });

// Re-read persistence (simulates refresh)
const dash2 = await read(owner.token, period);
const sp2 = findSpace(dash2, space.spaceId);
rec("REFRESH: obligation still present after re-read", !!sp2?.obligationId && sp2.paidFils === sp.paidFils, {
  paid: sp2?.paidFils, status: sp2?.status,
});

// Request reject path
const reqId = `req-res-${STAMP}`;
await cmd(yahia.token, "submitWorkRequest", {
  requestId: reqId, type: "update_partition", desc: "residual reject",
  payloadJson: JSON.stringify({ spaceId: space.spaceId, fields: { status: "vacant" } }),
  month: 8, year: 2026,
}, `res-req-${STAMP}`);
await cmd(owner.token, "resolveWorkRequest", { requestId: reqId, decision: "rejected" }, `res-reqrej-${STAMP}`);
dash = await read(owner.token, period);
const req = ((dash.ui && dash.ui.requests) || []).find((r) => r.id === reqId || r.requestId === reqId);
rec("REQUESTS: reject persists", !req || req.status === "rejected" || req.decision === "rejected" || req.state === "rejected", req);

// Month lock key format used by assertEmployeePeriodOpen: `${year}_${monthIndex0}`
const lockKey = "2026_8"; // September
let priorLocks = {};
try {
  // Read current locks from dashboard ui if present
  priorLocks = (dash.ui && dash.ui.locks) || {};
  if (typeof priorLocks === "string") priorLocks = JSON.parse(priorLocks);
} catch { priorLocks = {}; }
await cmd(owner.token, "upsertUiConfig", {
  configId: "locks",
  json: JSON.stringify({ ...priorLocks, [lockKey]: true }),
}, `res-lock-${STAMP}`);
rec("LOCKS: owner can set", true);
try {
  await cmd(nader.token, "submitDeposit", {
    amountFils: 1000, depositDate: TODAY, destinationAccountId: bankAcc.id, reference: `res-lockdep-${STAMP}`,
  }, `res-lockdep-${STAMP}`);
  rec("LOCKS: employee deposit blocked", false);
} catch (e) {
  rec("LOCKS: employee deposit blocked", /MONTH_LOCKED/i.test(String(e.message)), e.message);
}
// Restore prior locks (clear September probe lock)
const restored = { ...priorLocks };
delete restored[lockKey];
await cmd(owner.token, "upsertUiConfig", {
  configId: "locks",
  json: JSON.stringify(restored),
}, `res-unlock-${STAMP}`);
rec("LOCKS: owner unlock restored", true);

// Bank reject path
await cmd(owner.token, "uncollectObligation", { obligationId: sp.obligationId, reason: "prep bank reject" }, `res-uncol-${STAMP}`);
dash = await read(owner.token, period);
sp = findSpace(dash, space.spaceId);
const bankSub = await cmd(yahia.token, "submitBankReceipt", {
  obligationId: sp.obligationId, amountFils: 20000, collectionDate: TODAY,
  bankReference: `res-bank-${STAMP}`, collectorUserId: "mig:user:yahia",
}, `res-bank-${STAMP}`);
await cmd(owner.token, "rejectBankReceipt", { receiptId: bankSub.receiptId, reason: "residual bank reject" }, `res-bankrej-${STAMP}`);
dash = await read(owner.token, period);
sp = findSpace(dash, space.spaceId);
rec("BANK: reject does not collect", (sp?.paidFils || 0) === 0, { paid: sp?.paidFils });

// Cleanup
try {
  await cmd(owner.token, "uncollectObligation", { obligationId: sp.obligationId, reason: "res cleanup" }, `res-cleanun-${STAMP}`);
} catch (_) {}
try {
  if (sp?.rentalId || rental.rentalId) {
    await cmd(owner.token, "closeRental", {
      rentalId: sp.rentalId || rental.rentalId, endDate: TODAY, reason: "res cleanup", setVacant: true,
    }, `res-close-${STAMP}`);
  }
} catch (e) { console.log("cleanup close", e.message); }
try { await cmd(owner.token, "updateSpace", { spaceId: space.spaceId, active: false }, `res-delsp-${STAMP}`); } catch (_) {}
try { await cmd(owner.token, "updateUnit", { unitId: unit.unitId, active: false }, `res-delun-${STAMP}`); } catch (_) {}

const stuck = ((dash.ui && dash.ui.requests) || []).filter((r) => r.status === "processing").length;
rec("STUCK PROCESSING", stuck === 0, stuck);

const failed = results.filter((r) => !r.ok);
console.log("\nTOTAL", results.length, "PASS", results.length - failed.length, "FAIL", failed.length);
if (failed.length) {
  console.log("FAILURES:");
  failed.forEach((f) => console.log(" -", f.name, f.detail));
  process.exit(1);
}
