/**
 * Assemble the OLD QAMA screens (index-auth.html) onto the NEW engine.
 * Persistent workspace paths only — never depend on /tmp for source of truth.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
// Shell lives inside qama-new only — never the workspace-root index-auth.html
// (legacy hosting uses public/index.html and must stay untouched).
const srcPath = resolve(root, "src/frontend/old-qama-shell.html");
const bridgePath = resolve(root, "src/frontend/qama-engine-bridge.js");
const draftPartialPath = resolve(root, "src/frontend/draft_partial_merge.mjs");
const destPath = resolve(root, "src/frontend/index.html");

const src = readFileSync(srcPath, "utf8");
let bridge = readFileSync(bridgePath, "utf8");
const draftPartial = readFileSync(draftPartialPath, "utf8")
  .replace(/^export\s+/gm, "")
  .replace(/\/\*\*[\s\S]*?\*\//, "/* draft_partial_merge.mjs (assembled) */");
// Prefer assembled module over any inline copy in the bridge (through mergeDraftStatus).
bridge = bridge.replace(
  /\/\*\*\s*\n\s*\* Draft partial\/paid from extras[\s\S]*?\nfunction mergeDraftStatus\([\s\S]*?\n\}\n/,
  draftPartial + "\n"
);
if (!bridge.includes("function isStaleCollectDraft")) {
  bridge = draftPartial + "\n" + bridge;
}
if (!bridge.includes("function mergeDraftPartial")) {
  bridge = draftPartial + "\n" + bridge;
}

const importAt = src.indexOf("import { initializeApp }");
const dataAt = src.indexOf("// ========== DATA ==========");
if (importAt < 0 || dataAt < 0) throw new Error("markers not found in index-auth.html");

let out = src.slice(0, importAt) + bridge + "\n" + src.slice(dataAt);

out = out.replaceAll(
  'import("https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js")',
  "Promise.resolve({doc,getDoc,setDoc,serverTimestamp,getDocs,collection,query,orderBy,getDocFromServer,runTransaction})"
);

const helpers = `
async function getDocs(q){
  const reqs=(S._dash&&S._dash.ui&&S._dash.ui.requests)||[];
  return {docs:reqs.map(d=>({id:d.id,data:()=>d}))};
}
function collection(){return {_col:"requests"};}
function query(col){return col;}
function orderBy(){return {};}
async function getDocFromServer(ref){return getDoc(ref);}
async function runTransaction(_db, fn){
  const tx={
    async get(ref){return getDoc(ref);},
    update(ref, patch){return setDoc(ref, patch);}
  };
  return fn(tx);
}
`;

const loadMonthOnline = `async function loadMonthOnline(y,m){
  const k=getMonthKey(y,m);
  S.syncMsg="جاري المزامنة...";
  S.loading=true;
  R();
  try{
    const dash=await refreshEngine(y,m);
    const data=mapDashboardToMonth(dash);
    localStorage.setItem("qama_month_"+k,JSON.stringify(data));
    S.syncMsg="متصل";
    // Canonical request list lives in loadRequests (dedupe by requestId/depositId).
    // Never re-merge pendingApprovals here — that duplicated Manager cards.
    if (typeof loadRequests === "function") await loadRequests();
  }catch(e){
    console.error(e);
    S.syncMsg="تعذر الاتصال - حفظ محلي";
  }
  S.loading=false;
  R();
}

function saveMonthData(y,m,data,quiet=false){
  data=normalizeData(data);
  const k=getMonthKey(y,m);
  try{localStorage.setItem("qama_month_"+k,JSON.stringify(data));}catch(e){}
  // Return a Promise so callers can await ONE explicit submit → ONE server result.
  // Never toast success before this settles.
  return new Promise((resolve,reject)=>{
  // Always keep the latest intent; older in-flight saves must not win over newer edits.
  // Superseded jobs reject softly so awaiters do not hang forever.
  const prev=saveMonthData._pending;
  if(prev&&typeof prev.reject==="function"&&prev.resolve!==resolve){
    try{prev.reject(Object.assign(new Error("SAVE_SUPERSEDED"),{code:"SAVE_SUPERSEDED"}));}catch(_e){}
  }
  saveMonthData._pending={y,m,data,quiet:!!quiet,resolve,reject};
  clearTimeout(saveMonthData._t);
  saveMonthData._t=null;
  const publishSaveState=()=>{
    try{
      if(typeof window==="undefined")return;
      window.__qamaSaveState={
        saveOpSeq:S._saveOpSeq||0,
        saveOpId:S._saveOpId||0,
        saveOpDoneId:S._saveOpDoneId||0,
        saveOpStatus:S._saveOpStatus||null,
        syncMsg:S.syncMsg||"",
        msg:S.msg||"",
        t0:S._saveT0||null,
        tCmd:S._saveTCmd||null,
        tDone:S._saveTDone||null,
      };
    }catch(_e){}
  };
  const kick=()=>{
    if(S._saveInFlight){ S._saveQueued=true; return; }
    const job=saveMonthData._pending;
    if(!job) return;
    saveMonthData._pending=null;
    const opId=(S._saveOpSeq=(S._saveOpSeq||0)+1);
    S._saveOpId=opId;
    S._saveOpStatus="pending";
    S._saveInFlight=true;
    S._saveT0=Date.now();
    S._saveTCmd=null;
    S._saveTDone=null;
    const sy=job.y, sm=job.m, snap=job.data;
    const sk=getMonthKey(sy,sm);
    S.syncMsg="جاري الحفظ...";
    publishSaveState();
    if(!job.quiet)R();
    Promise.resolve(setDoc(doc(db,"months",sk),{data:snap,updatedAt:serverTimestamp()},{merge:true}))
    .then(async ()=>{
      S._saveTCmd=Date.now();
      if(opId!==S._saveOpId){
        try{job.reject(Object.assign(new Error("SAVE_SUPERSEDED"),{code:"SAVE_SUPERSEDED"}));}catch(_e){}
        return;
      }
      S._preserveDraftUntil=0;
      // setDoc(months) already hydrated once inside the bridge — do NOT hydrate again.
      S._saveOpStatus="ok";
      S._saveOpDoneId=opId;
      S._saveTDone=Date.now();
      S.syncMsg="تم الحفظ";
      publishSaveState();
      if(!job.quiet)R();
      try{job.resolve({ok:true,opId,ms:(S._saveTDone-S._saveT0)});}catch(_e){}
    })
    .catch(async e=>{
      if(opId!==S._saveOpId){
        try{job.reject(Object.assign(new Error("SAVE_SUPERSEDED"),{code:"SAVE_SUPERSEDED"}));}catch(_e){}
        return;
      }
      console.error(e);
      const code=String((e&&(e.message||e.code))||e);
      if(code==="SAVE_SUPERSEDED"){ try{job.reject(e);}catch(_e){} return; }
      const keepDraft=/TENANT_REQUIRED|RENT_REQUIRED|START_DATE_REQUIRED|PARTIAL_AMOUNT_REQUIRED|AMOUNT_EXCEEDS_REMAINING|IDEMPOTENCY_PAYLOAD_MISMATCH|AMOUNT_EXCEEDS_HOLDING|INVALID_AMOUNT|COLLECTION_NOT_READY|COLLECTION_REFRESH_FAILED|OBLIGATION_GENERATE_FAILED|ARREARS_CONFIRMATION_REQUIRED|FORBIDDEN/i.test(code);
      const moneyFail=/PARTIAL_AMOUNT_REQUIRED|AMOUNT_EXCEEDS_REMAINING|COLLECTION_|AMOUNT_EXCEEDS_HOLDING/i.test(code);
      if(!keepDraft){
        try { await hydrateMonthFromEngine(sy, sm); } catch (e2) {}
      } else {
        try {
          let snapKeep=snap;
          if(moneyFail && typeof stripFailedCollectPaintInData==="function"){
            try{ snapKeep=JSON.parse(JSON.stringify(snap)); stripFailedCollectPaintInData(snapKeep); }catch(_sf){ snapKeep=snap; }
          }
          localStorage.setItem("qama_month_"+sk, JSON.stringify(snapKeep));
          S._preserveDraftUntil = Date.now() + 120000;
          try { await refreshEngine(sy, sm, true); } catch (_re) {}
        } catch (_e3) {}
      }
      S._saveOpStatus="fail";
      S._saveOpDoneId=opId;
      S._saveTDone=Date.now();
      const ar=(typeof formatEngineError==="function"?formatEngineError(e):code);
      S.syncMsg=ar;
      publishSaveState();
      if(!job.quiet){try{showMsg("⚠ "+ar);}catch(_e){}}
      if(!job.quiet)R();
      try{job.reject(e);}catch(_e){}
    })
    .finally(()=>{
      if(opId!==S._saveOpId) return;
      S._saveInFlight=false;
      publishSaveState();
      if(S._saveQueued || saveMonthData._pending){
        S._saveQueued=false;
        kick();
      }
    });
  };
  // Quiet debounce is ONLY for local draft coalescing of non-money keystrokes.
  // Explicit submits (quiet=false) kick immediately — one intentional save.
  if(quiet){
    saveMonthData._t=setTimeout(kick, 700);
  } else kick();
  });
}
`;

function replaceFn(srcText, startMarker, nextMarker, replacement) {
  const a = srcText.indexOf(startMarker);
  if (a < 0) throw new Error("missing " + startMarker);
  const b = srcText.indexOf(nextMarker, a + 1);
  if (b < 0) throw new Error("missing next " + nextMarker);
  return srcText.slice(0, a) + replacement + "\n" + srcText.slice(b);
}

out = replaceFn(out, "async function loadMonthOnline(y,m){", "function changeMonth(m,y){", loadMonthOnline);
out = replaceFn(
  out,
  "function savePermissions(){",
  "function saveLocks(){",
  `function savePermissions(){
  try{localStorage.setItem("qama_permissions",JSON.stringify(S.permissions));}catch(e){}
  setDoc(doc(db,"config","permissions"),{data:S.permissions,updatedAt:serverTimestamp()},{merge:true}).catch(()=>{});
}`
);
out = replaceFn(
  out,
  "async function loadBalances(){",
  "function loadPermissions(){",
  `async function loadBalances(){
  try{
    if(!S._dash) await refreshEngine(S.year,S.month);
    applyUiConfig(S._dash&&S._dash.ui);
    R();
  }catch(e){}
}`
);

// engine_approval handlers live in index-auth.html — do not inject a second copy.
if (!out.includes('req.type==="engine_approval"') && !out.includes("req.type===\"engine_approval\"")) {
  out = out.replace(
    "async function approveRequest(req){",
    `async function approveRequest(req){
  if(req&&req.type==="engine_approval"){
    if(S.approvingReqId){showMsg("⏳ جاري اعتماد طلب آخر...");return;}
    S.approvingReqId=req.id; R();
    try{
      await engineCommand(req._approveCommand,req._approvePayload,"engap-"+req.id);
      showMsg("✓ تم اعتماد الطلب");
      await loadMonthOnline(S.year,S.month);
    }catch(e){showMsg("⚠ خطأ في الاعتماد");console.error(e);}
    finally{S.approvingReqId=null;R();}
    return;
  }
`
  );
  out = out.replace(
    "async function rejectRequest(req){",
    `async function rejectRequest(req){
  if(req&&req.type==="engine_approval"){
    try{
      const payload=Object.assign({},req._rejectPayload||{},{reason:"رفض من الشاشة"});
      await engineCommand(req._rejectCommand,payload,"engrej-"+req.id);
      showMsg("✓ تم رفض الطلب");
      await loadMonthOnline(S.year,S.month);
    }catch(e){showMsg("⚠ خطأ");}
    return;
  }
`
  );
}

const dataMark = out.indexOf("// ========== DATA ==========");
out = out.slice(0, dataMark) + helpers + "\n" + out.slice(dataMark);

writeFileSync(destPath, out);
console.log("wrote", destPath, "bytes", out.length);
if (!out.includes("qama-new-prod-2026")) throw new Error("missing new firebase config");
if (out.includes("qama-alrawasi.firebaseapp.com")) throw new Error("legacy config leaked");
if (!out.includes("function renderHome()")) throw new Error("missing renderHome");
if (!out.includes("الشقق الكاملة")) throw new Error("missing full apartments section");
if (!out.includes("👤  مدير") && !out.includes("مدير")) throw new Error("missing login users");
if (!out.includes('"pending"') && !out.includes("'pending'")) throw new Error("pending status option missing");
if (!out.includes("uncollectObligation")) throw new Error("missing uncollect in bridge");
if (!out.includes("renewRentalCycle")) throw new Error("missing renewRentalCycle in assembled UI");
if (!out.includes("endTenancy")) throw new Error("missing endTenancy in assembled UI");
if (!out.includes("btn-renew-cycle")) throw new Error("missing renew button");
if (!out.includes("hydrateMonthFromEngine")) throw new Error("missing hydrate");
if (out.includes("S.pendingRequests=[...reqs, ...enginePending]")) {
  throw new Error("regressive pendingApprovals merge still present in assembled UI");
}
console.log("markers ok");
