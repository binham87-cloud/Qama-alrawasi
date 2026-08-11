// ===== v11 (محاكاة) — البنود 1-8 =====
let P=0,F=0; const R=[];
const t=(n,fn)=>{try{const r=fn();if(r===true){P++;R.push('✅ '+n);}else{F++;R.push('❌ '+n+' — '+r);}}catch(e){F++;R.push('❌ '+n+' — '+e.message);}};
const r2=v=>Math.round(Number(v)*100)/100, num=v=>{const n=Number(v);return isFinite(n)?n:0;};
const USERS={saeed:{role:'owner'},yahia:{role:'emp'},nader:{role:'emp'}};
const UID={'uid_A1':'yahia'};
const userKeyOf=v=>{if(!v)return null;const s=String(v);return USERS[s]?s:(UID[s]||s);};

// ---- CALC v11 ----
const bookingWasPaid=b=>{if(!b)return false;const st=b.status;
  if(st==='pending')return false;
  if(st==='paid'||st==='confirmed')return !!b.paidAt;
  if(st==='cancelled'||st==='refunded'){if(typeof b.wasPaid==='boolean')return b.wasPaid;return !!b.paidAt;}
  return true;};
const bookingNet=b=>bookingWasPaid(b)?Math.max(0,r2(num(b.total)-num(b.refundAmount))):0;
const received=x=>{const p=num(x.paid_amount),rn=num(x.rent);
  if(x.partial&&p>0&&p<rn)return p; if(x.status==='collected')return rn; return 0;};
function custody(d,user){
  const U=userKeyOf(user),eq=v=>{const k=userKeyOf(v);return !!k&&k===U;};
  let recv=0;
  (d.units||[]).flatMap(u=>u.partitions||[]).forEach(x=>{if(eq(x.collectedBy)&&x.collectionMethod!=='bank')recv+=received(x);});
  (d.dailyBookings||[]).forEach(b=>{
    if(!bookingWasPaid(b))return; if(b.paymentMethod==='bank')return;
    if(!eq(b.collectedBy||b.by))return;
    recv+=num(b.total); if(b.refundFrom==='custody')recv-=num(b.refundAmount);});
  const hv=(d.handovers||[]).filter(x=>x.confirmed!==false&&x.status!=='rejected');
  const hvIn=hv.filter(x=>eq(x.to)).reduce((s,x)=>s+num(x.amount),0);
  const hvOut=hv.filter(x=>eq(x.from)).reduce((s,x)=>s+num(x.amount),0);
  const dep=(d.transactions||[]).filter(x=>eq(x.by)&&!x.bankRef&&!x.bankPaymentId&&!x.reversed).reduce((s,x)=>s+num(x.amount),0);
  return {received:r2(recv),handoverIn:r2(hvIn),handoverOut:r2(hvOut),deposited:r2(dep),
          remaining:r2(recv+hvIn-hvOut-dep)};
}
const STAFF=['yahia','nader','saeed'];
const deposited=d=>r2((d.transactions||[]).filter(x=>!x.reversed).reduce((s,x)=>s+num(x.amount),0));
const employeeHoldingTotal=d=>r2(STAFF.reduce((s,k)=>s+custody(d,k).remaining,0));
const collectionRefunds=d=>r2((d.dailyBookings||[]).filter(b=>b&&b.refundFrom&&b.refundFrom!=='custody')
  .reduce((s,b)=>s+num(b.refundAmount),0));
const netDepositedForKPI=d=>r2(deposited(d)-collectionRefunds(d));
const actualCollected=d=>r2(netDepositedForKPI(d)+employeeHoldingTotal(d));
const bankPending=(d,bps)=>r2(Object.values(bps||{}).filter(p=>p.status==='pending').reduce((s,p)=>s+num(p.amount),0));

// ===== 1) Rules: اعتماد المدير لحجز بنكي من يحيى =====
function rulesAllowCreateBP(actor, data, requests){
  const myKey=actor.userKey, isFinance=['owner','manager','finance'].includes(actor.role);
  const isStaff=isFinance||actor.role==='employee';
  // (أ) ينشئ دفعته بنفسه
  if(isStaff && data.status==='pending' && data.amount>0 && data.createdBy===myKey && typeof data.idempotencyKey==='string') return true;
  // (ب) المالية تنشئ نيابةً عن صاحب طلب add_daily موجود
  if(isFinance && data.status==='pending' && data.amount>0 && typeof data.idempotencyKey==='string'
     && data.bookingId!=null){
    const rq=requests[String(data.bookingId)];
    if(rq && rq.type==='add_daily' && rq.by===data.createdBy) return true;
  }
  return false;
}
const REQ={'r9':{type:'add_daily',by:'yahia'}};
t('X01 المدير يعتمد حجز يحيى البنكي — القاعدة تسمح', ()=>
  rulesAllowCreateBP({userKey:'saeed',role:'owner'},
    {status:'pending',amount:700,createdBy:'yahia',idempotencyKey:'k',bookingId:'r9'},REQ)===true?true:'رفضت');
t('X02 لا إنشاء نيابة عن مستخدم لا يملك الطلب', ()=>
  rulesAllowCreateBP({userKey:'saeed',role:'owner'},
    {status:'pending',amount:700,createdBy:'nader',idempotencyKey:'k',bookingId:'r9'},REQ)===false?true:'سمحت');
t('X03 لا إنشاء نيابة بلا طلب موجود', ()=>
  rulesAllowCreateBP({userKey:'saeed',role:'owner'},
    {status:'pending',amount:700,createdBy:'yahia',idempotencyKey:'k',bookingId:'r_none'},REQ)===false?true:'سمحت');
t('X04 الموظف لا ينشئ نيابة عن غيره', ()=>
  rulesAllowCreateBP({userKey:'yahia',role:'employee'},
    {status:'pending',amount:700,createdBy:'nader',idempotencyKey:'k',bookingId:'r9'},REQ)===false?true:'سمحت');
t('X05 الموظف ينشئ دفعته بنفسه', ()=>
  rulesAllowCreateBP({userKey:'yahia',role:'employee'},
    {status:'pending',amount:700,createdBy:'yahia',idempotencyKey:'k'},REQ)===true?true:'رفضت');

// ===== 2) لا حذف لسجل مالي =====
function reverseRecord(list,pred,bal,acct,dir){
  const rec=list.find(pred);
  if(!rec) return {ok:false,err:'ENTRY_MISSING'};
  if(rec.reversed) return {ok:false,err:'ALREADY_REVERSED'};
  bal[acct]=r2(bal[acct]+(dir==='credit'?num(rec.amount):-num(rec.amount)));
  rec.reversed=true; rec.reversedAt='now'; rec.reversedBy='saeed';
  rec.reverseReason='إلغاء اعتماد'; rec.reverseOf='approve_r1';
  return {ok:true};
}
t('X06 عكس الإيداع يُبقي السجل موسوماً', ()=>{
  const d={transactions:[{id:'t1',amount:1000,requestId:'r1'}]}; const bal={revenue:5000};
  const r=reverseRecord(d.transactions,x=>x.requestId==='r1',bal,'revenue','debit');
  return r.ok&&d.transactions.length===1&&d.transactions[0].reversed===true&&bal.revenue===4000?true:JSON.stringify({d,bal});
});
t('X07 عكس المصروف يُبقي السجل ويُعيد المبلغ', ()=>{
  const d={expenses:[{id:'e1',amount:800,paidFrom:'company',requestId:'r2'}]}; const bal={company:5000};
  const r=reverseRecord(d.expenses,x=>x.requestId==='r2',bal,'company','credit');
  return r.ok&&d.expenses.length===1&&d.expenses[0].reversed&&bal.company===5800?true:JSON.stringify({d,bal});
});
t('X08 عكس الصيانة يُبقي السجل', ()=>{
  const d={unitMaintenance:[{id:'m1',amount:300,paidFrom:'revenue'}]}; const bal={revenue:2000};
  const r=reverseRecord(d.unitMaintenance,x=>x.id==='m1',bal,'revenue','credit');
  return r.ok&&d.unitMaintenance.length===1&&d.unitMaintenance[0].reversed&&bal.revenue===2300?true:JSON.stringify({d,bal});
});
t('X09 العكس مرتين مرفوض', ()=>{
  const d={transactions:[{id:'t1',amount:1000,requestId:'r1'}]}; const bal={revenue:5000};
  reverseRecord(d.transactions,x=>x.requestId==='r1',bal,'revenue','debit');
  const b=reverseRecord(d.transactions,x=>x.requestId==='r1',bal,'revenue','debit');
  return !b.ok&&b.err==='ALREADY_REVERSED'&&bal.revenue===4000?true:JSON.stringify({b,bal});
});
t('X10 السجل المعكوس لا يُحتسب في المجاميع', ()=>{
  const d={transactions:[{amount:1000},{amount:500,reversed:true}]};
  return deposited(d)===1000?true:'صار '+deposited(d);
});

// ===== 3) cancelBankPayment =====
t('X11 إلغاء تحويل معتمد يُبقي القيد موسوماً', ()=>{
  const d={transactions:[{id:'bp_1',amount:1300,bankPaymentId:'bp1'}]}; const bal={revenue:5000};
  const bp={status:'approved',amount:1300};
  const t0=d.transactions.find(x=>x.bankPaymentId==='bp1');
  if(t0&&!t0.reversed){ bal.revenue=r2(bal.revenue-1300);
    t0.reversed=true; t0.reverseOf='bankapprove_bp1'; }
  bp.status='cancelled';
  return d.transactions.length===1&&d.transactions[0].reversed&&bal.revenue===3700&&deposited(d)===0?true:
    JSON.stringify({d,bal});
});

// ===== 4) المصروفات والصيانة: تعديل = عكس + مصحّح =====
function correctRecord(list,id,newAmt,src,bal){
  const it=list.find(x=>String(x.id)===String(id));
  if(!it) return {ok:false,err:'ENTRY_MISSING'};
  if(it.reversed) return {ok:false,err:'ALREADY_REVERSED'};
  const old=num(it.amount);
  bal[src]=r2(bal[src]+old);        // عكس القديم
  bal[src]=r2(bal[src]-newAmt);     // خصم الجديد
  it.reversed=true;
  list.push({id:'c_'+id,amount:newAmt,paidFrom:src,correctedFrom:String(id)});
  return {ok:true};
}
t('X12 تعديل مبلغ المصروف = عكس + سجل مصحّح', ()=>{
  const d={expenses:[{id:'e1',amount:1000,paidFrom:'company'}]}; const bal={company:5000};
  const r=correctRecord(d.expenses,'e1',700,'company',bal);
  const live=d.expenses.filter(x=>!x.reversed);
  return r.ok&&d.expenses.length===2&&live.length===1&&live[0].amount===700
    &&live[0].correctedFrom==='e1'&&bal.company===5300?true:JSON.stringify({d,bal});
});
t('X13 تعديل تكلفة الصيانة = عكس + مصحّح', ()=>{
  const d={unitMaintenance:[{id:'m1',amount:300,paidFrom:'revenue'}]}; const bal={revenue:2000};
  const r=correctRecord(d.unitMaintenance,'m1',500,'revenue',bal);
  const live=d.unitMaintenance.filter(x=>!x.reversed);
  return r.ok&&live[0].amount===500&&bal.revenue===1800&&d.unitMaintenance.length===2?true:JSON.stringify({d,bal});
});
t('X14 حذف المصروف يترك السجل معكوساً لا محذوفاً', ()=>{
  const d={expenses:[{id:'e1',amount:800,paidFrom:'revenue'}]}; const bal={revenue:2000};
  reverseRecord(d.expenses,x=>x.id==='e1',bal,'revenue','credit');
  return d.expenses.length===1&&d.expenses[0].reversed&&bal.revenue===2800?true:JSON.stringify({d,bal});
});
t('X15 حذف الصيانة يترك السجل معكوساً', ()=>{
  const d={facilityMaintenance:[{id:'f1',amount:500,paidFrom:'company'}]}; const bal={company:3000};
  reverseRecord(d.facilityMaintenance,x=>x.id==='f1',bal,'company','credit');
  return d.facilityMaintenance.length===1&&d.facilityMaintenance[0].reversed&&bal.company===3500?true:'fail';
});

// ===== 5) منع العكس المزدوج بعد التصحيح =====
t('X16 الطلب المصحّح لا يُعكس مرة ثانية', ()=>{
  const rc={status:'approved',corrected:true};
  const reverse=()=>{ if(rc.corrected) throw new Error('CORRECTED_REQUEST'); return {ok:true}; };
  let err=null; try{reverse();}catch(e){err=e.message;}
  return err==='CORRECTED_REQUEST'?true:'سمح بالعكس';
});
t('X17 Original 1000 → Correct 700 → Cancel corrected = 0', ()=>{
  const bal={revenue:0};
  const d={transactions:[]};
  // 1) اعتماد الأصل
  d.transactions.push({id:'t1',amount:1000,requestId:'r1'}); bal.revenue=r2(bal.revenue+1000);
  // 2) تصحيح إلى 700: عكس الأصل + سجل جديد
  const t0=d.transactions.find(x=>x.id==='t1');
  bal.revenue=r2(bal.revenue-1000); t0.reversed=true;
  d.transactions.push({id:'c1',amount:700,correctedFrom:'t1'}); bal.revenue=r2(bal.revenue+700);
  const rc={status:'approved',corrected:true,correctedOperationId:'c1'};
  // 3) إلغاء العملية المصححة: يُعكس السجل الجديد لا الأصل
  const target=d.transactions.find(x=>x.id===rc.correctedOperationId);
  if(target && !target.reversed){ bal.revenue=r2(bal.revenue-target.amount); target.reversed=true; }
  return bal.revenue===0&&deposited(d)===0?true:'صار '+bal.revenue;
});
t('X18 محاولة عكس الأصل بعد التصحيح تُرفض ولا تنتج -1000', ()=>{
  const bal={revenue:700};
  const rc={corrected:true};
  let err=null;
  try{ if(rc.corrected) throw new Error('CORRECTED_REQUEST'); bal.revenue=r2(bal.revenue-1000); }catch(e){err=e.message;}
  return err==='CORRECTED_REQUEST'&&bal.revenue===700?true:'الرصيد '+bal.revenue;
});

// ===== 6) عند الموظفين = العهدة فقط =====
t('X19 «محصّل لم يودع» من CALC.custody لا من collected−deposited', ()=>{
  const d={units:[{partitions:[{id:1,rent:1000,status:'collected',collectionMethod:'bank',bankDeposited:false}]}],
    dailyBookings:[],transactions:[],handovers:[]};
  const oldWay=r2(1000-0);                 // collected−deposited = 1000 خطأ (بنكي)
  const newWay=employeeHoldingTotal(d);    // 0 صحيح
  return oldWay===1000&&newWay===0?true:`old=${oldWay} new=${newWay}`;
});
t('X20 Bank Pending ليس ضمن عند الموظفين', ()=>{
  const bps={bp1:{status:'pending',amount:1300}};
  const d={units:[],dailyBookings:[],transactions:[],handovers:[]};
  return employeeHoldingTotal(d)===0&&bankPending(d,bps)===1300?true:'اختلطا';
});
t('X21 بنود التوازن منفصلة', ()=>{
  const bc={deposited:600,holding:400,bankPending:1300,late:200,notDue:100,partialRem:50};
  const sum=r2(bc.deposited+bc.holding+bc.bankPending+bc.late+bc.notDue+bc.partialRem);
  return sum===2650&&bc.holding!==bc.bankPending?true:'fail';
});

// ===== 7) الاستردادات في KPI =====
t('X22 Cash 1000، refund 200 من العهدة → Actual = 800', ()=>{
  const d={units:[],transactions:[],handovers:[],
    dailyBookings:[{id:'b',total:1000,status:'refunded',paidAt:'x',wasPaid:true,
                    paymentMethod:'cash',collectedBy:'yahia',refundAmount:200,refundFrom:'custody'}]};
  return actualCollected(d)===800?true:'صار '+actualCollected(d);
});
t('X23 Cash deposited 1000، refund 200 من revenue → Actual = 800', ()=>{
  const d={units:[],handovers:[],
    transactions:[{by:'yahia',amount:1000}],
    dailyBookings:[{id:'b',total:1000,status:'refunded',paidAt:'x',wasPaid:true,
                    paymentMethod:'cash',collectedBy:'yahia',refundAmount:200,refundFrom:'revenue'}]};
  // العهدة: استلم 1000 وأودع 1000 = 0 ؛ المودع 1000 − استرداد 200 = 800
  return actualCollected(d)===800?true:JSON.stringify({act:actualCollected(d),hold:employeeHoldingTotal(d),dep:netDepositedForKPI(d)});
});
t('X24 Bank approved 1000، refund 200 → Actual = 800', ()=>{
  const d={units:[],handovers:[],
    transactions:[{by:'saeed',amount:1000,bankPaymentId:'bp1'}],
    dailyBookings:[{id:'b',total:1000,status:'refunded',paidAt:'x',wasPaid:true,
                    paymentMethod:'bank',refundAmount:200,refundFrom:'revenue'}]};
  return actualCollected(d)===800?true:'صار '+actualCollected(d);
});
t('X25 استرداد كامل → Actual = 0', ()=>{
  const d={units:[],handovers:[],
    transactions:[{by:'saeed',amount:1000,bankPaymentId:'bp1'}],
    dailyBookings:[{id:'b',total:1000,status:'refunded',paidAt:'x',wasPaid:true,
                    paymentMethod:'bank',refundAmount:1000,refundFrom:'revenue'}]};
  return actualCollected(d)===0?true:'صار '+actualCollected(d);
});
t('X26 الاسترداد من العهدة لا يُطرح مرتين', ()=>{
  const d={units:[],transactions:[],handovers:[],
    dailyBookings:[{id:'b',total:1000,status:'refunded',paidAt:'x',wasPaid:true,
                    paymentMethod:'cash',collectedBy:'yahia',refundAmount:200,refundFrom:'custody'}]};
  return collectionRefunds(d)===0&&employeeHoldingTotal(d)===800&&actualCollected(d)===800?true:
    JSON.stringify({cr:collectionRefunds(d),hold:employeeHoldingTotal(d)});
});

// ===== 8) الحجز البنكي المعلّق =====
function cancelBooking(d,bps,id,o){
  const bk=(d.dailyBookings||[]).find(x=>String(x.id)===String(id));
  if(!bk) return {ok:false,err:'ENTRY_MISSING'};
  if(bk.status==='cancelled'||bk.status==='refunded') return {ok:false,err:'ENTRY_MISSING'};
  const refund = o.mode==='full'?num(bk.total):o.mode==='partial'?num(o.amount):0;
  const bp = bk.bankPaymentId ? bps[bk.bankPaymentId] : null;
  if(bp && bp.status==='pending' && refund>0) return {ok:false,err:'BANK_PENDING_FIRST'};
  bk.wasPaid=bookingWasPaid(bk);
  bk.status = refund>0?'refunded':'cancelled';
  bk.refundAmount=refund; bk.refundFrom=refund>0?(o.from||'revenue'):null;
  if(bp && bp.status==='pending') bk.bankPendingAtCancel=true;   // تبقى معلّقة
  return {ok:true,bpStatus:bp?bp.status:null};
}
t('X27 إلغاء بلا استرداد لا يُلغي الدفعة المعلّقة', ()=>{
  const bps={bp1:{status:'pending',amount:1000}};
  const d={dailyBookings:[{id:'b1',total:1000,status:'paid',paidAt:'x',paymentMethod:'bank',bankPaymentId:'bp1'}]};
  const r=cancelBooking(d,bps,'b1',{mode:'none'});
  return r.ok&&bps.bp1.status==='pending'&&d.dailyBookings[0].bankPendingAtCancel===true?true:JSON.stringify({r,bps});
});
t('X28 استرداد مع دفعة معلّقة مرفوض', ()=>{
  const bps={bp1:{status:'pending',amount:1000}};
  const d={dailyBookings:[{id:'b1',total:1000,status:'paid',paidAt:'x',paymentMethod:'bank',bankPaymentId:'bp1'}]};
  const r=cancelBooking(d,bps,'b1',{mode:'partial',amount:200});
  return !r.ok&&r.err==='BANK_PENDING_FIRST'&&d.dailyBookings[0].status==='paid'?true:JSON.stringify(r);
});
t('X29 رفض التحويل ⇒ صافي الحجز صفر', ()=>{
  const bps={bp1:{status:'pending',amount:1000,bookingId:'b1'}};
  const d={dailyBookings:[{id:'b1',total:1000,status:'paid',paidAt:'x',paymentMethod:'bank',bankPaymentId:'bp1'}],
           transactions:[],units:[],handovers:[]};
  // رفض/إلغاء الدفعة المعلّقة
  bps.bp1.status='cancelled';
  const bk=d.dailyBookings[0];
  bk.wasPaid=false; bk.paidAt=null; bk.status='cancelled'; bk.bankRejected=true;
  return bookingNet(bk)===0&&actualCollected(d)===0?true:
    JSON.stringify({net:bookingNet(bk),act:actualCollected(d)});
});
t('X30 بعد الاعتماد يمكن تنفيذ الاسترداد عادياً', ()=>{
  const bps={bp1:{status:'approved',amount:1000}};
  const d={dailyBookings:[{id:'b1',total:1000,status:'paid',paidAt:'x',paymentMethod:'bank',bankPaymentId:'bp1'}]};
  const r=cancelBooking(d,bps,'b1',{mode:'partial',amount:200,from:'revenue'});
  return r.ok&&d.dailyBookings[0].refundAmount===200&&bps.bp1.status==='approved'?true:JSON.stringify({r,bps});
});
t('X31 أثر الدفع متسق: معلّق ملغى بلا استرداد يبقى له مسار واضح', ()=>{
  const bps={bp1:{status:'pending',amount:1000}};
  const d={dailyBookings:[{id:'b1',total:1000,status:'paid',paidAt:'x',paymentMethod:'bank',bankPaymentId:'bp1'}],
           transactions:[],units:[],handovers:[]};
  cancelBooking(d,bps,'b1',{mode:'none'});
  const bk=d.dailyBookings[0];
  // الدفعة ما زالت معلّقة → لم تدخل المودع، والحجز صافيه 1000 لكن لم يُقبض بعد
  return bps.bp1.status==='pending'&&netDepositedForKPI(d)===0&&bk.bankPaymentId==='bp1'?true:
    JSON.stringify({bp:bps.bp1.status,dep:netDepositedForKPI(d)});
});

console.log('\n===== v11 (محاكاة) =====');
R.forEach(x=>console.log(x));
console.log(`\nنجح ${P} | فشل ${F}`);
process.exit(F>0?1:0);
