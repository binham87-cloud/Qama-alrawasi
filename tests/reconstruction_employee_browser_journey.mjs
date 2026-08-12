import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import {initializeApp} from "firebase-admin/app";
import {getFirestore} from "firebase-admin/firestore";
import {createPinRecord} from "../functions/pin_crypto.mjs";

process.env.FIRESTORE_EMULATOR_HOST||="127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST||="127.0.0.1:9099";
const projectId=process.env.GCLOUD_PROJECT||"qama-alrawasi";
const admin=initializeApp({projectId},"reconstruction-routing-admin");
const db=getFirestore(admin),monthKey="2026_7",planId="reconstruction:test-routing";

await db.collection("config").doc("system").set({financialMigrationV11:{completed:true}});
await db.collection("config").doc("canonicalControl").set({state:"RECONSTRUCTION_ALLOWED",version:1,structuralPreparation:{enabled:true,monthKey,planId,expiresAt:"2099-01-01T00:00:00.000Z"}});
await db.collection("users").doc("uid_reconstruction_employee").set({userKey:"reconstruction_employee",name:"موظف إعادة البناء",role:"employee",active:true});
await db.collection("authPins").doc("reconstruction_employee").set({uid:"uid_reconstruction_employee",name:"موظف إعادة البناء",active:true,sortOrder:1,...createPinRecord("4826",100000)});
await db.collection("months").doc(monthKey).set({data:{units:[{id:"legacy-unit",name:"Legacy 101",partitions:[{id:1,status:"late",rent:9999,tenant:"Legacy Tenant",paid_amount:0,due_date:"2026-08-01"}]}],full:[],transactions:[],expenses:[],dailyBookings:[],handovers:[],logs:[]},_rev:1});
await db.collection("reconstructionPlans").doc(planId).set({id:planId,monthKey,status:"DRAFT",reviewedObligations:[],createdAt:"2026-08-11T00:00:00.000Z"});
await db.collection("monthAuthorities").doc(monthKey).set({monthKey,status:"STAGED",activated:false,reconstructionPlanId:planId});

const browser=await puppeteer.launch({executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:true,args:["--no-sandbox"]});
const page=await browser.newPage(),errors=[];page.on("pageerror",e=>errors.push(String(e)));
const click=async text=>assert.equal(await page.evaluate(w=>{const e=[...document.querySelectorAll("button")].find(x=>x.innerText.includes(w));e?.click();return !!e;},text),true,`BUTTON_NOT_FOUND:${text}`);
try{
  await page.goto("http://127.0.0.1:5002/?qamaEmulator=1",{waitUntil:"domcontentloaded",timeout:30000});
  await page.waitForFunction(()=>document.body.innerText.includes("موظف إعادة البناء"),{timeout:30000});
  await click("موظف إعادة البناء");for(const d of "4826")await click(d);
  await page.waitForFunction(()=>window.QAMA_CONTROL_STATE==="RECONSTRUCTION_ALLOWED",{timeout:60000});
  await page.waitForFunction(()=>document.body.innerText.includes("مساحة عمل أغسطس القانونية"),{timeout:30000});
  let body=await page.evaluate(()=>document.body.innerText);
  assert.equal(body.includes("53%"),false);assert.equal(body.includes("تحتاج متابعة"),false);assert.equal(body.includes("Legacy Tenant"),false);
  await click("الوحدات");await page.waitForFunction(()=>document.body.innerText.includes("لا توجد مساحات قانونية بعد"),{timeout:30000});
  body=await page.evaluate(()=>document.body.innerText);
  for(const forbidden of ["Legacy 101","Legacy Tenant","نسبة التحصيل","تأكيد استلام المبلغ"])assert.equal(body.includes(forbidden),false,forbidden);

  await db.collection("properties").doc("property:test").set({id:"property:test",name:"عقار قانوني",status:"active"});
  await db.collection("units").doc("unit:test").set({id:"unit:test",propertyId:"property:test",name:"وحدة قانونية",status:"active"});
  await db.collection("rentableSpaces").doc("space:test").set({id:"space:test",propertyId:"property:test",unitId:"unit:test",name:"مساحة قانونية",status:"active"});
  await db.collection("tenants").doc("tenant:test").set({id:"tenant:test",displayName:"مستأجر قانوني",status:"active"});
  await db.collection("tenancies").doc("tenancy:test").set({id:"tenancy:test",propertyId:"property:test",unitId:"unit:test",spaceId:"space:test",tenantId:"tenant:test",status:"active"});
  await db.collection("rentalCycles").doc("cycle:test").set({id:"cycle:test",propertyId:"property:test",unitId:"unit:test",spaceId:"space:test",tenantId:"tenant:test",tenancyId:"tenancy:test",reportingMonth:monthKey,status:"open",startDate:"2026-08-01",dueDate:"2026-08-05",contractualAmountFils:120000,baseAmountFils:120000,origin:"reconstruction",reconstructionPlanId:planId});
  await click("تحديث");await page.waitForFunction(()=>document.body.innerText.includes("مستأجر قانوني"),{timeout:30000});
  await page.evaluate(()=>[...document.querySelectorAll("div")].find(x=>x.style.cursor==="pointer"&&x.innerText.includes("مستأجر قانوني"))?.click());
  await page.waitForFunction(()=>document.body.innerText.includes("تأكيد استلام المبلغ"),{timeout:30000});
  body=await page.evaluate(()=>document.body.innerText);
  assert.equal(body.includes("مستأجر قانوني"),true);assert.equal(body.includes("cycle:test"),false);assert.equal(body.includes("Legacy Tenant"),false);assert.equal(body.includes("Legacy 101"),false);
  assert.equal((await db.collection("collectionEvents").get()).size,0);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({tests:8,pass:8,fail:0,journeys:["employee_reconstruction_route","legacy_kpis_absent","legacy_cards_absent","empty_canonical_state","no_button_without_cycle","single_canonical_cycle","cycle_bound_collection_action","no_financial_event"]}));
}finally{await Promise.race([browser.close(),new Promise(resolve=>setTimeout(resolve,5000))]);}
process.exit(0);
