# تعليمات تشغيل مرشح v11 بأمان

لا تستبدل النظام الفعّال مباشرة. هذه الحزمة تحافظ على واجهة PIN، لكن الانتقال يتطلب Staging وترحيلاً غير هدّاماً.

## قبل Staging

```bash
npm install
npm test
npm run test:rules
npm run backup -- --project PRODUCTION_PROJECT --out backups/before.json
```

من كل جهاز قديم شغّل محتوى `scripts/export_legacy_localstorage.js` في Console، ثم:

```bash
npm run audit:legacy-local -- device-export.json backups/before.json
```

توقف إذا ظهرت بيانات محلية غير موجودة في Firebase.

إذا كان شهر موجوداً محلياً وغير موجود في Staging، خطط لاستيراده ثم طبقه. المستند الموجود لا يُستبدل أبداً، وأي اختلاف يوقف الأداة:

```bash
npm run legacy:import-plan -- --project STAGING_PROJECT --file device-export.json
npm run legacy:import-apply -- --project STAGING_PROJECT --file device-export.json
```

## المستخدمون والـPIN

الأمر تفاعلي ولا يضع PIN في سجل الأوامر. أمثلة القدرات اختيارية، ولا تمنح الموظف حفظاً مباشراً:

```bash
npm run pin:set -- --project STAGING_PROJECT manager "المدير" owner
npm run pin:set -- --project STAGING_PROJECT --capabilities deposits,showCollectionSummary,monthWindow=1 collector "المحصّل" employee
npm run pin:set -- --project STAGING_PROJECT --capabilities hideLateTotals field "الموظف" employee
```

## خطة الترحيل

```bash
npm run migrate:plan -- --project STAGING_PROJECT
```

الخطة لا تكتب شيئاً. إذا ظهر تاريخ 2013 أو بداية بعد النهاية، راجعه يدوياً. بعد اعتماد التقرير فقط:

```bash
npm run migrate:apply -- --project STAGING_PROJECT
```

الترحيل يضيف دفعات بنكية مستقلة وقيوداً افتتاحية، ولا يحذف أو يغيّر مستندات الشهور.

## اختبارات القبول على Staging

- دخول كل مستخدم بالـPIN وصحة الدور والشاشات.
- مقارنة كل شهر ووحدة ومستأجر وتاريخ ومبلغ قبل/بعد.
- جهازان يعدلان السجل نفسه: واحد ينجح والآخر يرى تعارضاً بلا فقد بيانات.
- فصل الشبكة أثناء الاعتماد: لا رسالة نجاح ولا تغير مالي؛ بعد العودة إعادة المحاولة تنفذ مرة واحدة.
- ضغط مزدوج على اعتماد/إيداع/مصروف/دفعة بنك: مستند وقيد واحد فقط.
- دفعتان بنكيتان جزئيتان لنفس الوحدة بمراجع مختلفة، ثم اعتماد كل واحدة مستقلاً.
- إضافة/تصحيح/عكس الإيداع والمصروف والصيانة والأرباح والقسط والتحويل والتسليم.
- إثبات لكل حساب: الرصيد الافتتاحي + credits − debits = الرصيد الحالي.
- فحص الحجم: `npm run test:size -- month-export.json`. تحذير عملي عند 700 KB، مع تقسيم السجلات قبل حد Firestore البالغ قرابة 1 MiB.

بعد الاختبار صدّر Staging وقارن:

```bash
npm run backup -- --project STAGING_PROJECT --out backups/after.json
npm run audit:preservation -- backups/before.json backups/after.json
```

لا تنشر Rules وحدها؛ النسخة القديمة بلا Firebase Auth ستتوقف. النشر — إن تقرر لاحقاً — يكون HTML + Functions + Rules بعد نجاح جميع البنود وتسجيل الحالات غير المختبرة.
