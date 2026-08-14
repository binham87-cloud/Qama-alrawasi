/**
 * R1.2 — rent:0 wipe defenses (client sanitize + server reject + owner detect)
 * Does not invent a new vacate-zero workflow; only blocks accidental wipe on live positive rent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyApprovedBusinessRequest, applyOwnerRentalPatch } from "../functions/domain/operational_commands.mjs";
import { _diffFields, parseMoneyInputRaw, sanitizeRentalDiff } from "./logic_extracted.mjs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const publicHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const owner = { id: "saeed", role: "owner", active: true };

function monthDoc(part = {}) {
  return {
    data: {
      units: [{
        id: "u1",
        name: "شقة",
        partitions: [
          { id: 1, rent: 1000, status: "late", tenant: "T1", phone: "0501111000", version: 0, operationalVersion: 0, ...part },
          { id: 10, rent: 2500, status: "late", tenant: "T10", phone: "0501010000", version: 0, operationalVersion: 0 },
        ],
      }],
      full: [{ id: "104", rent: 9000, status: "late", tenant: "Full", phone: "0509999000", version: 0, operationalVersion: 0 }],
      transactions: [],
    },
  };
}

test("R1.2-00 build sync .4 + three defense layers present", () => {
  assert.equal(html, publicHtml);
  assert.match(html, /qama-unified-final-2026-08-14\.4/);
  assert.match(html, /function parseMoneyInputRaw/);
  assert.match(html, /function sanitizeRentalDiff/);
  assert.match(html, /function rentalDiffLooksLikeRentWipe/);
  assert.match(html, /if\(rentalDiffLooksLikeRentWipe\(req\)\)/);
  assert.match(html, /RENT_ZERO_WIPE_DENIED/);
});

test("R1.2-01 blank money input is not Number(\"\")→0", () => {
  assert.equal(parseMoneyInputRaw(""), null);
  assert.equal(parseMoneyInputRaw("   "), null);
  assert.equal(parseMoneyInputRaw("1200"), 1200);
  assert.equal(parseMoneyInputRaw("0"), 0);
});

test("R1.2-02 phone-only diff never ships rent", () => {
  const snap = { rent: 1000, phone: "0501111000", tenant: "T1", status: "late" };
  const d = _diffFields({ ...snap, phone: "0501111999" }, snap);
  assert.deepEqual(Object.keys(d.fields).sort(), ["phone"]);
  assert.equal(d.fields.phone, "0501111999");
  assert.equal(Object.prototype.hasOwnProperty.call(d.fields, "rent"), false);
});

test("R1.2-03 polluted rent:0 from empty input is stripped from employee payload", () => {
  const snap = { rent: 1000, phone: "0501111000", tenant: "T1" };
  const d = _diffFields({ ...snap, phone: "0501111999", rent: 0 }, snap);
  assert.equal(Object.prototype.hasOwnProperty.call(d.fields, "rent"), false);
  assert.equal(d.fields.phone, "0501111999");
  const wiped = sanitizeRentalDiff({
    fields: { rent: 0, phone: "x" },
    originalFields: { rent: 1000, phone: "y" },
    count: 2,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(wiped.fields, "rent"), false);
});

test("R1.2-04 intentional rent 1000→1200 remains a real field change", () => {
  const snap = { rent: 1000, phone: "050", tenant: "T" };
  const d = _diffFields({ ...snap, rent: 1200 }, snap);
  assert.equal(d.fields.rent, 1200);
  assert.equal(d.originalFields.rent, 1000);
});

test("R1.2-05 server rejects update_partition rent:0 wipe on positive rent", () => {
  assert.throws(() => applyApprovedBusinessRequest(monthDoc(), {
    type: "update_partition",
    payload: { unitId: "u1", partId: 1, fields: { rent: 0, phone: "0501111999" }, originalFields: { rent: 1000, phone: "0501111000" } },
  }, owner), /RENT_ZERO_WIPE_DENIED/);
  const part = monthDoc().data.units[0].partitions[0];
  assert.equal(part.rent, 1000);
});

test("R1.2-06 server rejects update_full rent:0 wipe", () => {
  assert.throws(() => applyApprovedBusinessRequest(monthDoc(), {
    type: "update_full",
    payload: { unitId: "104", fields: { rent: 0 }, originalFields: { rent: 9000 } },
  }, owner), /RENT_ZERO_WIPE_DENIED/);
});

test("R1.2-07 owner direct rental patch also rejects rent:0 wipe", () => {
  assert.throws(() => applyOwnerRentalPatch(monthDoc(), {
    target: { entityType: "partition", unitId: "u1", entityId: 1 },
    patch: { rent: 0 },
    baseVersion: 0,
  }, owner), /RENT_ZERO_WIPE_DENIED/);
});

test("R1.2-08 intentional rent increase still applies once", () => {
  const out = applyApprovedBusinessRequest(monthDoc(), {
    type: "update_partition",
    payload: { unitId: "u1", partId: 1, fields: { rent: 1200 }, originalFields: { rent: 1000 }, baseVersion: 0 },
  }, owner);
  assert.equal(out.data.units[0].partitions[0].rent, 1200);
  assert.equal(out.data.units[0].partitions[1].rent, 2500);
  assert.equal(out.financialEffectFils, 0);
});

test("R1.2-09 phone-only approve does not touch rent (partition collision safe)", () => {
  const out = applyApprovedBusinessRequest(monthDoc(), {
    type: "update_partition",
    payload: { unitId: "u1", partId: 1, fields: { phone: "0501111999" }, originalFields: { phone: "0501111000" }, baseVersion: 0 },
  }, owner);
  assert.equal(out.data.units[0].partitions[0].phone, "0501111999");
  assert.equal(out.data.units[0].partitions[0].rent, 1000);
  assert.equal(out.data.units[0].partitions[1].rent, 2500);
  assert.equal(out.data.units[0].partitions[1].phone, "0501010000");
});

test("R1.2-10 add_partition vacant seed rent:0 remains legitimate", () => {
  const out = applyApprovedBusinessRequest(monthDoc(), {
    type: "add_partition",
    payload: {
      unitId: "u1",
      part: { id: 99, rent: 0, status: "vacant", tenant: "", note: "", version: 0 },
    },
  }, owner);
  const added = out.data.units[0].partitions.find((p) => Number(p.id) === 99);
  assert.ok(added);
  assert.equal(added.rent, 0);
  assert.equal(added.status, "vacant");
});

test("R1.2-11 stale baseVersion blocks silent overwrite on approve", () => {
  assert.throws(() => applyApprovedBusinessRequest(monthDoc({ version: 2 }), {
    type: "update_partition",
    payload: {
      unitId: "u1", partId: 1,
      fields: { phone: "0500000111" },
      originalFields: { phone: "0501111000" },
      baseVersion: 0,
    },
  }, owner), /STALE_OPERATIONAL_ENTITY/);
});

test("R1.2-12 rent may stay 0 when entity already had rent 0 (no wipe)", () => {
  const vacant = monthDoc({ rent: 0, status: "vacant", tenant: "" });
  const out = applyApprovedBusinessRequest(vacant, {
    type: "update_partition",
    payload: { unitId: "u1", partId: 1, fields: { note: "ملاحظة" }, originalFields: { note: "" }, baseVersion: 0 },
  }, owner);
  assert.equal(out.data.units[0].partitions[0].rent, 0);
  assert.equal(out.data.units[0].partitions[0].note, "ملاحظة");
});
