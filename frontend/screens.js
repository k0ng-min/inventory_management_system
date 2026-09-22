/* ==========================================================================
   screens.js — 업무 화면 정의
   각 화면은 { el, refresh } 를 돌려주고, app.js 의 탭 매니저가 보관합니다.
   ========================================================================== */

import {
  h, esc, api, fmt, toast, guard, grid, exportCsv, openForm, openPanel, confirmAsk,
  statusChip, bindRowActions, closeModal, today, addDays, monthStart, monthEnd, $,
} from "./core.js";
import { makeSelect, makeDate } from "./controls.js";

/** 서버의 CATEGORIES 와 같은 순서·라벨. 화면에서 분류 이름을 보여줄 때 씁니다. */
const CATEGORY_LABELS = {
  cable: "전선/케이블", breaker: "차단기", conduit: "전선관/배관", panel: "분전반",
  wiring: "콘센트/스위치", terminal: "터미널/압착단자", tool: "공구",
  consumable: "소모품", etc: "기타",
};
const PRICE_BASIS_LABELS = { retail: "시세", contract: "계약", quote: "견적" };
const priceBasisLabel = (value) => PRICE_BASIS_LABELS[value] || "견적";
const safeExternalUrl = (value) => /^https?:\/\//i.test(String(value || "")) ? String(value) : "";

/* ---------- 탭 열기 훅 — app.js 의 탭 매니저가 주입합니다 ------------------- */

export const nav = { open: () => {} };
const openScreen = (screenId) => nav.open(screenId);

/* ---------- 공통 조회 데이터 캐시 ------------------------------------------ */

export const ref = {
  products: [], suppliers: [], customers: [], warehouses: [], projects: [], me: null,

  async reload() {
    const [products, suppliers, customers, warehouses, projects] = await Promise.all([
      api("/api/products"), api("/api/suppliers"), api("/api/customers"),
      api("/api/warehouses"), api("/api/projects"),
    ]);
    Object.assign(this, { products, suppliers, customers, warehouses, projects });
  },
  opt(list, label = (row) => row.name) {
    return list.map((row) => ({ value: row.id, label: label(row) }));
  },
  get productOpts() { return this.opt(this.products.filter((p) => p.active), (p) => `${p.name} (${p.id})`); },
  get supplierOpts() { return this.opt(this.suppliers); },
  get customerOpts() { return this.opt(this.customers); },
  get warehouseOpts() { return this.opt(this.warehouses.filter((w) => w.active)); },
  get projectOpts() { return this.opt(this.projects, (p) => `${p.name} · ${p.manager || "-"}`); },
  product: (id) => ref.products.find((row) => row.id === id),
  warehouse: (id) => ref.warehouses.find((row) => row.id === id),
  project: (id) => ref.projects.find((row) => row.id === id),
  /** 금액 열람 범위 — 서버가 로그인 응답에 실어 보냅니다. */
  get canFinance() { return Boolean(ref.me?.scope?.finance); },
  get canPrices() { return Boolean(ref.me?.scope?.prices); },
  /** 메뉴·화면의 need 조건을 평가합니다. */
  allows(need) {
    if (!need) return true;
    if (need === "finance") return ref.canFinance;
    if (need === "prices") return ref.canPrices;
    if (need === "admin") return ref.me?.role === "admin";
    return true;
  },
  can(area) {
    const role = ref.me?.role;
    return ({
      master: ["admin", "purchasing"], purchasing: ["admin", "purchasing"],
      warehouse: ["admin", "warehouse"],
      sales: ["admin"], accounting: ["admin"], bids: ["admin"], system: ["admin"],
      schedule: ["admin", "purchasing", "warehouse"],   // 팀 일정은 서로 고칩니다 (조회 전용 제외)
    }[area] || []).includes(role);
  },
};

/* ---------- 화면 뼈대 ------------------------------------------------------ */

/**
 * 표준 조회 화면을 만듭니다.
 * def: { crumb, title, filters(state, refresh), load(state), columns(state, refresh),
 *        summary(rows, state), rowActions(refresh, state), actions(state, refresh),
 *        footer, empty, idKey, exportName, onRowClick }
 */
function dataScreen(def) {
  return function build() {
    const state = { ...(def.initialState || {}) };
    let rows = [];

    const filterHost = h("div.filterbar");
    const summaryHost = h("div");
    const gridHost = h("div.screen-body");
    const headHost = h("div.head-actions");

    async function refresh() {
      rows = (await def.load(state, rows)) || [];
      const columns = def.columns(state, refresh, rows);
      const node = grid({
        rows, columns,
        footer: def.footer, empty: def.empty,
        idKey: def.idKey || "id",
        onRowClick: def.onRowClick && ((row) => def.onRowClick(row, refresh, state)),
        rowClass: def.rowClass,
        selectedId: state.selectedId,
      });
      if (def.rowActions) bindRowActions(node, rows, def.idKey || "id", def.rowActions(refresh, state));
      gridHost.replaceChildren(node);
      summaryHost.replaceChildren(...(def.summary ? [def.summary(rows, state, refresh)].flat().filter(Boolean) : []));
      headHost.replaceChildren(
        ...[
          ...(def.actions ? [def.actions(state, refresh, rows)].flat().filter(Boolean) : []),
          def.exportName === false ? null
            : h("button.btn", { onclick: () => exportCsv(def.exportName || def.title, def.columns(state, refresh, rows), rows) }, "엑셀"),
          h("button.btn.primary", { onclick: () => refresh() }, "조회"),
        ].filter(Boolean));
      if (def.afterRefresh) def.afterRefresh(rows, state, refresh);
    }

    if (def.filters) filterHost.replaceChildren(...[def.filters(state, refresh)].flat().filter(Boolean));

    const el = h("div.screen", {},
      h("div.screen-head", {},
        h("div", {}, h("div.crumb", { text: def.crumb }), h("h1", { text: def.title })),
        headHost),
      h("div", {}, def.filters ? filterHost : null, summaryHost),
      gridHost);

    return { el, refresh };
  };
}

/** 스크롤되는 자유형 화면(대시보드·분석·설정 등). */
function panelScreen(def) {
  return function build() {
    const state = { ...(def.initialState || {}) };
    const body = h("div.screen-body");
    const headHost = h("div.head-actions");
    const filterHost = h("div.filterbar");

    async function refresh() {
      const content = await def.render(state, refresh);
      body.replaceChildren(...[content].flat().filter(Boolean));
      headHost.replaceChildren(...[
        ...(def.actions ? [def.actions(state, refresh)].flat().filter(Boolean) : []),
        h("button.btn.primary", { onclick: () => refresh() }, "새로고침"),
      ].filter(Boolean));
    }

    if (def.filters) filterHost.replaceChildren(...[def.filters(state, refresh)].flat().filter(Boolean));

    const el = h("div.screen.scroll", {},
      h("div.screen-head", {},
        h("div", {}, h("div.crumb", { text: def.crumb }), h("h1", { text: def.title })),
        headHost),
      def.filters ? filterHost : h("div"),
      body);

    return { el, refresh };
  };
}

/* ---------- 작은 UI 조각 --------------------------------------------------- */

const fld = (label, ...controls) => h("div.field", {}, label ? h("label", { text: label }) : null, ...controls);

const input = (state, key, opts = {}) => {
  if (opts.type === "date") {
    const picker = makeDate({ value: state[key] ?? "" });
    picker.style.width = `${opts.width || 150}px`;
    picker.addEventListener("change", () => { state[key] = picker.value; opts.onInput?.(); opts.onEnter?.(); });
    return picker;
  }
  const node = h("input", {
    type: opts.type || "text", value: state[key] ?? "",
    placeholder: opts.placeholder || "",
    style: { width: `${opts.width || 130}px` },
  });
  node.addEventListener("input", () => { state[key] = node.value; opts.onInput?.(); });
  if (opts.onEnter) node.addEventListener("keydown", (event) => { if (event.key === "Enter") opts.onEnter(); });
  return node;
};

const select = (state, key, options, opts = {}) => {
  const node = makeSelect({
    options,
    value: state[key] ?? "",
    allowEmpty: opts.all !== false,
    emptyLabel: opts.allLabel || "전체",
    placeholder: opts.allLabel || (opts.all === false ? "선택" : "전체"),
  });
  node.style.width = `${opts.width || 160}px`;
  node.addEventListener("change", () => { state[key] = node.value; opts.onChange?.(); });
  return node;
};

const dateRange = (state, refresh, fromKey = "from", toKey = "to") =>
  fld("조회기간",
    input(state, fromKey, { type: "date", width: 130 }),
    h("span.sep", {}, "~"),
    input(state, toKey, { type: "date", width: 130 }),
    h("button.btn.sm", { onclick: () => { state[fromKey] = monthStart(); state[toKey] = monthEnd(); refresh(); } }, "이번달"),
    h("button.btn.sm", { onclick: () => { state[fromKey] = addDays(today(), -30); state[toKey] = today(); refresh(); } }, "최근30일"));

const sum = (rows, key) => rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);

const strip = (entries) => h("div.summary", {}, entries.filter(Boolean).map(([label, value, tone]) =>
  h("div", {}, h("span", { text: label }), h(`b${tone ? `.${tone}` : ""}`, { html: value }))));

const btn = (label, onclick, kind = "") => h(`button.btn${kind ? `.${kind}` : ""}`, { onclick }, label);
const act = (label, kind = "") => `<button class="btn sm${kind ? ` ${kind}` : ""}" data-act="${esc(label)}">${esc(label)}</button>`;
const acts = (...items) => `<div class="rowbtns">${items.filter(Boolean).join("")}</div>`;

const rank = (items, valueKey = "amount", labelKey = "label", format = fmt.won) => {
  const max = Math.max(1, ...items.map((item) => Number(item[valueKey]) || 0));
  return h("div.rank", {}, items.slice(0, 8).map((item) => h("div.rank-row", {},
    h("span", { text: item[labelKey] || "-" }),
    h("b", { text: format(item[valueKey]) }),
    h("i", {}, h("u", { style: { width: `${((Number(item[valueKey]) || 0) / max) * 100}%` } })))));
};

const panel = (title, body, headExtra) =>
  h("div.panel", {}, h("div.panel-head", {}, h("h3", { text: title }), headExtra || null),
    h("div.panel-body" + (body?.classList?.contains("gridwrap") ? ".flush" : ""), {}, body));

/* ==========================================================================
   홈 — 경영현황
   ========================================================================== */

/* ---------- 대시보드 조각 ------------------------------------------------ */

const SEG_COLORS = ["var(--accent)", "#60a5fa", "#a5b4fc", "#f59e0b", "#94a3b8"];

/* 가는 선 아이콘 — 이모지나 기호 대신 써서 밀도와 정렬이 흐트러지지 않습니다 */
const ICON_PATHS = {
  project: '<path d="M3 21h18M5 21V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v16M9 8h2M9 12h2M9 16h2M15 21V10h3a1 1 0 0 1 1 1v10"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  inbound: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  box: '<path d="m21 8-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8"/>',
  coin: '<circle cx="12" cy="12" r="9"/><path d="m8 9 4 6 4-6M9.5 12.5h5M9.5 15h5"/>',
  gavel: '<path d="M14 3 21 10M17.5 6.5 10.5 13.5M3 21h10M6 18 13 11M9 8l7 7"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
  stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ""}</svg>`;

/** KPI 카드 — 누르면 해당 업무 화면이 열립니다. */
const metric = ({ label, value, unit, note, name, tone, to }) =>
  h("button.metric", { onclick: () => openScreen(to), title: `${label} 열기` },
    h("div.metric-top", {},
      h("span", { text: label }),
      h(`i.metric-ico${tone ? `.${tone}` : ""}`, { html: icon(name) })),
    h("strong", {}, value, unit ? h("small", { text: unit }) : null),
    h("div.metric-foot", {}, note));

/** 도넛 차트 — 세그먼트 사이에 얇은 간격을 둡니다. */
function donut(segments, centerValue, centerLabel) {
  const total = segments.reduce((acc, item) => acc + item.value, 0) || 1;
  const radius = 62;
  const circumference = 2 * Math.PI * radius;
  const gap = segments.length > 1 ? 6 : 0;
  let offset = 0;
  const arcs = segments.map((segment, index) => {
    const share = segment.value / total;
    const length = Math.max(0, share * circumference - gap);
    const arc = `<circle cx="74" cy="74" r="${radius}" fill="none"
      stroke="${SEG_COLORS[index % SEG_COLORS.length]}" stroke-width="16" stroke-linecap="round"
      stroke-dasharray="${length} ${circumference - length}" stroke-dashoffset="${-offset}"></circle>`;
    offset += share * circumference;
    return arc;
  }).join("");

  return h("div.donut-wrap", {},
    h("div.donut", {},
      h("div", {
        html: `<svg width="148" height="148" viewBox="0 0 148 148" aria-hidden="true">
          <circle cx="74" cy="74" r="${radius}" fill="none" stroke="var(--surface-3)" stroke-width="16"></circle>
          ${arcs}</svg>`,
      }),
      h("div.mid", {}, h("b", { text: centerValue }), h("span", { text: centerLabel }))),
    h("div.legend", {}, segments.map((segment, index) => h("div", {},
      h("i", { style: { background: SEG_COLORS[index % SEG_COLORS.length] } }),
      h("span", { text: segment.label }),
      h("b", { text: `${Math.round((segment.value / total) * 100)}%` })))));
}

/** 세로 막대 스파크 — 마지막 막대를 강조합니다. */
function spark(values, labels) {
  if (!values.length) return h("p.muted", { style: { margin: "10px 0 0" }, text: "기록 없음" });
  const max = Math.max(1, ...values);
  return h("div", {},
    h("div.spark", {}, values.map((value, index) =>
      h(`i${index === values.length - 1 ? ".hi" : ""}`, {
        style: { height: `${Math.max(6, (value / max) * 100)}%` },
        title: `${labels?.[index] ?? index} · ${fmt.int(value)}`,
      }))),
    labels?.length
      ? h("div.spark-x", {}, h("span", { text: fmt.date(labels[0]) }), h("span", { text: fmt.date(labels[labels.length - 1]) }))
      : null);
}

const statBlock = (label, value, unit, delta) => h("div.stat", {},
  h("div.lbl", { text: label }),
  h("div.val", {}, value, unit ? h("sup", { text: unit }) : null),
  delta ? h(`div.delta${String(delta).startsWith("-") ? ".down" : ""}`, { text: delta }) : null);

const segToggle = (options, active, onPick) =>
  h("div.seg", {}, options.map((option) =>
    h(`button${option === active ? ".on" : ""}`, { onclick: () => onPick(option) }, option)));

/* ---------- 경영 현황 ------------------------------------------------------ */


/** 대시보드의 '다가오는 일정' — 달력을 열지 않고도 2주치를 훑게 해 줍니다. */
function upcomingPanel(schedules) {
  const rows = schedules.slice(0, 8);
  return h("div.panel", {},
    h("div.panel-head", {},
      h("h3", { text: `다가오는 일정 ${schedules.length}건` }),
      h("button.btn.sm", { onclick: () => openScreen("home.calendar") }, "달력 보기")),
    h("div.panel-body", {},
      rows.length
        ? h("div.sched-mini", {}, rows.map((row) => h(`div.sched-mini-row.bar-${row.kind}`, {},
          h("time", { text: row.start_date === row.end_date
            ? fmt.date(row.start_date)
            : `${fmt.date(row.start_date)}~${fmt.date(row.end_date)}` }),
          h("b", { text: row.title }),
          h("span.who", { text: row.assignee_list.join(", ") || row.kind_label }))))
        : h("p.muted", { text: "오늘부터 2주 안에 잡힌 일정이 없습니다." })));
}

const dashboard = panelScreen({
  crumb: "홈", title: "경영 현황",
  initialState: { span: "이번 달" },
  actions: () => [],
  async render(state, refresh) {
    const [summary, inventory, orders, bidData, logs, reports, adjustments, salesRows, schedules] = await Promise.all([
      api("/api/summary"),
      api("/api/inventory"),
      api("/api/purchase-orders"),
      // 입찰·분석은 관리자 전용이라, 나머지 화면이 같이 깨지지 않게 빈 값으로 대체합니다.
      ref.allows("admin")
        ? api(`/api/bids?from=${today()}&to=${addDays(today(), 21)}&dateField=close_date`)
        : Promise.resolve({ notices: [] }),
      api("/api/audit-logs"),
      ref.allows("admin") ? api("/api/reports") : Promise.resolve({}),
      api("/api/stock-adjustments"),
      ref.canFinance ? api("/api/sales-orders") : Promise.resolve([]),
      api(`/api/schedules?from=${today()}&to=${addDays(today(), 13)}`),
    ]);

    const incoming = orders.filter((order) => ["발주완료", "부분입고"].includes(order.status));
    const shortage = inventory.filter((row) => row.shortage);
    const onHand = sum(inventory, "on_hand");
    const available = sum(inventory, "available");
    const usableRate = onHand ? Math.round((available / onHand) * 100) : 0;
    const shrink = adjustments.filter((row) => row.diff < 0);
    const bids = bidData.notices;
    const waiting = summary.pendingRequests + summary.pendingApprovals;
    const hasBusinessData = Boolean(
      summary.activeProjects || summary.monthSales || summary.monthPurchase ||
      summary.receivable || summary.payable || inventory.length || orders.length ||
      bids.length || logs.length || salesRows.length,
    );
    if (!hasBusinessData) {
      return [h("div.dashboard-empty", {},
        h("div.dashboard-empty-icon", { text: "+" }),
        h("h2", { text: "업무 데이터를 입력하면 경영 현황이 표시됩니다" }),
        h("p", { text: "공사, 자재, 거래처, 창고와 거래 내역을 등록하면 이 화면에 실제 수치만 표시됩니다." }),
        h("div.dashboard-empty-actions", {},
          h("button.btn.primary", { onclick: () => openScreen("base.project") }, "공사 등록"),
          h("button.btn", { onclick: () => openScreen("base.product") }, "자재 등록"),
          h("button.btn", { onclick: () => openScreen("base.supplier") }, "거래처 등록"),
        ),
      )];
    }

    // 기간 토글 — 입고예정 카드의 납기 범위
    const spanDays = { "오늘": 0, "이번 주": 7, "이번 달": 31 }[state.span] ?? 31;
    const limit = addDays(today(), spanDays);
    const inSpan = incoming.filter((order) => !order.due_date || order.due_date <= limit);

    // 매출 기준선 — 임의 목표 대신 직전 3개월 실적 평균
    const salesByMonth = reports.salesByMonth || [];
    const projectMargin = reports.projectMargin || [];
    const pastMonths = salesByMonth.filter((row) => row.label && row.label < today().slice(0, 7));
    const recent = pastMonths.slice(-3);
    const baseline = recent.length ? Math.round(recent.reduce((acc, row) => acc + row.amount, 0) / recent.length) : 0;
    const goalRate = baseline ? Math.round((summary.monthSales / baseline) * 100) : 0;
    const goalBars = 32;

    // 창고별 재고자산
    const byWarehouse = new Map();
    for (const row of inventory) {
      const value = row.on_hand * (row.price || 0);
      if (value > 0) byWarehouse.set(row.warehouse_name, (byWarehouse.get(row.warehouse_name) || 0) + value);
    }
    const distribution = [...byWarehouse.entries()]
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value);

    const kpiRows = [
      { metric: "재고 자산", value: fmt.won(summary.inventoryValue), change: `${inventory.length}개 로케이션`, state: "정상" },
      { metric: "이번 달 매출", value: fmt.won(summary.monthSales), change: baseline ? `기준선 대비 ${goalRate}%` : "기준선 없음", state: !baseline ? "확인" : goalRate >= 100 ? "양호" : goalRate >= 70 ? "보통" : "주의" },
      { metric: "이번 달 매입·경비", value: fmt.won(summary.monthPurchase), change: `발주 ${orders.length}건`, state: "정상" },
      { metric: "미수금", value: fmt.won(summary.receivable), change: "회수 예정", state: summary.receivable > 0 ? "주의" : "양호" },
      { metric: "미지급금", value: fmt.won(summary.payable), change: "발주 잔액", state: "정상" },
      { metric: "안전재고 미달", value: `${summary.lowStockItems}품목`, change: `가용재고율 ${usableRate}%`, state: summary.lowStockItems ? "주의" : "양호" },
    ];
    const toneOf = (value) => ({ 양호: "solid", 정상: "solid", 주의: "bad", 보통: "warn", 확인: "warn" }[value] || "mid");

    return [
      /* ---------- KPI 스트립 ---------- */
      h("div.metrics", {},
        metric({ label: "진행 중 공사", value: summary.activeProjects, unit: "건", name: "project", to: "base.project",
          note: h("span", { text: "완료되지 않은 현장" }) }),
        metric({ label: "승인 대기", value: waiting, unit: "건", name: "clock", to: "pur.request",
          tone: waiting ? "warn" : undefined,
          note: h("span", { text: `구매요청 ${summary.pendingRequests} · 발주 ${summary.pendingApprovals}` }) }),
        metric({ label: "입고 예정", value: summary.incomingOrders, unit: "건", name: "inbound", to: "pur.receive",
          note: h("span", { text: `미입고 ${fmt.int(sum(incoming, "remaining"))}EA` }) }),
        metric({ label: "안전재고 미달", value: summary.lowStockItems, unit: "품목", name: "alert", to: "inv.status",
          tone: summary.lowStockItems ? "bad" : "ok",
          note: h("span", { text: `가용재고율 ${usableRate}%` }) }),
        ref.canFinance
          ? metric({ label: "재고 자산", value: fmt.wonShort(summary.inventoryValue), name: "box", to: "inv.status",
            note: h("span", { text: `현재고 ${fmt.int(onHand)}EA` }) })
          : metric({ label: "총 재고", value: fmt.int(onHand), unit: "EA", name: "box", to: "inv.status",
            note: h("span", { text: `${inventory.length}개 로케이션` }) }),
        ref.canFinance
          ? metric({ label: "미수금", value: fmt.wonShort(summary.receivable), name: "coin", to: "sal.order",
            tone: summary.receivable > 0 ? "warn" : "ok",
            note: h("span", { text: `미지급금 ${fmt.wonShort(summary.payable)}` }) })
          : metric({ label: "다가오는 일정", value: schedules.length, unit: "건", name: "clock", to: "home.calendar",
            note: h("span", { text: "오늘부터 2주" }) })),

      /* ---------- 입고 예정 · 매출 · 재고 분포 ---------- */
      h(`div.cols${ref.canFinance ? "3.report" : "2"}`, {},
        h("div.stat-card", {},
          h("div.panel-head", {},
            h("h3", { text: "입고 예정" }),
            h("div.grow"),
            segToggle(["오늘", "이번 주", "이번 달"], state.span, (pick) => { state.span = pick; refresh(); })),
          h("div.stat-row", {},
            statBlock("수량", fmt.int(sum(inSpan, "remaining")), "EA", `${inSpan.length}건 / 전체 ${incoming.length}건`),
            statBlock("금액", fmt.wonShort(sum(inSpan, "amount")), "원"),
            statBlock("공급처", `${new Set(inSpan.map((order) => order.supplier_name)).size}`, "곳")),
          h("div", { style: { marginTop: "20px", display: "flex", gap: "8px" } },
            h("button.btn.primary.sm", { onclick: () => openScreen("pur.receive") }, "입고처리"),
            h("button.btn.sm", { onclick: () => openScreen("pur.order") }, "발주서"))),

        ref.canFinance ? h("div.panel", {},
          h("div.panel-head", {}, h("h3", { text: "이번 달 매출" })),
          h("div.panel-body", {},
            h("div.goal-val", { text: baseline ? `${goalRate}%` : fmt.wonShort(summary.monthSales) }),
            baseline
              ? h("div.goal-meter", {}, Array.from({ length: goalBars }, (unused, index) =>
                h(`i${index < Math.round((Math.min(goalRate, 100) / 100) * goalBars) ? ".on" : ""}`)))
              : salesByMonth.length >= 3
                ? h("div", { style: { margin: "18px 0 14px" } },
                  spark(salesByMonth.map((row) => row.amount), salesByMonth.map((row) => row.label)))
                : h("div.legend", { style: { margin: "20px 0 16px" } },
                  [["매출 건수", `${salesRows.length}건`], ["수금 완료", fmt.won(sum(salesRows, "received"))], ["미수금", fmt.won(sum(salesRows, "outstanding"))]]
                    .map(([label, value]) => h("div", {}, h("span", { text: label }), h("b", { text: value })))),
            h("div.goal-note", {
              text: baseline
                ? `${fmt.won(summary.monthSales)} · 직전 ${recent.length}개월 평균 ${fmt.won(baseline)} 기준`
                : `${fmt.won(summary.monthSales)} · 비교할 직전 월 실적이 아직 없습니다.`,
            }))) : null,

        h("div.panel", {},
          h("div.panel-head", {}, h("h3", { text: ref.canFinance ? "창고별 재고자산" : "창고별 재고 비중" })),
          h("div.panel-body", {},
            distribution.length
              ? donut(distribution,
                ref.canFinance ? fmt.wonShort(summary.inventoryValue) : fmt.int(onHand),
                ref.canFinance ? "재고 자산" : "총 수량")
              : h("p.muted", { text: "재고가 없습니다." })))),

      /* ---------- 처리할 일 ---------- */
      h("div.cols2", {},
        h("div.panel", {},
          h("div.panel-head", {},
            h("h3", { text: `안전재고 미달 ${shortage.length}건` }),
            h("button.btn.sm", { onclick: () => openScreen("inv.status") }, "재고현황")),
          h("div.panel-body", {}, shortage.length ? grid({
            rows: shortage,
            idKey: "product_id",
            columns: [
              { key: "product_name", label: "품목", cls: "strong ellip", width: 176, sortable: false },
              { key: "warehouse_name", label: "창고", width: 122, sortable: false },
              { key: "available", label: "가용", align: "num", width: 68, sortable: false, cell: (r) => `<b>${fmt.int(r.available)}</b>` },
              { key: "safety_stock", label: "안전", align: "num", width: 68, sortable: false },
              { key: "_s", label: "상태", width: 90, sortable: false, cell: () => statusChip("부족") },
            ],
          }) : h("p.muted", { text: "모든 품목이 안전재고 이상입니다." }))),

        // 입찰은 관리자 전용이라, 그 밖의 역할에는 같은 자리에 팀 일정을 보여 줍니다.
        ref.allows("admin")
          ? h("div.panel", {},
            h("div.panel-head", {},
              h("h3", { text: `마감 임박 입찰 ${bids.length}건` }),
              h("button.btn.sm", { onclick: () => openScreen("bid.list") }, "입찰공고")),
            h("div.panel-body", {}, bids.length ? grid({
              rows: bids.slice(0, 7),
              columns: [
                { key: "close_date", label: "마감", width: 148, sortable: false, cell: (r) => dueCell(fmt.date(r.close_date)) },
                { key: "kind", label: "구분", width: 74, sortable: false, cell: (r) => statusChip(r.kind, "mid") },
                { key: "title", label: "공고명", cls: "ellip", width: 150, sortable: false },
                { key: "base_amount", label: "기초금액", align: "num", width: 96, sortable: false, cell: (r) => fmt.wonShort(r.base_amount) },
              ],
            }) : h("p.muted", { text: "3주 이내 마감 예정 공고가 없습니다." })))
          : upcomingPanel(schedules)),

      /* ---------- 팀 일정 ---------- */
      ref.allows("admin") ? h("div.cols2", {}, upcomingPanel(schedules), h("div")) : null,

      /* ---------- 추이 ---------- */
      h("div.cols2", {},
        ref.canFinance ? h("div.panel", {},
          h("div.panel-head", {},
            h("h3", { text: "공사별 매출" }),
            h("button.btn.sm", { onclick: () => openScreen("prj.cost") }, "원가 보기")),
          h("div.panel-body", {}, rank(projectMargin.filter((row) => row.sales || row.cost), "sales"))) : null,

        h("div.panel", {},
          h("div.panel-head", {},
            h("h3", { text: "재고 조정 감소" }),
            h("button.btn.sm", { onclick: () => openScreen("inv.adjust") }, "재고조정")),
          h("div.panel-body", {},
            h("div.stat", {},
              h("div.lbl", { text: `누적 ${shrink.length}건` }),
              h("div.val", {}, fmt.int(Math.abs(sum(shrink, "diff"))), h("sup", { text: "EA" }))),
            h("div", { style: { marginTop: "16px" } },
              spark(shrink.slice(0, 14).reverse().map((row) => Math.abs(row.diff)),
                shrink.slice(0, 14).reverse().map((row) => row.adjusted_at)))))),

      /* ---------- 핵심 지표 · 변경 이력 ---------- */
      h("div.cols2", {},
        ref.canFinance ? h("div.panel", {},
          h("div.panel-head", {}, h("h3", { text: "핵심 지표" })),
          h("div.panel-body", {}, grid({
            rows: kpiRows,
            idKey: "metric",
            columns: [
              { key: "metric", label: "지표", cls: "strong", sortable: false },
              { key: "value", label: "현재값", align: "num", sortable: false },
              { key: "change", label: "비고", sortable: false, cell: (r) => `<span class="muted">${esc(r.change)}</span>` },
              { key: "state", label: "상태", width: 96, sortable: false, cell: (r) => statusChip(r.state, toneOf(r.state)) },
            ],
          }))) : null,

        h("div.panel", {},
          h("div.panel-head", {},
            h("h3", { text: "최근 변경 이력" }),
            h("button.btn.sm", { onclick: () => openScreen("sys.audit") }, "전체 보기")),
          h("div.panel-body", {}, grid({
            rows: logs.slice(0, 7),
            columns: [
              { key: "at", label: "일시", width: 140, cls: "code" },
              { key: "user", label: "사용자", width: 92 },
              { key: "module", label: "업무", width: 88, cell: (r) => statusChip(r.module, "mid") },
              { key: "action", label: "처리내용", cls: "ellip", width: 170 },
            ],
          })))),
    ];
  },
});

const kpi = (label, value, note, solid, bad) =>
  h(`div.kpi${solid ? ".solid" : ""}`, {},
    h("span", { text: label }),
    h("strong", { text: value, style: bad ? { color: "var(--danger)" } : undefined }),
    h("small", { text: note }));

/** 납기/마감 셀 — 지났거나 3일 이내면 강조합니다. */
function dueCell(date) {
  if (!date) return "";
  const days = Math.round((new Date(date) - new Date(today())) / 86400000);
  const tone = days < 0 ? "bad" : days <= 3 ? "warn" : "";
  const suffix = days < 0 ? `${-days}일 경과` : days === 0 ? "오늘" : `D-${days}`;
  return `${esc(date)} <span class="st ${tone}" style="min-width:auto">${suffix}</span>`;
}

/* ==========================================================================
   재고
   ========================================================================== */

const invStatus = dataScreen({
  crumb: "재고관리 > 재고현황", title: "창고별 재고현황",
  initialState: { warehouse: "", q: "", shortageOnly: "" },
  exportName: "재고현황",
  filters: (state, refresh) => [
    fld("창고", select(state, "warehouse", ref.warehouseOpts, { onChange: refresh })),
    fld("품목검색", input(state, "q", { placeholder: "품목명·코드·제조사", width: 200, onEnter: refresh })),
    fld("", h("label.field", { style: { gap: "5px" } },
      Object.assign(h("input", { type: "checkbox" }), {
        onchange(event) { state.shortageOnly = event.target.checked ? "1" : ""; refresh(); },
      }),
      h("span", { style: { fontSize: "11px" }, text: "안전재고 미달만" }))),
  ],
  load: (state) => api(`/api/inventory?${new URLSearchParams({
    warehouse: state.warehouse, q: state.q, shortageOnly: state.shortageOnly,
  })}`),
  summary: (rows) => strip([
    ["현재고", fmt.int(sum(rows, "on_hand"))],
    ["예약", fmt.int(sum(rows, "reserved"))],
    ["공사배정", fmt.int(sum(rows, "allocated"))],
    ["가용재고", fmt.int(sum(rows, "available"))],
    ["입고예정", fmt.int(sum(rows, "expected"))],
    ref.canPrices ? ["재고자산", fmt.won(rows.reduce((total, row) => total + row.on_hand * (row.price || 0), 0))] : null,
    ["미달품목", `${rows.filter((row) => row.shortage).length}`, rows.some((row) => row.shortage) ? "bad" : ""],
  ]),
  onRowClick: (row) => {
    openPanel({
      title: `${row.product_name} 수불 내역`, sub: row.warehouse_name, width: "xwide",
      content: h("div", { id: "ledgerHost" }, "불러오는 중…"),
    });
    loadLedgerInto(row);
  },
  columns: () => [
    { key: "product_id", label: "품목코드", cls: "code", width: 104 },
    { key: "product_name", label: "품목명 / 규격", cls: "strong ellip", width: 190, cell: (r) => `${esc(r.product_name)}<span class="muted"> · ${esc(r.manufacturer || "")}</span>` },
    { key: "warehouse_name", label: "창고", width: 90 },
    { key: "bin", label: "위치", width: 66, cls: "code" },
    { key: "on_hand", label: "현재고", align: "num", width: 68, sum: true },
    { key: "reserved", label: "예약", align: "num", width: 60, sum: true },
    { key: "allocated", label: "배정", align: "num", width: 60, sum: true },
    { key: "available", label: "가용", align: "num", width: 68, sum: true, cell: (r) => `<b>${fmt.int(r.available)}</b>` },
    { key: "expected", label: "예정", align: "num", width: 56, sum: true },
    { key: "safety_stock", label: "안전", align: "num", width: 56 },
    { key: "last_movement", label: "최종이동", width: 76, cls: "code" },
    { key: "_st", label: "상태", width: 92, sortable: false, cell: (r) => statusChip(r.shortage ? "부족" : "정상") },
    {
      key: "_actions", label: "업무", width: 184, sortable: false, noExport: true,
      cell: (r) => acts(
        ref.can("purchasing") && r.catalog_product_id ? act("구매", "primary") : null,
        ref.can("warehouse") ? act("이동") : null,
        ref.can("warehouse") ? act("조정") : null,
      ),
    },
  ],
  rowActions: (refresh) => ({
    구매: (row) => inventoryPurchasePanel(row, refresh),
    이동: (row) => transferDialog(refresh, row),
    조정: (row) => adjustDialog(refresh, row),
  }),
});

/** 재고 행에서 정규화 카탈로그의 판매처를 바로 비교하고 구매요청으로 넘깁니다. */
async function inventoryPurchasePanel(row, refresh) {
  const host = h("div.offer-blocked", { text: "판매처를 불러오는 중…" });
  openPanel({
    title: `${row.product_name} 구매 비교`,
    sub: `가용 ${fmt.int(row.available)} · 안전재고 ${fmt.int(row.safety_stock)} · 부족 ${fmt.int(Math.max(0, row.safety_stock - row.available))}`,
    width: "xwide", content: host,
  });

  try {
    const detail = await api(`/api/catalog/products/${encodeURIComponent(row.catalog_product_id)}`);
    if (detail.pricesHidden) {
      host.replaceChildren(h("div.offer-blocked", { text: "판매처 단가는 구매 담당 이상만 볼 수 있습니다." }));
      return;
    }
    if (!detail.offers.length) {
      host.replaceChildren(h("div.offer-blocked", {},
        h("span", { text: "등록된 공급처 단가가 없습니다." }),
        ref.can("master") ? h("button.btn.sm", { onclick: () => openScreen("base.import") }, "공급처 품목 등록") : null));
      return;
    }

    const needed = Math.max(1, row.safety_stock - row.available);
    const best = detail.offers[0];
    host.className = "";
    const offerRows = detail.offers.map((offer) => h("tr", {},
      h("td.strong", {}, offer.supplier_name, offer.id === best.id ? h("span.tag.best", {}, "최저가") : null),
      h("td", {}, h("span.tag", { text: priceBasisLabel(offer.price_basis) })),
      h("td", { text: `${offer.sell_unit}${offer.unit_qty > 1 ? ` (${offer.unit_qty}${detail.product.base_unit})` : ""}` }),
      h("td.num", { text: fmt.won(offer.price) }),
      h("td.num.strong", { text: `${fmt.int(Math.round(offer.unit_price))}원` }),
      h("td", { text: offer.lead_days === null ? "-" : offer.lead_days === 0 ? "당일" : `${offer.lead_days}일` }),
      h("td", { text: fmt.date(offer.quoted_at) }),
      h("td", {},
        safeExternalUrl(offer.product_url) ? h("a.btn.sm", { href: safeExternalUrl(offer.product_url), target: "_blank", rel: "noopener noreferrer" }, "상품보기") : null,
        h("button.btn.sm.primary", { onclick: () => requestDialog({
          id: row.product_id, name: row.product_name, unit: row.unit, quantity: needed,
          price: offer.price, supplier: offer.supplier_name, supplierId: offer.supplier_id,
          supplierProductId: offer.id, priceBasis: offer.price_basis,
          lead_time: offer.lead_days === null ? "" : `${offer.lead_days}일`,
          stock: row.on_hand, shipping: offer.shipping,
        }, refresh) }, "선택"))));
    const headings = ["공급처", "가격구분", "판매단위", "단가", `환산단가(/${detail.product.base_unit})`, "납기", "확인일", ""];
    host.replaceChildren(h("table.offer", {},
      h("thead", {}, h("tr", {}, headings.map((label, index) =>
        h(`th${[3, 4].includes(index) ? ".num" : ""}`, { text: label })))),
      h("tbody", {}, offerRows)));
  } catch (error) {
    host.replaceChildren(h("div.offer-blocked", { text: error.message }));
  }
}

async function loadLedgerInto(row) {
  const rows = await api(`/api/inventory/transactions?productId=${encodeURIComponent(row.product_id)}&warehouseId=${encodeURIComponent(row.warehouse_id)}`);
  const host = $("#ledgerHost");
  if (!host) return;
  host.replaceChildren(grid({ rows, columns: ledgerColumns(), empty: { title: "수불 내역이 없습니다" } }));
}

const TXN_LABEL = {
  PURCHASE_RECEIPT: "구매입고", RETURN_IN: "반품입고", TRANSFER_IN: "이동입고", ADJUST_IN: "조정증가",
  SALE_ISSUE: "판매출고", PROJECT_ISSUE: "공사출고", TRANSFER_OUT: "이동출고", ADJUST_OUT: "조정감소",
  RETURN_OUT: "반품출고",
};

const ledgerColumns = () => [
  { key: "at", label: "일시", width: 116, cls: "code" },
  { key: "type", label: "유형", width: 82, cell: (r) => statusChip(TXN_LABEL[r.type] || r.type, r.qty > 0 ? "mid" : "") },
  { key: "product_name", label: "품목", cls: "strong" },
  { key: "warehouse_name", label: "창고", width: 104 },
  { key: "qty", label: "증감", align: "num", width: 70, cell: (r) => `<b>${r.qty > 0 ? "+" : ""}${fmt.int(r.qty)}</b>` },
  { key: "balance_after", label: "잔량", align: "num", width: 70 },
  { key: "project_name", label: "공사", width: 150 },
  { key: "ref_id", label: "전표", width: 122, cls: "code" },
  { key: "user", label: "처리자", width: 70 },
  { key: "note", label: "비고", cls: "wrap" },
];

const invLedger = dataScreen({
  crumb: "재고관리 > 재고수불부", title: "재고 수불부",
  initialState: { from: addDays(today(), -30), to: today(), productId: "", warehouseId: "", type: "" },
  exportName: "재고수불부",
  filters: (state, refresh) => [
    dateRange(state, refresh),
    fld("품목", select(state, "productId", ref.productOpts, { width: 210, onChange: refresh })),
    fld("창고", select(state, "warehouseId", ref.warehouseOpts, { onChange: refresh })),
    fld("유형", select(state, "type", Object.entries(TXN_LABEL).map(([value, label]) => ({ value, label })), { width: 120, onChange: refresh })),
  ],
  load: (state) => api(`/api/inventory/transactions?${new URLSearchParams(state)}`),
  summary: (rows) => strip([
    ["입고 합계", fmt.int(rows.filter((r) => r.qty > 0).reduce((t, r) => t + r.qty, 0))],
    ["출고 합계", fmt.int(Math.abs(rows.filter((r) => r.qty < 0).reduce((t, r) => t + r.qty, 0)))],
    ["건수", `${rows.length}`],
  ]),
  columns: ledgerColumns,
  empty: { title: "해당 기간 수불 내역이 없습니다", hint: "기간이나 품목 조건을 바꿔 보세요." },
});

async function transferDialog(refresh, preset = {}) {
  const state = { productId: preset.product_id || "", warehouseId: preset.warehouse_id || "" };
  await openForm({
    title: "재고 이동", sub: "창고 간 이동 — 출고·입고 두 건의 수불이 기록됩니다", width: "wide",
    fields: [
      { key: "productId", label: "품목", type: "select", required: true, options: ref.productOpts, value: state.productId },
      { key: "fromWarehouse", label: "출발창고", type: "select", required: true, options: ref.warehouseOpts, value: state.warehouseId },
      { key: "toWarehouse", label: "도착창고", type: "select", required: true, options: ref.warehouseOpts },
      { key: "quantity", label: "이동수량", type: "number", required: true, min: 1, value: 1 },
      { key: "movedAt", label: "이동일자", type: "date", value: today() },
      { key: "note", label: "비고", type: "textarea", full: true },
    ],
    submitLabel: "이동 처리",
    onSubmit: (values) => api("/api/stock-transfers", { method: "POST", body: values }),
  }).then((result) => { if (result) { toast("재고 이동을 처리했습니다."); refresh(); } });
}

async function adjustDialog(refresh, preset = {}) {
  const current = preset.on_hand ?? "";
  await openForm({
    title: "재고 조정 (실사)", sub: "실물 수량을 입력하면 차이만큼 수불이 기록됩니다", width: "wide",
    extra: preset.product_name ? {
      readout: h("div.readout", {},
        h("b", { text: preset.product_name }),
        h("span", { text: `${preset.warehouse_name} · 현재고 ${fmt.int(current)}${preset.unit ? ` ${preset.unit}` : ""}` })),
    } : undefined,
    fields: [
      { key: "productId", label: "품목", type: "select", required: true, options: ref.productOpts, value: preset.product_id || "" },
      { key: "warehouseId", label: "창고", type: "select", required: true, options: ref.warehouseOpts, value: preset.warehouse_id || "" },
      { key: "beforeQty", label: "현재고", type: "static", value: current, readonly: true },
      { key: "afterQty", label: "실사수량", type: "number", required: true, min: 0, value: current },
      { key: "adjustedAt", label: "조정일자", type: "date", value: today() },
      { key: "reason", label: "조정사유", type: "textarea", required: true, full: true, placeholder: "예: 정기 실사 차이, 현장 반출 누락 등" },
    ],
    submitLabel: "조정 처리",
    onSubmit: (values) => api("/api/stock-adjustments", { method: "POST", body: values }),
  }).then((result) => { if (result) { toast("재고를 조정했습니다."); refresh(); } });
}

const invTransfer = dataScreen({
  crumb: "재고관리 > 재고이동", title: "창고 간 재고이동",
  exportName: "재고이동",
  actions: (state, refresh) => ref.can("warehouse") ? [btn("＋ 신규 이동", () => transferDialog(refresh), "primary")] : [],
  load: () => api("/api/stock-transfers"),
  summary: (rows) => strip([["이동 건수", `${rows.length}`], ["총 이동수량", fmt.int(sum(rows, "quantity"))]]),
  columns: () => [
    { key: "id", label: "이동번호", cls: "code", width: 120 },
    { key: "moved_at", label: "이동일자", width: 96, cls: "code" },
    { key: "product_name", label: "품목", cls: "strong" },
    { key: "from_name", label: "출발창고", width: 118 },
    { key: "to_name", label: "도착창고", width: 118 },
    { key: "quantity", label: "수량", align: "num", width: 72, sum: true },
    { key: "user", label: "처리자", width: 76 },
    { key: "note", label: "비고", cls: "wrap" },
  ],
  footer: true,
  empty: { title: "재고 이동 내역이 없습니다", hint: "신규 이동 버튼으로 창고 간 이동을 등록하세요." },
});

const invAdjust = dataScreen({
  crumb: "재고관리 > 재고조정", title: "재고 실사조정",
  exportName: "재고조정",
  actions: (state, refresh) => ref.can("warehouse") ? [btn("＋ 실사 조정", () => adjustDialog(refresh), "primary")] : [],
  load: () => api("/api/stock-adjustments"),
  summary: (rows) => strip([
    ["조정 건수", `${rows.length}`],
    ["증가", fmt.int(rows.filter((r) => r.diff > 0).reduce((t, r) => t + r.diff, 0))],
    ["감소", fmt.int(Math.abs(rows.filter((r) => r.diff < 0).reduce((t, r) => t + r.diff, 0))), "bad"],
  ]),
  columns: () => [
    { key: "id", label: "조정번호", cls: "code", width: 120 },
    { key: "adjusted_at", label: "조정일자", width: 96, cls: "code" },
    { key: "product_name", label: "품목", cls: "strong" },
    { key: "warehouse_name", label: "창고", width: 118 },
    { key: "before_qty", label: "전산수량", align: "num", width: 80 },
    { key: "after_qty", label: "실사수량", align: "num", width: 80 },
    { key: "diff", label: "차이", align: "num", width: 72, cell: (r) => `<b style="color:${r.diff < 0 ? "var(--danger)" : "inherit"}">${r.diff > 0 ? "+" : ""}${fmt.int(r.diff)}</b>` },
    { key: "reason", label: "조정사유", cls: "wrap" },
    { key: "user", label: "처리자", width: 76 },
  ],
  empty: { title: "재고 조정 내역이 없습니다" },
});

const invAllocation = dataScreen({
  crumb: "재고관리 > 공사별 자재배정", title: "공사별 자재배정 · 출고",
  exportName: "공사별자재배정",
  actions: (state, refresh) => ref.can("warehouse") ? [btn("＋ 자재 배정", () => allocateDialog(refresh), "primary")] : [],
  load: () => api("/api/allocations"),
  summary: (rows) => strip([
    ["배정 건수", `${rows.length}`],
    ["배정수량", fmt.int(sum(rows, "quantity"))],
    ["사용수량", fmt.int(sum(rows, "used"))],
    ["잔여", fmt.int(sum(rows, "remaining"))],
  ]),
  columns: () => [
    { key: "id", label: "배정번호", cls: "code", width: 116 },
    { key: "allocated_at", label: "배정일자", width: 94, cls: "code" },
    { key: "project_name", label: "공사", cls: "strong", width: 200 },
    { key: "product_name", label: "품목" },
    { key: "warehouse_name", label: "창고", width: 112 },
    { key: "quantity", label: "배정", align: "num", width: 64, sum: true },
    { key: "used", label: "사용", align: "num", width: 64, sum: true },
    { key: "remaining", label: "잔여", align: "num", width: 64, sum: true, cell: (r) => `<b>${fmt.int(r.remaining)}</b>` },
    { key: "status", label: "상태", width: 74, cell: (r) => statusChip(r.status) },
    {
      key: "_actions", label: "업무", width: 140, sortable: false, noExport: true,
      cell: (r) => (ref.can("warehouse") && r.remaining > 0 ? acts(act("출고", ""), act("해제", "danger")) : ""),
    },
  ],
  footer: true,
  rowActions: (refresh) => ({
    출고: (row) => openForm({
      title: "공사 자재 출고", sub: `${row.project_name} · 잔여 ${row.remaining}`,
      extra: { readout: h("div.readout", {}, h("b", { text: row.product_name }), h("span", { text: `${row.warehouse_name} · 배정 ${row.quantity} / 사용 ${row.used}` })) },
      fields: [
        { key: "quantity", label: "출고수량", type: "number", required: true, min: 1, max: row.remaining, value: row.remaining },
        { key: "note", label: "비고", type: "textarea", full: true },
      ],
      submitLabel: "출고 처리",
      onSubmit: (values) => api(`/api/allocations/${encodeURIComponent(row.id)}/issue`, { method: "POST", body: values }),
    }).then((result) => { if (result) { toast("공사 자재를 출고했습니다."); refresh(); } }),
    해제: async (row) => {
      if (!await confirmAsk({
        title: "배정 해제", danger: true, okLabel: "해제",
        message: `${row.project_name}에 배정된 ${row.product_name} 잔여 ${row.remaining}을(를) 해제하고 가용재고로 되돌립니다.`,
      })) return;
      await guard(() => api(`/api/allocations/${encodeURIComponent(row.id)}/release`, { method: "POST", body: {} }), "배정을 해제했습니다.");
      refresh();
    },
  }),
  empty: { title: "공사에 배정된 자재가 없습니다", hint: "자재 배정 버튼으로 현장에 재고를 예약하세요." },
});

async function allocateDialog(refresh, preset = {}) {
  const inventory = await api("/api/inventory");
  const state = {};
  const availableHint = () => {
    const row = inventory.find((item) => item.product_id === state.productId && item.warehouse_id === state.warehouseId);
    return row ? `가용 ${fmt.int(row.available)} (현재고 ${fmt.int(row.on_hand)})` : "해당 창고에 재고 없음";
  };
  await openForm({
    title: "공사 자재 배정", sub: "가용재고를 현장에 예약합니다 — 실물 재고는 그대로입니다", width: "wide",
    fields: [
      { key: "projectId", label: "공사", type: "select", required: true, options: ref.projectOpts, value: preset.projectId || "" },
      { key: "productId", label: "품목", type: "select", required: true, options: ref.productOpts, onChange: (s) => { state.productId = s.productId; } },
      { key: "warehouseId", label: "창고", type: "select", required: true, options: ref.warehouseOpts, onChange: (s) => { state.warehouseId = s.warehouseId; } },
      { key: "quantity", label: "배정수량", type: "number", required: true, min: 1, value: 1 },
      { key: "allocatedAt", label: "배정일자", type: "date", value: today() },
      { key: "note", label: "비고", type: "textarea", full: true },
    ],
    extra: { calc: { label: "선택한 창고의 가용재고", compute: (s) => { Object.assign(state, s); return availableHint(); } } },
    submitLabel: "배정",
    onSubmit: (values) => api("/api/allocations", { method: "POST", body: values }),
  }).then((result) => { if (result) { toast("자재를 배정했습니다."); refresh(); } });
}

/* ==========================================================================
   기준정보 (CRUD 공통)
   ========================================================================== */

/** 기준정보 CRUD 화면 생성기 — 등록/수정/삭제 모달이 자동으로 붙습니다. */
function masterScreen({ crumb, title, resource, columns, formFields, area = "master", idLabel = "코드", exportName, summary, initialState, filters, load, footer, empty }) {
  return dataScreen({
    crumb, title, exportName: exportName || title, initialState,
    filters, footer, empty,
    actions: (state, refresh) => ref.can(area)
      ? [btn("＋ 신규 등록", () => editDialog(null, refresh), "primary")]
      : [],
    load: load || (() => api(`/api/${resource}`)),
    summary,
    columns: (state, refresh) => [
      ...columns(state, refresh),
      {
        key: "_actions", label: "업무", width: 118, sortable: false, noExport: true,
        cell: () => (ref.can(area) ? acts(act("수정"), act("삭제", "danger")) : ""),
      },
    ],
    rowActions: (refresh) => ({
      수정: (row) => editDialog(row, refresh),
      삭제: async (row) => {
        if (!await confirmAsk({
          title: `${title} 삭제`, danger: true, okLabel: "삭제",
          message: `${row.name || row.id}을(를) 삭제합니다. 되돌릴 수 없습니다.`,
        })) return;
        await guard(() => api(`/api/${resource}/${encodeURIComponent(row.id)}`, { method: "DELETE" }), "삭제했습니다.");
        await ref.reload();
        refresh();
      },
    }),
  });

  function editDialog(row, refresh) {
    const fields = formFields(row);
    return openForm({
      title: row ? `${title} 수정` : `${title} 등록`,
      sub: row ? row.id : `${idLabel}는 비워두면 자동 생성됩니다`,
      width: "wide",
      fields: row ? fields : [{ key: "id", label: idLabel, placeholder: "자동 생성" }, ...fields],
      values: row ? normalizeRow(row, fields) : {},
      submitLabel: row ? "수정" : "등록",
      onSubmit: async (values) => {
        const result = row
          ? await api(`/api/${resource}/${encodeURIComponent(row.id)}`, { method: "PUT", body: values })
          : await api(`/api/${resource}`, { method: "POST", body: values });
        await ref.reload();
        return result;
      },
    }).then((result) => { if (result) { toast(row ? "수정했습니다." : "등록했습니다."); refresh(); } });
  }
}

/** DB 스네이크 컬럼을 폼 키(카멜)로 되돌립니다. */
function normalizeRow(row, fields) {
  const values = {};
  for (const field of fields) {
    const snake = field.key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
    values[field.key] = row[field.key] ?? row[snake] ?? "";
    if (field.type === "checkbox") values[field.key] = Boolean(Number(values[field.key]));
  }
  return values;
}

const baseProduct = masterScreen({
  crumb: "기준정보 > 품목", title: "품목 등록", resource: "products", idLabel: "품목코드", exportName: "품목마스터",
  summary: (rows) => strip([
    ["품목 수", `${rows.length}`],
    ["사용", `${rows.filter((r) => r.active).length}`],
    ref.canPrices ? ["평균단가", fmt.won(rows.length ? sum(rows, "price") / rows.length : 0)] : null,
  ]),
  columns: () => [
    { key: "id", label: "품목코드", cls: "code", width: 140 },
    { key: "name", label: "품목명", cls: "strong" },
    { key: "category", label: "분류", width: 80 },
    { key: "manufacturer", label: "제조사", width: 100 },
    { key: "supplier", label: "주거래처", width: 110 },
    { key: "spec", label: "규격", width: 150 },
    { key: "unit", label: "단위", width: 62, align: "num" },
    ...(ref.canPrices ? [
      { key: "price", label: "표준단가", align: "num", width: 96, cell: (r) => fmt.won(r.price) },
      { key: "unit_price", label: "환산단가", align: "num", width: 84, cell: (r) => fmt.int(r.unit_price) },
    ] : []),
    { key: "safety_stock", label: "안전재고", align: "num", width: 74 },
    { key: "lead_time", label: "납기", width: 84 },
    { key: "active", label: "사용", width: 58, cell: (r) => statusChip(r.active ? "사용" : "중지", r.active ? "" : "bad") },
  ],
  formFields: () => [
    { key: "name", label: "품목명", required: true },
    { key: "category", label: "분류", type: "select", options: ["케이블", "차단기", "전선관", "콘센트/스위치", "조명", "변압기", "기타"].map((value) => ({ value, label: value })) },
    { key: "manufacturer", label: "제조사" },
    { key: "model", label: "모델/규격" },
    { key: "supplier", label: "주거래처" },
    { key: "spec", label: "상세규격", full: true },
    { key: "unit", label: "단위", placeholder: "예: 100m, EA, 롤" },
    { key: "unitQty", label: "단위환산", type: "number", hint: "단위당 기본수량 (예: 100m → 100)" },
    { key: "price", label: "표준단가", type: "won", unit: "원" },
    { key: "unitPrice", label: "환산단가", type: "won", unit: "원", hint: "1m/1개당" },
    { key: "shipping", label: "배송비", type: "won", unit: "원" },
    { key: "leadTime", label: "납기" },
    { key: "safetyStock", label: "안전재고", type: "number" },
    { key: "barcode", label: "바코드" },
    { key: "tags", label: "검색태그", full: true, hint: "쉼표 구분 — 통합검색에 사용됩니다" },
    { key: "active", label: "사용여부", type: "checkbox", value: true },
  ],
});

/** 품목 마스터 — 정규화된 제품과 등록된 공급처 수를 봅니다. */
const baseCatalog = dataScreen({
  crumb: "기준정보 > 품목 마스터", title: "품목 마스터",
  exportName: "품목마스터",
  initialState: { category: "" },
  filters: (state, refresh) => [
    fld("분류", select(state, "category", Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ value, label })),
      { width: 180, onChange: refresh })),
  ],
  load: async (state) => {
    const rows = await api("/api/catalog/products");
    return state.category ? rows.filter((row) => row.category === state.category) : rows;
  },
  summary: (rows) => strip([
    ["제품 수", `${rows.length}`],
    ["공급처 연결", `${rows.filter((row) => row.supplier_count > 0).length}`],
    ["단가 미등록", `${rows.filter((row) => !row.supplier_count).length}`,
      rows.some((row) => !row.supplier_count) ? "bad" : ""],
    ["규격 확인 필요", `${rows.filter((row) => row.confidence < 1).length}`,
      rows.some((row) => row.confidence < 1) ? "bad" : ""],
  ]),
  columns: () => [
    { key: "name", label: "제품명", cls: "strong ellip", width: 230 },
    { key: "category", label: "분류", width: 116, cell: (r) => esc(CATEGORY_LABELS[r.category] || r.category) },
    { key: "spec_label", label: "규격", cls: "ellip", width: 190 },
    { key: "manufacturer", label: "제조사", width: 120 },
    { key: "base_unit", label: "기준단위", width: 92 },
    { key: "supplier_count", label: "공급처", align: "num", width: 88,
      cell: (r) => (r.supplier_count ? `<b>${r.supplier_count}</b>곳` : '<span class="muted">미등록</span>') },
    ...(ref.canPrices ? [{ key: "best_unit_price", label: "최저단가", align: "num", width: 116,
      cell: (r) => (r.best_unit_price === null ? "-" : `${fmt.int(Math.round(r.best_unit_price))}원`) }] : []),
    { key: "confidence", label: "규격인식", width: 108, sortable: false,
      cell: (r) => (r.confidence === 1 ? statusChip("확실", "solid") : statusChip("확인 필요", "warn")) },
    { key: "spec_key", label: "매칭키", cls: "code ellip", width: 170 },
  ],
  onRowClick: (row) => openScreen("pur.search"),
  empty: { title: "등록된 품목이 없습니다", hint: "공급처 품목 등록에서 판매 품목을 올리면 자동으로 생성됩니다." },
});

const baseSupplier = masterScreen({
  crumb: "기준정보 > 공급처", title: "공급처 등록", resource: "suppliers", idLabel: "거래처코드", exportName: "공급처",
  summary: (rows) => strip([
    ["공급처", `${rows.length}`],
    ref.canFinance ? ["미지급금 합계", fmt.won(rows.reduce((t, r) => t + (r.open_payable || 0), 0))] : null,
  ]),
  columns: () => [
    { key: "id", label: "거래처코드", cls: "code", width: 110 },
    { key: "name", label: "공급처명", cls: "strong" },
    { key: "biz_no", label: "사업자번호", width: 112, cls: "code" },
    { key: "contact", label: "담당자", width: 82 },
    { key: "phone", label: "연락처", width: 118, cls: "code" },
    { key: "email", label: "이메일", width: 140, cls: "ellip" },
    { key: "terms", label: "결제조건", width: 92 },
    { key: "lead_time", label: "납기", width: 68 },
    { key: "rating", label: "평가", align: "num", width: 62, cell: (r) => `${Number(r.rating || 0).toFixed(1)}` },
    { key: "order_count", label: "발주건수", align: "num", width: 84 },
    ...(ref.canFinance ? [{ key: "open_payable", label: "미지급금", align: "num", width: 124, sum: true, cell: (r) => fmt.won(r.open_payable), sumFormat: fmt.won }] : []),
    { key: "status", label: "상태", width: 78, cell: (r) => statusChip(r.status) },
  ],
  footer: true,
  formFields: () => [
    { key: "name", label: "공급처명", required: true },
    { key: "bizNo", label: "사업자번호" },
    { key: "contact", label: "담당자" },
    { key: "phone", label: "연락처" },
    { key: "email", label: "이메일" },
    { key: "terms", label: "결제조건", placeholder: "예: 월말 정산, 30일" },
    { key: "leadTime", label: "평균납기" },
    { key: "rating", label: "평가", type: "number", step: "0.1", min: 0, max: 5, unit: "/ 5.0" },
    { key: "status", label: "상태", type: "select", placeholder: false, options: ["정상", "검토", "거래중지"].map((value) => ({ value, label: value })) },
    { key: "note", label: "비고", type: "textarea", full: true },
  ],
});

const baseCustomer = masterScreen({
  crumb: "기준정보 > 고객", title: "고객(발주처) 등록", resource: "customers", idLabel: "고객코드", exportName: "고객",
  columns: () => [
    { key: "id", label: "고객코드", cls: "code", width: 130 },
    { key: "name", label: "고객명", cls: "strong" },
    { key: "biz_no", label: "사업자번호", width: 116, cls: "code" },
    { key: "contact", label: "담당자", width: 84 },
    { key: "phone", label: "연락처", width: 122, cls: "code" },
    { key: "email", label: "이메일", width: 180 },
    { key: "terms", label: "결제조건", width: 100 },
    { key: "status", label: "상태", width: 66, cell: (r) => statusChip(r.status) },
  ],
  formFields: () => [
    { key: "name", label: "고객명", required: true },
    { key: "bizNo", label: "사업자번호" },
    { key: "contact", label: "담당자" },
    { key: "phone", label: "연락처" },
    { key: "email", label: "이메일" },
    { key: "terms", label: "결제조건" },
    { key: "status", label: "상태", type: "select", placeholder: false, options: ["정상", "검토", "거래중지"].map((value) => ({ value, label: value })) },
    { key: "note", label: "비고", type: "textarea", full: true },
  ],
});

const baseWarehouse = masterScreen({
  crumb: "기준정보 > 창고", title: "창고 등록", resource: "warehouses", idLabel: "창고코드", exportName: "창고",
  columns: () => [
    { key: "id", label: "창고코드", cls: "code", width: 120 },
    { key: "name", label: "창고명", cls: "strong" },
    { key: "location", label: "위치", width: 200 },
    { key: "manager", label: "관리자", width: 100 },
    { key: "active", label: "사용", width: 62, cell: (r) => statusChip(r.active ? "사용" : "중지", r.active ? "" : "bad") },
  ],
  formFields: () => [
    { key: "name", label: "창고명", required: true },
    { key: "location", label: "위치" },
    { key: "manager", label: "관리자" },
    { key: "active", label: "사용여부", type: "checkbox", value: true },
  ],
});

const baseProject = masterScreen({
  crumb: "공사관리 > 공사등록", title: "공사 등록", resource: "projects", idLabel: "공사코드", exportName: "공사",
  summary: (rows) => strip([
    ["공사 수", `${rows.length}`],
    ["진행 중", `${rows.filter((r) => r.status === "진행 중").length}`],
    ref.canFinance ? ["도급액 합계", fmt.won(sum(rows, "budget"))] : null,
  ]),
  columns: () => [
    { key: "id", label: "공사코드", cls: "code", width: 122 },
    { key: "name", label: "공사명", cls: "strong" },
    { key: "customer", label: "발주처", width: 130 },
    { key: "site", label: "현장", width: 190 },
    { key: "manager", label: "담당자", width: 84 },
    { key: "start_date", label: "착공", width: 92, cls: "code" },
    { key: "end_date", label: "준공예정", width: 92, cls: "code" },
    ...(ref.canFinance ? [{ key: "budget", label: "도급액", align: "num", width: 116, sum: true, cell: (r) => fmt.won(r.budget), sumFormat: fmt.won }] : []),
    { key: "progress", label: "진행률", width: 110, cell: (r) => `<div class="bar"><i style="width:${Math.min(100, r.progress || 0)}%"></i></div>` },
    { key: "status", label: "상태", width: 78, cell: (r) => statusChip(r.status) },
  ],
  footer: true,
  formFields: () => [
    { key: "name", label: "공사명", required: true },
    { key: "customer", label: "발주처" },
    { key: "site", label: "현장주소", full: true },
    { key: "manager", label: "담당자" },
    { key: "status", label: "진행상태", type: "select", placeholder: false, options: ["진행 중", "마감 예정", "완료", "보류"].map((value) => ({ value, label: value })) },
    { key: "startDate", label: "착공일", type: "date" },
    { key: "endDate", label: "준공예정일", type: "date" },
    { key: "budget", label: "도급액", type: "won", unit: "원" },
    { key: "progress", label: "진행률", type: "number", min: 0, max: 100, unit: "%" },
    { key: "note", label: "비고", type: "textarea", full: true },
  ],
});

/* ==========================================================================
   구매
   ========================================================================== */

/* ==========================================================================
   자재 통합검색 · 업체별 가격비교
   사전조사의 핵심 화면입니다. 큰 검색창으로 들어와서, 규격이 맞는 제품을 찾고,
   그 아래에서 업체별 단가를 펼쳐 비교한 뒤 바로 구매요청으로 넘어갑니다.
   ========================================================================== */

const SORTS = [
  ["match", "규격 일치순"],
  ["price", "단가순"],
  ["lead", "납기순"],
  ["stock", "사내재고순"],
];

const ICON_SEARCH = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
  stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`;

/**
 * 지난 구매가 대비 현재가 변동.
 * 전기자재는 같은 물건을 반복해서 사기 때문에, "지난번보다 올랐는지" 가
 * 단가 자체보다 먼저 눈에 들어와야 합니다.
 */
function priceDelta(current, previous) {
  if (current === null || current === undefined || !previous) return null;
  const diff = Math.round(current - previous);
  if (!diff) return { text: "동일", tone: "same", diff: 0, rate: 0 };
  const rate = Math.round((diff / previous) * 1000) / 10;
  return {
    diff,
    rate,
    tone: diff > 0 ? "up" : "down",
    text: `${diff > 0 ? "+" : "−"}${fmt.int(Math.abs(diff))}원 · ${diff > 0 ? "+" : "−"}${Math.abs(rate)}%`,
  };
}

/** 과거 구매 이력 블록 — 현재가 / 지난 구매가 / 변동 / 구매일 / 구매처 */
function lastBuyBlock(product, lastPurchase, trend) {
  if (!lastPurchase) {
    return h("div.buy-hist.empty", {},
      h("span.muted", { text: "이 제품은 아직 구매 기록이 없습니다. 첫 구매 후부터 지난 구매가가 여기에 남습니다." }));
  }
  const current = product.best_unit_price ?? null;
  const previous = Math.round(lastPurchase.unit_price * 100) / 100;
  const delta = priceDelta(current, previous);
  const cell = (label, value, cls = "") => h(`div.bh-cell${cls}`, {},
    h("span", { text: label }), h("b", { text: value }));

  return h("div.buy-hist", {},
    h("div.bh-figs", {},
      cell("현재가격", current === null ? "미등록" : `${fmt.int(Math.round(current))}원`),
      cell("지난 구매가격", `${fmt.int(Math.round(previous))}원`),
      delta
        ? h(`div.bh-cell.bh-${delta.tone}`, {},
          h("span", { text: "가격변동" }), h("b", { text: delta.text }))
        : null,
      cell("마지막 구매", fmt.date(lastPurchase.at)),
      cell("구매처", lastPurchase.supplier_name || "-")),
    trend && trend.length > 1
      ? h("div.bh-trend", {},
        h("div.bh-trend-head", {},
          h("b", { text: `가격 추이 ${trend.length}건` }),
          h("span.muted", { text: `환산단가 기준 · 원/${product.base_unit}` })),
        spark(trend.map((row) => Math.round(row.unit_price)), trend.map((row) => row.at)))
      : null);
}

/* ---------- 견적함 · 업체별 견적 비교 ---------------------------------------
   자재는 한 번에 여러 품목을 삽니다. 품목마다 최저가를 찾아 봐야 "어디에
   주문할 것인가" 에는 답이 안 나옵니다 — 배송비는 주문마다 붙고, 한 업체가
   세 품목 중 둘만 팔면 나머지는 따로 시켜야 하기 때문입니다.
   그래서 "한 곳에 몰아주면 얼마" 와 "쪼개 사면 얼마" 를 나란히 놓습니다. */

/** 어느 화면에서든 제품을 견적함에 담습니다. 담을 곳이 없으면 그 자리에서 만듭니다. */
async function addToQuote(product, quantity) {
  const carts = (await api("/api/quotes")).filter((cart) => cart.status === "작성중");
  const pick = carts[0] || await api("/api/quotes", { method: "POST", body: { title: `견적 ${today()}` } });
  await api(`/api/quotes/${encodeURIComponent(pick.id)}/items`, {
    method: "POST",
    body: { productId: product.id, quantity: quantity || 1 },
  });
  return pick;
}

const cartStatusTone = (status) => ({ 작성중: "warn", 발주완료: "solid", 보관: "mid" }[status] || "mid");
const leadText = (days) => (days === null || days === undefined ? "-" : days === 0 ? "당일" : `${days}일`);

function quoteScreen() {
  const state = { cartId: null, carts: [], items: [], compare: null, expanded: new Set() };
  const side = h("div.quote-side");
  const main = h("div.quote-main");

  async function refresh() {
    state.carts = await api("/api/quotes");
    if (!state.carts.some((cart) => cart.id === state.cartId)) {
      state.cartId = state.carts.find((cart) => cart.status === "작성중")?.id || state.carts[0]?.id || null;
    }
    if (state.cartId) {
      const [detail, compare] = await Promise.all([
        api(`/api/quotes/${encodeURIComponent(state.cartId)}`),
        api(`/api/quotes/${encodeURIComponent(state.cartId)}/compare`),
      ]);
      state.items = detail.items;
      state.compare = compare;
    } else {
      state.items = [];
      state.compare = null;
    }
    draw();
  }

  async function newCart() {
    const result = await openForm({
      title: "견적함 만들기",
      fields: [
        { key: "title", label: "이름", required: true, value: `견적 ${today()}`, placeholder: "예: 3층 배관 자재" },
        { key: "note", label: "메모", type: "textarea", full: true },
      ],
      submitLabel: "만들기",
      onSubmit: (values) => api("/api/quotes", { method: "POST", body: values }),
    });
    if (result) { state.cartId = result.id; toast("견적함을 만들었습니다."); refresh(); }
  }

  /* ---- 왼쪽: 견적함 목록 ---- */
  function drawSide() {
    side.replaceChildren(...[
      h("div.hd", {},
        h("span", { text: `견적함 ${state.carts.length}` }),
        ref.can("purchasing") ? h("button.btn.sm.primary", { onclick: newCart }, "＋ 새로") : null),
      ...(state.carts.length
        ? state.carts.map((cart) => h(`button.prj-btn${state.cartId === cart.id ? ".on" : ""}`, {
          onclick: () => { state.cartId = cart.id; refresh(); },
        },
          h("b", { text: cart.title }),
          h("span", { text: `${cart.item_count}품목 · ${cart.owner || "-"}` }),
          h("small", { html: statusChip(cart.status, cartStatusTone(cart.status)) })))
        : [h("p.muted", { style: { padding: "14px" }, text: "견적함이 없습니다. 통합검색에서 자재를 담아 보세요." })]),
    ].filter(Boolean));
  }

  /* ---- 담긴 품목 ---- */
  function itemTable() {
    const editable = state.compare?.cart.status === "작성중" && ref.can("purchasing");
    return h("div.panel", {},
      h("div.panel-head", {},
        h("h3", { text: `담긴 자재 ${state.items.length}품목` }),
        h("div.grow"),
        h("button.btn.sm", { onclick: () => openScreen("pur.search") }, "자재 더 담기")),
      h("div.panel-body", {},
        state.items.length
          ? h("table.qt-items", {},
            h("thead", {}, h("tr", {},
              ...["자재", "규격", "공사", "필요 수량", "사내 가용", "판매처", ""].map((label, index) =>
                h(`th${[3, 4].includes(index) ? ".num" : ""}`, { text: label })))),
            h("tbody", {}, state.items.map((item) => h("tr", {},
              h("td.strong", {}, item.product_name,
                item.certification ? h("span.tag", { text: item.certification }) : null),
              h("td.muted", { text: item.spec_label || "-" }),
              h("td", { text: item.project_name || "-" }),
              h("td.num", {}, editable
                ? qtyField(item)
                : h("b", { text: `${fmt.int(item.quantity)}${item.base_unit}` })),
              h("td.num", {}, h(`span${item.available < item.quantity ? ".short" : ""}`, {
                text: `${fmt.int(item.available)}${item.base_unit}`,
              })),
              h("td", { text: item.supplier_count ? `${item.supplier_count}곳` : "단가 없음" }),
              h("td.num", {}, editable
                ? h("button.btn.sm.danger", {
                  onclick: async () => {
                    await guard(() => api(`/api/quotes/${encodeURIComponent(state.cartId)}/items/${encodeURIComponent(item.id)}`,
                      { method: "DELETE" }), "품목을 뺐습니다.");
                    refresh();
                  },
                }, "빼기")
                : null)))))
          : h("p.muted", { text: "담긴 자재가 없습니다. 통합검색에서 제품을 골라 견적함에 담으면 업체별 견적이 여기에 나옵니다." })));
  }

  /** 수량은 자주 고치므로 표 안에서 바로 바꿉니다. */
  function qtyField(item) {
    const input = h("input.qt-qty", { type: "number", min: "0.1", step: "any", value: String(item.quantity) });
    input.addEventListener("change", async () => {
      const next = Number(input.value);
      if (!Number.isFinite(next) || next <= 0) { input.value = String(item.quantity); return; }
      await guard(() => api(`/api/quotes/${encodeURIComponent(state.cartId)}/items/${encodeURIComponent(item.id)}`,
        { method: "PUT", body: { quantity: next } }), "수량을 바꿨습니다.");
      refresh();
    });
    return h("span.qt-qty-wrap", {}, input, h("small", { text: item.base_unit }));
  }

  /* ---- 두 갈래 요약: 한 곳에 몰아주기 vs 쪼개 사기 ---- */
  function strategyCards() {
    const { cheapestFull, bestSplit, splitSaving } = state.compare;
    if (!cheapestFull && !bestSplit) return null;

    const card = (title, note, total, lines, badge) => h("div.qt-strategy", {},
      h("div.qt-strategy-head", {}, h("b", { text: title }), badge),
      h("div.qt-strategy-total", { text: fmt.won(total) }),
      h("div.qt-strategy-note", { text: note }),
      h("div.qt-strategy-lines", {}, lines.map((line) => h("span", { text: line }))));

    const cheaper = splitSaving === null ? null : splitSaving > 0 ? "split" : splitSaving < 0 ? "full" : null;

    return h("div.qt-strategies", {}, ...[
      cheapestFull
        ? card("한 곳에 몰아주기", `${cheapestFull.supplier_name} · 납기 ${leadText(cheapestFull.lead_days)}`,
          cheapestFull.total,
          [`공급가 ${fmt.won(cheapestFull.supply)}`, `배송비 ${fmt.won(cheapestFull.shipping)}`, `부가세 ${fmt.won(cheapestFull.vat)}`],
          cheaper === "full" ? h("span.tag.best", {}, "더 쌈") : null)
        : h("div.qt-strategy.dim", {},
          h("div.qt-strategy-head", {}, h("b", {}, "한 곳에 몰아주기")),
          h("p.muted", { text: "담긴 자재를 전부 파는 업체가 없습니다. 쪼개 사야 합니다." })),
      bestSplit
        ? card("품목별 최적으로 쪼개기", `${bestSplit.supplier_count}곳에 주문 · 납기 ${leadText(bestSplit.lead_days)}`,
          bestSplit.total,
          [`공급가 ${fmt.won(bestSplit.supply)}`, `배송비 ${fmt.won(bestSplit.shipping)}`, `부가세 ${fmt.won(bestSplit.vat)}`],
          cheaper === "split" ? h("span.tag.best", {}, "더 쌈") : null)
        : null,
      splitSaving
        ? h("div.qt-saving", {},
          h("span", { text: splitSaving > 0 ? "쪼개 사면" : "한 곳에 몰아주면" }),
          h("b", { text: fmt.won(Math.abs(splitSaving)) }),
          h("span", { text: "아낍니다" }),
          h("small", {
            text: splitSaving > 0
              ? "대신 주문이 여러 건으로 늘고, 납기는 가장 늦은 쪽을 따릅니다"
              : "배송비를 한 번만 내기 때문입니다",
          }))
        : null,
    ].filter(Boolean));
  }

  /* ---- 업체별 견적 표 ---- */
  function supplierTable() {
    const { suppliers, items } = state.compare;
    if (!suppliers.length) return null;
    const fullOnes = suppliers.filter((row) => row.full);
    const cheapest = fullOnes.length ? Math.min(...fullOnes.map((row) => row.total)) : null;

    return h("div.panel", {},
      h("div.panel-head", {}, h("h3", { text: `업체별 견적 ${suppliers.length}곳` }),
        h("span.muted", { text: "행을 누르면 품목별 단가가 펼쳐집니다" })),
      h("div.panel-body.flush", {}, suppliers.map((supplier) => {
        const open = state.expanded.has(supplier.supplier_id);
        return h("div.qt-sup", {}, ...[
          h("button.qt-sup-row", {
            onclick: () => {
              if (open) state.expanded.delete(supplier.supplier_id);
              else state.expanded.add(supplier.supplier_id);
              draw();
            },
          },
            h("div.qt-sup-name", {},
              h("b", { text: supplier.supplier_name }),
              supplier.full && supplier.total === cheapest ? h("span.tag.best", {}, "최저가") : null,
              supplier.full
                ? h("span.tag", { text: `전 품목 ${items.length}` })
                : h("span.tag.warn", { text: `${supplier.covers}/${items.length}품목` })),
            h("div.qt-sup-figs", {},
              fig("공급가", fmt.won(supplier.supply)),
              fig("배송비", fmt.won(supplier.shipping)),
              fig("부가세", fmt.won(supplier.vat)),
              fig("총액", fmt.won(supplier.total), true),
              fig("납기", leadText(supplier.lead_days))),
            h("span.qt-caret", { text: open ? "▴" : "▾" })),
          open ? supplierLines(supplier) : null,
        ].filter(Boolean));
      })));
  }

  const fig = (label, value, strong) => h("div.qt-fig", {},
    h("span", { text: label }), h(`b${strong ? ".strong" : ""}`, { text: value }));

  function supplierLines(supplier) {
    return h("div.qt-sup-detail", {}, ...[
      h("table.qt-lines", {},
        h("thead", {}, h("tr", {},
          ...["자재", "필요", "판매단위", "구매 수량", "단가", "공급가", "납기"].map((label, index) =>
            h(`th${[1, 3, 4, 5].includes(index) ? ".num" : ""}`, { text: label })))),
        h("tbody", {}, supplier.lines.map((line) => h("tr", {},
          h("td", { text: line.product_name }),
          h("td.num", { text: `${fmt.int(line.quantity)}${line.base_unit}` }),
          h("td", { text: line.sell_unit }),
          h("td.num", {}, `${fmt.int(line.buy_quantity)}${line.base_unit}`,
            line.over > 0 ? h("small.over", { text: `+${fmt.int(line.over)} 더 삼` }) : null),
          h("td.num", { text: fmt.won(line.price) }),
          h("td.num.strong", { text: fmt.won(line.supply) }),
          h("td", { text: leadText(line.lead_days) }))))),
      supplier.missing.length
        ? h("div.qt-missing", {},
          h("b", {}, "이 업체에 없는 자재"),
          h("span", { text: supplier.missing.map((row) => row.product_name).join(", ") }))
        : null,
      ref.can("purchasing") && state.compare.cart.status === "작성중"
        ? h("div.qt-sup-actions", {},
          h("button.btn.primary.sm", {
            onclick: () => requestFromSupplier(supplier),
          }, `${supplier.supplier_name}에 ${supplier.lines.length}품목 구매요청`))
        : null,
    ].filter(Boolean));
  }

  /** 고른 업체 조합을 기존 구매요청 → 승인 → 발주 흐름으로 넘깁니다. */
  async function requestFromSupplier(supplier) {
    const result = await openForm({
      title: "견적 → 구매요청",
      sub: `${supplier.supplier_name} · ${supplier.lines.length}품목 · ${fmt.won(supplier.total)}`,
      fields: [
        { key: "projectId", label: "사용 공사", type: "select", required: true, options: ref.projectOpts },
        { key: "requestedDate", label: "희망납기", type: "date", value: addDays(today(), 7) },
        {
          key: "purpose", label: "사용 목적", type: "textarea", required: true, full: true,
          value: `${state.compare.cart.title} 일괄 구매`,
        },
      ],
      submitLabel: `${supplier.lines.length}건 구매요청`,
      footNote: supplier.missing.length
        ? `이 업체가 팔지 않는 ${supplier.missing.length}품목은 요청에 들어가지 않습니다.`
        : "품목마다 구매요청이 만들어지고, 승인하면 발주서로 넘어갑니다.",
      onSubmit: (values) => api(`/api/quotes/${encodeURIComponent(state.cartId)}/request`, {
        method: "POST",
        body: {
          ...values,
          lines: supplier.lines.map((line) => ({
            productId: line.product_id, supplierProductId: line.offer_id, projectId: values.projectId,
          })),
        },
      }),
    });
    if (result) {
      toast(`구매요청 ${result.requests.length}건을 만들었습니다.`);
      refresh();
    }
  }

  function draw() {
    drawSide();
    if (!state.compare) {
      main.replaceChildren(h("div.grid-empty", {},
        h("b", { text: "견적함이 없습니다" }),
        h("span", { text: "자재 통합검색에서 제품을 골라 담으면 업체별 견적을 비교할 수 있습니다." }),
        h("div", { style: { marginTop: "16px", display: "flex", gap: "8px" } },
          h("button.btn.primary", { onclick: () => openScreen("pur.search") }, "자재 통합검색"),
          ref.can("purchasing") ? h("button.btn", { onclick: newCart }, "빈 견적함 만들기") : null)));
      return;
    }
    main.replaceChildren(...[
      state.compare.unpriced.length
        ? h("div.cmp-warn", {
          text: `단가가 등록되지 않은 자재가 ${state.compare.unpriced.length}개 있습니다: ${state.compare.unpriced.map((row) => row.product_name).join(", ")}`,
        })
        : null,
      itemTable(),
      state.items.length ? strategyCards() : null,
      state.items.length ? supplierTable() : null,
    ].filter(Boolean));
  }

  const el = h("div.screen", {},
    h("div.screen-head", {},
      h("div", {}, h("div.crumb", { text: "구매관리 > 견적 비교" }), h("h1", { text: "견적 비교" })),
      h("div.head-actions", {}, ...[
        ref.can("purchasing") ? h("button.btn", { onclick: newCart }, "＋ 견적함") : null,
        h("button.btn", { onclick: () => refresh() }, "새로고침"),
      ].filter(Boolean))),
    h("div"),
    h("div.screen-body", {}, h("div.quote-layout", {}, side, h("div.quote-scroll", {}, main))));

  return { el, refresh };
}

/* ---------- 제품 비교 -------------------------------------------------------
   여러 제품을 나란히 놓고 고릅니다. 값이 갈리는 행만 눈에 띄게 하고,
   규격 → 가격 → 납기 → 과거구매 → 품질 순서로 봅니다. 전기자재는
   가격이 아무리 좋아도 규격이 어긋나면 살 수 없기 때문입니다. */

const COMPARE_MAX = 6;

/** 비교표 한 칸. 서버가 내려준 format 대로만 그립니다. */
function compareCell(row, item, value, best) {
  if (value === null || value === undefined || value === "") return h("span.muted", { text: "-" });
  switch (row.format) {
    case "won":
      return h("span", {},
        h(`b${row.strong && best.total ? ".pick" : ""}`, { text: fmt.won(Math.round(value)) }),
        row.suffix === "/기본단위" ? h("small", { text: `/${item.base_unit}` }) : null);
    case "int":
      return h("span", {}, h("b", { text: fmt.int(value) }), row.suffix ? h("small", { text: row.suffix }) : null);
    case "lead":
      return h("span", {}, h(`b${best.lead ? ".pick" : ""}`, {
        text: value === 0 ? "당일" : `${fmt.int(value)}일`,
      }));
    case "bool":
      return value
        ? h("span.tag.best", {}, "구매한 적 있음")
        : h("span.muted", { text: "처음 구매" });
    case "date": return h("span", { text: fmt.date(value) });
    case "category": return h("span", { text: CATEGORY_LABELS[value] || value });
    case "basis": return h("span.tag", { text: priceBasisLabel(value) });
    case "rating": return h("span", { text: `${value}` });
    case "delta": {
      const delta = priceDelta(item.unit_price, item.last_buy_unit_price);
      return delta ? h(`span.bh-tag.bh-${delta.tone}`, { text: delta.text }) : h("span.muted", { text: "-" });
    }
    case "spec":
      return h("b", { text: `${value}${row.unit || ""}` });
    default:
      return h("span", { text: String(value) });
  }
}

/**
 * 비교 서랍.
 * ids 는 검색 화면에서 체크한 제품들. 수량을 바꾸면 총 구매금액이 다시 계산됩니다.
 */
function compareDrawer(ids, onRequest) {
  const state = { qty: 1, data: null, busy: false };
  const body = h("div.cmp-host", { text: "불러오는 중…" });

  const qtyInput = h("input.cmp-qty", { type: "number", min: "1", value: "1" });
  qtyInput.addEventListener("change", () => {
    const next = Math.max(1, Number(qtyInput.value) || 1);
    state.qty = next;
    qtyInput.value = String(next);
    load();
  });

  async function load() {
    if (state.busy) return;
    state.busy = true;
    try {
      state.data = await api(`/api/catalog/compare?${new URLSearchParams({ ids: ids.join(","), qty: state.qty })}`);
      draw();
    } catch (error) {
      body.replaceChildren(h("div.offer-blocked", { text: error.message }));
    } finally {
      state.busy = false;
    }
  }

  function draw() {
    const { items, groups, cheapestTotal, fastestLead, mixedCategory } = state.data;

    const head = h("tr", {},
      h("th.cmp-corner", {}, h("span", { text: "비교 항목" })),
      ...items.map((item) => h("th", {},
        h("div.cmp-name", {},
          h("b", { text: item.name }),
          item.confidence < 1 ? h("span.tag.warn", {}, "규격 확인 필요") : null),
        h("div.cmp-sub", {},
          h("span", { text: CATEGORY_LABELS[item.category] || item.category }),
          item.manufacturer ? h("span", { text: item.manufacturer }) : null,
          h("span", { text: `공급처 ${item.supplier_count}곳` })),
        h("div.cmp-badges", {},
          item.total !== null && item.total === cheapestTotal ? h("span.tag.best", {}, "최저 총액") : null,
          item.lead_days !== null && item.lead_days === fastestLead ? h("span.tag", {}, "최단 납기") : null),
        ref.can("purchasing") && item.best_offer_id
          ? h("button.btn.sm.primary", {
            onclick: () => {
              closeModal();
              onRequest(item);
            },
          }, "구매요청")
          : null)));

    const rows = [];
    for (const group of groups) {
      rows.push(h("tr.cmp-group", {},
        h("th", { colSpan: items.length + 1 }, h("b", { text: group.label }),
          group.note ? h("span.muted", { text: group.note }) : null)));
      for (const row of group.rows) {
        rows.push(h(`tr${row.differs ? ".diff" : ""}`, {},
          h("th", {}, row.label, row.differs ? h("i.diff-dot", { title: "제품마다 값이 다릅니다" }) : null),
          ...items.map((item, index) => h("td", {},
            compareCell(row, item, row.values[index], {
              total: row.key === "total" && item.total !== null && item.total === cheapestTotal,
              lead: row.key === "lead_days" && item.lead_days !== null && item.lead_days === fastestLead,
            })))));
      }
    }

    // replaceChildren 는 h() 와 달리 null 을 걸러 주지 않아 "null" 이 그대로 찍힙니다.
    body.replaceChildren(...[
      mixedCategory
        ? h("div.cmp-warn", { text: "종류가 서로 다른 제품을 비교하고 있습니다. 규격 항목은 공통된 것만 보여 줍니다." })
        : null,
      h("div.cmp-scroll", {}, h("table.cmp", {}, h("thead", {}, head), h("tbody", {}, ...rows))),
    ].filter(Boolean));
  }

  openPanel({
    title: `제품 비교 ${ids.length}건`,
    sub: "규격이 맞는지 먼저 보고, 그 다음 가격과 납기를 봅니다",
    width: "xwide",
    content: h("div", {},
      h("div.cmp-bar", {},
        h("label", {}, h("span", { text: "구매 예정 수량" }), qtyInput),
        h("span.muted", { text: "기본단위 기준 · 판매단위 묶음과 최소수량을 반영해 총액을 냅니다" })),
      body),
  });
  load();
}

/** 규격을 칩으로 보여 줍니다. 검색어가 어떻게 해석됐는지 드러내기 위한 것입니다. */
const specChips = (categories, category, specs) => {
  const definition = categories?.[category];
  if (!definition) return null;
  const chips = definition.fields
    .filter((field) => specs?.[field.key] !== undefined && specs?.[field.key] !== null)
    .map((field) => `${specs[field.key]}${field.unit || ""}`);
  return h("div.parsed", {},
    h("span.parsed-label", { text: definition.label }),
    ...chips.map((chip) => h("span.parsed-chip", { text: chip })));
};

function catalogSearch() {
  const state = { q: "", sort: "match", category: "", inStock: false, open: new Set(), picked: new Map(), categories: null };
  let result = { products: [], total: 0, parsed: {} };

  const searchInput = h("input", {
    type: "search", placeholder: "예: CV 2.5 4C · MCCB 30A 2P · KIV 1.5 흑색 · 케이블마트",
    autocomplete: "off", spellcheck: "false",
  });
  const hint = h("div.search-hint");
  const body = h("div.screen-body");
  const countLine = h("div.result-line");

  const run = async () => {
    state.q = searchInput.value;
    result = await api(`/api/catalog/search?${new URLSearchParams({
      q: state.q, sort: state.sort, category: state.category, inStock: state.inStock ? "1" : "",
    })}`);
    state.categories = result.categories;
    draw();
  };

  searchInput.addEventListener("keydown", (event) => { if (event.key === "Enter") run(); });

  /** 업체별 비교 표 — 제품 행을 펼치면 나옵니다. */
  function offerTable(product, detail) {
    if (detail.pricesHidden) {
      return h("div.offer-blocked", { text: "단가는 구매 담당 이상만 볼 수 있습니다." });
    }
    if (!detail.offers.length) {
      return h("div.offer-blocked", {},
        h("span", { text: "등록된 공급처 단가가 없습니다. " }),
        ref.can("master") ? h("button.btn.sm", { onclick: () => openScreen("base.import") }, "공급처 품목 등록") : null);
    }
    const best = detail.offers[0];
    const fastest = [...detail.offers].sort((a, b) => (a.lead_days ?? 999) - (b.lead_days ?? 999))[0];

    return h("div", {},
      h("table.offer", {},
        h("thead", {}, h("tr", {},
          ["공급처", "가격구분", "판매단위", "단가", `환산단가(/${product.base_unit})`, "납기", "최소수량", "확인일", ""]
            .map((label, index) => h(`th${[3, 4, 6].includes(index) ? ".num" : ""}`, { text: label })))),
        h("tbody", {}, detail.offers.map((offer) => h("tr", {},
          h("td.strong", {}, offer.supplier_name,
            offer.id === best.id ? h("span.tag.best", {}, "최저가") : null,
            offer.id === fastest.id && fastest.lead_days !== null ? h("span.tag", {}, "최단납기") : null),
          h("td", {}, h("span.tag", { text: priceBasisLabel(offer.price_basis) })),
          h("td", { text: `${offer.sell_unit}${offer.unit_qty > 1 ? ` (${offer.unit_qty}${product.base_unit})` : ""}` }),
          h("td.num", { text: fmt.won(offer.price) }),
          h("td.num.strong", { text: `${fmt.int(Math.round(offer.unit_price))}원` }),
          h("td", { text: offer.lead_days === null ? "-" : offer.lead_days === 0 ? "당일" : `${offer.lead_days}일` }),
          h("td.num", { text: fmt.int(offer.moq) }),
          h("td", { text: fmt.date(offer.quoted_at) }),
          h("td", {}, safeExternalUrl(offer.product_url) ? h("a.btn.sm", { href: safeExternalUrl(offer.product_url), target: "_blank", rel: "noopener noreferrer" }, "상품보기") : null,
            ref.can("purchasing") ? h("button.btn.sm.primary", {
              onclick: () => requestDialog({
                id: product.id, name: product.name, unit: offer.sell_unit,
                price: offer.price, supplier: offer.supplier_name, supplierId: offer.supplier_id,
                supplierProductId: offer.id, priceBasis: offer.price_basis,
                lead_time: offer.lead_days === null ? "" : `${offer.lead_days}일`,
                stock: product.on_hand, shipping: offer.shipping,
              }, run),
            }, "구매요청")
            : null))))),
      lastBuyBlock(product, detail.lastPurchase, detail.trend));
  }

  async function toggle(product, host) {
    if (state.open.has(product.id)) {
      state.open.delete(product.id);
      host.replaceChildren();
      return;
    }
    state.open.add(product.id);
    host.replaceChildren(h("div.offer-blocked", { text: "불러오는 중…" }));
    try {
      const detail = await api(`/api/catalog/products/${encodeURIComponent(product.id)}`);
      host.replaceChildren(offerTable(product, detail));
    } catch (error) {
      host.replaceChildren(h("div.offer-blocked", { text: error.message }));
    }
  }

  const pickBar = h("div.pick-bar");

  /** 고른 제품이 있을 때만 뜨는 막대. 비교로 넘어가는 유일한 길입니다. */
  function drawPickBar() {
    const picked = [...state.picked.values()];
    pickBar.classList.toggle("on", picked.length > 0);
    if (!picked.length) return pickBar.replaceChildren();
    pickBar.replaceChildren(...[
      h("div.pick-names", {},
        h("b", { text: `${picked.length}개 선택` }),
        h("span.muted", { text: picked.map((row) => row.name).join(" · ") })),
      h("div.grow"),
      h("button.btn.sm", {
        onclick: () => { state.picked.clear(); draw(); },
      }, "선택 해제"),
      ref.can("purchasing")
        ? h("button.btn.sm", {
          onclick: async () => {
            // 수량은 견적 비교 화면에서 바로 고치므로, 담을 때는 1 로 넣고 넘어갑니다.
            await guard(async () => {
              for (const product of picked) await addToQuote(product, 1);
            }, `${picked.length}개를 견적함에 담았습니다.`);
            state.picked.clear();
            draw();
            openScreen("pur.quote");
          },
        }, "견적함에 담기")
        : null,
      h("button.btn.sm.primary", {
        disabled: picked.length < 2,
        title: picked.length < 2 ? "2개 이상 골라 주세요" : "",
        onclick: () => compareDrawer(picked.map((row) => row.id), (item) => requestDialog({
          id: item.id, name: item.name, unit: item.sell_unit || item.base_unit,
          price: item.price, supplier: item.best_supplier, supplierId: item.best_supplier_id,
          supplierProductId: item.best_offer_id, manufacturer: item.manufacturer,
          lead_time: item.lead_days === null ? "" : `${item.lead_days}일`,
          stock: item.stock_on_hand, shipping: item.shipping || 0,
        }, run)),
      }, `${picked.length}개 비교하기`),
    ].filter(Boolean));
  }

  function draw() {
    hint.replaceChildren(
      ...(result.parsed?.recognized
        ? [specChips(state.categories, result.parsed.category, result.parsed.specs)]
        : state.q ? [h("span.muted", { text: "규격을 읽지 못해 이름으로 찾았습니다." })] : []).filter(Boolean));

    countLine.replaceChildren(
      h("b", { text: `${result.total}건` }),
      h("span.muted", { text: state.q ? ` · "${state.q}"` : " · 전체 품목" }));

    if (!result.products.length) {
      body.replaceChildren(h("div.grid-empty", {},
        h("b", { text: state.q ? "조건에 맞는 자재가 없습니다" : "등록된 품목이 없습니다" }),
        h("span", { text: "공급처를 등록하고 판매 품목을 올리면 여기에서 바로 비교됩니다." }),
        ref.can("master")
          ? h("div", { style: { marginTop: "16px" } },
            h("button.btn.primary", { onclick: () => openScreen("base.import") }, "공급처 품목 등록"))
          : null));
      drawPickBar();
      return;
    }

    body.replaceChildren(...result.products.map((product) => {
      const host = h("div.offer-host");
      const row = h("div.hit", {},
        h("button.hit-main", { onclick: () => toggle(product, host) },
          h("div.hit-name", {},
            h("b", { text: product.name }),
            product.match < 100 ? h("span.tag.warn", { text: `${product.match}% 일치` }) : null,
            product.confidence < 1 ? h("span.tag.warn", {}, "규격 확인 필요") : null),
          h("div.hit-meta", {},
            h("span", { text: state.categories?.[product.category]?.label || product.category }),
            product.manufacturer ? h("span", { text: product.manufacturer }) : null,
            h("span", { text: `공급처 ${product.supplier_count}곳` }))),
        h("div.hit-figs", {},
          h("div.fig", {},
            h("span", {}, "최저 단가"),
            h("b", { text: product.best_unit_price === undefined ? "—" : product.best_unit_price === null ? "미등록" : `${fmt.int(Math.round(product.best_unit_price))}원` }),
            h("small", { text: `/${product.base_unit}` })),
          h("div.fig", {},
            h("span", {}, "최단 납기"),
            h("b", { text: product.best_lead === null ? "-" : product.best_lead === 0 ? "당일" : `${product.best_lead}일` })),
          (() => {
            // 지난 구매가는 펼치지 않고도 보여야 합니다 — 반복 구매가 잦기 때문입니다.
            const delta = priceDelta(product.best_unit_price ?? null, product.last_buy_unit_price);
            return h("div.fig", {},
              h("span", {}, "지난 구매"),
              h(`b${product.last_buy_unit_price ? "" : ".dim"}`, {
                text: product.last_buy_unit_price ? `${fmt.int(Math.round(product.last_buy_unit_price))}원` : "없음",
              }),
              delta
                ? h(`small.bh-tag.bh-${delta.tone}`, { text: delta.text, title: `${fmt.date(product.last_buy_at)} · ${product.last_buy_supplier || "-"}` })
                : h("small", { text: product.last_buy_at ? fmt.date(product.last_buy_at) : " " }));
          })(),
          h("div.fig", {},
            h("span", {}, "사내 재고"),
            h(`b${product.available <= 0 ? ".dim" : ""}`, { text: fmt.int(product.on_hand) }),
            h("small", { text: product.base_unit }))),
        h("button.hit-toggle", { onclick: () => toggle(product, host), title: "업체별 단가 비교" }, "▾"));

      // 비교 체크 — 여러 제품을 골라 나란히 놓기 위한 것입니다.
      const box = Object.assign(h("input", { type: "checkbox", title: "비교에 담기" }), {
        checked: state.picked.has(product.id),
        onchange(event) {
          if (event.target.checked) {
            if (state.picked.size >= COMPARE_MAX) {
              event.target.checked = false;
              toast(`비교는 ${COMPARE_MAX}개까지 담을 수 있습니다.`, "err");
              return;
            }
            state.picked.set(product.id, product);
          } else {
            state.picked.delete(product.id);
          }
          wrap.classList.toggle("on", event.target.checked);
          drawPickBar();
        },
      });
      row.prepend(h("label.hit-pick", {}, box));
      const wrap = h(`div.hit-wrap${state.picked.has(product.id) ? ".on" : ""}`, {}, row, host);
      return wrap;
    }));
    drawPickBar();
  }

  const chip = (label, active, onclick) =>
    h(`button.chip${active ? ".on" : ""}`, { onclick }, label);

  const el = h("div.screen.scroll", {},
    h("div.screen-head", {},
      h("div", {}, h("div.crumb", { text: "구매관리 > 자재 통합검색" }), h("h1", { text: "자재 통합검색" })),
      h("div.head-actions", {},
        ref.can("master") ? h("button.btn", { onclick: () => openScreen("base.import") }, "공급처 품목 등록") : null,
        h("button.btn", { onclick: () => openScreen("base.catalog") }, "품목 마스터"))),
    h("div", {},
      h("div.searchbar", {},
        h("i", { html: ICON_SEARCH }),
        searchInput,
        h("button.btn.primary", { onclick: run }, "검색")),
      hint,
      h("div.search-filters", {},
        h("div.chipset", {}, SORTS.map(([key, label]) =>
          chip(label, state.sort === key, () => { state.sort = key; run(); }))),
        h("div.grow"),
        h("label.inline-check", {},
          Object.assign(h("input", { type: "checkbox" }), {
            onchange: (event) => { state.inStock = event.target.checked; run(); },
          }),
          h("span", {}, "사내 재고 있는 것만")),
        countLine)),
    body,
    pickBar);

  return {
    el,
    refresh: async () => {
      if (!state.categories) state.categories = await api("/api/catalog/categories");
      await run();
      setTimeout(() => searchInput.focus(), 40);
    },
  };
}

/* ---------- 공급처 품목 등록 (CSV) ---------------------------------------- */

function catalogImport() {
  const state = {
    supplierId: "", filename: "", csv: "", preview: null, apiQuery: "전선",
    sources: null, busy: null, catalogOnly: false,
    mallId: "", categoryNo: "", pages: 4, detail: true, categories: [],
  };
  const body = h("div.screen-body");
  const supplierPick = h("div");

  /** 카테고리는 몰이 개편하면 바뀌므로 화면을 열 때 사이트에서 읽어 옵니다. */
  async function loadCategories() {
    if (!state.mallId) return;
    try {
      state.categories = await api(`/api/catalog/mall/categories?mallId=${encodeURIComponent(state.mallId)}`);
    } catch {
      state.categories = [];       // 사이트가 응답하지 않아도 화면은 그대로 씁니다
    }
    draw();
  }

  const fileInput = h("input", { type: "file", accept: ".csv,text/csv", style: { display: "none" } });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    state.filename = file.name;
    state.csv = await file.text();
    state.preview = null;
    await preview();
  });

  async function preview() {
    if (!state.supplierId) return toast("공급처를 먼저 선택해 주세요.", "err");
    if (!state.csv) return toast("CSV 파일을 선택해 주세요.", "err");
    try {
      state.preview = await api("/api/catalog/import/preview", {
        method: "POST",
        body: {
          supplierId: state.supplierId, csv: state.csv,
          filename: state.filename, catalogOnly: state.catalogOnly,
        },
      });
    } catch (error) {
      state.preview = null;
      toast(error.message, "err");
    }
    draw();
  }

  async function commit() {
    await guard(() => api("/api/catalog/import", {
      method: "POST",
      body: {
        supplierId: state.supplierId, csv: state.csv,
        filename: state.filename, catalogOnly: state.catalogOnly,
      },
    }), "공급처 품목을 적재했습니다.");
    state.csv = ""; state.filename = ""; state.preview = null;
    fileInput.value = "";
    await refresh();
  }

  /** 검색어 한 개로 가격 소스를 각각 호출합니다. 소스마다 요청 본문이 조금씩 다릅니다. */
  const API_SOURCES = {
    naver: { label: "네이버 쇼핑", path: "/api/catalog/naver/sync", body: (q) => ({ query: q, maxRows: 300 }) },
    coupang: { label: "쿠팡", path: "/api/catalog/coupang/sync", body: (q) => ({ query: q, maxRows: 100 }) },
    ali: { label: "알리익스프레스", path: "/api/catalog/ali/sync", body: (q) => ({ query: q, maxRows: 100 }) },
    g2b: { label: "나라장터", path: "/api/catalog/g2b/sync", body: (q) => ({ keyword: q, operation: "MAS", maxRows: 1000 }) },
    supplierRest: { label: "계약 공급처", path: "/api/catalog/supplier-rest/sync", body: (q) => ({ query: q, limit: 1000 }) },
  };

  async function syncApi(kind) {
    const source = API_SOURCES[kind];
    if (!state.apiQuery.trim()) return toast("검색어를 입력해 주세요.", "err");
    state.busy = kind; draw();
    try {
      const result = await api(source.path, { method: "POST", body: source.body(state.apiQuery.trim()) });
      if (!result.ok) return toast(result.reason || "동기화할 수 없습니다.", "err");
      const malls = result.suppliers ? ` · 판매처 ${result.suppliers}곳` : "";
      toast(`${source.label} ${fmt.int(result.fetched ?? result.imported ?? 0)}건${malls}을 가져왔습니다.`);
      await refresh();
    } catch (error) {
      toast(error.message, "err");
    } finally {
      state.busy = null; draw();
    }
  }

  /** 자재몰은 카테고리를 통째로 훑습니다. 가격이 없는 품목도 품목 마스터에는 들어갑니다. */
  async function syncMall(dryRun) {
    if (!state.categoryNo) return toast("카테고리를 선택해 주세요.", "err");
    state.busy = "mall"; draw();
    try {
      const result = await api("/api/catalog/mall/sync", {
        method: "POST",
        body: { mallId: state.mallId, categoryNo: state.categoryNo, pages: state.pages, detail: state.detail, dryRun },
      });
      if (!result.ok) return toast(result.reason || "수집할 수 없습니다.", "err");
      state.preview = dryRun ? { summary: result.summary, preview: result.preview } : null;
      toast(`${result.mall.name} ${result.category} — ${fmt.int(result.scanned)}건 확인 `
        + `(가격 ${fmt.int(result.priced)} · 품목만 ${fmt.int(result.noPrice)})`);
      if (dryRun) draw(); else await refresh();
    } catch (error) {
      toast(error.message, "err");
    } finally {
      state.busy = null; draw();
    }
  }

  /** 단가 열이 없는 목록도 품목 마스터에는 넣을 수 있게 해 줍니다. */
  function catalogOnlyBox() {
    const box = h("input", { type: "checkbox", checked: state.catalogOnly });
    box.addEventListener("change", () => {
      state.catalogOnly = box.checked;
      if (state.csv) preview();
    });
    return h("label.muted", { style: { display: "flex", gap: "6px", alignItems: "center" } },
      box, "단가 없이 품목만 등록");
  }

  function draw() {
    const parts = [];

    /* ── 소스 1. 온라인 자재몰 수집 (인증키 없이 동작) ── */
    const mallStatus = state.sources?.mall;
    const mallSelect = makeSelect({
      options: (mallStatus?.malls || []).map((row) => ({ value: row.id, label: row.name })),
      value: state.mallId, placeholder: "몰 선택", allowEmpty: false,
    });
    mallSelect.style.width = "160px";
    mallSelect.addEventListener("change", async () => {
      state.mallId = mallSelect.value;
      state.categoryNo = "";
      await loadCategories();
    });

    const catSelect = makeSelect({
      options: state.categories.map((row) => ({ value: row.no, label: row.label })),
      value: state.categoryNo,
      placeholder: state.categories.length ? "카테고리 선택" : "카테고리 불러오는 중…",
    });
    catSelect.style.width = "260px";
    catSelect.addEventListener("change", () => { state.categoryNo = catSelect.value; });

    const pagesInput = h("input", {
      type: "number", min: "1", max: "20", value: String(state.pages), style: { width: "70px" },
    });
    pagesInput.addEventListener("input", () => { state.pages = Math.max(1, Math.min(20, Number(pagesInput.value) || 1)); });

    const detailBox = h("input", { type: "checkbox", checked: state.detail });
    detailBox.addEventListener("change", () => { state.detail = detailBox.checked; });

    parts.push(h("div.panel", {},
      h("div.panel-head", {}, h("h3", { text: "온라인 자재몰 수집" })),
      h("div.panel-body", {},
        h("p.muted", { style: { margin: "0 0 14px", lineHeight: "1.7" },
          text: "몰의 카테고리를 통째로 훑어 품명·규격·제조사·배송비를 가져옵니다. "
            + "가격을 공개하지 않는 품목은 품목 마스터에만 들어가고, 가격은 다른 소스에서 채웁니다." }),
        h("div", { style: { display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" } },
          mallSelect, catSelect,
          h("label.muted", { style: { display: "flex", gap: "6px", alignItems: "center" } }, pagesInput, "페이지"),
          h("label.muted", { style: { display: "flex", gap: "6px", alignItems: "center" } }, detailBox, "상세까지 확인"),
          h("button.btn.sm", { disabled: state.busy === "mall", onclick: () => syncMall(true) }, "미리보기"),
          h("button.btn.sm.primary", { disabled: state.busy === "mall" || !mallStatus?.live, onclick: () => syncMall(false) },
            state.busy === "mall" ? "수집 중…" : "수집")),
        mallStatus?.live ? null : h("p.muted", { style: { margin: "12px 0 0" }, text: mallStatus?.reason || "" }))));

    /* ── 소스 2. 검색어 기반 가격 소스 ── */
    const queryInput = h("input", { value: state.apiQuery, placeholder: "예: CV 2.5SQ 4C", style: { width: "260px" } });
    queryInput.addEventListener("input", () => { state.apiQuery = queryInput.value; });

    const sourceRow = (kind, status) => h("div", {
      style: { display: "grid", gridTemplateColumns: "210px 1fr auto", gap: "12px", alignItems: "center", padding: "10px 0", borderTop: "1px solid var(--line)" },
    },
    h("b", { text: API_SOURCES[kind].label }),
    h("span.muted", {
      text: status?.live
        ? `연결 준비 · 최근 ${status.lastSyncAt ? fmt.dt(status.lastSyncAt) : "없음"}`
        : status?.reason || "상태 확인 중",
    }),
    h("button.btn.sm.primary", {
      disabled: !status?.live || Boolean(state.busy),
      onclick: () => syncApi(kind),
    }, state.busy === kind ? "동기화 중…" : "동기화"));

    parts.push(h("div.panel", {},
      h("div.panel-head", {}, h("h3", { text: "검색어로 판매처 가격 비교" })),
      h("div.panel-body", {},
        h("p.muted", { style: { margin: "0 0 12px", lineHeight: "1.7" },
          text: "네이버 쇼핑은 응답마다 판매몰 이름이 붙어 오므로, 한 번 호출로 쇼핑몰 여러 곳의 "
            + "가격이 판매처별로 나뉘어 들어옵니다. 인증키는 서버 환경변수에서만 읽습니다." }),
        h("div", { style: { marginBottom: "8px" } }, queryInput),
        sourceRow("naver", state.sources?.naver),
        sourceRow("coupang", state.sources?.coupang),
        sourceRow("ali", state.sources?.ali),
        sourceRow("g2b", state.sources?.g2b),
        sourceRow("supplierRest", state.sources?.supplierRest))));

    parts.push(h("div.panel", {},
      h("div.panel-head", {}, h("h3", { text: "1. 공급처 선택" })),
      h("div.panel-body", {}, supplierPick)));

    parts.push(h("div.panel", {},
      h("div.panel-head", {}, h("h3", { text: "2. 판매 품목 파일" })),
      h("div.panel-body", {},
        h("p.muted", { style: { margin: "0 0 14px", lineHeight: "1.8" },
          text: "엑셀에서 '다른 이름으로 저장 → CSV UTF-8' 로 내보낸 파일을 올립니다. "
            + "첫 줄은 머리글이어야 하며, 품명과 단가 열은 반드시 있어야 합니다." }),
        h("div.hdr-help", {},
          h("b", {}, "인식하는 머리글"),
          h("span", { text: "품명·품목명·제품명 / 품번·코드·모델 / 제조사·메이커 / 단위·판매단위 / 단가·가격·공급가 / 배송비 / 최소수량 / 납기·리드타임 / 재고" })),
        h("div", { style: { display: "flex", gap: "10px", alignItems: "center", marginTop: "16px" } },
          h("button.btn", { onclick: () => fileInput.click() }, state.filename || "CSV 파일 선택"),
          state.csv ? h("button.btn", { onclick: preview }, "다시 분석") : null,
          catalogOnlyBox(),
          fileInput))));

    if (state.preview) {
      const s = state.preview.summary;
      parts.push(h("div.panel", {},
        h("div.panel-head", {},
          h("h3", { text: "3. 적재 결과 미리보기" }),
          h("button.btn.primary", { onclick: commit }, `${s.total}건 적재하기`)),
        h("div.panel-body", {},
          h("div.metrics", { style: { marginBottom: "16px" } },
            [["읽은 행", s.total, null], ["기존 제품에 매칭", s.matched, "ok"],
              ["신규 제품 생성", s.created, null], ["규격 확인 필요", s.review, s.review ? "warn" : "ok"],
              ["가격 변경", s.updated, null], ["품목만 등록", s.catalog || 0, null],
              ["건너뜀", s.skipped, s.skipped ? "warn" : null]]
              .map(([label, value, tone]) => h("div.metric", {},
                h("div.metric-top", {}, h("span", { text: label })),
                h("strong", { text: fmt.int(value) })))),
          grid({
            rows: state.preview.preview,
            idKey: "raw",
            columns: [
              { key: "raw", label: "원본 품명", cls: "strong ellip", width: 220 },
              { key: "specLabel", label: "인식한 규격", cls: "ellip", width: 190 },
              { key: "category", label: "분류", width: 96, cell: (r) => esc(r.category) },
              { key: "match", label: "처리", width: 104, sortable: false,
                cell: (r) => statusChip(r.match === "created" ? "신규" : "매칭", r.match === "created" ? "warn" : "solid") },
              { key: "confidence", label: "신뢰도", width: 96, sortable: false,
                cell: (r) => (r.confidence === 1 ? statusChip("확실", "solid") : statusChip("확인 필요", "warn")) },
              { key: "unit", label: "단위", width: 90 },
              // 가격을 공개하지 않는 몰에서는 단가가 비어 있습니다 — 0 으로 보이면 안 됩니다.
              { key: "price", label: "단가", align: "num", width: 110,
                cell: (r) => (r.price === null ? "<span class=\"muted\">전화문의</span>" : fmt.won(r.price)) },
              { key: "unitPrice", label: "환산단가", align: "num", width: 110,
                cell: (r) => (r.unitPrice === null ? "" : fmt.int(Math.round(r.unitPrice))) },
            ],
          }))));
    }

    body.replaceChildren(...parts);
  }

  async function refresh() {
    const [suppliers, imports, sources] = await Promise.all([
      api("/api/suppliers"), api("/api/catalog/imports"), api("/api/catalog/sources"),
    ]);
    state.sources = sources;
    if (!state.mallId) {
      state.mallId = sources.mall?.malls?.[0]?.id || "";
      loadCategories();            // 목록이 도착하면 스스로 다시 그립니다
    }
    const picker = makeSelect({
      options: suppliers.map((row) => ({ value: row.id, label: row.name })),
      value: state.supplierId, placeholder: "공급처를 선택하세요",
    });
    picker.style.maxWidth = "360px";
    picker.addEventListener("change", () => { state.supplierId = picker.value; if (state.csv) preview(); });
    supplierPick.replaceChildren(
      picker,
      h("p.muted", { style: { margin: "12px 0 0" },
        text: suppliers.length ? "" : "등록된 공급처가 없습니다. 기준정보 > 공급처등록에서 먼저 추가하세요." }));

    draw();

    if (imports.length) {
      body.append(h("div.panel", {},
        h("div.panel-head", {}, h("h3", { text: "최근 적재 이력" })),
        h("div.panel-body", {}, grid({
          rows: imports,
          columns: [
            { key: "at", label: "일시", width: 160, cls: "code", cell: (r) => fmt.dt(r.at) },
            { key: "supplier_name", label: "공급처", width: 150, cls: "strong" },
            { key: "filename", label: "파일", cls: "ellip", width: 220 },
            { key: "total", label: "건수", align: "num", width: 84 },
            { key: "matched", label: "매칭", align: "num", width: 84 },
            { key: "created", label: "신규", align: "num", width: 84 },
            { key: "review", label: "확인필요", align: "num", width: 96 },
            { key: "user", label: "처리자", width: 100 },
          ],
        }))));
    }
  }

  const el = h("div.screen.scroll", {},
    h("div.screen-head", {},
      h("div", {}, h("div.crumb", { text: "기준정보 > 공급처 품목 등록" }), h("h1", { text: "공급처 판매품목 적재" })),
      h("div.head-actions", {}, h("button.btn", { onclick: () => openScreen("pur.search") }, "통합검색"))),
    h("div"),
    body);

  return { el, refresh };
}

const purSearch = catalogSearch;
const baseImport = catalogImport;

function requestDialog(product, refresh) {
  return openForm({
    title: "구매요청 작성", sub: `${product.name}${product.supplier ? ` · ${product.supplier}` : ""}`, width: "wide",
    extra: {
      readout: h("div.readout", {},
        h("b", { text: `${product.supplier || "-"} · ${fmt.won(product.price)} / ${product.unit}` }),
        h("span", { text: `${product.manufacturer || ""} · 사내재고 ${fmt.int(product.stock)} · 납기 ${product.lead_time || "-"}` })),
      calc: {
        label: "예상 구매금액 (배송비 포함)",
        compute: (state) => fmt.won(product.price * Math.max(1, Number(state.quantity) || 1) + (product.shipping || 0)),
      },
    },
    fields: [
      { key: "productId", label: "품목", type: "static", value: `${product.name} (${product.id})` },
      { key: "projectId", label: "사용 공사", type: "select", required: true, options: ref.projectOpts },
      { key: "quantity", label: "수량", type: "number", required: true, min: 1, value: product.quantity || 1, unit: product.unit },
      { key: "requestedDate", label: "희망납기", type: "date", value: addDays(today(), 4) },
      { key: "purpose", label: "사용 목적", type: "textarea", required: true, full: true, placeholder: "예: 주배전반 인입 케이블 시공" },
    ],
    submitLabel: "구매요청 보내기",
    footNote: "요청은 구매 담당 승인 후 발주서로 전환되며, 선택한 공사의 작업별 영수증에 자동 집계됩니다.",
    onSubmit: (values) => api("/api/purchase-requests", {
      method: "POST",
      body: {
        ...values, productId: product.id, supplierId: product.supplierId,
        supplierProductId: product.supplierProductId, quotedUnitPrice: product.price,
      },
    }),
  }).then((result) => { if (result) { toast("구매요청을 등록했습니다."); refresh?.(); } });
}

const purRequest = dataScreen({
  crumb: "구매관리 > 구매요청", title: "구매요청 관리",
  exportName: "구매요청",
  actions: (state, refresh) => ref.can("purchasing")
    ? [btn("＋ 신규 요청", async () => {
      const picked = await pickProduct();
      if (picked) requestDialog(picked, refresh);
    }, "primary")] : [],
  load: () => api("/api/purchase-requests"),
  summary: (rows) => strip([
    ["전체", `${rows.length}`],
    ["대기", `${rows.filter((r) => r.status === "구매요청").length}`, rows.some((r) => r.status === "구매요청") ? "bad" : ""],
    ["발주완료", `${rows.filter((r) => r.status === "발주완료").length}`],
    ref.canPrices ? ["예상금액", fmt.won(rows.reduce((t, r) => t + (r.price || 0) * r.quantity, 0))] : null,
  ]),
  columns: () => [
    { key: "id", label: "요청번호", cls: "code", width: 132 },
    { key: "created_at", label: "요청일", width: 96, cls: "code", cell: (r) => fmt.date(r.created_at) },
    { key: "project_name", label: "공사", width: 180, cls: "strong" },
    { key: "product_name", label: "품목" },
    { key: "quantity", label: "수량", align: "num", width: 64, sum: true },
    ...(ref.canPrices ? [{ key: "_amt", label: "예상금액", align: "num", width: 108, sortValue: (r) => (r.price || 0) * r.quantity, cell: (r) => fmt.won((r.price || 0) * r.quantity) }] : []),
    { key: "requested_date", label: "희망납기", width: 92, cls: "code" },
    { key: "purpose", label: "사용목적", cls: "wrap" },
    { key: "requester", label: "요청자", width: 74 },
    { key: "status", label: "상태", width: 80, cell: (r) => statusChip(r.status) },
    {
      key: "_actions", label: "업무", width: 152, sortable: false, noExport: true,
      cell: (r) => (ref.can("purchasing") && r.status === "구매요청" ? acts(act("승인·발주", "primary"), act("반려", "danger")) : ""),
    },
  ],
  footer: true,
  rowActions: (refresh) => ({
    "승인·발주": (row) => openForm({
      title: "구매요청 승인 · 발주", sub: row.id, width: "wide",
      extra: {
        readout: h("div.readout", {}, h("b", { text: row.product_name }),
          h("span", { text: `${row.project_name} · ${row.quantity}${row.unit ? ` ${row.unit}` : ""} · ${row.purpose || ""}` })),
        calc: { label: "발주금액", compute: (s) => fmt.won((Number(s.unitPrice) || 0) * row.quantity) },
      },
      fields: [
        { key: "supplierId", label: "공급처", type: "select", required: true, options: ref.supplierOpts, value: row.preferred_supplier_id || ref.suppliers.find((s) => s.name === ref.product(row.product_id)?.supplier)?.id || "" },
        { key: "unitPrice", label: "발주단가", type: "won", required: true, value: row.price || 0, unit: "원" },
        { key: "dueDate", label: "납기일", type: "date", value: row.requested_date || addDays(today(), 5) },
        { key: "warehouseId", label: "입고예정창고", type: "select", options: ref.warehouseOpts, value: ref.warehouses[0]?.id || "" },
      ],
      submitLabel: "승인하고 발주서 만들기",
      footNote: "승인하면 발주서가 생성되고 선택한 창고의 입고예정 수량이 늘어납니다.",
      onSubmit: (values) => api(`/api/purchase-requests/${encodeURIComponent(row.id)}/approve`, { method: "POST", body: values }),
    }).then((result) => { if (result) { toast(`발주서 ${result.order.id}를 생성했습니다.`); refresh(); } }),
    반려: (row) => openForm({
      title: "구매요청 반려", sub: row.id,
      fields: [{ key: "reason", label: "반려사유", type: "textarea", required: true, full: true }],
      submitLabel: "반려",
      onSubmit: (values) => api(`/api/purchase-requests/${encodeURIComponent(row.id)}/reject`, { method: "POST", body: values }),
    }).then((result) => { if (result) { toast("구매요청을 반려했습니다."); refresh(); } }),
  }),
  empty: { title: "구매요청이 없습니다", hint: "자재 통합검색에서 제품을 찾아 구매요청을 만들 수 있습니다." },
});

/** 품목 선택용 간이 팝업 — 검색 화면을 거치지 않고 바로 요청할 때 씁니다. */
function pickProduct() {
  return new Promise((resolve) => {
    const rows = ref.products.filter((product) => product.active).map((product) => ({ ...product, stock: 0 }));
    openPanel({
      title: "품목 선택", width: "xwide",
      content: grid({
        rows,
        columns: [
          { key: "id", label: "품목코드", cls: "code", width: 140 },
          { key: "name", label: "품목명", cls: "strong" },
          { key: "manufacturer", label: "제조사", width: 110 },
          { key: "supplier", label: "주거래처", width: 120 },
          ...(ref.canPrices ? [{ key: "price", label: "표준단가", align: "num", width: 108, cell: (r) => fmt.won(r.price) }] : []),
          { key: "unit", label: "단위", width: 70 },
        ],
        onRowClick: (row) => { closeModal(); resolve({ ...row, match: 100, lead_time: row.lead_time }); },
      }),
    });
    $("#modal").addEventListener("close", () => resolve(null), { once: true });
  });
}

/* ---------- 발주서 (다품목) -------------------------------------------------
   발주번호 하나에 품목이 여러 줄 달립니다. 목록은 발주서 단위로 보여 주고,
   행을 누르면 줄이 펼쳐집니다. 입고도 줄마다 따로 찍습니다 — 자재는 나뉘어
   들어오는 것이 보통이라 "한 번에 전량" 을 전제하면 현장과 어긋납니다. */

/** 줄 요약 — 목록 한 칸에 "CV 10SQ 3C 외 2품목" 으로 접습니다. */
const lineSummary = (order) => {
  const lines = order.lines || [];
  if (!lines.length) return "-";
  const first = lines[0].product_name || lines[0].product_id || "품목";
  return lines.length > 1 ? `${first} 외 ${lines.length - 1}품목` : first;
};

/** 발주 줄 표 — 펼친 패널과 입고 화면이 같은 모양을 씁니다. */
function orderLineTable(order) {
  return h("table.ol", {},
    h("thead", {}, h("tr", {}, ...[
      "#", "품목", "공사", "발주", "입고", "미입고",
      ...(ref.canPrices ? ["단가", "금액"] : []),
    ].map((label, index) => h(`th${index >= 3 ? ".num" : ""}`, { text: label })))),
    h("tbody", {}, order.lines.map((line) => h(`tr${line.remaining === 0 ? ".done" : ""}`, {}, ...[
      h("td.code", { text: String(line.line_no) }),
      h("td.strong", {}, line.product_name || line.product_id,
        line.manufacturer ? h("small", { text: line.manufacturer }) : null),
      h("td", { text: line.project_name || "-" }),
      h("td.num", { text: `${fmt.int(line.quantity)}${line.unit || ""}` }),
      h("td.num", { text: fmt.int(line.received) }),
      h("td.num", {}, h(`b${line.remaining > 0 ? ".warn" : ""}`, { text: fmt.int(line.remaining) })),
      ...(ref.canPrices ? [
        h("td.num", { text: fmt.won(line.unit_price) }),
        h("td.num.strong", { text: fmt.won(line.amount) }),
      ] : []),
    ]))));
}

/** 발주서 한 장을 펼쳐 봅니다. */
function orderPanel(order, refresh) {
  openPanel({
    title: `발주서 ${order.id}`,
    sub: `${order.supplier_name || "-"} · ${order.lines.length}품목 · ${ref.canPrices ? fmt.won(order.amount) : `${fmt.int(order.quantity)}개`}`,
    width: "xwide",
    content: h("div", {}, orderLineTable(order)),
    actions: [
      h("button.btn", { onclick: () => { closeModal(); openOrderSheet(order.id); } }, "인쇄"),
      order.remaining > 0 && !["승인대기", "취소"].includes(order.status) && ref.can("warehouse")
        ? h("button.btn.primary", { onclick: () => { closeModal(); receiveDialog(order, refresh); } }, "입고")
        : null,
    ].filter(Boolean),
  });
}

/* ---------- 인쇄용 발주서 ---------------------------------------------------
   공급처에 그대로 보내는 A4 한 장입니다. 작업별 영수증과 같은 .paper 를 씁니다. */

/** 인쇄 화면이 열릴 때 어느 발주서를 그릴지 알려 주는 자리입니다. */
const sheetRequest = { orderId: null };

function openOrderSheet(orderId) {
  sheetRequest.orderId = orderId;
  openScreen("pur.sheet");
}

function orderSheetScreen() {
  const state = { orderId: null, data: null, orders: [] };
  const side = h("div.receipt-side");
  const paper = h("div.paper");

  async function refresh() {
    state.orders = (await api("/api/purchase-orders")).filter((row) => row.status !== "취소");
    if (sheetRequest.orderId) { state.orderId = sheetRequest.orderId; sheetRequest.orderId = null; }
    if (!state.orders.some((row) => row.id === state.orderId)) state.orderId = state.orders[0]?.id || null;

    side.replaceChildren(...[
      h("div.hd", { text: `발주서 ${state.orders.length}건` }),
      ...state.orders.map((order) => h(`button.prj-btn${state.orderId === order.id ? ".on" : ""}`, {
        onclick: () => { state.orderId = order.id; refresh(); },
      },
        h("b", { text: order.supplier_name || "-" }),
        h("span", { text: `${order.id} · ${order.lines.length}품목` }),
        h("small", { text: ref.canPrices ? fmt.won(order.amount) : `${fmt.int(order.quantity)}개` }))),
    ]);

    if (!state.orderId) {
      paper.replaceChildren(h("p.muted", { text: "인쇄할 발주서가 없습니다." }));
      return;
    }
    state.data = await api(`/api/purchase-orders/${encodeURIComponent(state.orderId)}/sheet`);
    drawPaper();
  }

  function drawPaper() {
    const { order, organization, supply, vat, total, amountInWords, printedAt } = state.data;
    paper.innerHTML = `
      <div class="paper-top">
        <div><h2>발 주 서</h2><div class="muted" style="font-size:11px;margin-top:4px">PURCHASE ORDER</div></div>
        <div class="meta">${esc(order.id)}<br>발행일 ${esc(printedAt)}</div>
      </div>
      <div class="paper-parties">
        <div>
          <span>공급받는 자</span>
          <b>${esc(organization.name || "-")}</b>
          <small>사업자번호 ${esc(organization.businessNumber || "-")}</small>
          <small>${esc(organization.address || "-")}</small>
          <small>전화 ${esc(organization.phone || "-")} · 담당 ${esc(order.approver || "-")}</small>
        </div>
        <div>
          <span>공급자</span>
          <b>${esc(order.supplier_name || "-")}</b>
          <small>사업자번호 ${esc(order.supplier_biz_no || "-")}</small>
          <small>담당 ${esc(order.supplier_contact || "-")}</small>
          <small>전화 ${esc(order.supplier_phone || "-")} · ${esc(order.supplier_email || "-")}</small>
        </div>
      </div>
      <div class="paper-sum">
        <span>합계금액 (부가세 포함)</span>
        <b>일금 ${esc(amountInWords)} (${fmt.won(total)})</b>
      </div>
      <table>
        <thead><tr>
          <th style="width:38px">No</th><th>품목 · 규격</th><th style="width:120px">공사</th>
          <th style="width:76px" class="num">수량</th><th style="width:60px">단위</th>
          <th style="width:96px" class="num">단가</th><th style="width:110px" class="num">금액</th>
        </tr></thead>
        <tbody>${order.lines.map((line) => `<tr>
          <td>${line.line_no}</td>
          <td><b>${esc(line.product_name || line.product_id)}</b>${line.spec ? `<small>${esc(line.spec)}</small>` : ""}</td>
          <td>${esc(line.project_name || "-")}</td>
          <td class="num">${fmt.int(line.quantity)}</td>
          <td>${esc(line.unit || "")}</td>
          <td class="num">${fmt.won(line.unit_price)}</td>
          <td class="num"><b>${fmt.won(line.amount)}</b></td>
        </tr>`).join("")}</tbody>
      </table>
      <div class="paper-total">
        <div><span>공급가액</span><b>${fmt.won(supply)}</b></div>
        <div><span>부가세</span><b>${fmt.won(vat)}</b></div>
        <div class="big"><span>합계</span><b>${fmt.won(total)}</b></div>
      </div>
      <div class="paper-meta" style="margin-top:26px">
        <div><span>납기</span><b>${esc(order.due_date || "협의")}</b></div>
        <div><span>결제조건</span><b>${esc(order.terms || "기존 계약 조건")}</b></div>
        <div><span>발주일</span><b>${esc(String(order.created_at).slice(0, 10))}</b></div>
        <div><span>진행상태</span><b>${esc(order.status)}</b></div>
      </div>
      ${order.note ? `<div class="paper-note">${esc(order.note)}</div>` : ""}
      <div class="paper-note">
        위와 같이 발주하오니 납기일까지 납품하여 주시기 바랍니다.
        수량·규격이 발주서와 다를 경우 입고 전에 연락 바랍니다.
      </div>`;
  }

  const el = h("div.screen", {},
    h("div.screen-head", {},
      h("div", {}, h("div.crumb", { text: "구매관리 > 발주서 인쇄" }), h("h1", { text: "발주서" })),
      h("div.head-actions", {},
        btn("인쇄", () => window.print(), "primary"),
        btn("새로고침", () => refresh()))),
    h("div"),
    h("div.screen-body", {}, h("div.receipt-layout", {}, side, h("div.receipt-scroll", {}, paper))));

  return { el, refresh };
}

const purOrder = dataScreen({
  crumb: "구매관리 > 발주서", title: "발주 진행현황",
  initialState: { status: "" },
  exportName: "발주서",
  actions: (state, refresh) => ref.can("purchasing") ? [btn("＋ 직접 발주", () => orderDialog(refresh), "primary")] : [],
  filters: (state, refresh) => [
    fld("진행상태", h("div.chipset", {}, ["", "승인대기", "발주완료", "부분입고", "입고완료", "취소"].map((value) =>
      h(`button.chip${state.status === value ? ".on" : ""}`, {
        onclick: (event) => {
          state.status = value;
          [...event.target.parentNode.children].forEach((chip) => chip.classList.remove("on"));
          event.target.classList.add("on");
          refresh();
        },
      }, value || "전체")))),
  ],
  load: async (state) => {
    const rows = await api("/api/purchase-orders");
    return state.status ? rows.filter((row) => row.status === state.status) : rows;
  },
  summary: (rows) => strip([
    ["발주 건수", `${rows.length}`],
    ref.canPrices ? ["발주금액", fmt.won(sum(rows, "amount"))] : null,
    ["미입고 수량", fmt.int(sum(rows, "remaining"))],
    ["승인대기", `${rows.filter((r) => r.status === "승인대기").length}`, rows.some((r) => r.status === "승인대기") ? "bad" : ""],
  ]),
  onRowClick: (row) => orderPanel(row, () => {}),
  columns: () => [
    { key: "id", label: "발주번호", cls: "code", width: 126 },
    { key: "supplier_name", label: "공급처", width: 108 },
    { key: "_items", label: "품목", cls: "strong ellip", sortValue: (r) => lineSummary(r), cell: (r) => esc(lineSummary(r)) },
    { key: "line_count", label: "품목", align: "num", width: 58 },
    { key: "quantity", label: "발주", align: "num", width: 58, sum: true },
    { key: "received", label: "입고", align: "num", width: 58, sum: true },
    { key: "remaining", label: "미입고", align: "num", width: 66, sum: true, cell: (r) => `<b>${fmt.int(r.remaining)}</b>` },
    ...(ref.canPrices ? [
      { key: "amount", label: "발주금액", align: "num", width: 116, sum: true, cell: (r) => fmt.won(r.amount), sumFormat: fmt.won },
    ] : []),
    { key: "due_date", label: "납기", width: 118, cell: (r) => (["입고완료", "취소"].includes(r.status) ? esc(r.due_date || "") : dueCell(r.due_date)) },
    { key: "status", label: "상태", width: 108, cell: (r) => statusChip(r.status) },
    {
      key: "_actions", label: "업무", width: 190, sortable: false, noExport: true,
      cell: (r) => acts(
        act("상세"),
        act("인쇄"),
        r.status === "승인대기" && ref.can("purchasing") ? act("승인", "primary") : "",
        r.remaining > 0 && !["승인대기", "취소"].includes(r.status) && ref.can("warehouse") ? act("입고", "primary") : "",
        r.received === 0 && r.status !== "취소" && ref.can("purchasing") ? act("취소", "danger") : ""),
    },
  ],
  footer: true,
  rowActions: (refresh) => ({
    상세: (row) => orderPanel(row, refresh),
    인쇄: (row) => openOrderSheet(row.id),
    승인: async (row) => {
      if (!await confirmAsk({ title: "발주 승인", okLabel: "승인", message: `${row.id} / ${row.supplier_name} / ${fmt.won(row.amount)} 발주를 승인합니다.` })) return;
      await guard(() => api(`/api/purchase-orders/${encodeURIComponent(row.id)}/approve`, { method: "POST", body: {} }), "발주를 승인했습니다.");
      refresh();
    },
    입고: (row) => receiveDialog(row, refresh),
    취소: async (row) => {
      if (!await confirmAsk({ title: "발주 취소", danger: true, okLabel: "취소 처리", message: `${row.id} 발주를 취소합니다.` })) return;
      await guard(() => api(`/api/purchase-orders/${encodeURIComponent(row.id)}/cancel`, { method: "POST", body: {} }), "발주를 취소했습니다.");
      refresh();
    },
  }),
});

/**
 * 발주서 직접 등록 — 품목 줄을 붙였다 뗐다 합니다.
 * 같은 공급처에 여러 품목을 한 장으로 보내는 것이 보통이라, 줄 추가가 기본입니다.
 */
function orderDialog(refresh) {
  const rows = [];
  const body = h("tbody");
  const totalCell = h("b", { text: "₩0" });

  const recalc = () => {
    const amount = rows.reduce((sum, row) =>
      sum + (Number(row.qty.value) || 0) * (Number(row.price.value.replace(/[^\d.-]/g, "")) || 0), 0);
    totalCell.textContent = fmt.won(amount);
  };

  function addRow(preset = {}) {
    const product = makeSelect({ options: ref.productOpts, placeholder: "품목 선택" });
    const project = makeSelect({ options: ref.projectOpts, placeholder: "공사(선택)" });
    const qty = h("input.ol-qty", { type: "number", min: "1", value: String(preset.quantity || 1) });
    const price = h("input.ol-price", { type: "text", inputmode: "numeric", value: "0" });

    // 품목을 고르면 기준단가를 넣어 줍니다. 손으로 고칠 수 있습니다.
    product.addEventListener("change", () => {
      const picked = ref.product(product.value);
      if (picked) { price.value = String(picked.price || 0); recalc(); }
    });
    qty.addEventListener("input", recalc);
    price.addEventListener("input", recalc);

    const row = { product, project, qty, price };
    const tr = h("tr", {},
      h("td", {}, product),
      h("td", {}, project),
      h("td.num", {}, qty),
      h("td.num", {}, price),
      h("td.num", {}, h("button.btn.sm.danger", {
        type: "button",
        onclick: () => {
          if (rows.length === 1) return toast("품목은 한 줄 이상 있어야 합니다.", "err");
          rows.splice(rows.indexOf(row), 1);
          tr.remove();
          recalc();
        },
      }, "삭제")));
    rows.push(row);
    body.append(tr);
    recalc();
  }

  addRow();

  const editor = h("div", {},
    h("div.recv-quick", {},
      h("button.btn.sm", { type: "button", onclick: () => addRow() }, "＋ 품목 줄 추가"),
      h("div.grow"),
      h("span.muted", {}, "발주금액 ", totalCell)),
    h("table.ol.edit", {},
      h("thead", {}, h("tr", {}, ...["품목", "공사", "수량", "단가", ""]
        .map((label, index) => h(`th${[2, 3].includes(index) ? ".num" : ""}`, { text: label })))),
      body));

  return openForm({
    title: "발주서 직접 등록", width: "xwide",
    extra: { node: editor },
    fields: [
      { key: "supplierId", label: "공급처", type: "select", required: true, options: ref.supplierOpts },
      { key: "dueDate", label: "납기일", type: "date", value: addDays(today(), 5) },
      {
        key: "status", label: "상태", type: "select", placeholder: false,
        options: [{ value: "승인대기", label: "승인대기" }, { value: "발주완료", label: "발주완료(즉시승인)" }],
      },
      { key: "note", label: "비고", type: "textarea", full: true },
    ],
    submitLabel: "발주 등록",
    footNote: "품목 줄마다 공사를 따로 지정할 수 있습니다. 공사별 원가는 줄 기준으로 집계됩니다.",
    onSubmit: (values) => {
      const lines = rows.map((row) => ({
        productId: row.product.value,
        projectId: row.project.value || undefined,
        quantity: Number(row.qty.value) || 0,
        unitPrice: Number(String(row.price.value).replace(/[^\d.-]/g, "")) || 0,
      }));
      if (lines.some((line) => !line.productId)) throw new Error("품목을 고르지 않은 줄이 있습니다.");
      if (lines.some((line) => line.quantity < 1)) throw new Error("수량이 1 미만인 줄이 있습니다.");
      return api("/api/purchase-orders", { method: "POST", body: { ...values, lines } });
    },
  }).then((result) => {
    if (result) { toast(`발주서 ${result.id}를 등록했습니다 (${result.lines.length}품목).`); refresh(); }
  });
}

/**
 * 입고 처리 — 줄마다 수량을 받습니다.
 * 안 온 품목은 0 으로 두면 이번 입고에서 빠집니다. 창고와 입고일자는 발주 단위
 * 하나입니다 — 한 번 온 차에서 품목마다 다른 창고로 넣는 일은 없습니다.
 */
function receiveDialog(order, refresh) {
  const pending = (order.lines || []).filter((line) => line.remaining > 0);
  if (!pending.length) return toast("입고할 잔량이 없습니다.", "err");

  const inputs = new Map();
  const totalCell = h("b");

  const recalc = () => {
    const amount = pending.reduce((sum, line) =>
      sum + (Number(inputs.get(line.id).value) || 0) * (line.unit_price || 0), 0);
    totalCell.textContent = ref.canPrices ? fmt.won(amount) : "-";
  };

  const table = h("table.ol.recv", {},
    h("thead", {}, h("tr", {}, ...["#", "품목", "발주", "기입고", "미입고", "이번 입고", "적치위치"]
      .map((label, index) => h(`th${[2, 3, 4, 5].includes(index) ? ".num" : ""}`, { text: label })))),
    h("tbody", {}, pending.map((line) => {
      const qty = h("input.recv-qty", {
        type: "number", min: "0", max: String(line.remaining), value: String(line.remaining),
      });
      qty.addEventListener("input", recalc);
      inputs.set(line.id, qty);
      const bin = h("input.recv-bin", { type: "text", placeholder: "A-01-03" });
      inputs.set(`${line.id}:bin`, bin);
      return h("tr", {},
        h("td.code", { text: String(line.line_no) }),
        h("td.strong", { text: line.product_name || line.product_id }),
        h("td.num", { text: `${fmt.int(line.quantity)}${line.unit || ""}` }),
        h("td.num", { text: fmt.int(line.received) }),
        h("td.num", {}, h("b", { text: fmt.int(line.remaining) })),
        h("td.num", {}, qty),
        h("td", {}, bin));
    })));

  const quickButtons = h("div.recv-quick", {},
    h("button.btn.sm", {
      type: "button",
      onclick: () => { pending.forEach((line) => { inputs.get(line.id).value = String(line.remaining); }); recalc(); },
    }, "전량 입고"),
    h("button.btn.sm", {
      type: "button",
      onclick: () => { pending.forEach((line) => { inputs.get(line.id).value = "0"; }); recalc(); },
    }, "모두 0"),
    h("div.grow"),
    h("span.muted", {}, "매입 계상액 ", totalCell));

  recalc();

  return openForm({
    title: "입고 처리",
    sub: `${order.id} · ${order.supplier_name || "-"} · ${pending.length}품목 대기`,
    width: "xwide",
    extra: { node: h("div", {}, quickButtons, table) },
    fields: [
      { key: "warehouseId", label: "입고창고", type: "select", required: true, options: ref.warehouseOpts, value: ref.warehouses[0]?.id || "" },
      { key: "receivedAt", label: "입고일자", type: "date", value: today() },
      { key: "note", label: "검수 비고", type: "textarea", full: true, placeholder: "불량·오배송이 있으면 여기에 적어 주세요" },
    ],
    submitLabel: "입고 확정",
    footNote: "안 온 품목은 0 으로 두세요. 이번에 받은 수량만 재고로 잡히고, 나머지는 미입고로 남습니다.",
    onSubmit: (values) => api(`/api/purchase-orders/${encodeURIComponent(order.id)}/receive`, {
      method: "POST",
      body: {
        ...values,
        lines: pending.map((line) => ({
          lineId: line.id,
          quantity: Number(inputs.get(line.id).value) || 0,
          bin: inputs.get(`${line.id}:bin`).value || undefined,
        })).filter((line) => line.quantity > 0),
      },
    }),
  }).then((result) => {
    if (result) {
      toast(`입고 ${result.lines.length}품목 완료 — ${result.entryId ? `전표 ${result.entryId}` : "전표 없음"}`);
      refresh();
    }
  });
}

const purReceive = dataScreen({
  crumb: "구매관리 > 입고처리", title: "입고 대기 목록",
  exportName: "입고대기",
  load: async () => (await api("/api/purchase-orders"))
    .filter((order) => order.remaining > 0 && !["승인대기", "취소"].includes(order.status)),
  summary: (rows) => strip([
    ["입고 대기", `${rows.length}`],
    ["미입고 수량", fmt.int(sum(rows, "remaining"))],
    ["납기 경과", `${rows.filter((r) => r.due_date && r.due_date < today()).length}`, rows.some((r) => r.due_date && r.due_date < today()) ? "bad" : ""],
  ]),
  columns: () => [
    { key: "due_date", label: "납기", width: 118, cell: (r) => dueCell(r.due_date) },
    { key: "id", label: "발주번호", cls: "code", width: 126 },
    { key: "supplier_name", label: "공급처", width: 108 },
    { key: "_items", label: "품목", cls: "strong ellip", sortValue: (r) => lineSummary(r), cell: (r) => esc(lineSummary(r)) },
    { key: "_pending", label: "미도착", align: "num", width: 72,
      sortValue: (r) => r.lines.filter((line) => line.remaining > 0).length,
      cell: (r) => `${r.lines.filter((line) => line.remaining > 0).length} / ${r.lines.length}` },
    { key: "remaining", label: "미입고", align: "num", width: 80, sum: true, cell: (r) => `<b>${fmt.int(r.remaining)}</b>` },
    { key: "status", label: "상태", width: 108, cell: (r) => statusChip(r.status) },
    { key: "_actions", label: "업무", width: 124, sortable: false, noExport: true,
      cell: () => acts(act("상세"), ref.can("warehouse") ? act("입고", "primary") : "") },
  ],
  footer: true,
  onRowClick: (row) => orderPanel(row, () => {}),
  rowActions: (refresh) => ({
    상세: (row) => orderPanel(row, refresh),
    입고: (row) => receiveDialog(row, refresh),
  }),
  empty: { title: "입고 대기 중인 발주가 없습니다", hint: "발주서 화면에서 승인된 발주가 여기에 표시됩니다." },
});

const purReceipts = dataScreen({
  crumb: "구매관리 > 입고내역", title: "입고 내역",
  exportName: "입고내역",
  load: () => api("/api/goods-receipts"),
  summary: (rows) => strip([["입고 건수", `${rows.length}`], ["입고수량 합계", fmt.int(sum(rows, "quantity"))]]),
  columns: () => [
    { key: "id", label: "입고번호", cls: "code", width: 124 },
    { key: "received_at", label: "입고일자", width: 96, cls: "code" },
    { key: "order_id", label: "발주번호", cls: "code", width: 128 },
    { key: "supplier_name", label: "공급처", width: 120 },
    { key: "product_name", label: "품목", cls: "strong" },
    { key: "warehouse_name", label: "입고창고", width: 118 },
    { key: "quantity", label: "수량", align: "num", width: 72, sum: true },
    { key: "receiver", label: "처리자", width: 80 },
    { key: "note", label: "검수 비고", cls: "wrap" },
  ],
  footer: true,
  empty: { title: "입고 내역이 없습니다" },
});

/* ==========================================================================
   영업
   ========================================================================== */

const salOrder = dataScreen({
  crumb: "영업관리 > 매출등록", title: "매출 · 기성 청구",
  exportName: "매출",
  actions: (state, refresh) => ref.can("sales") ? [btn("＋ 매출 등록", () => salesDialog(refresh), "primary")] : [],
  load: () => api("/api/sales-orders"),
  summary: (rows) => strip([
    ["매출 합계", fmt.won(sum(rows, "amount"))],
    ["수금액", fmt.won(sum(rows, "received"))],
    ["미수금", fmt.won(sum(rows, "outstanding")), sum(rows, "outstanding") > 0 ? "bad" : ""],
    ["건수", `${rows.length}`],
  ]),
  columns: () => [
    { key: "id", label: "매출번호", cls: "code", width: 128 },
    { key: "customer", label: "거래처", width: 130, cls: "strong" },
    { key: "project_name", label: "공사", width: 180 },
    { key: "description", label: "적요", cls: "wrap" },
    { key: "amount", label: "매출금액", align: "num", width: 120, sum: true, cell: (r) => fmt.won(r.amount), sumFormat: fmt.won },
    { key: "received", label: "수금액", align: "num", width: 116, sum: true, cell: (r) => fmt.won(r.received), sumFormat: fmt.won },
    { key: "outstanding", label: "미수금", align: "num", width: 116, sum: true, cell: (r) => (r.outstanding ? `<b>${fmt.won(r.outstanding)}</b>` : "-"), sumFormat: fmt.won },
    { key: "invoice_date", label: "발행일", width: 92, cls: "code" },
    { key: "due_date", label: "수금예정", width: 130, cell: (r) => (r.outstanding > 0 ? dueCell(r.due_date) : esc(r.due_date || "")) },
    { key: "status", label: "상태", width: 92, cell: (r) => statusChip(r.status) },
    {
      key: "_actions", label: "업무", width: 80, sortable: false, noExport: true,
      cell: (r) => (ref.can("sales") && r.outstanding > 0 ? act("수금", "primary") : ""),
    },
  ],
  footer: true,
  rowActions: (refresh) => ({ 수금: (row) => paymentDialog(refresh, row) }),
});

function salesDialog(refresh) {
  return openForm({
    title: "매출 등록", width: "wide",
    fields: [
      { key: "customer", label: "거래처", required: true, placeholder: "발주처명" },
      { key: "projectId", label: "공사", type: "select", options: ref.projectOpts },
      { key: "description", label: "적요", full: true, placeholder: "예: 간선 전기공사 2차 기성" },
      { key: "amount", label: "매출금액", type: "won", required: true, unit: "원" },
      { key: "invoiceDate", label: "발행일", type: "date", value: today() },
      { key: "dueDate", label: "수금예정일", type: "date", value: addDays(today(), 30) },
      { key: "status", label: "상태", type: "select", placeholder: false, options: ["승인완료", "세금계산서 발행", "검토"].map((value) => ({ value, label: value })) },
    ],
    submitLabel: "등록",
    onSubmit: (values) => api("/api/sales-orders", { method: "POST", body: values }),
  }).then((result) => { if (result) { toast("매출을 등록했습니다."); refresh(); } });
}

async function paymentDialog(refresh, preset) {
  const orders = (await api("/api/sales-orders")).filter((order) => order.outstanding > 0);
  if (!orders.length) return toast("수금할 미수 매출이 없습니다.", "err");
  let selected = preset || orders[0];
  return openForm({
    title: "수금 등록", sub: preset ? `${preset.id} · ${preset.customer}` : undefined, width: "wide",
    extra: { calc: { label: "수금 후 잔액", compute: (state) => fmt.won(Math.max(0, (selected?.outstanding || 0) - (Number(state.amount) || 0))) } },
    fields: [
      {
        key: "salesOrderId", label: "매출 건", type: "select", required: true, value: selected.id,
        options: orders.map((order) => ({ value: order.id, label: `${order.id} · ${order.customer} · 미수 ${fmt.won(order.outstanding)}` })),
        onChange: (state, inputs) => {
          selected = orders.find((order) => order.id === state.salesOrderId) || selected;
          if (inputs.get("amount")) { inputs.get("amount").value = selected.outstanding; state.amount = selected.outstanding; }
        },
      },
      { key: "amount", label: "수금액", type: "won", required: true, min: 1, value: selected.outstanding, unit: "원" },
      { key: "paidAt", label: "수금일", type: "date", value: today() },
      { key: "method", label: "수금방법", type: "select", placeholder: false, options: ["계좌이체", "현금", "어음", "카드"].map((value) => ({ value, label: value })) },
      { key: "note", label: "비고", type: "textarea", full: true },
    ],
    submitLabel: "수금 처리",
    footNote: "수금을 등록하면 매출 상태가 갱신되고 수금 전표가 자동으로 만들어집니다.",
    onSubmit: (values) => api("/api/payments", { method: "POST", body: values }),
  }).then((result) => { if (result) { toast(`수금 ${fmt.won(result.payment.amount)} 처리 완료`); refresh(); } });
}

const salPayment = dataScreen({
  crumb: "영업관리 > 수금관리", title: "수금 내역",
  exportName: "수금내역",
  actions: (state, refresh) => ref.can("sales") ? [btn("＋ 수금 등록", () => paymentDialog(refresh), "primary")] : [],
  load: () => api("/api/payments"),
  summary: (rows) => strip([["수금 건수", `${rows.length}`], ["수금 합계", fmt.won(sum(rows, "amount"))]]),
  columns: () => [
    { key: "id", label: "수금번호", cls: "code", width: 124 },
    { key: "paid_at", label: "수금일", width: 96, cls: "code" },
    { key: "sales_order_id", label: "매출번호", cls: "code", width: 128 },
    { key: "customer", label: "거래처", width: 140, cls: "strong" },
    { key: "project_name", label: "공사", width: 180 },
    { key: "amount", label: "수금액", align: "num", width: 126, sum: true, cell: (r) => fmt.won(r.amount), sumFormat: fmt.won },
    { key: "method", label: "수금방법", width: 90 },
    { key: "note", label: "비고", cls: "wrap" },
  ],
  footer: true,
  empty: { title: "수금 내역이 없습니다" },
});

const salStatus = panelScreen({
  crumb: "영업관리 > 매출현황", title: "매출 · 수금 현황",
  async render() {
    const [reports, orders] = await Promise.all([api("/api/reports"), api("/api/sales-orders")]);
    const overdue = orders.filter((order) => order.outstanding > 0 && order.due_date && order.due_date < today());
    return [
      h("div.kpis", {},
        kpi("총 매출", fmt.wonShort(sum(orders, "amount")), `${orders.length}건`, true),
        kpi("수금 완료", fmt.wonShort(sum(orders, "received")), `${orders.filter((o) => o.status === "수금완료").length}건`),
        kpi("미수금", fmt.wonShort(sum(orders, "outstanding")), `${orders.filter((o) => o.outstanding > 0).length}건`),
        kpi("수금 기한 초과", fmt.wonShort(sum(overdue, "outstanding")), `${overdue.length}건`, false, overdue.length > 0)),
      h("div.cols2", {},
        panel("월별 매출", grid({
          rows: reports.salesByMonth,
          columns: [
            { key: "label", label: "월", width: 90, cls: "code" },
            { key: "count", label: "건수", align: "num", width: 70 },
            { key: "amount", label: "매출", align: "num", cell: (r) => fmt.won(r.amount) },
            { key: "received", label: "수금", align: "num", cell: (r) => fmt.won(r.received) },
            { key: "_out", label: "미수", align: "num", sortValue: (r) => r.amount - r.received, cell: (r) => fmt.won(r.amount - r.received) },
          ],
        })),
        panel("공사별 매출 순위", rank(reports.projectMargin.filter((row) => row.sales > 0), "sales"))),
      panel(`수금 기한 초과 ${overdue.length}건`,
        overdue.length ? grid({
          rows: overdue,
          columns: [
            { key: "due_date", label: "수금예정", width: 136, cell: (r) => dueCell(r.due_date) },
            { key: "id", label: "매출번호", cls: "code", width: 128 },
            { key: "customer", label: "거래처", width: 140 },
            { key: "project_name", label: "공사" },
            { key: "outstanding", label: "미수금", align: "num", width: 124, cell: (r) => `<b>${fmt.won(r.outstanding)}</b>` },
          ],
        }) : h("p.muted", { text: "기한이 지난 미수금이 없습니다." })),
    ];
  },
});

/* ==========================================================================
   공사
   ========================================================================== */

const prjCost = dataScreen({
  crumb: "공사관리 > 공사별 원가", title: "공사별 원가 · 수익",
  exportName: "공사별원가",
  load: async () => (await api("/api/reports")).projectMargin.map((row) => ({ ...row, margin: row.sales - row.cost, rate: row.sales ? ((row.sales - row.cost) / row.sales) * 100 : 0 })),
  summary: (rows) => strip([
    ["총 매출", fmt.won(sum(rows, "sales"))],
    ["총 자재비", fmt.won(sum(rows, "cost"))],
    ["총 이익", fmt.won(sum(rows, "margin"))],
    ["평균 이익률", `${rows.length ? (sum(rows, "rate") / rows.length).toFixed(1) : 0}%`],
  ]),
  columns: () => [
    { key: "id", label: "공사코드", cls: "code", width: 122 },
    { key: "label", label: "공사명", cls: "strong" },
    { key: "cost", label: "자재비(발주)", align: "num", width: 130, sum: true, cell: (r) => fmt.won(r.cost), sumFormat: fmt.won },
    { key: "sales", label: "매출", align: "num", width: 130, sum: true, cell: (r) => fmt.won(r.sales), sumFormat: fmt.won },
    { key: "margin", label: "이익", align: "num", width: 130, sum: true, cell: (r) => `<b style="color:${r.margin < 0 ? "var(--danger)" : "inherit"}">${fmt.won(r.margin)}</b>`, sumFormat: fmt.won },
    { key: "rate", label: "이익률", align: "num", width: 84, cell: (r) => `${r.rate.toFixed(1)}%` },
    { key: "status", label: "상태", width: 84, cell: (r) => statusChip(r.status) },
  ],
  footer: true,
});

/** 작업별 영수증 — 좌측 공사 목록 + 우측 인쇄용 용지 */
function prjReceipt() {
  const state = { projectId: null };
  const side = h("div.receipt-side");
  const paper = h("div.paper");
  const scroll = h("div.receipt-scroll", {}, paper);

  async function refresh() {
    const [projects, requests] = await Promise.all([api("/api/projects"), api("/api/purchase-requests")]);
    const counts = new Map();
    requests.forEach((row) => counts.set(row.project_id, (counts.get(row.project_id) || 0) + 1));
    if (!state.projectId) {
      state.projectId = projects.find((project) => counts.get(project.id))?.id || projects[0]?.id || null;
    }

    side.replaceChildren(
      h("div.hd", { text: `작업 선택 (${projects.length})` }),
      ...projects.map((project) => h(`button.prj-btn${state.projectId === project.id ? ".on" : ""}`, {
        onclick: () => { state.projectId = project.id; refresh(); },
      },
        h("b", { text: project.name }),
        h("span", { text: `${project.id} · ${project.manager || "-"}` }),
        h("small", { text: `구매요청 ${counts.get(project.id) || 0}건` }))));

    if (!state.projectId) {
      paper.replaceChildren(h("p.muted", { text: "등록된 공사가 없습니다." }));
      return;
    }
    renderPaper(await api(`/api/receipts/${encodeURIComponent(state.projectId)}`));
  }

  function renderPaper(data) {
    const { project, items, orders, issues, summary } = data;
    paper.innerHTML = `
      <div class="paper-top">
        <div><h2>자 재 영 수 증</h2><div class="muted" style="font-size:11px;margin-top:4px">재고관리시스템 · 내부 원가관리 자료</div></div>
        <div class="meta">${esc(project.id)}<br>발행일 ${today()}</div>
      </div>
      <div class="paper-meta">
        <div><span>공사명</span><b>${esc(project.name)}</b></div>
        <div><span>현장</span><b>${esc(project.site || "-")}</b></div>
        <div><span>담당자</span><b>${esc(project.manager || "-")}</b></div>
        <div><span>발주처</span><b>${esc(project.customer || "-")}</b></div>
      </div>
      ${items.length ? `
        <table>
          <thead><tr>
            <th style="width:32%">구매번호 · 품목</th><th>사용 목적</th>
            <th style="width:82px">상태</th><th style="width:70px" class="num">수량</th><th style="width:110px" class="num">금액</th>
          </tr></thead>
          <tbody>${items.map((item) => `<tr>
            <td><b>${esc(item.product_name || "삭제된 품목")}</b><small>${esc(item.id)}</small></td>
            <td>${esc(item.purpose || "")}<small>희망납기 ${esc(item.requested_date || "미정")}</small></td>
            <td>${statusChip(item.status)}</td>
            <td class="num">${fmt.int(item.quantity)}${esc(item.unit ? ` ${item.unit}` : "")}</td>
            <td class="num"><b>${fmt.won(item.total)}</b></td>
          </tr>`).join("")}</tbody>
        </table>
        <div class="paper-total">
          <div><span>자재비 소계</span><b>${fmt.won(summary.supplyTotal)}</b></div>
          <div><span>발주 확정액</span><b>${fmt.won(summary.orderTotal)}</b></div>
          <div class="big"><span>합계</span><b>${fmt.won(summary.grandTotal)}</b></div>
        </div>`
      : `<p class="muted" style="padding:36px 0;text-align:center">이 공사에 등록된 구매내역이 없습니다.</p>`}
      ${issues.length ? `
        <h3 style="font-size:12.5px;margin:26px 0 8px">현장 출고 내역</h3>
        <table>
          <thead><tr><th style="width:120px">일시</th><th>품목</th><th style="width:130px">창고</th><th style="width:80px" class="num">수량</th></tr></thead>
          <tbody>${issues.map((issue) => `<tr>
            <td>${esc(issue.at)}</td><td>${esc(issue.product_name)}</td>
            <td>${esc(issue.warehouse_name)}</td><td class="num">${fmt.int(Math.abs(issue.qty))}</td>
          </tr>`).join("")}</tbody>
        </table>` : ""}
      <div class="paper-note">
        이 영수증은 해당 공사에 지정된 구매요청·발주·출고 내역을 자동 집계한 내부 원가관리 자료입니다.
        세금계산서 및 거래명세서와는 별도이며, 발주 ${orders.length}건 기준으로 산출되었습니다.
      </div>`;
  }

  const el = h("div.screen", {},
    h("div.screen-head", {},
      h("div", {}, h("div.crumb", { text: "공사관리 > 작업별 영수증" }), h("h1", { text: "작업별 자재 영수증" })),
      h("div.head-actions", {},
        btn("인쇄", () => window.print(), "primary"),
        btn("새로고침", () => refresh()))),
    h("div"),
    h("div.screen-body", {}, h("div.receipt-layout", {}, side, scroll)));

  return { el, refresh };
}

/* ==========================================================================
   회계
   ========================================================================== */

const accLedger = dataScreen({
  crumb: "회계관리 > 전표조회", title: "전표 조회",
  initialState: { from: monthStart(), to: monthEnd(), type: "", projectId: "" },
  exportName: "전표",
  actions: (state, refresh) => ref.can("accounting") ? [btn("＋ 전표 입력", () => entryDialog(null, refresh), "primary")] : [],
  filters: (state, refresh) => [
    dateRange(state, refresh),
    fld("유형", select(state, "type", ["매입", "매출", "경비", "수금", "지급"].map((value) => ({ value, label: value })), { width: 110, onChange: refresh })),
    fld("공사", select(state, "projectId", ref.projectOpts, { width: 200, onChange: refresh })),
  ],
  load: async (state) => (await api("/api/accounting-entries")).filter((row) =>
    (!state.from || row.date >= state.from) && (!state.to || row.date <= state.to)
    && (!state.type || row.type === state.type) && (!state.projectId || row.project_id === state.projectId)),
  summary: (rows) => strip([
    ["차변 합계", fmt.won(sum(rows, "debit"))],
    ["대변 합계", fmt.won(sum(rows, "credit"))],
    ["차액", fmt.won(sum(rows, "debit") - sum(rows, "credit"))],
    ["전표 수", `${rows.length}`],
  ]),
  columns: () => [
    { key: "id", label: "전표번호", cls: "code", width: 128 },
    { key: "date", label: "일자", width: 94, cls: "code" },
    { key: "type", label: "유형", width: 68, cell: (r) => statusChip(r.type, "mid") },
    { key: "account", label: "계정과목", width: 116 },
    { key: "counterparty", label: "거래처", width: 130 },
    { key: "description", label: "적요", cls: "wrap" },
    { key: "project_name", label: "공사", width: 170 },
    { key: "debit", label: "차변", align: "num", width: 120, sum: true, cell: (r) => (r.debit ? fmt.won(r.debit) : "-"), sumFormat: fmt.won },
    { key: "credit", label: "대변", align: "num", width: 120, sum: true, cell: (r) => (r.credit ? fmt.won(r.credit) : "-"), sumFormat: fmt.won },
    { key: "status", label: "상태", width: 70, cell: (r) => statusChip(r.status) },
    {
      key: "_actions", label: "업무", width: 118, sortable: false, noExport: true,
      cell: () => (ref.can("accounting") ? acts(act("수정"), act("삭제", "danger")) : ""),
    },
  ],
  footer: true,
  rowActions: (refresh) => ({
    수정: (row) => entryDialog(row, refresh),
    삭제: async (row) => {
      if (!await confirmAsk({ title: "전표 삭제", danger: true, okLabel: "삭제", message: `${row.id} 전표를 삭제합니다.` })) return;
      await guard(() => api(`/api/accounting-entries/${encodeURIComponent(row.id)}`, { method: "DELETE" }), "전표를 삭제했습니다.");
      refresh();
    },
  }),
});

function entryDialog(row, refresh) {
  const fields = [
    { key: "date", label: "일자", type: "date", required: true, value: row?.date || today() },
    { key: "type", label: "유형", type: "select", required: true, placeholder: false, value: row?.type || "매입", options: ["매입", "매출", "경비", "수금", "지급"].map((value) => ({ value, label: value })) },
    { key: "account", label: "계정과목", value: row?.account || "", placeholder: "예: 공사재료비" },
    { key: "counterparty", label: "거래처", value: row?.counterparty || "" },
    { key: "projectId", label: "공사", type: "select", options: ref.projectOpts, value: row?.project_id || "" },
    { key: "debit", label: "차변", type: "won", value: row?.debit || 0, unit: "원" },
    { key: "credit", label: "대변", type: "won", value: row?.credit || 0, unit: "원" },
    { key: "status", label: "상태", type: "select", placeholder: false, value: row?.status || "검토", options: ["검토", "승인"].map((value) => ({ value, label: value })) },
    { key: "description", label: "적요", type: "textarea", full: true, value: row?.description || "" },
  ];
  return openForm({
    title: row ? "전표 수정" : "전표 입력", sub: row?.id, width: "wide", fields,
    values: Object.fromEntries(fields.map((field) => [field.key, field.value])),
    submitLabel: row ? "수정" : "등록",
    onSubmit: (values) => (row
      ? api(`/api/accounting-entries/${encodeURIComponent(row.id)}`, { method: "PUT", body: values })
      : api("/api/accounting-entries", { method: "POST", body: { ...values, createdAt: new Date().toISOString() } })),
  }).then((result) => { if (result) { toast(row ? "전표를 수정했습니다." : "전표를 등록했습니다."); refresh(); } });
}

const accFund = panelScreen({
  crumb: "회계관리 > 자금현황", title: "자금 현황",
  async render() {
    const [summary, sales, orders, entries] = await Promise.all([
      api("/api/summary"), api("/api/sales-orders"), api("/api/purchase-orders"), api("/api/accounting-entries"),
    ]);
    const payables = orders.filter((order) => order.status !== "입고완료" && order.status !== "취소");
    const receivables = sales.filter((order) => order.outstanding > 0);
    return [
      h("div.kpis", {},
        kpi("이번 달 매출", fmt.wonShort(summary.monthSales), "세금계산서 기준", true),
        kpi("이번 달 매입·경비", fmt.wonShort(summary.monthPurchase), "전표 차변 기준"),
        kpi("미수금", fmt.wonShort(summary.receivable), `${receivables.length}건`),
        kpi("미지급금", fmt.wonShort(summary.payable), `${payables.length}건`)),
      h("div.cols2", {},
        panel(`미수금 ${receivables.length}건`, grid({
          rows: receivables,
          columns: [
            { key: "customer", label: "거래처", width: 130, cls: "strong" },
            { key: "id", label: "매출번호", cls: "code", width: 126 },
            { key: "outstanding", label: "미수금", align: "num", cell: (r) => fmt.won(r.outstanding) },
            { key: "due_date", label: "수금예정", width: 132, cell: (r) => dueCell(r.due_date) },
          ],
          empty: { title: "미수금이 없습니다" },
        })),
        panel(`미지급금 ${payables.length}건`, grid({
          rows: payables,
          columns: [
            { key: "supplier_name", label: "공급처", width: 130, cls: "strong" },
            { key: "id", label: "발주번호", cls: "code", width: 126 },
            { key: "amount", label: "발주금액", align: "num", cell: (r) => fmt.won(r.amount) },
            { key: "due_date", label: "납기", width: 132, cell: (r) => dueCell(r.due_date) },
          ],
          empty: { title: "미지급금이 없습니다" },
        }))),
      panel("계정과목별 집계", rank(
        Object.entries(entries.reduce((acc, entry) => {
          const key = entry.account || "미지정";
          acc[key] = (acc[key] || 0) + entry.debit + entry.credit;
          return acc;
        }, {})).map(([label, amount]) => ({ label, amount })).sort((a, b) => b.amount - a.amount))),
    ];
  },
});

/* ==========================================================================
   입찰 (나라장터)
   ========================================================================== */

const KIND_ALL = ["공사", "물품", "용역", "외자"];

const bidFilters = (state, refresh) => [
  dateRange(state, refresh),
  fld("기준", select(state, "dateField", [
    { value: "notice_date", label: "공고일" }, { value: "close_date", label: "마감일" },
  ], { all: false, width: 100, onChange: refresh })),
  fld("업무구분", h("div.chipset", {}, KIND_ALL.map((kind) =>
    h(`button.chip${state.kinds.includes(kind) ? ".on" : ""}`, {
      onclick: (event) => {
        state.kinds = state.kinds.includes(kind) ? state.kinds.filter((item) => item !== kind) : [...state.kinds, kind];
        event.target.classList.toggle("on");
        refresh();
      },
    }, kind)))),
  fld("검색어", input(state, "q", { width: 190, placeholder: "공고명·기관명", onEnter: refresh })),
  fld("지역", input(state, "region", { width: 110, placeholder: "예: 세종", onEnter: refresh })),
];

const bidQueryString = (state) => new URLSearchParams({
  from: state.from, to: state.to, dateField: state.dateField,
  kinds: state.kinds.join(","), q: state.q || "", region: state.region || "",
  ...(state.starred ? { starred: "1" } : {}),
}).toString();

/** 연동 상태 배너 — 샘플 모드인지 실데이터인지 항상 알려줍니다. */
function bidBanner(status, state, refresh) {
  if (status.live) {
    return h("div.notice-banner.info", {},
      h("b", {}, "나라장터 실시간 연동 중"),
      h("span", { text: ` · 최근 동기화 ${status.lastSyncAt ? fmt.dt(status.lastSyncAt) : "없음"}` }),
      ref.can("bids") ? h("button.btn.sm", {
        onclick: () => syncBids(state, refresh),
      }, "지금 동기화") : null);
  }
  return h("div.notice-banner", {},
    h("b", {}, "샘플 공고 표시 중"),
    h("span", { text: ` · ${status.reason || ""}` }),
    ref.can("bids") ? h("button.btn.sm", {
      onclick: () => openPanel({
        title: "나라장터 연동 설정 방법", width: "wide",
        content: h("div", { html: `
          <ol style="padding-left:18px;line-height:1.9;margin:0">
            <li><b>공공데이터포털</b>(data.go.kr)에서 <b>조달청_나라장터 입찰공고정보서비스</b> 활용신청</li>
            <li>발급받은 <b>일반 인증키(Decoding)</b>를 복사</li>
            <li>프로젝트 루트의 <code>.env</code> 파일에 <code>G2B_SERVICE_KEY=발급키</code> 추가</li>
            <li>서버를 재시작한 뒤, <b>설정 &gt; 연동설정</b>에서 '나라장터 입찰공고'를 <b>사용</b>으로 전환</li>
            <li>이 화면에서 <b>지금 동기화</b>를 누르면 실제 공고가 조회됩니다</li>
          </ol>
          <p class="muted" style="margin:14px 0 0;line-height:1.7">
            연동 전까지는 화면 동작 확인용 샘플 공고 12건이 표시됩니다.
            인증키는 서버 환경변수로만 읽으며 DB나 브라우저에 저장하지 않습니다.
          </p>` }),
      }),
    }, "연동 방법") : null);
}

async function syncBids(state, refresh) {
  const result = await guard(() => api("/api/bids/sync", {
    method: "POST",
    body: { from: state.from, to: state.to, kinds: state.kinds.length ? state.kinds : KIND_ALL },
  }));
  if (!result.live) toast(result.reason || "연동이 꺼져 있습니다.", "err");
  else if (result.errors?.length) toast(`${result.imported}건 반영 · 오류 ${result.errors.join(" / ")}`, "err");
  else toast(`나라장터에서 ${result.imported}건을 가져왔습니다.`);
  refresh();
}

/** 입찰 캘린더 — 월 달력 위에 공고를 뿌립니다. */
function bidCalendarScreen() {
  const state = {
    month: today().slice(0, 7), dateField: "close_date", kinds: [], q: "", region: "",
    from: "", to: "",
  };
  const body = h("div.screen-body");
  const filterHost = h("div.filterbar");
  const bannerHost = h("div");

  function monthBounds() {
    const [year, month] = state.month.split("-").map(Number);
    state.from = `${state.month}-01`;
    state.to = new Date(year, month, 0).toLocaleDateString("sv-SE");
  }

  function shiftMonth(delta) {
    const [year, month] = state.month.split("-").map(Number);
    const next = new Date(year, month - 1 + delta, 1);
    state.month = next.toLocaleDateString("sv-SE").slice(0, 7);
    refresh();
  }

  async function refresh() {
    monthBounds();
    const data = await api(`/api/bids/calendar?${bidQueryString(state)}`);
    bannerHost.replaceChildren(bidBanner(data.status, state, refresh));

    const byDate = new Map(data.days.map((day) => [day.date, day]));
    const [year, month] = state.month.split("-").map(Number);
    const first = new Date(year, month - 1, 1);
    const start = new Date(first);
    start.setDate(1 - first.getDay());

    const cells = [];
    for (let index = 0; index < 42; index += 1) {
      const date = new Date(start.getTime() + index * 86400000);
      const iso = date.toLocaleDateString("sv-SE");
      const day = byDate.get(iso);
      const outside = date.getMonth() !== month - 1;
      cells.push(h(`button.cal-cell${outside ? ".out" : ""}${iso === today() ? ".today" : ""}`, {
        onclick: () => day && openDay(iso, day),
      },
        h("div.d", {}, h("span", { text: String(date.getDate()) }), day ? h("em", { text: `${day.count}건` }) : null),
        ...(day?.items || []).slice(0, 3).map((item) =>
          h(`div.cal-item.k${item.kind}`, { title: item.title, text: item.title })),
        day && day.count > 3 ? h("div.cal-more", { text: `＋${day.count - 3}건 더` }) : null));
    }

    const total = data.days.reduce((acc, day) => acc + day.count, 0);
    body.replaceChildren(
      h("div", { style: { display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px" } },
        btn("‹ 이전달", () => shiftMonth(-1)),
        h("h2", { style: { margin: "0", fontSize: "17px", minWidth: "116px", textAlign: "center" }, text: `${state.month.slice(0, 4)}년 ${state.month.slice(5)}월` }),
        btn("다음달 ›", () => shiftMonth(1)),
        btn("이번달", () => { state.month = today().slice(0, 7); refresh(); }),
        h("div.grow"),
        h("span.muted", { text: `${state.dateField === "close_date" ? "마감일" : "공고일"} 기준 · 총 ${total}건` })),
      h("div.cal", {},
        h("div.cal-head", {}, ["일", "월", "화", "수", "목", "금", "토"].map((label) => h("div", { text: label }))),
        h("div.cal-grid", {}, cells)),
      h("div.cal-legend", {},
        h("span", { html: `<i style="background:var(--g-90)"></i>공사` }),
        h("span", { html: `<i style="background:var(--g-50)"></i>물품` }),
        h("span", { html: `<i style="background:var(--g-30)"></i>용역` }),
        h("span.muted", {}, "날짜를 클릭하면 그날의 공고 목록이 열립니다.")));
  }

  async function openDay(iso, day) {
    const data = await api(`/api/bids?${new URLSearchParams({
      from: iso, to: iso, dateField: state.dateField,
      kinds: state.kinds.join(","), q: state.q || "", region: state.region || "",
    })}`);
    const node = grid({ rows: data.notices, columns: bidColumns(), empty: { title: "공고가 없습니다" } });
    bindRowActions(node, data.notices, "id", bidRowActions(() => { refresh(); openDay(iso, day); }));
    openPanel({
      title: `${iso} 입찰공고`, sub: `${day.count}건 · 기초금액 합계 ${fmt.won(day.amount)}`, width: "xwide",
      content: node,
    });
  }

  filterHost.replaceChildren(
    fld("기준", select(state, "dateField", [
      { value: "close_date", label: "마감일" }, { value: "notice_date", label: "공고일" },
    ], { all: false, width: 100, onChange: refresh })),
    fld("업무구분", h("div.chipset", {}, KIND_ALL.map((kind) =>
      h("button.chip", {
        onclick: (event) => {
          state.kinds = state.kinds.includes(kind) ? state.kinds.filter((item) => item !== kind) : [...state.kinds, kind];
          event.target.classList.toggle("on");
          refresh();
        },
      }, kind)))),
    fld("검색어", input(state, "q", { width: 180, placeholder: "공고명·기관명", onEnter: refresh })),
    fld("지역", input(state, "region", { width: 110, onEnter: refresh })),
    h("div.filter-actions", {},
      ref.can("bids") ? btn("나라장터 동기화", () => syncBids(state, refresh)) : null,
      btn("조회", refresh, "primary")));

  const el = h("div.screen.scroll", {},
    h("div.screen-head", {},
      h("div", {}, h("div.crumb", { text: "입찰정보 > 입찰 캘린더" }), h("h1", { text: "나라장터 입찰 캘린더" }))),
    h("div", {}, filterHost, bannerHost),
    body);

  return { el, refresh };
}

const bidColumns = () => [
  {
    key: "starred", label: "관심", width: 48, sortable: false, noExport: true,
    cell: (r) => (ref.can("bids") ? `<button class="btn sm ${r.starred ? "primary" : ""}" data-act="관심">${r.starred ? "★" : "☆"}</button>` : (r.starred ? "★" : "")),
  },
  { key: "kind", label: "구분", width: 54, cell: (r) => statusChip(r.kind, "mid") },
  { key: "notice_date", label: "공고일", width: 112, cls: "code", cell: (r) => esc(fmt.dt(r.notice_date)) },
  { key: "close_date", label: "마감일시", width: 150, cell: (r) => dueCell(fmt.date(r.close_date)) },
  { key: "title", label: "공고명", cls: "wrap strong" },
  { key: "notice_inst", label: "공고기관", width: 140 },
  { key: "demand_inst", label: "수요기관", width: 140 },
  { key: "base_amount", label: "기초금액", align: "num", width: 128, sum: true, cell: (r) => fmt.won(r.base_amount), sumFormat: fmt.won },
  { key: "region", label: "참가지역", width: 110 },
  { key: "contract_method", label: "계약방법", width: 116 },
  { key: "bid_no", label: "공고번호", width: 120, cls: "code" },
  {
    key: "_actions", label: "업무", width: 118, sortable: false, noExport: true,
    cell: () => acts(act("상세"), act("원문")),
  },
];

const bidRowActions = (refresh) => ({
  관심: async (row) => {
    await guard(() => api(`/api/bids/${encodeURIComponent(row.id)}/star`, { method: "PUT", body: { starred: !row.starred } }));
    refresh();
  },
  원문: (row) => window.open(row.url || "https://www.g2b.go.kr/", "_blank", "noopener"),
  상세: (row) => openPanel({
    title: row.title, sub: `${row.kind} · ${row.bid_no}-${row.bid_ord}`, width: "wide",
    content: h("div", {},
      h("dl.form", {}, [
        ["공고기관", row.notice_inst], ["수요기관", row.demand_inst],
        ["공고일시", fmt.dt(row.notice_date)], ["입찰마감", fmt.dt(row.close_date)], ["개찰일시", fmt.dt(row.open_date)],
        ["기초금액", fmt.won(row.base_amount)], ["배정예산", fmt.won(row.budget_amount)],
        ["참가지역", row.region], ["계약방법", row.contract_method],
        ["데이터출처", row.source === "g2b" ? "나라장터 오픈API" : "샘플 데이터"],
        ["수집시각", fmt.dt(row.fetched_at)],
      ].flatMap(([label, value]) => [h("dt", { text: label }), h("dd", {}, h("span", { text: value || "-" }))])),
      h("div", { style: { marginTop: "12px" } },
        h("label", { style: { fontSize: "11px", fontWeight: "600", display: "block", marginBottom: "4px" }, text: "검토 메모" }),
        (() => {
          const area = h("textarea", { rows: 3, style: { width: "100%", padding: "6px 8px", border: "1px solid var(--line-strong)", borderRadius: "3px" } });
          area.value = row.memo || "";
          area.id = "bidMemo";
          return area;
        })())),
    actions: ref.can("bids") ? [
      h("button.btn", { onclick: () => window.open(row.url || "https://www.g2b.go.kr/", "_blank", "noopener") }, "나라장터 원문"),
      h("button.btn.primary", {
        onclick: async () => {
          await guard(() => api(`/api/bids/${encodeURIComponent(row.id)}/memo`, { method: "PUT", body: { memo: $("#bidMemo").value } }), "메모를 저장했습니다.");
          refresh();
        },
      }, "메모 저장"),
    ] : [],
  }),
});

const bidList = dataScreen({
  crumb: "입찰정보 > 입찰공고 조회", title: "나라장터 입찰공고",
  initialState: { from: monthStart(), to: monthEnd(), dateField: "notice_date", kinds: [], q: "", region: "" },
  exportName: "입찰공고",
  filters: bidFilters,
  actions: (state, refresh) => ref.can("bids") ? [btn("나라장터 동기화", () => syncBids(state, refresh))] : [],
  load: async (state) => {
    const data = await api(`/api/bids?${bidQueryString(state)}`);
    state._status = data.status;
    return data.notices;
  },
  summary: (rows, state, refresh) => [
    bidBanner(state._status || {}, state, refresh),
    strip([
      ["공고 건수", `${rows.length}`],
      ["기초금액 합계", fmt.won(sum(rows, "base_amount"))],
      ["관심공고", `${rows.filter((row) => row.starred).length}`],
      ["7일 내 마감", `${rows.filter((row) => row.close_date && row.close_date.slice(0, 10) <= addDays(today(), 7) && row.close_date.slice(0, 10) >= today()).length}`, "bad"],
    ]),
  ],
  columns: bidColumns,
  rowActions: bidRowActions,
  footer: true,
  empty: { title: "조회 기간에 공고가 없습니다", hint: "기간을 넓히거나 나라장터 동기화를 실행해 보세요." },
});

const bidStarred = dataScreen({
  crumb: "입찰정보 > 관심공고", title: "관심 입찰공고",
  initialState: { from: addDays(today(), -180), to: addDays(today(), 180), dateField: "notice_date", kinds: [], q: "", region: "", starred: true },
  exportName: "관심공고",
  load: async (state) => (await api(`/api/bids?${bidQueryString(state)}`)).notices,
  summary: (rows) => strip([
    ["관심공고", `${rows.length}`],
    ["기초금액 합계", fmt.won(sum(rows, "base_amount"))],
    ["마감 임박(7일)", `${rows.filter((row) => row.close_date && row.close_date.slice(0, 10) <= addDays(today(), 7) && row.close_date.slice(0, 10) >= today()).length}`, "bad"],
  ]),
  columns: (state, refresh) => [
    ...bidColumns(),
    { key: "memo", label: "검토메모", cls: "wrap" },
  ],
  rowActions: bidRowActions,
  footer: true,
  empty: { title: "관심공고가 없습니다", hint: "입찰공고 조회에서 ☆ 버튼을 눌러 관심공고로 등록하세요." },
});

/* ==========================================================================
   분석
   ========================================================================== */

const rptPurchase = panelScreen({
  crumb: "분석 > 구매분석", title: "구매 분석",
  async render() {
    const reports = await api("/api/reports");
    return [
      h("div.cols2", {},
        panel("공급처별 구매액", rank(reports.purchaseBySupplier)),
        panel("월별 구매액", grid({
          rows: reports.purchaseByMonth,
          columns: [
            { key: "label", label: "월", width: 100, cls: "code" },
            { key: "count", label: "발주 건수", align: "num", width: 90 },
            { key: "amount", label: "발주금액", align: "num", cell: (r) => fmt.won(r.amount) },
          ],
        }))),
      panel("공급처별 상세", grid({
        rows: reports.purchaseBySupplier,
        columns: [
          { key: "label", label: "공급처", cls: "strong" },
          { key: "count", label: "발주 건수", align: "num", width: 100, sum: true },
          { key: "amount", label: "구매금액", align: "num", width: 150, sum: true, cell: (r) => fmt.won(r.amount), sumFormat: fmt.won },
          {
            key: "_share", label: "비중", width: 160, sortable: false,
            cell: (r) => {
              const total = reports.purchaseBySupplier.reduce((t, row) => t + row.amount, 0) || 1;
              return `<div class="bar"><i style="width:${(r.amount / total) * 100}%"></i></div>`;
            },
          },
        ],
        footer: true,
      })),
    ];
  },
});

const rptInventory = panelScreen({
  crumb: "분석 > 재고분석", title: "재고 분석",
  async render() {
    const reports = await api("/api/reports");
    return [
      h("div.kpis", {},
        kpi("안전재고 미달", `${reports.lowStock.length}`, "품목", true, reports.lowStock.length > 0),
        kpi("장기 미사용(30일+)", `${reports.deadStock.length}`, "품목"),
        kpi("총 입고수량", fmt.int(reports.stockTurnover.reduce((t, r) => t + r.received, 0)), "누계"),
        kpi("총 출고수량", fmt.int(reports.stockTurnover.reduce((t, r) => t + r.issued, 0)), "누계")),
      h("div.cols2", {},
        panel(`안전재고 미달 ${reports.lowStock.length}건`, grid({
          rows: reports.lowStock,
          columns: [
            { key: "product_name", label: "품목", cls: "strong" },
            { key: "warehouse_name", label: "창고", width: 110 },
            { key: "available", label: "가용", align: "num", width: 66 },
            { key: "safety_stock", label: "안전", align: "num", width: 66 },
            { key: "_gap", label: "부족", align: "num", width: 66, sortValue: (r) => r.safety_stock - r.available, cell: (r) => `<b>${fmt.int(r.safety_stock - r.available)}</b>` },
          ],
          empty: { title: "미달 품목이 없습니다" },
        })),
        panel(`장기 미사용 재고 ${reports.deadStock.length}건`, grid({
          rows: reports.deadStock,
          columns: [
            { key: "product_name", label: "품목", cls: "strong" },
            { key: "warehouse_name", label: "창고", width: 110 },
            { key: "on_hand", label: "현재고", align: "num", width: 72 },
            { key: "_val", label: "금액", align: "num", width: 110, sortValue: (r) => r.on_hand * (r.price || 0), cell: (r) => fmt.won(r.on_hand * (r.price || 0)) },
            { key: "last_movement", label: "최종이동", width: 92, cls: "code" },
          ],
          empty: { title: "장기 미사용 재고가 없습니다" },
        }))),
      panel("품목별 수불 회전", grid({
        rows: reports.stockTurnover,
        columns: [
          { key: "id", label: "품목코드", cls: "code", width: 140 },
          { key: "label", label: "품목명", cls: "strong" },
          { key: "on_hand", label: "현재고", align: "num", width: 84, sum: true },
          { key: "received", label: "누적입고", align: "num", width: 92, sum: true },
          { key: "issued", label: "누적출고", align: "num", width: 92, sum: true },
          { key: "_turn", label: "회전율", align: "num", width: 84, sortValue: (r) => (r.on_hand ? r.issued / r.on_hand : 0), cell: (r) => (r.on_hand ? (r.issued / r.on_hand).toFixed(2) : "-") },
        ],
        footer: true,
      })),
    ];
  },
});

/* ==========================================================================
   시스템
   ========================================================================== */

const sysUser = dataScreen({
  crumb: "시스템 > 사용자·권한", title: "사용자 · 권한 관리",
  exportName: "사용자",
  actions: (state, refresh) => [btn("＋ 사용자 추가", () => userDialog(null, refresh), "primary")],
  load: () => api("/api/admin/users"),
  summary: (rows) => strip([
    ["사용자", `${rows.length}`],
    ["사용중", `${rows.filter((r) => r.active).length}`],
    ["관리자", `${rows.filter((r) => r.role === "admin").length}`],
  ]),
  columns: () => [
    { key: "name", label: "이름", cls: "strong", width: 110 },
    { key: "email", label: "이메일", width: 230 },
    { key: "role", label: "역할", width: 110, cell: (r) => statusChip(ROLE_NAME[r.role] || r.role, r.role === "admin" ? "solid" : "mid") },
    { key: "_perm", label: "접근 권한", sortable: false, cell: (r) => esc(ROLE_DESC[r.role] || "") },
    { key: "active", label: "상태", width: 70, cell: (r) => statusChip(r.active ? "사용" : "중지", r.active ? "" : "bad") },
    { key: "createdAt", label: "등록일", width: 100, cls: "code", cell: (r) => fmt.date(r.createdAt) },
    { key: "_actions", label: "업무", width: 118, sortable: false, noExport: true, cell: () => acts(act("수정")) },
  ],
  rowActions: (refresh) => ({ 수정: (row) => userDialog(row, refresh) }),
});

const ROLE_NAME = { admin: "관리자", purchasing: "구매 담당", warehouse: "창고 담당", viewer: "조회 전용" };
const ROLE_DESC = {
  admin: "전체 기능 · 사용자/연동 설정 · 회계 전표",
  purchasing: "품목·거래처·공사 등록, 구매요청/발주 승인, 매출·수금, 입찰 동기화",
  warehouse: "입고 처리, 재고이동·조정, 공사 자재배정·출고",
  viewer: "모든 화면 조회만 가능 (등록·수정 불가)",
};

function userDialog(row, refresh) {
  const roleOptions = Object.entries(ROLE_NAME).map(([value, label]) => ({ value, label }));
  return openForm({
    title: row ? "사용자 수정" : "사용자 추가", sub: row?.email, width: "wide",
    fields: row ? [
      { key: "name", label: "이름", required: true, value: row.name },
      { key: "role", label: "역할", type: "select", placeholder: false, options: roleOptions, value: row.role },
      { key: "active", label: "사용여부", type: "checkbox", value: row.active },
      { key: "password", label: "비밀번호 초기화", type: "password", hint: "입력한 경우에만 변경됩니다 (10자 이상)" },
    ] : [
      { key: "name", label: "이름", required: true },
      { key: "email", label: "이메일", type: "email", required: true },
      { key: "role", label: "역할", type: "select", required: true, placeholder: false, options: roleOptions, value: "purchasing" },
      { key: "password", label: "임시 비밀번호", type: "password", required: true, hint: "10자 이상 · 안전한 경로로 전달하세요" },
    ],
    values: row ? { name: row.name, role: row.role, active: row.active } : { role: "purchasing" },
    submitLabel: row ? "수정" : "생성",
    footNote: Object.entries(ROLE_DESC).map(([key, desc]) => `${ROLE_NAME[key]}: ${desc}`).join("\n"),
    onSubmit: (values) => {
      const body = { ...values };
      if (row && !body.password) delete body.password;
      return row
        ? api(`/api/admin/users/${encodeURIComponent(row.id)}`, { method: "PUT", body })
        : api("/api/admin/users", { method: "POST", body });
    },
  }).then((result) => { if (result) { toast(row ? "사용자를 수정했습니다." : "사용자를 생성했습니다."); refresh(); } });
}

const sysConnector = panelScreen({
  crumb: "시스템 > 연동설정", title: "외부 데이터 연동",
  async render(state, refresh) {
    const connectors = await api("/api/admin/connectors");
    const note = h("p.muted", { style: { margin: "0 0 14px", lineHeight: "1.7" },
      text: "공식 API와 계약 공급처 데이터만 사용합니다. 인증키는 서버 환경변수로만 읽으며 DB·브라우저에 저장하지 않습니다. "
        + "'연결 확인'은 설정값의 유무만 검사합니다." });
    return [note, ...connectors.map((connector) => connectorCard(connector, refresh))];
  },
});

/** 연동 소스 한 장. 저장은 필드를 벗어날 때(change) 즉시 반영됩니다. */
function connectorCard(connector, refresh) {
  const save = (body, message) => guard(
    () => api(`/api/admin/connectors/${encodeURIComponent(connector.id)}`, { method: "PUT", body }),
    message,
  ).then(refresh);

  const toggle = h("input", { type: "checkbox", style: { width: "16px", height: "16px" } });
  toggle.checked = Boolean(connector.enabled);
  toggle.addEventListener("change", () =>
    save({ enabled: toggle.checked }, toggle.checked ? "연동을 사용합니다." : "연동을 중지했습니다."));

  const baseUrl = h("input", { value: connector.base_url || "", placeholder: "https://apis.data.go.kr/..." });
  baseUrl.addEventListener("change", () => save({ baseUrl: baseUrl.value }, "API 주소를 저장했습니다."));

  const rows = [
    ["사용여부", toggle, h("span.hint", { text: connector.status || "" })],
    ["API 주소", baseUrl],
    ["인증 환경변수",
      h("input", { value: connector.secret_env || "불필요", readonly: true }),
      h(`span.st${connector.secretConfigured ? ".solid" : ".bad"}`, { text: connector.secretConfigured ? "확인됨" : "미설정" })],
    ["최근 동기화", h("input", { value: connector.last_sync_at ? fmt.dt(connector.last_sync_at) : "없음", readonly: true })],
  ];

  return h("div.panel", {},
    h("div.panel-head", {},
      h("h3", { text: connector.name }),
      h(`span.st${connector.enabled ? ".solid" : ""}`, { text: connector.enabled ? "사용 중" : "사용 안 함" }),
      h("div.grow"),
      h("button.btn", { onclick: () => testConnector(connector, refresh) }, "연결 확인")),
    h("div.panel-body", {},
      h("p.muted", { style: { margin: "0 0 10px" }, text: connector.purpose || "" }),
      h("dl.form", {}, rows.flatMap(([label, ...controls]) => [
        h("dt", { text: label }),
        h("dd", {}, ...controls),
      ]))));
}

async function testConnector(connector, refresh) {
  try {
    const result = await api(`/api/admin/connectors/${encodeURIComponent(connector.id)}/test`, { method: "POST", body: {} });
    toast(`설정 확인 완료 · ${fmt.dt(result.checkedAt)}`);
  } catch (error) {
    toast(error.message, "err");
  }
  refresh();
}

const sysCompany = panelScreen({
  crumb: "시스템 > 회사정보", title: "회사 정보",
  async render(state, refresh) {
    const organization = await api("/api/admin/organization");
    const fields = [
      ["name", "회사명"], ["businessNumber", "사업자등록번호"], ["ceo", "대표자"],
      ["address", "주소"], ["phone", "대표전화"],
    ];
    const inputs = new Map();
    return h("div.panel", { style: { maxWidth: "620px" } },
      h("div.panel-head", {}, h("h3", { text: "사업자 정보" })),
      h("div.panel-body", {},
        h("dl.form", {}, fields.flatMap(([key, label]) => {
          const node = h("input", { value: organization[key] || "" });
          inputs.set(key, node);
          return [h("dt", { text: label }), h("dd", {}, node)];
        })),
        h("div", { style: { marginTop: "12px", textAlign: "right" } },
          btn("저장", async () => {
            const body = Object.fromEntries([...inputs].map(([key, node]) => [key, node.value]));
            await guard(() => api("/api/admin/organization", { method: "PUT", body }), "회사 정보를 저장했습니다.");
            $("#orgName").textContent = body.name || "ERP";
            refresh();
          }, "primary"))));
  },
});

const sysAudit = dataScreen({
  crumb: "시스템 > 변경이력", title: "변경 이력 (Audit Log)",
  initialState: { module: "", q: "" },
  exportName: "변경이력",
  filters: (state, refresh) => [
    fld("업무", select(state, "module", ["구매", "입고", "재고", "영업", "회계", "승인", "입찰", "기준정보", "공사", "시스템"].map((value) => ({ value, label: value })), { onChange: refresh })),
    fld("검색어", input(state, "q", { width: 200, placeholder: "사용자·내용", onEnter: refresh })),
  ],
  load: async (state) => (await api("/api/audit-logs")).filter((row) =>
    (!state.module || row.module === state.module)
    && (!state.q || [row.user, row.action, row.detail].join(" ").toLowerCase().includes(state.q.toLowerCase()))),
  summary: (rows) => strip([["기록", `${rows.length}`]]),
  columns: () => [
    { key: "at", label: "일시", width: 128, cls: "code" },
    { key: "user", label: "사용자", width: 96 },
    { key: "module", label: "업무", width: 80, cell: (r) => statusChip(r.module, "mid") },
    { key: "action", label: "처리내용", width: 170 },
    { key: "detail", label: "상세", cls: "wrap" },
  ],
  empty: { title: "변경 이력이 없습니다" },
});

const sysPassword = panelScreen({
  crumb: "시스템 > 비밀번호", title: "비밀번호 변경",
  actions: () => [],
  async render() {
    const current = h("input", { type: "password", autocomplete: "current-password" });
    const next = h("input", { type: "password", autocomplete: "new-password" });
    const again = h("input", { type: "password", autocomplete: "new-password" });
    return h("div.panel", { style: { maxWidth: "460px" } },
      h("div.panel-head", {}, h("h3", { text: `${ref.me?.name || ""} 계정` })),
      h("div.panel-body", {},
        h("dl.form", {},
          h("dt", {}, "현재 비밀번호"), h("dd", {}, current),
          h("dt", {}, "새 비밀번호"), h("dd", {}, next, h("span.hint", {}, "10자 이상")),
          h("dt", {}, "새 비밀번호 확인"), h("dd", {}, again)),
        h("div", { style: { marginTop: "12px", textAlign: "right" } },
          btn("변경", async () => {
            if (next.value !== again.value) return toast("새 비밀번호가 서로 다릅니다.", "err");
            if (next.value.length < 10) return toast("새 비밀번호는 10자 이상이어야 합니다.", "err");
            await guard(() => api("/api/auth/password", { method: "POST", body: { current: current.value, next: next.value } }), "비밀번호를 변경했습니다.");
            current.value = next.value = again.value = "";
          }, "primary"))));
  },
});

/* ==========================================================================
   메뉴 구조 + 화면 레지스트리
   ========================================================================== */


/* ---------- 팀 공유 일정 달력 ---------------------------------------------- */

const SCHEDULE_KINDS = [
  { value: "work", label: "작업" },
  { value: "leave", label: "휴가" },
  { value: "etc", label: "기타" },
];

/** 달력에 겹쳐 그리는 줄의 종류. 색은 styles.css 의 .bar-* 가 가집니다. */
const CAL_LAYERS = [
  { key: "work", label: "작업" },
  { key: "leave", label: "휴가" },
  { key: "etc", label: "기타" },
  { key: "project", label: "공사 기간" },
  { key: "bid", label: "입찰 마감", adminOnly: true },
];

const MAX_LANES = 4;          // 한 주에 겹쳐 보여 줄 줄 수. 넘치면 ＋N 으로 접습니다.

/** 월 달력은 항상 6주 × 7일입니다. 앞뒤로 이웃 달이 물려 들어옵니다. */
function monthWeeks(month) {
  const [year, monthNo] = month.split("-").map(Number);
  const first = new Date(year, monthNo - 1, 1);
  const cursor = new Date(year, monthNo - 1, 1 - first.getDay());
  const weeks = [];
  for (let week = 0; week < 6; week += 1) {
    const days = [];
    for (let index = 0; index < 7; index += 1) {
      days.push({
        iso: cursor.toLocaleDateString("sv-SE"),
        day: cursor.getDate(),
        outside: cursor.getMonth() !== monthNo - 1,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(days);
  }
  return weeks;
}

/**
 * 한 주 안에서 줄이 서로 겹치지 않게 칸(lane)을 배정합니다.
 * 긴 일정부터 위로 올려야 달력이 눈에 잘 들어옵니다.
 */
function layoutWeek(days, events) {
  const weekStart = days[0].iso;
  const weekEnd = days[6].iso;
  const lanes = [];
  const bars = [];
  const hidden = new Map();

  const inWeek = events
    .filter((event) => event.end >= weekStart && event.start <= weekEnd)
    .sort((a, b) => {
      if (a.start !== b.start) return a.start < b.start ? -1 : 1;
      if (a.end !== b.end) return a.end > b.end ? -1 : 1;
      return 0;
    });

  for (const event of inWeek) {
    const from = event.start <= weekStart ? 0 : days.findIndex((day) => day.iso === event.start);
    const to = event.end >= weekEnd ? 6 : days.findIndex((day) => day.iso === event.end);

    let lane = lanes.findIndex((slots) => slots.every((slot) => slot.to < from || slot.from > to));
    if (lane === -1) { lanes.push([]); lane = lanes.length - 1; }

    if (lane >= MAX_LANES) {
      // 자리에 못 들어간 것은 날짜별 ＋N 으로만 알립니다.
      for (let index = from; index <= to; index += 1) {
        hidden.set(days[index].iso, (hidden.get(days[index].iso) || 0) + 1);
      }
      continue;
    }
    lanes[lane].push({ from, to });
    bars.push({ event, lane, from, to, opensLeft: event.start >= weekStart, closesRight: event.end <= weekEnd });
  }
  return { bars, hidden, lanes: Math.min(lanes.length, MAX_LANES) };
}

function teamCalendar() {
  const state = {
    month: today().slice(0, 7),
    selected: today(),
    show: Object.fromEntries(CAL_LAYERS.map((layer) => [layer.key, true])),
    data: null,
  };
  const body = h("div.screen-body");

  const bounds = () => {
    const weeks = monthWeeks(state.month);
    return { from: weeks[0][0].iso, to: weeks[5][6].iso, weeks };
  };

  function shiftMonth(delta) {
    const [year, month] = state.month.split("-").map(Number);
    state.month = new Date(year, month - 1 + delta, 1).toLocaleDateString("sv-SE").slice(0, 7);
    refresh();
  }

  const editable = () => ref.can("schedule");

  /* ---- 일정 등록·수정 ---- */

  function openScheduleForm(values = {}) {
    const editing = Boolean(values.id);
    return openForm({
      title: editing ? "일정 수정" : "새 일정",
      sub: editing ? values.title : "누구든 등록하고 서로 조정할 수 있습니다",
      width: "wide",
      fields: [
        { key: "kind", label: "구분", type: "select", placeholder: false,
          options: SCHEDULE_KINDS, value: values.kind || "work" },
        { key: "title", label: "제목", required: true, value: values.title || "", full: true,
          placeholder: "예: 3층 배관 작업 / 연차" },
        { key: "startDate", label: "시작일", type: "date", required: true,
          value: values.startDate || state.selected || today() },
        { key: "endDate", label: "종료일", type: "date",
          value: values.endDate || values.startDate || state.selected || today(),
          hint: "하루짜리면 시작일과 같게 둡니다" },
        { key: "allDay", label: "하루 종일", type: "checkbox",
          value: values.allDay === undefined ? true : values.allDay },
        { key: "startTime", label: "시작 시각", value: values.startTime || "", placeholder: "09:00" },
        { key: "endTime", label: "종료 시각", value: values.endTime || "", placeholder: "18:00" },
        { key: "assignees", label: "담당자", value: values.assignees || "", full: true,
          placeholder: "쉼표로 구분 — 김현우, 박지민" },
        { key: "projectId", label: "공사", type: "select", options: ref.projectOpts,
          value: values.projectId || "", placeholder: "연결 안 함" },
        { key: "location", label: "장소", value: values.location || "" },
        { key: "note", label: "메모", type: "textarea", value: values.note || "", full: true },
      ],
      submitLabel: editing ? "수정" : "등록",
      onSubmit: async (form) => {
        const payload = {
          kind: form.kind,
          title: form.title,
          startDate: form.startDate,
          endDate: form.endDate || form.startDate,
          allDay: Boolean(form.allDay),
          startTime: form.allDay ? "" : form.startTime,
          endTime: form.allDay ? "" : form.endTime,
          assignees: form.assignees,
          projectId: form.projectId,
          location: form.location,
          note: form.note,
        };
        const saved = editing
          ? await api(`/api/schedules/${encodeURIComponent(values.id)}`, { method: "PUT", body: payload })
          : await api("/api/schedules", { method: "POST", body: payload });
        toast(editing ? "일정을 수정했습니다." : "일정을 등록했습니다.");
        state.selected = saved.start_date;
        await refresh();
        return saved;
      },
    });
  }

  async function dropSchedule(row) {
    await guard(() => api(`/api/schedules/${encodeURIComponent(row.id)}`, { method: "DELETE" }),
      "일정을 삭제했습니다.");
    await refresh();
  }

  /** 일정 줄을 눌렀을 때 — 일정은 수정창, 공사·입찰은 해당 화면으로 보냅니다. */
  function openEvent(event) {
    if (event.type === "schedule") {
      if (!editable()) return toast("일정을 바꿀 권한이 없습니다.", "err");
      const row = event.row;
      return openScheduleForm({
        id: row.id, kind: row.kind, title: row.title,
        startDate: row.start_date, endDate: row.end_date, allDay: row.all_day,
        startTime: row.start_time || "", endTime: row.end_time || "",
        assignees: row.assignees || "", projectId: row.project_id || "",
        location: row.location || "", note: row.note || "",
      });
    }
    if (event.type === "project") return openScreen("base.project");
    if (event.type === "bid") return openScreen("bid.calendar");
    return undefined;
  }

  /* ---- 그리기 ---- */

  function buildEvents() {
    const data = state.data;
    const events = [];
    for (const row of data.schedules) {
      if (!state.show[row.kind]) continue;
      events.push({
        type: "schedule", layer: row.kind, row,
        start: row.start_date, end: row.end_date,
        title: row.all_day ? row.title : `${row.start_time || ""} ${row.title}`.trim(),
      });
    }
    if (state.show.project) {
      for (const row of data.projects) {
        events.push({
          type: "project", layer: "project", row,
          start: row.start_date, end: row.end_date || row.start_date,
          title: `${row.name}${row.site ? ` · ${row.site}` : ""}`,
        });
      }
    }
    if (state.show.bid) {
      for (const row of data.bids) {
        events.push({ type: "bid", layer: "bid", row, start: row.date, end: row.date, title: row.title });
      }
    }
    return events;
  }

  function layerLabel(key) {
    return CAL_LAYERS.find((layer) => layer.key === key)?.label || "";
  }

  function detailLine(event) {
    const parts = [];
    if (event.start !== event.end) parts.push(`${event.start} ~ ${event.end}`);
    if (event.type === "schedule") {
      const row = event.row;
      if (!row.all_day && row.start_time) {
        parts.push(`${row.start_time}${row.end_time ? `~${row.end_time}` : ""}`);
      }
      if (row.assignee_list.length) parts.push(row.assignee_list.join(", "));
      if (row.location) parts.push(row.location);
      if (row.project_name) parts.push(row.project_name);
      if (row.note) parts.push(row.note);
    }
    if (event.type === "project") parts.push(`담당 ${event.row.manager || "-"}`);
    if (event.type === "bid" && event.row.notice_inst) parts.push(event.row.notice_inst);
    return parts.join(" · ");
  }

  function dayDetail(events) {
    const iso = state.selected;
    const onDay = events.filter((event) => event.start <= iso && event.end >= iso);
    const weekday = ["일", "월", "화", "수", "목", "금", "토"][new Date(`${iso}T00:00:00`).getDay()];

    return h("div.panel", {},
      h("div.panel-head", {},
        h("h3", { text: `${Number(iso.slice(5, 7))}월 ${Number(iso.slice(8))}일 (${weekday})` }),
        h("span.muted", { text: `${onDay.length}건` }),
        h("div.grow"),
        editable()
          ? h("button.btn.sm.primary", {
            onclick: () => openScheduleForm({ startDate: iso, endDate: iso }),
          }, "＋ 일정 추가")
          : null),
      h("div.panel-body", {},
        onDay.length
          ? h("div.sched-list", {}, onDay.map((event) => h(`div.sched-row.bar-${event.layer}`, {},
            h("span.sched-tag", { text: layerLabel(event.layer) }),
            h("div.sched-row-main", {},
              h("b", { text: event.title }),
              h("span.muted", { text: detailLine(event) })),
            h("div.sched-row-acts", {},
              event.type === "schedule" && editable()
                ? h("button.btn.sm", { onclick: () => openEvent(event) }, "수정")
                : h("button.btn.sm", { onclick: () => openEvent(event) }, "열기"),
              event.type === "schedule" && editable()
                ? h("button.btn.sm.danger", { onclick: () => dropSchedule(event.row) }, "삭제")
                : null))))
          : h("p.muted", { style: { margin: "0" }, text: "이 날에 잡힌 일정이 없습니다." })));
  }

  function draw() {
    const { weeks } = bounds();
    const events = buildEvents();

    const weekNodes = weeks.map((days) => {
      const { bars, hidden, lanes } = layoutWeek(days, events);
      const height = 30 + Math.max(1, lanes) * 24 + 8;

      return h("div.sched-week", { style: { height: `${height}px` } },
        h("div.sched-week-days", {}, days.map((day) => h(
          `button.sched-day${day.outside ? ".out" : ""}${day.iso === today() ? ".today" : ""}${day.iso === state.selected ? ".on" : ""}`,
          {
            onclick: () => { state.selected = day.iso; draw(); },
            ondblclick: () => { if (editable()) openScheduleForm({ startDate: day.iso, endDate: day.iso }); },
          },
          h("span.n", { text: String(day.day) }),
          hidden.get(day.iso) ? h("span.more", { text: `＋${hidden.get(day.iso)}` }) : null,
        ))),
        h("div.sched-week-bars", {}, bars.map((bar) => h(
          `div.sched-bar.bar-${bar.event.layer}${bar.opensLeft ? "" : ".cont-l"}${bar.closesRight ? "" : ".cont-r"}`,
          {
            style: {
              left: `calc(${(bar.from / 7) * 100}% + 4px)`,
              width: `calc(${((bar.to - bar.from + 1) / 7) * 100}% - 8px)`,
              top: `${bar.lane * 24}px`,
            },
            title: `${bar.event.title}${bar.event.start === bar.event.end ? "" : ` (${bar.event.start} ~ ${bar.event.end})`}`,
            onclick: (clickEvent) => { clickEvent.stopPropagation(); openEvent(bar.event); },
          },
          h("span", { text: bar.event.title }),
        ))));
    });

    const counts = { work: 0, leave: 0, etc: 0, project: 0, bid: 0 };
    for (const event of events) counts[event.layer] += 1;

    body.replaceChildren(
      h("div.cal-nav", {},
        h("div", { style: { display: "flex", gap: "8px", alignItems: "center" } },
          h("button", { onclick: () => shiftMonth(-1) }, "‹"),
          h("b", {
            style: { minWidth: "124px", textAlign: "center", display: "inline-block" },
            text: `${state.month.slice(0, 4)}년 ${Number(state.month.slice(5))}월`,
          }),
          h("button", { onclick: () => shiftMonth(1) }, "›"),
          h("button", {
            onclick: () => { state.month = today().slice(0, 7); state.selected = today(); refresh(); },
          }, "오늘")),
        h("div.sched-filters", {}, CAL_LAYERS
          .filter((layer) => !layer.adminOnly || ref.allows("admin"))
          .map((layer) => h(`button.sched-chip.bar-${layer.key}${state.show[layer.key] ? ".on" : ""}`, {
            onclick: () => { state.show[layer.key] = !state.show[layer.key]; draw(); },
          }, h("i"), `${layer.label} ${counts[layer.key]}`)))),

      h("div.sched-cal", {},
        h("div.cal-head", {}, ["일", "월", "화", "수", "목", "금", "토"].map((label) => h("div", { text: label }))),
        h("div.sched-weeks", {}, weekNodes)),

      dayDetail(events));
  }

  async function refresh() {
    const { from, to } = bounds();
    state.data = await api(`/api/calendar?from=${from}&to=${to}`);
    draw();
  }

  const el = h("div.screen.scroll", {},
    h("div.screen-head", {},
      h("div", {}, h("div.crumb", { text: "홈 > 작업 일정" }), h("h1", { text: "팀 일정" })),
      h("div.head-actions", {},
        ref.can("schedule")
          ? h("button.btn.primary", {
            onclick: () => openScheduleForm({ startDate: state.selected, endDate: state.selected }),
          }, "＋ 일정 추가")
          : null)),
    h("div"),
    body);

  return { el, refresh };
}

export const MODULES = [
  { id: "home", name: "홈", groups: [{ items: [["home.dashboard", "경영 현황"], ["home.calendar", "작업 일정"]] }] },
  {
    id: "inventory", name: "재고", groups: [
      { name: "재고관리", items: [["inv.status", "재고현황"], ["inv.ledger", "재고수불부"], ["inv.transfer", "재고이동"], ["inv.adjust", "재고조정"], ["inv.allocation", "공사별 자재배정"]] },
      { name: "기준정보", items: [["base.warehouse", "창고등록"], ["base.catalog", "품목 마스터"]] },
    ],
  },
  {
    id: "purchase", name: "구매", groups: [
      { name: "구매관리", items: [["pur.search", "자재 통합검색"], ["pur.quote", "견적 비교"], ["pur.request", "구매요청"], ["pur.order", "발주서"], ["pur.receive", "입고처리"], ["pur.receipts", "입고내역"]] },
      { name: "기준정보", items: [["base.supplier", "공급처등록"], ["base.import", "공급처 품목 등록"], ["base.catalog", "품목 마스터"]] },
    ],
  },
  {
    id: "sales", name: "영업", groups: [
      { name: "영업관리", items: [["sal.order", "매출등록"], ["sal.payment", "수금관리"], ["sal.status", "매출현황"]] },
      { name: "기준정보", items: [["base.customer", "고객등록"]] },
    ],
  },
  {
    id: "project", name: "공사", groups: [
      { name: "공사관리", items: [["base.project", "공사등록"], ["prj.cost", "공사별 원가"], ["prj.receipt", "작업별 영수증"], ["inv.allocation", "공사별 자재배정"]] },
    ],
  },
  {
    id: "accounting", name: "회계", need: "admin", groups: [
      { name: "회계관리", items: [["acc.ledger", "전표 입력·조회"], ["acc.fund", "자금현황"]] },
    ],
  },
  {
    id: "bid", name: "입찰", need: "admin", groups: [
      { name: "나라장터", items: [["bid.calendar", "입찰 캘린더"], ["bid.list", "입찰공고 조회"], ["bid.star", "관심공고"]] },
    ],
  },
  {
    id: "report", name: "분석", need: "admin", groups: [
      { name: "경영분석", items: [["rpt.purchase", "구매분석"], ["rpt.inventory", "재고분석"], ["prj.cost", "공사수익"]] },
    ],
  },
  {
    id: "system", name: "설정", groups: [
      { name: "시스템", items: [["sys.user", "사용자·권한"], ["sys.connector", "연동설정"], ["sys.company", "회사정보"], ["sys.audit", "변경이력"], ["sys.password", "비밀번호 변경"]], adminOnly: ["sys.user", "sys.connector", "sys.company"] },
    ],
  },
];

export const SCREENS = {
  "home.dashboard": { title: "경영 현황", build: dashboard },
  "home.calendar": { title: "작업 일정", build: teamCalendar },
  "inv.status": { title: "재고현황", build: invStatus },
  "inv.ledger": { title: "재고수불부", build: invLedger },
  "inv.transfer": { title: "재고이동", build: invTransfer },
  "inv.adjust": { title: "재고조정", build: invAdjust },
  "inv.allocation": { title: "공사별 자재배정", build: invAllocation },
  "base.warehouse": { title: "창고등록", build: baseWarehouse },
  "base.product": { title: "품목등록", build: baseProduct },
  "base.supplier": { title: "공급처등록", build: baseSupplier },
  "base.customer": { title: "고객등록", build: baseCustomer },
  "base.project": { title: "공사등록", build: baseProject },
  "pur.search": { title: "자재 통합검색", build: purSearch },
  "base.import": { title: "공급처 품목 등록", build: baseImport },
  "base.catalog": { title: "품목 마스터", build: baseCatalog },
  "pur.quote": { title: "견적 비교", build: quoteScreen },
  "pur.request": { title: "구매요청", build: purRequest },
  "pur.order": { title: "발주서", build: purOrder },
  "pur.sheet": { title: "발주서 인쇄", build: orderSheetScreen },
  "pur.receive": { title: "입고처리", build: purReceive },
  "pur.receipts": { title: "입고내역", build: purReceipts },
  "sal.order": { title: "매출등록", build: salOrder },
  "sal.payment": { title: "수금관리", build: salPayment },
  "sal.status": { title: "매출현황", build: salStatus },
  "prj.cost": { title: "공사별 원가", build: prjCost },
  "prj.receipt": { title: "작업별 영수증", build: prjReceipt },
  "acc.ledger": { title: "전표 입력·조회", build: accLedger },
  "acc.fund": { title: "자금현황", build: accFund },
  "bid.calendar": { title: "입찰 캘린더", build: bidCalendarScreen },
  "bid.list": { title: "입찰공고 조회", build: bidList },
  "bid.star": { title: "관심공고", build: bidStarred },
  "rpt.purchase": { title: "구매분석", build: rptPurchase },
  "rpt.inventory": { title: "재고분석", build: rptInventory },
  "sys.user": { title: "사용자·권한", build: sysUser },
  "sys.connector": { title: "연동설정", build: sysConnector },
  "sys.company": { title: "회사정보", build: sysCompany },
  "sys.audit": { title: "변경이력", build: sysAudit },
  "sys.password": { title: "비밀번호 변경", build: sysPassword },
};
