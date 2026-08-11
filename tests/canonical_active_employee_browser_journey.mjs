import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import {initializeApp} from "firebase-admin/app";
import {getFirestore} from "firebase-admin/firestore";
import {createPinRecord} from "../functions/pin_crypto.mjs";

process.env.FIRESTORE_EMULATOR_HOST||="127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST||="127.0.0.1:9099";
const projectId=process.env.GCLOUD_PROJECT||"qama-alrawasi";
const admin=initializeApp({projectId},"canonical-active-routing-admin"),db=getFirestore(admin);
await db.collection("config").doc("system").set({financialMigrationV11:{completed:true}});
await db.collection("config").doc("canonicalControl").set({state:"CANONICAL_ACTIVE",version:2});
await db.collection("users").doc("uid_active_employee").set({userKey:"active_employee",name:"موظف قانوني",role:"employee",active:true});
await db.collection("authPins").doc("active_employee").set({uid:"uid_active_employee",name:"موظف قانوني",active:true,sortOrder:1,...createPinRecord("4826",100000)});
await db.collection("months").doc("2026_7").set({data:{units:[{id:"legacy-unit",name:"Legacy 101",partitions:[{id:1,status:"late",rent:9999,tenant:"Legacy Tenant",paid_amount:400,due_date:"2026-08-01"}]}],full:[],transactions:[],expenses:[],dailyBookings:[],handovers:[],logs:[]},_rev:1});

const browser=await puppeteer.launch({executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:true,args:["--no-sandbox"]});
const page=await browser.newPage(),errors=[];page.on("pageerror",e=>errors.push(String(e)));
const click=async text=>assert.equal(await page.evaluate(value=>{const button=[...document.querySelectorAll("button")].find(x=>x.innerText.includes(value));button?.click();return !!button;},text),true,`BUTTON_NOT_FOUND:${text}`);
try{
  await page.goto("http://127.0.0.1:5002/?qamaEmulator=1",{waitUntil:"domcontentloaded",timeout:30000});
  await page.waitForFunction(()=>document.body.innerText.includes("موظف قانوني"),{timeout:30000});
  await click("موظف قانوني");for(const digit of "4826")await click(digit);
  await page.waitForFunction(()=>window.QAMA_CONTROL_STATE==="CANONICAL_ACTIVE",{timeout:60000});
  await page.waitForFunction(()=>document.body.innerText.includes("QAMA القانوني — التشغيل الدائم"),{timeout:30000});
  let body=await page.evaluate(()=>document.body.innerText);
  for(const forbidden of ["Legacy 101","Legacy Tenant","تحتاج متابعة","53%"] )assert.equal(body.includes(forbidden),false,forbidden);
  await click("الوحدات");await page.waitForFunction(()=>document.body.innerText.includes("لا توجد مساحات قانونية تشغيلية بعد"),{timeout:30000});
  body=await page.evaluate(()=>document.body.innerText);
  for(const forbidden of ["Legacy 101","Legacy Tenant","late","9,999","تأكيد استلام المبلغ"])assert.equal(body.includes(forbidden),false,forbidden);

  await db.collection("properties").doc("property:active").set({id:"property:active",name:"عقار قانوني دائم",status:"active"});
  await db.collection("units").doc("unit:active").set({id:"unit:active",propertyId:"property:active",name:"وحدة قانونية دائمة",status:"active"});
  await db.collection("rentableSpaces").doc("space:active").set({id:"space:active",propertyId:"property:active",unitId:"unit:active",name:"مساحة قانونية دائمة",status:"active"});
  await db.collection("tenants").doc("tenant:active").set({id:"tenant:active",displayName:"مستأجر قانوني دائم",status:"active"});
  await db.collection("tenancies").doc("tenancy:active").set({id:"tenancy:active",propertyId:"property:active",unitId:"unit:active",spaceId:"space:active",tenantId:"tenant:active",status:"active"});
  await db.collection("rentalCycles").doc("cycle:active").set({id:"cycle:active",propertyId:"property:active",unitId:"unit:active",spaceId:"space:active",tenantId:"tenant:active",tenancyId:"tenancy:active",reportingMonth:"2026_08",status:"open",startDate:"2026-08-01",dueDate:"2026-08-05",contractualAmountFils:120000,baseAmountFils:120000,origin:"normal"});
  await click("تحديث");await page.waitForFunction(()=>document.body.innerText.includes("مستأجر قانوني دائم"),{timeout:30000});
  await page.evaluate(()=>[...document.querySelectorAll("div")].find(x=>x.style.cursor==="pointer"&&x.innerText.includes("مستأجر قانوني دائم"))?.click());
  await page.waitForFunction(()=>document.body.innerText.includes("تأكيد استلام المبلغ"),{timeout:30000});
  body=await page.evaluate(()=>document.body.innerText);
  assert.equal(body.includes("مستأجر قانوني دائم"),true);assert.equal(body.includes("cycle:active"),false);assert.equal(body.includes("Legacy Tenant"),false);assert.equal(body.includes("9,999"),false);
  assert.equal((await db.collection("collectionEvents").get()).size,0);

  await click("الأدلة التاريخية");await page.waitForFunction(()=>document.body.innerText.includes("أدلة Legacy التاريخية — قراءة فقط"),{timeout:30000});
  body=await page.evaluate(()=>document.body.innerText);assert.equal(body.includes("تأكيد استلام المبلغ"),false);
  const evidenceButtons=await page.evaluate(()=>[...document.querySelectorAll("button")].map(x=>x.innerText));
  for(const forbidden of ["تعديل","حفظ","تحصيل","إيداع نقدي","مصروف تشغيلي"])assert.equal(evidenceButtons.some(x=>x.includes(forbidden)),false,forbidden);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({tests:10,pass:10,fail:0,journeys:["active_route","empty_canonical_state","legacy_dashboard_absent","legacy_units_absent","no_action_without_cycle","canonical_structure_only","cycle_bound_collection","plan_not_required","legacy_evidence_readonly","no_financial_event"]}));
}finally{await Promise.race([browser.close(),new Promise(resolve=>setTimeout(resolve,5000))]);}
process.exit(0);
