import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import {initializeApp} from "firebase-admin/app";
import {getFirestore} from "firebase-admin/firestore";
import {createPinRecord} from "../functions/pin_crypto.mjs";
import {chromePath} from "./chrome_path.mjs";

process.env.FIRESTORE_EMULATOR_HOST||="127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST||="127.0.0.1:9099";
const projectId=process.env.GCLOUD_PROJECT||"qama-alrawasi";
const admin=initializeApp({projectId},"employee-journey-admin"),db=getFirestore(admin);
await db.collection("config").doc("system").set({financialMigrationV11:{completed:true}});
await db.collection("users").doc("uid_active_employee").set({userKey:"active_employee",name:"موظف قمة",role:"employee",active:true});
await db.collection("authPins").doc("active_employee").set({uid:"uid_active_employee",name:"موظف قمة",active:true,sortOrder:1,...createPinRecord("4826",100000)});
await db.collection("months").doc("2026_7").set({data:{units:[{id:"legacy-unit",name:"شقة 101",partitions:[{id:1,status:"late",rent:9999,tenant:"مستأجر",paid_amount:400,due_date:"2026-08-01"}]}],full:[],transactions:[],expenses:[],dailyBookings:[],handovers:[],logs:[]},_rev:1});

const browser=await puppeteer.launch({executablePath:chromePath(),headless:true,args:["--no-sandbox"]});
const page=await browser.newPage(),errors=[];page.on("pageerror",e=>errors.push(String(e)));
const click=async text=>assert.equal(await page.evaluate(value=>{const button=[...document.querySelectorAll("button")].find(x=>x.innerText.includes(value));button?.click();return !!button;},text),true,`BUTTON_NOT_FOUND:${text}`);
try{
  await page.goto("http://127.0.0.1:5002/?qamaEmulator=1",{waitUntil:"domcontentloaded",timeout:30000});
  await page.waitForFunction(()=>document.body.innerText.includes("موظف قمة"),{timeout:30000});
  await click("موظف قمة");for(const digit of "4826")await click(digit);
  await page.waitForFunction(()=>document.body.innerText.includes("لوحة موظف قمة"),{timeout:60000});
  await page.waitForFunction(()=>window.QAMA_READY===true,{timeout:30000});
  let body=await page.evaluate(()=>document.body.innerText);
  assert.equal(body.includes("QAMA القانوني"),false);
  assert.equal(body.includes("إعادة البناء"),false);
  assert.equal(body.includes("لوحة موظف قمة"),true);
  await click("الوحدات");
  body=await page.evaluate(()=>document.body.innerText);
  assert.equal(body.includes("الوحدات"),true);
  assert.equal((await db.collection("collectionEvents").get()).size,0);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({tests:5,pass:5,fail:0,journeys:["employee_pin_login","familiar_home","no_reconstruction_ui","units_tab_present","no_financial_event"]}));
}finally{await Promise.race([browser.close(),new Promise(resolve=>setTimeout(resolve,5000))]);}
process.exit(0);
