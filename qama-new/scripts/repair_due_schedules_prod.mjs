/**
 * READ-THEN-REPAIR: sync dueDayOfMonth from contract start day for active rentals
 * in qama-new-prod-2026. Does not change paid amounts — only schedule fields.
 *
 * Usage:
 *   node scripts/repair_due_schedules_prod.mjs --dry-run
 *   node scripts/repair_due_schedules_prod.mjs --apply
 */
import { dueDateFor } from "../functions/domain/finance.mjs";

const API_KEY = "AIzaSyBs0wIu2h2mnNMGr5SH-YNXjUhrdrGSNKg";
const REGION = "me-central1";
const PROJECT = "qama-new-prod-2026";
const PERIOD = "2026-09";
const APPLY = process.argv.includes("--apply");

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
  return { token: await signIn(res.customToken), user: res.user };
}
async function cmd(token, command, payload, operationId) {
  return callable("command", { command, payload, operationId }, token);
}
async function read(token, period) {
  return callable("read", { what: "dashboard", period }, token);
}

function dayOf(iso) {
  return Math.min(31, Math.max(1, Number(String(iso || "").slice(8, 10)) || 1));
}

const owner = await login("mig:user:owner:saeed", "1325");
const dash = await read(owner.token, PERIOD);
const extras = (dash.ui && dash.ui.extras && dash.ui.extras.spaces) || {};

const mismatches = [];
for (const u of dash.unitsTree || []) {
  for (const sp of u.spaces || []) {
    if (!sp.rentalId || !sp.startDate) continue;
    const extra = extras[sp.spaceId] || {};
    // Prefer UI-entered start when present (manager "بداية من"); else engine start.
    const intendedStart =
      extra.start_date && /^\d{4}-\d{2}-\d{2}$/.test(extra.start_date)
        ? extra.start_date
        : sp.startDate;
    const wantDay = dayOf(intendedStart);
    const wantDue = dueDateFor(PERIOD, wantDay);
    const dayMismatch = Number(sp.dueDayOfMonth) !== wantDay;
    const dueMismatch = sp.dueDate && sp.dueDate !== wantDue;
    const startMismatch = sp.startDate !== intendedStart;
    if (dayMismatch || dueMismatch || startMismatch) {
      mismatches.push({
        unit: u.name,
        space: sp.name,
        spaceId: sp.spaceId,
        rentalId: sp.rentalId,
        before: {
          startDate: sp.startDate,
          dueDayOfMonth: sp.dueDayOfMonth,
          dueDate: sp.dueDate,
          status: sp.status,
          paidFils: sp.paidFils,
          extraStart: extra.start_date || null,
        },
        after: { startDate: intendedStart, dueDayOfMonth: wantDay, dueDate: wantDue },
      });
    }
  }
}

console.log(JSON.stringify({
  project: PROJECT,
  period: PERIOD,
  mode: APPLY ? "APPLY" : "DRY_RUN",
  affected: mismatches.length,
  sample: mismatches.slice(0, 8),
  unit9: mismatches.find((m) => /\/\s*9$/.test(m.space) || m.space.endsWith(" 9") || m.space.includes("/ 9")),
}, null, 2));

if (!APPLY) {
  console.log("Dry-run only. Re-run with --apply to repair.");
  process.exit(0);
}

const results = [];
for (const m of mismatches) {
  try {
    const r = await cmd(
      owner.token,
      "updateRentalSchedule",
      { rentalId: m.rentalId, startDate: m.after.startDate },
      `repair-sched-${m.rentalId}-${PERIOD}`
    );
    results.push({ rentalId: m.rentalId, space: m.space, ok: true, r });
  } catch (e) {
    results.push({ rentalId: m.rentalId, space: m.space, ok: false, error: String(e.message || e) });
  }
}

const afterDash = await read(owner.token, PERIOD);
let stillBad = 0;
const unit9After = [];
for (const u of afterDash.unitsTree || []) {
  for (const sp of u.spaces || []) {
    if (!sp.rentalId || !sp.startDate) continue;
    const wantDay = dayOf(sp.startDate);
    const wantDue = dueDateFor(PERIOD, wantDay);
    if (Number(sp.dueDayOfMonth) !== wantDay || (sp.dueDate && sp.dueDate !== wantDue)) stillBad++;
    if (/\/\s*9$/.test(sp.name) || sp.name.includes("/ 9")) {
      unit9After.push({
        name: sp.name,
        startDate: sp.startDate,
        dueDayOfMonth: sp.dueDayOfMonth,
        dueDate: sp.dueDate,
        status: sp.status,
        paidFils: sp.paidFils,
      });
    }
  }
}

console.log(JSON.stringify({
  repaired: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok),
  stillMismatchAfter: stillBad,
  unit9After,
}, null, 2));
