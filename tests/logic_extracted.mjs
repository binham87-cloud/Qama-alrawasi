// مستخرج حرفياً من qama-v4.html
let S={};
let displayStatus=(x)=>{const st=x&&x.status||'late';return st;}; // يُحقن من الاختبار
export function __setDisplayStatus(f){displayStatus=f;}
function _diffFields(cur, snap){
  const fields={}, originalFields={};
  const keys=new Set([...Object.keys(cur||{}), ...Object.keys(snap||{})]);
  keys.forEach(k=>{
    if(k==="partitions"||k==="version") return;
    const a=cur?cur[k]:undefined, b=snap?snap[k]:undefined;
    const na=(a===undefined||a===null)?"":a, nb=(b===undefined||b===null)?"":b;
    if(typeof na==="object"||typeof nb==="object"){ if(JSON.stringify(na)!==JSON.stringify(nb)){fields[k]=a;originalFields[k]=b;} return; }
    if(String(na)!==String(nb)){ fields[k]=a; originalFields[k]=b; }
  });
  return {fields, originalFields, count:Object.keys(fields).length};
}

function _bookingOverlap(a,b){ return a.startDate < b.endDate && b.startDate < a.endDate; }
function validateBooking(data, booking, allParts){
  if(!booking.startDate||!booking.endDate) return "أدخل تاريخي البداية والنهاية";
  if(booking.endDate<=booking.startDate)   return "تاريخ النهاية يجب أن يكون بعد البداية";
  const amt=Number(booking.total);
  if(!isFinite(amt)||amt<=0)               return "المبلغ غير صالح";
  // تداخل مع حجز قائم على نفس البارتشن (الملغى والمسترجع لا يحجزان التاريخ)
  const clash=((data&&data.dailyBookings)||[]).find(x=>
    String(x.partId)===String(booking.partId) &&
    String(x.id)!==String(booking.id) &&
    x.status!=="cancelled" && x.status!=="refunded" &&
    _bookingOverlap(x,booking));
  if(clash) return "تعارض مع حجز قائم: "+(clash.guest||"—")+" ("+clash.startDate+" إلى "+clash.endDate+")";
  // البارتشن مؤجّر شهرياً وغير فارغ
  const src=(allParts||[]).find(p=>String(p.id)===String(booking.partId));
  const obj=src&&src.obj;
  if(obj){
    const ds=displayStatus(obj);
    const isDailyUnit=(obj.note==="يومي")||(obj.rent_type==="daily");
    if(!isDailyUnit && ds!=="vacant") return "هذا البارتشن مؤجّر شهرياً — لا يمكن الحجز اليومي عليه";
  }
  return null;
}

export {_diffFields, validateBooking, _bookingOverlap};
