import process from "node:process";
import {initializeApp,applicationDefault} from "firebase-admin/app";
import {getFirestore} from "firebase-admin/firestore";

const p=process.argv.indexOf("--project"),projectId=p>=0?process.argv[p+1]:process.env.GCLOUD_PROJECT;
if(!projectId){console.error("الاستخدام: npm run reconcile -- --project PROJECT_ID");process.exit(2);}
initializeApp({projectId,credential:applicationDefault()});
const db=getFirestore(),r2=v=>Math.round((Number(v)||0)*100)/100;
const [bs,ls]=await Promise.all([db.doc("config/balances").get(),db.collection("ledger").get()]);
if(!bs.exists){console.error("config/balances غير موجود");process.exit(2);}
const b=bs.data(),current={company:r2(b.companyBalance),revenue:r2(b.revenueBalance),installment:r2(b.installmentBalance)};
const ledger={company:0,revenue:0,installment:0},invalid=[];
for(const d of ls.docs){const x=d.data(),a=r2(x.amount);if(!(x.account in ledger)||!(a>0)||!["credit","debit"].includes(x.direction)){invalid.push(d.id);continue;}ledger[x.account]=r2(ledger[x.account]+(x.direction==="credit"?a:-a));}
const rows=Object.keys(current).map(account=>({account,current:current[account],ledger:ledger[account],difference:r2(current[account]-ledger[account]),ok:Math.abs(r2(current[account]-ledger[account]))<0.01}));
console.table(rows);if(invalid.length)console.error("قيود غير صالحة:",invalid.join(", "));
const ok=rows.every(x=>x.ok)&&invalid.length===0;console.log(ok?"PASS: جميع الأرصدة تطابق القيود":"FAIL: توجد فروق");process.exit(ok?0:1);
