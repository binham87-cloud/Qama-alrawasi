/**
 * Unknown employees must not inherit the owner key.
 * The three production identities stay on their existing keys.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { actorKey } from "../../functions/commands/index.mjs";
import { freshDb, run, bootstrapOwner, createUser, opId } from "../helpers/commands.mjs";

test("production user ids keep nader, yahia, and saeed", () => {
  assert.equal(actorKey({ userId: "mig:user:nader" }), "nader");
  assert.equal(actorKey({ userId: "mig:user:yahia" }), "yahia");
  assert.equal(actorKey({ userId: "mig:user:owner:saeed" }), "saeed");
});

test("a fourth employee is not labeled saeed", async () => {
  const db = freshDb();
  const owner = await bootstrapOwner(db);
  const fourth = await createUser(db, owner, { displayName: "خالد", role: "employee", pin: "2468" });
  assert.equal(String(fourth.userId).includes("saeed"), false);
  const key = actorKey(fourth);
  assert.notEqual(key, "saeed");
  assert.notEqual(key, "nader");
  assert.notEqual(key, "yahia");

  const submitted = await run(db, fourth, "submitWorkRequest", {
    requestId: "req-fourth-1",
    type: "note",
    desc: "طلب الموظف الرابع",
    payloadJson: "{}",
    month: 9,
    year: 2026,
  }, opId("fourth-req"));
  const doc = db.dump("uiRequests").find((r) => r.id === submitted.requestId);
  assert.equal(doc.byKey, key);
  assert.equal(doc.byName, "خالد");
  assert.notEqual(doc.byKey, "saeed");
});
