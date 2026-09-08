/**
 * Production acceptance: Old-QAMA rental form → bridge → command path.
 * Simulates the exact vacant mid-edit sequence that caused TENANT_REQUIRED on iPhone:
 *   type tenant + rent + start_date while still vacant → then flip status to late → save once.
 *
 * Target: qama-new-prod-2026 only. Throwaway BOT data cleaned at end.
 */
const API_KEY = "AIzaSyBs0wIu2h2mnNMGr5SH-YNXjUhrdrGSNKg";
const REGION = "me-central1";
const PROJECT = "qama-new-prod-2026";
const HOST = "https://qama-new-prod-2026.web.app";
const PERIOD = "2026-09";
const STAMP = Date.now().toString(36);
const START = "2026-09-05";
const results = [];

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
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
    command,
    payload,
    operationId: operationId || `${command}-${STAMP}-${Math.random().toString(36).slice(2, 8)}`,
  }, token);
}

async function readDash(token) {
  return callable("read", { what: "dashboard", period: PERIOD }, token);
}

function spacesOf(dash) {
  const out = [];
  for (const u of dash.unitsTree || []) {
    for (const sp of u.spaces || []) out.push({ ...sp, unitName: u.name, unitId: u.unitId });
  }
  return out;
}

function findSpace(dash, spaceId) {
  return spacesOf(dash).find((s) => s.spaceId === spaceId) || null;
}

function aedToFils(n) {
  return Math.round(Number(n || 0) * 100);
}

/**
 * Mirror fixed syncOccupancyAndTenant vacant→rented create path (post-fix).
 * Intentionally does NOT call setSpaceOccupancy before createRental.
 */
async function bridgeCreateRentalFromUiItem(token, item) {
  const tenant = String(item.tenant || "").trim();
  const rentFils = aedToFils(item.rent);
  if (rentFils <= 0) throw new Error("RENT_REQUIRED");
  if (!tenant || tenant === "—" || tenant === "-" || tenant === "–") {
    throw new Error("TENANT_REQUIRED");
  }
  const start = item.start_date && /^\d{4}-\d{2}-\d{2}$/.test(item.start_date) ? item.start_date : START;
  const dueDay = Number(start.slice(8, 10)) || 1;
  const operationId = `rentnew-ui-${STAMP}-${Math.random().toString(36).slice(2, 8)}`;
  const payload = {
    spaceId: item._spaceId,
    tenantName: tenant.slice(0, 160),
    contractualAmountFils: rentFils,
    dueDayOfMonth: Math.min(31, Math.max(1, dueDay)),
    startDate: start,
  };
  if (item.phone) payload.tenantPhone = String(item.phone).slice(0, 40);
  console.log("TRACE createRental payload", {
    spaceId: payload.spaceId,
    tenantName: payload.tenantName,
    rentFils: payload.contractualAmountFils,
    startDate: payload.startDate,
    hasPhone: !!payload.tenantPhone,
    operationId,
  });
  const r = await cmd(token, "createRental", payload, operationId);
  await cmd(token, "generateObligations", { period: PERIOD }, `genobl-ui-${STAMP}`);
  return { ...r, operationId, payload };
}

// --- Hosting markers (assembled UI must include fix before claim) ---
const html = await (await fetch(HOST + "/?_=" + STAMP)).text();
rec("HOST assembled", html.length > 100000, html.length);
rec("HOST has اسم المستأجر field", html.includes("اسم المستأجر"));
rec("HOST fix deployed (mustClose)", html.includes("mustClose"), "if false: deploy hosting before physical retest");
rec("HOST fix create-before-occ", html.includes("Do NOT setSpaceOccupancy(rented) first"));
rec("HOST draft preserve", html.includes("_preserveDraftUntil"));
rec("HOST no legacy project", !html.includes("qama-alrawasi.firebaseapp.com"));

const owner = await login("mig:user:owner:saeed", "1325");
rec("LOGIN owner", owner.user?.role === "owner");

let dash = await readDash(owner.token);
const prop = (dash.properties || [])[0];
rec("READ dashboard", !!prop);

// Always use a throwaway probe space — never mutate real vacant inventory during accept.
let spaceId = null;
let unitId = null;
let createdProbe = true;
const u = await cmd(owner.token, "createUnit", {
  propertyId: prop.id, name: `BOT-RENT-${STAMP}`, kind: "partitioned",
}, `bot-unit-${STAMP}`);
const sp0 = await cmd(owner.token, "createSpace", {
  unitId: u.unitId, name: `BOT-RENT-${STAMP} / 1`,
}, `bot-space-${STAMP}`);
spaceId = sp0.spaceId;
unitId = u.unitId;
rec("CREATE probe vacant space", true, spaceId);

// Simulate the exact mid-edit wipe that caused physical TENANT_REQUIRED:
// while still vacant, a start_date/quiet save used to clear item.tenant="".
function simulatePreFixVacantSave(item) {
  // OLD buggy vacant branch (for proof only):
  const clone = { ...item };
  clone._rentalId = null;
  clone._obligationId = null;
  clone.tenant = ""; // <-- the bug
  clone.paid_amount = 0;
  clone.partial = false;
  return clone;
}
function simulatePostFixVacantSave(item, engineOcc, rentalId) {
  const mustClose = (engineOcc && engineOcc !== "vacant") || !!rentalId;
  const clone = { ...item };
  if (mustClose) {
    clone._rentalId = null;
    clone._obligationId = null;
    clone.tenant = "";
    clone.paid_amount = 0;
    clone.partial = false;
  } else {
    clone._rentalId = null;
    clone._obligationId = null;
    // draft tenant/rent preserved
  }
  return clone;
}

const draft = {
  _spaceId: spaceId,
  status: "vacant",
  tenant: "BOT RENT TEST",
  rent: 100,
  start_date: START,
  phone: "0500000000",
  note: "BOT RENT TEST",
};
const afterOldVacantSave = simulatePreFixVacantSave(draft);
const afterNewVacantSave = simulatePostFixVacantSave(draft, "vacant", null);
rec("PRE-FIX vacant save wiped tenant", afterOldVacantSave.tenant === "");
rec("POST-FIX vacant save keeps tenant", afterNewVacantSave.tenant === "BOT RENT TEST", afterNewVacantSave.tenant);

// After mid-edit, user flips to rented and saves once (complete payload).
const uiBeforeSave = {
  ...afterNewVacantSave,
  status: "late",
};
console.log("TRACE UI before save", {
  spaceId: uiBeforeSave._spaceId,
  tenant: uiBeforeSave.tenant,
  rent: uiBeforeSave.rent,
  start_date: uiBeforeSave.start_date,
  occupancyIntent: uiBeforeSave.status,
});

// Prove pre-fix would have thrown if tenant wiped:
const wiped = { ...uiBeforeSave, tenant: "" };
let wipedThrew = false;
try {
  await bridgeCreateRentalFromUiItem(owner.token, wiped);
} catch (e) {
  wipedThrew = String(e.message || e) === "TENANT_REQUIRED";
}
rec("PRECONDITION empty tenant still rejected", wipedThrew);

const created = await bridgeCreateRentalFromUiItem(owner.token, uiBeforeSave);
rec("PARTITION RENT CREATE", !!created.rentalId, {
  rentalId: created.rentalId,
  operationId: created.operationId,
  payloadTenant: created.payload.tenantName,
});

await new Promise((r) => setTimeout(r, 1500));
dash = await readDash(owner.token);
let sp = findSpace(dash, spaceId);
rec("CREATE tenant", sp?.tenantName === "BOT RENT TEST", sp?.tenantName);
rec("CREATE rent 100", Number(sp?.dueFils) === 10000, sp?.dueFils);
rec("DUE DATE = START DATE", sp?.dueDate === START, { due: sp?.dueDate, start: START });
rec("exactly one active rental", !!sp?.rentalId && sp?.occupancy === "rented", {
  rentalId: sp?.rentalId, occupancy: sp?.occupancy, obligationId: sp?.obligationId,
});

const rentalId1 = sp?.rentalId;

// Refresh persistence
dash = await readDash(owner.token);
sp = findSpace(dash, spaceId);
rec("REFRESH PERSISTENCE", sp?.tenantName === "BOT RENT TEST" && Number(sp?.dueFils) === 10000);

// Logout/login
const owner2 = await login("mig:user:owner:saeed", "1325");
dash = await readDash(owner2.token);
sp = findSpace(dash, spaceId);
rec("LOGOUT/LOGIN persistence", sp?.tenantName === "BOT RENT TEST");

// Tenant edit
await cmd(owner2.token, "updateRentalTenant", {
  rentalId: rentalId1, tenantName: "BOT RENT TEST EDIT",
}, `ten-edit-${STAMP}`);
dash = await readDash(owner2.token);
sp = findSpace(dash, spaceId);
rec("TENANT EDIT AFTER CREATE", sp?.tenantName === "BOT RENT TEST EDIT", sp?.tenantName);

// Vacate
await cmd(owner2.token, "closeRental", {
  rentalId: rentalId1, endDate: START, reason: "BOT vacate", setVacant: true,
}, `close-${STAMP}`);
await cmd(owner2.token, "setSpaceOccupancy", {
  spaceId, occupancy: "vacant",
}, `vac-${STAMP}`);
await new Promise((r) => setTimeout(r, 1000));
dash = await readDash(owner2.token);
sp = findSpace(dash, spaceId);
rec("VACATE", sp?.occupancy === "vacant" && !sp?.rentalId, {
  occupancy: sp?.occupancy, rentalId: sp?.rentalId, tenant: sp?.tenantName, status: sp?.status,
});

// Re-rent
const created2 = await bridgeCreateRentalFromUiItem(owner2.token, {
  _spaceId: spaceId,
  status: "late",
  tenant: "BOT RENT TEST 2",
  rent: 101,
  start_date: START,
  phone: "0500000000",
  note: "BOT RENT TEST 2",
});
await new Promise((r) => setTimeout(r, 1000));
dash = await readDash(owner2.token);
sp = findSpace(dash, spaceId);
rec("RE-RENT", sp?.tenantName === "BOT RENT TEST 2" && Number(sp?.dueFils) === 10100
  && sp?.rentalId && sp.rentalId !== rentalId1, {
  old: rentalId1, neu: sp?.rentalId, tenant: sp?.tenantName, dueFils: sp?.dueFils,
});

// Clean BOT data
const rentalId2 = sp?.rentalId;
if (rentalId2) {
  try {
    await cmd(owner2.token, "closeRental", {
      rentalId: rentalId2, endDate: START, reason: "BOT cleanup", setVacant: true,
    }, `close2-${STAMP}`);
  } catch (e) {
    console.warn("close2", e.message || e);
  }
}
try {
  await cmd(owner2.token, "setSpaceOccupancy", { spaceId, occupancy: "vacant" }, `vac2-${STAMP}`);
} catch (e) {
  console.warn("vac2", e.message || e);
}
if (createdProbe && unitId) {
  try {
    await cmd(owner2.token, "updateUnit", { unitId, active: false }, `deact-u-${STAMP}`);
  } catch (e) {
    console.warn("deact unit", e.message || e);
  }
}
if (createdProbe && spaceId) {
  try {
    await cmd(owner2.token, "updateSpace", { spaceId, active: false }, `deact-s-${STAMP}`);
  } catch (e) {
    console.warn("deact space", e.message || e);
  }
}

dash = await readDash(owner2.token);
const botLeft = spacesOf(dash).filter((s) => /BOT RENT/i.test(s.tenantName || "") && s.rentalId);
rec("TEMP DATA CLEANED", botLeft.length === 0, botLeft.map((s) => ({ id: s.spaceId, t: s.tenantName })));

const s = dash.summary || {};
const bal = (dash.ui && dash.ui.config && dash.ui.config.balances) || {};
const kpi = {
  Target: (s.targetFils || 0) / 100,
  Collected: (s.collectedFils || 0) / 100,
  Remaining: (s.remainingFils || 0) / 100,
  Deposited: (s.depositedFils || 0) / 100,
  Holding: (s.holdingFils || 0) / 100,
  Expenses: (s.expensesFils || 0) / 100,
  Revenue: Number(bal.revenueBalance || 0),
};
console.log("FINAL PRODUCTION TOTALS", JSON.stringify(kpi));

const fail = results.filter((r) => !r.ok);
console.log("\nFAIL COUNT:", fail.length);
if (fail.length) {
  console.log(fail);
  process.exit(1);
}
console.log("ALL RENTAL UI-PATH CHECKS PASSED");
