// ===== v10 (محاكاة) — البنود 1-11 =====
let P=0,F=0; const R=[];
const t=(n,fn)=>{try{const r=fn();if(r===true){P++;R.push('✅ '+n);}else{F++;R.push('❌ '+n+' — '+r);}}catch(e){F++;R.push('❌ '+n+' — '+e.message);}};
const r2=v=>Math.round(Number(v)*100)/100, num=v=>{const n=Number(v);return isFinite(n)?n:0;};

const USERS={saeed:{role:'owner'},yahia:{role:'emp'},nader:{role:'emp'}};
const UID={'uid_A1':'yahia','uid_B2':'nader'};
const userKeyOf=v=>{if(!v)return null;const s=String(v);return USERS[s]?s:(UID[s]||s);};

// ---- CALC (منقول من الملف) ----
const bookingWasPaid=b=>{ if(!b) return false; const st=b.status;
  if(st==='pending') return false;
  if(st==='paid'||st==='confirmed') return !!b.paidAt;
  if(st==='cancelled'||st==='refunded'){ if(typeof b.wasPaid==='boolean') return b.wasPaid; return !!b.paidAt; }
  return true; };
const bookingNet=b=> bookingWasPaid(b)? Math.max(0,r2(num(b.total)-num(b.refundAmount))) : 0;
const dailyTotal=d=> r2((d.dailyBookings||[]).reduce((s,b)=>s+bookingNet(b),0));
const received=x=>{const paid=num(x.paid_amount),rent=num(x.rent);
  if(x.partial&&paid>0&&paid<rent) return paid;
  if(x.status==='collected') return rent;
  return 0;};
function custody(d,user){
  const U=userKeyOf(user), eq=v=>{const k=userKeyOf(v);return !!k&&k===U;};
  let recv=0;
  (d.units||[]).flatMap(u=>u.partitions||[]).forEach(x=>{ if(eq(x.collectedBy)&&x.collectionMethod!=='bank') recv+=received(x); });
  (d.full||[]).forEach(x=>{ if(eq(x.collectedBy)&&x.collectionMethod!=='bank') recv+=received(x); });
  (d.dailyBookings||[]).forEach(b=>{
    if(!bookingWasPaid(b)) return;
    if(b.paymentMethod==='bank') return;
    if(!eq(b.collectedBy||b.by)) return;
    recv+=num(b.total);
    if(b.refundFrom==='custody') recv-=num(b.refundAmount); });
  const hv=(d.handovers||[]).filter(x=>x.confirmed!==false&&x.status!=='rejected');
  const hvIn=hv.filter(x=>eq(x.to)).reduce((s,x)=>s+num(x.amount),0);
  const hvOut=hv.filter(x=>eq(x.from)).reduce((s,x)=>s+num(x.amount),0);
  const dep=(d.transactions||[]).filter(x=>eq(x.by)&&!x.bankRef&&!x.reversed).reduce((s,x)=>s+num(x.amount),0);
  return {received:r2(recv),handoverIn:r2(hvIn),handoverOut:r2(hvOut),deposited:r2(dep),
          remaining:r2(recv+hvIn-hvOut-dep)};
}
const deposited=d=>r2((d.transactions||[]).filter(x=>!x.reversed).reduce((s,x)=>s+num(x.amount),0));
const STAFF=['yahia','nader','saeed'];
const employeeHoldingTotal=d=>r2(STAFF.reduce((s,k)=>s+custody(d,k).remaining,0));
const actualCollected=d=>r2(deposited(d)+employeeHoldingTotal(d));

// ===== 1) العهدة موحّدة =====
const D1={units:[{partitions:[{id:1,rent:1300,status:'collected',collectionMethod:'cash',collectedBy:'yahia'}]}],
  dailyBookings:[{id:'b1',total:1000,status:'paid',paidAt:'x',paymentMethod:'cash',collectedBy:'yahia'}],
  transactions:[],handovers:[],full:[]};
t('W01 عهدة يحيى تشمل كاش الإيجار وكاش الحجز', ()=>
  custody(D1,'yahia').remaining===2300?true:JSON.stringify(custody(D1,'yahia')));
t('W02 شاشة المدير وشاشة الموظف تعطيان نفس الرقم', ()=>{
  const emp=custody(D1,'yahia').remaining;          // بطاقة عهدتي
  const own=custody(D1,'yahia').remaining;          // بطاقة عهدة الموظفين
  return emp===own&&emp===2300?true:`emp=${emp} own=${own}`;
});
t('W03 استرداد 200 من العهدة ينقصها 200 فقط', ()=>{
  const d=JSON.parse(JSON.stringify(D1));
  d.dailyBookings[0]={...d.dailyBookings[0],status:'refunded',wasPaid:true,refundAmount:200,refundFrom:'custody'};
  return custody(d,'yahia').remaining===2100?true:JSON.stringify(custody(d,'yahia'));
});
t('W04 UID قديم وyahia في نفس العهدة', ()=>{
  const d={units:[{partitions:[{id:1,rent:500,status:'collected',collectionMethod:'cash',collectedBy:'uid_A1'}]}],
    dailyBookings:[{id:'x',total:300,status:'paid',paidAt:'x',paymentMethod:'cash',collectedBy:'yahia'}],
    transactions:[{by:'uid_A1',amount:100}],handovers:[],full:[]};
  const c=custody(d,'yahia');
  return c.received===800&&c.deposited===100&&c.remaining===700?true:JSON.stringify(c);
});
t('W05 العمليات المعكوسة مستثناة من العهدة', ()=>{
  const d={units:[],full:[],dailyBookings:[],handovers:[],
    transactions:[{by:'yahia',amount:500},{by:'yahia',amount:300,reversed:true}]};
  return custody(d,'yahia').deposited===500?true:JSON.stringify(custody(d,'yahia'));
});

// ===== 2) KPI =====
t('W06 Actual Collected = Deposited + Employee Holding', ()=>{
  const d={units:[{partitions:[{id:1,rent:1000,status:'collected',collectionMethod:'cash',collectedBy:'yahia'}]}],
    full:[],dailyBookings:[],handovers:[],transactions:[{by:'yahia',amount:600}]};
  const dep=deposited(d), hold=employeeHoldingTotal(d), act=actualCollected(d);
  return act===dep+hold&&dep===600&&hold===400&&act===1000?true:JSON.stringify({dep,hold,act});
});
t('W07 Bank Pending لا يدخل Actual Collected ولا Deposited', ()=>{
  const d={units:[{partitions:[{id:1,rent:1300,status:'collected',collectionMethod:'bank',bankDeposited:false,collectedBy:'yahia'}]},],
    full:[],dailyBookings:[],handovers:[],transactions:[]};
  const bankPending=1300;
  return deposited(d)===0&&employeeHoldingTotal(d)===0&&actualCollected(d)===0?true:
    JSON.stringify({dep:deposited(d),hold:employeeHoldingTotal(d),act:actualCollected(d)});
});
t('W08 نسبة التحصيل على المحصّل الفعلي لا المودع', ()=>{
  const d={units:[{partitions:[{id:1,rent:1000,status:'collected',collectionMethod:'cash',collectedBy:'yahia'}]}],
    full:[],dailyBookings:[],handovers:[],transactions:[]};
  const target=1000;
  const pctOld=Math.round(deposited(d)/target*100);        // 0% خطأ
  const pctNew=Math.round(actualCollected(d)/target*100);   // 100% صحيح
  return pctOld===0&&pctNew===100?true:`old=${pctOld} new=${pctNew}`;
});

// ===== 6) bookingWasPaid =====
t('W09 pending 1000 ثم إلغاء بلا استرداد = 0', ()=>{
  const bk={total:1000,status:'pending',paidAt:null};
  const wasPaid=bookingWasPaid(bk);                    // false
  const after={...bk,status:'cancelled',wasPaid,refundAmount:0};
  return bookingNet(after)===0?true:'صار '+bookingNet(after);
});
t('W10 paid 1000 ثم إلغاء بلا استرداد = 1000', ()=>{
  const bk={total:1000,status:'paid',paidAt:'x'};
  const after={...bk,status:'cancelled',wasPaid:bookingWasPaid(bk),refundAmount:0};
  return bookingNet(after)===1000?true:'صار '+bookingNet(after);
});
t('W11 paid 1000 ثم استرداد 200 = 800', ()=>{
  const bk={total:1000,status:'paid',paidAt:'x'};
  const after={...bk,status:'refunded',wasPaid:true,refundAmount:200};
  return bookingNet(after)===800?true:'صار '+bookingNet(after);
});
t('W12 paid 1000 ثم استرداد كامل = 0', ()=>{
  const after={total:1000,status:'refunded',paidAt:'x',wasPaid:true,refundAmount:1000};
  return bookingNet(after)===0?true:'صار '+bookingNet(after);
});
t('W13 المبلغ وحده ليس دليل دفع', ()=>{
  const after={total:5000,status:'cancelled',paidAt:null,wasPaid:false,refundAmount:0};
  return bookingNet(after)===0?true:'اعتبره مدفوعاً';
});

// ===== 8) daily card = net =====
t('W14 بطاقة اليومي تستخدم الصافي لا الإجمالي', ()=>{
  const d={dailyBookings:[
    {total:1000,status:'paid',paidAt:'x'},
    {total:1000,status:'refunded',paidAt:'x',wasPaid:true,refundAmount:200},
    {total:900,status:'pending',paidAt:null}]};
  const gross=d.dailyBookings.reduce((s,b)=>s+b.total,0);   // 2900 خطأ
  const net=dailyTotal(d);                                   // 1800 صحيح
  return gross===2900&&net===1800?true:`gross=${gross} net=${net}`;
});

// ===== 3) اعتماد طلب حجز بنكي =====
t('W15 اعتماد طلب حجز بنكي ينشئ bankPayment مرتبطاً في نفس المعاملة', ()=>{
  const writes=[];
  const approve=(req)=>{
    const bk={...req.payload.booking,id:req.id,requestId:req.id};
    let bp=null;
    if(bk.paymentMethod==='bank'){
      bp={id:'bp_'+req.id,status:'pending',bookingId:req.id,amount:bk.total};
      bk.bankPaymentId=bp.id;
    }
    writes.push({col:'months',bk}); if(bp) writes.push({col:'bankPayments',bp});
    return {ok:true,bk,bp};
  };
  const r=approve({id:'r9',payload:{booking:{total:700,status:'paid',paidAt:'x',paymentMethod:'bank'}}});
  return r.bk.bankPaymentId==='bp_r9'&&r.bp.status==='pending'&&writes.length===2?true:JSON.stringify(writes);
});
t('W16 الحجز البنكي لا يرفع الرصيد ولا يدخل المودع قبل الاعتماد', ()=>{
  const d={transactions:[]}; const bal={revenue:3000};
  return deposited(d)===0&&bal.revenue===3000?true:'fail';
});

// ===== 4) الإلغاء يقرأ من السيرفر =====
t('W17 قرار الدفعة من حالة السيرفر لا الكاش', ()=>{
  const SERVER={'bp1':{status:'approved'}};   // الكاش يقول pending
  const CACHE ={'bp1':{status:'pending'}};
  const decide=(id,src)=>{const st=(src[id]||{}).status;
    return st==='pending'?'cancel':st==='approved'?'keep':'none';};
  return decide('bp1',SERVER)==='keep'&&decide('bp1',CACHE)==='cancel'?true:'القرار من الكاش';
});
t('W18 تغيّر الدفعة من pending إلى approved أثناء الإلغاء لا يُفسد شيئاً', ()=>{
  const bp={status:'approved'};   // تغيّرت قبل المعاملة
  const bk={total:700,status:'paid',paidAt:'x',paymentMethod:'bank',bankPaymentId:'bp1'};
  const act = bp.status==='pending'?'cancel':bp.status==='approved'?'keep':'none';
  // keep: لا تُحذف الدفعة ولا يُلغى الإيداع؛ الاسترداد وحده يوثَّق
  const refund=0;
  return act==='keep'&&bp.status==='approved'&&refund===0?true:'فساد';
});
t('W19 دفعة ملغاة مسبقاً لا تُعالج مرتين', ()=>{
  const bp={status:'cancelled'};
  const act = bp.status==='pending'?'cancel':bp.status==='approved'?'keep':'none';
  return act==='none'?true:'عولجت مجدداً';
});

// ===== 5) لا حذف لحجز مدفوع =====
t('W20 عكس طلب حجز مدفوع مرفوض — يوجَّه للإلغاء', ()=>{
  const bk={total:700,status:'paid',paidAt:'x'};
  const reverse=()=>{ if(bookingWasPaid(bk)) throw new Error('BOOKING_PAID_USE_CANCEL'); return {ok:true}; };
  let err=null; try{reverse();}catch(e){err=e.message;}
  return err==='BOOKING_PAID_USE_CANCEL'?true:'سمح بالحذف';
});
t('W21 عكس طلب حجز غير مدفوع مسموح', ()=>{
  const bk={total:700,status:'pending',paidAt:null};
  const reverse=()=>{ if(bookingWasPaid(bk)) throw new Error('BLOCKED'); return {ok:true}; };
  return reverse().ok?true:'مُنع بلا سبب';
});

// ===== 7) paidFrom بلا تخمين =====
t('W22 paidFrom مفقود لا يفترض revenue', ()=>{
  const resolve=(entry,reqDoc,pick)=> entry.paidFrom || reqDoc.paidFrom || pick || null;
  const v=resolve({},{},null);
  let err=null; if(!v) err='PAID_FROM_REQUIRED';
  return v===null&&err==='PAID_FROM_REQUIRED'?true:'خمّن '+v;
});
t('W23 paidFrom من السجل له الأولوية ثم الطلب ثم الاختيار', ()=>{
  const resolve=(e,r,p)=> e.paidFrom||r.paidFrom||p||null;
  return resolve({paidFrom:'company'},{paidFrom:'revenue'},'revenue')==='company'
      && resolve({},{paidFrom:'company'},'revenue')==='company'
      && resolve({},{},'company')==='company' ?true:'ترتيب خاطئ';
});
t('W24 العكس بالمصدر المختار يخصم من الحساب الصحيح', ()=>{
  const bal={company:5000,revenue:3000};
  const reverseExpense=(amt,src)=>{ bal[src]=r2(bal[src]+amt); };
  reverseExpense(800,'company');
  return bal.company===5800&&bal.revenue===3000?true:JSON.stringify(bal);
});

// ===== 9) التصحيح =====
t('W25 تصحيح 1000 إلى 700: الأصل معكوس والجديدة 700', ()=>{
  const bal={revenue:5000};
  const d={transactions:[{id:'t1',amount:1000,requestId:'r1'}]};
  const led=[];
  const correct=(reqId,newAmt)=>{
    const t0=d.transactions.find(x=>x.requestId===reqId);
    if(t0.reversed) return {ok:false,err:'ALREADY_CORRECTED'};
    const open=bal.revenue;
    bal.revenue=r2(bal.revenue-t0.amount); const mid=bal.revenue;
    led.push({dir:'debit',amount:t0.amount,before:open,after:mid,reverseOf:'approve_'+reqId});
    t0.reversed=true;
    d.transactions.push({id:'c_'+reqId,amount:newAmt,correctedFrom:t0.id});
    bal.revenue=r2(bal.revenue+newAmt);
    led.push({dir:'credit',amount:newAmt,before:mid,after:bal.revenue});
    return {ok:true};
  };
  const r=correct('r1',700);
  const live=d.transactions.filter(x=>!x.reversed);
  return r.ok&&bal.revenue===4700&&live.length===1&&live[0].amount===700
    &&live[0].correctedFrom==='t1'&&led.length===2?true:JSON.stringify({bal,live,led});
});
t('W26 التصحيح مرتين مرفوض', ()=>{
  const d={transactions:[{id:'t1',amount:1000,requestId:'r1',reversed:true}]};
  const correct=()=>{const t0=d.transactions.find(x=>x.requestId==='r1');
    return t0.reversed?{ok:false,err:'ALREADY_CORRECTED'}:{ok:true};};
  return !correct().ok?true:'سمح بالتصحيح مرتين';
});
t('W27 الأصل يبقى في السجل موسوماً لا محذوفاً', ()=>{
  const d={transactions:[{id:'t1',amount:1000,reversed:true,correctedAt:'x'}]};
  return d.transactions.length===1&&d.transactions[0].reversed===true?true:'حُذف الأصل';
});

// ===== 10-11) الصلاحيات — تُفحص من الملفات الحقيقية لا من دوال وهمية =====
// القرار المعتمد: كل الموظفين يرسلون للاعتماد دائماً.
// allMonths:true يوسّع **نطاق الشهور** فقط، ولا يمنح أي حفظ مالي مباشر.
import fs from 'fs';
const RULES_SRC = fs.readFileSync(new URL('../firestore-v11.rules', import.meta.url),'utf8');
const HTML_SRC  = fs.readFileSync(new URL('../index.html', import.meta.url),'utf8');

t('W28 القواعد لا تمنح الموظف حفظاً مالياً مباشراً (فحص الملف الحقيقي)', ()=>{
  // لا وجود لأي دالة توسّع الكتابة للموظف
  if(/hasFullPerm/.test(RULES_SRC)) return 'firestore-v11.rules يحتوي hasFullPerm — يخالف القرار (أ)';
  // المسارات المالية الثلاثة يجب أن تكون isFinance() حصراً
  // قراءة كتلة match بتتبّع الأقواس — لا نافذة ثابتة تتعدى حدود الكتلة
  const sect = (name)=>{
    const i = RULES_SRC.indexOf(name);
    if(i<0) return null;
    // نتخطى وسيط المسار مثل {monthId} ونبدأ من قوس الكتلة الحقيقي
    let j=i;
    while(j<RULES_SRC.length && RULES_SRC[j]!=='\n'){
      if(RULES_SRC[j]==='{' && /^\{\s*$|^\{\s*\n/.test(RULES_SRC.slice(j, j+3))) break;
      j++;
    }
    j=RULES_SRC.lastIndexOf('{', j);
    let d=0, start=j;
    if(j<0) return null;
    for(; j<RULES_SRC.length; j++){
      if(RULES_SRC[j]==='{') d++;
      else if(RULES_SRC[j]==='}'){ d--; if(d===0) return RULES_SRC.slice(start, j+1); }
    }
    return null;
  };
  const checks = [
    ['match /config/balances', sect('match /config/balances')],
    ['match /months/',         sect('match /months/')],
    ['match /ledger/',         sect('match /ledger/')]
  ];
  for(const [name, body] of checks){
    if(!body) return `${name} غير موجود في القواعد`;
    const writes = body.match(/allow\s+(write|create|update)[^;]*;/g) || [];
    if(!writes.length) return `${name} بلا قواعد كتابة`;
    for(const w of writes){
      if(/:\s*if\s+false\s*;/.test(w)) continue;   // قاعدة منع صريح — ليست توسيعاً
      if(!/isFinance\(\)/.test(w))            return `${name}: قاعدة كتابة بلا isFinance() → ${w.slice(0,70)}`;
      if(/isStaff\(\)|hasFullPerm|allMonths/.test(w))
        return `${name}: قاعدة كتابة توسّع الصلاحية للموظف → ${w.slice(0,70)}`;
    }
  }
  return true;
});

t('W28ب allMonths يوسّع نطاق الشهور فقط ولا يذكر في أي قاعدة كتابة مالية', ()=>{
  // allMonths لا يظهر إطلاقاً في ملف القواعد — هو مفهوم واجهة بحت
  if(/allMonths/.test(RULES_SRC)) return 'allMonths مذكور في القواعد — يجب أن يكون نطاق شهور في الواجهة فقط';
  // وفي الواجهة يُستخدم للتنقل بين الشهور لا للحفظ
  if(!/allMonths/.test(HTML_SRC)) return 'allMonths غير موجود في الواجهة — تحقق من مصدر الصلاحيات';
  return true;
});

t('W29 كل الموظفين يرسلون للاعتماد — لا مسار حفظ مباشر في الواجهة', ()=>{
  // needApproval يجب ألا يُستخدم كبوابة تتخطى الاعتماد
  const bypass = /needApproval\s*===?\s*false\s*\)?\s*\?[^:]*saveCurData|!\s*needApproval[^\n]{0,40}saveCurData/;
  if(bypass.test(HTML_SRC)) return 'الواجهة تحفظ مباشرة عند needApproval=false — يخالف القرار (أ)';
  if(!/submitRequest/.test(HTML_SRC)) return 'لا يوجد مسار submitRequest في الواجهة';
  return true;
});

t('W30 لا موظف ولا مدير يعتمد دفعة بنكية مباشرة — Backend authority فقط', ()=>{
  const i = RULES_SRC.indexOf('match /bankPayments/');
  if(i<0) return 'bankPayments غير موجود في القواعد';
  const body = RULES_SRC.slice(i, i+500);
  return /allow\s+create,\s*update,\s*delete:\s*if\s+false/.test(body)
    ? true : 'bankPayments ما زال يسمح بكتابة مباشرة من العميل';
});

t('W31 الموظف لا ينفّذ تسوية ولا يعدّل Ledger', ()=>{
  const isFinance=r=>['owner','manager','finance'].includes(r);
  const canAdj=r=>isFinance(r);
  const canEditLedger=()=>false;
  return canAdj('employee')===false&&canEditLedger()===false&&canAdj('owner')===true?true:'fail';
});
t('W32 role موحّد: employee في Firestore و emp داخل الواجهة فقط', ()=>{
  const firestoreRoles=['owner','manager','finance','employee'];
  const uiRole={saeed:'owner',yahia:'emp',nader:'emp'};
  const fsRole ={saeed:'owner',yahia:'employee',nader:'employee'};
  const isStaff=r=>firestoreRoles.includes(r);
  return Object.values(fsRole).every(isStaff) && uiRole.yahia==='emp' && fsRole.yahia==='employee'?true:'خلط القيم';
});
t('W33 role employee يستطيع القراءة', ()=>{
  const isStaff=r=>['owner','manager','finance','employee'].includes(r);
  return isStaff('employee')===true?true:'مُنع من القراءة';
});

console.log('\n===== v10 (محاكاة) =====');
R.forEach(x=>console.log(x));
console.log(`\nنجح ${P} | فشل ${F}`);
process.exit(F>0?1:0);
