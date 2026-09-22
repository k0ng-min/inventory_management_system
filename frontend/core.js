/* ==========================================================================
   core.js — API 호출, 포맷터, DOM 헬퍼, 그리드/폼 엔진
   화면 정의(screens.js)는 전부 이 위에서 만들어집니다.
   ========================================================================== */

/* ---------- DOM ---------------------------------------------------------- */

export const $ = (selector, scope = document) => scope.querySelector(selector);

export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

// 커스텀 컨트롤은 core 를 import 하므로, 순환을 피해 지연 로딩합니다.
let controls = null;
export const useControls = (module) => { controls = module; };

// 단위가 없는 CSS 속성 — 그 외 숫자 값에는 px 를 붙입니다.
const UNITLESS = new Set(["opacity", "zIndex", "fontWeight", "lineHeight", "flex", "flexGrow", "flexShrink", "order", "zoom"]);

function setStyle(node, declarations) {
  for (const [property, value] of Object.entries(declarations)) {
    node.style[property] = typeof value === "number" && !UNITLESS.has(property) ? `${value}px` : value;
  }
}

/** 최소 하이퍼스크립트. h("div.cls", {onclick}, child, ...) */
export function h(spec, props, ...children) {
  const [tag, ...classes] = spec.split(".");
  const node = document.createElement(tag || "div");
  if (classes.length) node.className = classes.join(" ");
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "html") node.innerHTML = value;
    else if (key === "text") node.textContent = value;
    else if (key === "class") node.className = [node.className, value].filter(Boolean).join(" ");
    else if (key === "style") setStyle(node, value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat(3)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/* ---------- 포맷 ---------------------------------------------------------- */

const nf = new Intl.NumberFormat("ko-KR");

export const fmt = {
  int: (value) => (value === null || value === undefined || value === "" ? "" : nf.format(Math.round(Number(value) || 0))),
  won: (value) => `₩${nf.format(Math.round(Number(value) || 0))}`,
  /** 큰 금액을 억/만 단위로 압축 — KPI 타일용 */
  wonShort(value) {
    const n = Math.round(Number(value) || 0);
    const abs = Math.abs(n);
    if (abs >= 100_000_000) return `${(n / 100_000_000).toFixed(abs >= 1_000_000_000 ? 0 : 1)}억`;
    if (abs >= 10_000) return `${nf.format(Math.round(n / 10_000))}만`;
    return nf.format(n);
  },
  date: (value) => (value ? String(value).slice(0, 10) : ""),
  dt: (value) => (value ? String(value).replace("T", " ").slice(0, 16) : ""),
};

export const today = () => new Date().toLocaleDateString("sv-SE");
export const addDays = (date, days) =>
  new Date(new Date(date).getTime() + days * 86400000).toLocaleDateString("sv-SE");
export const monthStart = (date = new Date()) => `${date.toLocaleDateString("sv-SE").slice(0, 7)}-01`;
export const monthEnd = (date = new Date()) =>
  new Date(date.getFullYear(), date.getMonth() + 1, 0).toLocaleDateString("sv-SE");

/* ---------- API ---------------------------------------------------------- */

let busyCount = 0;
function setBusy(delta) {
  busyCount = Math.max(0, busyCount + delta);
  const existing = $("#busybar");
  if (busyCount > 0 && !existing) document.body.append(h("div.busy", { id: "busybar" }));
  if (busyCount === 0 && existing) existing.remove();
}

/** 401 이 오면 로그인 화면으로 돌려보냅니다. app.js 가 주입합니다. */
export const hooks = { onUnauthorized: null };

export async function api(path, options = {}) {
  setBusy(1);
  try {
    const response = await fetch(path, {
      headers: { "content-type": "application/json", ...(options.headers || {}) },
      ...options,
      body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body,
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (response.status === 401 && hooks.onUnauthorized) hooks.onUnauthorized();
    if (!response.ok) throw new Error(payload.message || `요청을 처리하지 못했습니다. (${response.status})`);
    return payload;
  } finally {
    setBusy(-1);
  }
}

/* ---------- 토스트 -------------------------------------------------------- */

export function toast(message, kind = "") {
  const node = h(`div.toast${kind === "err" ? ".err" : ""}`, { text: message });
  $("#toasts").append(node);
  setTimeout(() => {
    node.style.transition = "opacity .2s";
    node.style.opacity = "0";
    setTimeout(() => node.remove(), 220);
  }, kind === "err" ? 4600 : 2600);
}

/** 액션을 감싸 성공/실패 토스트를 자동 처리합니다. */
export async function guard(fn, successMessage) {
  try {
    const result = await fn();
    if (successMessage) toast(successMessage);
    return result;
  } catch (error) {
    toast(error.message, "err");
    throw error;
  }
}

/* ---------- 모달 ---------------------------------------------------------- */

const modal = () => $("#modal");

export function closeModal() {
  controls?.closePopover();
  const dialog = modal();
  if (dialog.open) dialog.close();
  dialog.innerHTML = "";
}

function shell({ title, sub, width, body, footer, bare }) {
  const dialog = modal();
  dialog.innerHTML = "";
  const card = h(`div.modal-card${width ? `.${width}` : ""}${bare ? ".bare" : ""}`, {},
    bare ? null : h("div.modal-head", {},
      h("div", {}, h("h2", { text: title }), sub ? h("div.sub", { text: sub }) : null),
      h("button", { type: "button", "aria-label": "닫기", onclick: closeModal }, "×")),
    h("div.modal-error.hidden", { id: "modalError" }),
    h("div.modal-body", {}, body),
    footer ? h("div.modal-foot", {}, footer) : null);
  dialog.append(card);
  dialog.showModal();
  return { dialog, card };
}

const showModalError = (message) => {
  const box = $("#modalError");
  if (!box) return;
  box.textContent = message;
  box.classList.toggle("hidden", !message);
};

/**
 * 선언형 폼 모달.
 * fields: [{ key, label, type, required, options, value, unit, hint, readonly, min, max, width, onChange }]
 * type: text | number | won | date | select | textarea | checkbox | static
 */
export function openForm({ title, sub, width, fields, values = {}, submitLabel = "저장", onSubmit, extra, footNote }) {
  return new Promise((resolve) => {
    const state = { ...values };
    const inputs = new Map();

    // 사용자가 건드리지 않은 필드도 기본값 그대로 제출되어야 합니다.
    // (체크박스·셀렉트의 기본값이 빠지면 서버에서 빈 값으로 덮어씁니다.)
    for (const field of fields) {
      if (state[field.key] === undefined && field.value !== undefined) state[field.key] = field.value;
    }

    const control = (field) => {
      const common = {
        id: `f_${field.key}`,
        name: field.key,
        value: state[field.key] ?? field.value ?? "",
        required: field.required || undefined,
        readonly: field.readonly || undefined,
        disabled: field.disabled || undefined,
      };
      let node;
      if (field.type === "select" && controls) {
        node = controls.makeSelect({
          options: field.options || [],
          value: state[field.key] ?? field.value ?? "",
          placeholder: field.placeholder === false ? "" : (field.placeholder || "선택하세요"),
          allowEmpty: field.placeholder !== false,
        });
      } else if (field.type === "date" && controls) {
        node = controls.makeDate({ value: state[field.key] ?? field.value ?? "" });
      } else if (field.type === "won" && controls) {
        node = controls.makeMoney({ value: state[field.key] ?? field.value ?? "", unit: field.unit || "원" });
      } else if (field.type === "select") {
        node = h("select", { ...common, value: undefined },
          (field.placeholder !== false) ? h("option", { value: "" }, field.placeholder || "선택하세요") : null,
          (field.options || []).map((option) => h("option", { value: option.value }, option.label)));
        node.value = state[field.key] ?? field.value ?? "";
      } else if (field.type === "textarea") {
        node = h("textarea", { ...common, value: undefined, rows: field.rows || 3 });
        node.value = state[field.key] ?? field.value ?? "";
      } else if (field.type === "checkbox") {
        node = h("input", { ...common, type: "checkbox", value: undefined, style: { width: "16px", height: "16px" } });
        node.checked = Boolean(state[field.key] ?? field.value);
      } else if (field.type === "static") {
        node = h("input", { ...common, readonly: true });
      } else {
        node = h("input", {
          ...common,
          type: field.type === "won" || field.type === "number" ? "number" : (field.type || "text"),
          class: field.type === "won" || field.type === "number" ? "num" : undefined,
          min: field.min, max: field.max, step: field.step,
          placeholder: field.placeholder || undefined,
        });
      }
      if (!node.id) node.id = common.id;
      node.addEventListener("input", () => {
        state[field.key] = field.type === "checkbox" ? node.checked : node.value;
        field.onChange?.(state, inputs);
        recalc();
      });
      node.addEventListener("change", () => {
        state[field.key] = field.type === "checkbox" ? node.checked : node.value;
        field.onChange?.(state, inputs);
        recalc();
      });
      inputs.set(field.key, node);
      return node;
    };

    const list = h("dl.form", {}, fields.flatMap((field) => field.type === "hidden" ? [] : [
      h("dt", {}, field.label, field.required ? h("span.req", {}, "*") : null),
      h(`dd${field.full ? ".full" : ""}`, {},
        control(field),
        field.unit && field.type !== "won" ? h("span.unit", { text: field.unit }) : null,
        field.hint ? h("span.hint", { text: field.hint }) : null),
    ]));

    const calcBox = extra?.calc ? h("div.calc", {}, h("span", { text: extra.calc.label }), h("strong", { id: "calcOut" }, "")) : null;
    function recalc() {
      if (!calcBox) return;
      $("#calcOut").textContent = extra.calc.compute(state) ?? "";
    }

    const body = h("div", {},
      extra?.readout || null,
      // 표처럼 필드로 표현할 수 없는 것을 폼 안에 넣습니다(예: 발주 품목 줄 편집).
      extra?.node || null,
      list,
      calcBox,
      footNote ? h("p.muted", { style: { margin: "10px 2px 0", fontSize: "10.5px", lineHeight: "1.55" }, text: footNote }) : null);

    const submitButton = h("button.btn.primary", { type: "submit", form: "modalForm" }, submitLabel);
    const form = h("form", { id: "modalForm", onsubmit: async (event) => {
      event.preventDefault();
      showModalError("");
      for (const field of fields) {
        if (field.required && !String(state[field.key] ?? "").trim()) {
          showModalError(`${field.label} 항목은 필수입니다.`);
          inputs.get(field.key)?.focus();
          return;
        }
      }
      submitButton.disabled = true;
      try {
        const result = await onSubmit(state);
        closeModal();
        resolve(result ?? state);
      } catch (error) {
        showModalError(error.message);
        submitButton.disabled = false;
      }
    } }, body);

    shell({
      title, sub, width, body: form,
      footer: [h("button.btn", { type: "button", onclick: () => { closeModal(); resolve(null); } }, "취소"), submitButton],
    });
    recalc();
    setTimeout(() => inputs.values().next().value?.focus(), 30);
  });
}

/** 임의 컨텐츠 모달 (상세 보기 등). */
export function openPanel({ title, sub, width, content, actions }) {
  shell({
    title, sub, width, body: content,
    footer: [
      ...(actions || []),
      h("button.btn", { type: "button", onclick: closeModal }, "닫기"),
    ],
  });
}

const ASK_ICON = {
  danger: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9"
    stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>`,
  ask: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9"
    stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 16v-5M12 8h.01"/></svg>`,
};

export function confirmAsk({ title, message, okLabel = "확인", danger }) {
  return new Promise((resolve) => {
    const ok = h(`button.btn.${danger ? "danger" : "primary"}`, {
      type: "button", onclick: () => { closeModal(); resolve(true); },
    }, okLabel);
    shell({
      bare: true,
      body: h("div.ask", {},
        h(`div.ask-ico${danger ? ".danger" : ""}`, { html: danger ? ASK_ICON.danger : ASK_ICON.ask }),
        h("div", {}, h("h2", { text: title }), h("p", { text: message }))),
      footer: [h("button.btn", { type: "button", onclick: () => { closeModal(); resolve(false); } }, "취소"), ok],
    });
    setTimeout(() => ok.focus(), 30);
  });
}

/* ---------- 상태 뱃지 ------------------------------------------------------ */

/* 상태별 강조 단계. solid = 채운 액센트, mid = 중립, warn/bad = 경고. */
const STATUS_TONE = {
  입고완료: "solid", 수금완료: "solid", 승인: "solid", 사용완료: "solid", 완료: "solid", 정상: "",
  발주완료: "mid", 부분입고: "mid", 부분수금: "mid", 일부사용: "mid", "진행 중": "mid", 예약: "mid",
  승인대기: "warn", 구매요청: "warn", 검토: "warn", "마감 예정": "warn", 부족: "bad",
  반려: "bad", 취소: "bad", 중지: "bad", 재고부족: "bad", 기한초과: "bad", 해제: "",
};

export const statusChip = (status, tone) =>
  `<span class="st ${tone ?? STATUS_TONE[status] ?? ""}">${esc(status ?? "-")}</span>`;

/* ---------- 그리드 -------------------------------------------------------- */

/**
 * columns: [{ key, label, cls, width, align:'num', cell(row):htmlString, sum:true, sortValue(row) }]
 * options: { rows, columns, empty, onRowClick, rowClass, footer:true, maxHeight }
 */
/** 행 버튼 열은 가로 스크롤과 무관하게 항상 보이도록 오른쪽에 고정합니다. */
const stickyEnd = (column) => column.sticky ?? column.key === "_actions";

export function grid({ rows, columns, empty, onRowClick, rowClass, footer, selectedId, idKey = "id" }) {
  const state = { sortKey: null, sortDir: 1 };
  const wrap = h("div.gridwrap");

  const valueOf = (column, row) => {
    if (column.sortValue) return column.sortValue(row);
    const raw = row[column.key];
    return typeof raw === "string" ? raw : Number(raw ?? 0);
  };

  function draw() {
    const data = state.sortKey
      ? [...rows].sort((a, b) => {
        const column = columns.find((item) => item.key === state.sortKey);
        const left = valueOf(column, a);
        const right = valueOf(column, b);
        if (typeof left === "string" || typeof right === "string") {
          return String(left).localeCompare(String(right), "ko") * state.sortDir;
        }
        return (left - right) * state.sortDir;
      })
      : rows;

    wrap.innerHTML = "";
    if (!data.length) {
      wrap.append(h("div.grid-empty", {},
        h("b", { text: empty?.title || "조회된 자료가 없습니다" }),
        h("span", { text: empty?.hint || "조회 조건을 변경한 뒤 다시 조회해 보세요." })));
      return;
    }

    const head = h("tr", {}, columns.map((column) => {
      const sorted = state.sortKey === column.key;
      const th = h(`th${column.align === "num" ? ".num" : ""}${stickyEnd(column) ? ".sticky-end" : ""}${column.sortable === false ? "" : ".sortable"}${sorted ? ".sorted" : ""}`, {
        style: column.width ? { width: `${column.width}px`, minWidth: `${column.width}px` } : undefined,
        html: `${esc(column.label)}${column.sortable === false ? "" : `<span class="caret">${sorted ? (state.sortDir > 0 ? "▲" : "▼") : "▾"}</span>`}`,
      });
      if (column.sortable !== false) {
        th.addEventListener("click", () => {
          if (state.sortKey === column.key) state.sortDir *= -1;
          else { state.sortKey = column.key; state.sortDir = 1; }
          draw();
        });
      }
      return th;
    }));

    const body = h("tbody", {}, data.map((row) => {
      const tr = h(`tr${rowClass?.(row) ? `.${rowClass(row)}` : ""}${selectedId && row[idKey] === selectedId ? ".selected" : ""}`,
        { dataset: { id: String(row[idKey] ?? "") } },
        columns.map((column) => {
          const td = h(`td${column.align === "num" ? ".num" : ""}${stickyEnd(column) ? ".sticky-end" : ""}${column.cls ? `.${column.cls}` : ""}`, {
            html: column.cell ? column.cell(row) : esc(row[column.key] ?? ""),
          });
          // 칸이 좁아 말줄임된 글자는 마우스를 올리면 전체가 보이게 합니다.
          if (!column.noExport && td.textContent.trim()) td.title = td.textContent.trim();
          return td;
        }));
      if (onRowClick) {
        tr.style.cursor = "pointer";
        tr.addEventListener("click", (event) => {
          if (event.target.closest("button, a, input")) return;
          onRowClick(row, tr);
        });
      }
      return tr;
    }));

    const parts = [h("thead", {}, head), body];
    if (footer && columns.some((column) => column.sum)) {
      parts.push(h("tfoot", {}, h("tr", {}, columns.map((column, index) => {
        if (column.sum) {
          const total = data.reduce((sum, row) => sum + (Number(row[column.key]) || 0), 0);
          return h("td.num", { html: column.sumFormat ? column.sumFormat(total) : fmt.int(total) });
        }
        return h(`td${column.align === "num" ? ".num" : ""}`, { text: index === 0 ? `합계 ${data.length}건` : "" });
      }))));
    }
    wrap.append(h("table.grid", {}, parts));
  }

  draw();
  return wrap;
}

/* ---------- CSV 내보내기 --------------------------------------------------- */

export function exportCsv(filename, columns, rows) {
  const visible = columns.filter((column) => column.key !== "_actions" && !column.noExport);
  const cellText = (column, row) => {
    const raw = column.export ? column.export(row) : row[column.key];
    return String(raw ?? "").replace(/<[^>]*>/g, "").replace(/"/g, '""');
  };
  const lines = [
    visible.map((column) => `"${column.label}"`).join(","),
    ...rows.map((row) => visible.map((column) => `"${cellText(column, row)}"`).join(",")),
  ];
  // BOM 을 붙여야 엑셀에서 한글이 깨지지 않습니다.
  const blob = new Blob([`﻿${lines.join("\r\n")}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = h("a", { href: url, download: `${filename}_${today()}.csv` });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  toast(`${rows.length}건을 CSV로 저장했습니다.`);
}

/* ---------- 그리드 행 버튼 ------------------------------------------------- */

/**
 * 그리드 안의 [data-act] 버튼 클릭을 한 곳에서 처리합니다.
 * 행은 data-id 로 찾으므로 정렬이 바뀌어도 올바른 행이 전달됩니다.
 */
export function bindRowActions(wrap, rows, idKey, handlers) {
  wrap.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-act]");
    if (!button) return;
    const id = button.closest("tr")?.dataset.id;
    const row = rows.find((item) => String(item[idKey]) === id);
    if (row) handlers[button.dataset.act]?.(row);
  });
}
