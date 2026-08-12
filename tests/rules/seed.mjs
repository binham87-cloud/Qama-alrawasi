// بيانات seed موحّدة لاختبارات القواعد
export const UIDS = { saeed:'uid_saeed', yahia:'uid_yahia', nader:'uid_nader', manager:'uid_manager' };

export const USERS = {
  [UIDS.saeed]: { userKey:'saeed', role:'owner',    name:'مدير', active:true },
  [UIDS.yahia]: { userKey:'yahia', role:'employee', name:'يحيى', active:true },
  [UIDS.nader]: { userKey:'nader', role:'employee', name:'نادر', active:true }
  ,[UIDS.manager]: { userKey:'manager', role:'manager', name:'مدير ثانٍ', active:true }
};

// ملاحظة مهمة على needApproval:false أدناه:
// هذه **حالة قديمة/عدائية** محفوظة عمداً في الـseed، وليست «صلاحية كاملة».
// القرار المعتمد: كل الموظفين يرسلون للاعتماد دائماً، و allMonths توسّع نطاق
// الشهور فقط. وجود needApproval:false هنا يثبت أن القواعد **ترفضه** ولا تمنح
// الموظف أي حفظ مالي مباشر مهما كانت قيمة الحقل في config/permissions.
export const PERMISSIONS = {
  data: {
    yahia: { allMonths:false, needApproval:true  },   // موظف عادي
    nader: { allMonths:true,  needApproval:false }    // حالة عدائية — القواعد يجب أن ترفض الكتابة المباشرة
  }
};

export const BALANCES = {
  companyBalance: 5000, revenueBalance: 3000,
  installmentBalance: 2000, installmentSchedule: []
};

export const MONTH_KEY = '2026_7';
export const MONTH_DOC = { data:{ units:[], full:[], transactions:[], expenses:[],
  unitMaintenance:[], facilityMaintenance:[], dailyBookings:[], handovers:[],
  profits:[], installments:[], logs:[] }, _rev: 1 };

// طلب حجز يومي بنكي أنشأه يحيى — الأساس لاختبارات الإنشاء نيابةً
export const BOOKING_REQ_ID = 'req_booking_1';
export const BOOKING_REQ = {
  id: BOOKING_REQ_ID, type:'add_daily', by:'yahia', status:'pending',
  desc:'حجز يومي — شقة 101', year:2026, month:7,
  createdAt:'2026-08-01T10:00:00.000Z',
  payload:{ booking:{ total:700, status:'paid', paidAt:'2026-08-01T10:00:00.000Z',
                      paymentMethod:'bank', partLabel:'شقة 101', guest:'ضيف' } }
};

export function bankPaymentFor(overrides={}){
  return {
    idempotencyKey:'booking_'+BOOKING_REQ_ID,
    unitRef:'booking_'+BOOKING_REQ_ID,
    unitLabel:'حجز يومي شقة 101', tenant:'ضيف',
    unitId:'', partId:null, contractCycle:'', monthKey:MONTH_KEY,
    amount:700, method:'bank', bankReference:'TRX-1', paymentDate:'2026-08-01',
    status:'pending', bookingId:BOOKING_REQ_ID,
    createdBy:'yahia', createdByUid:UIDS.yahia,
    createdAt:'2026-08-01T10:00:00.000Z',
    approvedBy:null, approvedAt:null, cancelledAt:null, cancelReason:null,
    ...overrides
  };
}
