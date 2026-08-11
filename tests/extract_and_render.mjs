// يستخرج السكربت من index.html ثم يرسم كل التبويبات في بيئة وهمية
// الاستخدام: node tests/extract_and_render.mjs
import fs from 'fs'; import vm from 'vm';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
let code=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');
code=code.replace(/^import\s+.*?;$/gm,'').replace(/await import\([^)]*\)/g,'({})');
const mkEl=()=>({style:{},children:[],appendChild(c){this.children.push(c);},addEventListener(){},
  setAttribute(){},removeChild(){},insertBefore(){},classList:{add(){},remove(){}},focus(){},value:'',textContent:''});
const ctx={console,setTimeout:()=>0,clearTimeout(){},Date,Math,JSON,Number,String,Object,Array,Boolean,isNaN,isFinite,Promise,
  document:{getElementById:(id)=>id==='root'?mkEl():null,addEventListener(){},createElement:()=>mkEl(),
            createTextNode:(t)=>({textContent:t}),body:mkEl()},
  window:{addEventListener(){},location:{}},location:{hostname:"test.invalid",search:""},URLSearchParams,navigator:{},
  initializeApp:()=>({}),getAuth:()=>({}),getFunctions:()=>({}),httpsCallable:()=>async()=>({data:{users:[]}}),
  signInWithCustomToken:async()=>({user:{uid:'u1'}}),signOut:async()=>{},onAuthStateChanged:()=>{},getFirestore:()=>({}),doc:()=>({}),getDoc:async()=>({exists:()=>false}),
  setDoc:async()=>({}),serverTimestamp:()=>({}),runTransaction:async()=>({}),writeBatch:()=>({}),
  collection:()=>({}),getDocs:async()=>({docs:[]}),query:()=>({}),where:()=>({})};
ctx.globalThis=ctx; vm.createContext(ctx);
try{ vm.runInContext(code,ctx,{filename:'qama-v11'}); }
catch(e){ console.log('❌ فشل تحميل السكربت:',e.message); process.exit(1); }
let pass=0,fail=0;
for(const [role,tab] of [['owner','overview'],['owner','financial'],['owner','units'],['owner','maintenance'],
  ['owner','expenses'],['owner','daily'],['owner','requests'],['owner','logs'],
  ['emp','emphome'],['emp','units'],['emp','expenses'],['emp','maintenance'],['emp','deposits']]){
  try{
    vm.runInContext(`S.user="u1";S.uid="u1";S.role="${role==='owner'?'owner':'employee'}";USERS.u1={name:"tester",role:S.role};S.screen="app";S.tab="${tab}";renderApp();`,ctx);
    console.log(`✅ ${role}/${tab}`); pass++;
  }catch(e){ console.log(`❌ ${role}/${tab} — ${e.message}`); fail++; }
}
console.log(`\nنجح ${pass} | فشل ${fail}`);
process.exit(fail>0?1:0);
