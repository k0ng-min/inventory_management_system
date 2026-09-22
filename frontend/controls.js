/* ==========================================================================
   controls.js — 콤보박스 / 날짜 선택 / 금액 입력
   브라우저 기본 위젯(select, input[type=date], number 스피너)은 OS 마다
   모양이 달라 화면 전체의 톤을 깨뜨립니다. 같은 동작을 직접 만들어 씁니다.

   세 컨트롤 모두 `.value` 게터·세터와 `.focus()` 를 노출하므로
   기존 폼 엔진(core.js 의 openForm)에서 <input> 과 똑같이 다룰 수 있습니다.
   ========================================================================== */

import { h, esc } from "./core.js";

/* ---------- 공용 팝오버 ---------------------------------------------------- */

let openPop = null;

/** 열려 있는 팝오버를 닫습니다. */
export function closePopover() {
  if (!openPop) return;
  openPop.node.remove();
  openPop.anchor?.classList.remove("pop-open");
  openPop = null;
}

/**
 * anchor 아래(공간이 없으면 위)에 패널을 띄웁니다.
 * position: fixed 라서 스크롤 컨테이너나 dialog 안에서도 잘리지 않습니다.
 */
function showPopover(anchor, panel, { matchWidth = true, minWidth = 200 } = {}) {
  closePopover();
  panel.classList.add("pop");
  // <dialog> 는 최상위 레이어에 그려지므로, 모달 안에서 열린 팝오버는
  // body 가 아니라 그 dialog 안에 넣어야 가려지지 않습니다.
  const host = anchor.closest("dialog") || document.body;
  host.append(panel);

  const place = () => {
    const rect = anchor.getBoundingClientRect();
    const width = matchWidth ? Math.max(rect.width, minWidth) : minWidth;
    panel.style.width = `${width}px`;
    panel.style.left = `${Math.min(rect.left, window.innerWidth - width - 8)}px`;

    const height = panel.offsetHeight;
    const below = window.innerHeight - rect.bottom;
    panel.style.top = below > height + 12 || below > rect.top
      ? `${rect.bottom + 6}px`
      : `${Math.max(8, rect.top - height - 6)}px`;
  };

  place();
  anchor.classList.add("pop-open");
  openPop = { node: panel, anchor, place };
  return panel;
}

document.addEventListener("pointerdown", (event) => {
  if (!openPop) return;
  if (openPop.node.contains(event.target) || openPop.anchor.contains(event.target)) return;
  closePopover();
}, true);
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !openPop) return;
  // 팝오버만 닫고 끝냅니다. preventDefault 가 없으면 <dialog> 까지 함께 닫힙니다.
  closePopover();
  event.preventDefault();
  event.stopPropagation();
}, true);
window.addEventListener("resize", () => openPop?.place());
window.addEventListener("scroll", () => openPop?.place(), true);

/** 래퍼에 value/focus 를 달아 <input> 처럼 쓰게 만듭니다. */
function asField(wrap, { get, set, focus }) {
  Object.defineProperty(wrap, "value", { get, set, configurable: true });
  wrap.focus = focus;
  return wrap;
}

const fire = (node) => {
  node.dispatchEvent(new Event("input", { bubbles: true }));
  node.dispatchEvent(new Event("change", { bubbles: true }));
};

const CHEVRON = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
  stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;
const CAL_ICON = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
  stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>`;
const CHECK = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
  stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 13 4 4L19 7"/></svg>`;

/* ==========================================================================
   콤보박스
   ========================================================================== */

/**
 * options: [{ value, label }]
 * 항목이 8개를 넘으면 검색창이 자동으로 붙습니다.
 */
export function makeSelect({ options = [], value = "", placeholder = "선택하세요", allowEmpty = true, emptyLabel } = {}) {
  let current = String(value ?? "");
  const wrap = h("div.cbx");
  const label = h("span.cbx-label");
  const button = h("button.cbx-btn", { type: "button" }, label, h("i", { html: CHEVRON }));
  wrap.append(button);

  const list = allowEmpty ? [{ value: "", label: emptyLabel || placeholder }, ...options] : options;

  function paint() {
    const hit = list.find((option) => String(option.value) === current);
    label.textContent = hit ? hit.label : (placeholder || "");
    label.classList.toggle("is-empty", !hit || hit.value === "");
    wrap.dataset.value = current;
  }

  function open() {
    const searchable = options.length > 8;
    const search = h("input.pop-search", { type: "text", placeholder: "검색", autocomplete: "off" });
    const listBox = h("div.pop-list", { role: "listbox" });
    const panel = h("div", {}, searchable ? h("div.pop-search-wrap", {}, search) : null, listBox);

    let rows = [];
    let cursor = Math.max(0, list.findIndex((option) => String(option.value) === current));

    const draw = (query = "") => {
      const needle = query.trim().toLowerCase();
      rows = list.filter((option) => !needle || option.label.toLowerCase().includes(needle));
      if (!rows.length) {
        listBox.replaceChildren(h("div.pop-none", { text: "검색 결과가 없습니다" }));
        return;
      }
      if (cursor >= rows.length) cursor = 0;
      listBox.replaceChildren(...rows.map((option, index) => {
        const picked = String(option.value) === current;
        return h(`button.pop-opt${picked ? ".picked" : ""}${index === cursor ? ".cursor" : ""}`, {
          type: "button", role: "option",
          dataset: { value: String(option.value) },
          "aria-selected": picked ? "true" : "false",
          onclick: () => { current = String(option.value); paint(); closePopover(); fire(wrap); },
        }, h("span", { text: option.label }), picked ? h("i", { html: CHECK }) : null);
      }));
      listBox.children[cursor]?.scrollIntoView({ block: "nearest" });
    };

    const move = (step) => {
      if (!rows.length) return;
      cursor = (cursor + step + rows.length) % rows.length;
      draw(search.value);
    };

    draw();
    showPopover(button, panel, { minWidth: 220 });

    const onKey = (event) => {
      if (event.key === "ArrowDown") { event.preventDefault(); move(1); }
      else if (event.key === "ArrowUp") { event.preventDefault(); move(-1); }
      else if (event.key === "Enter") {
        event.preventDefault();
        const option = rows[cursor];
        if (option) { current = String(option.value); paint(); closePopover(); fire(wrap); }
      }
    };
    (searchable ? search : panel).addEventListener("keydown", onKey);
    button.addEventListener("keydown", onKey);
    if (searchable) {
      search.addEventListener("input", () => { cursor = 0; draw(search.value); });
      setTimeout(() => search.focus(), 10);
    }
  }

  button.addEventListener("click", () => (openPop?.anchor === button ? closePopover() : open()));
  button.addEventListener("keydown", (event) => {
    if (["ArrowDown", "Enter", " "].includes(event.key) && openPop?.anchor !== button) { event.preventDefault(); open(); }
  });

  paint();
  return asField(wrap, {
    get: () => current,
    set: (next) => { current = String(next ?? ""); paint(); },
    focus: () => button.focus(),
  });
}

/* ==========================================================================
   날짜 선택
   ========================================================================== */

const pad2 = (value) => String(value).padStart(2, "0");
const iso = (date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
const todayIso = () => iso(new Date());
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

export function makeDate({ value = "", placeholder = "날짜 선택", clearable = true } = {}) {
  let current = value ? String(value).slice(0, 10) : "";
  const wrap = h("div.dtp");
  const label = h("span.dtp-label");
  const button = h("button.dtp-btn", { type: "button" }, h("i.dtp-ico", { html: CAL_ICON }), label);
  wrap.append(button);

  function paint() {
    label.textContent = current || placeholder;
    label.classList.toggle("is-empty", !current);
    wrap.dataset.value = current;
  }

  function open() {
    const base = current ? new Date(`${current}T00:00:00`) : new Date();
    let year = base.getFullYear();
    let month = base.getMonth();

    const title = h("b");
    const cells = h("div.cal-days");
    const panel = h("div", {},
      h("div.cal-nav", {},
        h("button", { type: "button", "aria-label": "이전 달", onclick: () => shift(-1) }, "‹"),
        title,
        h("button", { type: "button", "aria-label": "다음 달", onclick: () => shift(1) }, "›")),
      h("div.cal-week", {}, WEEKDAYS.map((day) => h("span", { text: day }))),
      cells,
      h("div.cal-foot", {},
        h("button", { type: "button", onclick: () => pick(todayIso()) }, "오늘"),
        clearable ? h("button", { type: "button", onclick: () => pick("") }, "지우기") : null));

    const pick = (next) => { current = next; paint(); closePopover(); fire(wrap); };
    const shift = (step) => {
      const moved = new Date(year, month + step, 1);
      year = moved.getFullYear(); month = moved.getMonth();
      draw();
      openPop?.place();
    };

    function draw() {
      title.textContent = `${year}년 ${month + 1}월`;
      const first = new Date(year, month, 1);
      const start = new Date(first);
      start.setDate(1 - first.getDay());
      const nodes = [];
      for (let index = 0; index < 42; index += 1) {
        const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
        const key = iso(date);
        const outside = date.getMonth() !== month;
        nodes.push(h(`button.cal-day${outside ? ".out" : ""}${key === current ? ".picked" : ""}${key === todayIso() ? ".now" : ""}`, {
          type: "button", dataset: { date: key }, onclick: () => pick(key),
        }, String(date.getDate())));
      }
      cells.replaceChildren(...nodes);
    }

    draw();
    showPopover(button, panel, { matchWidth: false, minWidth: 276 });
  }

  button.addEventListener("click", () => (openPop?.anchor === button ? closePopover() : open()));
  paint();
  return asField(wrap, {
    get: () => current,
    set: (next) => { current = next ? String(next).slice(0, 10) : ""; paint(); },
    focus: () => button.focus(),
  });
}

/* ==========================================================================
   금액 입력
   ========================================================================== */

const groups = new Intl.NumberFormat("ko-KR");

/** 입력 중에도 천단위 구분을 유지합니다. value 는 항상 순수 숫자 문자열입니다. */
export function makeMoney({ value = "", unit = "원", placeholder = "0" } = {}) {
  const wrap = h("div.money");
  const field = h("input", { type: "text", inputmode: "numeric", placeholder, autocomplete: "off" });
  wrap.append(h("span.money-sym", {}, "₩"), field, unit ? h("span.money-unit", { text: unit }) : null);

  const raw = () => field.value.replace(/[^\d-]/g, "");
  const paint = () => {
    const digits = raw();
    field.value = digits === "" || digits === "-" ? digits : groups.format(Number(digits));
  };

  field.addEventListener("input", () => {
    // 캐럿이 끝에 있을 때가 대부분이라, 포맷 후 커서를 끝으로 보냅니다.
    const atEnd = field.selectionStart === field.value.length;
    paint();
    if (atEnd) field.setSelectionRange(field.value.length, field.value.length);
  });
  field.addEventListener("blur", paint);

  if (value !== "" && value !== null && value !== undefined) { field.value = String(value); paint(); }

  return asField(wrap, {
    get: () => raw(),
    set: (next) => { field.value = next === null || next === undefined ? "" : String(next); paint(); },
    focus: () => field.focus(),
  });
}
