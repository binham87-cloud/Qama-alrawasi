// مستخرج حرفياً من qama-v3.html للاختبار المستقل
export function makeCALC(displayStatus){
const S={};
const CALC = (function(){
  const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
  const r2  = v => Math.round(num(v)*100)/100;
  const allItems = d => [
    ...((d&&d.units)||[]).flatMap(u=>(u.partitions||[]).map(p=>p)),
    ...(((d&&d.full)||[]).map(u=>u))
  ];
  // المبلغ المقبوض فعلياً على وحدة واحدة
  function received(x){
    const ds = displayStatus(x);
    const paid = num(x.paid_amount), rent = num(x.rent);
    if(x.partial && paid>0 && paid<rent) return paid;
    if(ds==="collected") return rent;
    if(ds==="partial")   return paid;
    return 0;
  }
  // هل تدخل الوحدة في المستهدف؟ (القاعدة المقصودة: يُستثنى الفارغ والموظفون والدورة المنتهية)
  function inTarget(x){
    const ds = displayStatus(x);
    return ds!=="vacant" && ds!=="staff" && ds!=="expired";
  }
  function dailyTotal(d){ return r2(((d&&d.dailyBookings)||[]).reduce((s,b)=>s+num(b.total),0)); }

  function target(d){
    let t=0; allItems(d).forEach(x=>{ if(inTarget(x)) t+=num(x.rent); });
    return r2(t + dailyTotal(d));
  }
  function collected(d){
    let c=0; allItems(d).forEach(x=>{ c+=received(x); });
    return r2(c + dailyTotal(d));
  }
  // الإيداعات المعتمدة المسجّلة في transactions (تشمل التحويلات البنكية بعد اعتمادها)
  function deposited(d){ return r2((((d&&d.transactions)||[]).reduce((s,t)=>s+num(t.amount),0))); }
  // تحويلات بنكية محصّلة لكن لم يعتمدها المدير بعد — ليست كاشاً بيد أحد
  function bankPending(d){
    let b=0; allItems(d).forEach(x=>{ if(x.collectionMethod==="bank" && !x.bankDeposited) b+=received(x); });
    return r2(b);
  }
  function bankApproved(d){
    let b=0; allItems(d).forEach(x=>{ if(x.collectionMethod==="bank" && x.bankDeposited) b+=received(x); });
    return r2(b);
  }
  // إجمالي ما يُعتبر مودعاً من منظور شاشة التحصيل
  function depositedTotal(d){ return r2(deposited(d) + bankPending(d)); }
  function gap(d){ return r2(target(d) - depositedTotal(d)); }
  function remaining(d){ return Math.max(0, gap(d)); }
  function surplus(d){ return Math.max(0, -gap(d)); }
  function late(d){
    let v=0; allItems(d).forEach(x=>{ if(displayStatus(x)==="late") v+=num(x.rent); });
    return r2(v);
  }
  function notDue(d){
    let v=0; allItems(d).forEach(x=>{ if(displayStatus(x)==="pending") v+=num(x.rent); });
    return r2(v);
  }
  function partialRemaining(d){
    let v=0; allItems(d).forEach(x=>{
      const ds=displayStatus(x), paid=num(x.paid_amount), rent=num(x.rent);
      if(ds==="expired") return;
      if((x.partial && paid>0 && paid<rent) || ds==="partial") v+=Math.max(0, rent-paid);
    });
    return r2(v);
  }
  function expiredTotal(d){
    let v=0; allItems(d).forEach(x=>{ if(displayStatus(x)==="expired") v+=num(x.rent); });
    return r2(v);
  }
  function vacantTotal(d){
    let v=0; allItems(d).forEach(x=>{ if(displayStatus(x)==="vacant") v+=num(x.rent); });
    return r2(v);
  }
  // محصّل لم يودع — كاش بيد الفريق
  function undeposited(d){ return r2(Math.max(0, collected(d) - deposited(d))); }
  function expenses(d){
    const e=(d&&d.expenses)||[], um=(d&&d.unitMaintenance)||[], fm=(d&&d.facilityMaintenance)||[];
    return r2([...e,...um,...fm].reduce((s,x)=>s+num(x.amount),0));
  }
  function liquidity(bal){ return r2(num(bal.companyBalance)+num(bal.revenueBalance)+num(bal.installmentBalance)); }
  // عهدة موظف: (ما حصّله كاشاً) + (استلم من زملاء) - (سلّم لزملاء) - (ما أودعه)
  function custody(d, user){
    let recv=0;
    allItems(d).forEach(x=>{ if(x.collectedBy===user && x.collectionMethod!=="bank") recv+=received(x); });
    ((d&&d.dailyBookings)||[]).forEach(b=>{ if(b.by===user) recv+=num(b.total); });
    const hv=((d&&d.handovers)||[]).filter(x=>x.confirmed!==false);
    const hvIn  = hv.filter(x=>x.to===user).reduce((s,x)=>s+num(x.amount),0);
    const hvOut = hv.filter(x=>x.from===user).reduce((s,x)=>s+num(x.amount),0);
    const dep   = ((d&&d.transactions)||[]).filter(t=>t.by===user && !t.bankRef).reduce((s,t)=>s+num(t.amount),0);
    return { received:r2(recv), handoverIn:r2(hvIn), handoverOut:r2(hvOut), deposited:r2(dep),
             remaining:r2(recv+hvIn-hvOut-dep) };
  }
  // معادلة التوازن — نفس البنود المقصودة، بلا قص
  function balanceCheck(d){
    const T=target(d), DEP=deposited(d), L=late(d), P=notDue(d), PR=partialRemaining(d), U=undeposited(d);
    const sum=r2(DEP+L+P+PR+U);
    return { target:T, deposited:DEP, late:L, notDue:P, partialRem:PR, undeposited:U,
             sum:sum, diff:r2(T-sum), balanced:Math.abs(r2(T-sum))<1 };
  }
  return { num, r2, received, inTarget, allItems, target, collected, deposited, depositedTotal,
           bankPending, bankApproved, gap, remaining, surplus, late, notDue, partialRemaining,
           expiredTotal, vacantTotal, undeposited, expenses, liquidity, custody, balanceCheck, dailyTotal };
})();
return CALC;
}
