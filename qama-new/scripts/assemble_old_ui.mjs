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
// Prefer assembled module over any inline copy in the bridge.
bridge = bridge.replace(
  /\/\*\*\s*\n\s*\* Draft partial\/paid from extras[\s\S]*?\nfunction mergeDraftPartial\([\s\S]*?\n\}\n/,
  draftPartial + "\n"
);
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
  const go=()=>setDoc(doc(db,"months",k),{data,updatedAt:serverTimestamp()},{merge:true})
    .then(async ()=>{
      // Successful engine apply — clear any prior failed-draft hold and re-hydrate.
      S._preserveDraftUntil=0;
      try { await hydrateMonthFromEngine(y, m); } catch (e) { console.error(e); }
      S.syncMsg="تم الحفظ أونلاين";
      if(!quiet)R();
    })
    .catch(async e=>{
      console.error(e);
      const code=String((e&&(e.message||e.code))||e);
      const keepDraft=/TENANT_REQUIRED|RENT_REQUIRED|IDEMPOTENCY_PAYLOAD_MISMATCH/i.test(code)
        || (S._preserveDraftUntil && Date.now() < S._preserveDraftUntil);
      if(!keepDraft){
        try { await hydrateMonthFromEngine(y, m); } catch (e2) {}
      }
      S.syncMsg="تعذر الحفظ أونلاين";
      if(!quiet){try{showMsg("⚠ لم يُحفظ: "+code);}catch(_e){}}
      if(!quiet)R();
    });
  // Non-quiet save must cancel a pending quiet debounce — otherwise an older
  // vacant mid-edit save can race and clear tenant after the rented save started.
  clearTimeout(saveMonthData._t);
  saveMonthData._t=null;
  if(quiet){
    saveMonthData._t=setTimeout(go, 700);
  } else go();
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
if (!out.includes("hydrateMonthFromEngine")) throw new Error("missing hydrate");
if (out.includes("S.pendingRequests=[...reqs, ...enginePending]")) {
  throw new Error("regressive pendingApprovals merge still present in assembled UI");
}
console.log("markers ok");
