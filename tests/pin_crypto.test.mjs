import assert from "node:assert/strict";
import test from "node:test";
import { createPinRecord, verifyPin } from "../functions/pin_crypto.mjs";

test("PIN الصحيح يطابق والرقم الخاطئ لا يطابق", () => {
  const record=createPinRecord("4826",100000);
  assert.equal(verifyPin("4826",record),true);
  assert.equal(verifyPin("4825",record),false);
});

test("كل PIN يحصل على salt مختلف ولا يُحفظ كنص", () => {
  const a=createPinRecord("4826",100000), b=createPinRecord("4826",100000);
  assert.notEqual(a.pinSalt,b.pinSalt);
  assert.notEqual(a.pinHash,b.pinHash);
  assert.equal(JSON.stringify(a).includes("4826"),false);
});

test("يرفض PIN غير المكوّن من أربعة أرقام", () => {
  assert.throws(()=>createPinRecord("123"),/PIN_INVALID/);
  assert.throws(()=>createPinRecord("12a4"),/PIN_INVALID/);
});
