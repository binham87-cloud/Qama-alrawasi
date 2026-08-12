import assert from "node:assert/strict";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createPinRecord } from "../functions/pin_crypto.mjs";

const projectId=process.env.GCLOUD_PROJECT||"qama-test";
initializeApp({projectId});
const db=getFirestore();
await db.collection("users").doc("uid_pin_test").set({userKey:"pin_test",name:"مستخدم اختبار",role:"employee",active:true});
await db.collection("authPins").doc("pin_test").set({uid:"uid_pin_test",name:"مستخدم اختبار",active:true,sortOrder:1,...createPinRecord("4826",100000)});

const base=`http://127.0.0.1:5001/${projectId}/us-central1`;
async function call(name,data){
  const res=await fetch(`${base}/${name}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({data})});
  return {status:res.status,body:await res.json()};
}

const list=await call("listPinUsers",{});
assert.equal(list.status,200);
assert.deepEqual(list.body.result.users,[{userKey:"pin_test",name:"مستخدم اختبار"}]);
assert.equal(JSON.stringify(list.body).includes("pinHash"),false);
assert.equal(JSON.stringify(list.body).includes("uid_pin_test"),false);

const wrong=await call("pinLogin",{userKey:"pin_test",pin:"0000"});
assert.notEqual(wrong.status,200);
assert.equal(JSON.stringify(wrong.body).includes("PIN_INVALID"),true);

const ok=await call("pinLogin",{userKey:"pin_test",pin:"4826"});
assert.equal(ok.status,200);
assert.equal(typeof ok.body.result.token,"string");
assert.ok(ok.body.result.token.length>20);
console.log("PIN Functions Emulator: list آمنة + رفض الخاطئ + إصدار token للصحيح — نجح");
