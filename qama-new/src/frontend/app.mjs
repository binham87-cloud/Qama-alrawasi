import { login, listLoginUsers, logout, cmd, readPeriod, newOperationId } from "./api.mjs";
import { el, clear, moneyDisplay } from "./dom.mjs";
import { parseAedInputToFils } from "./moneyInput.mjs";

const state = {
  user: null,
  period: new Date().toISOString().slice(0, 7),
  app: null,
  view: "login",
  loginStep: "users",
  loginUsers: null,
  selectedLoginUser: null,
  pin: "",
  busy: false,
  draft: {},
  selectedUnitId: null,
  selectedSpaceId: null,
  selectedObligation: null,
  collectMethod: "cash",
  confirm: null,
};

const root = document.getElementById("app");
const isOwner = () => state.user?.role === "owner";
const today = () => new Date().toISOString().slice(0, 10);

function roleLabelAr(role) {
  return role === "owner" ? "مالك / مدير" : "موظف";
}

function toast(msg) {
  const t = el("div", { class: "toast", text: msg });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

function statusBadge(status, label) {
  const cls = `badge st-${status || "vacant"}`;
  return el("span", { class: cls, text: label || status || "—" });
}

function filsFromAed(v) {
  return parseAedInputToFils(v);
}

function pctBar(paid, due) {
  const p = due > 0 ? Math.min(100, Math.round((paid / due) * 100)) : 0;
  const tone = p >= 100 ? "" : p >= 70 ? " mid" : " low";
  return el("div", { class: `progress${tone}` }, [el("span", { style: `width:${p}%` })]);
}

async function refresh() {
  if (!state.user) return;
  const data = await readPeriod(state.period);
  state.app = data.app;
}

async function runCommand(name, payload) {
  if (state.busy) return null;
  state.busy = true;
  render();
  try {
    const result = await cmd(name, payload, newOperationId(name));
    await refresh();
    toast("تم");
    return result;
  } catch (err) {
    toast(err.message || "فشل الأمر");
    return null;
  } finally {
    state.busy = false;
    state.confirm = null;
    render();
  }
}

function input(label, key, type = "text", opts = {}) {
  return el("label", { class: "field" }, [
    el("span", { text: label }),
    el("input", {
      type,
      value: state.draft[key] ?? opts.defaultValue ?? "",
      oninput: (e) => { state.draft[key] = e.target.value; },
    }),
  ]);
}

function confirmBox(message, onYes) {
  return el("div", { class: "confirm-box" }, [
    el("p", { text: message }),
    el("div", { class: "btn-row" }, [
      el("button", { class: "btn btn-danger", onclick: onYes, text: "تأكيد" }),
      el("button", { class: "btn btn-secondary", onclick: () => { state.confirm = null; render(); }, text: "إلغاء" }),
    ]),
  ]);
}

function moneyTriple(dueDisplay, paidDisplay, remainingDisplay) {
  return el("div", { class: "money-grid" }, [
    el("div", { class: "cell" }, [el("div", { class: "label", text: "الإيجار" }), el("div", { class: "val", text: dueDisplay })]),
    el("div", { class: "cell" }, [el("div", { class: "label", text: "المدفوع" }), el("div", { class: "val", text: paidDisplay })]),
    el("div", { class: "cell" }, [el("div", { class: "label", text: "المتبقي" }), el("div", { class: "val", text: remainingDisplay })]),
  ]);
}

/* ─── structural classification: unit.kind only, never space-count ─── */

function isFullApartment(unit) {
  return unit?.kind === "whole";
}

function apartmentTitle(unit) {
  return String(unit?.name || "").replace(/^شقة\s+/, "").trim() || unit?.name || "";
}

function occupancyAr(space, rental) {
  if (space?.occupancy === "staff") return { key: "staff", label: "موظفين" };
  if (space?.occupancy === "vacant" || !rental || rental.state !== "active") {
    return { key: "vacant", label: "فارغ" };
  }
  return { key: "rented", label: "مؤجر" };
}

function compareApartmentNames(a, b) {
  const an = apartmentTitle(a);
  const bn = apartmentTitle(b);
  const arabicDigitMap = { "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9" };
  const normalizeDigits = (s) => String(s || "").replace(/[٠-٩]/g, (d) => arabicDigitMap[d] || d);
  const isMiz = (n) => /ميزان|mezzan/i.test(n);
  const aptNum = (n) => {
    const s = normalizeDigits(n);
    const m = s.match(/(?:شقة\s*)?(\d{2,4})\b/) || s.match(/^(\d{2,4})$/);
    return m ? Number(m[1]) : null;
  };
  const mizNum = (n) => {
    const m = normalizeDigits(n).match(/(\d+)/);
    return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
  };
  if (isMiz(an) !== isMiz(bn)) return isMiz(an) ? -1 : 1;
  if (isMiz(an) && isMiz(bn)) {
    return mizNum(an) - mizNum(bn) || an.localeCompare(bn, "ar", { numeric: true });
  }
  const aNum = aptNum(an);
  const bNum = aptNum(bn);
  if (aNum != null && bNum != null && aNum !== bNum) return aNum - bNum;
  if (aNum != null && bNum == null) return -1;
  if (aNum == null && bNum != null) return 1;
  return an.localeCompare(bn, "ar", { numeric: true });
}

function unitTree() {
  const units = [...(state.app?.units || [])].filter((u) => u.active !== false);
  const spaces = state.app?.spaces || [];
  const rentals = state.app?.rentals || [];
  const obs = state.app?.dashboard?.obligations || [];
  const byUnit = new Map();

  for (const u of units) {
    byUnit.set(u.id, {
      unit: u,
      full: isFullApartment(u),
      spaces: [],
      dueTotal: 0,
      paidTotal: 0,
      partial: 0,
      late: 0,
      vacant: 0,
      collected: 0,
    });
  }

  for (const s of spaces.filter((x) => x.active !== false)) {
    const bucket = byUnit.get(s.unitId);
    if (!bucket) continue;
    const rental = rentals.find((r) => r.spaceId === s.id && r.state === "active")
      || rentals.find((r) => r.spaceId === s.id) || null;
    const view = obs.find((o) => o.spaceId === s.id) || null;
    const occ = occupancyAr(s, rental);
    bucket.spaces.push({ space: s, rental, view, occ });
    if (view) {
      bucket.dueTotal += view.dueFils || 0;
      bucket.paidTotal += view.paidFils || 0;
      if (view.status === "partial") bucket.partial++;
      else if (view.status === "late") bucket.late++;
      else if (view.status === "collected") bucket.collected++;
    }
    if (occ.key === "vacant") bucket.vacant++;
  }

  for (const bucket of byUnit.values()) {
    bucket.spaces.sort((a, b) =>
      String(a.space.name).localeCompare(String(b.space.name), "ar", { numeric: true }));
  }

  return [...byUnit.values()].sort((a, b) => compareApartmentNames(a.unit, b.unit));
}

function openApartment(row) {
  state.selectedUnitId = row.unit.id;
  if (row.full) {
    const entry = row.spaces[0] || null;
    state.selectedSpaceId = entry?.space?.id || null;
    state.selectedObligation = entry?.view || null;
    state.view = "fullDetail";
  } else {
    state.selectedSpaceId = null;
    state.selectedObligation = null;
    state.view = "partitionList";
  }
  render();
}

function openPartition(entry, unitId) {
  state.selectedUnitId = unitId;
  state.selectedSpaceId = entry.space.id;
  state.selectedObligation = entry.view || null;
  state.view = "partitionDetail";
  render();
}

/* ───────── login ───────── */

async function ensureLoginUsers() {
  if (state.loginUsers) return;
  try {
    state.loginUsers = await listLoginUsers();
  } catch {
    state.loginUsers = [];
    toast("تعذر تحميل المستخدمين");
  }
}

function renderLoginUserList() {
  const owners = (state.loginUsers || []).filter((u) => u.role === "owner");
  const employees = (state.loginUsers || []).filter((u) => u.role !== "owner");
  const userBtn = (u) =>
    el("button", {
      class: "btn btn-secondary login-user-btn",
      onclick: () => {
        state.selectedLoginUser = u;
        state.loginStep = "pin";
        state.pin = "";
        render();
      },
    }, [
      el("span", { class: "login-user-name", text: u.displayName }),
      el("span", { class: "login-user-role", text: roleLabelAr(u.role) }),
    ]);

  const sections = [];
  if (owners.length) {
    sections.push(el("h2", { class: "login-section-title", text: "المالك / المدير" }));
    sections.push(el("div", { class: "login-user-list" }, owners.map(userBtn)));
  }
  if (employees.length) {
    sections.push(el("h2", { class: "login-section-title", text: "الموظفون" }));
    sections.push(el("div", { class: "login-user-list" }, employees.map(userBtn)));
  }
  if (!owners.length && !employees.length) sections.push(el("p", { text: "لا يوجد مستخدمون نشطون" }));

  clear(root);
  root.append(
    el("div", { class: "content" }, [
      el("h1", { class: "h1", text: "قمة الرواسي" }),
      el("p", { class: "muted", text: "نظام إدارة البناية — اختر حسابك" }),
      el("div", { class: "card" }, sections),
    ]),
  );
}

function renderLoginPin() {
  const selected = state.selectedLoginUser;
  clear(root);
  root.append(
    el("div", { class: "content" }, [
      el("h1", { class: "h1", text: "قمة الرواسي" }),
      el("button", {
        class: "btn btn-secondary btn-block",
        text: "← رجوع لاختيار الحساب",
        onclick: () => {
          state.loginStep = "users";
          state.selectedLoginUser = null;
          state.pin = "";
          render();
        },
      }),
      el("div", { class: "card", style: "margin-top:12px" }, [
        el("div", { class: "login-selected" }, [
          el("strong", { text: selected?.displayName || "" }),
          el("span", { class: "login-user-role", text: roleLabelAr(selected?.role) }),
        ]),
        el("p", { text: "أدخل الرقم السري" }),
        el("div", { class: "row" }, [el("strong", { text: "•".repeat(state.pin.length) || "—" })]),
        el("div", { class: "pin-grid" }, ["1","2","3","4","5","6","7","8","9","⌫","0","✓"].map((d) =>
          el("button", {
            class: "btn btn-secondary",
            onclick: async () => {
              if (d === "⌫") state.pin = state.pin.slice(0, -1);
              else if (d === "✓") {
                if (!selected?.userId || !state.pin) return;
                try {
                  state.busy = true;
                  state.user = await login(selected.userId, state.pin);
                  state.pin = "";
                  state.loginStep = "users";
                  state.selectedLoginUser = null;
                  state.view = "units";
                  await refresh();
                } catch {
                  toast("رقم سري خاطئ");
                  state.pin = "";
                } finally {
                  state.busy = false;
                }
              } else if (state.pin.length < 12) state.pin += d;
              render();
            },
            text: d,
          })
        )),
      ]),
    ]),
  );
}

function renderLogin() {
  if (state.loginUsers === null) {
    clear(root);
    root.append(el("div", { class: "content" }, [
      el("h1", { class: "h1", text: "قمة الرواسي" }),
      el("p", { class: "muted", text: "جاري تحميل المستخدمين…" }),
    ]));
    ensureLoginUsers().then(() => render());
    return;
  }
  if (state.loginStep === "pin" && state.selectedLoginUser) return renderLoginPin();
  return renderLoginUserList();
}

/* ───────── shell ───────── */

function doLogout() {
  logout().finally(() => {
    state.user = null;
    state.app = null;
    state.view = "login";
    state.loginStep = "users";
    state.selectedLoginUser = null;
    state.pin = "";
    state.loginUsers = null;
    state.selectedUnitId = null;
    state.selectedSpaceId = null;
    render();
  });
}

function renderHeader() {
  return el("header", { class: "app-header" }, [
    el("div", { class: "brand", text: "قمة الرواسي" }),
    el("div", { class: "meta" }, [
      el("span", { text: `لوحة ${state.user?.displayName || ""}` }),
      el("div", { class: "actions" }, [
        el("button", {
          class: "btn btn-secondary",
          style: "min-height:40px;padding:8px 12px",
          text: "تحديث",
          onclick: async () => { await refresh(); toast("تم التحديث"); render(); },
        }),
        el("button", {
          class: "btn btn-secondary",
          style: "min-height:40px;padding:8px 12px",
          text: "خروج",
          onclick: doLogout,
        }),
      ]),
    ]),
  ]);
}

function renderTabs() {
  const items = isOwner()
    ? [
      ["units", "الوحدات"],
      ["approvals", "الطلبات"],
      ["deposits", "الإيداعات"],
      ["expenses", "المصاريف"],
      ["summary", "المالية"],
      ["manage", "إدارة"],
    ]
    : [
      ["units", "الوحدات"],
      ["custody", "عهدتي"],
      ["deposits", "الإيداعات"],
      ["expenses", "المصاريف"],
    ];

  const unitViews = new Set(["units", "partitionList", "partitionDetail", "fullDetail", "collect", "receiptHistory"]);
  return el("nav", { class: "tabs" }, items.map(([v, label]) =>
    el("button", {
      class: state.view === v || (v === "units" && unitViews.has(state.view)) ? "active" : "",
      text: label,
      onclick: async () => {
        state.view = v;
        state.draft = {};
        state.selectedUnitId = null;
        state.selectedSpaceId = null;
        state.selectedObligation = null;
        await refresh();
        render();
      },
    })
  ));
}

function periodNav() {
  return el("div", { class: "card" }, [
    el("div", { class: "row" }, [
      el("span", { class: "muted", text: "شهر التحصيل" }),
      el("input", {
        type: "month",
        value: state.period,
        onchange: async (e) => {
          state.period = e.target.value;
          await refresh();
          render();
        },
      }),
    ]),
  ]);
}

/* ───────── home ───────── */

function renderHome() {
  const f = state.app?.dashboard?.formatted;
  const summary = state.app?.dashboard?.summary;
  const views = state.app?.dashboard?.obligations || [];
  const late = views.filter((v) => v.status === "late");
  const partial = views.filter((v) => v.status === "partial");
  const wrap = el("div");
  wrap.append(periodNav());

  if (isOwner()) {
    wrap.append(el("div", { class: "kpi-grid" }, [
      el("div", { class: "kpi" }, [el("div", { class: "label", text: "المستهدف" }), el("div", { class: "value", text: f?.target || "0" })]),
      el("div", { class: "kpi" }, [el("div", { class: "label", text: "المحصّل" }), el("div", { class: "value", text: f?.collected || "0" })]),
      el("div", { class: "kpi" }, [el("div", { class: "label", text: "المتبقي" }), el("div", { class: "value", text: f?.remaining || "0" })]),
      el("div", { class: "kpi" }, [el("div", { class: "label", text: "العهدة" }), el("div", { class: "value", text: f?.holding || "0" })]),
    ]));
    const pending = state.app?.pending || {};
    const pendingCount = (pending.bankReceipts?.length || 0) + (pending.deposits?.length || 0) + (pending.expenses?.length || 0);
    if (pendingCount) {
      wrap.append(el("div", {
        class: "card tap",
        onclick: () => { state.view = "approvals"; render(); },
      }, [
        el("div", { class: "row" }, [
          el("strong", { text: "طلبات بانتظار الاعتماد" }),
          statusBadge("partial", String(pendingCount)),
        ]),
      ]));
    }
  } else {
    const mine = (state.app?.dashboard?.custody || []).find((c) => c.userId === state.user.userId);
    wrap.append(el("div", { class: "kpi-grid" }, [
      el("div", { class: "kpi" }, [el("div", { class: "label", text: "متأخر" }), el("div", { class: "value", text: String(late.length) })]),
      el("div", { class: "kpi" }, [el("div", { class: "label", text: "جزئي" }), el("div", { class: "value", text: String(partial.length) })]),
      el("div", { class: "kpi" }, [el("div", { class: "label", text: "عهدتي" }), el("div", { class: "value", text: mine?.holdingDisplay || "0" })]),
      el("div", { class: "kpi" }, [el("div", { class: "label", text: "المتبقي الكلي" }), el("div", { class: "value", text: f?.remaining || "0" })]),
    ]));
  }

  if (late.length) {
    wrap.append(el("h2", { class: "section-title", text: "متأخرات للتحصيل" }));
    for (const o of late.slice(0, 8)) {
      wrap.append(taskCard(o));
    }
  }
  if (partial.length) {
    wrap.append(el("h2", { class: "section-title", text: "جزئيون — متبقي" }));
    for (const o of partial.slice(0, 8)) {
      wrap.append(taskCard(o));
    }
  }
  if (!late.length && !partial.length) {
    wrap.append(el("div", { class: "card" }, [el("p", { class: "muted", text: "كل المهام منجزة لهذا الشهر" })]));
  }

  wrap.append(el("button", {
    class: "btn btn-primary btn-block",
    style: "margin-top:12px",
    text: "فتح الوحدات",
    onclick: () => { state.view = "units"; render(); },
  }));
  return wrap;
}

function taskCard(o) {
  const units = state.app?.units || [];
  const unit = units.find((u) => u.id === o.unitId);
  return el("div", {
    class: "card tap",
    onclick: () => {
      state.selectedUnitId = o.unitId;
      state.selectedSpaceId = o.spaceId;
      state.selectedObligation = o;
      state.view = "spaceDetail";
      render();
    },
  }, [
    el("div", { class: "row" }, [
      el("strong", { text: o.tenantName || "مستأجر" }),
      statusBadge(o.status, o.statusAr),
    ]),
    el("div", { class: "muted", text: `${unit?.name || "شقة"} · ${o.remainingDisplay} متبقي` }),
  ]);
}

/* ───────── units list ───────── */

function renderUnits() {
  const tree = unitTree();
  const wrap = el("div");
  wrap.append(periodNav());
  wrap.append(el("h1", { class: "h1", text: "الوحدات" }));

  const partitioned = tree.filter((t) => t.unit.kind !== "whole" && t.spaces.length !== 1);
  const wholes = tree.filter((t) => t.unit.kind === "whole" || t.spaces.length === 1);

  if (partitioned.length) {
    wrap.append(el("h2", { class: "section-title", text: "الشقق (بارتشنات)" }));
    for (const row of partitioned) wrap.append(unitListCard(row));
  }
  if (wholes.length) {
    wrap.append(el("h2", { class: "section-title", text: "المؤجرات بالكامل" }));
    for (const row of wholes) wrap.append(unitListCard(row, true));
  }
  if (!tree.length) wrap.append(el("div", { class: "card" }, [el("p", { class: "muted", text: "لا توجد وحدات" })]));
  return wrap;
}

function unitListCard(row, isFull = false) {
  const { unit, spaces, dueTotal, paidTotal, partial, late, vacant } = row;
  const badges = [];
  if (partial) badges.push(`◐ ${partial} جزئي`);
  if (late) badges.push(`⚠ ${late} متأخر`);
  if (vacant) badges.push(`○ ${vacant} فارغ`);
  if (!partial && !late && spaces.length && vacant === 0) badges.push("✓ مكتمل");

  const dueDisp = (dueTotal / 100).toLocaleString("en-US");
  const paidDisp = (paidTotal / 100).toLocaleString("en-US");

  return el("div", {
    class: "card tap",
    onclick: () => {
      state.selectedUnitId = unit.id;
      state.view = "unitDetail";
      state.expandSpaceId = null;
      render();
    },
  }, [
    el("div", { class: "row" }, [
      el("div", [
        el("div", { class: "strong", text: unit.name }),
        el("div", { class: "muted", text: isFull ? "شقة كاملة" : unitKindLabel(unit, spaces.length) }),
      ]),
      el("div", { style: "text-align:left" }, [
        el("div", { class: "strong", text: paidDisp }),
        el("div", { class: "muted", text: `من ${dueDisp}` }),
      ]),
    ]),
    pctBar(paidTotal, dueTotal),
    badges.length ? el("div", { class: "muted", style: "margin-top:8px", text: badges.join(" · ") }) : null,
  ]);
}

/* ───────── unit detail (partitions) ───────── */

function renderUnitDetail() {
  const tree = unitTree().find((t) => t.unit.id === state.selectedUnitId);
  if (!tree) {
    return el("div", [
      el("button", { class: "btn btn-secondary", text: "← رجوع", onclick: () => { state.view = "units"; render(); } }),
      el("p", { text: "الشقة غير موجودة" }),
    ]);
  }
  const { unit, spaces, dueTotal, paidTotal } = tree;
  const wrap = el("div");
  wrap.append(el("button", {
    class: "btn btn-secondary",
    text: "← رجوع للشقق",
    onclick: () => { state.view = "units"; state.selectedUnitId = null; render(); },
  }));

  wrap.append(el("div", { class: "card", style: "margin-top:12px" }, [
    el("div", { class: "h2", text: unit.name }),
    el("div", { class: "muted", text: unitKindLabel(unit, spaces.length) }),
    el("div", { class: "row", style: "margin-top:8px" }, [
      el("span", { text: "المحصّل" }),
      el("strong", { text: `${(paidTotal / 100).toLocaleString("en-US")} من ${(dueTotal / 100).toLocaleString("en-US")}` }),
    ]),
    pctBar(paidTotal, dueTotal),
  ]));

  wrap.append(el("h2", { class: "section-title", text: unit.kind === "whole" ? "الشقة" : "البارتشنات" }));

  for (const entry of spaces) {
    wrap.append(spaceRowCard(entry, unit));
  }
  if (!spaces.length) wrap.append(el("div", { class: "card" }, [el("p", { class: "muted", text: "لا توجد مساحات في هذه الشقة" })]));
  return wrap;
}

function spaceRowCard(entry, unit) {
  const { space, rental, view } = entry;
  const tenant = rental?.tenantName || (space.occupancy === "vacant" ? "—" : "شاغل غير محدد");
  const status = view?.status || (space.occupancy === "vacant" ? "vacant" : space.occupancy === "staff" ? "staff" : "not_due");
  const statusAr = view?.statusAr || (status === "vacant" ? "فارغ" : status === "staff" ? "موظفين" : "—");
  const due = view?.dueDisplay || (rental ? formatLocal(rental.contractualAmountFils) : "0");
  const paid = view?.paidDisplay || "0";
  const rem = view?.remainingDisplay || due;
  const expanded = state.expandSpaceId === space.id;

  const header = el("div", {
    class: "card tap",
    onclick: () => {
      state.expandSpaceId = expanded ? null : space.id;
      render();
    },
  }, [
    el("div", { class: "row" }, [
      el("div", { class: "row", style: "margin:0;gap:8px" }, [
        el("span", { class: "space-id", text: space.name || "—" }),
        statusBadge(status, statusAr),
      ]),
      el("span", { class: "muted", text: expanded ? "▲" : "▼" }),
    ]),
    el("div", { class: "row" }, [
      el("span", { class: "muted", text: "المستأجر" }),
      el("strong", { text: tenant }),
    ]),
    moneyTriple(due, paid, rem),
    view?.status === "partial"
      ? el("div", { class: "muted", style: "margin-top:6px", text: `مدفوع ${paid} · المتبقي ${rem}` })
      : null,
  ]);

  if (!expanded) return header;

  const detail = el("div", { class: "card", style: "border-color:#444;margin-top:-4px" }, [
    el("div", { class: "row" }, [el("span", { class: "muted", text: "الهاتف" }), el("span", { text: rental?.tenantPhone || "—" })]),
    el("div", { class: "row" }, [el("span", { class: "muted", text: "الإيجار التعاقدي" }), el("span", { text: rental ? formatLocal(rental.contractualAmountFils) : "—" })]),
    el("div", { class: "row" }, [el("span", { class: "muted", text: "حالة التحصيل" }), statusBadge(status, statusAr)]),
    el("p", { class: "muted", text: "حالة التحصيل من السجل المالي فقط — لا تُعدَّل يدوياً" }),
    moneyTriple(due, paid, rem),
    el("div", { class: "btn-row" }, [
      view && view.remainingFils > 0
        ? el("button", {
          class: "btn btn-primary",
          text: `استلام المتبقي ${rem}`,
          onclick: (e) => {
            e.stopPropagation();
            openCollect(entry, "cash", String((view.remainingFils || 0) / 100));
          },
        })
        : null,
      view && view.remainingFils > 0
        ? el("button", {
          class: "btn btn-secondary",
          text: "💵 كاش",
          onclick: (e) => { e.stopPropagation(); openCollect(entry, "cash"); },
        })
        : null,
      view && view.remainingFils > 0
        ? el("button", {
          class: "btn btn-secondary",
          text: "🏦 تحويل بنكي",
          onclick: (e) => { e.stopPropagation(); openCollect(entry, "bank"); },
        })
        : null,
      view
        ? el("button", {
          class: "btn btn-secondary",
          text: "سجل الاستلامات",
          onclick: (e) => {
            e.stopPropagation();
            state.selectedObligation = view;
            state.view = "receiptHistory";
            render();
          },
        })
        : null,
      el("button", {
        class: "btn btn-secondary",
        text: "تفاصيل المساحة",
        onclick: (e) => {
          e.stopPropagation();
          state.selectedSpaceId = space.id;
          state.selectedObligation = view;
          state.view = "spaceDetail";
          render();
        },
      }),
    ]),
  ]);

  return el("div", [header, detail]);
}

function formatLocal(fils) {
  return ((Number(fils) || 0) / 100).toLocaleString("en-US");
}

function openCollect(entry, method, amountDefault) {
  state.selectedSpaceId = entry.space.id;
  state.selectedObligation = entry.view;
  state.collectMethod = method;
  state.draft = { amount: amountDefault || String((entry.view?.remainingFils || 0) / 100), bankReference: "" };
  state.view = "collect";
  render();
}

/* ───────── space detail ───────── */

function renderSpaceDetail() {
  const tree = unitTree().find((t) => t.unit.id === state.selectedUnitId || t.spaces.some((s) => s.space.id === state.selectedSpaceId));
  const entry = tree?.spaces.find((s) => s.space.id === state.selectedSpaceId);
  if (!entry) {
    return el("div", [
      el("button", { class: "btn btn-secondary", text: "← رجوع", onclick: () => { state.view = "units"; render(); } }),
      el("p", { text: "المساحة غير موجودة" }),
    ]);
  }
  const unit = tree.unit;
  state.selectedUnitId = unit.id;
  const { space, rental, view } = entry;
  const wrap = el("div");
  wrap.append(el("button", {
    class: "btn btn-secondary",
    text: "← رجوع للشقة",
    onclick: () => { state.view = "unitDetail"; render(); },
  }));
  wrap.append(el("div", { class: "card", style: "margin-top:12px" }, [
    el("div", { class: "muted", text: `${unit.name} → ${spaceTitle(space, unit)}` }),
    el("div", { class: "h2", text: rental?.tenantName || "فارغ" }),
    statusBadge(view?.status || space.occupancy || "vacant", view?.statusAr || space.occupancy || "فارغ"),
    moneyTriple(view?.dueDisplay || "0", view?.paidDisplay || "0", view?.remainingDisplay || "0"),
  ]));

  if (view && view.remainingFils > 0) {
    wrap.append(el("div", { class: "card" }, [
      el("h2", { class: "h2", text: "طريقة التحصيل" }),
      el("div", { class: "btn-row" }, [
        el("button", {
          class: "btn btn-primary",
          text: `استلام المتبقي ${view.remainingDisplay}`,
          onclick: () => openCollect(entry, "cash", String(view.remainingFils / 100)),
        }),
        el("button", {
          class: "btn btn-secondary",
          text: "💵 كاش",
          onclick: () => openCollect(entry, "cash"),
        }),
        el("button", {
          class: "btn btn-secondary",
          text: "🏦 تحويل بنكي",
          onclick: () => openCollect(entry, "bank"),
        }),
      ]),
    ]));
  }
  return wrap;
}

/* ───────── collect ───────── */

function renderCollect() {
  const o = state.selectedObligation;
  if (!o) {
    return el("div", [
      el("button", { class: "btn btn-secondary", text: "← رجوع", onclick: () => { state.view = "units"; render(); } }),
      el("p", { text: "لا يوجد التزام" }),
    ]);
  }
  const isBank = state.collectMethod === "bank";
  return el("div", [
    el("button", {
      class: "btn btn-secondary",
      text: "← رجوع",
      onclick: () => { state.view = "spaceDetail"; render(); },
    }),
    el("div", { class: "card", style: "margin-top:12px" }, [
      el("h2", { class: "h2", text: isBank ? "🏦 تسجيل دفعة بنكية" : "تسجيل تحصيل نقدي فعلي" }),
      el("div", { class: "row" }, [el("span", { class: "muted", text: "المستأجر" }), el("strong", { text: o.tenantName })]),
      moneyTriple(o.dueDisplay, o.paidDisplay, o.remainingDisplay),
      input("المبلغ (درهم)", "amount", "number"),
      isBank ? input("مرجع البنك", "bankReference") : null,
      el("button", {
        class: "btn btn-primary btn-block",
        disabled: state.busy,
        text: isBank ? "تأكيد التحويل البنكي" : "تأكيد استلام المبلغ",
        onclick: async () => {
          const fils = filsFromAed(state.draft.amount);
          if (!fils) return toast("مبلغ غير صالح");
          if (isBank) {
            if (!state.draft.bankReference?.trim()) return toast("مرجع البنك مطلوب");
            await runCommand("submitBankReceipt", {
              obligationId: o.obligationId,
              amountFils: fils,
              collectionDate: today(),
              bankReference: state.draft.bankReference.trim(),
            });
          } else {
            await runCommand("createCashReceipt", {
              obligationId: o.obligationId,
              amountFils: fils,
              collectionDate: today(),
            });
          }
          state.view = "unitDetail";
          state.draft = {};
        },
      }),
    ]),
  ]);
}

function renderReceiptHistory() {
  const oid = state.selectedObligation?.obligationId;
  const rows = (state.app?.receipts || []).filter((r) => r.obligationId === oid);
  const wrap = el("div");
  wrap.append(el("button", {
    class: "btn btn-secondary",
    text: "← رجوع",
    onclick: () => { state.view = "unitDetail"; render(); },
  }));
  wrap.append(el("h1", { class: "h1", style: "margin-top:12px", text: `سجل الاستلامات — ${state.selectedObligation?.tenantName || ""}` }));
  for (const r of rows) {
    wrap.append(el("div", { class: "card" }, [
      el("div", { class: "row" }, [
        el("span", { text: r.method === "bank" ? "تحويل بنكي" : "كاش" }),
        el("strong", { text: moneyDisplay(r.amount.display) }),
      ]),
      el("div", { class: "row" }, [el("span", { class: "muted", text: "الحالة" }), el("span", { text: r.stateLabel })]),
      el("div", { class: "row" }, [el("span", { class: "muted", text: "التاريخ" }), el("span", { text: r.collectionDate })]),
      isOwner() && r.state === "recognized"
        ? el("button", {
          class: "btn btn-danger btn-block",
          text: "عكس الاستلام",
          onclick: () => { state.confirm = { type: "reverseReceipt", id: r.id }; render(); },
        })
        : null,
      state.confirm?.type === "reverseReceipt" && state.confirm.id === r.id
        ? confirmBox("تأكيد عكس الاستلام", async () => {
          await runCommand("reverseReceipt", { receiptId: r.id, reason: "تصحيح" });
          state.view = "receiptHistory";
        })
        : null,
    ]));
  }
  if (!rows.length) wrap.append(el("div", { class: "card" }, [el("p", { class: "muted", text: "لا توجد استلامات" })]));
  return wrap;
}

/* ───────── custody / deposits / expenses / approvals / summary / manage ───────── */

function renderCustody() {
  const rows = state.app?.dashboard?.custody || [];
  const mine = rows.find((r) => r.userId === state.user.userId);
  const wrap = el("div");
  wrap.append(el("h1", { class: "h1", text: "عهدتي" }));
  if (isOwner()) {
    for (const r of rows) {
      const name = (state.app?.users || []).find((u) => u.id === r.userId || u.userId === r.userId)?.displayName || r.userId;
      wrap.append(el("div", { class: "card" }, [
        el("div", { class: "row" }, [el("strong", { text: name }), el("span", { text: moneyDisplay(r.holdingDisplay) })]),
        el("div", { class: "muted", text: `محصّل ${r.collectedDisplay} · مودع ${r.depositedDisplay}` }),
      ]));
    }
  } else if (mine) {
    wrap.append(el("div", { class: "card" }, [
      el("div", { class: "row" }, [el("span", { text: "العهدة الحالية" }), el("strong", { text: moneyDisplay(mine.holdingDisplay) })]),
      el("div", { class: "muted", text: "محصّل كاش ولم يُودع بعد" }),
      el("button", {
        class: "btn btn-primary btn-block",
        style: "margin-top:10px",
        text: "إيداع العهدة",
        onclick: () => { state.view = "deposits"; state.draft = { amount: String((mine.holdingFils || 0) / 100) }; render(); },
      }),
    ]));
  } else {
    wrap.append(el("div", { class: "card" }, [el("p", { class: "muted", text: "لا توجد عهدة حالياً" })]));
  }
  return wrap;
}

function renderDeposits() {
  const accounts = state.app?.accounts || [];
  const defaultAcc = accounts[0]?.id || "";
  const wrap = el("div");
  wrap.append(el("h1", { class: "h1", text: "الإيداعات" }));
  wrap.append(el("div", { class: "card" }, [
    el("h2", { class: "h2", text: "إيداع نقدي" }),
    input("المبلغ (درهم)", "amount", "number"),
    el("button", {
      class: "btn btn-primary btn-block",
      disabled: state.busy || !defaultAcc,
      text: "إرسال للاعتماد",
      onclick: async () => {
        const fils = filsFromAed(state.draft.amount);
        if (!fils) return toast("مبلغ غير صالح");
        await runCommand("submitDeposit", { amountFils: fils, depositDate: today(), destinationAccountId: defaultAcc });
        state.draft = {};
      },
    }),
  ]));
  wrap.append(el("h2", { class: "section-title", text: "سجل الإيداعات" }));
  for (const d of state.app?.deposits || []) {
    wrap.append(el("div", { class: "card" }, [
      el("div", { class: "row" }, [el("strong", { text: moneyDisplay(d.amount.display) }), el("span", { text: d.state })]),
      el("div", { class: "muted", text: d.depositDate }),
      isOwner() && d.state === "approved"
        ? el("button", {
          class: "btn btn-danger btn-block",
          text: "عكس الإيداع",
          onclick: () => { state.confirm = { type: "reverseDeposit", id: d.id }; render(); },
        })
        : null,
      state.confirm?.type === "reverseDeposit" && state.confirm.id === d.id
        ? confirmBox("تأكيد عكس الإيداع", () => runCommand("reverseDeposit", { depositId: d.id, reason: "تصحيح" }))
        : null,
    ]));
  }
  return wrap;
}

function renderExpenses() {
  const accounts = state.app?.accounts || [];
  const defaultAcc = accounts[0]?.id || "";
  const wrap = el("div");
  wrap.append(el("h1", { class: "h1", text: "المصاريف" }));
  wrap.append(el("div", { class: "card" }, [
    input("المبلغ (درهم)", "amount", "number"),
    input("السبب", "reason"),
    input("الفئة", "category", "text", { defaultValue: "عام" }),
    el("button", {
      class: "btn btn-primary btn-block",
      disabled: state.busy || !defaultAcc,
      text: "إرسال للاعتماد",
      onclick: async () => {
        const fils = filsFromAed(state.draft.amount);
        if (!fils || !state.draft.reason?.trim()) return toast("أكمل البيانات");
        await runCommand("submitExpense", {
          amountFils: fils,
          reason: state.draft.reason.trim(),
          category: state.draft.category || "عام",
          expenseDate: today(),
          paidFromAccountId: defaultAcc,
        });
        state.draft = {};
      },
    }),
  ]));
  for (const e of state.app?.expenses || []) {
    wrap.append(el("div", { class: "card" }, [
      el("div", { class: "row" }, [el("strong", { text: moneyDisplay(e.amount.display) }), el("span", { text: e.state })]),
      el("div", { class: "muted", text: `${e.reason} · ${e.expenseDate}` }),
    ]));
  }
  return wrap;
}

function renderApprovals() {
  if (!isOwner()) return el("p", { text: "غير مصرح" });
  const p = state.app?.pending || { bankReceipts: [], deposits: [], expenses: [] };
  const wrap = el("div");
  wrap.append(el("h1", { class: "h1", text: "الطلبات" }));
  for (const r of p.bankReceipts) {
    wrap.append(el("div", { class: "card" }, [
      el("strong", { text: `تحويل بنكي — ${moneyDisplay(r.amount.display)}` }),
      el("div", { class: "btn-row" }, [
        el("button", { class: "btn btn-success", text: "اعتماد", onclick: () => runCommand("approveBankReceipt", { receiptId: r.id }) }),
        el("button", { class: "btn btn-danger", text: "رفض", onclick: () => runCommand("rejectBankReceipt", { receiptId: r.id, reason: "مرفوض" }) }),
      ]),
    ]));
  }
  for (const d of p.deposits) {
    wrap.append(el("div", { class: "card" }, [
      el("strong", { text: `إيداع — ${moneyDisplay(d.amount.display)}` }),
      el("div", { class: "btn-row" }, [
        el("button", { class: "btn btn-success", text: "اعتماد", onclick: () => runCommand("approveDeposit", { depositId: d.id }) }),
        el("button", { class: "btn btn-danger", text: "رفض", onclick: () => runCommand("rejectDeposit", { depositId: d.id, reason: "مرفوض" }) }),
      ]),
    ]));
  }
  for (const e of p.expenses) {
    wrap.append(el("div", { class: "card" }, [
      el("strong", { text: `مصروف — ${moneyDisplay(e.amount.display)}` }),
      el("div", { class: "muted", text: e.reason }),
      el("div", { class: "btn-row" }, [
        el("button", { class: "btn btn-success", text: "اعتماد", onclick: () => runCommand("approveExpense", { expenseId: e.id }) }),
        el("button", { class: "btn btn-danger", text: "رفض", onclick: () => runCommand("rejectExpense", { expenseId: e.id, reason: "مرفوض" }) }),
      ]),
    ]));
  }
  if (!p.bankReceipts.length && !p.deposits.length && !p.expenses.length) {
    wrap.append(el("div", { class: "card" }, [el("p", { class: "muted", text: "لا توجد طلبات معلّقة" })]));
  }
  return wrap;
}

function renderSummary() {
  const f = state.app?.dashboard?.formatted;
  const wrap = el("div");
  wrap.append(periodNav());
  wrap.append(el("h1", { class: "h1", text: "المالية" }));
  wrap.append(el("div", { class: "card" }, [
    el("div", { class: "row" }, [el("span", { text: "المستهدف" }), el("strong", { text: moneyDisplay(f?.target || "0") })]),
    el("div", { class: "row" }, [el("span", { text: "المحصّل" }), el("strong", { text: moneyDisplay(f?.collected || "0") })]),
    el("div", { class: "row" }, [el("span", { text: "المتبقي" }), el("strong", { text: moneyDisplay(f?.remaining || "0") })]),
    el("div", { class: "row" }, [el("span", { text: "المودع" }), el("strong", { text: moneyDisplay(f?.deposited || "0") })]),
    el("div", { class: "row" }, [el("span", { text: "محصّل ولم يُودع بعد" }), el("strong", { text: moneyDisplay(f?.holding || "0") })]),
    el("div", { class: "row" }, [el("span", { text: "المتأخرات" }), el("strong", { text: moneyDisplay(f?.arrears || "0") })]),
  ]));
  return wrap;
}

function renderManage() {
  if (!isOwner()) return el("p", { text: "غير مصرح" });
  const wrap = el("div");
  wrap.append(el("h1", { class: "h1", text: "إدارة" }));
  wrap.append(el("p", { class: "muted", text: "إعدادات ثانوية — العمل اليومي من الوحدات" }));

  wrap.append(el("div", { class: "card" }, [
    el("h2", { class: "h2", text: "توليد التزامات الشهر" }),
    el("button", {
      class: "btn btn-primary btn-block",
      text: `توليد ${state.period}`,
      onclick: () => runCommand("generateObligations", { period: state.period }),
    }),
  ]));

  wrap.append(el("div", { class: "card" }, [
    el("h2", { class: "h2", text: "موظف جديد" }),
    input("الاسم", "userName"),
    input("الرقم السري", "userPin"),
    el("button", {
      class: "btn btn-primary btn-block",
      text: "إنشاء موظف",
      onclick: () => runCommand("createUser", { displayName: state.draft.userName, role: "employee", pin: state.draft.userPin }),
    }),
  ]));

  wrap.append(el("h2", { class: "section-title", text: "المستخدمون" }));
  for (const u of state.app?.users || []) {
    wrap.append(el("div", { class: "card" }, [
      el("div", { class: "row" }, [
        el("strong", { text: u.displayName }),
        el("span", { class: "muted", text: roleLabelAr(u.role) }),
      ]),
    ]));
  }

  wrap.append(el("div", { class: "card" }, [
    el("h2", { class: "h2", text: "سجل التدقيق" }),
    el("button", {
      class: "btn btn-secondary btn-block",
      text: "عرض السجل",
      onclick: () => { state.view = "audit"; render(); },
    }),
  ]));

  // Keep create structure available but secondary
  const props = state.app?.properties || [];
  wrap.append(el("div", { class: "card" }, [
    el("h2", { class: "h2", text: "عقار / وحدة / مساحة / عقد" }),
    input("اسم عقار جديد", "propName"),
    el("button", {
      class: "btn btn-secondary btn-block",
      text: "إنشاء عقار",
      onclick: () => runCommand("createProperty", { name: state.draft.propName, address: state.draft.propAddress || undefined }),
    }),
    props[0] ? input("اسم شقة جديدة", "unitName") : null,
    props[0] ? el("button", {
      class: "btn btn-secondary btn-block",
      text: "إنشاء شقة",
      onclick: () => runCommand("createUnit", { propertyId: props[0].id, name: state.draft.unitName, kind: "partitioned" }),
    }) : null,
  ]));

  const units = state.app?.units || [];
  if (units[0]) {
    wrap.append(el("div", { class: "card" }, [
      input("اسم بارتشن جديد", "spaceName"),
      el("button", {
        class: "btn btn-secondary btn-block",
        text: `إضافة بارتشن إلى ${units[0].name}`,
        onclick: () => runCommand("createSpace", { unitId: units[0].id, name: state.draft.spaceName }),
      }),
    ]));
  }

  const vacant = (state.app?.spaces || []).filter((s) => s.occupancy === "vacant");
  if (vacant[0]) {
    wrap.append(el("div", { class: "card" }, [
      el("h2", { class: "h2", text: "عقد إيجار لمساحة فارغة" }),
      el("div", { class: "muted", text: vacant[0].name }),
      input("اسم المستأجر", "tenantName"),
      input("الإيجار الشهري (درهم)", "rentAed", "number"),
      input("يوم الاستحقاق", "dueDay", "number", { defaultValue: "1" }),
      el("button", {
        class: "btn btn-primary btn-block",
        text: "إنشاء عقد",
        onclick: async () => {
          const fils = filsFromAed(state.draft.rentAed);
          if (!fils || !state.draft.tenantName) return toast("أكمل البيانات");
          await runCommand("createRental", {
            spaceId: vacant[0].id,
            tenantName: state.draft.tenantName,
            contractualAmountFils: fils,
            dueDayOfMonth: Number(state.draft.dueDay) || 1,
            startDate: today(),
          });
        },
      }),
    ]));
  }

  for (const r of (state.app?.rentals || []).filter((x) => x.state === "active").slice(0, 20)) {
    wrap.append(el("div", { class: "card" }, [
      el("div", { class: "row" }, [el("strong", { text: r.tenantName }), el("span", { class: "muted", text: "نشط" })]),
      el("button", {
        class: "btn btn-danger btn-block",
        text: "إغلاق العقد",
        onclick: () => runCommand("closeRental", { rentalId: r.id, endDate: today(), reason: "إغلاق", setVacant: true }),
      }),
    ]));
  }

  return wrap;
}

function renderAudit() {
  if (!isOwner()) return el("p", { text: "غير مصرح" });
  const wrap = el("div");
  wrap.append(el("button", { class: "btn btn-secondary", text: "← رجوع", onclick: () => { state.view = "manage"; render(); } }));
  wrap.append(el("h1", { class: "h1", style: "margin-top:12px", text: "السجل" }));
  for (const a of state.app?.auditEvents || []) {
    wrap.append(el("div", { class: "card" }, [
      el("div", { class: "row" }, [el("span", { text: a.action }), el("span", { class: "muted", text: a.at })]),
      el("div", { class: "muted", text: `${a.actorUserId || ""} · ${a.targetType || ""}` }),
    ]));
  }
  return wrap;
}

/* ───────── main render ───────── */

function render() {
  if (state.view === "login" || !state.user) return renderLogin();

  clear(root);
  root.append(renderHeader());
  root.append(renderTabs());

  const body = el("div", { class: "content" });
  const screens = {
    home: renderHome,
    units: renderUnits,
    unitDetail: renderUnitDetail,
    spaceDetail: renderSpaceDetail,
    collect: renderCollect,
    receiptHistory: renderReceiptHistory,
    custody: renderCustody,
    deposits: renderDeposits,
    expenses: renderExpenses,
    approvals: renderApprovals,
    summary: renderSummary,
    manage: renderManage,
    audit: renderAudit,
  };
  const node = screens[state.view]?.();
  if (node) body.append(node);
  else body.append(el("p", { text: "شاشة غير معروفة" }));
  root.append(body);
}

render();
