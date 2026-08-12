// ===== اختبارات المرحلة 1 (محاكاة) — مخزن الذاكرة وحارس المراجعة =====
let P=0,F=0; const R=[];
const t=(n,fn)=>{try{const r=fn();if(r===true){P++;R.push('✅ '+n);}else{F++;R.push('❌ '+n+' — '+r);}}catch(e){F++;R.push('❌ '+n+' — '+e.message);}};

// محاكاة المخزن + الخادم
const MEM=Object.create(null);
const memGet=k=>MEM[k]||null, memPut=(k,d,r)=>MEM[k]={data:d,rev:r},
      memRev=k=>MEM[k]?MEM[k].rev:null, memHas=k=>!!MEM[k], memClear=k=>{delete MEM[k];};
let SERVER={};
function serverPut(k,d,r){SERVER[k]={data:JSON.parse(JSON.stringify(d)),_rev:r};}
function serverGet(k){return SERVER[k]?JSON.parse(JSON.stringify(SERVER[k])):null;}

async function saveMonth(k,data){
  const base=memRev(k);
  if(base===null) return {ok:false,err:'NOT_LOADED'};
  const srv=serverGet(k); const srvRev=srv?srv._rev:0;
  if(srvRev!==base) return {ok:false,err:'STALE',serverRev:srvRev,baseRev:base};
  serverPut(k,data,srvRev+1); memPut(k,data,srvRev+1);
  return {ok:true,rev:srvRev+1};
}
async function loadMonth(k){ const s=serverGet(k); if(!s) return null; memPut(k,s.data,s._rev); return s.data; }

t('P1-01 getMonthData بلا تحميل لا يعيد بيانات قديمة', ()=>{
  memClear('2026_7'); return memGet('2026_7')===null?true:'أعاد بيانات غير مؤكدة';
});

const run=async()=>{
  SERVER={}; Object.keys(MEM).forEach(k=>delete MEM[k]);
  const K='2026_7';

  // بلا تحميل
  let r=await saveMonth(K,{v:'a'});
  t('P1-02 حفظ شهر غير محمّل مرفوض', ()=> r.ok===false&&r.err==='NOT_LOADED'?true:JSON.stringify(r));

  // تحميل ثم حفظ
  serverPut(K,{v:'server0'},1);
  await loadMonth(K);
  r=await saveMonth(K,{v:'a'});
  t('P1-03 حفظ بعد تحميل ينجح ويرفع المراجعة', ()=> r.ok&&r.rev===2?true:JSON.stringify(r));

  // جهازان: A و B حمّلا نفس المراجعة
  serverPut(K,{v:'base'},5);
  const memA={rev:5}, memB={rev:5};
  const saveAs=async(mem,val)=>{
    const srv=serverGet(K);
    if(srv._rev!==mem.rev) return {ok:false,err:'STALE',serverRev:srv._rev,baseRev:mem.rev};
    serverPut(K,{v:val},srv._rev+1); mem.rev=srv._rev+1; return {ok:true,rev:mem.rev};
  };
  const ra=await saveAs(memA,'fromA');
  const rb=await saveAs(memB,'fromB');
  t('P1-04 جهاز A ينجح', ()=> ra.ok&&ra.rev===6?true:JSON.stringify(ra));
  t('P1-05 جهاز B يُرفض بدل الكتابة فوق A', ()=> rb.ok===false&&rb.err==='STALE'?true:JSON.stringify(rb));
  t('P1-06 بيانات A محفوظة ولم تُمحَ', ()=> serverGet(K).data.v==='fromA'?true:'تعديل A ضاع');

  // B يعيد التحميل ثم يحفظ
  await loadMonth(K); memB.rev=memRev(K);
  const rb2=await saveAs(memB,'fromB2');
  t('P1-07 B ينجح بعد إعادة التحميل', ()=> rb2.ok&&rb2.rev===7?true:JSON.stringify(rb2));

  // فشل الحفظ لا يترك تغييراً وهمياً
  serverPut(K,{v:'srv'},9); memPut(K,{v:'old'},8);
  const rf=await saveMonth(K,{v:'ghost'});
  memClear(K); await loadMonth(K);
  t('P1-08 بعد الفشل تُعاد النسخة المؤكدة لا الوهمية', ()=>
    rf.ok===false && memGet(K).data.v==='srv' ? true : JSON.stringify({rf,mem:memGet(K)}));

  // نشر الوحدات: يمس الشهور الموجودة على الخادم فقط
  SERVER={}; serverPut('2026_8',{units:[]},1); // 2026_9 غير موجود
  const mutate=(k,fn)=>{const s=serverGet(k); if(!s) return false; if(fn(s.data)===false) return false; serverPut(k,s.data,s._rev+1); return true;};
  const t8=mutate('2026_8',d=>{d.units.push({id:'newU'});});
  const t9=mutate('2026_9',d=>{d.units.push({id:'newU'});});
  t('P1-09 النشر يعدّل الشهر الموجود', ()=> t8===true && serverGet('2026_8').data.units.length===1?true:'فشل');
  t('P1-10 النشر لا ينشئ شهراً غير موجود', ()=> t9===false && !serverGet('2026_9')?true:'أنشأ شهراً');
  t('P1-11 النشر لا يكرّر الوحدة', ()=>{
    const again=mutate('2026_8',d=>{ if(d.units.find(u=>u.id==='newU')) return false; d.units.push({id:'newU'}); });
    return again===false && serverGet('2026_8').data.units.length===1?true:'تكرار';
  });

  console.log('\n===== المرحلة 1 (محاكاة) =====');
  R.forEach(x=>console.log(x));
  console.log(`\nنجح ${P} | فشل ${F}`);
  process.exit(F>0?1:0);
};
run();
