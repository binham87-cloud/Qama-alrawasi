import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createPinRecord } from "../functions/pin_crypto.mjs";
import { chromePath } from "./chrome_path.mjs";

process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";
const projectId=process.env.GCLOUD_PROJECT||"qama-alrawasi";
const admin=initializeApp({projectId},"browser-journey-admin");
const db=getFirestore(admin);
const monthKey="2026_7";

await db.collection("config").doc("system").set({financialMigrationV11:{completed:true}});
await db.collection("users").doc("uid_browser_owner").set({userKey:"browser_owner",name:"مدير المتصفح",role:"owner",active:true});
await db.collection("authPins").doc("browser_owner").set({uid:"uid_browser_owner",name:"مدير المتصفح",active:true,sortOrder:1,...createPinRecord("4826",100000)});
await db.collection("months").doc(monthKey).set({data:{units:[],full:[],transactions:[],expenses:[],dailyBookings:[],handovers:[],logs:[]},_rev:1});
for(const account of ["company","revenue","deduction"])await db.collection("accountBalances").doc(account).set({account,amountFils:0,version:0,schemaVersion:2});
await db.collection("requests").doc("req_browser_reject_1").set({
  id:"req_browser_reject_1", type:"update_partition", desc:"تصحيح رقم الهاتف للاختبار",
  payload:{unitId:"u1",partId:1,fields:{phone:"0501111111"}},
  by:"browser_employee", byName:"موظف الاختبار", month:7, year:2026, status:"pending",
  createdAt:"2026-08-01T00:00:00.000Z",
});

const browser=await puppeteer.launch({executablePath:chromePath(),headless:true,args:["--no-sandbox"]});
const page=await browser.newPage();
const pageErrors=[]; page.on("pageerror",e=>pageErrors.push(String(e?.message||e)));
page.on("console",m=>{if(m.type()==="error")console.error("BROWSER_CONSOLE",m.text());});
page.on("requestfailed",r=>console.error("BROWSER_REQUEST_FAILED",r.url(),r.failure()?.errorText));
const clickText=async(text)=>{
  const ok=await page.evaluate((wanted)=>{const el=[...document.querySelectorAll("button")].find(x=>x.innerText.trim()===wanted||x.innerText.includes(wanted));if(!el)return false;el.click();return true;},text);
  assert.equal(ok,true,`BUTTON_NOT_FOUND:${text}`);
};
try{
  console.log("BROWSER_STEP:open_a");
  await page.goto("http://127.0.0.1:5002/?qamaEmulator=1",{waitUntil:"domcontentloaded",timeout:30000});
  await page.waitForFunction(()=>document.body.innerText.includes("مدير المتصفح"),{timeout:30000});
  console.log("BROWSER_STEP:login_a");
  await clickText("مدير المتصفح");
  for(const digit of "4826")await clickText(digit);
  await page.waitForFunction(()=>document.body.innerText.includes("لوحة مدير المتصفح"),{timeout:60000});
  await page.waitForFunction(()=>window.QAMA_READY===true,{timeout:30000});
  console.log("BROWSER_STEP:transactions_a");
  await clickText("الإيداعات");
  await clickText("+ إيداع");
  await page.select("select","external_revenue");
  await page.type('input[placeholder="مصدر الإيراد الآخر (إلزامي)"]',"اختبار متصفح محلي");
  await page.type('input[placeholder^="الوصف"]',"إيراد خارجي موثق");
  await page.type('input[placeholder="المبلغ"]',"5000");
  await clickText("حفظ");
  console.log("BROWSER_STEP:wait_external_a");
  await page.waitForFunction(()=>document.body.innerText.includes("إيراد من مصدر آخر")&&document.body.innerText.includes("5,000"),{timeout:20000});
  console.log("BROWSER_STEP:verify_backend");
  const eventSnap=await db.collection("externalRevenues").get();
  assert.equal(eventSnap.size,1);
  assert.equal(eventSnap.docs[0].data().amountFils,500000);
  assert.equal((await db.collection("accountBalances").doc("revenue").get()).data().amountFils,500000);
  assert.equal((await db.collection("paymentAllocations").get()).size,0,"tenant collection must remain unchanged");

  // A separate browser context proves that the rendered result comes from the
  // canonical server projection rather than from browser A's local state.
  const contextB=await browser.createBrowserContext(); const pageB=await contextB.newPage();
  console.log("BROWSER_STEP:open_b");
  await pageB.goto("http://127.0.0.1:5002/?qamaEmulator=1",{waitUntil:"domcontentloaded",timeout:30000});
  await pageB.waitForFunction(()=>document.body.innerText.includes("مدير المتصفح"),{timeout:30000});
  const clickB=async text=>pageB.evaluate(w=>{const e=[...document.querySelectorAll("button")].find(x=>x.innerText.includes(w));e?.click();return !!e;},text);
  assert.equal(await clickB("مدير المتصفح"),true); for(const d of "4826")assert.equal(await clickB(d),true);
  await pageB.waitForFunction(()=>document.body.innerText.includes("لوحة مدير المتصفح"),{timeout:60000});
  await pageB.waitForFunction(()=>window.QAMA_READY===true,{timeout:30000});
  console.log("BROWSER_STEP:transactions_b");
  assert.equal(await clickB("الإيداعات"),true);
  await pageB.waitForFunction(()=>document.body.innerText.includes("إيراد من مصدر آخر")&&document.body.innerText.includes("5,000"),{timeout:20000});
  await contextB.close();

  console.log("BROWSER_STEP:requests_reject");
  const ledgerBeforeReject=(await db.collection("financialLedger").get()).size;
  await clickText("الطلبات");
  await page.waitForFunction(()=>document.body.innerText.includes("تصحيح رقم الهاتف للاختبار"),{timeout:20000});
  const rejectClicked=await page.evaluate(()=>{
    const btn=[...document.querySelectorAll("button")].find(x=>x.innerText.includes("✗ رفض"));
    if(!btn)return false;
    btn.click();
    btn.click();
    return true;
  });
  assert.equal(rejectClicked,true,"REJECT_BUTTON_NOT_FOUND");
  await page.waitForFunction(()=>document.body.innerText.includes("مرفوض")||document.body.innerText.includes("تم رفض الطلب"),{timeout:20000});
  const rejected=await db.collection("requests").doc("req_browser_reject_1").get();
  assert.equal(rejected.data().status,"rejected");
  assert.equal((await db.collection("accountBalances").doc("revenue").get()).data().amountFils,500000);
  assert.equal((await db.collection("accountBalances").doc("company").get()).data().amountFils,0);
  assert.equal((await db.collection("financialLedger").get()).size,ledgerBeforeReject);
  assert.deepEqual(pageErrors,[]);
  console.log(JSON.stringify({tests:11,pass:11,fail:0,journeys:["pin_login","external_revenue_button","backend_command","operational_refresh","same_screen_result","tenant_metrics_unchanged","second_session_read","no_page_errors","reject_button","reject_zero_financial_effect","reject_double_click"]}));
}finally{await Promise.race([browser.close(),new Promise(resolve=>setTimeout(resolve,5000))]);}
process.exit(0);
