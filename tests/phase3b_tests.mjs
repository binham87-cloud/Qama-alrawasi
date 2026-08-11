// ===== المرحلة 3 (معاد فتحها) — المصاريف والصيانة وتسويات الأرصدة =====
let P=0,F=0; const R=[];
const t=(n,fn)=>{try{const r=fn();if(r===true){P++;R.push('✅ '+n);}else{F++;R.push('❌ '+n+' — '+r);}}catch(e){F++;R.push('❌ '+n+' — '+e.message);}};

const mk=()=>({bal:{company:5000,revenue:3000,installment:2000},
  month:{expenses:[],unitMaintenance:[],facilityMaintenance:[],transactions:[],dailyBookings:[],handovers:[]},busy:false});
function op(st,mutate,needMonth=true){
  if(st.busy) return {ok:false,err:'BUSY'};
  st.busy=true;
  const sb=JSON.parse(JSON.stringify(st.bal)), sm=JSON.parse(JSON.stringify(st.month));
  const r2=v=>Math.round(Number(v)*100)/100;
  const chk=v=>{const n=Number(v); if(!isFinite(n)||isNaN(n)||n<=0) throw new Error('BAD_AMOUNT'); return r2(n);};
  const bal=st.bal;
  const ctx={data:st.month,bal,r2,chk,
    deduct(a,x){const v=chk(x); if(v>bal[a]) throw new Error('INSUFFICIENT|'+a+'|'+bal[a]+'|'+v); bal[a]=r2(bal[a]-v); return v;},
    add(a,x){const v=chk(x); bal[a]=r2(bal[a]+v); return v;},
    setAbs(a,x){const n=Number(x); if(!isFinite(n)||n<0) throw new Error('BAD_AMOUNT'); bal[a]=r2(n);},
    log(){}, ACC:{company:'الشركة',revenue:'الإيرادات',installment:'الاقتطاع'}};
  try{ mutate(ctx); st.busy=false; return {ok:true}; }
  catch(e){ st.bal=sb; st.month=sm; st.busy=false; return {ok:false,err:String(e.message)}; }
}
// المسارات كما في الملف
const addExpense=(st,amt,src,id='e1')=>op(st,c=>{const a=c.deduct(src,amt);
  if(c.data.expenses.some(x=>x.opId===id))return;
  c.data.expenses.push({id,opId:id,amount:a,paidFrom:src});});
const srcOf=(x,fix)=> x.paidFrom || (fix||{})[x.id] || null;
const editExpense=(st,id,newAmt,fix)=>{
  const ex=st.month.expenses.find(x=>x.id===id);
  const src=srcOf(ex||{},fix);
  if(!src) return {ok:false,err:'NEED_SOURCE'};
  return op(st,c=>{const e=c.data.expenses.find(x=>x.id===id); if(!e) throw new Error('ENTRY_MISSING');
    const a=c.chk(newAmt); const d=c.r2(a-Number(e.amount||0));
    if(d>0) c.deduct(src,d); else if(d<0) c.add(src,Math.abs(d));
    e.amount=a; e.paidFrom=src;});
};
const delExpense=(st,id,fix)=>{
  const ex=st.month.expenses.find(x=>x.id===id);
  // في الكود الحقيقي الدالة مربوطة بعنصر معروض، فمصدره متاح دائماً عند الضغط
  const src=srcOf(ex||{id},fix);
  if(!src) return {ok:false,err:'NEED_SOURCE'};
  return op(st,c=>{const i=c.data.expenses.findIndex(x=>x.id===id); if(i<0) throw new Error('ENTRY_MISSING');
    const rm=c.data.expenses.splice(i,1)[0]; if(Number(rm.amount)>0) c.add(src,Number(rm.amount));});
};
const addMaint=(st,key,amt,src,id)=>op(st,c=>{const a=c.deduct(src,amt);
  c.data[key]=c.data[key]||[]; if(c.data[key].some(x=>x.opId===id))return;
  c.data[key].push({id,opId:id,amount:a,paidFrom:src});});
const editMaint=(st,key,id,newAmt)=>{
  const it=st.month[key].find(x=>x.id===id); const src=it&&it.paidFrom;
  if(!src) return {ok:false,err:'NEED_SOURCE'};
  return op(st,c=>{const m=c.data[key].find(x=>x.id===id); if(!m) throw new Error('ENTRY_MISSING');
    const a=c.chk(newAmt); const d=c.r2(a-Number(m.amount||0));
    if(d>0) c.deduct(src,d); else if(d<0) c.add(src,Math.abs(d)); m.amount=a;});
};
const delMaint=(st,key,id)=>{
  const it=st.month[key].find(x=>x.id===id); const src=it&&it.paidFrom;
  if(!src) return {ok:false,err:'NEED_SOURCE'};
  return op(st,c=>{const i=c.data[key].findIndex(x=>x.id===id); if(i<0) throw new Error('ENTRY_MISSING');
    const rm=c.data[key].splice(i,1)[0]; c.add(src,Number(rm.amount||0));});
};
// تسويات
let ADJ={};
const mkAdj=(st,o)=>{
  const amt=Number(o.amount);
  if(!isFinite(amt)||amt<=0) return {ok:false,err:'BAD_AMOUNT'};
  if(!o.reason||!String(o.reason).trim()) return {ok:false,err:'NO_REASON'};
  if(['company','revenue','installment'].indexOf(o.account)<0) return {ok:false,err:'BAD_ACCOUNT'};
  const id='adj_'+o.idem;
  if(ADJ[id]) return {ok:false,err:'DUPLICATE'};
  const r=op(st,c=>{ if(o.type==='withdraw') c.deduct(o.account,amt); else c.add(o.account,amt); },false);
  if(!r.ok) return r;
  ADJ[id]={adjustmentId:id,...o,amount:amt,status:'active',reverseOf:o.reverseOf||null};
  return {ok:true,id};
};
const revAdj=(st,id)=>{
  const a=ADJ[id];
  if(!a) return {ok:false,err:'MISSING'};
  if(a.status==='reversed') return {ok:false,err:'ALREADY_REVERSED'};
  if(a.reverseOf) return {ok:false,err:'IS_REVERSAL'};
  const r=mkAdj(st,{account:a.account,type:a.type==='add'?'withdraw':'add',amount:a.amount,
                    reason:'عكس: '+a.reason,reverseOf:id,idem:'rev_'+id});
  if(r.ok) a.status='reversed';
  return r;
};

// ===== 1-3 إضافة المصروف =====
let st=mk();
t('E01 مصروف من حساب الشركة يُخصم فعلياً', ()=>{
  const r=addExpense(st,1200,'company');
  return r.ok&&st.bal.company===3800&&st.bal.revenue===3000&&st.month.expenses.length===1?true:JSON.stringify(st.bal);
});
st=mk();
t('E02 مصروف من الإيرادات يُخصم فعلياً', ()=>{
  const r=addExpense(st,800,'revenue');
  return r.ok&&st.bal.revenue===2200&&st.bal.company===5000?true:JSON.stringify(st.bal);
});
st=mk();
t('E03 مصروف أكبر من الرصيد مرفوض بلا قيد', ()=>{
  const r=addExpense(st,99999,'revenue');
  return !r.ok&&r.err.startsWith('INSUFFICIENT')&&st.bal.revenue===3000&&st.month.expenses.length===0?true:JSON.stringify({r,st:st.bal});
});
// ===== 4-6 تعديل وحذف =====
st=mk(); addExpense(st,1000,'company','x1');
t('E04 زيادة المبلغ تخصم الفرق فقط', ()=>{
  const r=editExpense(st,'x1',1500);
  return r.ok&&st.bal.company===3500&&st.month.expenses[0].amount===1500?true:JSON.stringify(st.bal);
});
t('E05 تقليل المبلغ يُرجع الفرق', ()=>{
  const r=editExpense(st,'x1',600);
  return r.ok&&st.bal.company===4400&&st.month.expenses[0].amount===600?true:JSON.stringify(st.bal);
});
t('E06 حذف المصروف يُرجع كامل المبلغ', ()=>{
  const r=delExpense(st,'x1');
  return r.ok&&st.bal.company===5000&&st.month.expenses.length===0?true:JSON.stringify(st.bal);
});
t('E07 حذف نفس المصروف مرتين مرفوض', ()=>{
  const r=delExpense(st,'x1',{x1:'company'});
  return !r.ok&&r.err==='ENTRY_MISSING'&&st.bal.company===5000?true:JSON.stringify({r,bal:st.bal});
});
t('E08 زيادة تتجاوز الرصيد مرفوضة والمبلغ لا يتغير', ()=>{
  const s2=mk(); addExpense(s2,100,'revenue','y1');
  const r=editExpense(s2,'y1',99999);
  return !r.ok&&s2.month.expenses[0].amount===100&&s2.bal.revenue===2900?true:JSON.stringify({r,bal:s2.bal});
});
// ===== 7-10 الصيانة =====
st=mk();
t('E09 صيانة شقة من حساب الشركة', ()=>{
  const r=addMaint(st,'unitMaintenance',700,'company','m1');
  return r.ok&&st.bal.company===4300&&st.month.unitMaintenance.length===1?true:JSON.stringify(st.bal);
});
t('E10 صيانة مرافق من الإيرادات', ()=>{
  const r=addMaint(st,'facilityMaintenance',500,'revenue','m2');
  return r.ok&&st.bal.revenue===2500&&st.bal.company===4300?true:JSON.stringify(st.bal);
});
t('E11 تعديل تكلفة الصيانة يضبط الفرق', ()=>{
  const r=editMaint(st,'unitMaintenance','m1',900);
  return r.ok&&st.bal.company===4100&&st.month.unitMaintenance[0].amount===900?true:JSON.stringify(st.bal);
});
t('E12 حذف الصيانة يُرجع الرصيد للمصدر الصحيح', ()=>{
  const r=delMaint(st,'unitMaintenance','m1');
  return r.ok&&st.bal.company===5000&&st.bal.revenue===2500?true:JSON.stringify(st.bal);
});
t('E13 صيانة أكبر من الرصيد مرفوضة', ()=>{
  const s2=mk(); const r=addMaint(s2,'unitMaintenance',99999,'company','m9');
  return !r.ok&&s2.bal.company===5000&&s2.month.unitMaintenance.length===0?true:JSON.stringify(s2.bal);
});
// ===== 11 بيانات قديمة بلا paidFrom =====
st=mk(); st.month.expenses.push({id:'old1',amount:400}); // بلا paidFrom
t('E14 تعديل مصروف قديم بلا paidFrom: يطلب الحساب ولا يخمّن', ()=>{
  const r=editExpense(st,'old1',600);
  return !r.ok&&r.err==='NEED_SOURCE'&&st.month.expenses[0].amount===400&&st.bal.company===5000&&st.bal.revenue===3000?true:JSON.stringify({r,bal:st.bal});
});
t('E15 حذف مصروف قديم بلا paidFrom: يطلب الحساب', ()=>{
  const r=delExpense(st,'old1');
  return !r.ok&&r.err==='NEED_SOURCE'&&st.month.expenses.length===1?true:JSON.stringify(r);
});
t('E16 بعد اختيار الحساب يعمل التعديل صحيحاً', ()=>{
  const r=editExpense(st,'old1',600,{old1:'revenue'});
  return r.ok&&st.bal.revenue===2800&&st.month.expenses[0].amount===600?true:JSON.stringify(st.bal);
});
// ===== 12 الضغط المزدوج =====
t('E17 الضغط المزدوج مرفوض في كل عملية', ()=>{
  const s2=mk(); s2.busy=true;
  const a=addExpense(s2,100,'revenue'), b=addMaint(s2,'unitMaintenance',100,'company','z'), c=delExpense(s2,'nope',{nope:'revenue'});
  return !a.ok&&!b.ok&&s2.bal.revenue===3000&&s2.bal.company===5000?true:JSON.stringify(s2.bal);
});
t('E18 idempotency: نفس opId لا يُضاف مرتين', ()=>{
  const s2=mk(); addExpense(s2,100,'revenue','dup'); addExpense(s2,100,'revenue','dup');
  return s2.month.expenses.length===1?true:'أُضيف '+s2.month.expenses.length;
});
// ===== 13-16 تسويات الأرصدة =====
ADJ={}; st=mk();
t('E19 تسوية إضافة ترفع الرصيد', ()=>{
  const r=mkAdj(st,{account:'company',type:'add',amount:2000,reason:'إيداع مالك',idem:'a1'});
  return r.ok&&st.bal.company===7000?true:JSON.stringify({r,bal:st.bal});
});
t('E20 تسوية سحب تخفض الرصيد', ()=>{
  const r=mkAdj(st,{account:'revenue',type:'withdraw',amount:500,reason:'سحب نقدي',idem:'a2'});
  return r.ok&&st.bal.revenue===2500?true:JSON.stringify({r,bal:st.bal});
});
t('E21 السبب إجباري', ()=>{
  const r=mkAdj(st,{account:'revenue',type:'add',amount:100,reason:'  ',idem:'a3'});
  return !r.ok&&r.err==='NO_REASON'&&st.bal.revenue===2500?true:JSON.stringify(r);
});
t('E22 سحب أكبر من الرصيد مرفوض (لا رصيد سالب)', ()=>{
  const r=mkAdj(st,{account:'revenue',type:'withdraw',amount:999999,reason:'خطأ',idem:'a4'});
  return !r.ok&&r.err.startsWith('INSUFFICIENT')&&st.bal.revenue===2500?true:JSON.stringify({r,bal:st.bal});
});
t('E23 نفس المفتاح لا ينفَّذ مرتين', ()=>{
  const before=st.bal.company;
  const r=mkAdj(st,{account:'company',type:'add',amount:2000,reason:'إيداع مالك',idem:'a1'});
  return !r.ok&&r.err==='DUPLICATE'&&st.bal.company===before?true:JSON.stringify({r,bal:st.bal});
});
t('E24 العكس يُنشئ عملية مضادة ويعيد الرصيد', ()=>{
  const before=st.bal.company;
  const r=revAdj(st,'adj_a1');
  return r.ok&&st.bal.company===before-2000&&ADJ['adj_a1'].status==='reversed'?true:JSON.stringify({r,bal:st.bal});
});
t('E25 العكس مرتين مرفوض', ()=>{
  const before=st.bal.company;
  const r=revAdj(st,'adj_a1');
  return !r.ok&&r.err==='ALREADY_REVERSED'&&st.bal.company===before?true:JSON.stringify(r);
});
t('E26 لا يمكن عكس عملية عكسية', ()=>{
  const rid=Object.keys(ADJ).find(k=>ADJ[k].reverseOf);
  const r=revAdj(st,rid);
  return !r.ok&&r.err==='IS_REVERSAL'?true:JSON.stringify(r);
});
t('E27 التسوية لا تُحفظ إلا بعد نجاح المعاملة', ()=>{
  const s2=mk(); const n0=Object.keys(ADJ).length;
  const r=mkAdj(s2,{account:'revenue',type:'withdraw',amount:999999,reason:'تجربة',idem:'zz'});
  return !r.ok&&Object.keys(ADJ).length===n0?true:'حُفظ مستند رغم الفشل';
});
// 16) لا تؤثر على المستهدف/التحصيل
t('E28 التسوية ليست مصروفاً ولا إيداعاً', ()=>{
  const s2=mk();
  mkAdj(s2,{account:'revenue',type:'add',amount:5000,reason:'رأس مال',idem:'q1'});
  return s2.month.expenses.length===0&&s2.month.transactions.length===0?true:'دخلت قائمة مالية';
});
t('E29 التسوية لا تغيّر المستهدف ولا المحصّل', ()=>{
  const target=(d)=>d.dailyBookings.reduce((s,b)=>s+b.total,0);
  const collected=(d)=>d.transactions.reduce((s,x)=>s+x.amount,0);
  const s2=mk(); s2.month.dailyBookings.push({total:500}); s2.month.transactions.push({amount:300});
  const t0=target(s2.month), c0=collected(s2.month);
  mkAdj(s2,{account:'company',type:'add',amount:10000,reason:'تسوية',idem:'q2'});
  return target(s2.month)===t0&&collected(s2.month)===c0?true:'تأثر التقرير';
});
t('E30 الفشل الجزئي يرجّع كل شيء', ()=>{
  const s2=mk();
  const r=op(s2,c=>{c.deduct('company',500); c.data.expenses.push({id:'g',amount:500}); throw new Error('BOOM');});
  return !r.ok&&s2.bal.company===5000&&s2.month.expenses.length===0?true:JSON.stringify({bal:s2.bal});
});

console.log('\n===== المرحلة 3ب (محاكاة) — المصاريف/الصيانة/التسويات =====');
R.forEach(x=>console.log(x));
console.log(`\nنجح ${P} | فشل ${F}`);
process.exit(F>0?1:0);
