/* ==========================================================================
   search.mjs — 통합검색 / 업체별 가격비교
   검색어도 제품명과 같은 파서를 태우므로 "CV 2.5 4C" 와 "CV2.5SQ4C" 가
   같은 결과를 냅니다. 결과는 제품 단위로 묶고, 그 아래에 업체별 가격을 답니다.
   ========================================================================== */

import { all, get } from "./db.mjs";
import { parseQuery, matchScore, CATEGORIES, normalizeText } from "./catalog.mjs";

/** "케이블", "차단기" 처럼 분류 이름으로 검색했을 때 해당 종류로 좁힙니다. */
function categoryFromWord(text) {
  const needle = normalizeText(text);
  if (!needle) return null;
  for (const [key, definition] of Object.entries(CATEGORIES)) {
    const label = normalizeText(definition.label);
    if (label.split(/[/·]/).some((part) => part && (needle.includes(part) || part.includes(needle)))) return key;
  }
  return null;
}

/**
 * 그 제품을 가장 최근에 '실제로 구매한'(발주 기표된) 값 한 칸.
 * 지난 구매가는 검색 결과 행에서 바로 보여야 하므로 목록 쿼리에 함께 싣습니다.
 */
const lastBuy = (column) => `(SELECT h.${column} FROM price_history h
   WHERE h.product_id = c.id AND h.ref_type = 'PO' ORDER BY h.id DESC LIMIT 1)`;

const PRODUCT_SQL = `
  SELECT c.*,
         (SELECT COUNT(*) FROM supplier_products WHERE product_id = c.id AND active = 1) AS supplier_count,
         (SELECT MIN(price / unit_qty) FROM supplier_products WHERE product_id = c.id AND active = 1) AS best_unit_price,
         (SELECT MIN(lead_days) FROM supplier_products WHERE product_id = c.id AND active = 1) AS best_lead,
         COALESCE((SELECT SUM(b.on_hand) FROM inventory_balances b
                    JOIN products p ON p.id = b.product_id WHERE p.catalog_product_id = c.id), 0) AS on_hand,
         COALESCE((SELECT SUM(b.on_hand - b.reserved - b.allocated) FROM inventory_balances b
                    JOIN products p ON p.id = b.product_id WHERE p.catalog_product_id = c.id), 0) AS available,
         (SELECT group_concat(COALESCE(sp.raw_name,'') || ' ' || COALESCE(s.name,''), ' ')
            FROM supplier_products sp LEFT JOIN suppliers s ON s.id = sp.supplier_id
           WHERE sp.product_id = c.id) AS supplier_blob,
         ${lastBuy("unit_price")} AS last_buy_unit_price,
         ${lastBuy("price")}      AS last_buy_price,
         ${lastBuy("at")}         AS last_buy_at,
         (SELECT s.name FROM price_history h LEFT JOIN suppliers s ON s.id = h.supplier_id
           WHERE h.product_id = c.id AND h.ref_type = 'PO' ORDER BY h.id DESC LIMIT 1) AS last_buy_supplier
  FROM catalog_products c
  WHERE c.active = 1`;

const OFFER_SQL = `
  SELECT sp.*, s.name AS supplier_name, s.rating, s.terms, s.status AS supplier_status,
         (sp.price / sp.unit_qty) AS unit_price
  FROM supplier_products sp
  JOIN suppliers s ON s.id = sp.supplier_id
  WHERE sp.product_id = ? AND sp.active = 1
  ORDER BY unit_price`;

/** 제품의 업체별 판매 조건. 비교 화면의 행이 됩니다. */
export function offersFor(productId) {
  return all(OFFER_SQL, productId).map((row) => ({
    ...row,
    unit_price: Math.round(row.unit_price * 100) / 100,
    total_first_order: row.price * (row.moq || 1) + (row.shipping || 0),
  }));
}

/** 최근 구매가 — "지난번에 얼마에 샀는가" 에 답합니다. */
export function lastPurchase(productId) {
  return get(`
    SELECT h.*, s.name AS supplier_name
    FROM price_history h
    LEFT JOIN suppliers s ON s.id = h.supplier_id
    WHERE h.product_id = ? AND h.ref_type = 'PO'
    ORDER BY h.id DESC LIMIT 1`, productId);
}

/** 가격 추이 — 최근 n건. 급등 감지에 씁니다. */
export function priceTrend(productId, limit = 24) {
  return all(`
    SELECT h.at, h.unit_price, h.price, h.supplier_id, s.name AS supplier_name, h.source
    FROM price_history h LEFT JOIN suppliers s ON s.id = h.supplier_id
    WHERE h.product_id = ? ORDER BY h.id DESC LIMIT ?`, productId, limit).reverse();
}

/**
 * 통합검색.
 * sort: match(규격 일치순) | price(단가순) | lead(납기순) | stock(사내재고순)
 */
export function searchProducts({ query = "", category = "", sort = "match", limit = 60, inStockOnly = false }) {
  const parsed = parseQuery(query);
  const clauses = [];
  const params = [];

  if (category) { clauses.push("c.category = ?"); params.push(category); }
  if (inStockOnly) clauses.push(`(SELECT COALESCE(SUM(b.on_hand),0) FROM inventory_balances b
    JOIN products p ON p.id = b.product_id WHERE p.catalog_product_id = c.id) > 0`);

  // 검색어에서 규격을 읽었으면 그 종류로 먼저 좁힙니다.
  if (!category && parsed.category) { clauses.push("c.category = ?"); params.push(parsed.category); }

  // 규격을 못 읽었어도 "케이블" 같은 분류명이면 그 종류를 보여 줍니다.
  const wordCategory = !category && !parsed.category ? categoryFromWord(query) : null;
  if (wordCategory) { clauses.push("c.category = ?"); params.push(wordCategory); }

  // 토큰은 이름·규격·제조사·업체 원본명 어디에 있어도 통과시키고, 정밀도는 점수로 가립니다.
  if (!wordCategory) {
    for (const token of parsed.tokens) {
      clauses.push(`(UPPER(c.name) LIKE ? OR UPPER(c.spec_label) LIKE ?
        OR UPPER(COALESCE(c.manufacturer,'')) LIKE ? OR UPPER(c.spec_key) LIKE ?
        OR EXISTS (SELECT 1 FROM supplier_products sp
                   LEFT JOIN suppliers s ON s.id = sp.supplier_id
                   WHERE sp.product_id = c.id
                     AND (UPPER(sp.raw_name) LIKE ? OR UPPER(COALESCE(s.name,'')) LIKE ?)))`);
      const like = `%${token}%`;
      params.push(like, like, like, like, like, like);
    }
  }

  let rows = all(`${PRODUCT_SQL}${clauses.length ? ` AND ${clauses.join(" AND ")}` : ""}`, ...params);

  // 토큰 검색으로 못 걸러진 경우(예: "CV2.5SQ4C" 붙여쓰기)를 규격 키로 한 번 더 시도합니다.
  if (!rows.length && parsed.key) {
    rows = all(`${PRODUCT_SQL} AND c.spec_key = ?`, parsed.key);
  }

  const scored = rows.map((row) => ({
    ...row,
    specs: JSON.parse(row.specs || "{}"),
    match: wordCategory ? 100 : matchScore(parsed, row),
    best_unit_price: row.best_unit_price === null ? null : Math.round(row.best_unit_price * 100) / 100,
    last_buy_unit_price: row.last_buy_unit_price === null ? null : Math.round(row.last_buy_unit_price * 100) / 100,
  })).filter((row) => row.match > 0 || !query || Boolean(wordCategory));

  const compare = {
    match: (a, b) => b.match - a.match || (a.best_unit_price ?? Infinity) - (b.best_unit_price ?? Infinity),
    price: (a, b) => (a.best_unit_price ?? Infinity) - (b.best_unit_price ?? Infinity),
    lead: (a, b) => (a.best_lead ?? 999) - (b.best_lead ?? 999) || (a.best_unit_price ?? Infinity) - (b.best_unit_price ?? Infinity),
    stock: (a, b) => b.available - a.available,
  }[sort] || null;
  if (compare) scored.sort(compare);

  return {
    query,
    parsed: { category: parsed.category, specs: parsed.specs, recognized: Boolean(parsed.category) },
    categories: CATEGORIES,
    total: scored.length,
    products: scored.slice(0, limit),
  };
}

/** 제품 상세 — 업체별 가격 + 최근 구매가 + 가격추이 + 창고별 재고 */
export function productDetail(productId) {
  const product = get("SELECT * FROM catalog_products WHERE id = ?", productId);
  if (!product) return null;
  return {
    product: { ...product, specs: JSON.parse(product.specs || "{}") },
    offers: offersFor(productId),
    lastPurchase: lastPurchase(productId),
    trend: priceTrend(productId),
    stock: all(`
      SELECT b.*, w.name AS warehouse_name, (b.on_hand - b.reserved - b.allocated) AS available
      FROM inventory_balances b
      JOIN products p ON p.id = b.product_id
      JOIN warehouses w ON w.id = b.warehouse_id
      WHERE p.catalog_product_id = ?`, productId),
  };
}

/**
 * 가격 급등 감지 — 같은 공급처의 직전 가격 대비 상승률.
 * 홈 화면의 "최근 가격 변동" 에 씁니다.
 */
export function priceAlerts({ days = 30, threshold = 5 } = {}) {
  const rows = all(`
    SELECT h.product_id, h.supplier_id, h.unit_price, h.at,
           c.name AS product_name, c.base_unit, s.name AS supplier_name
    FROM price_history h
    JOIN catalog_products c ON c.id = h.product_id
    LEFT JOIN suppliers s ON s.id = h.supplier_id
    WHERE date(substr(h.at,1,10)) >= date('now', ?)
    ORDER BY h.product_id, h.supplier_id, h.id`, `-${days} day`);

  const latest = new Map();
  const alerts = [];
  for (const row of rows) {
    const key = `${row.product_id}|${row.supplier_id}`;
    const previous = latest.get(key);
    if (previous && previous.unit_price > 0) {
      const change = ((row.unit_price - previous.unit_price) / previous.unit_price) * 100;
      if (Math.abs(change) >= threshold) {
        alerts.push({
          product_id: row.product_id,
          product_name: row.product_name,
          supplier_name: row.supplier_name,
          base_unit: row.base_unit,
          from: Math.round(previous.unit_price * 100) / 100,
          to: Math.round(row.unit_price * 100) / 100,
          change: Math.round(change * 10) / 10,
          at: row.at,
        });
      }
    }
    latest.set(key, row);
  }
  return alerts.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
}
