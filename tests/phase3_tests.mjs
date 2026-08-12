// ===== اختبارات المرحلة 3 (محاكاة) — المسارات المالية المباشرة =====
let P=0,F=0; const R=[];
const t=(n,fn)=>{try{const r=fn();if(r===true){P++;R.push('✅ '+n);}else{F++;R.push('❌ '+n+' — '+r);}}catch(e){F++;R.push('❌ '+n+' — '+e.message);}};

// محاكاة commitMoneyOp
const mkState=()=>({bal:{company:5000,revenue:1000,installment:2000,schedule:[{date:'2026-06-30',amount:800,paid:false},{date:'2026-09-30',amount:900,paid:false}]},
                    month:{transactions:[],expenses:[],profits:[],installments:[],logs:[]},_rev:1,busy:false});
function commitMoneyOp(st,mutate,needMonth=true){
  if(st.busy) return {ok:false,err:'BUSY'};
  st.busy=true;
  const snapBal=JSON.parse(JSON.stringify(st.bal));
  const snapMonth=JSON.parse(JSON.stringify(st.month));
  const r2=v=>Math.round(Number(v)*100)/100;
  const chk=v=>{const n=Number(v); if(!isFinite(n)||isNaN(n)||n<=0) throw new Error('BAD_AMOUNT'); return r2(n);};
  const bal=st.bal;
  const ctx={data:st.month,bal,r2,chk,
    deduct(a,x){const v=chk(x); if(v>bal[a]) throw new Error('INSUFFICIENT|'+a+'|'+bal[a]+'|'+v); bal[a]=r2(bal[a]-v); return v;},
    add(a,x){const v=chk(x); bal[a]=r2(bal[a]+v); return v;},
    setAbs(a,x){const n=Number(x); if(!isFinite(n)||isNaN(n)||n<0) throw new Error('BAD_AMOUNT'); bal[a]=r2(n);},
    log(){}, ACC:{company:'الشركة',revenue:'الإيرادات',installment:'الاقتطاع'}};
  try{ mutate(ctx); st._rev++; st.busy=false; return {ok:true}; }
  catch(e){ st.bal=snapBal; st.month=snapMonth; st.busy=false; return {ok:false,err:String(e.message)}; }
}

// 1) إيداع مباشر
let st=mkState();
let r=commitMoneyOp(st,ctx=>{const a=ctx.add('revenue',500); ctx.data.transactions.push({id:1,opId:'d1',amount:a});});
t('P3-01 إيداع مباشر: القيد والرصيد معاً', ()=> r.ok&&st.bal.revenue===1500&&st.month.transactions.length===1?true:JSON.stringify(st.bal));
t('P3-02 إيداع مباشر مكرر لا يُضاف مرتين', ()=>{
  commitMoneyOp(st,ctx=>{const a=ctx.add('revenue',500); if(ctx.data.transactions.some(x=>x.opId==='d1'))return; ctx.data.transactions.push({id:2,opId:'d1',amount:a});});
  return st.month.transactions.length===1?true:'أُضيف مرتين';
});

// 2) تعديل الإيداع بالفرق
st=mkState(); commitMoneyOp(st,ctx=>{const a=ctx.add('revenue',500); ctx.data.transactions.push({id:1,amount:a});});
r=commitMoneyOp(st,ctx=>{const t0=ctx.data.transactions[0]; const diff=ctx.r2(800-t0.amount);
  if(diff<0&&Math.abs(diff)>ctx.bal.revenue) throw new Error('INSUFFICIENT|revenue|'+ctx.bal.revenue+'|'+Math.abs(diff));
  t0.amount=800; ctx.bal.revenue=ctx.r2(ctx.bal.revenue+diff);});
t('P3-03 تعديل الإيداع يعدّل الرصيد بالفرق فقط', ()=> r.ok&&st.bal.revenue===1800&&st.month.transactions[0].amount===800?true:JSON.stringify(st.bal));

// 3) حذف/عكس الإيداع
r=commitMoneyOp(st,ctx=>{const t0=ctx.data.transactions[0];
  if(t0.amount>ctx.bal.revenue) throw new Error('INSUFFICIENT|revenue|'+ctx.bal.revenue+'|'+t0.amount);
  ctx.bal.revenue=ctx.r2(ctx.bal.revenue-t0.amount); ctx.data.transactions.shift();});
t('P3-04 حذف الإيداع يعكس الرصيد بالكامل', ()=> r.ok&&st.bal.revenue===1000&&st.month.transactions.length===0?true:JSON.stringify(st.bal));

// 4) مصروف من حساب محدد + تعديله
st=mkState();
commitMoneyOp(st,ctx=>{const a=ctx.deduct('company',1200); ctx.data.expenses.push({id:1,amount:a,paidFrom:'company'});});
t('P3-05 المصروف يُخصم من الحساب المختار', ()=> st.bal.company===3800&&st.bal.revenue===1000?true:JSON.stringify(st.bal));
r=commitMoneyOp(st,ctx=>{const e=ctx.data.expenses[0]; const diff=ctx.r2(1500-e.amount);
  const cur=e.paidFrom==='company'?ctx.bal.company:ctx.bal.revenue;
  if(diff>0&&diff>cur) throw new Error('INSUFFICIENT|company|'+cur+'|'+diff);
  e.amount=1500; ctx.bal.company=ctx.r2(ctx.bal.company-diff);});
t('P3-06 تعديل المصروف يخصم الفرق من نفس الحساب', ()=> r.ok&&st.bal.company===3500?true:JSON.stringify(st.bal));
r=commitMoneyOp(st,ctx=>{const e=ctx.data.expenses[0]; ctx.bal.company=ctx.r2(ctx.bal.company+e.amount); ctx.data.expenses.shift();});
t('P3-07 حذف المصروف يرجّع للحساب الصحيح', ()=> st.bal.company===5000&&st.bal.revenue===1000?true:JSON.stringify(st.bal));

// 5) الأرباح تُخصم فعلياً
st=mkState();
r=commitMoneyOp(st,ctx=>{const a=ctx.deduct('revenue',600); ctx.data.profits.push({id:1,amount:a,account:'revenue'});});
t('P3-08 الأرباح تُخصم من الحساب المختار', ()=> r.ok&&st.bal.revenue===400&&st.month.profits.length===1?true:JSON.stringify(st.bal));
r=commitMoneyOp(st,ctx=>{const a=ctx.deduct('revenue',9999); ctx.data.profits.push({id:2,amount:a});});
t('P3-09 أرباح تتجاوز الرصيد: رفض بلا قيد', ()=>
  !r.ok&&r.err.startsWith('INSUFFICIENT')&&st.bal.revenue===400&&st.month.profits.length===1?true:JSON.stringify({r,st:st.bal}));

// 6) الأقساط
st=mkState();
r=commitMoneyOp(st,ctx=>{const a=ctx.deduct('company',700); ctx.data.installments.push({id:1,amount:a});});
t('P3-10 القسط يُخصم قبل الإضافة للقائمة', ()=> r.ok&&st.bal.company===4300&&st.month.installments.length===1?true:JSON.stringify(st.bal));
r=commitMoneyOp(st,ctx=>{const a=ctx.deduct('company',99999); ctx.data.installments.push({id:2,amount:a});});
t('P3-11 قسط برصيد غير كافٍ: لا يُضاف للقائمة أصلاً', ()=>
  !r.ok&&st.month.installments.length===1&&st.bal.company===4300?true:JSON.stringify({n:st.month.installments.length}));

// 7) دفع القسط القادم من حساب الاقتطاع
st=mkState();
r=commitMoneyOp(st,ctx=>{const sc=ctx.bal.schedule.map(x=>({...x})); const i=sc.findIndex(x=>!x.paid);
  const a=ctx.deduct('installment',sc[i].amount); sc[i].paid=true; ctx.bal.schedule=sc;});
t('P3-12 دفع القسط: خصم + وسم مدفوع معاً', ()=>
  r.ok&&st.bal.installment===1200&&st.bal.schedule[0].paid===true?true:JSON.stringify(st.bal));
st.bal.installment=100;
r=commitMoneyOp(st,ctx=>{const sc=ctx.bal.schedule.map(x=>({...x})); const i=sc.findIndex(x=>!x.paid);
  const a=ctx.deduct('installment',sc[i].amount); sc[i].paid=true; ctx.bal.schedule=sc;});
t('P3-13 قسط برصيد اقتطاع غير كافٍ: لا وسم ولا خصم', ()=>
  !r.ok&&st.bal.installment===100&&st.bal.schedule[1].paid===false?true:JSON.stringify(st.bal));

// 8) إضافة/سحب من حساب الاقتطاع
st=mkState();
commitMoneyOp(st,ctx=>ctx.add('installment',500),false);
t('P3-14 إضافة لحساب الاقتطاع', ()=> st.bal.installment===2500?true:st.bal.installment);
r=commitMoneyOp(st,ctx=>ctx.deduct('installment',99999),false);
t('P3-15 سحب أكبر من الرصيد مرفوض', ()=> !r.ok&&st.bal.installment===2500?true:JSON.stringify(st.bal));

// 9) التحويل بين الحسابين
st=mkState();
r=commitMoneyOp(st,ctx=>{ctx.deduct('revenue',400); ctx.add('company',400);},false);
t('P3-16 التحويل: الطرفان يتحركان معاً', ()=> r.ok&&st.bal.revenue===600&&st.bal.company===5400?true:JSON.stringify(st.bal));
r=commitMoneyOp(st,ctx=>{ctx.deduct('revenue',99999); ctx.add('company',99999);},false);
t('P3-17 تحويل برصيد غير كافٍ: لا طرف يتحرك', ()=>
  !r.ok&&st.bal.revenue===600&&st.bal.company===5400?true:JSON.stringify(st.bal));

// 10) التعديل اليدوي على الرصيد
st=mkState();
r=commitMoneyOp(st,ctx=>ctx.setAbs('company',7777),false);
t('P3-18 تعديل يدوي صالح', ()=> r.ok&&st.bal.company===7777?true:st.bal.company);
r=commitMoneyOp(st,ctx=>ctx.setAbs('company',-5),false);
t('P3-19 رصيد سالب مرفوض', ()=> !r.ok&&st.bal.company===7777?true:st.bal.company);
r=commitMoneyOp(st,ctx=>ctx.setAbs('company',NaN),false);
t('P3-20 NaN مرفوض', ()=> !r.ok&&st.bal.company===7777?true:st.bal.company);

// 11) الذرّية: فشل في منتصف العملية
st=mkState();
r=commitMoneyOp(st,ctx=>{ctx.add('revenue',300); ctx.data.transactions.push({id:9,amount:300}); throw new Error('BOOM');});
t('P3-21 فشل بعد تعديل جزئي: كل شيء يرجع', ()=>
  !r.ok&&st.bal.revenue===1000&&st.month.transactions.length===0?true:JSON.stringify({bal:st.bal,n:st.month.transactions.length}));

// 12) منع الضغط المكرر
st=mkState(); st.busy=true;
r=commitMoneyOp(st,ctx=>ctx.add('revenue',100));
t('P3-22 الضغط أثناء التنفيذ مرفوض', ()=> !r.ok&&r.err==='BUSY'&&st.bal.revenue===1000?true:JSON.stringify(r));

// 13) مبالغ غير صالحة عبر كل المسارات
st=mkState();
t('P3-23 صفر/سالب/NaN/نص مرفوضة في كل المسارات', ()=>
  [0,-1,NaN,'abc',null,undefined,Infinity].every(v=>{
    const s2=mkState();
    const a=commitMoneyOp(s2,c=>c.add('revenue',v));
    const b=commitMoneyOp(s2,c=>c.deduct('company',v));
    return !a.ok&&!b.ok&&s2.bal.revenue===1000&&s2.bal.company===5000;
  })?true:'قُبل مبلغ غير صالح');

// 14) تسليم العهدة (تحويل بين موظفين — لا يمس الأرصدة)
t('P3-24 تسليم العهدة لا يغيّر أرصدة الحسابات', ()=>{
  const s2=mkState();
  const before=JSON.stringify(s2.bal);
  commitMoneyOp(s2,ctx=>{ctx.data.handovers=[{from:'nader',to:'yahia',amount:300,confirmed:false}];});
  return JSON.stringify(s2.bal)===before?true:'تغيّر الرصيد';
});
t('P3-25 التسليم غير المؤكد لا يُحتسب في العهدة', ()=>{
  const hv=[{from:'a',to:'b',amount:300,confirmed:false},{from:'a',to:'b',amount:200,confirmed:true}];
  const counted=hv.filter(x=>x.confirmed!==false).reduce((s,x)=>s+x.amount,0);
  return counted===200?true:'المحتسب '+counted;
});

console.log('\n===== المرحلة 3 (محاكاة) =====');
R.forEach(x=>console.log(x));
console.log(`\nنجح ${P} | فشل ${F}`);
process.exit(F>0?1:0);
