/**
 * A stale period save may update only the entity it owns.
 * Rows absent from the client snapshot stay on the server.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { freshDb, run, bootstrapOwner, createUser, actorFrom, opId } from "../helpers/commands.mjs";

function patchBody(extra) {
  return {
    period: "2026-10",
    writeMode: "patch",
    scopes: extra.scopes,
    extrasJson: JSON.stringify(extra.body),
  };
}

async function seedOctober(db, owner) {
  await run(db, owner, "savePeriodExtras", {
    period: "2026-10",
    extrasJson: JSON.stringify({
      dailyBookings: [{ id: "B0", guest: "قبل", total: 400 }],
      unitMaintenance: [{ id: "M0", desc: "صيانة", amount: 50 }],
      facilityMaintenance: [],
      spaces: { A: { note: "مسودة أ", phone: "050" }, B: { note: "مسودة ب", phone: "052" } },
      profits: [{ id: "P0", amount: 2500 }],
      installments: [{ id: "I0", amount: 800 }],
      logs: [{ id: "L0", text: "قديم" }],
      marker: "keep-me",
    }),
  }, opId("seed-oct"));
}

function saved(db) {
  return JSON.parse(db.dump("uiPeriods")[0].extrasJson);
}

test("stale space patch keeps a newer daily booking, maintenance row, and other space", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  await seedOctober(db, owner);
  await run(db, owner, "savePeriodExtras", patchBody({
    scopes: "dailyBookings",
    body: { upserts: { dailyBookings: [{ id: "B1", guest: "جديد", total: 750 }] }, removedIds: {} },
  }), opId("add-b1"));
  await run(db, owner, "savePeriodExtras", patchBody({
    scopes: "unitMaintenance",
    body: { upserts: { unitMaintenance: [{ id: "M1", desc: "صيانة لاحقة", amount: 90 }] }, removedIds: {} },
  }), opId("add-m1"));
  await run(db, owner, "savePeriodExtras", patchBody({
    scopes: "spaces",
    body: {
      touchedSpaceIds: ["B"],
      spacePatches: { B: { note: "محدّثة", phone: "052" } },
      removedIds: {},
    },
  }), opId("edit-b"));

  await run(db, owner, "savePeriodExtras", patchBody({
    scopes: "spaces",
    body: {
      touchedSpaceIds: ["A"],
      spacePatches: { A: { note: "تعديل أ", phone: "050" }, B: { note: "نسخة قديمة", phone: "000" } },
      upserts: { dailyBookings: [], unitMaintenance: [] },
      removedIds: {},
    },
  }), opId("stale-space"));

  const doc = saved(db);
  assert.deepEqual(doc.dailyBookings.map((r) => r.id).sort(), ["B0", "B1"]);
  assert.equal(doc.dailyBookings.find((r) => r.id === "B1").total, 750);
  assert.deepEqual(doc.unitMaintenance.map((r) => r.id).sort(), ["M0", "M1"]);
  assert.equal(doc.spaces.B.note, "محدّثة");
  assert.equal(doc.spaces.A.note, "تعديل أ");
  assert.equal(doc.marker, "keep-me");
  assert.equal(doc.profits[0].id, "P0");
  assert.equal(doc.installments[0].id, "I0");
});

test("explicit removal drops one daily booking and leaves the rest", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  await seedOctober(db, owner);
  await run(db, owner, "savePeriodExtras", patchBody({
    scopes: "dailyBookings",
    body: { upserts: {}, removedIds: { dailyBookings: ["B0"] } },
  }), opId("del-b0"));
  const doc = saved(db);
  assert.equal(doc.dailyBookings.length, 0);
  assert.equal(doc.unitMaintenance[0].id, "M0");
  assert.equal(doc.spaces.A.note, "مسودة أ");
});

test("employee patch cannot replace owner profits or installments", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const emp = actorFrom(await createUser(db, owner, { displayName: "يحيى", role: "employee", pin: "1234" }));
  await seedOctober(db, owner);
  await run(db, emp, "savePeriodExtras", patchBody({
    scopes: "profits,installments,dailyBookings",
    body: {
      upserts: {
        profits: [{ id: "P9", amount: 1 }],
        installments: [],
        dailyBookings: [{ id: "B2", total: 120 }],
      },
      removedIds: { profits: ["P0"], installments: ["I0"] },
    },
  }), opId("emp-patch"));
  const doc = saved(db);
  assert.equal(doc.profits.length, 1);
  assert.equal(doc.profits[0].id, "P0");
  assert.equal(doc.installments[0].id, "I0");
  assert.ok(doc.dailyBookings.some((r) => r.id === "B2"));
});

test("replace mode still replaces the document for the owner", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  await seedOctober(db, owner);
  await run(db, owner, "savePeriodExtras", {
    period: "2026-10",
    extrasJson: JSON.stringify({ dailyBookings: [{ id: "only", total: 10 }] }),
  }, opId("replace"));
  const doc = saved(db);
  assert.equal(doc.dailyBookings.length, 1);
  assert.equal(doc.marker, undefined);
});

test("the month screen sends a scoped patch and names deletions", () => {
  const bridge = readFileSync(new URL("../../src/frontend/qama-engine-bridge.js", import.meta.url), "utf8");
  const shell = readFileSync(new URL("../../src/frontend/old-qama-shell.html", import.meta.url), "utf8");
  assert.match(bridge, /writeMode: "patch"/);
  assert.match(bridge, /scopes: patch\.scopes\.join\(/);
  assert.match(shell, /_extrasRemoved\.dailyBookings/);
  assert.match(shell, /data-testid":"holding-unallocated"/);
});
