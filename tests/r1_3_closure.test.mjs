/**
 * R1.3 pre-R2 closure — static + domain proofs for Owner-mandated approval paths.
 * Does not replace the consolidated browser HAT.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  applyApprovedBusinessRequest,
  businessRequestTypes,
  assertBusinessRequestType,
} from "../functions/domain/operational_commands.mjs";
import { blankState, executeCommand } from "../functions/domain/command_processor.mjs";
import { money } from "../functions/domain/financial_engine.mjs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const publicHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const owner = { id: "saeed", role: "owner", active: true };
const employee = { id: "yahia", role: "employee", active: true };
const manager = { id: "mgr", role: "owner", active: true };

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

test("R1.3-00 index/public parity + BUILD .5", () => {
  assert.equal(html, publicHtml);
  assert.equal(sha256(html), sha256(publicHtml));
  assert.match(html, /qama-unified-final-2026-08-14\.6-rc1/);
  assert.doesNotMatch(html, /qama-unified-final-2026-08-14\.5/);
});

test("R1.3-01 add_daily is a business request type", () => {
  assert.ok(businessRequestTypes.includes("add_daily"));
  assert.equal(assertBusinessRequestType("add_daily"), "add_daily");
});

test("R1.3-02 employee createDailyBooking denied at engine", () => {
  assert.throws(
    () => executeCommand(blankState(), "createDailyBooking", {
      operationId: "op:r13:deny",
      actor: employee,
      payload: { tenancyId: "daily:t1", unitId: "unit:1", tenant: "G", amountFils: money(100), method: "cash", paymentDate: "2026-08-01" },
      now: "2026-08-01T12:00:00.000Z",
    }),
    /MANAGER_REQUIRED/,
  );
});

test("R1.3-03 employee UI queues add_daily; owner approve wires createDailyBooking once", () => {
  assert.match(html, /submitBusinessRequestViaServer\(type, desc, payload\)/);
  assert.match(html, /identity:"approve-daily:"\+req\.id/);
  assert.match(html, /role!=="owner"[\s\S]{0,80}?role!=="manager"|role==="owner"\|\|role==="manager"[\s\S]{0,200}?submitBusinessRequestViaServer/);
  assert.match(html, /تم إرسال الطلب لاعتماد المدير/);
  // Owner approve path: financial mint keyed by request id, then business approve.
  const approveIdx = html.indexOf('identity:"approve-daily:"+req.id');
  assert.ok(approveIdx > 0);
  assert.ok(html.slice(approveIdx, approveIdx + 1200).includes('approveBusinessRequest'));
});

test("R1.3-04 structural request UI exposed to employees", () => {
  assert.match(html, /طلب حذف البارتشن/);
  assert.match(html, /طلب حذف الشقة/);
  assert.match(html, /طلب شقة بارتشنات/);
  assert.match(html, /طلب شقة كاملة/);
  assert.match(html, /submitRequest\("delete_partition"/);
  assert.match(html, /submitRequest\("add_unit"/);
  assert.match(html, /submitRequest\("add_full_unit"/);
  assert.match(html, /submitRequest\("add_partition"/);
});

test("R1.3-05 approve add_daily mirrors month booking once and is idempotent on re-apply key", () => {
  const month = { data: { units: [], full: [], dailyBookings: [] } };
  const booking = {
    partId: "u1-1", partLabel: "شقة / 1", guest: "نزيل", startDate: "2026-08-01",
    endDate: "2026-08-03", nights: 2, nightRate: 100, total: 200, paymentMethod: "cash", status: "paid",
  };
  const req = { id: "req_daily_1", type: "add_daily", payload: { booking } };
  const first = applyApprovedBusinessRequest(month, req, owner);
  assert.equal(first.data.dailyBookings.length, 1);
  assert.equal(first.data.dailyBookings[0].requestId, "req_daily_1");
  assert.equal(first.financialEffectFils, 0);
  const second = applyApprovedBusinessRequest({ data: first.data }, req, owner);
  assert.equal(second.data.dailyBookings.length, 1);
});

test("R1.3-06 manager mint daily booking still allowed", () => {
  const { state } = executeCommand(blankState(), "createDailyBooking", {
    operationId: "op:r13:ok",
    actor: manager,
    payload: { tenancyId: "daily:t1", unitId: "unit:1", tenant: "G", amountFils: money(100), method: "cash", paymentDate: "2026-08-01" },
    now: "2026-08-01T12:00:00.000Z",
  });
  assert.equal(state.dailyBookings.length, 1);
});

test("R1.3-07 deposit remains request→approve path", () => {
  assert.match(html, /command:"createDepositRequest"/);
  assert.match(html, /command:"approveDeposit"/);
  assert.match(html, /تم إرسال طلب الإيداع لاعتماد المدير/);
  assert.match(html, /type==="add_transaction"[\s\S]{0,400}?approveDeposit/);
});

test("R1.3-08 write machine-readable action inventory artifact", () => {
  const types = [...html.matchAll(/submitRequest\("([a-z_]+)"/g)].map((m) => m[1]);
  const uniq = [...new Set(types)].sort();
  const financialCmds = [...html.matchAll(/command:"([A-Za-z]+)"/g)].map((m) => m[1]);
  const finUniq = [...new Set(financialCmds)].sort();
  const inventory = {
    build: "qama-unified-final-2026-08-14.6-rc1",
    businessRequestTypes,
    submitRequestTypesInUi: uniq,
    financialCommandsReferencedInUi: finUniq,
    notes: {
      confirm_handover: "peer custody confirmation — not Owner approval",
      reject_handover: "peer custody rejection — not Owner approval",
      add_daily: "employee → submitBusinessRequest; owner approve → createDailyBooking + approveBusinessRequest",
      add_expense: "requestExpense / approveExpense",
      add_transaction: "createDepositRequest / approveDeposit",
    },
  };
  mkdirSync(new URL("../artifacts", import.meta.url), { recursive: true });
  writeFileSync(new URL("../artifacts/r1_3_action_inventory.json", import.meta.url), JSON.stringify(inventory, null, 2));
  assert.ok(uniq.includes("add_daily"));
  assert.ok(uniq.includes("update_partition"));
  assert.ok(businessRequestTypes.includes("add_daily"));
});
