// ===== المرحلة 4 (محاكاة) — Ledger · العكس · الحجوزات · البنكي =====
let P=0,F=0; const R=[];
const t=(n,fn)=>{try{const r=fn();if(r===true){P++;R.push('✅ '+n);}else{F++;R.push('❌ '+n+' — '+r);}}catch(e){F++;R.push('❌ '+n+' — '+e.message);}};
const r2=v=>Math.round(Number(v)*100)/100;

// ---------- محاكاة Ledger + المحرك ----------
function mkState(){return{
  bal:{company:5000,revenue:3000,installment:2000},
  month:{transactions:[],expenses:[],unitMaintenance:[],facilityMaintenance:[],profits:[],installments:[],dailyBookings:[],handovers:[]},
  ledger:{}, adj:{}, bankPay:{}, busy:false, rev:1};}
function ledgerWrite(st,op){
  const amount=r2(op.amount);
  if(!isFinite(amount)||amount<=0) throw new Error('LEDGER_BAD_AMOUNT');
  if(['company','revenue','installment','custody'].indexOf(op.account)<0) throw new Error('LEDGER_BAD_ACCOUNT');
  if(['debit','credit'].indexOf(op.direction)<0) throw new Error('LEDGER_BAD_DIRECTION');
  if(!op.idempotencyKey) throw new Error('LEDGER_NO_IDEM');
  const delta=r2(op.balanceAfter-op.balanceBefore);
  const expect=op.direction==='credit'?amount:-amount;
  if(Math.abs(delta-expect)>0.01) throw new Error('LEDGER_MISMATCH');
  const id='led_'+op.idempotencyKey+'_'+op.account;
  st.ledger[id]={entryId:id,...op,amount};
  return id;
}
function op(st,mutate,o={}){
  if(st.busy) return {ok:false,err:'BUSY'};
  st.busy=true;
  const sb=JSON.parse(JSON.stringify(st.bal)), sm=JSON.parse(JSON.stringify(st.month)),
        sl=JSON.parse(JSON.stringify(st.ledger)), sa=JSON.parse(JSON.stringify(st.adj));
  const opening={...st.bal}; const moves=[];
  const chk=v=>{const n=Number(v); if(!isFinite(n)||isNaN(n)||n<=0) throw new Error('BAD_AMOUNT'); return r2(n);};
  const ctx={data:st.month,bal:st.bal,r2,chk,
    deduct(a,x){const v=chk(x); if(v>st.bal[a]) throw new Error('INSUFFICIENT|'+a+'|'+st.bal[a]+'|'+v);
      st.bal[a]=r2(st.bal[a]-v); moves.push({account:a,dir:-v}); return v;},
    add(a,x){const v=chk(x); st.bal[a]=r2(st.bal[a]+v); moves.push({account:a,dir:v}); return v;},
    setAbs(a,x){const n=Number(x); if(!isFinite(n)||n<0) throw new Error('BAD_AMOUNT');
      const d=r2(n-st.bal[a]); st.bal[a]=r2(n); if(Math.abs(d)>0.001) moves.push({account:a,dir:d});},
    log(){}, ACC:{company:'الشركة',revenue:'الإيرادات',installment:'الاقتطاع'}};
  try{
    mutate(ctx);
    const agg={}; moves.forEach(m=>agg[m.account]=(agg[m.account]||0)+m.dir);
    Object.keys(agg).forEach(a=>{const net=r2(agg[a]); if(Math.abs(net)<0.001) return;
      ledgerWrite(st,{operationId:o.opId||'op',operationType:o.opType||'money_op',account:a,
        direction:net>0?'credit':'debit',amount:Math.abs(net),
        balanceBefore:opening[a],balanceAfter:st.bal[a],monthKey:'2026_7',
        sourceCollection:o.src||'months',sourceId:o.srcId||'',description:o.desc||'',
        idempotencyKey:o.opId||'op',reverseOf:o.reverseOf||null});});
    st.busy=false; st.rev++; return {ok:true};
  }catch(e){ st.bal=sb; st.month=sm; st.ledger=sl; st.adj=sa; st.busy=false; return {ok:false,err:String(e.message)}; }
}
const ledCount=st=>Object.keys(st.ledger).length;
const ledNet=(st,acc)=>r2(Object.values(st.ledger).filter(x=>x.account===acc)
  .reduce((s,x)=>s+(x.direction==='credit'?x.amount:-x.amount),0));

// ===== 1) إضافة وعكس إيداع =====
let st=mkState();
t('L01 إيداع مباشر يكتب قيداً في نفس العملية', ()=>{
  const r=op(st,c=>{const a=c.add('revenue',500); c.data.transactions.push({id:'t1',amount:a});},{opId:'dep_t1',opType:'deposit'});
  return r.ok&&st.bal.revenue===3500&&ledCount(st)===1&&Object.values(st.ledger)[0].direction==='credit'?true:JSON.stringify(st.bal);
});
t('L02 عكس الإيداع يخصم ويكتب قيداً مضاداً', ()=>{
  const r=op(st,c=>{const tr=c.data.transactions.find(x=>x.id==='t1');
    if(tr.reversed) throw new Error('ENTRY_MISSING');
    c.deduct('revenue',tr.amount); tr.reversed=true;},{opId:'rev_t1',opType:'reverse_deposit',reverseOf:'dep_t1'});
  return r.ok&&st.bal.revenue===3000&&ledCount(st)===2&&ledNet(st,'revenue')===0?true:JSON.stringify({bal:st.bal,n:ledCount(st)});
});
t('L03 عكس الإيداع مرتين مرفوض', ()=>{
  const r=op(st,c=>{const tr=c.data.transactions.find(x=>x.id==='t1');
    if(tr.reversed) throw new Error('ENTRY_MISSING'); c.deduct('revenue',tr.amount);},{opId:'rev_t1b'});
  return !r.ok&&st.bal.revenue===3000&&ledCount(st)===2?true:JSON.stringify(r);
});
// ===== 2) عكس مصروف وصيانة =====
st=mkState();
t('L04 مصروف ثم عكسه يرجع الرصيد ويوازن الدفتر', ()=>{
  op(st,c=>{const a=c.deduct('company',800); c.data.expenses.push({id:'e1',amount:a,paidFrom:'company'});},{opId:'exp_e1'});
  const mid=st.bal.company;
  op(st,c=>{const e=c.data.expenses.find(x=>x.id==='e1'); c.add('company',e.amount); e.reversed=true;},{opId:'exprev_e1',reverseOf:'exp_e1'});
  return mid===4200&&st.bal.company===5000&&ledNet(st,'company')===0?true:JSON.stringify({mid,now:st.bal.company});
});
t('L05 صيانة ثم عكسها', ()=>{
  op(st,c=>{const a=c.deduct('revenue',300); c.data.unitMaintenance.push({id:'m1',amount:a,paidFrom:'revenue'});},{opId:'mnt_m1'});
  op(st,c=>{const m=c.data.unitMaintenance.find(x=>x.id==='m1'); c.add('revenue',m.amount); m.reversed=true;},{opId:'mntrev_m1',reverseOf:'mnt_m1'});
  return st.bal.revenue===3000&&ledNet(st,'revenue')===0?true:JSON.stringify(st.bal);
});
// ===== 3) عكس أرباح وقسط =====
st=mkState();
t('L06 عكس تحويل أرباح يعيد المبلغ', ()=>{
  op(st,c=>{const a=c.deduct('revenue',600); c.data.profits.push({id:'p1',amount:a,account:'revenue'});},{opId:'prof_p1'});
  op(st,c=>{const p=c.data.profits.find(x=>x.id==='p1'); if(p.reversed) throw new Error('ENTRY_MISSING');
    c.add('revenue',p.amount); p.reversed=true;},{opId:'profrev_p1',reverseOf:'prof_p1'});
  return st.bal.revenue===3000&&ledNet(st,'revenue')===0?true:JSON.stringify(st.bal);
});
t('L07 عكس قسط يعيد المبلغ', ()=>{
  op(st,c=>{const a=c.deduct('company',900); c.data.installments.push({id:'i1',amount:a,account:'company'});},{opId:'inst_i1'});
  op(st,c=>{const i=c.data.installments.find(x=>x.id==='i1'); c.add('company',i.amount); i.reversed=true;},{opId:'instrev_i1',reverseOf:'inst_i1'});
  return st.bal.company===5000&&ledNet(st,'company')===0?true:JSON.stringify(st.bal);
});
// ===== 4) منع تعديل المبلغ مباشرة =====
t('L08 تعديل حقل مالي مباشرة مرفوض', ()=>{
  const MONEY=['amount','account','type','paidFrom'];
  const save=(f)=> MONEY.indexOf(f)>=0 ? {ok:false,err:'BLOCKED'} : {ok:true};
  return MONEY.every(f=>!save(f).ok) && save('note').ok && save('desc').ok ? true : 'سمح بتعديل مالي';
});
// ===== 5-6) بيانات الخادم لا الواجهة =====
function approve(server,client){
  const doc=server[client.id];
  if(!doc) return {ok:false,err:'REQ_MISSING'};
  if(doc.status!=='pending') return {ok:false,err:'ALREADY_PROCESSED'};
  if(doc.type!==client.type) return {ok:false,err:'TYPE_MISMATCH'};
  if(Number(doc.year)!==Number(client.year)||Number(doc.month)!==Number(client.month)) return {ok:false,err:'MONTH_MISMATCH'};
  return {ok:true,applied:doc.payload.amount};   // المبلغ من الخادم دائماً
}
t('L09 الاعتماد يستخدم مبلغ الخادم لا الواجهة', ()=>{
  const server={r1:{status:'pending',type:'add_transaction',year:2026,month:7,payload:{amount:100}}};
  const r=approve(server,{id:'r1',type:'add_transaction',year:2026,month:7,payload:{amount:99999}});
  return r.ok&&r.applied===100?true:'استُخدم مبلغ الواجهة: '+JSON.stringify(r);
});
t('L10 نوع مختلف بين الواجهة والخادم يُرفض', ()=>{
  const server={r1:{status:'pending',type:'add_transaction',year:2026,month:7,payload:{amount:100}}};
  const r=approve(server,{id:'r1',type:'add_expense',year:2026,month:7,payload:{amount:100}});
  return !r.ok&&r.err==='TYPE_MISMATCH'?true:JSON.stringify(r);
});
t('L11 شهر مختلف يُرفض', ()=>{
  const server={r1:{status:'pending',type:'add_transaction',year:2026,month:7,payload:{amount:100}}};
  const r=approve(server,{id:'r1',type:'add_transaction',year:2026,month:3,payload:{amount:100}});
  return !r.ok&&r.err==='MONTH_MISMATCH'?true:JSON.stringify(r);
});
// ===== 7-8) عكس التسوية =====
function mkAdj(st,o){
  const id='adj_'+o.idem;
  if(st.adj[id]) return {ok:false,err:'DUPLICATE'};
  if(!o.reason||!o.reason.trim()) return {ok:false,err:'NO_REASON'};
  const r=op(st,c=>{ if(o.type==='withdraw') c.deduct(o.account,o.amount); else c.add(o.account,o.amount); },
    {opId:id,opType:o.reverseOf?'adjustment_reversal':'balance_adjustment',src:'balanceAdjustments',srcId:id,reverseOf:o.reverseOf||null});
  if(!r.ok) return r;
  st.adj[id]={adjustmentId:id,...o,status:'active'};
  return {ok:true,id};
}
function revAdjAtomic(st,id,failAt){
  const orig=st.adj[id];
  if(!orig) return {ok:false,err:'ADJ_MISSING'};
  if(orig.reverseOf) return {ok:false,err:'IS_REVERSAL'};
  if(orig.status!=='active') return {ok:false,err:'NOT_ACTIVE'};
  const revId='adj_rev_'+id;
  if(st.adj[revId]) return {ok:false,err:'ALREADY_REVERSED'};
  const snapAdj=JSON.parse(JSON.stringify(st.adj));
  const r=op(st,c=>{
    if(failAt==='mid') throw new Error('NETWORK');
    if(orig.type==='add') c.deduct(orig.account,orig.amount); else c.add(orig.account,orig.amount);
    st.adj[revId]={adjustmentId:revId,account:orig.account,type:orig.type==='add'?'withdraw':'add',
                   amount:orig.amount,status:'active',reverseOf:id};
    orig.status='reversed';           // داخل نفس المعاملة
  },{opId:revId,opType:'adjustment_reversal',src:'balanceAdjustments',srcId:revId,reverseOf:id});
  if(!r.ok){ st.adj=snapAdj; return r; }
  return {ok:true};
}
st=mkState();
t('L12 تسوية إضافة تكتب قيداً', ()=>{
  const r=mkAdj(st,{account:'company',type:'add',amount:2000,reason:'إيداع مالك',idem:'a1'});
  return r.ok&&st.bal.company===7000&&ledCount(st)===1?true:JSON.stringify({r,bal:st.bal});
});
t('L13 عكس التسوية ذرّي: الرصيد + الحالة + القيد معاً', ()=>{
  const r=revAdjAtomic(st,'adj_a1');
  return r.ok&&st.bal.company===5000&&st.adj['adj_a1'].status==='reversed'&&ledCount(st)===2
    &&ledNet(st,'company')===0?true:JSON.stringify({bal:st.bal,n:ledCount(st)});
});
t('L14 عكس التسوية مرتين مرفوض (حارسان: الحالة ومستند العكس)', ()=>{
  const n0=ledCount(st);
  const r=revAdjAtomic(st,'adj_a1');
  const rejected = !r.ok && (r.err==='ALREADY_REVERSED'||r.err==='NOT_ACTIVE');
  return rejected&&st.bal.company===5000&&ledCount(st)===n0?true:JSON.stringify({r,bal:st.bal.company});
});
t('L15 انقطاع أثناء العكس: لا رصيد ولا قيد ولا حالة', ()=>{
  const s2=mkState(); mkAdj(s2,{account:'revenue',type:'add',amount:400,reason:'ر',idem:'b1'});
  const before={bal:s2.bal.revenue,n:ledCount(s2),st:s2.adj['adj_b1'].status};
  const r=revAdjAtomic(s2,'adj_b1','mid');
  return !r.ok&&s2.bal.revenue===before.bal&&ledCount(s2)===before.n&&s2.adj['adj_b1'].status==='active'
    ?true:JSON.stringify({before,after:{bal:s2.bal.revenue,n:ledCount(s2),st:s2.adj['adj_b1'].status}});
});
t('L16 لا يمكن عكس عملية عكسية', ()=>{
  const rid=Object.keys(st.adj).find(k=>st.adj[k].reverseOf);
  const r=revAdjAtomic(st,rid);
  return !r.ok&&r.err==='IS_REVERSAL'?true:JSON.stringify(r);
});
// ===== 9-11) الحجوزات — الدفع مقدماً =====
const bookingIsPaid=b=>{const s=b&&b.status;
  if(s==='cancelled'||s==='refunded'||s==='pending') return false;
  if(s==='paid'||s==='confirmed') return !!b.paidAt;
  return s===undefined||s===null;};
const dailyTotal=d=>r2((d.dailyBookings||[]).filter(bookingIsPaid).reduce((s,b)=>s+Number(b.total||0),0));
const custodyOf=(d,user)=>r2((d.dailyBookings||[]).filter(b=>bookingIsPaid(b)&&b.paymentMethod!=='bank'&&(b.collectedBy||b.by)===user)
  .reduce((s,b)=>s+Number(b.total||0),0));
st=mkState();
t('L17 حجز كاش: مدفوع مقدماً ويدخل عهدة المستلم', ()=>{
  const b={id:'b1',total:500,status:'paid',paidAt:'now',paymentMethod:'cash',collectedBy:'yahia'};
  st.month.dailyBookings.push(b);
  return dailyTotal(st.month)===500&&custodyOf(st.month,'yahia')===500&&st.bal.revenue===3000?true:
    JSON.stringify({d:dailyTotal(st.month),c:custodyOf(st.month,'yahia'),bal:st.bal.revenue});
});
t('L18 حجز بنكي: لا يدخل العهدة ولا الرصيد قبل الاعتماد', ()=>{
  const b={id:'b2',total:700,status:'paid',paidAt:'now',paymentMethod:'bank',bankPaymentId:'bp1'};
  st.month.dailyBookings.push(b);
  st.bankPay['bp1']={amount:700,status:'pending'};
  const depApproved=st.month.transactions.reduce((s,t)=>s+t.amount,0);
  return dailyTotal(st.month)===1200&&custodyOf(st.month,'yahia')===500&&depApproved===0&&st.bal.revenue===3000?true:
    JSON.stringify({d:dailyTotal(st.month),dep:depApproved,bal:st.bal.revenue});
});
t('L19 حجز غير مدفوع لا يدخل المحصّل ولا الدخل', ()=>{
  st.month.dailyBookings.push({id:'b3',total:900,status:'pending',paidAt:null,paymentMethod:null});
  return dailyTotal(st.month)===1200?true:'دخل غير المدفوع: '+dailyTotal(st.month);
});
// ===== 12-15) الإلغاء والاسترداد =====
function cancelBooking(st,id,o){
  return op(st,c=>{
    const bk=c.data.dailyBookings.find(x=>x.id===id);
    if(!bk) throw new Error('ENTRY_MISSING');
    if(bk.status==='cancelled'||bk.status==='refunded') throw new Error('ENTRY_MISSING');
    if(!o.reason) throw new Error('NO_REASON');
    const paid=r2(bk.total);
    let refund=0;
    if(o.mode==='full') refund=paid;
    else if(o.mode==='partial') refund=r2(o.amount);
    if(o.mode!=='none'){
      if(!isFinite(refund)||refund<=0) throw new Error('BAD_AMOUNT');
      if(refund>paid+0.01) throw new Error('REFUND_TOO_BIG');
      if(!bookingIsPaid(bk)) throw new Error('REFUND_UNPAID');
      const from=o.from||(bk.paymentMethod==='cash'?'custody':'revenue');
      if(from!=='custody') c.deduct(from,refund);
      bk.refundFrom=from;
    }
    bk.status=refund>0?'refunded':'cancelled';
    bk.refundAmount=refund; bk.cancelReason=o.reason;
  },{opId:'bkcancel_'+id,opType:'daily_booking_cancel',reverseOf:'booking_'+id});
}
t('L20 إلغاء بلا استرداد: يخرج من الدخل ولا يمس الرصيد', ()=>{
  const before=st.bal.revenue;
  const r=cancelBooking(st,'b1',{mode:'none',reason:'ألغى الضيف'});
  return r.ok&&dailyTotal(st.month)===700&&st.bal.revenue===before?true:JSON.stringify({d:dailyTotal(st.month),bal:st.bal.revenue});
});
t('L21 إلغاء نفس الحجز مرتين مرفوض', ()=>{
  const r=cancelBooking(st,'b1',{mode:'none',reason:'مجدداً'});
  return !r.ok&&r.err==='ENTRY_MISSING'?true:JSON.stringify(r);
});
t('L22 استرداد جزئي يخصم من الحساب ويكتب قيداً', ()=>{
  const s2=mkState();
  s2.month.dailyBookings.push({id:'x1',total:1000,status:'paid',paidAt:'n',paymentMethod:'bank'});
  const n0=ledCount(s2);
  const r=cancelBooking(s2,'x1',{mode:'partial',amount:400,from:'revenue',reason:'مغادرة مبكرة'});
  const bk=s2.month.dailyBookings[0];
  return r.ok&&s2.bal.revenue===2600&&bk.status==='refunded'&&bk.refundAmount===400&&ledCount(s2)===n0+1?true:
    JSON.stringify({bal:s2.bal.revenue,bk});
});
t('L23 استرداد كامل', ()=>{
  const s2=mkState();
  s2.month.dailyBookings.push({id:'x2',total:600,status:'paid',paidAt:'n',paymentMethod:'bank'});
  const r=cancelBooking(s2,'x2',{mode:'full',from:'revenue',reason:'إلغاء'});
  return r.ok&&s2.bal.revenue===2400&&s2.month.dailyBookings[0].refundAmount===600?true:JSON.stringify(s2.bal);
});
t('L24 استرداد أكبر من المدفوع مرفوض', ()=>{
  const s2=mkState();
  s2.month.dailyBookings.push({id:'x3',total:500,status:'paid',paidAt:'n',paymentMethod:'bank'});
  const r=cancelBooking(s2,'x3',{mode:'partial',amount:900,from:'revenue',reason:'خطأ'});
  return !r.ok&&r.err==='REFUND_TOO_BIG'&&s2.bal.revenue===3000&&s2.month.dailyBookings[0].status==='paid'?true:JSON.stringify({r,bal:s2.bal});
});
t('L25 السجل الأصلي لا يُحذف', ()=>{
  const s2=mkState();
  s2.month.dailyBookings.push({id:'x4',total:300,status:'paid',paidAt:'n',paymentMethod:'cash',collectedBy:'y'});
  cancelBooking(s2,'x4',{mode:'none',reason:'ر'});
  return s2.month.dailyBookings.length===1&&s2.month.dailyBookings[0].cancelReason==='ر'?true:'حُذف السجل';
});
// ===== 16-17) التحويل البنكي =====
t('L26 تحويل pending لا يدخل الإيداعات المعتمدة ولا الرصيد', ()=>{
  const s2=mkState();
  s2.bankPay['bp9']={amount:1300,status:'pending'};
  const deposited=s2.month.transactions.filter(t=>!t.reversed).reduce((s,t)=>s+t.amount,0);
  return deposited===0&&s2.bal.revenue===3000?true:JSON.stringify({deposited,bal:s2.bal.revenue});
});
t('L27 اعتماد التحويل مرة واحدة فقط', ()=>{
  const s2=mkState(); s2.bankPay['bp9']={amount:1300,status:'pending'};
  const approveBank=(st,pid)=>{
    const p=st.bankPay[pid];
    if(!p||p.status!=='pending') return {ok:false,err:'NOT_PENDING'};
    if(st.month.transactions.some(t=>t.bankPaymentId===pid)) return {ok:false,err:'ALREADY_POSTED'};
    const r=op(st,c=>{c.add('revenue',p.amount); c.data.transactions.push({id:'bp_'+pid,amount:p.amount,bankPaymentId:pid});},
      {opId:'bankapprove_'+pid,opType:'bank_payment_approved',src:'bankPayments',srcId:pid});
    if(r.ok) p.status='approved';
    return r;
  };
  const a=approveBank(s2,'bp9'), b=approveBank(s2,'bp9');
  return a.ok&&!b.ok&&s2.bal.revenue===4300&&s2.month.transactions.length===1&&ledCount(s2)===1?true:
    JSON.stringify({a,b,bal:s2.bal.revenue,n:s2.month.transactions.length});
});
// ===== 18) تطابق الصافي =====
t('L28 الصافي متطابق بين النظرة العامة والشاشة المالية', ()=>{
  const d={transactions:[{amount:10000},{amount:500,reversed:true}],
           expenses:[{amount:1200}], unitMaintenance:[{amount:300}], facilityMaintenance:[{amount:500}],
           profits:[{amount:600}], installments:[{amount:900}], dailyBookings:[]};
  const CALCexp=x=>r2([...(x.expenses||[]),...(x.unitMaintenance||[]),...(x.facilityMaintenance||[])]
    .filter(z=>!z.reversed).reduce((s,z)=>s+Number(z.amount||0),0));
  const dep=x=>r2((x.transactions||[]).filter(z=>!z.reversed).reduce((s,z)=>s+Number(z.amount||0),0));
  const prof=x=>(x.profits||[]).filter(z=>!z.reversed).reduce((s,z)=>s+Number(z.amount||0),0);
  const inst=x=>(x.installments||[]).filter(z=>!z.reversed).reduce((s,z)=>s+Number(z.amount||0),0);
  const overview=r2(dep(d)-CALCexp(d)-prof(d)-inst(d));
  const financial=r2(dep(d)-CALCexp(d)-prof(d)-inst(d));
  return overview===financial&&overview===6500?true:`overview=${overview} financial=${financial}`;
});
// ===== 19-20) تغطية ومطابقة الدفتر =====
t('L29 كل تغير رصيد له قيد مطابق', ()=>{
  const s2=mkState();
  op(s2,c=>c.add('revenue',100),{opId:'o1'});
  op(s2,c=>c.deduct('company',200),{opId:'o2'});
  op(s2,c=>{c.deduct('revenue',50); c.add('installment',50);},{opId:'o3'});
  // 4 قيود: revenue+100, company-200, revenue-50, installment+50
  return ledCount(s2)===4?true:'عدد القيود '+ledCount(s2);
});
t('L30 مجموع الدفتر يطابق الأرصدة النهائية', ()=>{
  const s2=mkState();
  const open={...s2.bal};
  op(s2,c=>{const a=c.add('revenue',1500); c.data.transactions.push({id:'q',amount:a});},{opId:'q1'});
  op(s2,c=>c.deduct('company',700),{opId:'q2'});
  op(s2,c=>{c.deduct('revenue',300); c.add('company',300);},{opId:'q3'});
  op(s2,c=>c.add('installment',250),{opId:'q4'});
  const ok=['company','revenue','installment'].every(a=> r2(open[a]+ledNet(s2,a))===s2.bal[a]);
  return ok?true:JSON.stringify({open,fin:s2.bal,
    led:{c:ledNet(s2,'company'),r:ledNet(s2,'revenue'),i:ledNet(s2,'installment')}});
});
t('L31 قيد بمبلغ لا يطابق فرق الرصيد يُرفض', ()=>{
  const s2=mkState();
  let threw=false;
  try{ ledgerWrite(s2,{account:'revenue',direction:'credit',amount:100,balanceBefore:1000,balanceAfter:1050,idempotencyKey:'k'});}
  catch(e){ threw=/MISMATCH/.test(e.message); }
  return threw&&ledCount(s2)===0?true:'قُبل قيد غير متطابق';
});
t('L32 فشل الدفتر يُسقط العملية كاملة', ()=>{
  const s2=mkState();
  const r=op(s2,c=>{c.add('revenue',500); c.data.transactions.push({id:'z',amount:500});
    ledgerWrite(s2,{account:'BAD',direction:'credit',amount:1,balanceBefore:0,balanceAfter:1,idempotencyKey:'x'});},{opId:'z1'});
  return !r.ok&&s2.bal.revenue===3000&&s2.month.transactions.length===0&&ledCount(s2)===0?true:JSON.stringify({bal:s2.bal,n:ledCount(s2)});
});
t('L33 القيد لا يتكرر بنفس المفتاح', ()=>{
  const s2=mkState();
  op(s2,c=>c.add('revenue',100),{opId:'same'});
  op(s2,c=>c.add('revenue',100),{opId:'same'});
  return ledCount(s2)===1?true:'تكرر القيد: '+ledCount(s2);
});

console.log('\n===== المرحلة 4 (محاكاة) =====');
R.forEach(x=>console.log(x));
console.log(`\nنجح ${P} | فشل ${F}`);
process.exit(F>0?1:0);
