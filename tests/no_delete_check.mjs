#!/usr/bin/env node
// فحص آلي: لا حذف فعلي لأي سجل مالي في index.html
// يتجاهل عمليات الوحدات وعناصر الواجهة عمداً — يركّز على المصفوفات المالية فقط.
import fs from 'fs';

const FILE = new URL('../index.html', import.meta.url);
const html = fs.readFileSync(FILE,'utf8');
const code = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');
const lines = code.split('\n');

const FINANCIAL = ['transactions','expenses','unitMaintenance','facilityMaintenance',
                   'bankPayments','ledger','balanceAdjustments'];

// أنماط الحذف الفعلي
const PATTERNS = FINANCIAL.flatMap(arr => ([
  { name:`${arr}.splice`,        re: new RegExp(`\\b${arr}\\b[^\\n]{0,40}\\.splice\\s*\\(`) },
  { name:`${arr} = filter`,      re: new RegExp(`\\b${arr}\\s*=\\s*[^\\n]{0,60}\\.filter\\s*\\(`) },
  { name:`deleteDoc(${arr})`,    re: new RegExp(`deleteDoc\\([^)]*["']${arr}["']`) },
  { name:`tx.delete(${arr})`,    re: new RegExp(`tx\\.delete\\([^)]*["']${arr}["']`) }
]));
// استثناء: الفلترة للعرض فقط (const x = ... .filter) ليست حذفاً
const DISPLAY_OK = /^\s*(const|let)\s+\w+\s*=/;

let hits = [];
lines.forEach((l,i)=>{
  const t = l.trim();
  if (t.startsWith('//')) return;
  for (const p of PATTERNS) {
    if (p.re.test(l)) {
      if (DISPLAY_OK.test(l) && /\.filter\s*\(/.test(l)) continue;   // إسناد لمتغيّر عرض
      hits.push({ line:i+1, pattern:p.name, text:t.slice(0,110) });
    }
  }
});

// فحص إيجابي: وجود وسم العكس
const stamps = ['reversed','reversedAt','reversedBy','reverseReason','reverseOf'];
const stampCounts = Object.fromEntries(stamps.map(s=>[s,(code.match(new RegExp(s,'g'))||[]).length]));

console.log('════ فحص عدم الحذف الفعلي للسجلات المالية ════');
console.log('الملف: index.html');
console.log('المصفوفات المفحوصة: '+FINANCIAL.join(' · ')+'\n');
if (hits.length===0) {
  console.log('✅ صفر عملية حذف فعلي\n');
} else {
  console.log(`❌ ${hits.length} موضع حذف فعلي:\n`);
  hits.forEach(h=>console.log(`   سطر ${h.line} [${h.pattern}]  ${h.text}`));
  console.log('');
}
console.log('وسوم العكس الموجودة:');
stamps.forEach(s=>console.log(`   ${s.padEnd(16)} ${stampCounts[s]} مرة`));
const missing = stamps.filter(s=>stampCounts[s]===0);
if (missing.length) console.log('\n⚠️  وسوم غائبة: '+missing.join(', '));

// فحص أن المجاميع تستثني المعكوس
const aggr = [
  { name:'CALC.deposited يستثني reversed', re:/function deposited\(d\)\{[^}]*filter\(t=>!t\.reversed\)/ },
  { name:'CALC.expenses يستثني reversed',  re:/filter\(x=>!x\.reversed\)\.reduce\(\(s,x\)=>s\+num\(x\.amount\)/ },
  { name:'custody يستثني reversed',        re:/!t\.bankPaymentId && !t\.reversed|!x\.bankPaymentId&&!x\.reversed/ }
];
console.log('\nاستثناء المعكوس من المجاميع:');
let aggFail=0;
aggr.forEach(a=>{ const ok=a.re.test(code); if(!ok)aggFail++;
  console.log(`   ${ok?'✅':'❌'} ${a.name}`); });

const fail = hits.length>0 || missing.length>0 || aggFail>0;
console.log('\n'+(fail?'❌ الفحص فشل':'✅ الفحص نجح'));
process.exit(fail?1:0);
