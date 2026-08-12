#!/usr/bin/env node
// ============================================================
// أداة فحص حجم مستند الشهر — محلية بالكامل، لا تتصل بـFirebase
//
//   node tests/doc_size.mjs                    ← نموذج تقديري (ليست بياناتك)
//   node tests/doc_size.mjs month.json         ← مستند حقيقي مُصدَّر
//
// لتصدير مستندك: Firebase Console → Firestore → months/{y_m} → ⋮ → نسخ الحقول
// إلى ملف JSON ثم مرّره كوسيط. بلا ذلك، الأرقام **تقديرية من نموذج** لا من بياناتك.
// ============================================================
import fs from 'fs';

const LIMIT      = 1048576;   // حد Firestore للمستند الواحد: 1 MiB
const WARN       = 700*1024;
const CRITICAL   = 850*1024;

const ARRAYS = ['transactions','expenses','unitMaintenance','facilityMaintenance',
                'dailyBookings','handovers','profits','installments','logs'];

function bytes(o){ return Buffer.byteLength(JSON.stringify(o),'utf8'); }
function fmt(b){ return (b/1024).toFixed(1)+' KB'; }
function bar(b){
  const pct=Math.min(100,b/LIMIT*100);
  const n=Math.round(pct/2.5);
  return '['+'█'.repeat(n)+'·'.repeat(40-n)+'] '+pct.toFixed(1)+'%';
}

// نموذج تقديري — يُستخدم فقط عند غياب مستند حقيقي
function sampleMonth(){
  const unit=(i)=>({id:'u'+i,name:'شقة '+(100+i),partitions:Array.from({length:6},(_,j)=>({
    id:j+1, rent:1300, rent_type:'monthly', status:'collected', paid_amount:1300,
    partial:false, tenant:'مستأجر '+j, phone:'0501234567', deposit:1300, note:'',
    start_date:'2026-07-01', due_date:'2026-08-01', contract_end:'2026-08-01',
    collectionMethod:'cash', bankDeposited:false, collectedBy:'yahia',
    elec_paid:false, elec_amount:0, cycle_anchor:'2026-07-01', cycle_i:1,
    renewStamp:'', lastRenewedKey:'2026_7', version:1 }))});
  const tx=(i)=>({id:'t'+i,type:'إيجار شهري',desc:'إيداع إيجار شهر أغسطس — شقة 101',
    amount:1300,date:'2026-08-05',by:'yahia',requestId:'req_'+i,
    approvedBy:'saeed',approvedAt:'2026-08-05T10:00:00.000Z'});
  const exp=(i)=>({id:'e'+i,desc:'مصروف صيانة كهرباء',amount:250,date:'2026-08-05',
    category:'صيانة',paidFrom:'revenue',requestId:'req_e'+i,by:'yahia',
    approvedBy:'saeed',approvedAt:'2026-08-05T10:00:00.000Z'});
  const log=(i)=>({id:'l'+i,user:'yahia',name:'يحيى',
    text:'يحيى عدّل بارتشن شقة 101 #3 — الحالة من متأخر إلى محصّل',
    at:'2026-08-05T10:00:00.000Z',target:'شقة 101 #3',field:'الحالة',
    oldVal:'late',newVal:'collected'});
  return { data:{
    units: Array.from({length:5},(_,i)=>unit(i)),
    full:  Array.from({length:9},(_,i)=>({id:String(100+i),rent:9000,status:'collected',
           paid_amount:9000,partial:false,tenant:'مستأجر',phone:'0501234567',
           deposit:9000,note:'',collectionMethod:'cash',collectedBy:'yahia',version:1})),
    transactions: Array.from({length:40},(_,i)=>tx(i)),
    expenses: Array.from({length:25},(_,i)=>exp(i)),
    unitMaintenance: Array.from({length:10},(_,i)=>({...exp(i),id:'m'+i})),
    facilityMaintenance: Array.from({length:6},(_,i)=>({...exp(i),id:'f'+i})),
    dailyBookings: Array.from({length:12},(_,i)=>({id:'b'+i,partId:'u1-2',partLabel:'شقة 101 / بارتشن 2',
      guest:'ضيف',startDate:'2026-08-01',endDate:'2026-08-04',nights:3,nightRate:250,total:750,
      by:'yahia',status:'paid',paidAt:'2026-08-01T10:00:00.000Z',paymentMethod:'cash',
      collectedBy:'yahia',refundAmount:0})),
    handovers: Array.from({length:6},(_,i)=>({id:'hv'+i,from:'nader',to:'yahia',
      amount:500,at:'2026-08-05T10:00:00.000Z',status:'confirmed'})),
    profits: [], installments: [],
    logs: Array.from({length:150},(_,i)=>log(i))
  }, _rev: 40 };
}

const argPath = process.argv[2];
let month, source;
if (argPath && fs.existsSync(argPath)) {
  month = JSON.parse(fs.readFileSync(argPath,'utf8'));
  source = 'مستند حقيقي: '+argPath;
} else {
  if (argPath) { console.error('⚠️  الملف غير موجود: '+argPath+' — سيُستخدم النموذج التقديري\n'); }
  month = sampleMonth();
  source = 'نموذج تقديري (ليست بياناتك الحقيقية)';
}

const d = month.data || month;
const total = bytes(month);

console.log('════ فحص حجم مستند الشهر ════');
console.log('المصدر: '+source);
console.log('حد Firestore للمستند: '+fmt(LIMIT)+'\n');
console.log('الحجم الحالي: '+fmt(total));
console.log(bar(total)+'\n');

console.log('التفصيل حسب المصفوفة:');
const rows=[];
let recTotal=0;
for (const k of ARRAYS) {
  const arr = d[k] || [];
  const b = bytes(arr);
  const per = arr.length ? b/arr.length : 0;
  recTotal += arr.length;
  rows.push([k, arr.length, b, per]);
}
const unitsB = bytes(d.units||[]) + bytes(d.full||[]);
console.log(`  ${'الوحدات (units+full)'.padEnd(24)} ${String((d.units||[]).length+(d.full||[]).length).padStart(5)} سجل  ${fmt(unitsB).padStart(10)}`);
rows.forEach(([k,n,b,per])=>{
  console.log(`  ${k.padEnd(24)} ${String(n).padStart(5)} سجل  ${fmt(b).padStart(10)}  ~${per.toFixed(0)} بايت/سجل`);
});
console.log(`\nإجمالي السجلات (بلا الوحدات): ${recTotal}`);

// ===== متوسط النمو لكل عملية =====
// العملية الواحدة تكتب: قيد/مصروف + سطر سجل. المعكوسة تضيف حقول ولا تُحذف.
const perTx  = rows.find(r=>r[0]==='transactions')[3] || 260;
const perLog = rows.find(r=>r[0]==='logs')[3] || 210;
const perOp  = perTx + perLog;
const reversalOverhead = 140;   // حقول reversed/reversedAt/reversedBy/reverseReason/reverseOf
console.log(`\nمتوسط النمو لكل عملية مالية: ~${perOp.toFixed(0)} بايت (قيد ${perTx.toFixed(0)} + سجل ${perLog.toFixed(0)})`);
console.log(`عبء العكس الإضافي لكل عملية معكوسة: ~${reversalOverhead} بايت (السجل يبقى ولا يُحذف)`);

// ===== التقدير بعد 12 شهراً =====
console.log('\n════ تقدير النمو ════');
console.log('ملاحظة: مستند الشهر يُنشأ جديداً كل شهر — النمو داخل الشهر الواحد فقط،');
console.log('والوحدات تُرحَّل للشهر التالي. لذا التقدير أدناه لأسوأ حالة: شهر مزدحم.\n');
const opsPerMonth = [100, 200, 400, 800];
for (const ops of opsPerMonth) {
  const growth = ops*perOp + Math.round(ops*0.1)*reversalOverhead;   // 10% معكوسة
  const est = unitsB + growth + 20*1024;   // + هيكل ثابت
  const flag = est>=CRITICAL ? ' 🔴 حرج' : est>=WARN ? ' 🟠 تحذير' : ' ✅';
  console.log(`  ${String(ops).padStart(4)} عملية/شهر → ${fmt(est).padStart(10)}${flag}`);
}
// كم عملية حتى الحدود
const room = (t)=>Math.max(0, Math.floor((t - unitsB - 20*1024)/perOp));
console.log(`\nالسعة قبل التحذير (${fmt(WARN)}): ~${room(WARN)} عملية في الشهر الواحد`);
console.log(`السعة قبل الحرج  (${fmt(CRITICAL)}): ~${room(CRITICAL)} عملية`);
console.log(`السعة قبل حد Firestore: ~${room(LIMIT)} عملية`);

console.log('\n════ الحالة ════');
if (total >= CRITICAL) {
  console.log('🔴 حرج: تجاوز '+fmt(CRITICAL)+' — أرشِف السجلات القديمة فوراً قبل فشل الكتابة.');
  process.exitCode = 2;
} else if (total >= WARN) {
  console.log('🟠 تحذير: تجاوز '+fmt(WARN)+' — خطّط لأرشفة logs والسجلات المعكوسة.');
  process.exitCode = 1;
} else {
  console.log('✅ ضمن الحدود الآمنة.');
}
console.log('\nإجراءات التخفيف عند الاقتراب:');
console.log('  1. logs هي الأسرع نمواً — انقلها إلى مجموعة مستقلة monthLogs/{y_m}/entries');
console.log('  2. السجلات المعكوسة (reversed:true) — أرشِفها بعد إقفال الشهر');
console.log('  3. dailyBookings الملغاة — أرشِفها بعد 3 أشهر');
console.log('\n⚠️  بلا تمرير مستندك الحقيقي، هذه الأرقام من نموذج ولا تصف مشروعك.');
