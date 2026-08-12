#!/usr/bin/env node
// مشغّل واحد لكل مجموعات الاختبار — node tests/run_all.mjs
import { execFileSync } from 'child_process';
import fs from 'fs';
const dir=new URL('.',import.meta.url).pathname;
const files=['run_tests.mjs','phase1_tests.mjs','phase2_tests.mjs','phase3_tests.mjs',
  'phase3b_tests.mjs','phase4_tests.mjs','phase5_tests.mjs','phase6_tests.mjs','phase7_tests.mjs',
  'extract_and_render.mjs','no_delete_check.mjs'];
let pass=0,fail=0,bad=[];
console.log('الملف تحت الاختبار: index.html\n');
for(const f of files){
  if(!fs.existsSync(dir+f)){ console.log(`⚠️  ${f} غير موجود`); bad.push(f); continue; }
  let out='';
  try{ out=execFileSync('node',[dir+f],{encoding:'utf8'}); }
  catch(e){ out=(e.stdout||'')+(e.stderr||''); }
  if(f==='no_delete_check.mjs'){
    const ok=/✅ الفحص نجح/.test(out);
    console.log(`${ok?'✅':'❌'} ${f.padEnd(24)} ${ok?'صفر حذف فعلي':'وُجد حذف'}`);
    if(!ok) bad.push(f);
    continue;
  }
  const m=out.match(/نجح (\d+) \| فشل (\d+)/);
  if(m){ pass+=+m[1]; fail+=+m[2]; console.log(`${(+m[2]===0?'✅':'❌')} ${f.padEnd(24)} نجح ${m[1]} | فشل ${m[2]}`); if(+m[2]>0) bad.push(f); }
  else { console.log(`❌ ${f.padEnd(24)} لم تُقرأ النتيجة`); bad.push(f); }
}
console.log(`\n════ الإجمالي: نجح ${pass} | فشل ${fail} ════`);
if(bad.length) console.log('مجموعات تحتاج مراجعة: '+bad.join(', '));
console.log('\n⚠️  هذه محاكاة منطقية فقط. اختبارات القواعد في tests/rules/ وتحتاج Firebase Emulator.');
process.exit(fail>0||bad.length?1:0);
