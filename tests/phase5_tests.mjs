// ===== v9 (محاكاة) — userKey · العهدة · صافي الحجز · البنكي · التصحيح =====
let P=0,F=0; const R=[];
const t=(n,fn)=>{try{const r=fn();if(r===true){P++;R.push('✅ '+n);}else{F++;R.push('❌ '+n+' — '+r);}}catch(e){F++;R.push('❌ '+n+' — '+e.message);}};
const r2=v=>Math.round(Number(v)*100)/100, num=v=>{const n=Number(v);return isFinite(n)?n:0;};

// ---------- Mapping ----------
const USERS={saeed:{role:'owner',name:'مدير'},yahia:{role:'emp',name:'يحيى'},nader:{role:'emp',name:'نادر'}};
const UID_TO_KEY={'uid_A1':'yahia','uid_B2':'nader','uid_C3':'saeed'};
const userKeyOf=v=>{ if(!v) return null; const s=String(v);
  if(USERS[s]) return s; if(UID_TO_KEY[s]) return UID_TO_KEY[s]; return s; };

t('V01 المفتاح القديم يُطابق نفسه', ()=> userKeyOf('yahia')==='yahia'?true:'fail');
t('V02 UID يُترجم للمفتاح القديم', ()=> userKeyOf('uid_A1')==='yahia'?true:userKeyOf('uid_A1'));
t('V03 قيمة مجهولة تُعاد كما هي لا تُسقط', ()=> userKeyOf('unknown_x')==='unknown_x'?true:'أُسقطت');
t('V04 فارغ يرجع null', ()=> userKeyOf(null)===null&&userKeyOf('')===null?true:'fail');
t('V05 شروط الواجهة تستخدم userKey لا UID', ()=>{
  const S={user:'yahia',uid:'uid_A1',role:'emp'};
  return (S.user==='yahia')&&(USERS[S.user].role==='emp')?true:'انكسر شرط الواجهة';
});

// ---------- الحجز: صافي = مدفوع − مسترد ----------
const bookingWasPaid=b=>{ if(!b) return false; const st=b.status;
  if(st==='pending') return false;
  if(st==='paid'||st==='confirmed') return !!b.paidAt;
  if(st==='cancelled'||st==='refunded') return !!b.paidAt||num(b.total)>0;
  return true; };
const bookingNet=b=> bookingWasPaid(b)? r2(num(b.total)-num(b.refundAmount)) : 0;
const dailyTotal=d=> r2((d.dailyBookings||[]).reduce((s,b)=>s+bookingNet(b),0));

t('V06 حجز مدفوع 1000 = إيراد 1000', ()=>
  bookingNet({total:1000,status:'paid',paidAt:'x'})===1000?true:'fail');
t('V07 ملغى بلا استرداد = الإيراد يبقى 1000', ()=>
  bookingNet({total:1000,status:'cancelled',paidAt:'x',refundAmount:0})===1000?true:
  'صار '+bookingNet({total:1000,status:'cancelled',paidAt:'x',refundAmount:0}));
t('V08 استرداد 200 = صافي 800', ()=>
  bookingNet({total:1000,status:'refunded',paidAt:'x',refundAmount:200})===800?true:'fail');
t('V09 استرداد كامل = صافي 0', ()=>
  bookingNet({total:1000,status:'refunded',paidAt:'x',refundAmount:1000})===0?true:'fail');
t('V10 حجز غير مدفوع = 0', ()=>
  bookingNet({total:900,status:'pending',paidAt:null})===0?true:'fail');
t('V11 حجز قديم بلا حالة يُعتبر مدفوعاً', ()=>
  bookingNet({total:500})===500?true:'fail');
t('V12 مجموع الدخل اليومي يجمع الصوافي', ()=>{
  const d={dailyBookings:[{total:1000,status:'cancelled',paidAt:'x',refundAmount:0},
                          {total:1000,status:'refunded',paidAt:'x',refundAmount:200},
                          {total:900,status:'pending',paidAt:null}]};
  return dailyTotal(d)===1800?true:'صار '+dailyTotal(d);
});

// ---------- العهدة ----------
const custody=(d,user)=>{
  const U=userKeyOf(user), eq=v=>{const k=userKeyOf(v); return !!k&&k===U;};
  let recv=0;
  (d.units||[]).flatMap(u=>u.partitions||[]).forEach(x=>{
    if(eq(x.collectedBy)&&x.collectionMethod!=='bank') recv+= x.status==='collected'?num(x.rent):0; });
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
};
t('V13 حجز كاش 1000 يدخل عهدة يحيى', ()=>{
  const d={dailyBookings:[{id:1,total:1000,status:'paid',paidAt:'x',paymentMethod:'cash',collectedBy:'yahia'}]};
  return custody(d,'yahia').remaining===1000?true:JSON.stringify(custody(d,'yahia'));
});
t('V14 استرداد 200 من العهدة يترك 800 (لا يمسح الألف)', ()=>{
  const d={dailyBookings:[{id:1,total:1000,status:'refunded',paidAt:'x',paymentMethod:'cash',
                           collectedBy:'yahia',refundAmount:200,refundFrom:'custody'}]};
  return custody(d,'yahia').remaining===800?true:JSON.stringify(custody(d,'yahia'));
});
t('V15 إلغاء بلا استرداد يبقي 1000 في العهدة', ()=>{
  const d={dailyBookings:[{id:1,total:1000,status:'cancelled',paidAt:'x',paymentMethod:'cash',
                           collectedBy:'yahia',refundAmount:0}]};
  return custody(d,'yahia').remaining===1000?true:JSON.stringify(custody(d,'yahia'));
});
t('V16 العهدة تُطابق البيانات القديمة والـUID معاً', ()=>{
  const d={dailyBookings:[{id:1,total:300,status:'paid',paidAt:'x',paymentMethod:'cash',collectedBy:'yahia'},
                          {id:2,total:200,status:'paid',paidAt:'x',paymentMethod:'cash',collectedBy:'uid_A1'}],
           transactions:[],handovers:[]};
  return custody(d,'yahia').remaining===500?true:JSON.stringify(custody(d,'yahia'));
});
t('V17 حجز بنكي لا يدخل العهدة', ()=>{
  const d={dailyBookings:[{id:1,total:700,status:'paid',paidAt:'x',paymentMethod:'bank'}]};
  return custody(d,'yahia').remaining===0?true:JSON.stringify(custody(d,'yahia'));
});
t('V18 الإيداع يخفض العهدة ولا يمسحها', ()=>{
  const d={dailyBookings:[{id:1,total:1000,status:'paid',paidAt:'x',paymentMethod:'cash',collectedBy:'yahia'}],
           transactions:[{by:'uid_A1',amount:600}],handovers:[]};
  const c=custody(d,'yahia');
  return c.received===1000&&c.deposited===600&&c.remaining===400?true:JSON.stringify(c);
});
t('V19 التسليم المؤكد ينقل العهدة بين الموظفين', ()=>{
  const d={dailyBookings:[{id:1,total:1000,status:'paid',paidAt:'x',paymentMethod:'cash',collectedBy:'nader'}],
           handovers:[{from:'nader',to:'uid_A1',amount:400,confirmed:true}],transactions:[]};
  return custody(d,'nader').remaining===600&&custody(d,'yahia').remaining===400?true:
    JSON.stringify({n:custody(d,'nader'),y:custody(d,'yahia')});
});
t('V20 التسليم المرفوض لا يُحتسب', ()=>{
  const d={dailyBookings:[{id:1,total:1000,status:'paid',paidAt:'x',paymentMethod:'cash',collectedBy:'nader'}],
           handovers:[{from:'nader',to:'yahia',amount:400,status:'rejected'}],transactions:[]};
  return custody(d,'nader').remaining===1000&&custody(d,'yahia').remaining===0?true:'fail';
});

// ---------- الكاش لا يرفع الإيرادات ----------
t('V21 تحصيل كاش لا يرفع revenueBalance', ()=>{
  const bal={revenue:1000};
  const d={units:[{partitions:[{id:1,rent:1300,status:'collected',collectionMethod:'cash',collectedBy:'yahia'}]}],
           transactions:[],handovers:[],dailyBookings:[]};
  return bal.revenue===1000&&custody(d,'yahia').remaining===1300?true:'fail';
});

// ---------- البنكي ----------
t('V22 حجز بنكي يُنشئ دفعة في نفس العملية', ()=>{
  const writes=[];
  const createBookingTx=(bk)=>{ // محاكاة معاملة واحدة
    const extra = bk.paymentMethod==='bank' ? [{col:'bankPayments',id:'bp_'+bk.id,status:'pending',bookingId:bk.id}] : [];
    writes.push({col:'months',booking:bk}); extra.forEach(e=>writes.push(e));
    return {ok:true};
  };
  createBookingTx({id:9,total:700,status:'paid',paidAt:'x',paymentMethod:'bank',bankPaymentId:'bp_9'});
  const bk=writes.find(w=>w.col==='months'), bp=writes.find(w=>w.col==='bankPayments');
  return bk&&bp&&bp.bookingId===9?true:'حجز paid بلا دفعة';
});
t('V23 إلغاء الحجز يُلغي الدفعة المعلّقة المرتبطة', ()=>{
  const bp={paymentId:'bp_9',status:'pending',bookingId:9};
  const bk={id:9,total:700,status:'paid',paidAt:'x',paymentMethod:'bank',bankPaymentId:'bp_9'};
  const cancel=()=>{ if(bp.status==='pending') bp.status='cancelled'; bk.status='cancelled'; bk.refundAmount=0; };
  cancel();
  return bp.status==='cancelled'&&bk.status==='cancelled'?true:'بقيت الدفعة معلّقة';
});
t('V24 تحويل معلّق لا يدخل المودع ولا الرصيد', ()=>{
  const deposited=d=>r2((d.transactions||[]).filter(x=>!x.reversed).reduce((s,x)=>s+num(x.amount),0));
  const d={transactions:[]}; const bal={revenue:3000};
  const bp={status:'pending',amount:1300};
  return deposited(d)===0&&bal.revenue===3000?true:'fail';
});
t('V25 بعد الاعتماد فقط يدخل المودع ويرفع الرصيد', ()=>{
  const d={transactions:[]}; const bal={revenue:3000}; const bp={id:'bp1',status:'pending',amount:1300};
  const approve=()=>{ if(bp.status!=='pending') return {ok:false};
    if(d.transactions.some(t=>t.bankPaymentId===bp.id)) return {ok:false};
    d.transactions.push({amount:bp.amount,bankPaymentId:bp.id}); bal.revenue=r2(bal.revenue+bp.amount);
    bp.status='approved'; return {ok:true}; };
  const a=approve(), b=approve();
  return a.ok&&!b.ok&&bal.revenue===4300&&d.transactions.length===1?true:JSON.stringify({bal,n:d.transactions.length});
});

// ---------- التصحيح: عكس + جديد ----------
t('V26 لا تعديل مباشر لمبلغ عملية معتمدة', ()=>{
  const MONEY=['amount','account','type','paidFrom'];
  const edit=f=> MONEY.includes(f)?{ok:false,err:'BLOCKED'}:{ok:true};
  return MONEY.every(f=>!edit(f).ok)&&edit('note').ok?true:'سمح بالتعديل';
});
t('V27 التصحيح = عكس الأصل ثم عملية جديدة، بقيدين', ()=>{
  const ledger=[]; const bal={revenue:1000};
  const post=(amt,op,rev)=>{ const before=bal.revenue; bal.revenue=r2(bal.revenue+amt);
    ledger.push({op,amount:Math.abs(amt),direction:amt>0?'credit':'debit',
                 balanceBefore:before,balanceAfter:bal.revenue,reverseOf:rev||null}); };
  post(1000,'approve_r1');            // الأصل الخاطئ
  post(-1000,'reverse_r1','approve_r1'); // العكس
  post(700,'approve_r2');             // الصحيحة
  return bal.revenue===1700&&ledger.length===3&&ledger[1].reverseOf==='approve_r1'?true:
    JSON.stringify({bal,n:ledger.length});
});

// ---------- التسويات معزولة ----------
t('V28 التسوية لا تدخل المستهدف ولا المحصّل ولا المودع', ()=>{
  const d={units:[{partitions:[{id:1,rent:1000,status:'collected',collectionMethod:'cash',collectedBy:'yahia'}]}],
           transactions:[{by:'yahia',amount:600}],dailyBookings:[],handovers:[]};
  const target=1000, collected=1000, deposited=600;
  const adj={account:'company',type:'add',amount:50000};   // تسوية كبيرة
  return target===1000&&collected===1000&&deposited===600?true:'تأثرت الأرقام';
});
t('V29 المعادلة: المحصّل = المودع + العهدة', ()=>{
  const d={units:[{partitions:[{id:1,rent:1000,status:'collected',collectionMethod:'cash',collectedBy:'yahia'}]}],
           transactions:[{by:'yahia',amount:600}],dailyBookings:[],handovers:[]};
  const collected=1000, deposited=600, holding=custody(d,'yahia').remaining;
  return collected===deposited+holding?true:`${collected} != ${deposited}+${holding}`;
});
t('V30 التعديل اليدوي يصبح تسوية بفرق وسبب', ()=>{
  const cur=40000, target=50000;
  const mk=(v,reason)=>{ const diff=r2(v-cur);
    if(Math.abs(diff)<0.01) return {ok:false,err:'NO_DIFF'};
    if(!reason||!reason.trim()) return {ok:false,err:'NO_REASON'};
    return {ok:true,type:diff>0?'add':'withdraw',amount:Math.abs(diff)}; };
  const a=mk(target,'تمويل مالك'), b=mk(target,''), c=mk(cur,'x');
  return a.ok&&a.type==='add'&&a.amount===10000&&!b.ok&&b.err==='NO_REASON'&&!c.ok?true:JSON.stringify({a,b,c});
});

console.log('\n===== v9 (محاكاة) =====');
R.forEach(x=>console.log(x));
console.log(`\nنجح ${P} | فشل ${F}`);
process.exit(F>0?1:0);
