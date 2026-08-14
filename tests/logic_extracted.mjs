// مستخرج متزامن مع index.html (_diffFields + sanitize rent wipe)
let S={};
let displayStatus=(x)=>{const st=x&&x.status||'late';return st;}; // يُحقن من الاختبار
export function __setDisplayStatus(f){displayStatus=f;}

function parseMoneyInputRaw(raw){
  if(raw===null||raw===undefined) return null;
  const s=String(raw).trim();
  if(s==="") return null;
  const n=Number(s);
  if(!Number.isFinite(n)||n<0) return null;
  return n;
}
function sanitizeRentalDiff(diff){
  const fields=diff?.fields&&typeof diff.fields==="object"?{...diff.fields}:{};
  const originalFields=diff?.originalFields&&typeof diff.originalFields==="object"?{...diff.originalFields}:{};
  for(const k of ["rent","deposit","elec_amount"]){
    if(!Object.prototype.hasOwnProperty.call(fields,k)) continue;
    const next=Number(fields[k]);
    const prev=Number(originalFields[k]);
    if(k==="rent" && next===0 && prev>0){
      delete fields[k]; delete originalFields[k];
      continue;
    }
    if(!Number.isFinite(next)){ delete fields[k]; delete originalFields[k]; }
  }
  return {fields, originalFields, count:Object.keys(fields).length};
}
function _diffFields(cur, snap){
  const fields={}, originalFields={};
  const storable=(v,other)=>{
    if(v!==undefined)return v;
    if(typeof other==="string")return "";
    if(typeof other==="number")return 0;
    if(typeof other==="boolean")return false;
    return null;
  };
  const moneyKeys=new Set(["rent","deposit","elec_amount","paid_amount"]);
  const keys=new Set([...Object.keys(cur||{}), ...Object.keys(snap||{})]);
  keys.forEach(k=>{
    if(k==="partitions"||k==="version"||k.startsWith("_")) return;
    const a=cur?cur[k]:undefined, b=snap?snap[k]:undefined;
    if(moneyKeys.has(k) && (a===undefined||a===null)) return;
    const na=(a===undefined||a===null)?"":a, nb=(b===undefined||b===null)?"":b;
    if(typeof na==="object"||typeof nb==="object"){ if(JSON.stringify(na)!==JSON.stringify(nb)){fields[k]=storable(a,b);originalFields[k]=storable(b,a);} return; }
    if(String(na)!==String(nb)){ fields[k]=storable(a,b); originalFields[k]=storable(b,a); }
  });
  return sanitizeRentalDiff({fields, originalFields, count:Object.keys(fields).length});
}

function _bookingOverlap(a,b){ return a.startDate < b.endDate && b.startDate < a.endDate; }
function validateBooking(data, booking, allParts){
  if(!booking.startDate||!booking.endDate) return "أدخل تاريخي البداية والنهاية";
  if(booking.endDate<=booking.startDate)   return "تاريخ النهاية يجب أن يكون بعد البداية";
  const amt=Number(booking.total);
  if(!isFinite(amt)||amt<=0)               return "المبلغ غير صالح";
  const clash=((data&&data.dailyBookings)||[]).find(x=>
    String(x.partId)===String(booking.partId) &&
    String(x.id)!==String(booking.id) &&
    x.status!=="cancelled" && x.status!=="refunded" &&
    _bookingOverlap(x,booking));
  if(clash) return "تعارض مع حجز قائم: "+(clash.guest||"—")+" ("+clash.startDate+" إلى "+clash.endDate+")";
  const src=(allParts||[]).find(p=>String(p.id)===String(booking.partId));
  const obj=src&&src.obj;
  if(obj){
    const ds=displayStatus(obj);
    const isDailyUnit=(obj.note==="يومي")||(obj.rent_type==="daily");
    if(!isDailyUnit && ds!=="vacant") return "هذا البارتشن مؤجّر شهرياً — لا يمكن الحجز اليومي عليه";
  }
  return null;
}

export {_diffFields, validateBooking, _bookingOverlap, parseMoneyInputRaw, sanitizeRentalDiff};
