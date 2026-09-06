import { initializeApp } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-app.js";
import { getAuth, signInWithCustomToken, signOut, setPersistence, inMemoryPersistence, browserLocalPersistence, connectAuthEmulator } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-auth.js";
import { getFunctions, httpsCallable, connectFunctionsEmulator } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-functions.js";

const firebaseConfig = {
  apiKey: "AIzaSyBs0wIu2h2mnNMGr5SH-YNXjUhrdrGSNKg",
  authDomain: "qama-new-prod-2026.firebaseapp.com",
  projectId: "qama-new-prod-2026",
  storageBucket: "qama-new-prod-2026.firebasestorage.app",
  messagingSenderId: "691374873380",
  appId: "1:691374873380:web:aa862cbb8b40b65d2e71b1"
};
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const fns = getFunctions(fbApp, "me-central1");
const __QAMA_EMULATOR__ = typeof location !== "undefined" && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
if (__QAMA_EMULATOR__) {
  try {
    connectAuthEmulator(auth, `http://${location.hostname}:9099`, { disableWarnings: true });
    connectFunctionsEmulator(fns, location.hostname, 5001);
    console.info("[qama] emulator mode", location.hostname);
  } catch (e) { console.warn("[qama] emulator connect", e); }
}
const db = { _engine: true };

const AUTH_EMAILS = { saeed:"saeed@qama-alrawasi.app", yahia:"yahia@qama-alrawasi.app", nader:"nader@qama-alrawasi.app" };
const AUTH_PASS_SUFFIX = "-Qama#2026!Sec";
const PIN_LEN = 4;
const NEW_UID = {
  saeed: "mig:user:owner:saeed",
  yahia: "mig:user:yahia",
  nader: "mig:user:nader"
};
const UID_TO_KEY = {
  "mig:user:owner:saeed": "saeed",
  "mig:user:yahia": "yahia",
  "mig:user:nader": "nader"
};

function isIosLike() {
  const ua = navigator.userAgent || "";
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
setPersistence(auth, isIosLike() ? inMemoryPersistence : browserLocalPersistence).catch(() => {});

const callFn = (name, payload) => httpsCallable(fns, name)(payload).then((r) => r.data);
function opId(tag) {
  const u = (crypto.randomUUID?.() || (Date.now() + "-" + Math.random())).toString().replace(/-/g, "");
  return (String(tag) + "-" + u).slice(0, 120);
}
/** Stable intent for true retries; never reuse across different logical payloads. */
function intentKey(...parts) {
  return parts.map((p) => String(p ?? "").replace(/[^A-Za-z0-9_:.-]/g, "").slice(0, 40)).filter(Boolean).join("-").slice(0, 100);
}
/** Compact obligation id so pay/uncol keys keep L/A suffixes inside 120 chars. */
function shortOb(ob) {
  const s = String(ob || "");
  if (s.length <= 48) return s.replace(/[^A-Za-z0-9_:.-]/g, "");
  return (s.slice(0, 24) + "_" + s.slice(-20)).replace(/[^A-Za-z0-9_:.-]/g, "");
}
function receiptCounts(receipts) {
  const list = Array.isArray(receipts) ? receipts : [];
  let live = 0;
  for (const r of list) {
    if (r && (r.state === "recognized" || r.state === "pending")) live++;
  }
  return { live, all: list.length };
}
function collectionOpKey(obligationId, wantFils, deltaFils, receipts) {
  const { live, all } = receiptCounts(receipts);
  return (`pay-${shortOb(obligationId)}-w${wantFils}-d${deltaFils}-L${live}-A${all}`).slice(0, 120);
}
function uncollectOpKey(obligationId, alreadyFils, receipts) {
  const list = Array.isArray(receipts) ? receipts : [];
  const { live, all } = receiptCounts(list);
  // Missing history → fresh opId (never sticky uncol-{ob}-p{already} across cycles).
  if (!list.length && alreadyFils > 0) return opId("uncol-" + shortOb(obligationId));
  return (`uncol-${shortOb(obligationId)}-p${alreadyFils}-L${live}-A${all}`).slice(0, 120);
}
/**
 * Run a command with an optional stable operationId.
 * If the server reports IDEMPOTENCY_PAYLOAD_MISMATCH (stale opId reused for a
 * NEW edit), retry once with a fresh unique opId so legitimate UI saves never
 * die with «تعذر الحفظ أونلاين».
 */
async function engineCommand(command, payload, intent) {
  const first = (intent && String(intent).slice(0, 120)) || opId(command);
  try {
    return await callFn("command", { command, payload, operationId: first });
  } catch (e) {
    const msg = String((e && (e.message || e.code)) || e);
    if (!/IDEMPOTENCY_PAYLOAD_MISMATCH/i.test(msg)) throw e;
    const fresh = opId((intent || command) + "-n");
    console.warn("opId stale → retry fresh", command, first, "→", fresh);
    return callFn("command", { command, payload, operationId: fresh });
  }
}

/** Map engine/domain codes to specific Arabic operator messages (never PINs). */
function formatEngineError(err) {
  const raw = String((err && (err.message || err.code || err.details)) || err || "");
  // Callable HttpsError: message is often the domain code; figures live in details.
  const details = (err && (err.details || err.customData || err.data)) || {};
  const detailObj = typeof details === "object" && details ? details : {};
  const holdingFils = detailObj.holdingFils ?? detailObj.sharedHoldingAfterFils;
  const attemptedFils = detailObj.attemptedFils;
  const holdAed = holdingFils != null ? (Number(holdingFils) / 100).toLocaleString("en-US") : null;
  const tryAed = attemptedFils != null ? (Number(attemptedFils) / 100).toLocaleString("en-US") : null;

  if (/AMOUNT_EXCEEDS_HOLDING/i.test(raw)) {
    if (holdAed != null && tryAed != null) {
      return `المبلغ يتجاوز العهدة المشتركة المتاحة (${tryAed} من ${holdAed} د.إ)`;
    }
    return "المبلغ يتجاوز العهدة المشتركة المتاحة (Holding)";
  }
  if (/CUSTODY_RECONCILIATION_ERROR/i.test(raw)) {
    return holdAed != null
      ? `خطأ مطابقة العهدة — العهدة المشتركة سالبة (${holdAed} د.إ). أوقف الإيداع حتى التسوية.`
      : "خطأ مطابقة العهدة — العهدة المشتركة سالبة. أوقف الإيداع حتى التسوية.";
  }
  if (/RECEIPT_ALREADY_DEPOSITED/i.test(raw)) {
    return "لا يمكن عكس الإيصال — المبلغ مضمّن في إيداع معتمد. اعكس الإيداع أولاً.";
  }
  if (/AMOUNT_EXCEEDS_REMAINING/i.test(raw)) return "المبلغ يتجاوز المتبقي على الالتزام";
  if (/TENANT_REQUIRED/i.test(raw)) return "اسم المستأجر مطلوب قبل التأجير";
  if (/INVALID_AMOUNT/i.test(raw)) return "المبلغ غير صالح — أدخل مبلغاً أكبر من صفر";
  if (/FORBIDDEN/i.test(raw)) return "غير مسموح لهذه الصلاحية";
  if (/ALREADY_REVERSED/i.test(raw)) return "تم العكس مسبقاً";
  if (/DEPOSIT_NOT_APPROVED/i.test(raw)) return "الإيداع غير معتمد — لا يمكن عكسه بهذا المسار";
  if (/NEGATIVE_HOLDING/i.test(raw)) return "العهدة المشتركة سالبة — أوقف الإيداع حتى التسوية";
  if (/IDEMPOTENCY_PAYLOAD_MISMATCH/i.test(raw)) return "تعارض في مفتاح العملية — أعد المحاولة";
  if (/network|unavailable|Failed to fetch|internal/i.test(raw)) return "تعذر الاتصال بالخادم — تحقق من الشبكة";
  const short = raw.replace(/^FirebaseError:\s*/i, "").replace(/^functions\//i, "").slice(0, 160);
  return short || "تعذر الحفظ أونلاين";
}
function periodOfMonth(y, m) {
  return Number(y) + "-" + String(Number(m) + 1).padStart(2, "0");
}
function aedToFils(n) {
  const t = Number(n || 0);
  if (!Number.isFinite(t) || t < 0) return 0;
  const [w, f = "00"] = t.toFixed(2).split(".");
  return Number(w) * 100 + Number((f + "00").slice(0, 2));
}
function filsToAed(n) { return Number(n || 0) / 100; }
function engineToday() {
  try { if (typeof todayISO === "function") return todayISO(); } catch (e) {}
  return new Date().toISOString().slice(0, 10);
}
function serverTimestamp() { return new Date().toISOString(); }
function doc(_db, col, id) { return { _col: col, _id: String(id) }; }
function makeSnap(exists, data) {
  return { exists: () => !!exists, data: () => data || {}, id: data && data.id };
}

async function secureLogin(userKey, pin) {
  try {
    if (auth.currentUser) { try { await signOut(auth); } catch (e) {} }
    const res = await callFn("login", { userId: NEW_UID[userKey], pin: String(pin) });
    await signInWithCustomToken(auth, res.customToken);
    S._actor = res.user;
    return { ok: true };
  } catch (e) {
    const code = String((e && (e.code || e.message)) || e);
    if (/TOO_MANY|resource-exhausted/i.test(code)) return { ok: false, err: "auth/too-many-requests" };
    if (/network|unavailable|Failed to fetch|internal/i.test(code)) return { ok: false, err: "auth/network-request-failed" };
    return { ok: false, err: "auth/wrong-password" };
  }
}

async function pinHash(userKey, pin) {
  const enc = new TextEncoder().encode("qama|" + userKey + "|" + pin + "|v1");
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function unitMeta(name) {
  const n = String(name || "");
  if (/101/.test(n) && !/سطح/.test(n)) return { type: "شباب", color: "#3B82F6" };
  if (/202|203|204|301/.test(n)) return { type: "بنات", color: "#EC4899" };
  if (/302|ميزان/.test(n)) return { type: "رجال", color: "#10B981" };
  if (/سطح/.test(n)) return { type: "سطح", color: "#f59e0b" };
  return { type: "شقة", color: "#888888" };
}
function spacePartId(space) {
  const n = String(space.name || "");
  const m = n.match(/\/\s*(\d+)\s*$/);
  if (m) return Number(m[1]);
  if (/^\d+$/.test(n)) return n;
  return space.spaceId;
}
function wholeDisplayId(unit) {
  const n = String(unit.name || "");
  if (/^\d+$/.test(n)) return n;
  const m = n.match(/شقة\s*(.+)$/);
  if (m) return m[1].trim();
  return n;
}
function engineStatusToOld(sp) {
  const st = sp.status;
  if (st === "staff" || sp.occupancy === "staff") return { status: "staff", partial: false, paid_amount: 0 };
  if (st === "vacant" || sp.occupancy === "vacant") return { status: "vacant", partial: false, paid_amount: 0 };
  const paid = filsToAed(sp.paidFils);
  const rent = filsToAed(sp.dueFils);
  if (st === "partial") return { status: "late", partial: true, paid_amount: paid };
  if (st === "collected") return { status: "collected", partial: false, paid_amount: paid || rent };
  if (st === "not_due") return { status: "pending", partial: false, paid_amount: paid };
  return { status: "late", partial: false, paid_amount: paid };
}

/**
 * Draft partial/paid from extras may survive hydrate for mid-edit only.
 * NEVER resurrect after uncollect/reverse, and NEVER carry into a new rental.
 * (Source of truth: draft_partial_merge.mjs — keep in sync / assembled prepend.)
 */
function mergeDraftPartial(mapped, extra, sp) {
  const enginePaid = Number(mapped.paid_amount || 0);
  if (enginePaid > 0 || mapped.partial) {
    return { partial: !!mapped.partial, paid_amount: enginePaid || Number(mapped.paid_amount || 0) };
  }
  const draftPartial = !!extra.partial;
  const draftPaid = Number(extra.paid_amount || 0) || 0;
  if (!draftPartial && draftPaid <= 0) {
    return { partial: false, paid_amount: 0 };
  }
  if (mapped.status === "vacant" || mapped.status === "staff") {
    return { partial: draftPartial, paid_amount: draftPaid };
  }
  const rentalId = (sp && sp.rentalId) || "";
  const draftFor = extra.draftForRentalId != null ? String(extra.draftForRentalId) : null;
  if (draftFor != null && draftFor !== "" && rentalId && draftFor !== rentalId) {
    return { partial: false, paid_amount: 0 };
  }
  const receipts = Array.isArray(sp && sp.spaceReceipts) ? sp.spaceReceipts : [];
  const hasRecognized = receipts.some((r) => r && r.state === "recognized");
  const hasReversed = receipts.some((r) => r && r.state === "reversed");
  if (hasRecognized) return { partial: false, paid_amount: enginePaid };
  if (hasReversed) return { partial: false, paid_amount: 0 };
  return { partial: draftPartial, paid_amount: draftPaid };
}

function applyUiConfig(ui) {
  if (!ui || !ui.config) return;
  const c = ui.config;
  if (c.permissions) {
    const p = c.permissions.data || c.permissions;
    if (p && typeof p === "object") {
      S.permissions = p;
      try { localStorage.setItem("qama_permissions", JSON.stringify(p)); } catch (e) {}
    }
  }
  if (c.locks) {
    const l = c.locks.data || c.locks;
    if (l && typeof l === "object") {
      S.lockedMonths = l;
      try { localStorage.setItem("qama_locks", JSON.stringify(l)); } catch (e) {}
    }
  }
  if (c.balances) {
    const b = c.balances;
    if (b.companyBalance != null && !S.showEditCompany) S.companyBalance = b.companyBalance;
    if (b.revenueBalance != null && !S.showEditRevenue) S.revenueBalance = b.revenueBalance;
    if (b.installmentBalance != null) S.installmentBalance = b.installmentBalance;
    if (typeof ensureInstallmentSchedule === "function") {
      S.installmentSchedule = ensureInstallmentSchedule(b.installmentSchedule);
    } else if (Array.isArray(b.installmentSchedule) && b.installmentSchedule.length) {
      S.installmentSchedule = b.installmentSchedule;
    }
  }
  if (c.customUnits) {
    const cu = c.customUnits.data || c.customUnits;
    if (cu) try { localStorage.setItem("qama_custom_units", JSON.stringify(cu)); } catch (e) {}
  }
}

/**
 * Strip collect/tenant paint only for real vacate leftovers — never because a timer expired.
 * Active pre-rental drafts (no draftForRentalId / no draftClearedByVacate) are kept as draft.
 */
function isVacateResidueExtra(extra, sp, mapped) {
  if (!extra) return false;
  if (sp && sp.rentalId) return false;
  if (!(mapped && (mapped.status === "vacant" || mapped.status === "staff"))) return false;
  if (!["collected", "late", "pending"].includes(String(extra.status || ""))) return false;
  if (extra.draftClearedByVacate) return true;
  const bound = extra.draftForRentalId != null ? String(extra.draftForRentalId) : "";
  if (bound) return true; // bound to a rental that no longer occupies this space
  return false;
}

function mapDashboardToMonth(dash) {
  const extras = (dash.ui && dash.ui.extras) || {};
  const extraBySpace = extras.spaces || {};
  const units = [];
  const full = [];
  for (const u of (dash.unitsTree || [])) {
    const meta = unitMeta(u.name);
    if (u.isWhole || u.kind === "whole") {
      const sp = (u.spaces && u.spaces[0]) || {};
      const mapped = engineStatusToOld(sp);
      const extra = extraBySpace[sp.spaceId] || {};
      const engineRent = filsToAed(sp.dueFils != null ? sp.dueFils : u.dueFils);
      const draftRent = Number(extra.rent || 0) || 0;
      full.push({
        id: wholeDisplayId(u),
        // Vacant cards have dueFils=0; keep UI draft rent from extras so mid-edit saves
        // (tenant/start date) do not zero the rent the user already typed.
        rent: (mapped.status === "vacant" || mapped.status === "staff")
          ? (draftRent || engineRent)
          : (engineRent || draftRent),
        tenant: (() => {
          const abandoned = isVacateResidueExtra(extra, sp, mapped);
          return abandoned ? "" : (sp.tenantName || extra.tenant || "");
        })(),
        phone: extra.phone || sp.tenantPhone || "",
        note: extra.note || "",
        start_date: extra.start_date || sp.startDate || "",
        due_date: sp.dueDate || extra.due_date || "",
        elec_paid: !!extra.elec_paid,
        elec_amount: Number(extra.elec_amount || 0),
        deposit: extra.deposit || "",
        collectionMethod: extra.collectionMethod || "",
        collectedBy: extra.collectedBy || "",
        rent_type: extra.rent_type || "monthly",
        draftSessionId: extra.draftSessionId || "",
        draftClearedByVacate: !!extra.draftClearedByVacate,
        draftForRentalId: extra.draftForRentalId || "",
        ...mapped,
        ...mergeDraftPartial(mapped, (() => {
          const abandoned = isVacateResidueExtra(extra, sp, mapped);
          return abandoned ? { ...extra, tenant: "", status: mapped.status, collectionMethod: "", partial: false, paid_amount: 0 } : extra;
        })(), sp),
        ...mergeDraftStatus(mapped, (() => {
          const abandoned = isVacateResidueExtra(extra, sp, mapped);
          return abandoned ? { ...extra, tenant: "", status: mapped.status, collectionMethod: "", partial: false, paid_amount: 0 } : extra;
        })(), sp),
        _unitId: u.unitId,
        _spaceId: sp.spaceId,
        _rentalId: sp.rentalId,
        _obligationId: sp.obligationId,
        _enginePaid: filsToAed(sp.paidFils),
        _receipts: sp.spaceReceipts || [],
        _tenantCommitted: sp.tenantName || "",
      });
    } else {
      const partitions = (u.spaces || []).map((sp) => {
        const mapped = engineStatusToOld(sp);
        const extra = extraBySpace[sp.spaceId] || {};
        const engineRent = filsToAed(sp.dueFils);
        const draftRent = Number(extra.rent || 0) || 0;
        // Vacate leftovers (bound prior rental / explicit clear) vs active pre-rental draft.
        // Timer expiry is NOT abandonment — slow typing / reconnect / failed create keep draft.
        const abandonedDraft = isVacateResidueExtra(extra, sp, mapped);
        const extraUse = abandonedDraft
          ? { ...extra, tenant: "", status: mapped.status, collectionMethod: "", partial: false, paid_amount: 0 }
          : extra;
        return {
          id: spacePartId(sp),
          rent: (mapped.status === "vacant" || mapped.status === "staff")
            ? (draftRent || engineRent)
            : (engineRent || draftRent),
          tenant: sp.tenantName || extraUse.tenant || "",
          phone: extraUse.phone || sp.tenantPhone || "",
          note: extraUse.note || (mapped.status === "vacant" ? "فارغ" : mapped.status === "staff" ? "موظفين" : ""),
          start_date: extraUse.start_date || sp.startDate || "",
          end_date: extraUse.end_date || "",
          due_date: sp.dueDate || extraUse.due_date || "",
          deposit: extraUse.deposit || "",
          collectionMethod: extraUse.collectionMethod || "",
          collectedBy: extraUse.collectedBy || "",
          rent_type: extraUse.rent_type || "monthly",
          draftSessionId: extraUse.draftSessionId || "",
          draftClearedByVacate: !!extraUse.draftClearedByVacate,
          draftForRentalId: extraUse.draftForRentalId || "",
          ...mapped,
          ...mergeDraftPartial(mapped, extraUse, sp),
          ...mergeDraftStatus(mapped, extraUse, sp),
          _unitId: u.unitId,
          _spaceId: sp.spaceId,
          _rentalId: sp.rentalId,
          _obligationId: sp.obligationId,
          _enginePaid: filsToAed(sp.paidFils),
          _receipts: sp.spaceReceipts || [],
          _tenantCommitted: sp.tenantName || extraUse.tenant || "",
        };
      });
      units.push({
        id: u.unitId,
        name: u.name,
        type: meta.type,
        color: meta.color,
        partitions,
        _unitId: u.unitId
      });
    }
  }
  // Presentation-only: preserve readModel order (mezzanine → numeric apartments).
  // Re-apply here so Old UI month blobs cannot reshuffle display.
  const arabicDigitMap = { "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9" };
  const normalizeDigits = (s) => String(s || "").replace(/[٠-٩]/g, (d) => arabicDigitMap[d] || d);
  const isMezzanineName = (name) => /ميزان|mezzan/i.test(String(name || ""));
  const apartmentNumber = (name) => {
    const s = normalizeDigits(name);
    const m = s.match(/(?:شقة\s*)?(\d{2,4})\b/) || s.match(/^(\d{2,4})$/);
    return m ? Number(m[1]) : null;
  };
  const mezzanineNumber = (name) => {
    const m = normalizeDigits(name).match(/(\d+)/);
    return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
  };
  const compareDisplayUnits = (a, b) => {
    const an = a.name || a.id || "";
    const bn = b.name || b.id || "";
    const aMiz = isMezzanineName(an);
    const bMiz = isMezzanineName(bn);
    if (aMiz !== bMiz) return aMiz ? -1 : 1;
    if (aMiz && bMiz) {
      return mezzanineNumber(an) - mezzanineNumber(bn)
        || String(an).localeCompare(String(bn), "ar", { numeric: true });
    }
    const aNum = apartmentNumber(an);
    const bNum = apartmentNumber(bn);
    if (aNum != null && bNum != null && aNum !== bNum) return aNum - bNum;
    if (aNum != null && bNum == null) return -1;
    if (aNum == null && bNum != null) return 1;
    return String(an).localeCompare(String(bn), "ar", { numeric: true });
  };
  units.sort(compareDisplayUnits);
  for (const u of units) {
    (u.partitions || []).sort((a, b) => Number(a.id) - Number(b.id) || String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  }
  full.sort(compareDisplayUnits);

  const depToTx = (d) => ({
    id: d.id,
    type: "عام",
    desc: d.reference || d.accountName || "إيداع",
    amount: filsToAed(d.amountFils),
    date: d.depositDate,
    notes: d.employeeName || "",
    by: "saeed",
    _engineId: d.id,
    _state: d.state
  });
  const expToOld = (e) => ({
    id: e.id,
    desc: e.reason,
    amount: filsToAed(e.amountFils),
    category: e.category || "عام",
    date: e.expenseDate,
    by: "saeed",
    _engineId: e.id,
    _state: e.state,
    _maintenanceLinkId: e.maintenanceLinkId || null,
    _kind: (String(e.category || "") === "صيانة") ? "maintenance" : "expense"
  });
  const liveExp = (dash.expenses || []).filter((e) => e.state !== "reversed" && e.state !== "rejected");
  const liveDep = (dash.deposits || []).filter((d) => d.state !== "reversed" && d.state !== "rejected");
  S._hydratedExpenseIds = new Set(liveExp.map((e) => e.id));
  S._hydratedDepositIds = new Set(liveDep.map((d) => d.id));
  // Money truth is engine-only. Do NOT merge extras.transactions/expenses —
  // that created ghost rows → applyUiDeposits/Expenses resubmitted duplicates.
  return normalizeData({
    monthInitMode: "zero-v2",
    units,
    full,
    expenses: liveExp.map(expToOld),
    transactions: liveDep.map(depToTx),
    profits: extras.profits || [],
    installments: extras.installments || [],
    logs: extras.logs || [],
    dailyBookings: extras.dailyBookings || [],
    unitMaintenance: extras.unitMaintenance || [],
    facilityMaintenance: extras.facilityMaintenance || []
  });
}

function mergeEngineRows(engineRows, extraRows) {
  const out = engineRows.slice();
  const seen = new Set(out.map((r) => r._engineId).filter(Boolean));
  for (const row of extraRows || []) {
    if (row && row._engineId && seen.has(row._engineId)) continue;
    if (row && !row._engineId) out.push(row);
  }
  return out;
}

function extrasFromData(data) {
  const spaces = {};
  const remember = (x) => {
    if (!x || !x._spaceId) return;
    spaces[x._spaceId] = {
      note: x.note || "",
      phone: x.phone || "",
      start_date: x.start_date || "",
      end_date: x.end_date || "",
      due_date: x.due_date || "",
      deposit: x.deposit || "",
      collectionMethod: x.collectionMethod || "",
      collectedBy: x.collectedBy || "",
      rent_type: x.rent_type || "monthly",
      elec_paid: !!x.elec_paid,
      elec_amount: Number(x.elec_amount || 0),
      // Draft rent/tenant must survive vacant mid-edit saves (start date / quiet debounce)
      // until createRental commits them to the engine.
      tenant: x.tenant || "",
      rent: Number(x.rent || 0) || 0,
      status: x.status || "",
      // Draft partial/paid must survive hydrate until a receipt is recognized —
      // otherwise جزئي + مبلغ mid-edit is wiped by engineStatusToOld(late, paid=0).
      // Scoped to current rental so a prior tenant's draft cannot leak into a new cycle.
      partial: !!x.partial,
      paid_amount: Number(x.paid_amount || 0) || 0,
      draftForRentalId: x._rentalId || x.draftForRentalId || "",
      draftSessionId: x.draftSessionId || "",
      draftClearedByVacate: !!x.draftClearedByVacate,
    };
  };
  (data.units || []).forEach((u) => (u.partitions || []).forEach(remember));
  (data.full || []).forEach(remember);
  return {
    spaces,
    // Never persist deposits/expenses into extras — engine collections are canonical.
    profits: data.profits || [],
    installments: data.installments || [],
    logs: data.logs || [],
    dailyBookings: data.dailyBookings || [],
    unitMaintenance: data.unitMaintenance || [],
    facilityMaintenance: data.facilityMaintenance || []
  };
}

async function refreshEngine(y, m, quiet) {
  const period = periodOfMonth(y, m);
  if (USERS[S.user]?.role === "owner") {
    try { await engineCommand("generateObligations", { period }, "genobl-" + period + "-" + Date.now()); } catch (e) {}
  }
  const dash = await engineRead(period);
  S._dash = dash;
  applyUiConfig(dash.ui);
  return dash;
}
async function engineRead(period) {
  return callFn("read", { what: "dashboard", period });
}

function bankAccountId() {
  const acc = (S._dash && S._dash.accounts) || [];
  return (acc.find((a) => a.kind === "bank") || acc[0] || {}).id;
}

function dashSpaceById(spaceId) {
  for (const u of ((S._dash && S._dash.unitsTree) || [])) {
    for (const sp of (u.spaces || [])) {
      if (sp.spaceId === spaceId) return sp;
    }
  }
  return null;
}

async function applyCollection(item, dashSp) {
  const already = dashSp ? Number(dashSp.paidFils || 0) : aedToFils(item._enginePaid || 0);
  let want = 0;
  if (item.partial) want = aedToFils(item.paid_amount);
  else if (item.status === "collected") want = aedToFils(item.rent || item.paid_amount);
  else return;
  const delta = want - already;
  if (delta <= 0) return;
  // Full and partial collect both require an explicit method. Otherwise selecting
  // محصّل alone would mint a cash receipt before the user chose نقداً/تحويل,
  // and a concurrent hydrate could wipe the method picker mid-edit.
  if (!item.collectionMethod) return;
  const ob = item._obligationId || dashSp?.obligationId;
  if (!ob) {
    throw new Error("COLLECTION_NOT_READY: لا يوجد التزام جاهز للتحصيل — أعد المحاولة");
  }
  const date = (item.due_date && /^\d{4}-\d{2}-\d{2}$/.test(item.due_date)) ? item.due_date : engineToday();
  const collector = NEW_UID[item.collectedBy] || NEW_UID[S.user] || (S._actor && S._actor.userId);
  const method = item.collectionMethod === "bank" ? "bank" : "cash";
  // spaceReceipts includes reversed (readModel). Live/all counts change across cycles.
  const receipts = Array.isArray(item._receipts) ? item._receipts
    : Array.isArray(dashSp?.spaceReceipts) ? dashSp.spaceReceipts
    : [];
  const payKey = collectionOpKey(ob, want, delta, receipts);
  if (method === "bank") {
    const sub = await engineCommand("submitBankReceipt", {
      obligationId: ob, amountFils: delta, collectionDate: date,
      bankReference: "تحويل-" + String(item._spaceId || ob).slice(-10),
      collectorUserId: collector
    }, payKey);
    if (USERS[S.user]?.role === "owner" && sub && sub.receiptId) {
      await engineCommand("approveBankReceipt", { receiptId: sub.receiptId }, "apprbank-" + sub.receiptId);
    }
  } else {
    await engineCommand("createCashReceipt", {
      obligationId: ob, amountFils: delta, collectionDate: date,
      collectorUserId: collector
    }, payKey);
  }
}

async function maybeUncollect(item, dashSp) {
  const ob = item._obligationId || dashSp?.obligationId;
  if (!ob) return;
  const already = dashSp ? Number(dashSp.paidFils || 0) : 0;
  // OLD UI historically left paid_amount set when picking متأخر after محصّل.
  // Unpaid intent: late/pending with partial off, OR explicit paid_amount 0.
  const unpaidUi =
    ((item.status === "late" || item.status === "pending") && !item.partial) ||
    ((item.status === "late" || item.status === "pending") && Number(item.paid_amount || 0) === 0);
  if (unpaidUi && already > 0) {
    const receipts = Array.isArray(item._receipts) ? item._receipts
      : Array.isArray(dashSp?.spaceReceipts) ? dashSp.spaceReceipts
      : [];
    await engineCommand("uncollectObligation", {
      obligationId: ob, reason: "تعديل الحالة من الشاشة"
    }, uncollectOpKey(ob, already, receipts));
  }
}

async function syncOccupancyAndTenant(item, dashSp) {
  if (!item._spaceId) return;
  const occ = item.status === "staff" ? "staff" : item.status === "vacant" ? "vacant" : "rented";
  const engineOcc = dashSp ? (dashSp.occupancy || "vacant") : null;
  let rentalId = item._rentalId || dashSp?.rentalId || null;

  // Vacant/staff must end live tenancy — but MUST NOT wipe draft tenant/rent the user
  // typed while the card is still vacant (start-date / quiet saves used to clear
  // item.tenant="" and then status→rented threw TENANT_REQUIRED).
  if (occ === "vacant" || occ === "staff") {
    const mustClose = (engineOcc && engineOcc !== occ) || !!rentalId;
    // Include rentalId so vacate→rent→vacate is a NEW logical op, not a stale
    // replay of the previous cycle's setSpaceOccupancy(vacant) (same payload).
    const vacKey = intentKey("occ", item._spaceId, occ, rentalId || "norent");
    if (engineOcc !== occ) {
      await engineCommand("setSpaceOccupancy", { spaceId: item._spaceId, occupancy: occ }, vacKey);
    } else if (rentalId) {
      try {
        await engineCommand("closeRental", {
          rentalId, endDate: engineToday(), reason: "تأكيد إفراغ من الشاشة",
          setVacant: occ === "vacant",
        }, intentKey("close-force", rentalId));
      } catch (e) {
        const code = String((e && (e.message || e.code)) || e);
        if (!/RENTAL_ALREADY_CLOSED|RENTAL_NOT_ACTIVE|RENTAL_NOT_FOUND/.test(code)) throw e;
      }
      try {
        await engineCommand("setSpaceOccupancy", { spaceId: item._spaceId, occupancy: occ },
          intentKey("occ-force", item._spaceId, occ, rentalId));
      } catch (e2) {
        const c2 = String((e2 && (e2.message || e2.code)) || e2);
        if (!/NOTHING_TO_UPDATE/.test(c2)) throw e2;
      }
    }
    if (mustClose) {
      item._rentalId = null;
      item._obligationId = null;
      item.tenant = "";
      item.paid_amount = 0;
      item.partial = false;
    } else {
      // Already vacant/staff with no live rental: keep draft fields for the next rent save.
      item._rentalId = null;
      item._obligationId = null;
    }
    return;
  }

  rentalId = item._rentalId || dashSp?.rentalId || null;

  // Vacant → rented: createRental must receive the FULL validated payload in one shot.
  // Do NOT setSpaceOccupancy(rented) first — that left partial occupancy when tenant
  // was missing, and createRental itself sets occupancy=rented on success.
  if (!rentalId && occ === "rented") {
    const tenant = String(item.tenant || "").trim();
    const rentFils = aedToFils(item.rent);
    if (rentFils > 0) {
      if (!tenant || tenant === "—" || tenant === "-" || tenant === "–") {
        throw new Error("TENANT_REQUIRED");
      }
      const start = item.start_date && /^\d{4}-\d{2}-\d{2}$/.test(item.start_date) ? item.start_date : engineToday();
      const dueDay = start ? Number(start.slice(8, 10)) || 1 : 1;
      // NEW rental must never reuse burned rentnew-{spaceId} (caused IDEMPOTENCY_PAYLOAD_MISMATCH).
      if (!item._rentCreateOp) item._rentCreateOp = opId("rentnew");
      const createPayload = {
        spaceId: item._spaceId,
        tenantName: tenant.slice(0, 160),
        contractualAmountFils: rentFils,
        dueDayOfMonth: Math.min(31, Math.max(1, dueDay)),
        startDate: start
      };
      if (item.phone) createPayload.tenantPhone = String(item.phone).slice(0, 40);
      try {
        console.info("[qama-rent] createRental", {
          spaceId: item._spaceId,
          tenantName: createPayload.tenantName,
          rentFils: createPayload.contractualAmountFils,
          startDate: createPayload.startDate,
          hasPhone: !!createPayload.tenantPhone,
          operationId: item._rentCreateOp
        });
        const r = await engineCommand("createRental", createPayload, item._rentCreateOp);
        if (r && r.rentalId) {
          rentalId = r.rentalId;
          item._rentalId = rentalId;
          item._rentCreateOp = null;
        }
      } catch (e) {
        const code = String((e && (e.message || e.code)) || e);
        if (/SPACE_ALREADY_RENTED/.test(code)) {
          item._rentCreateOp = null;
          try {
            await refreshEngine(S.year, S.month, true);
          } catch (e2) {
            throw new Error("COLLECTION_REFRESH_FAILED: " + String((e2 && e2.message) || e2));
          }
          const live = dashSpaceById(item._spaceId);
          if (live && live.rentalId) {
            item._rentalId = live.rentalId;
            rentalId = live.rentalId;
            if (live.obligationId) item._obligationId = live.obligationId;
          } else {
            throw new Error("SPACE_ALREADY_RENTED: تعذر قراءة الإيجار الحالي — أعد المحاولة");
          }
        } else {
          item._rentCreateOp = null;
          throw e;
        }
      }
      if (rentalId) {
        const period = periodOfMonth(S.year, S.month);
        try {
          await engineCommand("generateObligations", { period },
            intentKey("genobl2", period, item._spaceId, rentalId || "x"));
        } catch (e) {
          const code = String((e && (e.message || e.code)) || e);
          if (!/SPACE_ALREADY_RENTED/.test(code)) {
            throw new Error("OBLIGATION_GENERATE_FAILED: " + code);
          }
        }
        // Obligation id is only available after generate + refresh — without it
        // collection must fail visibly (not leave UI محصّل with holding 0).
        try {
          await refreshEngine(S.year, S.month, true);
        } catch (e) {
          throw new Error("COLLECTION_REFRESH_FAILED: " + String((e && e.message) || e));
        }
        const live = dashSpaceById(item._spaceId);
        if (live) {
          if (live.rentalId) { item._rentalId = live.rentalId; rentalId = live.rentalId; }
          if (live.obligationId) item._obligationId = live.obligationId;
        }
        if ((item.status === "collected" || item.partial) && item.collectionMethod && !item._obligationId) {
          throw new Error("COLLECTION_NOT_READY: لم يُنشأ الالتزام بعد إنشاء الإيجار — أعد المحاولة");
        }
      }
    } else if (engineOcc !== "rented") {
      // Status flipped to rented but rent still 0 — keep engine vacant; do not
      // partially mark occupancy rented without a contractual amount.
      return;
    }
  }

  // Existing rental (or create just succeeded): tenant / rent / schedule patches only.
  rentalId = item._rentalId || dashSp?.rentalId || rentalId || null;
  if (rentalId && occ === "rented") {
    const tenantChanged = item.tenant && item.tenant !== (dashSp?.tenantName || "");
    const phoneChanged = item.phone && item.phone !== (dashSp?.tenantPhone || "");
    if (tenantChanged || phoneChanged) {
      const payload = { rentalId };
      if (item.tenant) payload.tenantName = String(item.tenant).slice(0, 160);
      if (item.phone) payload.tenantPhone = String(item.phone).slice(0, 40);
      try {
        await engineCommand("updateRentalTenant", payload, intentKey("ten", rentalId, Date.now()));
      } catch (e) {
        const code = String((e && (e.message || e.code)) || e);
        if (!/NOTHING_TO_UPDATE/.test(code)) throw e;
      }
    }
  }
  if (rentalId && Number(item.rent) > 0 && occ === "rented") {
    const engineDue = dashSp ? Number(dashSp.dueFils || 0) : -1;
    const rentFils = aedToFils(item.rent);
    if (engineDue !== rentFils) {
      await engineCommand("updateRentalRent", {
        rentalId, contractualAmountFils: rentFils
      }, intentKey("rent", rentalId, rentFils));
    }
  }
  // Definitive due rule: contract start day-of-month is the recurring due day.
  if (rentalId && occ === "rented" && item.start_date && /^\d{4}-\d{2}-\d{2}$/.test(item.start_date)) {
    const wantDay = Number(item.start_date.slice(8, 10)) || 1;
    const haveDay = Number(dashSp?.dueDayOfMonth || 0);
    const haveStart = dashSp?.startDate || "";
    if (haveDay !== wantDay || haveStart !== item.start_date) {
      try {
        await engineCommand("updateRentalSchedule", {
          rentalId,
          startDate: item.start_date,
          dueDayOfMonth: Math.min(31, Math.max(1, wantDay)),
        }, intentKey("sched", rentalId, item.start_date, wantDay));
      } catch (e) {
        const code = String((e && (e.message || e.code)) || e);
        if (!/NOTHING_TO_UPDATE/.test(code)) throw e;
      }
    }
  }
}


async function applyUiExpenses(data) {
  const acc = bankAccountId();
  if (!acc) return;
  // Only owner direct saves create expenses here. Employee expenses go through work requests.
  if (USERS[S.user]?.role !== "owner") return;
  for (const exp of (data.expenses || [])) {
    if (exp._engineId || exp._state) continue;
    if (exp.requestId || exp.expenseId) continue;
    const fils = aedToFils(exp.amount);
    if (fils <= 0) throw new Error("INVALID_AMOUNT");
    const date = (exp.date && /^\d{4}-\d{2}-\d{2}$/.test(exp.date)) ? exp.date : engineToday();
    const r = await engineCommand("submitExpense", {
      amountFils: fils,
      reason: String(exp.desc || "مصروف").slice(0, 300),
      category: String(exp.category || "عام").slice(0, 60),
      expenseDate: date,
      paidFromAccountId: acc,
      ...(exp._maintenanceLinkId ? { maintenanceLinkId: String(exp._maintenanceLinkId).slice(0, 120) } : {})
    }, ("uiexp-" + String(exp.id || Date.now()) + "-" + fils).slice(0, 120));
    if (r && r.expenseId) {
      exp._engineId = r.expenseId;
      exp._state = r.state || "approved";
    }
  }
}

async function applyUiDeposits(data) {
  const acc = bankAccountId();
  if (!acc) return;
  // Only owner direct saves create deposits here. Employee deposits go through
  // submitWorkRequest → pending deposit → Manager commitWorkRequest/approveDeposit.
  if (USERS[S.user]?.role !== "owner") return;
  const known = S._hydratedDepositIds || new Set();
  for (const tx of (data.transactions || [])) {
    if (tx._engineId || tx._state) continue;
    if (tx.requestId || tx.depositId) continue; // work-request sourced — never double-submit
    // Fingerprint guard: if an identical live deposit already exists, link it.
    const fils = aedToFils(tx.amount);
    if (fils <= 0) throw new Error("INVALID_AMOUNT");
    const date = (tx.date && /^\d{4}-\d{2}-\d{2}$/.test(tx.date)) ? tx.date : engineToday();
    const dup = (S._dash && S._dash.deposits || []).find((d) =>
      d && (d.state === "approved" || d.state === "pending")
      && Number(d.amountFils) === fils
      && String(d.depositDate) === date
      && String(d.reference || "") === String(tx.desc || tx.id || "إيداع").slice(0, 120)
    );
    if (dup) {
      tx._engineId = dup.id;
      tx._state = dup.state;
      continue;
    }
    const r = await engineCommand("submitDeposit", {
      amountFils: fils,
      depositDate: date,
      destinationAccountId: acc,
      note: String(tx.notes || tx.desc || "إيداع").slice(0, 300),
      reference: String(tx.desc || tx.id || "إيداع").slice(0, 120)
    }, ("uiddep-" + String(tx.id || Date.now()) + "-" + fils).slice(0, 120));
    if (r && r.depositId) {
      tx._engineId = r.depositId;
      tx._state = r.state || "approved";
      known.add(r.depositId);
    }
  }
  S._hydratedDepositIds = known;
}

async function applyUiMaintenance(data) {
  const acc = bankAccountId();
  if (!acc) return;
  if (USERS[S.user]?.role !== "owner") return;
  const rows = []
    .concat(data.unitMaintenance || [])
    .concat(data.facilityMaintenance || []);
  for (const row of rows) {
    if (row._cancelled || row._reversed) continue;
    if (row._engineId || row._expenseId) continue;
    const fils = aedToFils(row.amount);
    if (fils <= 0) continue;
    // If engine already has a matching صيانة expense for this link/id, attach it.
    const linkId = String(row.id || "");
    const existing = (S._dash && S._dash.expenses || []).find((e) =>
      e && (e.state === "approved" || e.state === "pending")
      && String(e.category || "") === "صيانة"
      && Number(e.amountFils) === fils
      && (String(e.maintenanceLinkId || "") === linkId || String(e.reason || "") === String(row.desc || row.description || "صيانة").slice(0, 300))
    );
    if (existing) {
      row._engineId = existing.id;
      row._expenseId = existing.id;
      continue;
    }
    const date = (row.date && /^\d{4}-\d{2}-\d{2}$/.test(row.date)) ? row.date : engineToday();
    const r = await engineCommand("submitExpense", {
      amountFils: fils,
      reason: String(row.desc || row.description || "صيانة").slice(0, 300),
      category: "صيانة",
      expenseDate: date,
      paidFromAccountId: acc,
      maintenanceLinkId: linkId.slice(0, 120) || undefined
    }, ("uimaint-" + String(row.id || Date.now()) + "-" + fils).slice(0, 120));
    if (r && r.expenseId) {
      row._engineId = r.expenseId;
      row._expenseId = r.expenseId;
    }
  }
}

async function syncDeletedMoney(data) {
  if (!S._moneyHydrated || !S._dash) return;
  const keepExp = new Set((data.expenses || []).map((e) => e._engineId).filter(Boolean));
  const knownExp = S._hydratedExpenseIds || new Set();
  for (const e of S._dash.expenses || []) {
    if (!e.id || keepExp.has(e.id) || !knownExp.has(e.id)) continue;
    if (e.state !== "approved" && e.state !== "pending") continue;
    try {
      if (e.state === "pending") {
        await engineCommand("rejectExpense", { expenseId: e.id, reason: "حذف من الشاشة" }, "reje-" + e.id);
      } else {
        await engineCommand("reverseExpense", { expenseId: e.id, reason: "حذف من الشاشة" }, "reve-" + e.id);
      }
    } catch (err) { console.error(err); }
  }
  const keepDep = new Set((data.transactions || []).map((t) => t._engineId).filter(Boolean));
  const knownDep = S._hydratedDepositIds || new Set();
  for (const d of S._dash.deposits || []) {
    if (!d.id || keepDep.has(d.id) || !knownDep.has(d.id)) continue;
    if (d.state !== "approved" && d.state !== "pending") continue;
    try {
      if (d.state === "pending") {
        await engineCommand("rejectDeposit", { depositId: d.id, reason: "حذف من الشاشة" }, "rejd-" + d.id);
      } else {
        await engineCommand("reverseDeposit", { depositId: d.id, reason: "حذف من الشاشة" }, "revd-" + d.id);
      }
    } catch (err) { console.error(err); }
  }
}

async function applyEngineDiff(data) {
  const dashSpaces = [];
  for (const u of ((S._dash && S._dash.unitsTree) || [])) {
    for (const sp of (u.spaces || [])) dashSpaces.push(sp);
  }
  const items = [];
  (data.units || []).forEach((u) => (u.partitions || []).forEach((p) => items.push(p)));
  (data.full || []).forEach((u) => items.push(u));

  const errors = [];
  for (const item of items) {
    if (!item._spaceId) continue;
    const dashSp = dashSpaceById(item._spaceId);
    try {
      await maybeUncollect(item, dashSp);
      await syncOccupancyAndTenant(item, dashSp);
      let fresh = dashSpaceById(item._spaceId) || dashSp;
      // _collectDraft + method means the operator confirmed محصّل in the form even if
      // a prior hydrate left mapped.status as late (unpaid engine truth).
      const wantsPay = item.status === "collected" || item.partial
        || (!!item._collectDraft && !!item.collectionMethod);
      if (wantsPay && item.collectionMethod
          && !(item._obligationId || (fresh && fresh.obligationId))) {
        const period = periodOfMonth(S.year, S.month);
        try {
          await engineCommand("generateObligations", { period },
            intentKey("genobl-pay", period, item._spaceId));
        } catch (e) {
          throw new Error("OBLIGATION_GENERATE_FAILED: " + String((e && e.message) || e));
        }
        try {
          await refreshEngine(S.year, S.month, true);
        } catch (e) {
          throw new Error("COLLECTION_REFRESH_FAILED: " + String((e && e.message) || e));
        }
        fresh = dashSpaceById(item._spaceId) || fresh;
        if (fresh && fresh.obligationId) item._obligationId = fresh.obligationId;
        if (fresh && fresh.rentalId) item._rentalId = fresh.rentalId;
      }
      if (wantsPay) {
        // applyCollection keys off status/partial — promote draft collect for this call only.
        const payItem = (item.status === "collected" || item.partial) ? item
          : { ...item, status: "collected" };
        await applyCollection(payItem, fresh);
      }
    } catch (e) {
      console.error("applyEngineDiff item failed", item._spaceId, e);
      errors.push(e);
    }
  }
  if (errors.length) throw errors[0];

  const mapped = items.filter((x) => x._spaceId).length;
  const skipDeletes = mapped < Math.max(1, dashSpaces.length * 0.5);
  if (!skipDeletes) {
    const live = new Set(items.map((x) => x._spaceId).filter(Boolean));
    for (const sp of dashSpaces) {
      if (sp.spaceId && !live.has(sp.spaceId)) {
        if (sp.rentalId) {
          await engineCommand("closeRental", {
            rentalId: sp.rentalId, endDate: engineToday(), reason: "حذف من الشاشة", setVacant: true
          }, "delclose-" + sp.rentalId);
        }
        await engineCommand("updateSpace", { spaceId: sp.spaceId, active: false }, "delsp-" + sp.spaceId);
      }
    }
  }

  for (const u of (data.units || [])) {
    if (u._unitId) {
      for (const p of (u.partitions || [])) {
        if (p._spaceId) continue;
        const sp = await engineCommand("createSpace", {
          unitId: u._unitId, name: (u.name || "شقة") + " / " + p.id
        }, "space-" + u._unitId + "-" + p.id);
        p._spaceId = sp.spaceId;
        p._unitId = u._unitId;
      }
      continue;
    }
    // Never mint a second canonical unit for the same physical name.
    const existingUnit = ((S._dash && S._dash.unitsTree) || []).find(
      (x) => String(x.name || "").trim() === String(u.name || "").trim()
    );
    if (existingUnit && existingUnit.unitId) {
      u._unitId = existingUnit.unitId;
      for (const p of (u.partitions || [])) {
        if (p._spaceId) continue;
        const matchSp = (existingUnit.spaces || []).find((sp) => {
          const m = String(sp.name || "").match(/\/\s*(\d+)\s*$/);
          return m && Number(m[1]) === Number(p.id);
        }) || (existingUnit.spaces || [])[0];
        if (matchSp) {
          p._spaceId = matchSp.spaceId;
          p._unitId = existingUnit.unitId;
        }
      }
      continue;
    }
    const prop = (S._dash && S._dash.properties && S._dash.properties[0]) || {};
    if (!prop.id) continue;
    const created = await engineCommand("createUnit", {
      propertyId: prop.id, name: u.name, kind: "partitioned"
    }, "unit-" + u.id);
    u._unitId = created.unitId;
    for (const p of (u.partitions || [])) {
      const sp = await engineCommand("createSpace", {
        unitId: u._unitId, name: u.name + " / " + p.id
      }, "space-" + u.id + "-" + p.id);
      p._spaceId = sp.spaceId;
      p._unitId = u._unitId;
    }
  }
  for (const u of (data.full || [])) {
    if (u._unitId) continue;
    const existingFull = ((S._dash && S._dash.unitsTree) || []).find(
      (x) => (x.isWhole || x.kind === "whole") && String(x.name || "").trim() === String(u.id || "").trim()
    );
    if (existingFull && existingFull.unitId) {
      u._unitId = existingFull.unitId;
      const sp0 = (existingFull.spaces || [])[0];
      if (sp0) u._spaceId = sp0.spaceId;
      continue;
    }
    const prop = (S._dash && S._dash.properties && S._dash.properties[0]) || {};
    if (!prop.id) continue;
    const created = await engineCommand("createUnit", {
      propertyId: prop.id, name: String(u.id), kind: "whole"
    }, "full-" + u.id);
    u._unitId = created.unitId;
    const sp = await engineCommand("createSpace", { unitId: u._unitId, name: String(u.id) }, "fullsp-" + u.id);
    u._spaceId = sp.spaceId;
  }
  await applyUiExpenses(data);
  await applyUiDeposits(data);
  await applyUiMaintenance(data);
  await syncDeletedMoney(data);
}

async function hydrateMonthFromEngine(y, m) {
  const dash = await refreshEngine(y, m, true);
  const data = mapDashboardToMonth(dash);
  S._moneyHydrated = true;
  try { localStorage.setItem("qama_month_" + y + "_" + m, JSON.stringify(data)); } catch (e) {}
  return data;
}

async function persistExtras(y, m, data) {
  const period = periodOfMonth(y, m);
  await engineCommand("savePeriodExtras", {
    period, extrasJson: JSON.stringify(extrasFromData(data))
  }, "extras-" + period + "-" + Date.now());
}

async function upsertConfig(configId, obj) {
  let jsonObj = obj;
  if (configId === "locks" || configId === "permissions" || configId === "customUnits") {
    jsonObj = obj.data != null ? obj.data : obj;
  }
  if (configId === "balances") {
    jsonObj = {
      companyBalance: obj.companyBalance,
      revenueBalance: obj.revenueBalance,
      installmentBalance: obj.installmentBalance,
      installmentSchedule: obj.installmentSchedule
    };
  }
  await engineCommand("upsertUiConfig", { configId, json: JSON.stringify(jsonObj) }, "cfg-" + configId + "-" + Date.now());
}

async function setDoc(ref, data) {
  try {
    if (ref._col === "config") {
      const id = ref._id;
      if (id === "permissions" || id === "locks" || id === "customUnits" || id === "balances") {
        await upsertConfig(id, data);
      }
      return;
    }
    if (ref._col === "requests") {
      const status = data.status || "pending";
      if (status === "pending" && !data.resolvedAt) {
        try {
          let payload = data.payload || {};
          // Employee deposit: create canonical PENDING deposit so Manager sees it in
          // pendingApprovals AND in uiRequests. Approval later only flips that deposit.
          if (data.type === "add_transaction" && payload.transaction && !payload.depositId) {
            const tx = payload.transaction;
            const fils = aedToFils(tx.amount);
            const acc = bankAccountId();
            if (fils > 0 && acc) {
              const date = (tx.date && /^\d{4}-\d{2}-\d{2}$/.test(tx.date)) ? tx.date : engineToday();
              try {
                const dep = await engineCommand("submitDeposit", {
                  amountFils: fils,
                  depositDate: date,
                  destinationAccountId: acc,
                  note: String(tx.notes || tx.desc || "إيداع").slice(0, 300),
                  reference: String(tx.desc || data.id || "إيداع").slice(0, 120),
                }, ("reqdep-" + (data.id || ref._id)).slice(0, 120));
                if (dep && dep.depositId) {
                  payload = { ...payload, depositId: dep.depositId, transaction: { ...tx, depositId: dep.depositId } };
                }
              } catch (depErr) {
                // Still create the work request so Manager sees the attempt + error context.
                payload = {
                  ...payload,
                  depositSubmitError: String((depErr && (depErr.message || depErr.code)) || depErr).slice(0, 200),
                };
              }
            }
          }
          await engineCommand("submitWorkRequest", {
            requestId: data.id || ref._id,
            type: String(data.type || "update"),
            desc: String(data.desc || data.type || "طلب").slice(0, 800),
            payloadJson: JSON.stringify(payload),
            month: Number(data.month || S.month),
            year: Number(data.year || S.year)
          }, "req-" + (data.id || ref._id));
        } catch (e) {
          const code = e && (e.code || e.message);
          if (/REQUEST_EXISTS|DUPLICATE_PENDING_REQUEST/i.test(String(code))) {
            // Treat as already-submitted — Manager already has the single card.
            return;
          }
          throw e;
        }
      } else if (status === "approved") {
        // Prefer the atomic commit path. resolveWorkRequest("approved") alone
        // only flips status and must not be used as a silent success.
        await engineCommand("commitWorkRequest", {
          requestId: data.id || ref._id
        }, "commit-" + (data.id || ref._id));
      } else {
        const map = { rejected: "rejected", processing: "processing", pending: "pending", failed: "failed" };
        const decision = map[status];
        if (decision) {
          // Rejecting a deposit work request must also reject the linked pending deposit.
          if (decision === "rejected" && data.type === "add_transaction") {
            let payload = data.payload || {};
            try {
              if (typeof payload === "string") payload = JSON.parse(payload);
            } catch { payload = {}; }
            const depId = payload.depositId || payload.transaction?.depositId;
            if (depId) {
              try {
                await engineCommand("rejectDeposit", {
                  depositId: depId, reason: "رفض طلب الإيداع من الشاشة",
                }, "reqrejdep-" + depId);
              } catch (re) {
                const c = String((re && (re.message || re.code)) || re);
                if (!/DEPOSIT_NOT_PENDING|DEPOSIT_NOT_FOUND|ALREADY/.test(c)) throw re;
              }
            }
          }
          await engineCommand("resolveWorkRequest", {
            requestId: data.id || ref._id, decision
          }, "reqres-" + (data.id || ref._id) + "-" + decision + "-" + Date.now());
        }
      }
      return;
    }
    if (ref._col === "months") {
      const parts = String(ref._id).split("_");
      const y = Number(parts[0]), m = Number(parts[1]);
      const monthData = data.data || data;
      // Snapshot draft before engine apply so TENANT_REQUIRED / partial failures
      // can restore the user's typed form instead of hydrating vacant/0/empty.
      let draftJson = null;
      try { draftJson = JSON.stringify(monthData); } catch (_e) { draftJson = null; }
      try {
        // Apply money mutations first so _engineId/_expenseId links exist,
        // then persist extras (maintenance rows) with those links.
        await applyEngineDiff(monthData);
        await persistExtras(y, m, monthData);
        await hydrateMonthFromEngine(y, m);
        S.syncMsg = "تم الحفظ أونلاين";
      } catch (e) {
        console.error(e);
        const code = String((e && (e.message || e.code)) || e);
        const keepDraft = /TENANT_REQUIRED|RENT_REQUIRED|IDEMPOTENCY_PAYLOAD_MISMATCH|AMOUNT_EXCEEDS_HOLDING|INVALID_AMOUNT/i.test(code);
        if (keepDraft && draftJson) {
          try {
            localStorage.setItem("qama_month_" + y + "_" + m, draftJson);
            S._preserveDraftUntil = Date.now() + 120000;
          } catch (_e2) {}
        } else {
          try { await hydrateMonthFromEngine(y, m); } catch (e2) {}
        }
        const ar = formatEngineError(e);
        S.syncMsg = ar;
        S.msg = ar;
        throw e;
      }
    }
  } catch (e) {
    console.error(e);
    const ar = formatEngineError(e);
    S.syncMsg = ar;
    S.msg = ar;
    throw e;
  }
}

async function getDoc(ref) {
  if (ref._col === "config") {
    const cfg = (S._dash && S._dash.ui && S._dash.ui.config) || {};
    const d = cfg[ref._id];
    if (d == null) return makeSnap(false, {});
    if (ref._id === "balances") return makeSnap(true, d);
    return makeSnap(true, { data: d });
  }
  if (ref._col === "months") {
    const k = ref._id;
    try {
      const raw = localStorage.getItem("qama_month_" + k);
      if (raw) return makeSnap(true, { data: JSON.parse(raw) });
    } catch (e) {}
    return makeSnap(false, {});
  }
  if (ref._col === "requests") {
    const req = ((S._dash && S._dash.ui && S._dash.ui.requests) || []).find((r) => r.id === ref._id);
    return req ? makeSnap(true, req) : makeSnap(false, {});
  }
  return makeSnap(false, {});
}

/** Emulator-only: expose helpers for isolated browser matrix (never production). */
if (typeof window !== "undefined" && typeof __QAMA_EMULATOR__ !== "undefined" && __QAMA_EMULATOR__) {
  window.__qamaTest = {
    collectionOpKey, uncollectOpKey, shortOb, receiptCounts, formatEngineError, intentKey, opId,
    engineCommand, refreshEngine, applyEngineDiff, applyCollection, maybeUncollect,
    authState() {
      return {
        screen: typeof S !== "undefined" ? S.screen : null,
        user: typeof S !== "undefined" ? S.user : null,
        tab: typeof S !== "undefined" ? S.tab : null,
        loading: typeof S !== "undefined" ? !!S.loading : null,
        syncMsg: typeof S !== "undefined" ? S.syncMsg : null,
        msg: typeof S !== "undefined" ? S.msg : null,
        showAddExp: typeof S !== "undefined" ? !!S.showAddExp : null,
        hasDash: !!(typeof S !== "undefined" && S._dash),
        summary: (typeof S !== "undefined" && S._dash && S._dash.summary) || null,
        actorId: (typeof S !== "undefined" && S._actor && S._actor.userId) || null,
        saveOpSeq: typeof S !== "undefined" ? (S._saveOpSeq || 0) : 0,
        saveOpId: typeof S !== "undefined" ? (S._saveOpId || 0) : 0,
        saveOpDoneId: typeof S !== "undefined" ? (S._saveOpDoneId || 0) : 0,
        saveOpStatus: typeof S !== "undefined" ? (S._saveOpStatus || null) : null,
        saveInFlight: typeof S !== "undefined" ? !!S._saveInFlight : false,
      };
    },
  };
}
