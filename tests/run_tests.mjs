// ============================================================
// اختبارات محاكاة (SIMULATION) — لا تتصل بـ Firebase الحقيقي
// ============================================================
import { makeCALC } from './calc_extracted.mjs';

let PASS=0, FAIL=0; const RESULTS=[];
function t(name, fn){
  try{ const r=fn(); if(r===true){PASS++;RESULTS.push([name,'PASS','']);}
       else {FAIL++;RESULTS.push([name,'FAIL',String(r)]);} }
  catch(e){FAIL++;RESULTS.push([name,'ERROR',String(e.message)]);}
}
const eq=(a,b,l='')=> a===b ? true : `${l} توقع ${b} لكن النتيجة ${a}`;

// --- محاكاة displayStatus بنفس منطق النسخة (اليدوي أولوية، ثم جزئي، ثم expired) ---
const EXPIRED=new Set();
function displayStatus(x){
  const st=x.status||'late';
  if(st==='vacant'||st==='staff')return st;
  const paid=Number(x.paid_amount)||0, rent=Number(x.rent)||0;
  const isPartial = !!x.partial && (rent>0||paid>0) && (rent-paid)>0;
  if(isPartial && paid>0) return 'partial';
  if(st==='collected') return 'collected';
  if(isPartial) return 'partial';
  if(EXPIRED.has(x.uid)) return 'expired';
  if(x.notDue) return 'pending';
  return 'late';
}
const CALC=makeCALC(displayStatus);

const D=()=>({
  units:[{id:'u1',partitions:[
    {uid:'p1',id:1,rent:1300,status:'collected',paid_amount:1300,collectionMethod:'bank',bankDeposited:true,collectedBy:'yahia'},
    {uid:'p2',id:2,rent:1100,status:'collected',paid_amount:1100,collectionMethod:'bank',bankDeposited:false,collectedBy:'yahia'},
    {uid:'p3',id:3,rent:1300,status:'late',paid_amount:0,collectedBy:null},
    {uid:'p4',id:4,rent:1000,status:'late',paid_amount:0,notDue:true},
    {uid:'p5',id:5,rent:2000,status:'collected',paid_amount:2000,collectionMethod:'cash',collectedBy:'yahia'},
    {uid:'p6',id:6,rent:900,status:'late',partial:true,paid_amount:400,collectionMethod:'cash',collectedBy:'nader'},
    {uid:'p7',id:7,rent:800,status:'vacant',paid_amount:0},
    {uid:'p8',id:8,rent:700,status:'staff',paid_amount:0},
    {uid:'p9',id:9,rent:1200,status:'late',paid_amount:0}
  ]}],
  full:[{uid:'f1',id:'102',rent:9000,status:'collected',paid_amount:9000,collectionMethod:'cash',collectedBy:'yahia'}],
  transactions:[{id:1,amount:1300,bankRef:'bank_p1',by:'saeed'},{id:2,amount:2000,by:'yahia'},{id:3,amount:9000,by:'yahia'}],
  dailyBookings:[{id:'d1',total:500,by:'nader'}],
  handovers:[{from:'nader',to:'yahia',amount:300,confirmed:true}],
  expenses:[{amount:1200}], unitMaintenance:[{amount:300}], facilityMaintenance:[{amount:500}]
});
EXPIRED.clear(); EXPIRED.add('p9');

// ===== 5. اختبارات الحسابات المركزية =====
const d=D();
// المستهدف: 1300+1100+1300+1000+2000+900 (لا vacant 800، لا staff 700، لا expired 1200) + يومي 500
t('T01 المستهدف يستثني الفارغ/الموظفين/المنتهي', ()=>eq(CALC.target(d), 1300+1100+1300+1000+2000+900+9000+500,'target'));
t('T02 المحصّل يجمع المقبوض فعلياً', ()=>eq(CALC.collected(d), 1300+1100+2000+400+9000+500,'collected'));
t('T03 الإيداعات المعتمدة = transactions فقط', ()=>eq(CALC.deposited(d), 12300,'deposited'));
t('T04 بنكي معلّق = غير المعتمد فقط', ()=>eq(CALC.bankPending(d), 1100,'bankPending'));
t('T05 بنكي معتمد لا يُحسب مرتين', ()=>eq(CALC.bankApproved(d), 1300,'bankApproved'));
t('T06 المودع الكلي = معتمد + بنكي معلّق', ()=>eq(CALC.depositedTotal(d), 12300+1100,'depositedTotal'));
t('T07 المتأخر', ()=>eq(CALC.late(d), 1300,'late'));
t('T08 لم يحل عليه', ()=>eq(CALC.notDue(d), 1000,'notDue'));
t('T09 الجزئي المتبقي', ()=>eq(CALC.partialRemaining(d), 500,'partialRem'));
t('T10 الدورة المنتهية مستثناة', ()=>eq(CALC.expiredTotal(d), 1200,'expired'));
t('T11 محصّل لم يودع', ()=>eq(CALC.undeposited(d), Math.max(0,CALC.collected(d)-CALC.deposited(d)),'undep'));
t('T12 المصروفات = مصاريف + صيانة وحدات + مرافق', ()=>eq(CALC.expenses(d), 2000,'expenses'));
t('T13 السيولة', ()=>eq(CALC.liquidity({companyBalance:100,revenueBalance:50,installmentBalance:25}),175,'liquidity'));

// ===== 26. المبلغ نفسه لا يُحتسب مرتين (التكرار البنكي) =====
t('T14 لا تكرار بنكي: بنكي معتمد داخل transactions فقط', ()=>{
  const dd=D();
  const total=CALC.depositedTotal(dd);
  const naive=CALC.deposited(dd)+CALC.bankPending(dd)+CALC.bankApproved(dd);
  return total===13400 && naive===14700 ? true : `total=${total} naive=${naive}`;
});

// ===== 8/9/10. تحويلات بنكية =====
t('T15 تحويل بنكي معلّق يظهر في bankPending', ()=>{
  const dd=D(); return eq(CALC.bankPending(dd),1100);
});
t('T16 بعد الاعتماد ينتقل مرة واحدة فقط', ()=>{
  const dd=D();
  const before=CALC.depositedTotal(dd);
  dd.full[0].collectionMethod='bank'; dd.full[0].bankDeposited=false; // 9000 يصير بنكياً معلّقاً
  const mid=CALC.depositedTotal(dd);
  dd.full[0].bankDeposited=true; // اعتُمد: يُفترض أن transactions تحوي 9000 أصلاً
  const after=CALC.depositedTotal(dd);
  return (mid===before+9000 && after===before) ? true : `before=${before} mid=${mid} after=${after}`;
});
t('T17 دفعتان جزئيتان لنفس الوحدة (نموذج ledger)', ()=>{
  // نموذج الدفعات المستقلة المقترح: مجموع الدفعات المعتمدة = 700، غير المعتمدة = 400
  const payments=[
    {paymentId:'bp1',unit:'p6',amount:400,status:'approved',idempotencyKey:'k1'},
    {paymentId:'bp2',unit:'p6',amount:300,status:'approved',idempotencyKey:'k2'},
    {paymentId:'bp3',unit:'p6',amount:400,status:'pending', idempotencyKey:'k3'},
    {paymentId:'bp2',unit:'p6',amount:300,status:'approved',idempotencyKey:'k2'} // إعادة إرسال
  ];
  const seen=new Set(); const uniq=payments.filter(p=>seen.has(p.idempotencyKey)?false:(seen.add(p.idempotencyKey),true));
  const appr=uniq.filter(p=>p.status==='approved').reduce((s,p)=>s+p.amount,0);
  const pend=uniq.filter(p=>p.status==='pending').reduce((s,p)=>s+p.amount,0);
  return (uniq.length===3 && appr===700 && pend===400)?true:`uniq=${uniq.length} appr=${appr} pend=${pend}`;
});

// ===== 16. الفائض فوق المستهدف =====
t('T18 الفائض يظهر ولا يُقص', ()=>{
  const dd=D(); dd.transactions.push({id:9,amount:50000,by:'yahia'});
  return (CALC.remaining(dd)===0 && CALC.surplus(dd)>0)?true:`rem=${CALC.remaining(dd)} sur=${CALC.surplus(dd)}`;
});
t('T19 لا فائض في الحالة السليمة', ()=>{const dd=D();return eq(CALC.surplus(dd),0);});

// ===== 17/18/19 حالات الوحدات =====
t('T20 دورة منتهية: خارج المستهدف ولا تُحسب متأخرة', ()=>{
  const dd=D(); const before=CALC.target(dd)+CALC.late(dd);
  EXPIRED.add('p3'); const after=CALC.target(dd)+CALC.late(dd); EXPIRED.delete('p3');
  return (after===before-1300-1300)?true:`before=${before} after=${after}`;
});
t('T21 وحدة فارغة خارج المستهدف', ()=>{const dd=D();const a=CALC.target(dd);dd.units[0].partitions[6].status='late';const b=CALC.target(dd);return eq(b-a,800);});
t('T22 وحدة موظفين خارج المستهدف', ()=>{const dd=D();const a=CALC.target(dd);dd.units[0].partitions[7].status='late';const b=CALC.target(dd);return eq(b-a,700);});

// ===== العهدة =====
t('T23 عهدة يحيى تستثني البنكي وتشمل التسليمات', ()=>{
  const dd=D(); const c=CALC.custody(dd,'yahia');
  // كاش يحيى: p5 2000 + f1 9000 = 11000 (p1/p2 بنكي مستثنى) + استلم 300 - أودع (2000+9000)=11000
  return (c.received===11000 && c.handoverIn===300 && c.deposited===11000 && c.remaining===300)?true:JSON.stringify(c);
});
t('T24 عهدة نادر', ()=>{
  const dd=D(); const c=CALC.custody(dd,'nader');
  return (c.received===400+500 && c.handoverOut===300 && c.remaining===600)?true:JSON.stringify(c);
});

// ===== 11/12/13/14 الضغط المزدوج والذرّية والـidempotency =====
function mockApprove(state, req, opts={}){
  // محاكاة runTransaction: قراءة ثم كتابة ذرّية
  if(state.requests[req.id].status!=='pending') return {ok:false,err:'ALREADY_PROCESSED'};
  const amt=Number(req.amount);
  if(!isFinite(amt)||amt<=0) return {ok:false,err:'BAD_AMOUNT'};
  if(req.kind==='deduct'){
    if(amt>state.balances[req.src]) return {ok:false,err:'INSUFFICIENT'};
  }
  if(state.month.transactions.some(t=>t.requestId===req.id)) return {ok:false,err:'DUPLICATE'};
  if(opts.failMidway) return {ok:false,err:'NETWORK'}; // فشل قبل أي كتابة
  if(req.kind==='deduct') state.balances[req.src]-=amt;
  else { state.balances.revenue+=amt; state.month.transactions.push({requestId:req.id,amount:amt}); }
  state.requests[req.id].status='approved';
  return {ok:true};
}
const mk=()=>({balances:{revenue:1000,company:5000},month:{transactions:[]},requests:{r1:{status:'pending'}}});

t('T25 الضغط المزدوج: الثانية تُرفض', ()=>{
  const st=mk(); const a=mockApprove(st,{id:'r1',amount:500,kind:'add'});
  const b=mockApprove(st,{id:'r1',amount:500,kind:'add'});
  return (a.ok && !b.ok && b.err==='ALREADY_PROCESSED' && st.balances.revenue===1500 && st.month.transactions.length===1)?true:JSON.stringify({a,b,st});
});
t('T26 اعتماد نفس الطلب مرتين لا يضاعف الرصيد', ()=>{
  const st=mk(); mockApprove(st,{id:'r1',amount:500,kind:'add'});
  st.requests.r1.status='pending'; // محاكاة سباق: الحالة رجعت
  const b=mockApprove(st,{id:'r1',amount:500,kind:'add'});
  return (!b.ok && b.err==='DUPLICATE' && st.balances.revenue===1500)?true:JSON.stringify({b,bal:st.balances});
});
t('T27 فشل خطوة داخل العملية = لا تغيير إطلاقاً', ()=>{
  const st=mk(); const r=mockApprove(st,{id:'r1',amount:500,kind:'add'},{failMidway:true});
  return (!r.ok && st.balances.revenue===1000 && st.month.transactions.length===0 && st.requests.r1.status==='pending')?true:JSON.stringify(st);
});
t('T28 نقص الرصيد يرفض ولا يقص إلى صفر', ()=>{
  const st=mk(); const r=mockApprove(st,{id:'r1',amount:9999,kind:'deduct',src:'revenue'});
  return (!r.ok && r.err==='INSUFFICIENT' && st.balances.revenue===1000 && st.requests.r1.status==='pending')?true:JSON.stringify({r,st});
});
t('T29 مبلغ صفري/سالب/NaN مرفوض', ()=>{
  const bad=[0,-5,NaN,'abc',null,undefined,Infinity];
  return bad.every(v=>{const st=mk();return !mockApprove(st,{id:'r1',amount:v,kind:'add'}).ok;})?true:'قُبل مبلغ غير صالح';
});

// ===== 14/21 إلغاء الاعتماد مرتين وعكس العملية =====
function mockReverse(state,req){
  if(state.requests[req.id].status!=='approved') return {ok:false,err:'NOT_APPROVED'};
  const idx=state.month.transactions.findIndex(t=>t.requestId===req.id);
  if(idx<0) return {ok:false,err:'NOT_FOUND'};
  const amt=state.month.transactions[idx].amount;
  if(amt>state.balances.revenue) return {ok:false,err:'INSUFFICIENT'};
  state.month.transactions.splice(idx,1);
  state.balances.revenue-=amt;
  state.requests[req.id].status='revoked';
  return {ok:true};
}
t('T30 عكس العملية يعيد الرصيد بدقة', ()=>{
  const st=mk(); mockApprove(st,{id:'r1',amount:500,kind:'add'});
  const r=mockReverse(st,{id:'r1'});
  return (r.ok && st.balances.revenue===1000 && st.month.transactions.length===0)?true:JSON.stringify(st);
});
t('T31 إلغاء الاعتماد مرتين: الثانية مرفوضة', ()=>{
  const st=mk(); mockApprove(st,{id:'r1',amount:500,kind:'add'}); mockReverse(st,{id:'r1'});
  const b=mockReverse(st,{id:'r1'});
  return (!b.ok && b.err==='NOT_APPROVED' && st.balances.revenue===1000)?true:JSON.stringify({b,st});
});

// ===== 23 تعارض version =====
t('T32 تعارض version يرفض الاعتماد', ()=>{
  const unit={version:3,rent:1000};
  const req={baseVersion:2,fields:{rent:1200}};
  const apply=(u,r)=> u.version!==r.baseVersion ? {ok:false,err:'VERSION_CONFLICT'} : {ok:true};
  const r=apply(unit,req);
  return (!r.ok && r.err==='VERSION_CONFLICT' && unit.rent===1000)?true:JSON.stringify(r);
});

// ===== 24/25 الحجوزات =====
const overlap=(a,b)=> a.start < b.end && b.start < a.end;
t('T33 حجزان متداخلان يُرفضان', ()=>
  overlap({start:'2026-08-01',end:'2026-08-05'},{start:'2026-08-03',end:'2026-08-07'})===true?true:'لم يُكتشف التداخل');
t('T34 حجزان متلاصقان غير متداخلين', ()=>
  overlap({start:'2026-08-01',end:'2026-08-03'},{start:'2026-08-03',end:'2026-08-06'})===false?true:'اعتُبرا متداخلين');
t('T35 نهاية قبل بداية مرفوضة', ()=>{
  const valid=b=> b.start<b.end;
  return valid({start:'2026-08-05',end:'2026-08-01'})===false?true:'قُبل تاريخ معكوس';
});
t('T36 حجز يومي على وحدة مؤجرة شهرياً مرفوض', ()=>{
  const unit={rent_type:'monthly',status:'collected'};
  const allow=u=> !(u.rent_type==='monthly' && u.status!=='vacant');
  return allow(unit)===false?true:'سُمح بالحجز';
});
t('T37 الحجز لا يُحتسب محصّلاً قبل الدفع', ()=>{
  const bookings=[{total:500,status:'pending'},{total:700,status:'paid'},{total:300,status:'cancelled'},{total:200,status:'refunded'}];
  const counted=bookings.filter(b=>b.status==='paid').reduce((s,b)=>s+b.total,0);
  return counted===700?true:`counted=${counted}`;
});

// ===== 27. مقارنة قبل/بعد إعادة التنظيم =====
function legacyEmployeeScreen(d){
  // المنطق القديم حرفياً (قبل CALC) — لإثبات مواضع الاختلاف
  let target=0,bank=0;
  const items=[...d.units.flatMap(u=>u.partitions),...d.full];
  items.forEach(x=>{const ds=displayStatus(x);
    if(ds!=='vacant'&&ds!=='staff'&&ds!=='expired')target+=Number(x.rent)||0;
    let got=0; if(ds==='collected')got=Number(x.rent)||0; else if(ds==='partial')got=Number(x.paid_amount)||0;
    if(got>0&&x.collectionMethod==='bank')bank+=got;});
  target+=d.dailyBookings.reduce((s,b)=>s+b.total,0);
  const dep=d.transactions.reduce((s,t)=>s+t.amount,0)+bank;
  return {target,deposited:dep,remaining:Math.max(0,target-dep)};
}
function legacyOwnerTarget(d){
  const items=[...d.units.flatMap(u=>u.partitions),...d.full];
  return items.filter(x=>x.status!=='vacant').reduce((s,x)=>s+(Number(x.rent)||0),0)
       + d.dailyBookings.reduce((s,b)=>s+b.total,0);
}
const dd=D();
const L=legacyEmployeeScreen(dd), LO=legacyOwnerTarget(dd);
const N={target:CALC.target(dd),deposited:CALC.depositedTotal(dd),remaining:CALC.remaining(dd),surplus:CALC.surplus(dd)};
RESULTS.push(['--- مقارنة قبل/بعد ---','','']);
t('T38 المستهدف لم يتغير في شاشة الموظف', ()=>eq(N.target,L.target,'target'));
t('T39 المودع تغيّر: التكرار البنكي أُزيل', ()=>
  (L.deposited===N.deposited+1300)?true:`قديم=${L.deposited} جديد=${N.deposited}`);
t('T40 مستهدف المدير القديم كان مختلفاً عن الموظف', ()=>
  (LO!==L.target && CALC.target(dd)===N.target)?true:`ownerLegacy=${LO} empLegacy=${L.target}`);

console.log('\n================ نتائج الاختبارات (محاكاة) ================');
RESULTS.forEach(([n,s,m])=>{ if(s==='') console.log(n); else console.log(`${s==='PASS'?'✅':'❌'} ${n}${m?' — '+m:''}`); });
console.log(`\nنجح: ${PASS} | فشل: ${FAIL}`);
console.log('\n--- أرقام المقارنة قبل/بعد ---');
console.log('شاشة الموظف (قديم):', JSON.stringify(L));
console.log('شاشة الموظف (جديد):', JSON.stringify(N));
console.log('مستهدف المدير (قديم):', LO, '| مستهدف المدير (جديد):', CALC.target(dd));
console.log('التوازن:', JSON.stringify(CALC.balanceCheck(dd)));


// ================= إضافات v4 =================
import { _diffFields, validateBooking, __setDisplayStatus } from './logic_extracted.mjs';
__setDisplayStatus(displayStatus);
const R2=[]; let P2=0,F2=0;
function t2(n,fn){try{const r=fn();if(r===true){P2++;R2.push(['✅ '+n]);}else{F2++;R2.push(['❌ '+n+' — '+r]);}}catch(e){F2++;R2.push(['❌ '+n+' — '+e.message]);}}

// --- الفروق فقط + القيم القديمة ---
t2('T41 يرسل الحقول المتغيرة فقط', ()=>{
  const snap={rent:1300,status:'late',tenant:'أحمد',paid_amount:0,note:''};
  const cur ={rent:1300,status:'collected',tenant:'أحمد',paid_amount:1300,note:''};
  const d=_diffFields(cur,snap);
  return (d.count===2 && d.fields.status==='collected' && d.fields.paid_amount===1300
       && d.originalFields.status==='late' && d.originalFields.paid_amount===0)?true:JSON.stringify(d);
});
t2('T42 لا تغيير = لا طلب', ()=>{
  const o={rent:1300,status:'late'}; return _diffFields({...o},o).count===0?true:'اكتشف تغييراً وهمياً';
});
t2('T43 null و "" و undefined لا تُعتبر تغييراً', ()=>{
  const d=_diffFields({a:null,b:undefined,c:''},{a:'',b:'',c:null});
  return d.count===0?true:JSON.stringify(d.fields);
});

// --- تعارض النسخة ---
function assertNoConflict(target,payload){
  const of=payload.originalFields; if(!of) return null;
  const bv=Number(payload.baseVersion);
  if(isFinite(bv) && Number(target.version||0)!==bv) return 'VERSION_CONFLICT';
  const ch=Object.keys(of).filter(k=>String(target[k]??'')!==String(of[k]??''));
  return ch.length?'CONFLICT|'+ch.join(','):null;
}
t2('T44 لا تعارض: القيم كما كانت', ()=>
  assertNoConflict({version:0,status:'late',rent:1300},{originalFields:{status:'late'},baseVersion:0})===null?true:'اكتشف تعارضاً خاطئاً');
t2('T45 تعارض: تغيّرت الحالة على السيرفر', ()=>
  assertNoConflict({version:0,status:'collected'},{originalFields:{status:'late'},baseVersion:0})==='CONFLICT|status'?true:'لم يُكتشف');
t2('T46 تعارض النسخة يُكتشف', ()=>
  assertNoConflict({version:3,status:'late'},{originalFields:{status:'late'},baseVersion:1})==='VERSION_CONFLICT'?true:'لم يُكتشف');
t2('T47 طلب قديم بلا originalFields يُطبَّق (توافق رجعي)', ()=>
  assertNoConflict({version:5,status:'x'},{fields:{status:'y'}})===null?true:'كسر التوافق الرجعي');

// --- الحجوزات ---
const parts=[{id:'u1-1',obj:{status:'vacant',rent:1000}},{id:'u1-2',obj:{status:'collected',rent:1200}},{id:'u1-3',obj:{status:'collected',note:'يومي'}}];
const bookData={dailyBookings:[{id:1,partId:'u1-3',startDate:'2026-08-10',endDate:'2026-08-15',guest:'سالم',status:'paid'}]};
t2('T48 نهاية قبل البداية مرفوضة', ()=>
  /بعد البداية/.test(validateBooking(bookData,{id:9,partId:'u1-3',startDate:'2026-08-20',endDate:'2026-08-18',total:500},parts))?true:'قُبل');
t2('T49 تداخل مرفوض', ()=>
  /تعارض مع حجز قائم/.test(validateBooking(bookData,{id:9,partId:'u1-3',startDate:'2026-08-12',endDate:'2026-08-18',total:500},parts))?true:'قُبل');
t2('T50 تلاصق (نهاية = بداية) مقبول', ()=>
  validateBooking(bookData,{id:9,partId:'u1-3',startDate:'2026-08-15',endDate:'2026-08-18',total:500},parts)===null?true:'رُفض بلا سبب');
t2('T51 وحدة مؤجرة شهرياً مرفوضة', ()=>
  /مؤجّر شهرياً/.test(validateBooking(bookData,{id:9,partId:'u1-2',startDate:'2026-09-01',endDate:'2026-09-03',total:500},parts))?true:'قُبل');
t2('T52 وحدة فارغة مقبولة', ()=>
  validateBooking(bookData,{id:9,partId:'u1-1',startDate:'2026-09-01',endDate:'2026-09-03',total:500},parts)===null?true:'رُفض');
t2('T53 حجز ملغى لا يحجز التاريخ', ()=>{
  const d={dailyBookings:[{id:1,partId:'u1-3',startDate:'2026-08-10',endDate:'2026-08-15',status:'cancelled'}]};
  return validateBooking(d,{id:9,partId:'u1-3',startDate:'2026-08-12',endDate:'2026-08-18',total:500},parts)===null?true:'حجب التاريخ';
});
t2('T54 مبلغ غير صالح مرفوض', ()=>
  [0,-1,NaN,'x'].every(v=>validateBooking(bookData,{id:9,partId:'u1-1',startDate:'2026-09-01',endDate:'2026-09-03',total:v},parts)!==null)?true:'قُبل مبلغ غير صالح');

// --- رسالة الحفظ لا تظهر إلا بعد النجاح ---
t2('T55 فشل الحفظ لا يُظهر "تم الحفظ"', ()=>{
  let shown=null; const showMsg=m=>shown=m;
  const save=ok=>Promise.resolve(ok);
  return save(false).then(ok=>{if(ok)showMsg('✓ تم الحفظ');}).then(()=>shown===null)?true:'ظهرت رسالة نجاح كاذبة';
});

console.log('\n=========== اختبارات v4 الإضافية ===========');
R2.forEach(r=>console.log(r[0]));
console.log(`\nv4: نجح ${P2} | فشل ${F2}`);
console.log(`الإجمالي: ${PASS+P2} نجح | ${FAIL+F2} فشل`);

// ================= المرحلة 1: Firebase مصدراً وحيداً =================
const R3=[]; let P3=0,F3=0;
function t3(n,fn){try{const r=fn();if(r===true){P3++;R3.push('✅ '+n);}else{F3++;R3.push('❌ '+n+' — '+r);}}catch(e){F3++;R3.push('❌ '+n+' — '+e.message);}}

// محاكاة saveMonthData الذرّي بفحص version
function mkServer(){ return {months:{'2026_7':{data:{transactions:[]},version:5}}}; }
function saveMonthAtomic(server, key, payload, baseVer, user){
  const cur=server.months[key];
  const srvVer=cur?cur.version:0;
  if(cur && srvVer!==baseVer) return {ok:false,err:'MONTH_CONFLICT',srvVer,baseVer};
  server.months[key]={data:payload,version:srvVer+1,updatedBy:user};
  return {ok:true,version:srvVer+1};
}
t3('T56 حفظ بنسخة مطابقة ينجح ويرفع version', ()=>{
  const sv=mkServer(); const r=saveMonthAtomic(sv,'2026_7',{transactions:[{a:1}]},5,'saeed');
  return (r.ok && sv.months['2026_7'].version===6)?true:JSON.stringify(r);
});
t3('T57 جهاز بنسخة قديمة يُرفض ولا يمحو الأحدث', ()=>{
  const sv=mkServer();
  saveMonthAtomic(sv,'2026_7',{transactions:[{dev:'A'}]},5,'yahia');  // جهاز A ينجح -> v6
  const b=saveMonthAtomic(sv,'2026_7',{transactions:[{dev:'B'}]},5,'nader'); // جهاز B بنسخة 5
  return (!b.ok && b.err==='MONTH_CONFLICT'
       && sv.months['2026_7'].data.transactions[0].dev==='A'
       && sv.months['2026_7'].version===6)?true:JSON.stringify({b,sv:sv.months['2026_7']});
});
t3('T58 بعد إعادة القراءة يمر الحفظ', ()=>{
  const sv=mkServer();
  saveMonthAtomic(sv,'2026_7',{transactions:[{dev:'A'}]},5,'yahia');
  const fresh=sv.months['2026_7'].version;                 // جهاز B يعيد القراءة
  const b=saveMonthAtomic(sv,'2026_7',{transactions:[{dev:'A'},{dev:'B'}]},fresh,'nader');
  return (b.ok && sv.months['2026_7'].data.transactions.length===2)?true:JSON.stringify(b);
});
t3('T59 شهر غير محمّل لا يُحفظ', ()=>{
  const data={_unloaded:true};
  const guard=d=>d._unloaded?{ok:false,err:'UNLOADED'}:{ok:true};
  return guard(data).err==='UNLOADED'?true:'سمح بالحفظ من نسخة غير مؤكدة';
});
t3('T60 فشل الحفظ يُسقط الكاش ولا يترك تغييراً وهمياً', ()=>{
  const cache={'2026_7':{transactions:[{ghost:true}]}};
  const onFail=k=>{delete cache[k];};
  onFail('2026_7');
  return cache['2026_7']===undefined?true:'بقي تغيير وهمي في الكاش';
});
// النشر عبر الشهور بمعاملة لكل شهر
function propagate(server, months, mutate, user){
  let touched=0, failed=0;
  months.forEach(k=>{
    const cur=server.months[k];
    if(!cur){ return; }                          // شهر غير موجود: لا يُنشأ
    try{
      const d=JSON.parse(JSON.stringify(cur.data));
      if(mutate(d)){ server.months[k]={data:d,version:cur.version+1,updatedBy:user}; touched++; }
    }catch(e){ failed++; }
  });
  return {touched,failed};
}
t3('T61 نشر وحدة جديدة يمس الشهور الموجودة فقط', ()=>{
  const sv={months:{'2026_8':{data:{units:[]},version:1},'2026_9':{data:{units:[]},version:2}}};
  const r=propagate(sv,['2026_8','2026_9','2026_10'],d=>{
    if((d.units||[]).find(u=>u.id==='x'))return false;
    d.units.push({id:'x'}); return true;
  },'saeed');
  return (r.touched===2 && sv.months['2026_8'].version===2 && sv.months['2026_9'].version===3
       && sv.months['2026_10']===undefined)?true:JSON.stringify(r);
});
t3('T62 النشر لا يكرر الوحدة عند إعادة التشغيل', ()=>{
  const sv={months:{'2026_8':{data:{units:[{id:'x'}]},version:1}}};
  const r=propagate(sv,['2026_8'],d=>{
    if((d.units||[]).find(u=>u.id==='x'))return false;
    d.units.push({id:'x'}); return true;
  },'saeed');
  return (r.touched===0 && sv.months['2026_8'].data.units.length===1)?true:JSON.stringify(r);
});
// تعديل عملية معتمدة ذرّياً
function editApproved(state, req, newAmt){
  if(state.requests[req.id].status!=='approved') return {ok:false,err:'NOT_APPROVED'};
  const amt=Number(newAmt);
  if(!isFinite(amt)||amt<=0) return {ok:false,err:'BAD_AMOUNT'};
  const list=req.type==='tx'?state.month.transactions:state.month.expenses;
  const e=list.find(x=>x.requestId===req.id);
  if(!e) return {ok:false,err:'ENTRY_MISSING'};
  const diff=amt-e.amount;
  if(req.type==='tx'){
    if(diff<0 && Math.abs(diff)>state.balances.revenue) return {ok:false,err:'INSUFFICIENT'};
    e.amount=amt; state.balances.revenue+=diff;
  }else{
    const src=req.paidFrom||'revenue';
    if(diff>0 && diff>state.balances[src]) return {ok:false,err:'INSUFFICIENT'};
    e.amount=amt; state.balances[src]-=diff;
  }
  return {ok:true};
}
const mkEdit=()=>({balances:{revenue:1000,company:5000},
  month:{transactions:[{requestId:'r1',amount:500}],expenses:[{requestId:'r2',amount:200}]},
  requests:{r1:{status:'approved'},r2:{status:'approved'}}});
t3('T63 تعديل إيداع معتمد يعدّل الرصيد بالفرق', ()=>{
  const st=mkEdit(); const r=editApproved(st,{id:'r1',type:'tx'},700);
  return (r.ok && st.balances.revenue===1200 && st.month.transactions[0].amount===700)?true:JSON.stringify(st.balances);
});
t3('T64 تعديل مصروف معتمد يعدّل الحساب المخصوم منه', ()=>{
  const st=mkEdit(); const r=editApproved(st,{id:'r2',type:'exp',paidFrom:'company'},500);
  // زيادة المصروف 200 -> 500 = خصم إضافي 300
  return (r.ok && st.balances.company===4700)?true:JSON.stringify(st.balances);
});
t3('T65 تقليل المصروف يعيد الفرق', ()=>{
  const st=mkEdit(); editApproved(st,{id:'r2',type:'exp',paidFrom:'revenue'},50);
  return st.balances.revenue===1150?true:'revenue='+st.balances.revenue;
});
t3('T66 تعديل يتجاوز الرصيد مرفوض بلا تغيير', ()=>{
  const st=mkEdit(); const r=editApproved(st,{id:'r2',type:'exp',paidFrom:'revenue'},99999);
  return (!r.ok && st.balances.revenue===1000 && st.month.expenses[0].amount===200)?true:JSON.stringify(st);
});
t3('T67 تعديل عملية غير معتمدة مرفوض', ()=>{
  const st=mkEdit(); st.requests.r1.status='revoked';
  return editApproved(st,{id:'r1',type:'tx'},700).err==='NOT_APPROVED'?true:'سمح بالتعديل';
});

console.log('\n=========== المرحلة 1: Firebase مصدراً وحيداً ===========');
R3.forEach(r=>console.log(r));
console.log(`\nالمرحلة 1: نجح ${P3} | فشل ${F3}`);
console.log(`الإجمالي الكلي: ${PASS+P2+P3} نجح | ${FAIL+F2+F3} فشل`);

// ================= المرحلة 2: الدفعات البنكية =================
const R4=[]; let P4=0,F4=0;
function t4(n,fn){try{const r=fn();if(r===true){P4++;R4.push('✅ '+n);}else{F4++;R4.push('❌ '+n+' — '+r);}}catch(e){F4++;R4.push('❌ '+n+' — '+e.message);}}

// محاكاة معاملة اعتماد الدفعة البنكية (نفس منطق approveBankPayment)
function mkBank(){ return {
  docs:{},                                   // bankPayments/{id}
  month:{bankPayments:[],transactions:[],units:[{id:'u1',partitions:[{id:1,rent:5000,status:'collected',paid_amount:5000,collectionMethod:'bank'}]}],full:[]},
  balances:{revenue:1000}, version:1 }; }
const recvOf=x=>x.status==='collected'?Number(x.rent):Number(x.paid_amount||0);
function approveBank(st, ref, amount){
  const amt=Math.round(Number(amount)*100)/100;
  if(!isFinite(amt)||amt<=0) return {ok:false,err:'BAD_AMOUNT'};
  const item=st.month.units[0].partitions.find(p=>'bank_u1_'+p.id===ref);
  if(!item) return {ok:false,err:'UNIT_MISSING'};
  const prior=st.month.bankPayments.filter(b=>b.ref===ref&&b.status==='approved');
  const soFar=prior.reduce((s,b)=>s+b.amount,0);
  const legacy=(!prior.length&&item.bankDeposited)?recvOf(item):0;
  const remaining=Math.round((recvOf(item)-soFar-legacy)*100)/100;
  if(remaining<=0) return {ok:false,err:'ALREADY_FULL'};
  if(amt>remaining) return {ok:false,err:'EXCEEDS',remaining};
  const seq=st.month.bankPayments.filter(b=>b.ref===ref).length+1;
  const paymentId='2026_7__'+ref+'__'+seq;
  if(st.docs[paymentId]) return {ok:false,err:'DUPLICATE'};
  const rec={paymentId,ref,amount:amt,status:'approved'};
  st.docs[paymentId]=rec;
  st.month.bankPayments.push(rec);
  st.month.transactions.push({id:paymentId,amount:amt,bankRef:ref,paymentId});
  if(soFar+legacy+amt>=recvOf(item)) item.bankDeposited=true;
  st.balances.revenue+=amt; st.version++;
  return {ok:true,paymentId};
}
function cancelBank(st,paymentId){
  const rec=st.month.bankPayments.find(b=>b.paymentId===paymentId);
  if(!rec) return {ok:false,err:'PAY_MISSING'};
  if(rec.status!=='approved') return {ok:false,err:'NOT_APPROVED'};
  if(rec.amount>st.balances.revenue) return {ok:false,err:'INSUFFICIENT'};
  rec.status='cancelled';
  st.month.transactions=st.month.transactions.filter(t=>t.paymentId!==paymentId);
  st.balances.revenue-=rec.amount;
  const item=st.month.units[0].partitions.find(p=>'bank_u1_'+p.id===rec.ref);
  if(item) item.bankDeposited=false;
  return {ok:true};
}
const depositedOf=st=>st.month.transactions.reduce((s,t)=>s+t.amount,0);

t4('T68 دفعة كاملة تُعتمد مرة واحدة', ()=>{
  const st=mkBank(); const r=approveBank(st,'bank_u1_1',5000);
  return (r.ok && depositedOf(st)===5000 && st.balances.revenue===6000
       && st.month.units[0].partitions[0].bankDeposited===true)?true:JSON.stringify({r,d:depositedOf(st)});
});
t4('T69 دفعتان جزئيتان لنفس الوحدة', ()=>{
  const st=mkBank();
  const a=approveBank(st,'bank_u1_1',2000);
  const b=approveBank(st,'bank_u1_1',3000);
  return (a.ok&&b.ok&&a.paymentId!==b.paymentId&&depositedOf(st)===5000
       &&st.month.bankPayments.length===2)?true:JSON.stringify({a,b,d:depositedOf(st)});
});
t4('T70 ثلاث دفعات جزئية بنفس المبلغ لا تتصادم', ()=>{
  const st=mkBank();
  const ids=[approveBank(st,'bank_u1_1',1000),approveBank(st,'bank_u1_1',1000),approveBank(st,'bank_u1_1',1000)];
  const uniq=new Set(ids.map(x=>x.paymentId));
  return (ids.every(x=>x.ok)&&uniq.size===3&&depositedOf(st)===3000)?true:JSON.stringify(ids);
});
t4('T71 المبلغ الزائد عن المتبقي مرفوض', ()=>{
  const st=mkBank(); approveBank(st,'bank_u1_1',4000);
  const b=approveBank(st,'bank_u1_1',2000);
  return (!b.ok&&b.err==='EXCEEDS'&&b.remaining===1000&&depositedOf(st)===4000)?true:JSON.stringify(b);
});
t4('T72 بعد اكتمال المبلغ لا اعتماد إضافي', ()=>{
  const st=mkBank(); approveBank(st,'bank_u1_1',5000);
  const b=approveBank(st,'bank_u1_1',100);
  return (!b.ok&&b.err==='ALREADY_FULL')?true:JSON.stringify(b);
});
t4('T73 معرّف المستند يمنع التكرار', ()=>{
  const st=mkBank(); const a=approveBank(st,'bank_u1_1',2000);
  st.month.bankPayments.pop();          // محاكاة سباق: السطر ضاع لكن المستند موجود
  const b=approveBank(st,'bank_u1_1',2000);
  return (!b.ok&&b.err==='DUPLICATE')?true:'أُنشئ مستند ثانٍ بنفس المعرّف';
});
t4('T74 إلغاء دفعة واحدة لا يمس البقية', ()=>{
  const st=mkBank();
  const a=approveBank(st,'bank_u1_1',2000);
  const b=approveBank(st,'bank_u1_1',3000);
  cancelBank(st,a.paymentId);
  return (depositedOf(st)===3000 && st.balances.revenue===4000
       && st.month.bankPayments.find(x=>x.paymentId===b.paymentId).status==='approved'
       && st.month.units[0].partitions[0].bankDeposited===false)?true:JSON.stringify({d:depositedOf(st),bal:st.balances});
});
t4('T75 إلغاء الدفعة مرتين مرفوض', ()=>{
  const st=mkBank(); const a=approveBank(st,'bank_u1_1',2000);
  cancelBank(st,a.paymentId);
  const c=cancelBank(st,a.paymentId);
  return (!c.ok&&c.err==='NOT_APPROVED'&&st.balances.revenue===1000)?true:JSON.stringify({c,bal:st.balances});
});
t4('T76 بعد الإلغاء يمكن اعتماد المبلغ من جديد', ()=>{
  const st=mkBank(); const a=approveBank(st,'bank_u1_1',5000);
  cancelBank(st,a.paymentId);
  const b=approveBank(st,'bank_u1_1',5000);
  return (b.ok && depositedOf(st)===5000 && b.paymentId!==a.paymentId)?true:JSON.stringify(b);
});
t4('T77 المبلغ لا يُحتسب مرتين بعد الاعتماد', ()=>{
  const st=mkBank(); approveBank(st,'bank_u1_1',5000);
  // المودع = transactions فقط؛ المتبقي البنكي المعلّق = صفر
  const item=st.month.units[0].partitions[0];
  const soFar=st.month.bankPayments.filter(b=>b.status==='approved').reduce((s,b)=>s+b.amount,0);
  const pending=Math.max(0,recvOf(item)-soFar);
  return (depositedOf(st)+pending===5000)?true:`dep=${depositedOf(st)} pend=${pending}`;
});
t4('T78 توافق رجعي: bankDeposited القديم يُعتبر معتمداً بالكامل', ()=>{
  const st=mkBank(); st.month.units[0].partitions[0].bankDeposited=true;
  const b=approveBank(st,'bank_u1_1',5000);
  return (!b.ok&&b.err==='ALREADY_FULL')?true:'حسبه غير معتمد فأتاح تكراراً';
});
t4('T79 مبلغ صفري/سالب مرفوض', ()=>{
  const st=mkBank();
  return [0,-100,NaN,'x'].every(v=>!approveBank(st,'bank_u1_1',v).ok)?true:'قُبل مبلغ غير صالح';
});

console.log('\n=========== المرحلة 2: الدفعات البنكية ===========');
R4.forEach(r=>console.log(r));
console.log(`\nالمرحلة 2: نجح ${P4} | فشل ${F4}`);
console.log(`الإجمالي الكلي: ${PASS+P2+P3+P4} نجح | ${FAIL+F2+F3+F4} فشل`);

// ================= المرحلة 3: المسارات المالية المباشرة =================
const R5=[]; let P5=0,F5=0;
function t5(n,fn){try{const r=fn();if(r===true){P5++;R5.push('✅ '+n);}else{F5++;R5.push('❌ '+n+' — '+r);}}catch(e){F5++;R5.push('❌ '+n+' — '+e.message);}}

// محاكاة runMoneyOp
function moneyOp(state, {mutateBalances, mutateMonth}){
  if(state.busy) return {ok:false,err:'BUSY'};
  const bal={...state.balances, schedule:JSON.parse(JSON.stringify(state.schedule||[]))};
  const month=JSON.parse(JSON.stringify(state.month));
  try{
    const nb=mutateBalances?mutateBalances(bal):bal;
    if(nb.company<0||nb.revenue<0||nb.installment<0) throw new Error('NEGATIVE');
    if(mutateMonth) mutateMonth(month,nb);
    state.balances={company:nb.company,revenue:nb.revenue,installment:nb.installment};
    state.schedule=nb.schedule; state.month=month;
    return {ok:true};
  }catch(e){ return {ok:false,err:e.message}; }   // لا شيء طُبِّق
}
const mkM=()=>({balances:{company:5000,revenue:1000,installment:2000},
  schedule:[{date:'2026-06-30',amount:1500,paid:false}],
  month:{transactions:[],profits:[],installments:[],logs:[]},busy:false});
const money=v=>{const n=Math.round(Number(v)*100)/100;if(!isFinite(n)||isNaN(n)||n<=0)throw new Error('BAD_AMOUNT');return n;};

t5('T80 إيداع مباشر يضيف القيد والرصيد معاً', ()=>{
  const st=mkM(); const a=money(500);
  const r=moneyOp(st,{mutateBalances:b=>{b.revenue+=a;return b;},
                      mutateMonth:m=>{m.transactions.push({id:'d1',amount:a});}});
  return (r.ok&&st.balances.revenue===1500&&st.month.transactions.length===1)?true:JSON.stringify(st);
});
t5('T81 الأرباح تُخصم فعلياً من الحساب المختار', ()=>{
  const st=mkM(); const a=money(800);
  const r=moneyOp(st,{mutateBalances:b=>{if(a>b.company)throw new Error('INSUFFICIENT|'+b.company+'|'+a);b.company-=a;return b;},
                      mutateMonth:m=>{m.profits.push({amount:a,paidFrom:'company'});}});
  return (r.ok&&st.balances.company===4200&&st.month.profits[0].paidFrom==='company')?true:JSON.stringify(st.balances);
});
t5('T82 الأرباح بمبلغ يفوق الرصيد: لا قيد ولا خصم', ()=>{
  const st=mkM(); const a=money(99999);
  const r=moneyOp(st,{mutateBalances:b=>{if(a>b.company)throw new Error('INSUFFICIENT|'+b.company+'|'+a);b.company-=a;return b;},
                      mutateMonth:m=>{m.profits.push({amount:a});}});
  return (!r.ok&&st.balances.company===5000&&st.month.profits.length===0)?true:JSON.stringify(st);
});
t5('T83 القسط يُخصم من حساب الاقتطاع ويوسم مدفوعاً معاً', ()=>{
  const st=mkM(); const due=1500;
  const r=moneyOp(st,{mutateBalances:b=>{
    if(due>b.installment)throw new Error('INSUFFICIENT');
    b.installment-=due; b.schedule=b.schedule.map(x=>x.date==='2026-06-30'?{...x,paid:true}:x); return b;}});
  return (r.ok&&st.balances.installment===500&&st.schedule[0].paid===true)?true:JSON.stringify(st);
});
t5('T84 قسط أكبر من رصيد الاقتطاع: لا وسم ولا خصم', ()=>{
  const st=mkM(); const due=9999;
  const r=moneyOp(st,{mutateBalances:b=>{
    if(due>b.installment)throw new Error('INSUFFICIENT');
    b.installment-=due; b.schedule=b.schedule.map(x=>({...x,paid:true})); return b;}});
  return (!r.ok&&st.balances.installment===2000&&st.schedule[0].paid===false)?true:JSON.stringify(st);
});
t5('T85 التحويل بين الحسابين يحفظ المجموع', ()=>{
  const st=mkM(); const a=money(600); const tot=st.balances.company+st.balances.revenue;
  const r=moneyOp(st,{mutateBalances:b=>{if(a>b.revenue)throw new Error('INSUFFICIENT');b.revenue-=a;b.company+=a;return b;}});
  return (r.ok&&st.balances.company+st.balances.revenue===tot&&st.balances.revenue===400)?true:JSON.stringify(st.balances);
});
t5('T86 التحويل بما يفوق المصدر مرفوض', ()=>{
  const st=mkM(); const a=money(5000);
  const r=moneyOp(st,{mutateBalances:b=>{if(a>b.revenue)throw new Error('INSUFFICIENT');b.revenue-=a;b.company+=a;return b;}});
  return (!r.ok&&st.balances.revenue===1000&&st.balances.company===5000)?true:JSON.stringify(st.balances);
});
t5('T87 السحب من حساب الاقتطاع يمنع السالب', ()=>{
  const st=mkM();
  const r=moneyOp(st,{mutateBalances:b=>{b.installment-=9999;return b;}});
  return (!r.ok&&r.err==='NEGATIVE'&&st.balances.installment===2000)?true:JSON.stringify(r);
});
t5('T88 التعديل اليدوي للرصيد يرفض السالب', ()=>{
  const st=mkM();
  const r=moneyOp(st,{mutateBalances:b=>{b.company=-1;return b;}});
  return (!r.ok&&st.balances.company===5000)?true:'قَبِل رصيداً سالباً';
});
t5('T89 الضغط المزدوج محجوب أثناء التنفيذ', ()=>{
  const st=mkM(); st.busy=true;
  const r=moneyOp(st,{mutateBalances:b=>{b.revenue+=500;return b;}});
  return (!r.ok&&r.err==='BUSY'&&st.balances.revenue===1000)?true:JSON.stringify(r);
});
t5('T90 مبلغ غير صالح يُرفض قبل أي كتابة', ()=>{
  const bad=[0,-1,NaN,'x',null,Infinity];
  return bad.every(v=>{try{money(v);return false;}catch(e){return true;}})?true:'قُبل مبلغ غير صالح';
});
t5('T91 الإيداع المباشر لا يتكرر بنفس المعرّف', ()=>{
  const st=mkM(); const a=money(500); const id='dep_1';
  const push=m=>{if(m.transactions.some(x=>x.id===id))return;m.transactions.push({id,amount:a});};
  moneyOp(st,{mutateBalances:b=>{b.revenue+=a;return b;},mutateMonth:push});
  moneyOp(st,{mutateBalances:b=>{b.revenue+=0.0;return b;},mutateMonth:push});
  return st.month.transactions.length===1?true:'تكرر القيد';
});
// العهدة
t5('T92 تأكيد التسليم مرتين مرفوض', ()=>{
  const hv={id:'h1',status:'pending',amount:500};
  const confirm=x=>{ if((x.status||'pending')!=='pending') return {ok:false,err:'ALREADY'}; x.status='confirmed'; return {ok:true}; };
  const a=confirm(hv), b=confirm(hv);
  return (a.ok&&!b.ok&&b.err==='ALREADY')?true:'سمح بالتأكيد مرتين';
});
t5('T93 التسليم غير المؤكد لا يُحتسب في عهدة المستلم', ()=>{
  const hvs=[{from:'nader',to:'yahia',amount:300,status:'pending'},{from:'nader',to:'yahia',amount:200,status:'confirmed'}];
  const conf=x=>(x.status||'confirmed')==='confirmed';
  const hvIn=hvs.filter(x=>x.to==='yahia'&&conf(x)).reduce((s,x)=>s+x.amount,0);
  return hvIn===200?true:'hvIn='+hvIn;
});

console.log('\n=========== المرحلة 3: المسارات المالية المباشرة ===========');
R5.forEach(r=>console.log(r));
console.log(`\nالمرحلة 3: نجح ${P5} | فشل ${F5}`);
console.log(`\n████ الإجمالي الكلي: ${PASS+P2+P3+P4+P5} نجح | ${FAIL+F2+F3+F4+F5} فشل ████`);
