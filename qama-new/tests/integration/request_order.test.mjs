/**
 * Request lists come from storage in arbitrary order.
 * The read model must return newest creation first, including after approval.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { freshDb, run, bootstrapOwner, createUser, actorFrom, opId } from "../helpers/commands.mjs";
import { buildDashboard } from "../../functions/services/readModel.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const shell = readFileSync(resolve(root, "src/frontend/old-qama-shell.html"), "utf8");

const T = {
  R1: "2026-10-01T08:00:00.000Z",
  R2: "2026-10-02T08:00:00.000Z",
  R3: "2026-10-03T08:00:00.000Z",
  R4: "2026-10-04T08:00:00.000Z",
};

function withList(mem) {
  return {
    async list(collection, wheres = []) {
      return mem.dump(collection).filter((d) => {
        for (const [field, op, value] of wheres || []) {
          if (op !== "==") throw new Error(`unsupported op ${op}`);
          if (d[field] !== value) return false;
        }
        return true;
      });
    },
    async getUser(id) { return mem.getUser(id); },
  };
}

function seedRequest(mem, id, createdAt, extra = {}) {
  mem.seed("uiRequests", id, {
    id,
    type: extra.type || "add_expense",
    desc: extra.desc || id,
    payloadJson: extra.payloadJson || "{}",
    month: 9,
    year: 2026,
    by: extra.by || "mig:user:yahia",
    byKey: extra.byKey || "yahia",
    byName: extra.byName || "يحيى",
    status: extra.status || "pending",
    createdAt,
    resolvedAt: extra.resolvedAt || null,
    approvedAt: extra.approvedAt || null,
    submittedAt: extra.submittedAt,
  });
}

async function dashOf(mem) {
  const db = withList(mem);
  const viewer = { userId: "mig:user:owner:saeed", role: "owner", displayName: "سعيد", active: true };
  return buildDashboard({ db, viewer, period: "2026-10", asOfDate: "2026-10-09" });
}

test("read model returns shuffled requests newest-created first", async () => {
  const mem = freshDb();
  mem.seed("users", "mig:user:owner:saeed", {
    id: "mig:user:owner:saeed", displayName: "سعيد", role: "owner", active: true,
  });
  // Deliberately not insertion order and not id order.
  seedRequest(mem, "R2", T.R2);
  seedRequest(mem, "R4", T.R4);
  seedRequest(mem, "R1", T.R1);
  seedRequest(mem, "R3", T.R3);
  const first = await dashOf(mem);
  assert.deepEqual(first.ui.requests.map((r) => r.id), ["R4", "R3", "R2", "R1"]);

  seedRequest(mem, "R2", T.R2, {
    status: "approved",
    resolvedAt: "2026-10-09T23:30:00.000Z",
    approvedAt: "2026-10-09T23:30:00.000Z",
  });
  const afterApproval = await dashOf(mem);
  assert.deepEqual(afterApproval.ui.requests.map((r) => r.id), ["R4", "R3", "R2", "R1"]);
  assert.equal(afterApproval.ui.requests.find((r) => r.id === "R2").status, "approved");
  assert.equal(afterApproval.ui.requests.find((r) => r.id === "R2").createdAt, T.R2);

  const relogin = await dashOf(mem);
  assert.deepEqual(relogin.ui.requests.map((r) => r.id), afterApproval.ui.requests.map((r) => r.id));
});

test("manager pending and employee history stay newest-first after refresh", async () => {
  const mem = freshDb();
  seedRequest(mem, "R1", T.R1, { status: "pending", byKey: "yahia", by: "mig:user:yahia" });
  seedRequest(mem, "R3", T.R3, { status: "pending", byKey: "nader", by: "mig:user:nader", byName: "نادر" });
  seedRequest(mem, "R2", T.R2, {
    status: "approved", byKey: "yahia", by: "mig:user:yahia",
    resolvedAt: "2026-10-09T21:00:00.000Z", approvedAt: "2026-10-09T21:00:00.000Z",
  });
  seedRequest(mem, "R4", T.R4, { status: "pending", byKey: "yahia", by: "mig:user:yahia" });
  const dash = await dashOf(mem);
  const pending = dash.ui.requests.filter((r) => r.status === "pending");
  const yahia = dash.ui.requests.filter((r) => r.byKey === "yahia" || r.by === "yahia");
  assert.deepEqual(pending.map((r) => r.id), ["R4", "R3", "R1"]);
  assert.deepEqual(yahia.map((r) => r.id), ["R4", "R2", "R1"]);
});

test("legacy uiRequest without createdAt does not sort as new", async () => {
  const mem = freshDb();
  seedRequest(mem, "R4", T.R4);
  mem.seed("uiRequests", "legacy", {
    id: "legacy", type: "add_expense", desc: "old", payloadJson: "{}",
    month: 8, year: 2026, by: "mig:user:yahia", byKey: "yahia", byName: "يحيى",
    status: "approved", resolvedAt: "2026-10-09T23:59:00.000Z", submittedAt: "2026-08-01T00:00:00.000Z",
  });
  const dash = await dashOf(mem);
  assert.deepEqual(dash.ui.requests.map((r) => r.id), ["R4", "legacy"]);
  assert.equal(dash.ui.requests[1].createdAt, "2026-08-01T00:00:00.000Z");
});

test("requests page sorts each section newest-first and does not order by approval time", () => {
  assert.match(shell, /sortRequestsNewestFirst\(mergedRequests\)/);
  assert.match(shell, /orderReqRows\(S\.pendingRequests\.filter\(r=>r\.status==="pending"\)\)/);
  assert.match(shell, /sortRequestsNewestFirst\(S\.pendingRequests\.filter\(r=>isMyRequest\(r\)\)\)/);
  assert.ok(!shell.includes("S.pendingRequests = [...terminalBank, ...byReqId.values(), ...enginePending]"));
  assert.ok(!shell.includes("createdAt: d.depositDate || d.approvedAt || d.rejectedAt"));
  assert.match(shell, /orderReqRows\(\[\.\.\.bankDone, \.\.\.otherDone\]\)/);
});

test("employee period save cannot erase owner profit or installment mirrors", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const emp = actorFrom(await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "1234" }));
  await run(db, owner, "savePeriodExtras", {
    period: "2026-10",
    extrasJson: JSON.stringify({
      profits: [{ id: "p1", amount: 5000, date: "2026-10-02" }],
      installments: [{ id: "i1", amount: 1000, date: "2026-10-03" }],
      dailyBookings: [],
      spaces: { s1: { note: "owner" } },
    }),
  }, opId("own-extras"));

  await run(db, emp, "savePeriodExtras", {
    period: "2026-10",
    extrasJson: JSON.stringify({
      profits: [],
      installments: [],
      dailyBookings: [{ id: "b1", total: 300 }],
      spaces: { s1: { note: "emp draft" } },
    }),
  }, opId("emp-extras"));

  const saved = JSON.parse(db.dump("uiPeriods")[0].extrasJson);
  assert.equal(saved.profits.length, 1);
  assert.equal(saved.profits[0].id, "p1");
  assert.equal(saved.installments.length, 1);
  assert.equal(saved.installments[0].id, "i1");
  assert.equal(saved.dailyBookings[0].id, "b1");
  assert.equal(saved.spaces.s1.note, "emp draft");

  await run(db, owner, "savePeriodExtras", {
    period: "2026-10",
    extrasJson: JSON.stringify({
      profits: [{ id: "p2", amount: 100 }],
      installments: [],
      dailyBookings: saved.dailyBookings,
      spaces: saved.spaces,
    }),
  }, opId("own-replace"));
  const ownerSaved = JSON.parse(db.dump("uiPeriods")[0].extrasJson);
  assert.equal(ownerSaved.profits[0].id, "p2");
  assert.equal(ownerSaved.installments.length, 0);
});
