/* ==========================================================================
   app.js — 인증, 모듈/메뉴 네비게이션, 멀티탭 매니저
   ========================================================================== */

import { $, h, api, toast, hooks, useControls } from "./core.js";
import * as controls from "./controls.js";

// core 의 폼 엔진이 커스텀 컨트롤을 쓰도록 연결합니다.
useControls(controls);
import { MODULES, SCREENS, ref, nav } from "./screens.js";

const ROLE_LABEL = { admin: "시스템 관리자", purchasing: "구매 담당", warehouse: "창고 담당", viewer: "조회 전용" };

const state = {
  moduleId: "home",
  tabs: [],          // [{ id, title, el, refresh }]
  activeId: null,
};

// 화면 안에서 다른 화면을 열 수 있도록 탭 매니저를 screens.js 에 연결합니다.
nav.open = (screenId) => openTab(screenId);

/* ---------- 모듈 바 -------------------------------------------------------- */

/* ---------- 접근 권한 ------------------------------------------------------
   메뉴 항목의 3번째 값(need)과 모듈의 need 로 노출을 결정합니다.
   서버가 이미 같은 기준으로 막고 있고, 여기서는 보이지 않게만 합니다.
   -------------------------------------------------------------------------- */

const itemNeed = (module, group, id, need) =>
  need || module.need || ((group.adminOnly || []).includes(id) ? "admin" : null);

const allowedModules = () => MODULES.filter((module) =>
  ref.allows(module.need) && visibleItems(module).length > 0);

/** 같은 화면이 여러 메뉴에 걸려 있으면 가장 느슨한 조건을 따릅니다. */
function screenAllowed(screenId) {
  let listed = false;
  for (const module of MODULES) {
    for (const group of module.groups) {
      for (const [id, , need] of group.items) {
        if (id !== screenId) continue;
        listed = true;
        if (ref.allows(itemNeed(module, group, id, need))) return true;
      }
    }
  }
  return !listed;
}

function renderModuleBar() {
  $("#moduleBar").replaceChildren(...allowedModules().map((module) =>
    h(`button${state.moduleId === module.id ? ".on" : ""}`, {
      onclick: () => selectModule(module.id),
    }, module.name)));
}

function selectModule(moduleId, openFirst = true) {
  const allowed = allowedModules();
  state.moduleId = allowed.some((module) => module.id === moduleId) ? moduleId : (allowed[0]?.id || moduleId);
  moduleId = state.moduleId;
  renderModuleBar();
  renderLnb();
  const module = MODULES.find((item) => item.id === moduleId);
  const first = visibleItems(module)[0];
  if (openFirst && first) openTab(first[0]);
}

/** 권한에 따라 감춰야 할 메뉴를 걸러냅니다. */
function visibleItems(module) {
  return module.groups.flatMap((group) =>
    group.items.filter(([id, , need]) => ref.allows(itemNeed(module, group, id, need))));
}

function renderLnb() {
  const module = MODULES.find((item) => item.id === state.moduleId);
  $("#lnbHead").textContent = module.name;
  $("#lnbBody").replaceChildren(...module.groups.map((group) => {
    const items = group.items.filter(([id, , need]) => ref.allows(itemNeed(module, group, id, need)));
    if (!items.length) return h("div", { style: { display: "none" } });
    return h("div.lnb-group", {},
      group.name ? h("h4", { text: group.name }) : null,
      ...items.map(([id, label]) => h(`button.lnb-item${state.activeId === id ? ".on" : ""}`, {
        onclick: () => { openTab(id); $("#lnb").classList.remove("open"); },
      }, h("span", { text: label }), badgeFor(id))));
  }));
}

const badges = {};
function badgeFor(id) {
  const value = badges[id];
  return value ? h("span.badge", { text: String(value) }) : null;
}

/** 대기 업무 건수를 메뉴에 표시합니다. */
async function refreshBadges() {
  try {
    const summary = await api("/api/summary");
    if (!ref.allows("prices")) { renderLnb(); return; }
    badges["pur.request"] = summary.pendingRequests;
    badges["pur.order"] = summary.pendingApprovals;
    badges["pur.receive"] = summary.incomingOrders;
    badges["inv.status"] = summary.lowStockItems;
    badges["bid.star"] = summary.starredBids;
    renderLnb();
  } catch { /* 로그인 전이거나 일시 오류 — 배지는 생략합니다 */ }
}

/* ---------- 탭 ------------------------------------------------------------ */

function renderTabs() {
  $("#tabstrip").replaceChildren(...state.tabs.map((tab) =>
    h(`div.tab${state.activeId === tab.id ? ".on" : ""}`, { onclick: () => activateTab(tab.id) },
      h("span", { text: tab.title }),
      h("button.tab-close", {
        title: "닫기",
        onclick: (event) => { event.stopPropagation(); closeTab(tab.id); },
      }, "×"))));
}

async function openTab(screenId) {
  const definition = SCREENS[screenId];
  if (!definition) return toast(`화면을 찾을 수 없습니다: ${screenId}`, "err");
  if (!screenAllowed(screenId)) return toast("이 화면을 볼 권한이 없습니다.", "err");

  let tab = state.tabs.find((item) => item.id === screenId);
  if (!tab) {
    const instance = definition.build();
    tab = { id: screenId, title: definition.title, ...instance };
    state.tabs.push(tab);
    $("#tabhost").append(tab.el);
    activateTab(screenId);
    try {
      await tab.refresh();
    } catch (error) {
      toast(error.message, "err");
    }
  } else {
    activateTab(screenId);
    tab.refresh().catch((error) => toast(error.message, "err"));
  }
  // 열린 화면이 속한 모듈로 상단 메뉴를 맞춥니다.
  const owner = MODULES.find((module) => module.groups.some((group) => group.items.some(([id]) => id === screenId)));
  if (owner && owner.id !== state.moduleId) { state.moduleId = owner.id; renderModuleBar(); }
  renderLnb();
}

function activateTab(screenId) {
  state.activeId = screenId;
  state.tabs.forEach((tab) => tab.el.classList.toggle("on", tab.id === screenId));
  renderTabs();
  renderLnb();
  history.replaceState(null, "", `#${screenId}`);
}

function closeTab(screenId) {
  const index = state.tabs.findIndex((tab) => tab.id === screenId);
  if (index < 0) return;
  state.tabs[index].el.remove();
  state.tabs.splice(index, 1);
  if (state.activeId === screenId) {
    const next = state.tabs[index] || state.tabs[index - 1];
    if (next) activateTab(next.id);
    else { state.activeId = null; renderTabs(); renderLnb(); }
  } else {
    renderTabs();
  }
}

function refreshActiveTab() {
  const tab = state.tabs.find((item) => item.id === state.activeId);
  tab?.refresh().catch((error) => toast(error.message, "err"));
  refreshBadges();
}

/* ---------- 인증 ---------------------------------------------------------- */

function showAuth(status) {
  $("#authScreen").classList.remove("hidden");
  $("#app").classList.add("hidden");
  $("#loginForm").classList.toggle("hidden", Boolean(status?.setupRequired));
  $("#setupForm").classList.toggle("hidden", !status?.setupRequired);
  // 탭 상태를 비워 다음 로그인 때 새로 그립니다.
  state.tabs.forEach((tab) => tab.el.remove());
  state.tabs = [];
  state.activeId = null;
}

async function showApp(user, organization) {
  ref.me = user;
  $("#authScreen").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#userName").textContent = user.name;
  $("#userRole").textContent = ROLE_LABEL[user.role] || user.role;
  $("#userAvatar").textContent = user.name.slice(0, 1);
  $("#orgName").textContent = organization?.name || "ERP";

  await ref.reload();
  renderModuleBar();

  const requested = location.hash.slice(1);
  const initial = SCREENS[requested] && screenAllowed(requested) ? requested : "home.dashboard";
  selectModule(MODULES.find((module) => module.groups.some((group) => group.items.some(([id]) => id === initial)))?.id || "home", false);
  await openTab(initial);
  refreshBadges();
  registerWebMcpTools();
}

async function boot() {
  try {
    const status = await api("/api/auth/status");
    if (status.authenticated) await showApp(status.user, status.organization);
    else showAuth(status);
  } catch (error) {
    showAuth({ setupRequired: false });
    toast(`서버에 연결하지 못했습니다: ${error.message}`, "err");
  }
}

hooks.onUnauthorized = () => {
  if (!$("#app").classList.contains("hidden")) {
    showAuth({ setupRequired: false });
    toast("세션이 만료되었습니다. 다시 로그인해 주세요.", "err");
  }
};

/* ---------- 이벤트 배선 ----------------------------------------------------- */

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = $("#loginError");
  error.textContent = "";
  try {
    const result = await api("/api/auth/login", {
      method: "POST",
      body: { email: $("#loginEmail").value, password: $("#loginPassword").value },
    });
    await showApp(result.user, result.organization);
  } catch (problem) {
    error.textContent = problem.message;
  }
});

$("#setupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = $("#setupError");
  error.textContent = "";
  try {
    const result = await api("/api/auth/setup", {
      method: "POST",
      body: {
        organizationName: $("#setupOrganization").value,
        name: $("#setupName").value,
        email: $("#setupEmail").value,
        password: $("#setupPassword").value,
      },
    });
    await showApp(result.user, result.organization);
    await openTab("sys.connector");
  } catch (problem) {
    error.textContent = problem.message;
  }
});

$("#logoutBtn").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST", body: {} }).catch(() => {});
  ref.me = null;
  showAuth({ setupRequired: false });
});

$("#refreshAll").addEventListener("click", async () => {
  await ref.reload();
  refreshActiveTab();
});

$("#lnbToggle").addEventListener("click", () => $("#lnb").classList.toggle("open"));

document.addEventListener("keydown", (event) => {
  if (event.key === "F5" && !event.ctrlKey) { event.preventDefault(); refreshActiveTab(); }
  if (event.key === "Escape" && $("#lnb").classList.contains("open")) $("#lnb").classList.remove("open");
  // Ctrl+W 로 현재 탭 닫기 — 브라우저 탭이 아니라 업무 탭입니다.
  if (event.ctrlKey && event.key.toLowerCase() === "w" && state.activeId) {
    event.preventDefault();
    closeTab(state.activeId);
  }
});

window.addEventListener("hashchange", () => {
  const id = location.hash.slice(1);
  if (SCREENS[id] && id !== state.activeId) openTab(id);
});

/* ---------- Web MCP — 브라우저에서 AI 에이전트가 쓸 수 있는 도구 ------------- */

let mcpRegistered = false;
function registerWebMcpTools() {
  if (mcpRegistered) return;
  const context = document.modelContext;
  if (!context?.registerTool) return;
  mcpRegistered = true;
  const lifecycle = new AbortController();
  const register = (tool) =>
    Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => {});

  register({
    name: "search_electrical_parts",
    title: "전기자재 검색",
    description: "규격이나 제품명으로 전기자재를 검색하고 화면에 결과를 표시합니다.",
    inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1 } }, required: ["query"], additionalProperties: false },
    annotations: { readOnlyHint: true },
    async execute(input) {
      const result = await api(`/api/integrations/compare?q=${encodeURIComponent(input.query)}`);
      await openTab("pur.search");
      return { count: result.products.length, products: result.products.map((p) => ({ id: p.id, name: p.name, price: p.price, supplier: p.supplier })) };
    },
  });

  register({
    name: "create_purchase_request",
    title: "구매요청 생성",
    description: "품목·공사·수량·목적을 지정해 구매요청을 생성합니다.",
    inputSchema: {
      type: "object",
      properties: {
        productId: { type: "string" }, projectId: { type: "string" },
        quantity: { type: "integer", minimum: 1 }, purpose: { type: "string", minLength: 1 },
        requestedDate: { type: "string" },
      },
      required: ["productId", "projectId", "quantity", "purpose"],
      additionalProperties: false,
    },
    async execute(input) {
      const result = await api("/api/purchase-requests", { method: "POST", body: input });
      refreshBadges();
      return { requestId: result.id, status: result.status, project: result.project_name };
    },
  });

  register({
    name: "check_inventory",
    title: "재고 조회",
    description: "품목명이나 코드로 창고별 현재고·가용재고를 조회합니다.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, shortageOnly: { type: "boolean" } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
    async execute(input) {
      const rows = await api(`/api/inventory?${new URLSearchParams({
        q: input.query || "", shortageOnly: input.shortageOnly ? "1" : "",
      })}`);
      return rows.map((row) => ({
        product: row.product_name, warehouse: row.warehouse_name,
        onHand: row.on_hand, available: row.available, shortage: row.shortage,
      }));
    },
  });

  register({
    name: "list_bid_notices",
    title: "나라장터 입찰공고 조회",
    description: "기간과 업무구분으로 입찰공고를 조회합니다. 날짜 기준은 공고일 또는 마감일입니다.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "YYYY-MM-DD" },
        to: { type: "string", description: "YYYY-MM-DD" },
        kinds: { type: "array", items: { type: "string", enum: ["공사", "물품", "용역", "외자"] } },
        dateField: { type: "string", enum: ["notice_date", "close_date"] },
        keyword: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async execute(input) {
      const result = await api(`/api/bids?${new URLSearchParams({
        from: input.from || new Date().toLocaleDateString("sv-SE"),
        to: input.to || new Date().toLocaleDateString("sv-SE"),
        dateField: input.dateField || "close_date",
        kinds: (input.kinds || []).join(","),
        q: input.keyword || "",
      })}`);
      return {
        live: result.status.live,
        note: result.status.live ? "나라장터 실시간 데이터" : `샘플 데이터 — ${result.status.reason}`,
        notices: result.notices.map((notice) => ({
          title: notice.title, kind: notice.kind, closeDate: notice.close_date,
          institution: notice.notice_inst, baseAmount: notice.base_amount, url: notice.url,
        })),
      };
    },
  });
}

boot();
