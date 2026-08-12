// ===== اختبارات المرحلة 2 (محاكاة) — الدفعات البنكية كمستندات مستقلة =====
let P=0,F=0; const R=[];
const t=(n,fn)=>{try{const r=fn();if(r===true){P++;R.push('✅ '+n);}else{F++;R.push('❌ '+n+' — '+r);}}catch(e){F++;R.push('❌ '+n+' — '+e.message);}};

// محاكاة Firestore
let DOCS={}, MONTH={transactions:[],_rev:1}, BAL={revenue:1000};
const reset=()=>{DOCS={};MONTH={transactions:[],_rev:1};BAL={revenue:1000};};
const bankPayId=(mk,ref,idem)=>"bp_"+mk+"_"+String(ref).replace(/[^A-Za-z0-9_-]/g,"")+"_"+idem;

function createPayment(o){
  const pid=bankPayId(o.monthKey,o.unitRef,o.idem);
  const amt=Math.round(Number(o.amount)*100)/100;
  if(!isFinite(amt)||amt<=0) return {ok:false,err:'BAD_AMOUNT'};
  if(DOCS[pid]) return {ok:false,err:'DUPLICATE'};   // معرّف المستند هو الحارس
  DOCS[pid]={paymentId:pid,unitRef:o.unitRef,monthKey:o.monthKey,amount:amt,
             bankReference:o.ref||"",status:'pending',createdBy:o.by||'yahia',idempotencyKey:o.idem};
  return {ok:true,paymentId:pid};
}
function approvePayment(pid){
  const p=DOCS[pid];
  if(!p) return {ok:false,err:'PAY_MISSING'};
  if(p.status!=='pending') return {ok:false,err:'NOT_PENDING'};
  if(MONTH.transactions.some(t=>t.bankPaymentId===pid)) return {ok:false,err:'ALREADY_POSTED'};
  MONTH.transactions.push({id:'bp_'+pid,amount:p.amount,bankPaymentId:pid});
  BAL.revenue=Math.round((BAL.revenue+p.amount)*100)/100;
  p.status='approved';
  return {ok:true};
}
function cancelPayment(pid){
  const p=DOCS[pid];
  if(!p) return {ok:false,err:'PAY_MISSING'};
  if(p.status==='cancelled') return {ok:false,err:'ALREADY_CANCELLED'};
  if(p.status==='approved'){
    const i=MONTH.transactions.findIndex(t=>t.bankPaymentId===pid);
    if(i>=0){ if(p.amount>BAL.revenue) return {ok:false,err:'INSUFFICIENT'};
      MONTH.transactions.splice(i,1); BAL.revenue=Math.round((BAL.revenue-p.amount)*100)/100; }
  }
  p.status='cancelled'; return {ok:true};
}
const paid=ref=>Object.values(DOCS).filter(p=>p.unitRef===ref&&p.status==='approved').reduce((s,p)=>s+p.amount,0);
const pend=ref=>Object.values(DOCS).filter(p=>p.unitRef===ref&&p.status==='pending').reduce((s,p)=>s+p.amount,0);
const remaining=(ref,due)=>Math.round((due-paid(ref)-pend(ref))*100)/100;

const MK='2026_7', U='u1p5';

// دفعة كاملة
reset();
const c1=createPayment({monthKey:MK,unitRef:U,amount:1300,idem:'k1'});
t('P2-01 إنشاء دفعة كاملة', ()=> c1.ok?true:JSON.stringify(c1));
t('P2-02 الدفعة تبدأ معلّقة', ()=> DOCS[c1.paymentId].status==='pending'?true:'ليست معلّقة');
t('P2-03 المعلّق لا يدخل الإيداعات ولا الرصيد', ()=>
  MONTH.transactions.length===0 && BAL.revenue===1000?true:'دخلت قبل الاعتماد');
const a1=approvePayment(c1.paymentId);
t('P2-04 الاعتماد يُضيف القيد والرصيد مرة واحدة', ()=>
  a1.ok && MONTH.transactions.length===1 && BAL.revenue===2300?true:JSON.stringify({a1,BAL}));
t('P2-05 اعتماد نفس الدفعة مرتين مرفوض', ()=>{
  const a2=approvePayment(c1.paymentId);
  return !a2.ok && a2.err==='NOT_PENDING' && BAL.revenue===2300?true:JSON.stringify({a2,BAL});
});

// منع التكرار بمعرّف المستند
reset();
createPayment({monthKey:MK,unitRef:U,amount:500,idem:'same'});
const dup=createPayment({monthKey:MK,unitRef:U,amount:500,idem:'same'});
t('P2-06 معرّف المستند يمنع إنشاء دفعتين بنفس المفتاح', ()=>
  !dup.ok && dup.err==='DUPLICATE' && Object.keys(DOCS).length===1?true:JSON.stringify({dup,n:Object.keys(DOCS).length}));
t('P2-07 الضغط المزدوج على التسجيل لا ينشئ دفعتين', ()=>{
  const before=Object.keys(DOCS).length;
  createPayment({monthKey:MK,unitRef:U,amount:500,idem:'same'});
  createPayment({monthKey:MK,unitRef:U,amount:500,idem:'same'});
  return Object.keys(DOCS).length===before?true:'أُنشئت نسخ إضافية';
});

// دفعتان جزئيتان لنفس الوحدة
reset();
const p1=createPayment({monthKey:MK,unitRef:U,amount:800,idem:'a',ref:'TRX-1'});
const p2=createPayment({monthKey:MK,unitRef:U,amount:500,idem:'b',ref:'TRX-2'});
t('P2-08 دفعتان جزئيتان لنفس الوحدة مقبولتان', ()=>
  p1.ok&&p2.ok&&Object.keys(DOCS).length===2?true:'رُفضت الثانية');
t('P2-09 المتبقي محسوب صحيحاً قبل الاعتماد', ()=> remaining(U,1300)===0?true:'المتبقي '+remaining(U,1300));
approvePayment(p1.paymentId);
t('P2-10 اعتماد دفعة واحدة لا يمس الأخرى', ()=>
  DOCS[p1.paymentId].status==='approved' && DOCS[p2.paymentId].status==='pending'
  && MONTH.transactions.length===1 && BAL.revenue===1800?true:JSON.stringify({BAL,n:MONTH.transactions.length}));
approvePayment(p2.paymentId);
t('P2-11 المجموع بعد اعتماد الاثنتين صحيح', ()=>
  paid(U)===1300 && BAL.revenue===2300 && MONTH.transactions.length===2?true:JSON.stringify({paid:paid(U),BAL}));
t('P2-12 لا احتساب مزدوج: مجموع القيود = مجموع الدفعات المعتمدة', ()=>
  MONTH.transactions.reduce((s,t)=>s+t.amount,0)===paid(U)?true:'اختلاف');

// إلغاء دفعة واحدة
t('P2-13 إلغاء دفعة واحدة يعكس أثرها فقط', ()=>{
  const r=cancelPayment(p1.paymentId);
  return r.ok && BAL.revenue===1500 && MONTH.transactions.length===1
      && DOCS[p2.paymentId].status==='approved'?true:JSON.stringify({BAL,n:MONTH.transactions.length});
});
t('P2-14 إلغاء نفس الدفعة مرتين مرفوض', ()=>{
  const r=cancelPayment(p1.paymentId);
  return !r.ok && r.err==='ALREADY_CANCELLED' && BAL.revenue===1500?true:JSON.stringify({r,BAL});
});
t('P2-15 إلغاء دفعة معلّقة لا يمس الرصيد', ()=>{
  reset();
  const c=createPayment({monthKey:MK,unitRef:U,amount:300,idem:'z'});
  const r=cancelPayment(c.paymentId);
  return r.ok && BAL.revenue===1000 && MONTH.transactions.length===0?true:JSON.stringify({BAL});
});

// المرجع البنكي وثلاث دفعات
reset();
['x','y','z'].forEach((k,i)=>createPayment({monthKey:MK,unitRef:U,amount:400,idem:k,ref:'REF'+i}));
t('P2-16 ثلاث دفعات جزئية مدعومة', ()=> Object.keys(DOCS).length===3?true:'العدد '+Object.keys(DOCS).length);
t('P2-17 المرجع البنكي محفوظ لكل دفعة', ()=>
  Object.values(DOCS).every((p,i)=>/^REF\d$/.test(p.bankReference))?true:'مرجع مفقود');
t('P2-18 المتبقي مع تجاوز الإيجار يظهر سالباً لا يُقص', ()=> remaining(U,1000)===-200?true:'المتبقي '+remaining(U,1000));

// وحدات مختلفة مستقلة
reset();
createPayment({monthKey:MK,unitRef:'u1p5',amount:500,idem:'k'});
createPayment({monthKey:MK,unitRef:'u2p3',amount:700,idem:'k'});
t('P2-19 نفس المفتاح لوحدتين مختلفتين مسموح', ()=> Object.keys(DOCS).length===2?true:'رُفضت الثانية');
t('P2-20 مبلغ غير صالح مرفوض', ()=>
  [0,-5,NaN,'x',null].every(v=>!createPayment({monthKey:MK,unitRef:U,amount:v,idem:'q'+v}).ok)?true:'قُبل');

console.log('\n===== المرحلة 2 (محاكاة) =====');
R.forEach(x=>console.log(x));
console.log(`\nنجح ${P} | فشل ${F}`);
process.exit(F>0?1:0);
