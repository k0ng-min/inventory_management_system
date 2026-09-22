import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { parseSpec, specKey, specLabel, canonicalName, CATEGORIES } from "./catalog.mjs";

const backendDir = fileURLToPath(new URL(".", import.meta.url));
const dbPath = process.env.ERP_DB_PATH || join(backendDir, "erp.db");
const seedPath = join(backendDir, "data.json");

export const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
db.exec("PRAGMA busy_timeout = 5000;");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  purpose TEXT,
  base_url TEXT,
  secret_env TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  status TEXT,
  last_sync_at TEXT
);

CREATE TABLE IF NOT EXISTS warehouses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  location TEXT,
  manager TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  site TEXT,
  manager TEXT,
  customer TEXT,
  status TEXT NOT NULL DEFAULT '진행 중',
  start_date TEXT,
  end_date TEXT,
  budget INTEGER NOT NULL DEFAULT 0,
  progress INTEGER NOT NULL DEFAULT 0,
  note TEXT
);

CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  biz_no TEXT,
  contact TEXT,
  phone TEXT,
  email TEXT,
  terms TEXT,
  lead_time TEXT,
  rating REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT '정상',
  note TEXT
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  biz_no TEXT,
  contact TEXT,
  phone TEXT,
  email TEXT,
  terms TEXT,
  status TEXT NOT NULL DEFAULT '정상',
  note TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  catalog_product_id TEXT,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '케이블',
  manufacturer TEXT,
  model TEXT,
  supplier TEXT,
  unit TEXT NOT NULL DEFAULT 'EA',
  unit_qty REAL NOT NULL DEFAULT 1,
  price INTEGER NOT NULL DEFAULT 0,
  unit_price INTEGER NOT NULL DEFAULT 0,
  shipping INTEGER NOT NULL DEFAULT 0,
  lead_time TEXT,
  safety_stock INTEGER NOT NULL DEFAULT 0,
  barcode TEXT,
  spec TEXT,
  tags TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS purchase_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  product_id TEXT REFERENCES products(id),
  preferred_supplier_id TEXT REFERENCES suppliers(id),
  supplier_product_id TEXT,
  quoted_unit_price REAL,
  quantity INTEGER NOT NULL,
  purpose TEXT,
  requested_date TEXT,
  status TEXT NOT NULL DEFAULT '구매요청',
  requester TEXT,
  approver TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL
);

-- 발주서 헤더. 품목은 purchase_order_lines 에 있습니다.
-- quantity·received·amount 는 줄의 합입니다 — 대시보드와 미지급금이 이 값을 씁니다.
CREATE TABLE IF NOT EXISTS purchase_orders (
  id TEXT PRIMARY KEY,
  supplier_id TEXT REFERENCES suppliers(id),
  line_count INTEGER NOT NULL DEFAULT 0,
  quantity INTEGER NOT NULL DEFAULT 0,
  received INTEGER NOT NULL DEFAULT 0,
  amount INTEGER NOT NULL DEFAULT 0,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT '승인대기',
  approver TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);

-- 발주서 품목 줄. 발주번호 하나에 여러 품목이 달립니다.
-- 공급처에 보내는 발주서와 1:1 로 맞추려면 번호가 하나여야 합니다.
-- 수량·단가·입고는 전부 줄에 붙고, 헤더의 quantity/received/amount 는 줄의 합입니다.
CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id TEXT PRIMARY KEY,                 -- PO-2609-0001-01
  order_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  product_id TEXT REFERENCES products(id),
  project_id TEXT REFERENCES projects(id),
  request_id TEXT,
  supplier_product_id TEXT,
  source_url TEXT,
  quantity INTEGER NOT NULL,
  received INTEGER NOT NULL DEFAULT 0,
  unit_price INTEGER NOT NULL DEFAULT 0,
  amount INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  UNIQUE (order_id, line_no)
);
CREATE INDEX IF NOT EXISTS idx_po_lines_order ON purchase_order_lines(order_id);
CREATE INDEX IF NOT EXISTS idx_po_lines_product ON purchase_order_lines(product_id);

CREATE TABLE IF NOT EXISTS goods_receipts (
  id TEXT PRIMARY KEY,
  order_id TEXT REFERENCES purchase_orders(id),
  warehouse_id TEXT REFERENCES warehouses(id),
  product_id TEXT REFERENCES products(id),
  quantity INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  receiver TEXT,
  defect_qty INTEGER NOT NULL DEFAULT 0,
  defect_kind TEXT,
  note TEXT
);

CREATE TABLE IF NOT EXISTS inventory_balances (
  product_id TEXT NOT NULL REFERENCES products(id),
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  bin TEXT,
  on_hand INTEGER NOT NULL DEFAULT 0,
  reserved INTEGER NOT NULL DEFAULT 0,
  allocated INTEGER NOT NULL DEFAULT 0,
  expected INTEGER NOT NULL DEFAULT 0,
  safety_stock INTEGER NOT NULL DEFAULT 0,
  last_movement TEXT,
  PRIMARY KEY (product_id, warehouse_id)
);

CREATE TABLE IF NOT EXISTS inventory_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  product_id TEXT NOT NULL,
  warehouse_id TEXT NOT NULL,
  qty INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  ref_type TEXT,
  ref_id TEXT,
  project_id TEXT,
  user TEXT,
  note TEXT
);

CREATE TABLE IF NOT EXISTS stock_transfers (
  id TEXT PRIMARY KEY,
  product_id TEXT REFERENCES products(id),
  from_warehouse TEXT REFERENCES warehouses(id),
  to_warehouse TEXT REFERENCES warehouses(id),
  quantity INTEGER NOT NULL,
  moved_at TEXT NOT NULL,
  user TEXT,
  note TEXT
);

CREATE TABLE IF NOT EXISTS stock_adjustments (
  id TEXT PRIMARY KEY,
  product_id TEXT REFERENCES products(id),
  warehouse_id TEXT REFERENCES warehouses(id),
  before_qty INTEGER NOT NULL,
  after_qty INTEGER NOT NULL,
  diff INTEGER NOT NULL,
  reason TEXT,
  adjusted_at TEXT NOT NULL,
  user TEXT
);

CREATE TABLE IF NOT EXISTS project_allocations (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  product_id TEXT REFERENCES products(id),
  warehouse_id TEXT REFERENCES warehouses(id),
  quantity INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT '예약',
  allocated_at TEXT NOT NULL,
  user TEXT,
  note TEXT
);

CREATE TABLE IF NOT EXISTS sales_orders (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  customer TEXT,
  description TEXT,
  amount INTEGER NOT NULL DEFAULT 0,
  received INTEGER NOT NULL DEFAULT 0,
  invoice_date TEXT,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT '승인완료',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  sales_order_id TEXT REFERENCES sales_orders(id),
  amount INTEGER NOT NULL,
  paid_at TEXT NOT NULL,
  method TEXT,
  note TEXT
);

CREATE TABLE IF NOT EXISTS accounting_entries (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  type TEXT NOT NULL,
  account TEXT,
  counterparty TEXT,
  description TEXT,
  project_id TEXT REFERENCES projects(id),
  debit INTEGER NOT NULL DEFAULT 0,
  credit INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT '검토',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bid_notices (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'sample',
  bid_no TEXT,
  bid_ord TEXT,
  title TEXT NOT NULL,
  kind TEXT,
  notice_inst TEXT,
  demand_inst TEXT,
  notice_date TEXT,
  close_date TEXT,
  open_date TEXT,
  base_amount INTEGER NOT NULL DEFAULT 0,
  budget_amount INTEGER NOT NULL DEFAULT 0,
  region TEXT,
  contract_method TEXT,
  url TEXT,
  starred INTEGER NOT NULL DEFAULT 0,
  memo TEXT,
  fetched_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  user TEXT,
  module TEXT,
  action TEXT,
  detail TEXT
);

-- 팀 공유 일정. 작업·휴가를 한 달력에서 같이 보고 서로 조정합니다.
-- 날짜는 YYYY-MM-DD, 하루짜리는 start_date = end_date 로 둡니다.
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'work',   -- work | leave | etc
  title TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 1,
  start_time TEXT,
  end_time TEXT,
  assignees TEXT,                      -- 담당자 이름을 쉼표로 구분
  project_id TEXT,
  location TEXT,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedules_range ON schedules(start_date, end_date);

-- 정규화된 제품 마스터. 규격이 같으면 파는 업체가 달라도 한 행입니다.
CREATE TABLE IF NOT EXISTS catalog_products (
  id TEXT PRIMARY KEY,
  spec_key TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  specs TEXT NOT NULL DEFAULT '{}',
  spec_label TEXT,
  manufacturer TEXT,
  base_unit TEXT NOT NULL DEFAULT 'EA',
  safety_stock INTEGER NOT NULL DEFAULT 0,
  barcode TEXT,
  note TEXT,
  certification TEXT,
  confidence REAL NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

-- 공급처별 판매 정보. 같은 제품을 여러 업체가 서로 다른 단위·가격으로 팝니다.
CREATE TABLE IF NOT EXISTS supplier_products (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  supplier_sku TEXT,
  raw_name TEXT,
  sell_unit TEXT NOT NULL DEFAULT 'EA',
  unit_qty REAL NOT NULL DEFAULT 1,
  price INTEGER NOT NULL DEFAULT 0,
  shipping INTEGER NOT NULL DEFAULT 0,
  moq INTEGER NOT NULL DEFAULT 1,
  lead_days INTEGER,
  stock INTEGER,
  quoted_at TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  price_basis TEXT NOT NULL DEFAULT 'quote',
  product_url TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (product_id, supplier_id)
);

-- 가격 이력. "지난번에 얼마에 샀는가" 를 바로 답하기 위한 자산입니다.
CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL,
  supplier_id TEXT,
  price INTEGER NOT NULL,
  unit_price REAL NOT NULL,
  sell_unit TEXT,
  unit_qty REAL,
  at TEXT NOT NULL,
  source TEXT,
  ref_type TEXT,
  ref_id TEXT,
  user TEXT
);

-- 견적함. 필요한 자재를 한 리스트에 담아 업체별 견적을 비교합니다.
-- 한 번에 여러 품목을 사는 것이 보통이라, 품목 하나씩 비교해서는 답이 안 나옵니다.
CREATE TABLE IF NOT EXISTS quote_carts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  owner TEXT,
  status TEXT NOT NULL DEFAULT '작성중',   -- 작성중 | 발주완료 | 보관
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quote_items (
  id TEXT PRIMARY KEY,
  cart_id TEXT NOT NULL REFERENCES quote_carts(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
  quantity REAL NOT NULL DEFAULT 1,        -- 제품 기본단위 기준
  project_id TEXT,                         -- 행마다 공사가 다를 수 있습니다
  note TEXT,
  added_at TEXT NOT NULL,
  UNIQUE (cart_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_quote_items_cart ON quote_items(cart_id);

-- 공급처 품목 적재 이력
CREATE TABLE IF NOT EXISTS catalog_imports (
  id TEXT PRIMARY KEY,
  supplier_id TEXT,
  filename TEXT,
  total INTEGER NOT NULL DEFAULT 0,
  matched INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL DEFAULT 0,
  review INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL,
  user TEXT
);

-- 판매처 상품을 제품 마스터에 자동 확정하지 못했을 때 관리자가 판정하는 큐입니다.
CREATE TABLE IF NOT EXISTS product_match_reviews (
  id TEXT PRIMARY KEY,
  supplier_product_id TEXT,
  candidate_product_id TEXT,
  proposed_product_id TEXT,
  reason TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  evidence TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | remapped
  resolved_by TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL
);

-- 외부 이동 전 구매 후보를 남깁니다. 이후 기존 구매요청/발주 흐름으로 승격할 수 있습니다.
CREATE TABLE IF NOT EXISTS purchase_candidates (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES catalog_products(id),
  supplier_product_id TEXT REFERENCES supplier_products(id),
  quantity REAL NOT NULL DEFAULT 1,
  expected_total REAL,
  status TEXT NOT NULL DEFAULT 'candidate', -- candidate | requested | purchased | cancelled
  product_url TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_match_review_status ON product_match_reviews(status, created_at);
CREATE INDEX IF NOT EXISTS idx_purchase_candidate_status ON purchase_candidates(status, created_at);

CREATE INDEX IF NOT EXISTS idx_cat_category ON catalog_products(category);
CREATE INDEX IF NOT EXISTS idx_sp_product ON supplier_products(product_id);
CREATE INDEX IF NOT EXISTS idx_sp_supplier ON supplier_products(supplier_id);
CREATE INDEX IF NOT EXISTS idx_ph_product ON price_history(product_id, at);

CREATE INDEX IF NOT EXISTS idx_txn_product ON inventory_transactions(product_id, warehouse_id, at);
CREATE INDEX IF NOT EXISTS idx_txn_at ON inventory_transactions(at);
CREATE INDEX IF NOT EXISTS idx_bid_dates ON bid_notices(notice_date, close_date);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_logs(at);
`;

db.exec(SCHEMA);

// CREATE TABLE IF NOT EXISTS는 기존 표에 새 열을 더하지 않습니다. 배포된 DB도
// 같은 코드 경로를 타도록, 호환 가능한 nullable/default 열만 작은 인라인 마이그레이션으로 보강합니다.
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn("products", "catalog_product_id", "TEXT");
ensureColumn("purchase_requests", "preferred_supplier_id", "TEXT");
ensureColumn("purchase_requests", "supplier_product_id", "TEXT");
ensureColumn("purchase_requests", "quoted_unit_price", "REAL");
ensureColumn("catalog_products", "certification", "TEXT");
ensureColumn("catalog_products", "brand", "TEXT");
ensureColumn("catalog_products", "subcategory", "TEXT");
ensureColumn("catalog_products", "series", "TEXT");
ensureColumn("catalog_products", "model", "TEXT");
ensureColumn("catalog_products", "product_code", "TEXT");
ensureColumn("catalog_products", "normalized_name", "TEXT");
ensureColumn("catalog_products", "image_url", "TEXT");
ensureColumn("catalog_products", "manufacturer_url", "TEXT");
ensureColumn("catalog_products", "datasheet_url", "TEXT");
ensureColumn("catalog_products", "catalog_url", "TEXT");
ensureColumn("catalog_products", "certifications", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("catalog_products", "status", "TEXT NOT NULL DEFAULT 'active'");
ensureColumn("catalog_products", "source", "TEXT NOT NULL DEFAULT 'legacy'");
ensureColumn("catalog_products", "source_updated_at", "TEXT");
ensureColumn("catalog_products", "last_synced_at", "TEXT");
ensureColumn("catalog_products", "manual_fields", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("goods_receipts", "line_id", "TEXT");
ensureColumn("goods_receipts", "batch_id", "TEXT");
// 불량·오배송은 "받긴 받았는데 못 쓰는" 수량입니다. 재고에는 넣지 않고 기록만 남깁니다.
ensureColumn("goods_receipts", "defect_qty", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("goods_receipts", "defect_kind", "TEXT");
// 다품목 발주로 올리기 전에, 기존 DB 에도 헤더 열이 있어야 합니다.
ensureColumn("purchase_orders", "note", "TEXT");
ensureColumn("purchase_orders", "line_count", "INTEGER NOT NULL DEFAULT 0");

/**
 * 1발주 1품목 → 다품목 발주서로 올립니다.
 * 기존 발주 한 건을 1번 줄로 옮기고, 품목에 매인 열을 헤더에서 뺍니다.
 * quantity·received·amount 는 줄의 합이라는 뜻으로 바뀌어 그대로 남습니다 —
 * 대시보드·미지급금·구매분석 쿼리가 계속 동작합니다.
 */
function migrateOrderLines() {
  const columns = db.prepare("PRAGMA table_info(purchase_orders)").all().map((row) => row.name);
  if (!columns.includes("product_id")) return;    // 이미 이관됐습니다

  const orders = db.prepare("SELECT * FROM purchase_orders").all();
  const insert = db.prepare(`INSERT OR IGNORE INTO purchase_order_lines
      (id, order_id, line_no, product_id, project_id, request_id, supplier_product_id,
       source_url, quantity, received, unit_price, amount)
     VALUES (?,?,1,?,?,?,?,?,?,?,?,?)`);
  for (const order of orders) {
    insert.run(`${order.id}-01`, order.id, order.product_id, order.project_id,
      order.request_id, order.supplier_product_id, order.source_url,
      order.quantity, order.received, order.unit_price, order.amount);
  }
  // 입고 이력도 그 줄에 붙여 둡니다.
  db.exec("UPDATE goods_receipts SET line_id = order_id || '-01' WHERE line_id IS NULL AND order_id IS NOT NULL");

  for (const column of ["product_id", "project_id", "request_id", "supplier_product_id", "source_url", "unit_price"]) {
    if (columns.includes(column)) db.exec(`ALTER TABLE purchase_orders DROP COLUMN ${column}`);
  }
  db.exec("UPDATE purchase_orders SET line_count = 1 WHERE line_count = 0");
  if (orders.length) console.log(`  발주 ${orders.length}건을 다품목 구조로 옮겼습니다.`);
}
migrateOrderLines();
ensureColumn("supplier_products", "price_basis", "TEXT NOT NULL DEFAULT 'quote'");
ensureColumn("supplier_products", "product_url", "TEXT");
ensureColumn("supplier_products", "external_product_id", "TEXT");
ensureColumn("supplier_products", "normalized_title", "TEXT");
ensureColumn("supplier_products", "manufacturer", "TEXT");
ensureColumn("supplier_products", "model", "TEXT");
ensureColumn("supplier_products", "raw_specification", "TEXT");
ensureColumn("supplier_products", "parsed_specifications", "TEXT NOT NULL DEFAULT '{}'");
ensureColumn("supplier_products", "original_price", "INTEGER");
ensureColumn("supplier_products", "vat_included", "INTEGER");
ensureColumn("supplier_products", "stock_status", "TEXT");
ensureColumn("supplier_products", "lead_time", "TEXT");
ensureColumn("supplier_products", "image_url", "TEXT");
ensureColumn("supplier_products", "last_checked_at", "TEXT");
ensureColumn("supplier_products", "match_confidence", "REAL NOT NULL DEFAULT 0");
ensureColumn("supplier_products", "match_status", "TEXT NOT NULL DEFAULT 'review'");
ensureColumn("supplier_products", "other_cost", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("price_history", "supplier_product_id", "TEXT");
ensureColumn("price_history", "shipping_cost", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("price_history", "stock_status", "TEXT");
ensureColumn("price_history", "vat_included", "INTEGER");
ensureColumn("price_history", "checked_at", "TEXT");
ensureColumn("connectors", "last_attempt_at", "TEXT");
ensureColumn("connectors", "last_success_at", "TEXT");
ensureColumn("connectors", "last_error", "TEXT");
ensureColumn("connectors", "policy_status", "TEXT NOT NULL DEFAULT 'review_required'");
ensureColumn("connectors", "source_grade", "TEXT");
ensureColumn("connectors", "next_sync_at", "TEXT");
ensureColumn("connectors", "failure_count", "INTEGER NOT NULL DEFAULT 0");
db.exec("CREATE INDEX IF NOT EXISTS idx_products_catalog ON products(catalog_product_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_catalog_product_code ON catalog_products(product_code)");
db.exec("CREATE INDEX IF NOT EXISTS idx_catalog_model ON catalog_products(manufacturer, model)");
db.exec("CREATE INDEX IF NOT EXISTS idx_supplier_external ON supplier_products(supplier_id, external_product_id)");

// 가격비교 소스. seedIfEmpty() 는 빈 DB 에서만 돌기 때문에, 이미 쓰고 있는 DB 에도
// 새 연동이 나타나도록 여기서 한 번만 등록합니다. 켜는 것은 관리자 몫입니다.
for (const connector of [
  ["mall-scrape", "온라인 자재몰 수집", "scrape", "자재몰 상품목록 — 품명·규격·배송비",
    "https://jajekorea.com", "", 0, "정책 확인 전 중지"],
  ["naver-shop", "네이버 쇼핑 검색", "rest", "검색어 한 번에 쇼핑몰별 최저가",
    "https://openapi.naver.com/v1/search/shop.json", "NAVER_CLIENT_ID", 0, "2026-07-31 서비스 종료"],
  ["coupang-partners", "쿠팡 파트너스", "rest", "쿠팡 판매가 (제휴 승인 필요)",
    "https://api-gateway.coupang.com", "COUPANG_ACCESS_KEY", 0, "제휴 승인 필요"],
  ["ali-open", "알리익스프레스 오픈API", "rest", "해외 직구 시세 (관세·납기 별도)",
    "https://api-sg.aliexpress.com/sync", "ALI_APP_KEY", 0, "앱 등록 필요"],
]) {
  // run() 은 아래에서 선언되므로 여기서는 준비문을 직접 씁니다.
  db.prepare(`INSERT OR IGNORE INTO connectors
       (id, name, type, purpose, base_url, secret_env, enabled, status, last_sync_at)
       VALUES (?,?,?,?,?,?,?,?,NULL)`).run(...connector);
}

// 조사 결과가 기존 설치 DB에도 즉시 반영되도록 위험한 기본 연동은 강제로 끕니다.
db.prepare("UPDATE connectors SET enabled = 0, status = ?, policy_status = ?, source_grade = ? WHERE id = ?")
  .run("정책 확인 전 중지", "permission_required", "C", "mall-scrape");
db.prepare("UPDATE connectors SET enabled = 0, status = ?, policy_status = ?, source_grade = ? WHERE id = ?")
  .run("2026-07-31 서비스 종료", "retired", "E", "naver-shop");

/* ------------------------------------------------------------------ */
/* query helpers                                                       */
/* ------------------------------------------------------------------ */

export const all = (sql, ...params) => db.prepare(sql).all(...params);
export const get = (sql, ...params) => db.prepare(sql).get(...params);
export const run = (sql, ...params) => db.prepare(sql).run(...params);

/** Runs `fn` inside a transaction; rolls back and rethrows on failure. */
/**
 * 트랜잭션. 중첩해서 불러도 됩니다.
 * 업무 하나가 다른 업무를 통째로 쓰는 일이 흔한데(요청 승인 → 발주 생성),
 * 안쪽에서 또 BEGIN 을 걸면 SQLite 가 거부합니다. 안쪽은 SAVEPOINT 로 받고,
 * 커밋은 가장 바깥에서 한 번만 합니다.
 */
let txDepth = 0;

export function tx(fn) {
  const nested = txDepth > 0;
  const name = `sp_${txDepth}`;
  db.exec(nested ? `SAVEPOINT ${name}` : "BEGIN IMMEDIATE");
  txDepth += 1;
  try {
    const result = fn();
    txDepth -= 1;
    db.exec(nested ? `RELEASE ${name}` : "COMMIT");
    return result;
  } catch (error) {
    txDepth -= 1;
    try { db.exec(nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : "ROLLBACK"); } catch { /* 이미 되돌려졌습니다 */ }
    throw error;
  }
}

/** 업무 규칙 위반(재고 부족 등) — 서버가 400 으로 내보냅니다. */
export class BusinessError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

export const nowIso = () => new Date().toISOString();
export const seoulNow = () => new Date().toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }).slice(0, 16);
export const today = () => new Date().toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }).slice(0, 10);
export const yearMonth = () => today().slice(0, 7).replace("-", "");

/** `PO-202609-0042` style document numbers, unique per table+prefix. */
export function nextDocNo(table, prefix) {
  const head = `${prefix}-${yearMonth()}-`;
  const row = get(`SELECT id FROM ${table} WHERE id LIKE ? ORDER BY id DESC LIMIT 1`, `${head}%`);
  const serial = row ? Number(row.id.slice(head.length)) + 1 : 1;
  return `${head}${String(serial).padStart(4, "0")}`;
}

export function auditLog(user, module, action, detail) {
  run("INSERT INTO audit_logs (at, user, module, action, detail) VALUES (?,?,?,?,?)",
    seoulNow(), user || "시스템", module, action, detail || "");
}

export function setting(key, fallback = null) {
  const row = get("SELECT value FROM settings WHERE key = ?", key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  run("INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, String(value));
}

/* ------------------------------------------------------------------ */
/* passwords                                                           */
/* ------------------------------------------------------------------ */

export function passwordRecord(password) {
  const salt = randomBytes(16).toString("hex");
  return { salt, hash: scryptSync(password, salt, 64).toString("hex") };
}

export function passwordMatches(password, user) {
  const actual = scryptSync(password, user.password_salt, 64);
  const expected = Buffer.from(user.password_hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const newId = (prefix) => `${prefix}-${randomBytes(5).toString("hex")}`;

/* ------------------------------------------------------------------ */
/* inventory movement — the single writer for stock quantities         */
/* ------------------------------------------------------------------ */

const SIGN = {
  PURCHASE_RECEIPT: 1,
  RETURN_IN: 1,
  TRANSFER_IN: 1,
  ADJUST_IN: 1,
  SALE_ISSUE: -1,
  PROJECT_ISSUE: -1,
  TRANSFER_OUT: -1,
  ADJUST_OUT: -1,
  RETURN_OUT: -1,
};

export const MOVEMENT_TYPES = Object.keys(SIGN);

/**
 * Applies one stock movement and records it in inventory_transactions.
 * Caller must already be inside a transaction when several moves must be atomic.
 */
export function moveStock({ type, productId, warehouseId, qty, refType, refId, projectId, user, note }) {
  const sign = SIGN[type];
  if (!sign) throw new BusinessError(`알 수 없는 재고 이동 유형입니다: ${type}`);
  const amount = Math.abs(Number(qty));
  if (!Number.isInteger(amount) || amount < 1) throw new BusinessError("이동 수량은 1 이상의 정수여야 합니다.");

  let balance = get("SELECT * FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?", productId, warehouseId);
  if (!balance) {
    const product = get("SELECT safety_stock FROM products WHERE id = ?", productId);
    run("INSERT INTO inventory_balances (product_id, warehouse_id, on_hand, safety_stock) VALUES (?,?,0,?)",
      productId, warehouseId, product?.safety_stock || 0);
    balance = get("SELECT * FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?", productId, warehouseId);
  }

  const next = balance.on_hand + sign * amount;
  if (next < 0) throw new BusinessError(`재고가 부족합니다. 현재고 ${balance.on_hand}, 요청 ${amount}`);

  run("UPDATE inventory_balances SET on_hand = ?, last_movement = ? WHERE product_id = ? AND warehouse_id = ?",
    next, today(), productId, warehouseId);
  run(`INSERT INTO inventory_transactions (at, type, product_id, warehouse_id, qty, balance_after, ref_type, ref_id, project_id, user, note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    seoulNow(), type, productId, warehouseId, sign * amount, next, refType || null, refId || null, projectId || null, user || null, note || null);
  return next;
}

/* ------------------------------------------------------------------ */
/* seed — runs once, from the original data.json prototype fixtures    */
/* ------------------------------------------------------------------ */

/**
 * 이 회사는 사업장이 하나입니다. 자재를 한 곳에 두고 현장으로 들고 나갑니다.
 * 그래서 기본은 창고 한 개 — 화면이 창고를 묻지 않습니다.
 * 창고를 더 만들면 그때부터 선택 칸과 재고이동 메뉴가 다시 나타납니다.
 */
const WAREHOUSE_SEED = [
  { id: "WH-HQ", name: "본사 사업장", location: "", manager: "" },
];

function seedBidNotices() {
  // 인증키가 없을 때도 캘린더/목록 화면이 실제처럼 동작하도록 만든 예시 공고입니다.
  // 날짜는 오늘 기준 상대값으로 생성해 항상 이번 달 주변에 분포합니다.
  const base = new Date();
  const fixtures = [
    ["공사", "세종 스마트산업단지 전력간선 설치공사", "조달청", "세종특별자치시", 1_480_000_000, "세종특별자치시", "제한경쟁", -22, -4],
    ["물품", "지상변압기 및 부속자재 구매", "한국전력공사", "한국전력공사", 640_000_000, "전국", "일반경쟁", -20, -2],
    ["공사", "○○초등학교 전기설비 개선공사", "조달청", "세종특별자치시교육청", 320_000_000, "세종특별자치시", "일반경쟁", -18, -1],
    ["용역", "배전설비 안전진단 용역", "한국전기안전공사", "한국전기안전공사", 78_000_000, "전국", "협상에의한계약", -15, 1],
    ["공사", "동탄2 물류단지 수변전설비 증설공사", "한국토지주택공사", "한국토지주택공사", 2_140_000_000, "경기도", "제한경쟁", -14, 2],
    ["물품", "배전반용 저압 전력케이블 구매", "조달청", "한국전력공사", 186_000_000, "전국", "일반경쟁", -12, 3],
    ["공사", "판교 공공청사 조명설비 교체공사", "성남시", "성남시", 410_000_000, "경기도", "지역제한", -11, 4],
    ["공사", "군산 산업단지 가로등 정비공사", "군산시", "군산시", 132_000_000, "전라북도", "지역제한", -10, 5],
    ["용역", "전기설비 정기점검 용역", "한국도로공사", "한국도로공사", 95_000_000, "전국", "협상에의한계약", -9, 6],
    ["물품", "TFR-CV 난연케이블 연간 단가계약", "조달청", "조달청", 1_020_000_000, "전국", "단가계약", -8, 7],
    ["공사", "인천 물류센터 비상발전기 설치공사", "인천항만공사", "인천항만공사", 760_000_000, "인천광역시", "제한경쟁", -7, 8],
    ["공사", "대전 연구단지 수전설비 보수공사", "조달청", "한국연구재단", 280_000_000, "대전광역시", "지역제한", -6, 9],
    ["물품", "분전반 및 배선기구 구매", "조달청", "국방부", 64_000_000, "전국", "일반경쟁", -5, 10],
    ["공사", "광주 하수처리장 전기계장 공사", "한국환경공단", "한국환경공단", 890_000_000, "광주광역시", "제한경쟁", -4, 11],
    ["공사", "부산 신항 전기실 리모델링공사", "부산항만공사", "부산항만공사", 540_000_000, "부산광역시", "일반경쟁", -3, 12],
    ["용역", "공동주택 전기안전관리 대행용역", "SH공사", "SH공사", 142_000_000, "서울특별시", "협상에의한계약", -2, 13],
    ["공사", "울산 석유화학단지 방폭 전기공사", "한국산업단지공단", "한국산업단지공단", 1_260_000_000, "울산광역시", "제한경쟁", -1, 14],
    ["물품", "LED 투광등기구 구매설치", "조달청", "국토교통부", 218_000_000, "전국", "일반경쟁", 0, 15],
    ["공사", "제주 신재생에너지 연계 배전공사", "한국전력공사", "한국전력공사", 980_000_000, "제주특별자치도", "제한경쟁", 0, 16],
    ["공사", "천안 일반산업단지 전기간선 신설공사", "천안시", "천안시", 620_000_000, "충청남도", "지역제한", 1, 17],
    ["용역", "전력설비 열화진단 용역", "한국수자원공사", "한국수자원공사", 58_000_000, "전국", "협상에의한계약", 2, 18],
    ["물품", "고압 진공차단기(VCB) 구매", "조달청", "한국철도공사", 345_000_000, "전국", "일반경쟁", 3, 19],
    ["공사", "강릉 하수처리시설 전기설비 공사", "강원특별자치도", "강릉시", 470_000_000, "강원특별자치도", "지역제한", 4, 20],
    ["공사", "김포 물류창고 수배전반 교체공사", "한국공항공사", "한국공항공사", 388_000_000, "경기도", "일반경쟁", 5, 21],
    ["물품", "접지자재 및 피뢰침 구매", "조달청", "기상청", 42_000_000, "전국", "일반경쟁", 6, 22],
    ["공사", "포항 산업단지 특고압 인입공사", "경상북도", "포항시", 1_140_000_000, "경상북도", "제한경쟁", 7, 24],
    ["용역", "신재생에너지 계통연계 설계용역", "한국에너지공단", "한국에너지공단", 164_000_000, "전국", "협상에의한계약", 8, 25],
    ["공사", "수원 컨벤션센터 무대조명 전기공사", "수원시", "수원시", 296_000_000, "경기도", "지역제한", 9, 26],
    ["외자", "고압 케이블 부속재 수입 구매", "조달청", "한국전력공사", 512_000_000, "전국", "일반경쟁", 10, 27],
    ["공사", "청주 공공하수처리장 전기공사", "충청북도", "청주시", 735_000_000, "충청북도", "제한경쟁", 12, 30],
  ];

  const insert = db.prepare(`INSERT OR IGNORE INTO bid_notices
    (id, source, bid_no, bid_ord, title, kind, notice_inst, demand_inst, notice_date, close_date, open_date,
     base_amount, budget_amount, region, contract_method, url, fetched_at)
    VALUES (?,'sample',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  const shift = (days) => new Date(base.getTime() + days * 86400000).toISOString().slice(0, 10);

  fixtures.forEach(([kind, title, inst, demand, amount, region, method, noticeOffset, closeOffset], index) => {
    const bidNo = `2026${String(1_000_000 + index * 1373).padStart(7, "0")}`;
    insert.run(
      `SAMPLE-${bidNo}-00`, bidNo, "00", title, kind, inst, demand,
      `${shift(noticeOffset)} 09:00`,
      `${shift(closeOffset)} ${10 + (index % 5)}:00`,
      `${shift(closeOffset + 1)} 11:00`,
      amount, Math.round(amount * 1.1), region, method,
      "https://www.g2b.go.kr/", nowIso(),
    );
  });
}

/* ------------------------------------------------------------------ */
/* 레거시 products → 카탈로그(제품 1 : N 업체가격) 전개                  */
/* ------------------------------------------------------------------ */

/** "당일", "내일", "3일 이내" 같은 납기 표기를 일수로 바꿉니다. */
function leadDaysOf(text) {
  if (!text) return null;
  if (/당일|오늘/.test(text)) return 0;
  if (/내일/.test(text)) return 1;
  const digits = /(\d+)\s*일/.exec(text);
  return digits ? Number(digits[1]) : null;
}

/**
 * `products` 각 행의 제품명에서 규격을 읽어 `catalog_products` 로 묶고,
 * 그 행이 들고 있던 거래처·가격은 `supplier_products` + `price_history` 로 옮깁니다.
 * 규격이 같으면 업체가 달라도 제품 행은 하나입니다.
 *
 * 트랜잭션은 열지 않습니다 — 호출하는 쪽에서 `tx()` 로 감싸세요.
 * 시드(최초 1회)와 `migrate-catalog.mjs`(기존 DB 전환)가 같이 씁니다.
 *
 * @returns {{ moved: number, map: Map<string, string> }} 옛 product_id → 새 product_id
 */
export function catalogFromLegacy() {
  const legacy = all("SELECT * FROM products");
  const map = new Map();

  for (const row of legacy) {
    const parsed = parseSpec(row.name, row.category);
    const key = specKey(parsed.category, parsed.specs);
    const definition = CATEGORIES[parsed.category] || CATEGORIES.etc;

    let target = get("SELECT * FROM catalog_products WHERE spec_key = ?", key);
    if (!target) {
      const id = newId("P");
      run(`INSERT INTO catalog_products
             (id, spec_key, category, name, specs, spec_label, manufacturer, base_unit,
              safety_stock, barcode, note, confidence, active, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
        id, key, parsed.category,
        canonicalName(parsed.category, parsed.specs, null),
        JSON.stringify(parsed.specs), specLabel(parsed.category, parsed.specs),
        row.manufacturer, definition.baseUnit,
        row.safety_stock || 0, row.barcode, row.spec || null, parsed.confidence,
        nowIso(), nowIso());
      target = get("SELECT * FROM catalog_products WHERE id = ?", id);
    }
    map.set(row.id, target.id);
    if (row.catalog_product_id !== target.id) {
      run("UPDATE products SET catalog_product_id = ? WHERE id = ?", target.id, row.id);
    }

    // 레거시의 거래처는 이름 문자열이라, 거래처 테이블에서 찾아 연결합니다.
    const supplier = row.supplier ? get("SELECT id FROM suppliers WHERE name = ?", row.supplier) : null;
    if (!supplier || !(row.price > 0)) continue;

    // 이미 옮긴 DB 에 다시 돌려도 가격이력이 불어나지 않게 합니다.
    if (get("SELECT id FROM supplier_products WHERE product_id = ? AND supplier_id = ?",
      target.id, supplier.id)) continue;

    const unitQty = row.unit_qty > 0 ? row.unit_qty : 1;
    run(`INSERT INTO supplier_products
           (id, product_id, supplier_id, raw_name, sell_unit, unit_qty, price, shipping, lead_days, quoted_at, source)
         VALUES (?,?,?,?,?,?,?,?,?,?, 'migrated')
         ON CONFLICT(product_id, supplier_id) DO NOTHING`,
      newId("SP"), target.id, supplier.id, row.name,
      row.unit || definition.baseUnit, unitQty, row.price, row.shipping || 0,
      leadDaysOf(row.lead_time), row.updated_at || today());
    run(`INSERT INTO price_history (product_id, supplier_id, price, unit_price, sell_unit, unit_qty, at, source)
         VALUES (?,?,?,?,?,?,?, 'migrated')`,
      target.id, supplier.id, row.price, row.price / unitQty,
      row.unit || definition.baseUnit, unitQty, row.updated_at || nowIso());
  }

  return { moved: legacy.length, map };
}

export function seedIfEmpty() {
  if (process.env.ERP_SKIP_SEED === "1") return;
  if (get("SELECT value FROM settings WHERE key = 'data.seedDisabled'")?.value === "1") return;
  if (get("SELECT COUNT(*) AS n FROM products").n > 0) return;
  if (!existsSync(seedPath)) return;
  const seed = JSON.parse(readFileSync(seedPath, "utf8"));

  tx(() => {
    setSetting("organization.name", seed.organization?.name || "INPACK");
    setSetting("organization.businessNumber", seed.organization?.businessNumber || "");
    setSetting("organization.dataMode", seed.organization?.dataMode || "integration");

    for (const warehouse of WAREHOUSE_SEED) {
      run("INSERT OR IGNORE INTO warehouses (id, name, location, manager) VALUES (?,?,?,?)",
        warehouse.id, warehouse.name, warehouse.location, warehouse.manager);
    }
    const warehouseIdByName = new Map(WAREHOUSE_SEED.map((w) => [w.name, w.id]));

    for (const user of seed.users || []) {
      run(`INSERT OR IGNORE INTO users (id, name, email, role, active, password_salt, password_hash, created_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        user.id, user.name, user.email, user.role, user.active ? 1 : 0,
        user.passwordSalt, user.passwordHash, user.createdAt);
    }

    for (const connector of seed.connectors || []) {
      run(`INSERT OR IGNORE INTO connectors (id, name, type, purpose, base_url, secret_env, enabled, status, last_sync_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        connector.id, connector.name, connector.type, connector.purpose,
        connector.baseUrl, connector.secretEnv, connector.enabled ? 1 : 0, connector.status, connector.lastSyncAt);
    }
    run(`INSERT OR IGNORE INTO connectors (id, name, type, purpose, base_url, secret_env, enabled, status, last_sync_at)
         VALUES ('g2b-bids','나라장터 입찰공고','g2b','공사·물품·용역 입찰공고 조회',
                 'https://apis.data.go.kr/1230000/ad/BidPublicInfoService','G2B_SERVICE_KEY',0,'설정 필요',NULL)`);

    for (const project of seed.projects || []) {
      run(`INSERT OR IGNORE INTO projects (id, name, site, manager, status, progress, budget)
           VALUES (?,?,?,?,?,?,0)`,
        project.id, project.name, project.site, project.manager, project.status,
        { "PRJ-2409-01": 72, "PRJ-2408-03": 54, "PRJ-2407-02": 88 }[project.id] || 50);
    }

    for (const supplier of seed.suppliers || []) {
      run(`INSERT OR IGNORE INTO suppliers (id, name, contact, phone, terms, lead_time, rating, status)
           VALUES (?,?,?,?,?,?,?,?)`,
        supplier.id, supplier.name, supplier.contact, supplier.phone,
        supplier.terms, supplier.leadTime, supplier.rating, supplier.status);
    }

    for (const order of seed.salesOrders || []) {
      run(`INSERT OR IGNORE INTO customers (id, name, terms, status)
           VALUES (?,?,'월말 정산','정상')`,
        `CUS-${order.customer}`, order.customer);
    }

    for (const product of seed.products || []) {
      run(`INSERT OR IGNORE INTO products
           (id, name, category, manufacturer, supplier, unit, unit_qty, price, unit_price, shipping, lead_time, safety_stock, spec, tags, updated_at)
           VALUES (?,?,'케이블',?,?,?,?,?,?,?,?,?,?,?,?)`,
        product.id, product.name, product.manufacturer, product.supplier,
        product.unit, 100, product.price, product.unitPrice, product.shipping,
        product.leadTime, 10, product.tags.join(" "), product.tags.join(","), product.updatedAt);
    }

    for (const row of seed.inventory || []) {
      const warehouseId = warehouseIdByName.get(row.warehouse) || "WH-HQ";
      run(`INSERT OR IGNORE INTO inventory_balances
           (product_id, warehouse_id, bin, on_hand, reserved, allocated, expected, safety_stock, last_movement)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        row.productId, warehouseId, row.bin, row.onHand, row.reserved,
        row.allocated, row.expected, row.safetyStock, row.lastMovement);
      run(`INSERT INTO inventory_transactions (at, type, product_id, warehouse_id, qty, balance_after, ref_type, ref_id, user, note)
           VALUES (?, 'ADJUST_IN', ?, ?, ?, ?, 'SEED', 'OPENING', '시스템', '기초재고 이관')`,
        `${row.lastMovement} 00:00`, row.productId, warehouseId, row.onHand, row.onHand);
      run("UPDATE products SET safety_stock = ? WHERE id = ?", row.safetyStock, row.productId);
    }

    for (const request of seed.purchases || []) {
      run(`INSERT OR IGNORE INTO purchase_requests
           (id, project_id, product_id, quantity, purpose, requested_date, status, requester, created_at)
           VALUES (?,?,?,?,?,?,?, '김현우', ?)`,
        request.id, request.projectId, request.productId, request.quantity,
        request.purpose, request.requestedDate, request.status, request.createdAt);
    }

    // 시드 발주는 품목 하나짜리라 줄 1번으로 들어갑니다.
    for (const order of seed.purchaseOrders || []) {
      run(`INSERT OR IGNORE INTO purchase_orders
           (id, supplier_id, line_count, quantity, received, amount, due_date, status, approver, created_at)
           VALUES (?,?,1,?,?,?,?,?,?,?)`,
        order.id, order.supplierId, order.quantity, order.received,
        order.amount, order.dueDate, order.status, order.approver, nowIso());
      run(`INSERT OR IGNORE INTO purchase_order_lines
           (id, order_id, line_no, product_id, project_id, quantity, received, unit_price, amount)
           VALUES (?,?,1,?,?,?,?,?,?)`,
        `${order.id}-01`, order.id, order.productId, order.projectId,
        order.quantity, order.received, Math.round(order.amount / order.quantity), order.amount);
    }

    for (const order of seed.salesOrders || []) {
      run(`INSERT OR IGNORE INTO sales_orders
           (id, project_id, customer, description, amount, received, invoice_date, due_date, status, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        order.id, order.projectId, order.customer, order.description, order.amount,
        order.status === "수금완료" ? order.amount : 0,
        order.invoiceDate, order.dueDate, order.status, nowIso());
    }

    for (const entry of seed.accountingEntries || []) {
      run(`INSERT OR IGNORE INTO accounting_entries
           (id, date, type, account, counterparty, description, project_id, debit, credit, status, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        entry.id, entry.date, entry.type, entry.account, entry.counterparty,
        entry.description, entry.projectId, entry.debit, entry.credit, entry.status, nowIso());
    }

    for (const log of (seed.auditLogs || []).slice().reverse()) {
      run("INSERT INTO audit_logs (at, user, module, action, detail) VALUES (?,?,?,?,?)",
        log.at, log.user, log.module, log.action, log.detail);
    }

    seedBidNotices();
    catalogFromLegacy();
  });
}

seedIfEmpty();

// 기존 DB에는 카탈로그가 있어도 products와의 연결 열이 비어 있을 수 있습니다.
// 함수는 공급처 행을 중복 생성하지 않으므로 시작할 때 안전하게 보정할 수 있습니다.
tx(() => catalogFromLegacy());
