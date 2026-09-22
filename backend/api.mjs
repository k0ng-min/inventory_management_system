import { randomBytes } from "node:crypto";
import {
  all, get, run, tx, moveStock, nowIso, seoulNow, today, nextDocNo,
  auditLog, setting, setSetting, passwordRecord, passwordMatches, newId, catalogFromLegacy,
} from "./db.mjs";
import {
  bidStatus, listBidNotices, bidCalendar, syncBidNotices, toggleStar, saveMemo, BID_KINDS,
} from "./g2b.mjs";
import { searchProducts, productDetail, offersFor, priceTrend, priceAlerts } from "./search.mjs";
import { ingestSupplierCatalog, rowsFromCsv } from "./ingest.mjs";
import { CATEGORIES } from "./catalog.mjs";
import { shopStatus, probe as g2bProbe, syncShoppingMall, SHOP_OPERATIONS } from "./g2b-shop.mjs";
import { supplierRestStatus, syncSupplierRest } from "./supplier-rest.mjs";
import { mallStatus, syncMall, fetchCategories, MALLS } from "./mall-scrape.mjs";
import { naverStatus, probeNaver, syncNaverShop } from "./naver-shop.mjs";
import { coupangStatus, probeCoupang, syncCoupang } from "./coupang-partners.mjs";
import { aliStatus, probeAli, syncAli } from "./ali-open.mjs";
import {
  listSchedules, createSchedule, updateSchedule, removeSchedule, calendarFeed, KINDS as SCHEDULE_KINDS,
} from "./schedule.mjs";

/* ------------------------------------------------------------------ */
/* http plumbing                                                       */
/* ------------------------------------------------------------------ */

export const sessions = new Map();
const SESSION_HOURS = 8;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (message) => { throw new HttpError(400, message); };
const forbidden = (message) => { throw new HttpError(403, message); };
const notFound = (message) => { throw new HttpError(404, message); };
export { HttpError };

function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie || "").split(";")
    .map((item) => item.trim()).filter(Boolean)
    .map((item) => {
      const index = item.indexOf("=");
      return [decodeURIComponent(item.slice(0, index)), decodeURIComponent(item.slice(index + 1))];
    }));
}

async function readBody(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 2_000_000) throw new HttpError(413, "요청 데이터가 너무 큽니다.");
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new HttpError(400, "잘못된 JSON 형식입니다."); }
}

const publicUser = (user) => user && ({
  id: user.id, name: user.name, email: user.email,
  role: user.role, active: Boolean(user.active), createdAt: user.created_at,
  scope: { finance: canFinance(user), prices: canPrices(user) },
});

function currentUser(request) {
  const token = parseCookies(request).electro_session;
  const session = token && sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) { sessions.delete(token); return null; }
  return get("SELECT * FROM users WHERE id = ? AND active = 1", session.userId) || null;
}

function createSession(response, user) {
  const token = randomBytes(32).toString("hex");
  sessions.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_HOURS * 3600_000 });
  response.setHeader("set-cookie",
    `electro_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}`);
}

/* ------------------------------------------------------------------ */
/* permissions                                                         */
/* ------------------------------------------------------------------ */

/**
 * 직원 5명 회사라 업무는 서로 대신 처리합니다. 쓰기 권한은 '직원이냐 아니냐'로만
 * 가르고, 조회 전용 계정만 빼냅니다. 시스템 설정은 사장(관리자) 몫입니다.
 */
const STAFF = ["admin", "purchasing", "warehouse"];

const ROLE_WRITE = {
  master: STAFF,       // 품목·거래처·고객·공사·창고
  purchasing: STAFF,   // 구매요청·발주
  warehouse: STAFF,    // 입고·재고이동·조정·배정·출고
  sales: STAFF,        // 매출·수금
  accounting: STAFF,   // 전표
  bids: STAFF,         // 입찰
  system: ["admin"],   // 사용자·연동·회사정보 — 관리자 전용
  schedule: STAFF,     // 팀 일정
};

/**
 * 금액 열람.
 * 구매 판단에 과거 구매가와 단가가 필요하고(요구사항 9), 5명 회사에서 금액을
 * 서로 가리면 업무가 막힙니다. 로그인한 사람은 모두 봅니다.
 * 나중에 사람이 늘어 가려야 하면 이 두 함수만 고치면 서버 응답까지 함께 막힙니다.
 */
const canFinance = () => true;
const canPrices = () => true;

const requireFinance = () => {};

/** 객체(또는 배열)에서 지정한 금액 필드를 제거합니다. */
function stripMoney(payload, fields) {
  const clean = (row) => {
    const copy = { ...row };
    for (const field of fields) delete copy[field];
    return copy;
  };
  return Array.isArray(payload) ? payload.map(clean) : clean(payload);
}

function requireRole(user, area) {
  const roles = ROLE_WRITE[area];
  if (!roles.includes(user.role)) {
    forbidden(`이 작업에는 ${roles.map(roleName).join(" 또는 ")} 권한이 필요합니다.`);
  }
}

const roleName = (role) => ({
  admin: "관리자", purchasing: "구매 담당", warehouse: "창고 담당", viewer: "조회 전용",
}[role] || role);

/* ------------------------------------------------------------------ */
/* generic CRUD factory                                                */
/* ------------------------------------------------------------------ */

const str = (value) => (value === undefined || value === null ? null : String(value).trim() || null);
const int = (value) => {
  if (value === "" || value === undefined || value === null) return 0;
  const n = Number(String(value).replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
};
const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const bool = (value) => (value ? 1 : 0);

/**
 * Declarative CRUD. `fields` maps API field name -> { column, cast, required }.
 * Returns handlers wired into the route table below.
 */
function crud({ table, prefix, area, module, label, fields, listSql, idFrom, beforeDelete, afterWrite }) {
  const columns = Object.entries(fields);

  const shape = (body, partial) => {
    const values = {};
    for (const [key, spec] of columns) {
      if (partial && !(key in body)) continue;
      const raw = body[key];
      if (spec.required && (raw === undefined || raw === null || String(raw).trim() === "")) {
        bad(`${spec.label || key} 항목은 필수입니다.`);
      }
      const value = (spec.cast || str)(raw);
      // NOT NULL 컬럼에 빈 값이 오면 컬럼 자체를 빼서 DB 기본값이 적용되게 합니다.
      if (value === null && spec.notNull) continue;
      values[spec.column] = value;
    }
    return values;
  };

  return {
    list: () => all(listSql || `SELECT * FROM ${table}`),
    create: (body, user) => {
      requireRole(user, area);
      const values = shape(body, false);
      const id = str(body.id) || (idFrom ? idFrom(body) : newId(prefix));
      if (get(`SELECT id FROM ${table} WHERE id = ?`, id)) bad(`이미 존재하는 코드입니다: ${id}`);
      const cols = ["id", ...Object.keys(values)];
      run(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
        id, ...Object.values(values));
      auditLog(user.name, module, `${label} 등록`, `${id}${body.name ? ` / ${body.name}` : ""}`);
      afterWrite?.(get(`SELECT * FROM ${table} WHERE id = ?`, id));
      return get(`SELECT * FROM ${table} WHERE id = ?`, id);
    },
    update: (id, body, user) => {
      requireRole(user, area);
      const existing = get(`SELECT * FROM ${table} WHERE id = ?`, id);
      if (!existing) notFound(`${label}을(를) 찾을 수 없습니다.`);
      const values = shape(body, true);
      if (!Object.keys(values).length) return existing;
      run(`UPDATE ${table} SET ${Object.keys(values).map((c) => `${c} = ?`).join(", ")} WHERE id = ?`,
        ...Object.values(values), id);
      auditLog(user.name, module, `${label} 수정`, id);
      afterWrite?.(get(`SELECT * FROM ${table} WHERE id = ?`, id));
      return get(`SELECT * FROM ${table} WHERE id = ?`, id);
    },
    remove: (id, user) => {
      requireRole(user, area);
      const existing = get(`SELECT * FROM ${table} WHERE id = ?`, id);
      if (!existing) notFound(`${label}을(를) 찾을 수 없습니다.`);
      if (beforeDelete) beforeDelete(existing);
      run(`DELETE FROM ${table} WHERE id = ?`, id);
      auditLog(user.name, module, `${label} 삭제`, id);
      return { ok: true, id };
    },
  };
}

const blockIfReferenced = (label, checks) => (row) => {
  for (const [sql, message] of checks) {
    if (get(sql, row.id)?.n > 0) bad(`${message} 먼저 정리한 뒤 ${label}을(를) 삭제할 수 있습니다.`);
  }
};

const resources = {
  products: crud({
    table: "products", prefix: "MAT", area: "master", module: "기준정보", label: "품목",
    listSql: "SELECT * FROM products ORDER BY active DESC, name",
    fields: {
      name: { column: "name", required: true, label: "품목명" },
      category: { column: "category", notNull: true },
      manufacturer: { column: "manufacturer" },
      model: { column: "model" },
      supplier: { column: "supplier" },
      unit: { column: "unit", notNull: true },
      unitQty: { column: "unit_qty", cast: num },
      price: { column: "price", cast: int },
      unitPrice: { column: "unit_price", cast: int },
      shipping: { column: "shipping", cast: int },
      leadTime: { column: "lead_time" },
      safetyStock: { column: "safety_stock", cast: int },
      barcode: { column: "barcode" },
      spec: { column: "spec" },
      tags: { column: "tags" },
      active: { column: "active", cast: bool },
      updatedAt: { column: "updated_at", cast: (value) => str(value) || seoulNow() },
    },
    beforeDelete: blockIfReferenced("품목", [
      ["SELECT COUNT(*) n FROM inventory_balances WHERE product_id = ? AND on_hand <> 0", "재고가 남아 있습니다."],
      ["SELECT COUNT(*) n FROM purchase_orders WHERE product_id = ? AND status <> '입고완료'", "진행 중인 발주가 있습니다."],
    ]),
    afterWrite: () => catalogFromLegacy(),
  }),
  suppliers: crud({
    table: "suppliers", prefix: "SUP", area: "master", module: "기준정보", label: "공급처",
    listSql: `SELECT s.*,
                COALESCE((SELECT SUM(amount) FROM purchase_orders
                          WHERE supplier_id = s.id AND status NOT IN ('입고완료','취소')), 0) AS open_payable,
                COALESCE((SELECT COUNT(*) FROM purchase_orders WHERE supplier_id = s.id), 0) AS order_count
              FROM suppliers s ORDER BY s.name`,
    fields: {
      name: { column: "name", required: true, label: "공급처명" },
      bizNo: { column: "biz_no" }, contact: { column: "contact" }, phone: { column: "phone" },
      email: { column: "email" }, terms: { column: "terms" }, leadTime: { column: "lead_time" },
      rating: { column: "rating", cast: num }, status: { column: "status", notNull: true }, note: { column: "note" },
    },
    beforeDelete: blockIfReferenced("공급처", [
      ["SELECT COUNT(*) n FROM purchase_orders WHERE supplier_id = ?", "연결된 발주가 있습니다."],
    ]),
  }),
  customers: crud({
    table: "customers", prefix: "CUS", area: "master", module: "기준정보", label: "고객",
    listSql: "SELECT * FROM customers ORDER BY name",
    fields: {
      name: { column: "name", required: true, label: "고객명" },
      bizNo: { column: "biz_no" }, contact: { column: "contact" }, phone: { column: "phone" },
      email: { column: "email" }, terms: { column: "terms" }, status: { column: "status", notNull: true }, note: { column: "note" },
    },
  }),
  warehouses: crud({
    table: "warehouses", prefix: "WH", area: "master", module: "기준정보", label: "창고",
    listSql: "SELECT * FROM warehouses ORDER BY active DESC, name",
    fields: {
      name: { column: "name", required: true, label: "창고명" },
      location: { column: "location" }, manager: { column: "manager" }, active: { column: "active", cast: bool },
    },
    beforeDelete: blockIfReferenced("창고", [
      ["SELECT COUNT(*) n FROM inventory_balances WHERE warehouse_id = ? AND on_hand <> 0", "재고가 남아 있습니다."],
    ]),
  }),
  projects: crud({
    table: "projects", prefix: "PRJ", area: "master", module: "공사", label: "공사",
    listSql: "SELECT * FROM projects ORDER BY status, id DESC",
    fields: {
      name: { column: "name", required: true, label: "공사명" },
      site: { column: "site" }, manager: { column: "manager" }, customer: { column: "customer" },
      status: { column: "status", notNull: true }, startDate: { column: "start_date" }, endDate: { column: "end_date" },
      budget: { column: "budget", cast: int }, progress: { column: "progress", cast: int }, note: { column: "note" },
    },
    beforeDelete: blockIfReferenced("공사", [
      ["SELECT COUNT(*) n FROM purchase_orders WHERE project_id = ?", "연결된 발주가 있습니다."],
      ["SELECT COUNT(*) n FROM sales_orders WHERE project_id = ?", "연결된 매출이 있습니다."],
    ]),
  }),
  "accounting-entries": crud({
    table: "accounting_entries", prefix: "JV", area: "accounting", module: "회계", label: "전표",
    listSql: `SELECT e.*, p.name AS project_name FROM accounting_entries e
              LEFT JOIN projects p ON p.id = e.project_id ORDER BY e.date DESC, e.id DESC`,
    idFrom: () => nextDocNo("accounting_entries", "JV"),
    fields: {
      date: { column: "date", required: true, label: "일자" },
      type: { column: "type", required: true, label: "유형" },
      account: { column: "account" }, counterparty: { column: "counterparty" },
      description: { column: "description" }, projectId: { column: "project_id" },
      debit: { column: "debit", cast: int }, credit: { column: "credit", cast: int },
      status: { column: "status", notNull: true }, createdAt: { column: "created_at", cast: (value) => str(value) || nowIso() },
    },
  }),
};

/* ------------------------------------------------------------------ */
/* domain reads                                                        */
/* ------------------------------------------------------------------ */

const INVENTORY_SQL = `
  SELECT (b.product_id || '|' || b.warehouse_id) AS id,
         b.product_id, p.catalog_product_id, b.warehouse_id, b.bin, b.on_hand, b.reserved, b.allocated, b.expected,
         b.safety_stock, b.last_movement,
         p.name AS product_name, p.unit, p.price, p.manufacturer, p.category, p.spec,
         w.name AS warehouse_name,
         (b.on_hand - b.reserved - b.allocated) AS available
  FROM inventory_balances b
  JOIN products p ON p.id = b.product_id
  JOIN warehouses w ON w.id = b.warehouse_id`;

const inventoryRows = (where = "", ...params) =>
  all(`${INVENTORY_SQL} ${where} ORDER BY p.name, w.name`, ...params)
    .map((row) => ({ ...row, shortage: row.available < row.safety_stock }));

const PO_SQL = `
  SELECT o.*, s.name AS supplier_name, pr.name AS project_name, p.name AS product_name, p.unit,
         (o.quantity - o.received) AS remaining
  FROM purchase_orders o
  LEFT JOIN suppliers s ON s.id = o.supplier_id
  LEFT JOIN projects pr ON pr.id = o.project_id
  LEFT JOIN products p ON p.id = o.product_id`;

const REQUEST_SQL = `
  SELECT r.*, pr.name AS project_name, p.name AS product_name, p.unit,
         COALESCE(r.quoted_unit_price, p.price) AS price,
         s.name AS preferred_supplier_name
  FROM purchase_requests r
  LEFT JOIN projects pr ON pr.id = r.project_id
  LEFT JOIN products p ON p.id = r.product_id
  LEFT JOIN suppliers s ON s.id = r.preferred_supplier_id`;

const SUMMARY_MONEY = ["inventoryValue", "purchaseAmount", "salesAmount", "monthSales", "monthPurchase", "receivable", "payable"];

function summary() {
  const inventory = inventoryRows();
  const receivable = get(`SELECT COALESCE(SUM(amount - received),0) AS n FROM sales_orders WHERE amount > received`).n;
  const payable = get(`SELECT COALESCE(SUM(amount),0) AS n FROM purchase_orders WHERE status <> '입고완료'`).n;
  const month = today().slice(0, 7);
  return {
    activeProjects: get("SELECT COUNT(*) n FROM projects WHERE status <> '완료'").n,
    pendingRequests: get("SELECT COUNT(*) n FROM purchase_requests WHERE status = '구매요청'").n,
    pendingApprovals: get("SELECT COUNT(*) n FROM purchase_orders WHERE status = '승인대기'").n,
    incomingOrders: get("SELECT COUNT(*) n FROM purchase_orders WHERE status IN ('발주완료','부분입고')").n,
    lowStockItems: inventory.filter((row) => row.shortage).length,
    inventoryValue: inventory.reduce((sum, row) => sum + row.on_hand * (row.price || 0), 0),
    purchaseAmount: get("SELECT COALESCE(SUM(amount),0) n FROM purchase_orders").n,
    salesAmount: get("SELECT COALESCE(SUM(amount),0) n FROM sales_orders").n,
    monthSales: get("SELECT COALESCE(SUM(amount),0) n FROM sales_orders WHERE substr(invoice_date,1,7) = ?", month).n,
    monthPurchase: get("SELECT COALESCE(SUM(debit),0) n FROM accounting_entries WHERE type IN ('매입','경비') AND substr(date,1,7) = ?", month).n,
    receivable,
    payable,
    openBids: get("SELECT COUNT(*) n FROM bid_notices WHERE date(substr(close_date,1,10)) >= date('now','localtime')").n,
    starredBids: get("SELECT COUNT(*) n FROM bid_notices WHERE starred = 1").n,
  };
}

function receipt(projectId) {
  const project = get("SELECT * FROM projects WHERE id = ?", projectId);
  if (!project) notFound("공사를 찾을 수 없습니다.");
  const items = all(`${REQUEST_SQL} WHERE r.project_id = ? ORDER BY r.created_at`, projectId)
    .map((row) => {
      const supply = (row.price || 0) * row.quantity;
      return { ...row, supply, shipping: 0, total: supply };
    });
  const supplyTotal = items.reduce((sum, item) => sum + item.supply, 0);
  const orders = all(`${PO_SQL} WHERE o.project_id = ? ORDER BY o.created_at DESC`, projectId);
  const issues = all(
    `SELECT t.*, p.name AS product_name, w.name AS warehouse_name
     FROM inventory_transactions t
     JOIN products p ON p.id = t.product_id
     JOIN warehouses w ON w.id = t.warehouse_id
     WHERE t.project_id = ? AND t.type = 'PROJECT_ISSUE' ORDER BY t.at DESC`, projectId);
  return {
    project, items, orders, issues,
    summary: {
      itemCount: items.length,
      supplyTotal,
      shippingTotal: 0,
      grandTotal: supplyTotal,
      orderTotal: orders.reduce((sum, order) => sum + order.amount, 0),
    },
  };
}

/* ------------------------------------------------------------------ */
/* domain writes                                                       */
/* ------------------------------------------------------------------ */

function createRequest(body, user) {
  requireRole(user, "purchasing");
  const requestedProductId = str(body.productId);
  let product = get("SELECT * FROM products WHERE id = ?", requestedProductId);
  const catalogProduct = get("SELECT * FROM catalog_products WHERE id = ?", requestedProductId);

  // 통합검색은 정규화 카탈로그 ID를 사용합니다. 아직 사내 품목과 연결되지 않은
  // 카탈로그 제품은 최초 구매요청 때 재고 품목을 만들고 이후부터 같은 행을 재사용합니다.
  if (!product && catalogProduct) {
    product = get("SELECT * FROM products WHERE catalog_product_id = ? AND active = 1 ORDER BY id LIMIT 1", catalogProduct.id);
    if (!product) {
      const productId = newId("MAT");
      run(`INSERT INTO products
             (id, catalog_product_id, name, category, manufacturer, unit, unit_qty,
              safety_stock, spec, active, updated_at)
           VALUES (?,?,?,?,?,?,1,?, ?,1,?)`,
        productId, catalogProduct.id, catalogProduct.name, catalogProduct.category,
        catalogProduct.manufacturer, catalogProduct.base_unit || "EA",
        catalogProduct.safety_stock || 0, catalogProduct.spec_label, seoulNow());
      product = get("SELECT * FROM products WHERE id = ?", productId);
    }
  }
  const project = get("SELECT * FROM projects WHERE id = ?", str(body.projectId));
  const quantity = int(body.quantity);
  if (!product) bad("품목을 선택해 주세요.");
  if (!project) bad("공사를 선택해 주세요.");
  if (quantity < 1) bad("수량은 1 이상이어야 합니다.");
  if (!str(body.purpose)) bad("사용 목적을 입력해 주세요.");

  const linkedCatalogId = product.catalog_product_id || catalogProduct?.id;
  let supplierProduct = null;
  if (str(body.supplierProductId)) {
    supplierProduct = get("SELECT * FROM supplier_products WHERE id = ? AND active = 1", str(body.supplierProductId));
    if (!supplierProduct || supplierProduct.product_id !== linkedCatalogId) bad("선택한 판매조건이 품목과 일치하지 않습니다.");
  }
  const preferredSupplierId = supplierProduct?.supplier_id || str(body.supplierId) || null;
  if (preferredSupplierId && !get("SELECT id FROM suppliers WHERE id = ?", preferredSupplierId)) bad("공급처를 찾을 수 없습니다.");
  const quotedUnitPrice = supplierProduct?.price ?? (body.quotedUnitPrice !== undefined ? num(body.quotedUnitPrice) : null);

  const id = nextDocNo("purchase_requests", "PUR");
  run(`INSERT INTO purchase_requests
       (id, project_id, product_id, preferred_supplier_id, supplier_product_id, quoted_unit_price,
        quantity, purpose, requested_date, status, requester, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,'구매요청',?,?)`,
    id, project.id, product.id, preferredSupplierId, supplierProduct?.id || null, quotedUnitPrice,
    quantity, str(body.purpose), str(body.requestedDate), user.name, nowIso());
  auditLog(user.name, "구매", "구매요청 생성", `${id} / ${project.name} / ${product.name} ${quantity}${product.unit}`);
  return get(`${REQUEST_SQL} WHERE r.id = ?`, id);
}

/** 구매요청 승인 → 발주서 자동 생성. 하나의 트랜잭션으로 처리합니다. */
function approveRequest(id, body, user) {
  requireRole(user, "purchasing");
  return tx(() => {
    const request = get("SELECT * FROM purchase_requests WHERE id = ?", id);
    if (!request) notFound("구매요청을 찾을 수 없습니다.");
    if (request.status !== "구매요청") bad(`이미 ${request.status} 상태입니다.`);
    const product = get("SELECT * FROM products WHERE id = ?", request.product_id);
    const supplierId = str(body.supplierId)
      || request.preferred_supplier_id
      || get("SELECT id FROM suppliers WHERE name = ?", product?.supplier)?.id
      || get("SELECT id FROM suppliers ORDER BY rating DESC LIMIT 1")?.id;
    if (!supplierId) bad("발주할 공급처가 없습니다. 기준정보에서 공급처를 먼저 등록해 주세요.");

    const unitPrice = body.unitPrice !== undefined ? int(body.unitPrice) : (request.quoted_unit_price ?? product?.price ?? 0);
    const amount = unitPrice * request.quantity;
    const orderId = nextDocNo("purchase_orders", "PO");
    const selectedOffer = request.supplier_product_id
      ? get("SELECT * FROM supplier_products WHERE id = ?", request.supplier_product_id) : null;
    run(`INSERT INTO purchase_orders
         (id, request_id, supplier_product_id, source_url, supplier_id, project_id, product_id,
          quantity, received, unit_price, amount, due_date, status, approver, created_at)
         VALUES (?,?,?,?,?,?,?,?,0,?,?,?,'발주완료',?,?)`,
      orderId, request.id, selectedOffer?.id || null, selectedOffer?.product_url || null,
      supplierId, request.project_id, request.product_id,
      request.quantity, unitPrice, amount,
      str(body.dueDate) || request.requested_date, user.name, nowIso());

    run("UPDATE purchase_requests SET status = '발주완료', approver = ?, approved_at = ? WHERE id = ?",
      user.name, nowIso(), id);

    // 입고예정 수량 반영
    const warehouseId = str(body.warehouseId) || get("SELECT id FROM warehouses WHERE active = 1 ORDER BY id LIMIT 1")?.id;
    if (warehouseId) {
      run(`INSERT INTO inventory_balances (product_id, warehouse_id, expected, safety_stock)
           VALUES (?,?,?,?)
           ON CONFLICT(product_id, warehouse_id) DO UPDATE SET expected = expected + excluded.expected`,
        request.product_id, warehouseId, request.quantity, product?.safety_stock || 0);
    }

    auditLog(user.name, "구매", "구매요청 승인·발주", `${id} → ${orderId} / ₩${amount.toLocaleString("ko-KR")}`);
    return { request: get(`${REQUEST_SQL} WHERE r.id = ?`, id), order: get(`${PO_SQL} WHERE o.id = ?`, orderId) };
  });
}

function rejectRequest(id, body, user) {
  requireRole(user, "purchasing");
  const request = get("SELECT * FROM purchase_requests WHERE id = ?", id);
  if (!request) notFound("구매요청을 찾을 수 없습니다.");
  if (request.status !== "구매요청") bad(`이미 ${request.status} 상태입니다.`);
  run("UPDATE purchase_requests SET status = '반려', approver = ?, approved_at = ? WHERE id = ?",
    user.name, nowIso(), id);
  auditLog(user.name, "구매", "구매요청 반려", `${id} / ${str(body.reason) || "사유 없음"}`);
  return get(`${REQUEST_SQL} WHERE r.id = ?`, id);
}

function createOrder(body, user) {
  requireRole(user, "purchasing");
  const product = get("SELECT * FROM products WHERE id = ?", str(body.productId));
  const supplier = get("SELECT * FROM suppliers WHERE id = ?", str(body.supplierId));
  const quantity = int(body.quantity);
  if (!product) bad("품목을 선택해 주세요.");
  if (!supplier) bad("공급처를 선택해 주세요.");
  if (quantity < 1) bad("수량은 1 이상이어야 합니다.");
  const unitPrice = body.unitPrice !== undefined ? int(body.unitPrice) : product.price;
  const id = nextDocNo("purchase_orders", "PO");
  run(`INSERT INTO purchase_orders
       (id, supplier_id, project_id, product_id, quantity, received, unit_price, amount, due_date, status, approver, created_at)
       VALUES (?,?,?,?,?,0,?,?,?,?,?,?)`,
    id, supplier.id, str(body.projectId), product.id, quantity, unitPrice,
    unitPrice * quantity, str(body.dueDate), str(body.status) || "승인대기", user.name, nowIso());
  auditLog(user.name, "구매", "발주 등록", `${id} / ${supplier.name} / ${product.name} ${quantity}`);
  return get(`${PO_SQL} WHERE o.id = ?`, id);
}

function approveOrder(id, user) {
  requireRole(user, "purchasing");
  const order = get("SELECT * FROM purchase_orders WHERE id = ?", id);
  if (!order) notFound("발주서를 찾을 수 없습니다.");
  if (order.status !== "승인대기") bad(`이미 ${order.status} 상태입니다.`);
  run("UPDATE purchase_orders SET status = '발주완료', approver = ? WHERE id = ?", user.name, id);
  auditLog(user.name, "승인", "발주 승인", `${id} / ₩${order.amount.toLocaleString("ko-KR")}`);
  return get(`${PO_SQL} WHERE o.id = ?`, id);
}

function cancelOrder(id, user) {
  requireRole(user, "purchasing");
  const order = get("SELECT * FROM purchase_orders WHERE id = ?", id);
  if (!order) notFound("발주서를 찾을 수 없습니다.");
  if (order.received > 0) bad("이미 입고된 발주는 취소할 수 없습니다. 반품으로 처리해 주세요.");
  run("UPDATE purchase_orders SET status = '취소' WHERE id = ?", id);
  auditLog(user.name, "구매", "발주 취소", id);
  return get(`${PO_SQL} WHERE o.id = ?`, id);
}

/**
 * 실제로 산 가격을 가격이력에 남깁니다.
 * 요구사항: "모든 구매가격은 기록한다" — 다음 구매 때 "지난번에 얼마였나"에
 * 즉시 답하기 위한 자산입니다. 적재·견적과 구분하려고 ref_type 을 'PO' 로 둡니다.
 *
 * 사내 품목이 정규화 카탈로그에 연결돼 있어야 제품 단위로 비교됩니다.
 * 연결이 없으면(직접 등록한 품목) 조용히 건너뜁니다 — 입고 자체를 막을 일은 아닙니다.
 */
function recordPurchasePrice(order, at, userName) {
  const product = get("SELECT catalog_product_id FROM products WHERE id = ?", order.product_id);
  const catalogId = product?.catalog_product_id;
  if (!catalogId || !order.unit_price) return;

  // 발주가 어떤 판매조건에서 나왔으면 그 판매단위를, 아니면 기본단위 1개로 환산합니다.
  const offer = order.supplier_product_id
    ? get("SELECT sell_unit, unit_qty FROM supplier_products WHERE id = ?", order.supplier_product_id)
    : null;
  const unitQty = offer?.unit_qty && offer.unit_qty > 0 ? offer.unit_qty : 1;

  run(`INSERT INTO price_history
         (product_id, supplier_id, price, unit_price, sell_unit, unit_qty, at, source, ref_type, ref_id, user)
       VALUES (?,?,?,?,?,?,?, 'purchase', 'PO', ?, ?)`,
    catalogId, order.supplier_id, order.unit_price, order.unit_price / unitQty,
    offer?.sell_unit || null, unitQty, at, order.id, userName);
}

/** 입고: 발주 수량 갱신 + 재고 증가 + 트랜잭션 기록 + 매입전표까지 한 번에. */
function receiveOrder(id, body, user) {
  requireRole(user, "warehouse");
  return tx(() => {
    const order = get("SELECT * FROM purchase_orders WHERE id = ?", id);
    if (!order) notFound("발주서를 찾을 수 없습니다.");
    if (order.status === "승인대기") bad("승인되지 않은 발주는 입고할 수 없습니다.");
    if (order.status === "취소") bad("취소된 발주입니다.");

    const quantity = int(body.quantity);
    const remaining = order.quantity - order.received;
    if (quantity < 1 || quantity > remaining) bad(`입고 가능 수량은 1 ~ ${remaining} 입니다.`);

    const warehouseId = str(body.warehouseId);
    const warehouse = get("SELECT * FROM warehouses WHERE id = ?", warehouseId);
    if (!warehouse) bad("입고 창고를 선택해 주세요.");

    const received = order.received + quantity;
    const status = received >= order.quantity ? "입고완료" : "부분입고";
    run("UPDATE purchase_orders SET received = ?, status = ? WHERE id = ?", received, status, id);

    moveStock({
      type: "PURCHASE_RECEIPT", productId: order.product_id, warehouseId,
      qty: quantity, refType: "PO", refId: id, projectId: order.project_id,
      user: user.name, note: str(body.note) || `${warehouse.name} 입고`,
    });
    run(`UPDATE inventory_balances SET expected = MAX(0, expected - ?)
         WHERE product_id = ? AND warehouse_id = ?`, quantity, order.product_id, warehouseId);
    if (str(body.bin)) {
      run("UPDATE inventory_balances SET bin = ? WHERE product_id = ? AND warehouse_id = ?",
        str(body.bin), order.product_id, warehouseId);
    }

    const receiptId = nextDocNo("goods_receipts", "GR");
    run(`INSERT INTO goods_receipts (id, order_id, warehouse_id, product_id, quantity, received_at, receiver, note)
         VALUES (?,?,?,?,?,?,?,?)`,
      receiptId, id, warehouseId, order.product_id, quantity,
      str(body.receivedAt) || today(), user.name, str(body.note));

    recordPurchasePrice(order, str(body.receivedAt) || today(), user.name);

    // 매입 전표 자동 기표
    const supplier = get("SELECT name FROM suppliers WHERE id = ?", order.supplier_id);
    const amount = order.unit_price * quantity;
    const entryId = nextDocNo("accounting_entries", "JV");
    run(`INSERT INTO accounting_entries
         (id, date, type, account, counterparty, description, project_id, debit, credit, status, created_at)
         VALUES (?,?,'매입','공사재료비',?,?,?,?,0,'검토',?)`,
      entryId, str(body.receivedAt) || today(), supplier?.name || "",
      `${id} 입고 ${quantity}`, order.project_id, amount, nowIso());

    auditLog(user.name, "입고", "입고 처리", `${id} / ${quantity} / ${warehouse.name}`);
    return {
      order: get(`${PO_SQL} WHERE o.id = ?`, id),
      receiptId,
      entryId,
      inventory: inventoryRows("WHERE b.product_id = ? AND b.warehouse_id = ?", order.product_id, warehouseId)[0],
    };
  });
}

function transferStock(body, user) {
  requireRole(user, "warehouse");
  return tx(() => {
    const productId = str(body.productId);
    const from = str(body.fromWarehouse);
    const to = str(body.toWarehouse);
    const quantity = int(body.quantity);
    if (!get("SELECT id FROM products WHERE id = ?", productId)) bad("품목을 선택해 주세요.");
    if (!from || !to) bad("출발 창고와 도착 창고를 선택해 주세요.");
    if (from === to) bad("출발 창고와 도착 창고가 같습니다.");
    if (quantity < 1) bad("이동 수량은 1 이상이어야 합니다.");

    const id = nextDocNo("stock_transfers", "MV");
    moveStock({ type: "TRANSFER_OUT", productId, warehouseId: from, qty: quantity, refType: "TRANSFER", refId: id, user: user.name, note: str(body.note) });
    moveStock({ type: "TRANSFER_IN", productId, warehouseId: to, qty: quantity, refType: "TRANSFER", refId: id, user: user.name, note: str(body.note) });
    run(`INSERT INTO stock_transfers (id, product_id, from_warehouse, to_warehouse, quantity, moved_at, user, note)
         VALUES (?,?,?,?,?,?,?,?)`,
      id, productId, from, to, quantity, str(body.movedAt) || today(), user.name, str(body.note));

    const fromName = get("SELECT name FROM warehouses WHERE id = ?", from)?.name;
    const toName = get("SELECT name FROM warehouses WHERE id = ?", to)?.name;
    auditLog(user.name, "재고", "재고 이동", `${id} / ${fromName} → ${toName} / ${quantity}`);
    return get(`SELECT t.*, p.name AS product_name, f.name AS from_name, w.name AS to_name
                FROM stock_transfers t
                LEFT JOIN products p ON p.id = t.product_id
                LEFT JOIN warehouses f ON f.id = t.from_warehouse
                LEFT JOIN warehouses w ON w.id = t.to_warehouse WHERE t.id = ?`, id);
  });
}

/** 실사 조정: 실제 수량을 입력하면 차이만큼 가감 트랜잭션을 남깁니다. */
function adjustStock(body, user) {
  requireRole(user, "warehouse");
  return tx(() => {
    const productId = str(body.productId);
    const warehouseId = str(body.warehouseId);
    const afterQty = int(body.afterQty);
    if (!productId || !warehouseId) bad("품목과 창고를 선택해 주세요.");
    if (afterQty < 0) bad("실사 수량은 0 이상이어야 합니다.");
    if (!str(body.reason)) bad("조정 사유를 입력해 주세요.");

    const balance = get("SELECT on_hand FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?", productId, warehouseId);
    const beforeQty = balance?.on_hand || 0;
    const diff = afterQty - beforeQty;
    if (diff === 0) bad("현재고와 실사 수량이 같습니다.");

    const id = nextDocNo("stock_adjustments", "AJ");
    moveStock({
      type: diff > 0 ? "ADJUST_IN" : "ADJUST_OUT", productId, warehouseId,
      qty: Math.abs(diff), refType: "ADJUST", refId: id, user: user.name, note: str(body.reason),
    });
    run(`INSERT INTO stock_adjustments (id, product_id, warehouse_id, before_qty, after_qty, diff, reason, adjusted_at, user)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      id, productId, warehouseId, beforeQty, afterQty, diff, str(body.reason), str(body.adjustedAt) || today(), user.name);
    auditLog(user.name, "재고", "재고 조정", `${id} / ${beforeQty} → ${afterQty} (${diff > 0 ? "+" : ""}${diff})`);
    return get(`SELECT a.*, p.name AS product_name, w.name AS warehouse_name
                FROM stock_adjustments a
                LEFT JOIN products p ON p.id = a.product_id
                LEFT JOIN warehouses w ON w.id = a.warehouse_id WHERE a.id = ?`, id);
  });
}

/** 공사별 자재 예약(배정). 실물은 그대로 두고 가용재고만 줄입니다. */
function allocate(body, user) {
  requireRole(user, "warehouse");
  return tx(() => {
    const productId = str(body.productId);
    const warehouseId = str(body.warehouseId);
    const projectId = str(body.projectId);
    const quantity = int(body.quantity);
    if (!productId || !warehouseId || !projectId) bad("공사, 품목, 창고를 모두 선택해 주세요.");
    if (quantity < 1) bad("배정 수량은 1 이상이어야 합니다.");

    const balance = get("SELECT * FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?", productId, warehouseId);
    if (!balance) bad("해당 창고에 품목 재고가 없습니다.");
    const available = balance.on_hand - balance.reserved - balance.allocated;
    if (quantity > available) bad(`가용재고가 부족합니다. 가용 ${available}, 요청 ${quantity}`);

    const id = nextDocNo("project_allocations", "AL");
    run("UPDATE inventory_balances SET allocated = allocated + ? WHERE product_id = ? AND warehouse_id = ?",
      quantity, productId, warehouseId);
    run(`INSERT INTO project_allocations (id, project_id, product_id, warehouse_id, quantity, used, status, allocated_at, user, note)
         VALUES (?,?,?,?,?,0,'예약',?,?,?)`,
      id, projectId, productId, warehouseId, quantity, str(body.allocatedAt) || today(), user.name, str(body.note));
    auditLog(user.name, "재고", "공사 자재 배정", `${id} / ${quantity}`);
    return get(`SELECT a.*, p.name AS product_name, w.name AS warehouse_name, pr.name AS project_name
                FROM project_allocations a
                LEFT JOIN products p ON p.id = a.product_id
                LEFT JOIN warehouses w ON w.id = a.warehouse_id
                LEFT JOIN projects pr ON pr.id = a.project_id WHERE a.id = ?`, id);
  });
}

/** 배정분 출고(사용). 실재고와 배정량을 함께 차감합니다. */
function issueAllocation(id, body, user) {
  requireRole(user, "warehouse");
  return tx(() => {
    const allocation = get("SELECT * FROM project_allocations WHERE id = ?", id);
    if (!allocation) notFound("배정 내역을 찾을 수 없습니다.");
    const quantity = int(body.quantity);
    const remaining = allocation.quantity - allocation.used;
    if (quantity < 1 || quantity > remaining) bad(`출고 가능 수량은 1 ~ ${remaining} 입니다.`);

    moveStock({
      type: "PROJECT_ISSUE", productId: allocation.product_id, warehouseId: allocation.warehouse_id,
      qty: quantity, refType: "ALLOCATION", refId: id, projectId: allocation.project_id,
      user: user.name, note: str(body.note) || "공사 사용 출고",
    });
    run("UPDATE inventory_balances SET allocated = MAX(0, allocated - ?) WHERE product_id = ? AND warehouse_id = ?",
      quantity, allocation.product_id, allocation.warehouse_id);
    const used = allocation.used + quantity;
    run("UPDATE project_allocations SET used = ?, status = ? WHERE id = ?",
      used, used >= allocation.quantity ? "사용완료" : "일부사용", id);
    auditLog(user.name, "재고", "공사 자재 출고", `${id} / ${quantity}`);
    return get(`SELECT a.*, p.name AS product_name, w.name AS warehouse_name, pr.name AS project_name
                FROM project_allocations a
                LEFT JOIN products p ON p.id = a.product_id
                LEFT JOIN warehouses w ON w.id = a.warehouse_id
                LEFT JOIN projects pr ON pr.id = a.project_id WHERE a.id = ?`, id);
  });
}

function releaseAllocation(id, user) {
  requireRole(user, "warehouse");
  return tx(() => {
    const allocation = get("SELECT * FROM project_allocations WHERE id = ?", id);
    if (!allocation) notFound("배정 내역을 찾을 수 없습니다.");
    const remaining = allocation.quantity - allocation.used;
    if (remaining > 0) {
      run("UPDATE inventory_balances SET allocated = MAX(0, allocated - ?) WHERE product_id = ? AND warehouse_id = ?",
        remaining, allocation.product_id, allocation.warehouse_id);
    }
    run("UPDATE project_allocations SET status = '해제' WHERE id = ?", id);
    auditLog(user.name, "재고", "공사 배정 해제", `${id} / ${remaining}`);
    return { ok: true, id, released: remaining };
  });
}

function createSalesOrder(body, user) {
  requireRole(user, "sales");
  const amount = int(body.amount);
  if (!str(body.customer)) bad("거래처를 입력해 주세요.");
  if (amount <= 0) bad("매출금액을 입력해 주세요.");
  const id = nextDocNo("sales_orders", "SO");
  run(`INSERT INTO sales_orders (id, project_id, customer, description, amount, received, invoice_date, due_date, status, created_at)
       VALUES (?,?,?,?,?,0,?,?,?,?)`,
    id, str(body.projectId), str(body.customer), str(body.description), amount,
    str(body.invoiceDate) || today(), str(body.dueDate), str(body.status) || "승인완료", nowIso());
  auditLog(user.name, "영업", "매출 등록", `${id} / ₩${amount.toLocaleString("ko-KR")}`);
  return get(`SELECT s.*, p.name AS project_name FROM sales_orders s LEFT JOIN projects p ON p.id = s.project_id WHERE s.id = ?`, id);
}

/** 수금 등록 → 매출 수금액 누적 + 상태 전환 + 수금 전표 생성. */
function createPayment(body, user) {
  requireRole(user, "sales");
  return tx(() => {
    const order = get("SELECT * FROM sales_orders WHERE id = ?", str(body.salesOrderId));
    if (!order) bad("매출 건을 선택해 주세요.");
    const amount = int(body.amount);
    const remaining = order.amount - order.received;
    if (amount < 1 || amount > remaining) bad(`수금 가능 금액은 1 ~ ${remaining.toLocaleString("ko-KR")} 입니다.`);

    const id = nextDocNo("payments", "RC");
    const paidAt = str(body.paidAt) || today();
    run("INSERT INTO payments (id, sales_order_id, amount, paid_at, method, note) VALUES (?,?,?,?,?,?)",
      id, order.id, amount, paidAt, str(body.method) || "계좌이체", str(body.note));
    const received = order.received + amount;
    run("UPDATE sales_orders SET received = ?, status = ? WHERE id = ?",
      received, received >= order.amount ? "수금완료" : "부분수금", order.id);

    const entryId = nextDocNo("accounting_entries", "JV");
    run(`INSERT INTO accounting_entries (id, date, type, account, counterparty, description, project_id, debit, credit, status, created_at)
         VALUES (?,?,'수금','보통예금',?,?,?,?,0,'승인',?)`,
      entryId, paidAt, order.customer, `${order.id} 수금`, order.project_id, amount, nowIso());

    auditLog(user.name, "영업", "수금 등록", `${id} / ${order.id} / ₩${amount.toLocaleString("ko-KR")}`);
    return { payment: get("SELECT * FROM payments WHERE id = ?", id), order: get("SELECT * FROM sales_orders WHERE id = ?", order.id), entryId };
  });
}

/* ------------------------------------------------------------------ */
/* reports                                                             */
/* ------------------------------------------------------------------ */

function reports(url) {
  const from = url.searchParams.get("from") || `${today().slice(0, 4)}-01-01`;
  const to = url.searchParams.get("to") || today();
  return {
    range: { from, to },
    purchaseBySupplier: all(
      `SELECT s.name AS label, COUNT(*) AS count, COALESCE(SUM(o.amount),0) AS amount
       FROM purchase_orders o LEFT JOIN suppliers s ON s.id = o.supplier_id
       WHERE date(substr(o.created_at,1,10)) BETWEEN date(?) AND date(?)
       GROUP BY s.name ORDER BY amount DESC`, from, to),
    purchaseByMonth: all(
      `SELECT substr(created_at,1,7) AS label, COALESCE(SUM(amount),0) AS amount, COUNT(*) AS count
       FROM purchase_orders GROUP BY label ORDER BY label`),
    salesByMonth: all(
      `SELECT substr(invoice_date,1,7) AS label, COALESCE(SUM(amount),0) AS amount,
              COALESCE(SUM(received),0) AS received, COUNT(*) AS count
       FROM sales_orders WHERE invoice_date IS NOT NULL GROUP BY label ORDER BY label`),
    projectMargin: all(
      `SELECT p.id, p.name AS label, p.status,
              COALESCE((SELECT SUM(amount) FROM purchase_orders WHERE project_id = p.id),0) AS cost,
              COALESCE((SELECT SUM(amount) FROM sales_orders WHERE project_id = p.id),0) AS sales
       FROM projects p ORDER BY sales DESC`),
    stockTurnover: all(
      `SELECT p.name AS label, p.id,
              COALESCE((SELECT SUM(on_hand) FROM inventory_balances WHERE product_id = p.id),0) AS on_hand,
              COALESCE((SELECT SUM(ABS(qty)) FROM inventory_transactions WHERE product_id = p.id AND qty < 0),0) AS issued,
              COALESCE((SELECT SUM(qty) FROM inventory_transactions WHERE product_id = p.id AND qty > 0),0) AS received
       FROM products p ORDER BY issued DESC`),
    deadStock: inventoryRows("WHERE b.on_hand > 0 AND (b.last_movement IS NULL OR date(b.last_movement) < date('now','-30 day'))"),
    lowStock: inventoryRows("WHERE (b.on_hand - b.reserved - b.allocated) < b.safety_stock"),
  };
}

/* ------------------------------------------------------------------ */
/* router                                                              */
/* ------------------------------------------------------------------ */

const json = (response, status, payload, headers = {}) => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(payload));
};

const seg = (url, index) => decodeURIComponent(url.pathname.split("/")[index] || "");

export async function handleApi(request, response, url) {
  const method = request.method;
  const path = url.pathname;
  const body = ["POST", "PUT", "PATCH"].includes(method) ? await readBody(request) : {};

  /* ---- public ---- */
  if (method === "GET" && path === "/api/health") return json(response, 200, { ok: true, at: nowIso() });

  if (method === "GET" && path === "/api/auth/status") {
    const user = currentUser(request);
    return json(response, 200, {
      setupRequired: get("SELECT COUNT(*) n FROM users").n === 0,
      authenticated: Boolean(user),
      user: publicUser(user),
      organization: organization(),
    });
  }

  if (method === "POST" && path === "/api/auth/setup") {
    if (get("SELECT COUNT(*) n FROM users").n > 0) throw new HttpError(409, "초기 관리자 설정이 이미 완료되었습니다.");
    validateNewUser(body);
    if (!str(body.organizationName)) bad("회사명을 입력해 주세요.");
    const record = passwordRecord(body.password);
    const id = newId("USR");
    run(`INSERT INTO users (id, name, email, role, active, password_salt, password_hash, created_at)
         VALUES (?,?,?,'admin',1,?,?,?)`,
      id, str(body.name), str(body.email).toLowerCase(), record.salt, record.hash, nowIso());
    setSetting("organization.name", str(body.organizationName));
    setSetting("organization.dataMode", "integration");
    const user = get("SELECT * FROM users WHERE id = ?", id);
    createSession(response, user);
    auditLog(user.name, "시스템", "초기 관리자 설정", user.email);
    return json(response, 201, { user: publicUser(user), organization: organization() });
  }

  if (method === "POST" && path === "/api/auth/login") {
    const user = get("SELECT * FROM users WHERE email = ? AND active = 1", String(body.email || "").trim().toLowerCase());
    if (!user || !passwordMatches(String(body.password || ""), user)) {
      throw new HttpError(401, "이메일 또는 비밀번호가 맞지 않습니다.");
    }
    createSession(response, user);
    auditLog(user.name, "시스템", "로그인", user.email);
    return json(response, 200, { user: publicUser(user), organization: organization() });
  }

  if (method === "POST" && path === "/api/auth/logout") {
    const token = parseCookies(request).electro_session;
    if (token) sessions.delete(token);
    return json(response, 200, { ok: true },
      { "set-cookie": "electro_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
  }

  /* ---- everything below requires a session ---- */
  const user = currentUser(request);
  if (!user) throw new HttpError(401, "로그인이 필요합니다.");

  if (method === "GET" && path === "/api/auth/me") {
    return json(response, 200, { user: publicUser(user), organization: organization() });
  }
  if (method === "GET" && path === "/api/auth/scope") {
    return json(response, 200, { finance: canFinance(user), prices: canPrices(user) });
  }
  if (method === "POST" && path === "/api/auth/password") {
    if (!passwordMatches(String(body.current || ""), user)) throw new HttpError(401, "현재 비밀번호가 맞지 않습니다.");
    if (String(body.next || "").length < 10) bad("새 비밀번호는 10자 이상이어야 합니다.");
    const record = passwordRecord(body.next);
    run("UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?", record.salt, record.hash, user.id);
    auditLog(user.name, "시스템", "비밀번호 변경", user.email);
    return json(response, 200, { ok: true });
  }

  /* ---- generic CRUD resources ---- */
  // 품목 단가와 공사 도급액은 권한에 따라 목록 응답에서 지웁니다.
  const LIST_MONEY = {
    products: ["price", "unit_price", "shipping"],
    projects: ["budget"],
    suppliers: ["open_payable"],
  };

  const crudMatch = /^\/api\/(products|suppliers|customers|warehouses|projects|accounting-entries)(?:\/([^/]+))?$/.exec(path);
  if (crudMatch) {
    if (crudMatch[1] === "accounting-entries") requireFinance(user);
    const resource = resources[crudMatch[1]];
    const id = crudMatch[2] && decodeURIComponent(crudMatch[2]);
    if (method === "GET" && !id) {
      const rows = resource.list();
      if (crudMatch[1] === "projects" && !canFinance(user)) return json(response, 200, stripMoney(rows, LIST_MONEY.projects));
      if (crudMatch[1] === "products" && !canPrices(user)) return json(response, 200, stripMoney(rows, LIST_MONEY.products));
      if (crudMatch[1] === "suppliers" && !canFinance(user)) return json(response, 200, stripMoney(rows, LIST_MONEY.suppliers));
      return json(response, 200, rows);
    }
    if (method === "POST" && !id) return json(response, 201, resource.create(body, user));
    if (method === "PUT" && id) return json(response, 200, resource.update(id, body, user));
    if (method === "DELETE" && id) return json(response, 200, resource.remove(id, user));
  }

  /* ---- dashboards & reads ---- */
  if (method === "GET" && path === "/api/summary") {
    const data = summary();
    return json(response, 200, canFinance(user) ? data : stripMoney(data, SUMMARY_MONEY));
  }
  if (method === "GET" && path === "/api/reports") {
    const data = reports(url);
    if (canFinance(user)) return json(response, 200, data);
    // 금액이 들어간 분석은 통째로 빼고, 수량 기반 분석만 돌려줍니다.
    return json(response, 200, {
      range: data.range,
      stockTurnover: data.stockTurnover,
      deadStock: stripMoney(data.deadStock, ["price"]),
      lowStock: stripMoney(data.lowStock, ["price"]),
      financeHidden: true,
    });
  }

  if (method === "GET" && path === "/api/inventory") {
    const warehouse = url.searchParams.get("warehouse");
    const keyword = (url.searchParams.get("q") || "").trim();
    const clauses = [];
    const params = [];
    if (warehouse) { clauses.push("b.warehouse_id = ?"); params.push(warehouse); }
    if (keyword) { clauses.push("(p.name LIKE ? OR p.id LIKE ? OR p.manufacturer LIKE ?)"); params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`); }
    if (url.searchParams.get("shortageOnly") === "1") clauses.push("(b.on_hand - b.reserved - b.allocated) < b.safety_stock");
    const rows = inventoryRows(clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", ...params);
    return json(response, 200, canPrices(user) ? rows : stripMoney(rows, ["price"]));
  }

  if (method === "GET" && path === "/api/inventory/transactions") {
    const clauses = [];
    const params = [];
    for (const [key, column] of [["productId", "t.product_id"], ["warehouseId", "t.warehouse_id"], ["projectId", "t.project_id"], ["type", "t.type"]]) {
      const value = url.searchParams.get(key);
      if (value) { clauses.push(`${column} = ?`); params.push(value); }
    }
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (from) { clauses.push("date(substr(t.at,1,10)) >= date(?)"); params.push(from); }
    if (to) { clauses.push("date(substr(t.at,1,10)) <= date(?)"); params.push(to); }
    return json(response, 200, all(
      `SELECT t.*, p.name AS product_name, p.unit, w.name AS warehouse_name, pr.name AS project_name
       FROM inventory_transactions t
       LEFT JOIN products p ON p.id = t.product_id
       LEFT JOIN warehouses w ON w.id = t.warehouse_id
       LEFT JOIN projects pr ON pr.id = t.project_id
       ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY t.id DESC LIMIT 500`, ...params));
  }

  if (method === "GET" && path === "/api/purchase-requests") {
    const rows = all(`${REQUEST_SQL} ORDER BY r.created_at DESC`);
    return json(response, 200, canPrices(user) ? rows : stripMoney(rows, ["price"]));
  }
  if (method === "GET" && path === "/api/purchase-orders") {
    const rows = all(`${PO_SQL} ORDER BY o.id DESC`);
    return json(response, 200, canPrices(user) ? rows : stripMoney(rows, ["unit_price", "amount"]));
  }
  if (method === "GET" && path === "/api/goods-receipts") {
    return json(response, 200, all(
      `SELECT g.*, p.name AS product_name, w.name AS warehouse_name, o.supplier_id, s.name AS supplier_name
       FROM goods_receipts g
       LEFT JOIN products p ON p.id = g.product_id
       LEFT JOIN warehouses w ON w.id = g.warehouse_id
       LEFT JOIN purchase_orders o ON o.id = g.order_id
       LEFT JOIN suppliers s ON s.id = o.supplier_id
       ORDER BY g.received_at DESC, g.id DESC`));
  }
  if (method === "GET" && path === "/api/stock-transfers") {
    return json(response, 200, all(
      `SELECT t.*, p.name AS product_name, f.name AS from_name, w.name AS to_name
       FROM stock_transfers t
       LEFT JOIN products p ON p.id = t.product_id
       LEFT JOIN warehouses f ON f.id = t.from_warehouse
       LEFT JOIN warehouses w ON w.id = t.to_warehouse ORDER BY t.moved_at DESC, t.id DESC`));
  }
  if (method === "GET" && path === "/api/stock-adjustments") {
    return json(response, 200, all(
      `SELECT a.*, p.name AS product_name, w.name AS warehouse_name
       FROM stock_adjustments a
       LEFT JOIN products p ON p.id = a.product_id
       LEFT JOIN warehouses w ON w.id = a.warehouse_id ORDER BY a.adjusted_at DESC, a.id DESC`));
  }
  if (method === "GET" && path === "/api/allocations") {
    return json(response, 200, all(
      `SELECT a.*, p.name AS product_name, p.unit, w.name AS warehouse_name, pr.name AS project_name,
              (a.quantity - a.used) AS remaining
       FROM project_allocations a
       LEFT JOIN products p ON p.id = a.product_id
       LEFT JOIN warehouses w ON w.id = a.warehouse_id
       LEFT JOIN projects pr ON pr.id = a.project_id ORDER BY a.allocated_at DESC, a.id DESC`));
  }
  if (method === "GET" && path === "/api/sales-orders") {
    requireFinance(user);
    return json(response, 200, all(
      `SELECT s.*, p.name AS project_name, (s.amount - s.received) AS outstanding
       FROM sales_orders s LEFT JOIN projects p ON p.id = s.project_id ORDER BY s.invoice_date DESC, s.id DESC`));
  }
  if (method === "GET" && path === "/api/payments") {
    requireFinance(user);
    return json(response, 200, all(
      `SELECT pm.*, s.customer, s.project_id, pr.name AS project_name
       FROM payments pm
       LEFT JOIN sales_orders s ON s.id = pm.sales_order_id
       LEFT JOIN projects pr ON pr.id = s.project_id ORDER BY pm.paid_at DESC, pm.id DESC`));
  }
  if (method === "GET" && path === "/api/audit-logs") {
    return json(response, 200, all("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 300"));
  }
  if (method === "GET" && path.startsWith("/api/receipts/")) {
    requireFinance(user);
    return json(response, 200, receipt(seg(url, 3)));
  }

  /* ---- 팀 공유 일정 · 달력 ---- */

  if (method === "GET" && path === "/api/schedules") {
    return json(response, 200, listSchedules({
      from: url.searchParams.get("from") || undefined,
      to: url.searchParams.get("to") || undefined,
      kind: url.searchParams.get("kind") || undefined,
    }));
  }

  // 달력 한 장에 필요한 것(일정·공사기간·입찰마감)을 한 번에 내려 줍니다.
  if (method === "GET" && path === "/api/calendar") {
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (!from || !to) bad("조회 기간(from·to)이 필요합니다.");
    return json(response, 200, calendarFeed({ from, to, isAdmin: true }));
  }

  if (method === "POST" && path === "/api/schedules") {
    requireRole(user, "schedule");
    return json(response, 201, createSchedule(body, user.name));
  }

  if (method === "PUT" && /^\/api\/schedules\/[^/]+$/.test(path)) {
    requireRole(user, "schedule");
    return json(response, 200, updateSchedule(seg(url, 3), body, user.name));
  }

  if (method === "DELETE" && /^\/api\/schedules\/[^/]+$/.test(path)) {
    requireRole(user, "schedule");
    return json(response, 200, removeSchedule(seg(url, 3), user.name));
  }

  /* ---- 카탈로그: 통합검색 · 업체별 가격비교 ---- */

  if (method === "GET" && path === "/api/catalog/categories") {
    return json(response, 200, CATEGORIES);
  }

  if (method === "GET" && path === "/api/catalog/search") {
    const result = searchProducts({
      query: url.searchParams.get("q") || "",
      category: url.searchParams.get("category") || "",
      sort: url.searchParams.get("sort") || "match",
      inStockOnly: url.searchParams.get("inStock") === "1",
      limit: Math.min(200, Number(url.searchParams.get("limit")) || 60),
    });
    // 단가를 볼 수 없는 역할에는 가격을 지우고 '업체 수'만 남깁니다.
    if (!canPrices(user)) {
      result.products = result.products.map((row) => stripMoney(row, ["best_unit_price"]));
    }
    return json(response, 200, result);
  }

  if (method === "GET" && /^\/api\/catalog\/products\/[^/]+$/.test(path)) {
    const detail = productDetail(seg(url, 4));
    if (!detail) notFound("제품을 찾을 수 없습니다.");
    if (!canPrices(user)) {
      detail.offers = [];
      detail.trend = [];
      detail.lastPurchase = null;
      detail.pricesHidden = true;
    }
    return json(response, 200, detail);
  }

  // 업체별 단가는 조회입니다. 쓰기 권한과 묶지 않습니다.
  if (method === "GET" && /^\/api\/catalog\/products\/[^/]+\/offers$/.test(path)) {
    return json(response, 200, offersFor(seg(url, 4)));
  }

  if (method === "GET" && /^\/api\/catalog\/products\/[^/]+\/trend$/.test(path)) {
    requireFinance(user);
    return json(response, 200, priceTrend(seg(url, 4)));
  }

  if (method === "GET" && path === "/api/catalog/price-alerts") {
    requireFinance(user);
    return json(response, 200, priceAlerts({
      days: Number(url.searchParams.get("days")) || 30,
      threshold: Number(url.searchParams.get("threshold")) || 5,
    }));
  }

  if (method === "GET" && path === "/api/catalog/products") {
    const rows = all(`
      SELECT c.*,
             (SELECT COUNT(*) FROM supplier_products WHERE product_id = c.id AND active = 1) AS supplier_count,
             (SELECT MIN(price / unit_qty) FROM supplier_products WHERE product_id = c.id AND active = 1) AS best_unit_price
      FROM catalog_products c ORDER BY c.category, c.name`);
    return json(response, 200, canPrices(user) ? rows : stripMoney(rows, ["best_unit_price"]));
  }

  /* ---- 공급처 판매품목 적재 ---- */

  if (method === "POST" && path === "/api/catalog/import/preview") {
    requireRole(user, "master");
    const parsed = rowsFromCsv(String(body.csv || ""));
    return json(response, 200, {
      headers: parsed.headers,
      mapped: parsed.map,
      ...ingestSupplierCatalog({
        supplierId: str(body.supplierId), rows: parsed.rows,
        filename: str(body.filename), user: user.name, dryRun: true,
        catalogOnly: bool(body.catalogOnly),
      }),
    });
  }

  if (method === "POST" && path === "/api/catalog/import") {
    requireRole(user, "master");
    const parsed = rowsFromCsv(String(body.csv || ""));
    return json(response, 201, ingestSupplierCatalog({
      supplierId: str(body.supplierId), rows: parsed.rows,
      filename: str(body.filename), user: user.name,
      catalogOnly: bool(body.catalogOnly),   // 단가 열이 없는 품목 목록도 받습니다
    }));
  }

  if (method === "GET" && path === "/api/catalog/imports") {
    return json(response, 200, all(`
      SELECT i.*, s.name AS supplier_name
      FROM catalog_imports i LEFT JOIN suppliers s ON s.id = i.supplier_id
      ORDER BY i.at DESC LIMIT 100`));
  }

  /* ---- 나라장터 종합쇼핑몰 (공식 오픈API) ---- */

  if (method === "GET" && path === "/api/catalog/g2b/status") {
    return json(response, 200, { ...shopStatus(), operations: SHOP_OPERATIONS });
  }

  if (method === "POST" && path === "/api/catalog/g2b/probe") {
    requireRole(user, "master");
    return json(response, 200, await g2bProbe({
      keyword: str(body.keyword) || "전선",
      operationKey: str(body.operation) || "MAS",
    }));
  }

  if (method === "POST" && path === "/api/catalog/g2b/sync") {
    requireRole(user, "master");
    return json(response, 200, await syncShoppingMall({
      keyword: str(body.keyword),
      classNo: str(body.classNo),
      operationKey: str(body.operation) || "MAS",
      maxRows: Math.min(5000, int(body.maxRows) || 1000),
      user: user.name,
    }));
  }

  if (method === "GET" && path === "/api/catalog/supplier-rest/status") {
    return json(response, 200, supplierRestStatus());
  }

  if (method === "POST" && path === "/api/catalog/supplier-rest/sync") {
    requireRole(user, "master");
    return json(response, 200, await syncSupplierRest({
      query: str(body.query), limit: Math.min(5000, int(body.limit) || 1000), user: user.name,
    }));
  }

  /* ---- 가격비교 소스: 자재몰 수집 · 네이버 · 쿠팡 · 알리 ---- */

  // 화면이 소스 상태를 한 번에 그리도록 묶어서 돌려줍니다.
  if (method === "GET" && path === "/api/catalog/sources") {
    return json(response, 200, {
      mall: { ...mallStatus(), kind: "scrape", label: "온라인 자재몰 수집" },
      naver: { ...naverStatus(), kind: "api", label: "네이버 쇼핑 검색" },
      coupang: { ...coupangStatus(), kind: "api", label: "쿠팡 파트너스" },
      ali: { ...aliStatus(), kind: "api", label: "알리익스프레스 오픈API" },
      g2b: { ...shopStatus(), kind: "api", label: "나라장터 종합쇼핑몰" },
      supplierRest: { ...supplierRestStatus(), kind: "api", label: "계약 공급처 REST" },
    });
  }

  if (method === "GET" && path === "/api/catalog/mall/status") {
    return json(response, 200, mallStatus());
  }

  // 카테고리는 몰 개편에 따라 바뀌므로 사이트에서 직접 읽어 옵니다.
  if (method === "GET" && path === "/api/catalog/mall/categories") {
    const mallId = url.searchParams.get("mallId") || MALLS[0]?.id;
    return json(response, 200, await fetchCategories(mallId));
  }

  if (method === "POST" && path === "/api/catalog/mall/sync") {
    requireRole(user, "master");
    return json(response, 200, await syncMall({
      mallId: str(body.mallId) || MALLS[0]?.id,
      categoryNo: str(body.categoryNo),
      pages: Math.min(20, int(body.pages) || 1),
      detail: body.detail !== false,
      dryRun: bool(body.dryRun),
      user: user.name,
    }));
  }

  if (method === "GET" && path === "/api/catalog/naver/status") {
    return json(response, 200, naverStatus());
  }

  if (method === "POST" && path === "/api/catalog/naver/probe") {
    requireRole(user, "master");
    return json(response, 200, await probeNaver({ query: str(body.query) || "CV 케이블" }));
  }

  if (method === "POST" && path === "/api/catalog/naver/sync") {
    requireRole(user, "master");
    return json(response, 200, await syncNaverShop({
      query: str(body.query),
      maxRows: Math.min(1000, int(body.maxRows) || 300),
      sort: ["sim", "date", "asc", "dsc"].includes(str(body.sort)) ? str(body.sort) : "asc",
      dryRun: bool(body.dryRun),
      user: user.name,
    }));
  }

  if (method === "GET" && path === "/api/catalog/coupang/status") {
    return json(response, 200, coupangStatus());
  }

  if (method === "POST" && path === "/api/catalog/coupang/probe") {
    requireRole(user, "master");
    return json(response, 200, await probeCoupang({ keyword: str(body.query) || "전선" }));
  }

  if (method === "POST" && path === "/api/catalog/coupang/sync") {
    requireRole(user, "master");
    return json(response, 200, await syncCoupang({
      query: str(body.query), maxRows: Math.min(100, int(body.maxRows) || 100),
      dryRun: bool(body.dryRun), user: user.name,
    }));
  }

  if (method === "GET" && path === "/api/catalog/ali/status") {
    return json(response, 200, aliStatus());
  }

  if (method === "POST" && path === "/api/catalog/ali/probe") {
    requireRole(user, "master");
    return json(response, 200, await probeAli({ keyword: str(body.query) || "cable" }));
  }

  if (method === "POST" && path === "/api/catalog/ali/sync") {
    requireRole(user, "master");
    return json(response, 200, await syncAli({
      query: str(body.query), maxRows: Math.min(500, int(body.maxRows) || 100),
      dryRun: bool(body.dryRun), user: user.name,
    }));
  }

  /* ---- 공급처 판매정보 직접 수정 ---- */

  if (method === "POST" && path === "/api/supplier-products") {
    requireRole(user, "master");
    const productId = str(body.productId);
    const supplierId = str(body.supplierId);
    if (!get("SELECT id FROM catalog_products WHERE id = ?", productId)) bad("제품을 선택해 주세요.");
    if (!get("SELECT id FROM suppliers WHERE id = ?", supplierId)) bad("공급처를 선택해 주세요.");
    const price = int(body.price);
    if (price <= 0) bad("단가를 입력해 주세요.");
    const unitQty = num(body.unitQty) || 1;
    const existing = get("SELECT * FROM supplier_products WHERE product_id = ? AND supplier_id = ?", productId, supplierId);

    if (existing) {
      run(`UPDATE supplier_products SET supplier_sku = ?, sell_unit = ?, unit_qty = ?, price = ?,
             shipping = ?, moq = ?, lead_days = ?, quoted_at = ?, source = 'manual',
             price_basis = ?, product_url = ?, active = 1 WHERE id = ?`,
        str(body.sku), str(body.sellUnit) || existing.sell_unit, unitQty, price,
        int(body.shipping), int(body.moq) || 1, body.leadDays === "" ? null : int(body.leadDays),
        str(body.quotedAt) || today(), str(body.priceBasis) || "quote", str(body.productUrl) || existing.product_url, existing.id);
    } else {
      run(`INSERT INTO supplier_products
             (id, product_id, supplier_id, supplier_sku, raw_name, sell_unit, unit_qty, price,
               shipping, moq, lead_days, quoted_at, source, price_basis, product_url, active)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'manual', ?, ?, 1)`,
        newId("SP"), productId, supplierId, str(body.sku), str(body.rawName),
        str(body.sellUnit) || "EA", unitQty, price, int(body.shipping), int(body.moq) || 1,
        body.leadDays === "" ? null : int(body.leadDays), str(body.quotedAt) || today(),
        str(body.priceBasis) || "quote", str(body.productUrl) || null);
    }
    if (!existing || existing.price !== price) {
      run(`INSERT INTO price_history (product_id, supplier_id, price, unit_price, sell_unit, unit_qty, at, source, user)
           VALUES (?,?,?,?,?,?,?, 'manual', ?)`,
        productId, supplierId, price, price / unitQty, str(body.sellUnit) || "EA", unitQty, nowIso(), user.name);
    }
    auditLog(user.name, "기준정보", existing ? "공급처 단가 수정" : "공급처 단가 등록", `${productId} / ${supplierId} / ${price}`);
    return json(response, existing ? 200 : 201, offersFor(productId));
  }

  if (method === "DELETE" && /^\/api\/supplier-products\/[^/]+$/.test(path)) {
    requireRole(user, "master");
    const row = get("SELECT * FROM supplier_products WHERE id = ?", seg(url, 3));
    if (!row) notFound("공급처 판매정보를 찾을 수 없습니다.");
    run("DELETE FROM supplier_products WHERE id = ?", row.id);
    auditLog(user.name, "기준정보", "공급처 단가 삭제", row.id);
    return json(response, 200, { ok: true });
  }

  /* ---- 자재 검색 / 비교 ---- */
  if (method === "GET" && (path === "/api/integrations/compare" || path === "/api/search/products")) {
    const query = (url.searchParams.get("q") || "").trim().toLowerCase();
    const tokens = query.split(/\s+/).filter(Boolean);
    const products = all("SELECT * FROM products WHERE active = 1").filter((product) => {
      if (!tokens.length) return true;
      const haystack = [product.name, product.manufacturer, product.supplier, product.model, product.spec, product.tags]
        .filter(Boolean).join(" ").toLowerCase();
      return tokens.every((token) => haystack.includes(token));
    }).map((product) => {
      const stock = get("SELECT COALESCE(SUM(on_hand),0) n FROM inventory_balances WHERE product_id = ?", product.id).n;
      const hits = tokens.filter((token) =>
        [product.name, product.spec, product.tags].filter(Boolean).join(" ").toLowerCase().includes(token)).length;
      return {
        ...product,
        stock,
        match: tokens.length ? Math.round((hits / tokens.length) * 100) : 100,
        sourceId: "local-catalog",
        sourceName: "내부 품목 마스터",
      };
    });
    const sources = all("SELECT * FROM connectors").map((connector) => ({
      id: connector.id, name: connector.name, status: connector.status,
      ready: Boolean(connector.enabled) && (!connector.secret_env || Boolean(process.env[connector.secret_env])),
    }));
    return json(response, 200, {
      query,
      products: canPrices(user) ? products : stripMoney(products, ["price", "unit_price", "shipping"]),
      sources,
      externalFetchPerformed: false,
    });
  }

  /* ---- 입찰정보 ---- */
  if (path.startsWith("/api/bids")) {
    if (method === "GET" && path === "/api/bids/status") {
      return json(response, 200, { ...bidStatus(), kinds: BID_KINDS.map((item) => item.key) });
    }
    if (method === "GET" && path === "/api/bids") {
      return json(response, 200, {
        status: bidStatus(),
        notices: listBidNotices(bidQuery(url)),
      });
    }
    if (method === "GET" && path === "/api/bids/calendar") {
      const query = bidQuery(url);
      return json(response, 200, {
        status: bidStatus(),
        range: { from: query.from, to: query.to, dateField: query.dateField },
        days: bidCalendar(query),
      });
    }
    if (method === "POST" && path === "/api/bids/sync") {
      requireRole(user, "bids");
      const query = bidQuery(url, body);
      return json(response, 200, await syncBidNotices({
        from: query.from, to: query.to, kinds: query.kinds, user: user.name,
      }));
    }
    if (method === "PUT" && /^\/api\/bids\/[^/]+\/star$/.test(path)) {
      requireRole(user, "bids");
      return json(response, 200, toggleStar(seg(url, 3), Boolean(body.starred), user.name));
    }
    if (method === "PUT" && /^\/api\/bids\/[^/]+\/memo$/.test(path)) {
      requireRole(user, "bids");
      return json(response, 200, saveMemo(seg(url, 3), str(body.memo), user.name));
    }
  }

  /* ---- 구매 흐름 ---- */
  if (method === "POST" && (path === "/api/purchase-requests" || path === "/api/purchases")) {
    return json(response, 201, createRequest(body, user));
  }
  if (method === "POST" && /^\/api\/purchase-requests\/[^/]+\/approve$/.test(path)) {
    return json(response, 200, approveRequest(seg(url, 3), body, user));
  }
  if (method === "POST" && /^\/api\/purchase-requests\/[^/]+\/reject$/.test(path)) {
    return json(response, 200, rejectRequest(seg(url, 3), body, user));
  }
  if (method === "POST" && path === "/api/purchase-orders") {
    return json(response, 201, createOrder(body, user));
  }
  if (method === "POST" && /^\/api\/purchase-orders\/[^/]+\/approve$/.test(path)) {
    return json(response, 200, approveOrder(seg(url, 3), user));
  }
  if (method === "POST" && /^\/api\/purchase-orders\/[^/]+\/cancel$/.test(path)) {
    return json(response, 200, cancelOrder(seg(url, 3), user));
  }
  if (method === "POST" && /^\/api\/purchase-orders\/[^/]+\/receive$/.test(path)) {
    return json(response, 200, receiveOrder(seg(url, 3), body, user));
  }

  /* ---- 재고 흐름 ---- */
  if (method === "POST" && path === "/api/stock-transfers") return json(response, 201, transferStock(body, user));
  if (method === "POST" && path === "/api/stock-adjustments") return json(response, 201, adjustStock(body, user));
  if (method === "POST" && path === "/api/allocations") return json(response, 201, allocate(body, user));
  if (method === "POST" && /^\/api\/allocations\/[^/]+\/issue$/.test(path)) {
    return json(response, 200, issueAllocation(seg(url, 3), body, user));
  }
  if (method === "POST" && /^\/api\/allocations\/[^/]+\/release$/.test(path)) {
    return json(response, 200, releaseAllocation(seg(url, 3), user));
  }

  /* ---- 영업 ---- */
  if (method === "POST" && path === "/api/sales-orders") return json(response, 201, createSalesOrder(body, user));
  if (method === "POST" && path === "/api/payments") return json(response, 201, createPayment(body, user));

  /* ---- 관리자 ---- */
  if (path.startsWith("/api/admin/")) {
    requireRole(user, "system");

    if (method === "GET" && path === "/api/admin/users") {
      return json(response, 200, all("SELECT * FROM users ORDER BY created_at").map(publicUser));
    }
    if (method === "POST" && path === "/api/admin/users") {
      validateNewUser(body, true);
      if (get("SELECT id FROM users WHERE email = ?", str(body.email).toLowerCase())) {
        throw new HttpError(409, "이미 등록된 이메일입니다.");
      }
      const record = passwordRecord(body.password);
      const id = newId("USR");
      run(`INSERT INTO users (id, name, email, role, active, password_salt, password_hash, created_at)
           VALUES (?,?,?,?,1,?,?,?)`,
        id, str(body.name), str(body.email).toLowerCase(), body.role, record.salt, record.hash, nowIso());
      auditLog(user.name, "시스템", "사용자 생성", `${body.email} / ${roleName(body.role)}`);
      return json(response, 201, publicUser(get("SELECT * FROM users WHERE id = ?", id)));
    }
    if (method === "PUT" && /^\/api\/admin\/users\/[^/]+$/.test(path)) {
      const id = seg(url, 4);
      const target = get("SELECT * FROM users WHERE id = ?", id);
      if (!target) notFound("사용자를 찾을 수 없습니다.");
      const updates = [];
      const params = [];
      if (str(body.name)) { updates.push("name = ?"); params.push(str(body.name)); }
      if (body.role) {
        if (!["admin", "purchasing", "warehouse", "viewer"].includes(body.role)) bad("역할이 올바르지 않습니다.");
        if (target.role === "admin" && body.role !== "admin"
          && get("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND active = 1").n <= 1) {
          bad("마지막 관리자의 역할은 변경할 수 없습니다.");
        }
        updates.push("role = ?"); params.push(body.role);
      }
      if (body.active !== undefined) {
        if (!body.active && target.id === user.id) bad("본인 계정은 비활성화할 수 없습니다.");
        updates.push("active = ?"); params.push(bool(body.active));
      }
      if (body.password) {
        if (String(body.password).length < 10) bad("비밀번호는 10자 이상이어야 합니다.");
        const record = passwordRecord(body.password);
        updates.push("password_salt = ?", "password_hash = ?"); params.push(record.salt, record.hash);
      }
      if (!updates.length) return json(response, 200, publicUser(target));
      run(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`, ...params, id);
      auditLog(user.name, "시스템", "사용자 수정", target.email);
      return json(response, 200, publicUser(get("SELECT * FROM users WHERE id = ?", id)));
    }

    if (method === "GET" && path === "/api/admin/connectors") {
      return json(response, 200, all("SELECT * FROM connectors ORDER BY id").map((connector) => ({
        ...connector,
        enabled: Boolean(connector.enabled),
        secretConfigured: connector.secret_env ? Boolean(process.env[connector.secret_env]) : true,
        status: connector.secret_env && process.env[connector.secret_env]
          ? (connector.status === "환경변수 필요" ? "연결 준비됨" : connector.status)
          : connector.status,
      })));
    }
    if (method === "PUT" && /^\/api\/admin\/connectors\/[^/]+$/.test(path)) {
      const id = seg(url, 4);
      const connector = get("SELECT * FROM connectors WHERE id = ?", id);
      if (!connector) notFound("연동 소스를 찾을 수 없습니다.");
      const enabled = body.enabled === undefined ? connector.enabled : bool(body.enabled);
      const baseUrl = body.baseUrl === undefined ? connector.base_url : str(body.baseUrl);
      const secretEnv = body.secretEnv === undefined ? connector.secret_env : str(body.secretEnv);
      const status = enabled
        ? (secretEnv && !process.env[secretEnv] ? "환경변수 필요" : "연결 준비")
        : "사용 안 함";
      run("UPDATE connectors SET enabled = ?, base_url = ?, secret_env = ?, status = ? WHERE id = ?",
        enabled, baseUrl, secretEnv, status, id);
      auditLog(user.name, "시스템", enabled ? "연동 사용" : "연동 중지", connector.name);
      const updated = get("SELECT * FROM connectors WHERE id = ?", id);
      return json(response, 200, {
        ...updated, enabled: Boolean(updated.enabled),
        secretConfigured: updated.secret_env ? Boolean(process.env[updated.secret_env]) : true,
      });
    }
    if (method === "POST" && /^\/api\/admin\/connectors\/[^/]+\/test$/.test(path)) {
      const id = seg(url, 4);
      const connector = get("SELECT * FROM connectors WHERE id = ?", id);
      if (!connector) notFound("연동 소스를 찾을 수 없습니다.");
      if (connector.secret_env && !process.env[connector.secret_env]) {
        throw new HttpError(422, `${connector.secret_env} 환경변수가 설정되지 않았습니다.`);
      }
      if (["g2b", "rest"].includes(connector.type) && !connector.base_url) {
        throw new HttpError(422, "API 주소를 설정해 주세요.");
      }
      const checkedAt = nowIso();
      run("UPDATE connectors SET status = '설정 확인됨', last_sync_at = ? WHERE id = ?", checkedAt, id);
      auditLog(user.name, "시스템", "연동 확인", connector.name);
      return json(response, 200, { ok: true, status: "설정 확인됨", checkedAt });
    }

    if (method === "GET" && path === "/api/admin/organization") return json(response, 200, organization());
    if (method === "PUT" && path === "/api/admin/organization") {
      for (const key of ["name", "businessNumber", "ceo", "address", "phone"]) {
        if (body[key] !== undefined) setSetting(`organization.${key}`, str(body[key]) || "");
      }
      auditLog(user.name, "시스템", "회사정보 수정", str(body.name) || "");
      return json(response, 200, organization());
    }
  }

  throw new HttpError(404, "요청한 API를 찾을 수 없습니다.");
}

function bidQuery(url, body = {}) {
  const from = body.from || url.searchParams.get("from") || monthStart();
  const to = body.to || url.searchParams.get("to") || monthEnd();
  const kindsRaw = body.kinds || url.searchParams.get("kinds");
  const kinds = Array.isArray(kindsRaw) ? kindsRaw : (kindsRaw ? String(kindsRaw).split(",").filter(Boolean) : []);
  return {
    from, to, kinds,
    keyword: body.keyword || url.searchParams.get("q") || "",
    region: body.region || url.searchParams.get("region") || "",
    starred: (body.starred ?? url.searchParams.get("starred")) === "1" || body.starred === true,
    dateField: body.dateField || url.searchParams.get("dateField") || "notice_date",
  };
}

const monthStart = () => `${today().slice(0, 7)}-01`;
const monthEnd = () => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 0).toLocaleString("sv-SE").slice(0, 10);
};

function organization() {
  return {
    name: setting("organization.name", "INPACK"),
    businessNumber: setting("organization.businessNumber", ""),
    ceo: setting("organization.ceo", ""),
    address: setting("organization.address", ""),
    phone: setting("organization.phone", ""),
    dataMode: setting("organization.dataMode", "integration"),
  };
}

function validateNewUser(body, needRole = false) {
  if (!str(body.name)) bad("이름을 입력해 주세요.");
  if (!/^\S+@\S+\.\S+$/.test(String(body.email || ""))) bad("이메일 형식이 올바르지 않습니다.");
  if (typeof body.password !== "string" || body.password.length < 10) bad("비밀번호는 10자 이상이어야 합니다.");
  if (needRole && !["admin", "purchasing", "warehouse", "viewer"].includes(body.role)) bad("역할을 선택해 주세요.");
}

export { json };
