// ============================================================
// اختبارات قواعد Firestore — تحتاج Firebase Emulator
//   npm install
//   npm run test:rules
// ============================================================
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  initializeTestEnvironment, assertFails, assertSucceeds
} from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, getDoc, runTransaction, deleteDoc } from 'firebase/firestore';
import fs from 'fs';
import { UIDS, USERS, PERMISSIONS, BALANCES, MONTH_KEY, MONTH_DOC,
         BOOKING_REQ_ID, BOOKING_REQ, bankPaymentFor } from './seed.mjs';

let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'qama-test',
    firestore: {
      rules: fs.readFileSync(new URL('../../firestore-v11.rules', import.meta.url), 'utf8'),
      host: '127.0.0.1', port: 8080
    }
  });
});
after(async () => { if (env) await env.cleanup(); });

// تنظيف + إعادة seed قبل كل اختبار
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const [uid, u] of Object.entries(USERS)) await setDoc(doc(db,'users',uid), u);
    await setDoc(doc(db,'config','permissions'), PERMISSIONS);
    await setDoc(doc(db,'config','balances'), BALANCES);
    await setDoc(doc(db,'months',MONTH_KEY), MONTH_DOC);
    await setDoc(doc(db,'requests',BOOKING_REQ_ID), BOOKING_REQ);
  });
});

const as = (uid) => env.authenticatedContext(uid).firestore();
const asSaeed = () => as(UIDS.saeed);
const asYahia = () => as(UIDS.yahia);
const asNader = () => as(UIDS.nader);

// إنشاء دفعة معلّقة باسم يحيى بتجاوز القواعد (تهيئة)
async function seedPendingPayment(id='bp_1', overrides={}) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(),'bankPayments',id), bankPaymentFor(overrides));
  });
}
async function seedApprovedPayment(id='bp_1') {
  await seedPendingPayment(id, { status:'approved', approvedBy:'saeed', approvedAt:'2026-08-01T11:00:00.000Z' });
}

describe('٠ — تصحيح الطلب المعلّق', () => {
  test('صاحب الطلب يستبدل payload بآخر تصحيح', async () => {
    await assertSucceeds(updateDoc(doc(asYahia(),'requests',BOOKING_REQ_ID), {
      desc:'حجز يومي — التصحيح الأخير',
      payload:{ booking:{ total:800, status:'paid', paymentMethod:'cash', guest:'ضيف' } },
      updatedAt:'2026-08-01T10:05:00.000Z'
    }));
  });

  test('غير صاحب الطلب لا يستبدل محتواه', async () => {
    await assertFails(updateDoc(doc(asNader(),'requests',BOOKING_REQ_ID), {
      payload:{ booking:{ total:800 } }, updatedAt:'x'
    }));
  });

  test('التصحيح لا يسمح بتغيير النوع أو الحالة', async () => {
    await assertFails(updateDoc(doc(asYahia(),'requests',BOOKING_REQ_ID), {
      type:'add_expense', status:'approved', payload:{ expense:{ amount:800 } }, updatedAt:'x'
    }));
  });
});

describe('١ — الإنشاء نيابةً عند اعتماد طلب add_daily بنكي', () => {

  test('سعيد يعتمد طلب يحيى: الطلب + الدفعة + الشهر معاً ينجحون', async () => {
    const db = asSaeed();
    await assertSucceeds(runTransaction(db, async (tx) => {
      const reqRef = doc(db,'requests',BOOKING_REQ_ID);
      const monRef = doc(db,'months',MONTH_KEY);
      const snap = await tx.get(reqRef);
      const mon  = await tx.get(monRef);
      const data = mon.data().data;
      data.dailyBookings.push({ id:BOOKING_REQ_ID, ...snap.data().payload.booking,
                                bankPaymentId:'bp_new', requestId:BOOKING_REQ_ID });
      tx.set(doc(db,'bankPayments','bp_new'), bankPaymentFor({ bookingId:BOOKING_REQ_ID }));
      tx.set(monRef, { data, _rev: mon.data()._rev + 1 }, { merge:true });
      tx.set(reqRef, { status:'approved', approvedAt:'2026-08-01T11:00:00.000Z',
                       approvedBy:'saeed', approvedByUid:UIDS.saeed }, { merge:true });
    }));
  });

  test('يُمنع الإنشاء نيابةً إذا بقي الطلب pending (لا اعتماد في المعاملة)', async () => {
    const db = asSaeed();
    await assertFails(setDoc(doc(db,'bankPayments','bp_x'), bankPaymentFor()));
  });

  // ===== الثغرة المُصلحة: before.status لازم يكون pending =====

  test('🔒 طلب معتمد سابقاً + إنشاء دفعة في معاملة منفصلة = مرفوض', async () => {
    // الطلب اعتُمد في وقت سابق تماماً
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(),'requests',BOOKING_REQ_ID),
        { status:'approved', approvedAt:'2026-08-01T09:00:00.000Z',
          approvedBy:'saeed', approvedByUid:UIDS.saeed });
    });
    // محاولة إنشاء الدفعة الآن خارج معاملة الاعتماد
    // getAfter سيعيد approved و approvedBy=saeed، لكن before.status=approved لا pending
    await assertFails(setDoc(doc(asSaeed(),'bankPayments','bp_late'), bankPaymentFor()));
  });

  test('🔒 طلب معتمد سابقاً + إنشاء الدفعة داخل معاملة تلمس الطلب = مرفوض', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(),'requests',BOOKING_REQ_ID),
        { status:'approved', approvedAt:'x', approvedBy:'saeed', approvedByUid:UIDS.saeed });
    });
    const db = asSaeed();
    await assertFails(runTransaction(db, async (tx) => {
      const reqRef = doc(db,'requests',BOOKING_REQ_ID);
      await tx.get(reqRef);
      tx.set(doc(db,'bankPayments','bp_late2'), bankPaymentFor());
      // إعادة كتابة approved لا تُغيّر أن before كان approved أصلاً
      tx.set(reqRef, { status:'approved', approvedAt:'y',
                       approvedBy:'saeed', approvedByUid:UIDS.saeed }, { merge:true });
    }));
  });

  test('✅ طلب pending → approved + الدفعة داخل المعاملة نفسها = مسموح', async () => {
    const db = asSaeed();
    await assertSucceeds(runTransaction(db, async (tx) => {
      const reqRef = doc(db,'requests',BOOKING_REQ_ID);
      await tx.get(reqRef);
      tx.set(doc(db,'bankPayments','bp_inline'), bankPaymentFor());
      tx.set(reqRef, { status:'approved', approvedAt:'x',
                       approvedBy:'saeed', approvedByUid:UIDS.saeed }, { merge:true });
    }));
  });

  test('🔒 طلب pending بلا تحديث إلى approved + إنشاء الدفعة = مرفوض', async () => {
    const db = asSaeed();
    await assertFails(runTransaction(db, async (tx) => {
      const reqRef = doc(db,'requests',BOOKING_REQ_ID);
      await tx.get(reqRef);
      tx.set(doc(db,'bankPayments','bp_noappr'), bankPaymentFor());
      // لا كتابة للطلب إطلاقاً → after.status يبقى pending
    }));
  });

  test('🔒 اعتماد الطلب بمستخدم مختلف عن منشئ الدفعة = مرفوض', async () => {
    // سعيد يعتمد، لكن الدفعة تُنشأ ويُدّعى أن approvedBy شخص آخر
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db,'users','uid_mgr'),
        { userKey:'nader', role:'finance', name:'مالية', active:true });
    });
    const db = as('uid_mgr');   // مالية، userKey=nader
    await assertFails(runTransaction(db, async (tx) => {
      const reqRef = doc(db,'requests',BOOKING_REQ_ID);
      await tx.get(reqRef);
      tx.set(doc(db,'bankPayments','bp_mismatch'), bankPaymentFor());
      tx.set(reqRef, { status:'approved', approvedAt:'x',
                       approvedBy:'saeed', approvedByUid:UIDS.saeed }, { merge:true });
    }));
  });

  test('يُمنع الإنشاء بالاعتماد على طلب مرفوض', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(),'requests',BOOKING_REQ_ID), { status:'rejected' });
    });
    const db = asSaeed();
    await assertFails(setDoc(doc(db,'bankPayments','bp_x'), bankPaymentFor()));
  });

  test('يُمنع الإنشاء بالاعتماد على طلب revoked/deleted', async () => {
    for (const st of ['revoked','deleted']) {
      await env.withSecurityRulesDisabled(async (ctx) => {
        await updateDoc(doc(ctx.firestore(),'requests',BOOKING_REQ_ID), { status: st });
      });
      await assertFails(setDoc(doc(asSaeed(),'bankPayments','bp_'+st), bankPaymentFor()));
    }
  });

  test('يُمنع الإنشاء نيابةً عن مستخدم لا يملك الطلب', async () => {
    const db = asSaeed();
    await assertFails(runTransaction(db, async (tx) => {
      const reqRef = doc(db,'requests',BOOKING_REQ_ID);
      await tx.get(reqRef);
      tx.set(doc(db,'bankPayments','bp_bad'), bankPaymentFor({ createdBy:'nader' }));
      tx.set(reqRef, { status:'approved', approvedBy:'saeed' }, { merge:true });
    }));
  });

  test('يُمنع الإنشاء بمبلغ مختلف عن مبلغ الحجز في payload', async () => {
    const db = asSaeed();
    await assertFails(runTransaction(db, async (tx) => {
      const reqRef = doc(db,'requests',BOOKING_REQ_ID);
      await tx.get(reqRef);
      tx.set(doc(db,'bankPayments','bp_amt'), bankPaymentFor({ amount: 999 }));
      tx.set(reqRef, { status:'approved', approvedBy:'saeed' }, { merge:true });
    }));
  });

  test('الموظف لا ينشئ دفعة نيابةً عن غيره', async () => {
    const db = asNader();   // صلاحية كاملة
    await assertFails(runTransaction(db, async (tx) => {
      const reqRef = doc(db,'requests',BOOKING_REQ_ID);
      await tx.get(reqRef);
      tx.set(doc(db,'bankPayments','bp_emp'), bankPaymentFor());
      tx.set(reqRef, { status:'approved', approvedBy:'nader' }, { merge:true });
    }));
  });

  test('الموظف ينشئ دفعته بنفسه (المسار العادي)', async () => {
    await assertSucceeds(setDoc(doc(asYahia(),'bankPayments','bp_own'),
      bankPaymentFor({ bookingId:'unit_u1p5', unitRef:'u1p5',
                       idempotencyKey:'yahia_u1p5_700' })));
  });
});

describe('٢ — اعتماد ورفض الدفعات', () => {

  test('سعيد يعتمد دفعة أنشأها يحيى', async () => {
    await seedPendingPayment('bp_1');
    await assertSucceeds(updateDoc(doc(asSaeed(),'bankPayments','bp_1'),
      { status:'approved', approvedAt:'x', approvedBy:'saeed', approvedByUid:UIDS.saeed }));
  });

  test('سعيد لا يعتمد دفعة أنشأها سعيد', async () => {
    await seedPendingPayment('bp_own', { createdBy:'saeed', createdByUid:UIDS.saeed });
    await assertFails(updateDoc(doc(asSaeed(),'bankPayments','bp_own'),
      { status:'approved', approvedAt:'x', approvedBy:'saeed' }));
  });

  test('موظف عادي لا يعتمد دفعة', async () => {
    await seedPendingPayment('bp_1');
    await assertFails(updateDoc(doc(asYahia(),'bankPayments','bp_1'),
      { status:'approved', approvedAt:'x', approvedBy:'yahia' }));
  });

  test('موظف بصلاحية كاملة لا يعتمد دفعة', async () => {
    await seedPendingPayment('bp_1');
    await assertFails(updateDoc(doc(asNader(),'bankPayments','bp_1'),
      { status:'approved', approvedAt:'x', approvedBy:'nader' }));
  });

  test('موظف عادي لا يرفض دفعة', async () => {
    await seedPendingPayment('bp_1');
    await assertFails(updateDoc(doc(asYahia(),'bankPayments','bp_1'),
      { status:'rejected', rejectedAt:'x', rejectedBy:'yahia' }));
  });

  test('اعتماد دفعة معتمدة مسبقاً مرفوض', async () => {
    await seedApprovedPayment('bp_1');
    await assertFails(updateDoc(doc(asSaeed(),'bankPayments','bp_1'),
      { status:'approved', approvedAt:'y', approvedBy:'saeed' }));
  });
});

describe('٣ — إلغاء الدفعة المعلّقة', () => {

  test('يحيى يلغي دفعته المعلّقة', async () => {
    await seedPendingPayment('bp_1');
    await assertSucceeds(updateDoc(doc(asYahia(),'bankPayments','bp_1'),
      { status:'cancelled', cancelledAt:'x', cancelledBy:'yahia', cancelReason:'خطأ' }));
  });

  test('نادر (صلاحية كاملة) لا يلغي دفعة يحيى', async () => {
    await seedPendingPayment('bp_1');
    await assertFails(updateDoc(doc(asNader(),'bankPayments','bp_1'),
      { status:'cancelled', cancelledAt:'x', cancelledBy:'nader', cancelReason:'x' }));
  });

  test('يحيى لا يلغي دفعة معتمدة', async () => {
    await seedApprovedPayment('bp_1');
    await assertFails(updateDoc(doc(asYahia(),'bankPayments','bp_1'),
      { status:'cancelled', cancelledAt:'x', cancelledBy:'yahia', cancelReason:'x' }));
  });

  test('سعيد يلغي دفعة معتمدة', async () => {
    await seedApprovedPayment('bp_1');
    await assertSucceeds(updateDoc(doc(asSaeed(),'bankPayments','bp_1'),
      { status:'cancelled', cancelledAt:'x', cancelledBy:'saeed', cancelReason:'إلغاء' }));
  });
});

describe('٤ — منع تغيير الحقول المالية والمرجعية أثناء update', () => {
  const CASES = [
    ['amount',          { amount: 9999 }],
    ['createdBy',       { createdBy:'nader' }],
    ['createdByUid',    { createdByUid:'uid_x' }],
    ['bookingId',       { bookingId:'other' }],
    ['monthKey',        { monthKey:'2026_8' }],
    ['unitRef',         { unitRef:'other' }],
    ['idempotencyKey',  { idempotencyKey:'k2' }],
    ['paymentDate',     { paymentDate:'2026-09-01' }],
    ['bankReference',   { bankReference:'TRX-9' }]
  ];
  for (const [name, extra] of CASES) {
    test(`الاعتماد مع تغيير ${name} مرفوض`, async () => {
      await seedPendingPayment('bp_1');
      await assertFails(updateDoc(doc(asSaeed(),'bankPayments','bp_1'),
        { status:'approved', approvedAt:'x', approvedBy:'saeed', ...extra }));
    });
  }
  test('إضافة حقل جانبي غير متوقع مرفوضة', async () => {
    await seedPendingPayment('bp_1');
    await assertFails(updateDoc(doc(asSaeed(),'bankPayments','bp_1'),
      { status:'approved', approvedAt:'x', approvedBy:'saeed', sneaky:true }));
  });
  test('الحذف مرفوض دائماً', async () => {
    await seedPendingPayment('bp_1');
    await assertFails(deleteDoc(doc(asSaeed(),'bankPayments','bp_1')));
  });
});

describe('٥ — الطلبات: انتقالات الحالة', () => {

  test('سعيد يعتمد طلب يحيى', async () => {
    await assertSucceeds(updateDoc(doc(asSaeed(),'requests',BOOKING_REQ_ID),
      { status:'approved', approvedAt:'x', approvedBy:'saeed', approvedByUid:UIDS.saeed }));
  });

  test('تغيير payload أثناء الاعتماد مرفوض', async () => {
    await assertFails(updateDoc(doc(asSaeed(),'requests',BOOKING_REQ_ID),
      { status:'approved', approvedAt:'x', approvedBy:'saeed',
        payload:{ booking:{ total: 5000 } } }));
  });

  test('تغيير by أو type أو year أو month أثناء الاعتماد مرفوض', async () => {
    for (const extra of [{by:'nader'},{type:'add_expense'},{year:2025},{month:1}]) {
      await env.clearFirestore();
      await env.withSecurityRulesDisabled(async (ctx) => {
        const db = ctx.firestore();
        for (const [uid,u] of Object.entries(USERS)) await setDoc(doc(db,'users',uid), u);
        await setDoc(doc(db,'config','permissions'), PERMISSIONS);
        await setDoc(doc(db,'requests',BOOKING_REQ_ID), BOOKING_REQ);
      });
      await assertFails(updateDoc(doc(asSaeed(),'requests',BOOKING_REQ_ID),
        { status:'approved', approvedAt:'x', approvedBy:'saeed', ...extra }));
    }
  });

  test('الموظف لا يعتمد طلبه', async () => {
    await assertFails(updateDoc(doc(asYahia(),'requests',BOOKING_REQ_ID),
      { status:'approved', approvedAt:'x', approvedBy:'yahia' }));
  });

  test('العكس من approved فقط، وممنوع بعد التصحيح', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(),'requests',BOOKING_REQ_ID),
        { status:'approved', corrected:true });
    });
    await assertFails(updateDoc(doc(asSaeed(),'requests',BOOKING_REQ_ID),
      { status:'revoked', revokedAt:'x', reversedBy:'saeed' }));
  });

  test('وسم التصحيح مرة واحدة فقط', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(),'requests',BOOKING_REQ_ID), { status:'approved' });
    });
    await assertSucceeds(updateDoc(doc(asSaeed(),'requests',BOOKING_REQ_ID),
      { corrected:true, correctedAt:'x', correctedBy:'saeed',
        correctedAmount:700, correctedDesc:'', correctedOperationId:'correct_1' }));
    await assertFails(updateDoc(doc(asSaeed(),'requests',BOOKING_REQ_ID),
      { corrected:true, correctedAt:'y', correctedBy:'saeed',
        correctedAmount:500, correctedDesc:'', correctedOperationId:'correct_2' }));
  });


  // ===== أُضيف من حزمة delivery — مع رقعة الـharness (const db مرة واحدة) =====

  test('🔒 التصحيح الأول ينجح على طلب بلا حقل corrected إطلاقاً', async () => {
    // seed لا يحتوي corrected — قراءة الحقل مباشرة كانت تسبب evaluation error
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();          // نسخة واحدة تُعاد استخدامها
      await updateDoc(doc(db,'requests',BOOKING_REQ_ID), { status:'approved' });
      const snap = await getDoc(doc(db,'requests',BOOKING_REQ_ID));
      assert.strictEqual('corrected' in snap.data(), false);
    });
    await assertSucceeds(updateDoc(doc(asSaeed(),'requests',BOOKING_REQ_ID),
      { corrected:true, correctedAt:'x', correctedBy:'saeed',
        correctedAmount:700, correctedDesc:'', correctedOperationId:'correct_first' }));
  });

  test('🔒 العكس ينجح على طلب بلا حقل corrected إطلاقاً', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await updateDoc(doc(db,'requests',BOOKING_REQ_ID), { status:'approved' });
    });
    await assertSucceeds(updateDoc(doc(asSaeed(),'requests',BOOKING_REQ_ID),
      { status:'revoked', revokedAt:'x', reversedBy:'saeed', reverseReason:'إلغاء' }));
  });

  test('حذف الطلب مرفوض', async () => {
    await assertFails(deleteDoc(doc(asSaeed(),'requests',BOOKING_REQ_ID)));
  });
});

describe('٦ — الأرصدة والتسويات والدفتر', () => {

  test('موظف عادي لا يكتب في الأرصدة', async () => {
    await assertFails(setDoc(doc(asYahia(),'config','balances'),
      { ...BALANCES, revenueBalance: 99999 }, { merge:true }));
  });

  test('الموظف لا يكتب في الأرصدة مهما كانت صلاحيات الواجهة', async () => {
    await assertFails(setDoc(doc(asNader(),'config','balances'),
      { ...BALANCES, revenueBalance: 3500 }, { merge:true }));
  });

  test('الموظف لا يكتب مستند الشهر مباشرة', async () => {
    await assertFails(setDoc(doc(asNader(),'months',MONTH_KEY),
      { data: MONTH_DOC.data, _rev: 2 }, { merge:true }));
  });

  test('الموظف لا ينشئ قيد دفتر مباشرة', async () => {
    await assertFails(setDoc(doc(asNader(),'ledger','employee_direct'), {
      amount:100,direction:'credit',account:'revenue',createdBy:'nader',idempotencyKey:'employee_direct'
    }));
  });

  for (const field of ['companyBalance','revenueBalance','installmentBalance']) {
    test(`${field} السالب مرفوض حتى على المالك`, async () => {
      await assertFails(setDoc(doc(asSaeed(),'config','balances'),
        { ...BALANCES, [field]: -1 }, { merge:true }));
    });
  }

  test('المالك ممنوع من الكتابة في config/auth', async () => {
    await assertFails(setDoc(doc(asSaeed(),'config','auth'),
      { enabled:true, secret:'forbidden' }));
  });

  test('المالك ممنوع من إنشاء مستند config عشوائي غير مصرّح به', async () => {
    await assertFails(setDoc(doc(asSaeed(),'config','unexpected'),
      { value:1 }));
  });

  test('مادة PIN محجوبة عن جميع عملاء Firestore حتى المالك', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(),'authPins','saeed'),
        { uid:UIDS.saeed, pinHash:'x', pinSalt:'y', active:true });
    });
    await assertFails(getDoc(doc(asSaeed(),'authPins','saeed')));
    await assertFails(setDoc(doc(asSaeed(),'authPins','saeed'), { pinHash:'changed' }, { merge:true }));
    await assertFails(getDoc(doc(asYahia(),'authPins','saeed')));
  });

  test('مسارات config المصرّح بها تستمر وفق الأدوار الحالية', async () => {
    await assertSucceeds(setDoc(doc(asSaeed(),'config','permissions'), PERMISSIONS));
    await assertSucceeds(setDoc(doc(asSaeed(),'config','unlock'),
      { active:true, until:'2026-08-08T00:00:00.000Z' }));
    await assertSucceeds(setDoc(doc(asSaeed(),'config','customUnits'),
      { data:[], updatedBy:'saeed' }));

    // صلاحية الموظف الكاملة تسمح بالأرصدة فقط، ولا تمنحه إدارة إعدادات النظام.
    await assertFails(setDoc(doc(asNader(),'config','permissions'), PERMISSIONS));
    await assertFails(setDoc(doc(asNader(),'config','unlock'), { active:false }));
    await assertFails(setDoc(doc(asNader(),'config','customUnits'), { data:[] }));
  });

  test('الموظف لا ينشئ تسوية ولو بالصلاحية الكاملة', async () => {
    await assertFails(setDoc(doc(asNader(),'balanceAdjustments','adj_1'),
      { account:'company', type:'add', amount:100, reason:'x',
        status:'active', createdBy:'nader', monthKey:MONTH_KEY }));
  });

  test('تسوية بلا سبب مرفوضة', async () => {
    await assertFails(setDoc(doc(asSaeed(),'balanceAdjustments','adj_2'),
      { account:'company', type:'add', amount:100, reason:'',
        status:'active', createdBy:'saeed', monthKey:MONTH_KEY }));
  });


  // ===== أُضيف من حزمة delivery: تغطية config بعد حذف القاعدة العامة =====

  test('🔒 المالك ممنوع من الكتابة في config/auth', async () => {
    await assertFails(setDoc(doc(asSaeed(),'config','auth'), { codes: { saeed:'1325' } }));
  });

  test('🔒 المالك ممنوع من قراءة config/auth', async () => {
    await assertFails(getDoc(doc(asSaeed(),'config','auth')));
  });

  test('🔒 مستند config عشوائي غير مصرّح به مرفوض كتابةً وقراءةً', async () => {
    await assertFails(setDoc(doc(asSaeed(),'config','anything'), { x:1 }));
    await assertFails(getDoc(doc(asSaeed(),'config','anything')));
  });

  test('✅ balances: قيم غير سالبة من المالك مسموحة', async () => {
    await assertSucceeds(setDoc(doc(asSaeed(),'config','balances'),
      { companyBalance: 6000, revenueBalance: 2500,
        installmentBalance: 0, installmentSchedule: [] }, { merge:true }));
  });

  test('✅ permissions: المدير يكتب والموظف يقرأ فقط', async () => {
    await assertSucceeds(setDoc(doc(asSaeed(),'config','permissions'),
      { data: { yahia:{allMonths:true, needApproval:true},
                nader:{allMonths:true, needApproval:false} } }));
    await assertSucceeds(getDoc(doc(asYahia(),'config','permissions')));
    await assertFails(setDoc(doc(asYahia(),'config','permissions'),
      { data: { yahia:{allMonths:true, needApproval:false} } }));
  });

  test('✅ unlock: المدير يكتب والموظف يقرأ فقط', async () => {
    await assertSucceeds(setDoc(doc(asSaeed(),'config','unlock'),
      { key: MONTH_KEY, at:'2026-08-01T10:00:00.000Z', by:'saeed' }));
    await assertSucceeds(getDoc(doc(asYahia(),'config','unlock')));
    await assertFails(setDoc(doc(asYahia(),'config','unlock'),
      { key: MONTH_KEY, at:'x', by:'yahia' }));
  });

  test('✅ customUnits: المدير يكتب والموظف يقرأ فقط', async () => {
    await assertSucceeds(setDoc(doc(asSaeed(),'config','customUnits'),
      { data: { units:[], full:[] } }));
    await assertSucceeds(getDoc(doc(asYahia(),'config','customUnits')));
    await assertFails(setDoc(doc(asYahia(),'config','customUnits'),
      { data: { units:[{id:'x'}], full:[] } }));
  });

  test('لا أحد يعدّل أو يحذف قيد Ledger', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(),'ledger','led_1'),
        { entryId:'led_1', amount:100, direction:'credit', account:'revenue',
          createdBy:'saeed', idempotencyKey:'k', monthKey:MONTH_KEY });
    });
    await assertFails(updateDoc(doc(asSaeed(),'ledger','led_1'), { amount: 1 }));
    await assertFails(deleteDoc(doc(asSaeed(),'ledger','led_1')));
  });

  test('لا أحد يعدّل دوره ولا userKey', async () => {
    await assertFails(updateDoc(doc(asSaeed(),'users',UIDS.saeed), { role:'owner' }));
    await assertFails(updateDoc(doc(asSaeed(),'users',UIDS.yahia), { userKey:'saeed' }));
  });

  test('غير مسجّل الدخول لا يقرأ شيئاً', async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db,'months',MONTH_KEY)));
  });
});

describe('٧ — الذرّية والتكرار', () => {

  test('فشل كتابة واحدة يُسقط المعاملة كاملة', async () => {
    const db = asSaeed();
    await assertFails(runTransaction(db, async (tx) => {
      const monRef = doc(db,'months',MONTH_KEY);
      const mon = await tx.get(monRef);
      tx.set(monRef, { data: mon.data().data, _rev: mon.data()._rev + 1 }, { merge:true });
      tx.set(doc(db,'ledger','led_bad'), { amount:-5, direction:'credit',
        account:'revenue', createdBy:'saeed', idempotencyKey:'k' });   // مبلغ سالب → رفض
    }));
    // الشهر لم يتغير
    await env.withSecurityRulesDisabled(async (ctx) => {
      const s = await getDoc(doc(ctx.firestore(),'months',MONTH_KEY));
      assert.strictEqual(s.data()._rev, 1);
    });
  });

  test('_rev غير المتقدّم مرفوض (يمنع الكتابة فوق نسخة أحدث)', async () => {
    await assertFails(setDoc(doc(asSaeed(),'months',MONTH_KEY),
      { data: MONTH_DOC.data, _rev: 1 }, { merge:true }));
  });

  test('شهر قديم بلا _rev يقبل أول تحديث آمن إلى 1', async () => {
    const legacyId='2026_legacy_no_rev';
    await env.withSecurityRulesDisabled(async ctx=>{
      await setDoc(doc(ctx.firestore(),'months',legacyId),{data:MONTH_DOC.data});
    });
    await assertSucceeds(setDoc(doc(asSaeed(),'months',legacyId),
      {data:MONTH_DOC.data,_rev:1},{merge:true}));
  });

  test('إعادة إرسال نفس المعاملة لا تنشئ دفعة مكررة', async () => {
    const db = asSaeed();
    const run = () => runTransaction(db, async (tx) => {
      const reqRef = doc(db,'requests',BOOKING_REQ_ID);
      const snap = await tx.get(reqRef);
      if (snap.data().status !== 'pending') throw new Error('ALREADY_PROCESSED');
      tx.set(doc(db,'bankPayments','bp_det'), bankPaymentFor());
      tx.set(reqRef, { status:'approved', approvedAt:'x',
                       approvedBy:'saeed', approvedByUid:UIDS.saeed }, { merge:true });
    });
    await assertSucceeds(run());
    await assert.rejects(run());   // الثانية ترفض لأن الطلب لم يعد pending
  });

  test('جهازان بنفس _rev: واحد فقط ينجح والثاني يرى تعارضاً', async () => {
    const saveFromDevice=(db,device)=>runTransaction(db,async tx=>{
      const ref=doc(db,'months',MONTH_KEY);const snap=await tx.get(ref);
      if(Number(snap.data()._rev)!==1)throw new Error('STALE');
      tx.set(ref,{data:{...snap.data().data,device},_rev:2},{merge:true});
    });
    const results=await Promise.allSettled([
      saveFromDevice(asSaeed(),'device-A'),saveFromDevice(as(UIDS.manager),'device-B')
    ]);
    assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(results.filter(x=>x.status==='rejected').length,1);
    await env.withSecurityRulesDisabled(async ctx=>{
      const s=await getDoc(doc(ctx.firestore(),'months',MONTH_KEY));assert.equal(s.data()._rev,2);
    });
  });
});

describe('٨ — Canonical v2 backend-only وfinance غير mapped', () => {
  async function seedCanonical(){
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db=ctx.firestore();
      await setDoc(doc(db,'canonicalState','main'),{schemaVersion:2,version:1,state:{balances:{company:0,revenue:0,deduction:0}}});
      await setDoc(doc(db,'financialOperations','op_test_1'),{actorUid:UIDS.yahia,status:'completed',payloadHash:'x'});
      await setDoc(doc(db,'operationalProjections','2026_07'),{targetFils:100});
      await setDoc(doc(db,'financialProjections','2026_07'),{revenueFils:100});
      await setDoc(doc(db,'auditEvents','audit_1'),{actorId:'yahia',at:'x'});
      await setDoc(doc(db,'users','uid_finance'),{userKey:'finance_legacy',role:'finance',name:'مالية قديمة',active:true});
    });
  }
  test('لا عميل يكتب canonicalState حتى المالك', async()=>{
    await seedCanonical();
    await assertFails(updateDoc(doc(asSaeed(),'canonicalState','main'),{version:2}));
    await assertFails(setDoc(doc(asYahia(),'financialOperations','op_client'),{status:'completed'}));
    await assertFails(setDoc(doc(asSaeed(),'auditEvents','audit_client'),{at:'x'}));
  });
  test('الموظف يقرأ projection التشغيلي فقط ولا يقرأ state أو balances projection', async()=>{
    await seedCanonical();
    await assertSucceeds(getDoc(doc(asYahia(),'operationalProjections','2026_07')));
    await assertFails(getDoc(doc(asYahia(),'canonicalState','main')));
    await assertFails(getDoc(doc(asYahia(),'financialProjections','2026_07')));
    await assertFails(getDoc(doc(asYahia(),'auditEvents','audit_1')));
  });
  test('الموظف يقرأ نتيجة عمليته فقط', async()=>{
    await seedCanonical();
    await assertSucceeds(getDoc(doc(asYahia(),'financialOperations','op_test_1')));
    await assertFails(getDoc(doc(asNader(),'financialOperations','op_test_1')));
  });
  test('دور finance القديم لا يقرأ canonical state ولا projections المالية الجديدة', async()=>{
    await seedCanonical(); const finance=as('uid_finance');
    await assertFails(getDoc(doc(finance,'canonicalState','main')));
    await assertFails(getDoc(doc(finance,'financialProjections','2026_07')));
  });
});
