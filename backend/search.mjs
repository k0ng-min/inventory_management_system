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

/* ==========================================================================
   제품 비교
   여러 제품을 나란히 놓고 고릅니다. 전기자재는 가격보다 규격이 먼저라서,
   비교 항목을 규격 → 가격 → 납기 → 제조사/품질 순서로 묶어 내려보냅니다.
   화면은 이 순서를 그대로 그리기만 하면 됩니다.
   ========================================================================== */

const VAT_RATE = 0.1;

/**
 * 판매단위 표기. "ROLL" 처럼 수량이 안 보이는 단위에만 환산량을 괄호로 답니다.
 * "100m (100m)" 같은 중복을 만들지 않기 위해서입니다.
 */
const sellUnitLabel = (offer, baseUnit) => {
  const unit = String(offer.sell_unit || "").trim();
  if (!(offer.unit_qty > 1)) return unit;
  return /\d/.test(unit) ? unit : `${unit} (${offer.unit_qty}${baseUnit})`;
};

/** 값이 서로 다른 행을 표시하기 위한 비교 키. 숫자와 문자를 같은 방식으로 다룹니다. */
const sameValue = (a, b) => {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-9;
  return String(a) === String(b);
};

/**
 * 제품별 비교 자료 한 벌.
 * quantity — 총 구매금액을 계산할 수량(기본단위 기준). 업체마다 판매단위가
 * 달라도 "이만큼 사려면 얼마인가"로 답이 맞춰집니다.
 */
function compareRow(productId, quantity) {
  const product = get("SELECT * FROM catalog_products WHERE id = ?", productId);
  if (!product) return null;

  const offers = offersFor(productId);
  const best = offers[0] || null;                       // offersFor 가 환산단가 오름차순
  const fastest = offers.filter((row) => row.lead_days !== null)
    .sort((a, b) => a.lead_days - b.lead_days)[0] || null;
  const purchase = lastPurchase(productId);

  const stock = get(`
    SELECT COALESCE(SUM(b.on_hand), 0) AS on_hand,
           COALESCE(SUM(b.on_hand - b.reserved - b.allocated), 0) AS available
    FROM inventory_balances b JOIN products p ON p.id = b.product_id
    WHERE p.catalog_product_id = ?`, productId);

  // 판매단위가 ROLL(100m) 이면 3개를 사야 300m 입니다. MOQ 와 최소 구매 묶음을 함께 봅니다.
  let packs = null;
  let supply = null;
  let shipping = null;
  if (best && quantity > 0) {
    const perPack = best.unit_qty > 0 ? best.unit_qty : 1;
    packs = Math.max(best.moq || 1, Math.ceil(quantity / perPack));
    supply = packs * best.price;
    shipping = best.shipping || 0;
  }
  const vat = supply === null ? null : Math.round((supply + shipping) * VAT_RATE);
  const total = supply === null ? null : supply + shipping + vat;

  return {
    id: product.id,
    name: product.name,
    category: product.category,
    specs: JSON.parse(product.specs || "{}"),
    spec_label: product.spec_label,
    manufacturer: product.manufacturer,
    certification: product.certification,
    base_unit: product.base_unit,
    confidence: product.confidence,
    supplier_count: offers.length,
    best_supplier: best?.supplier_name || null,
    best_supplier_id: best?.supplier_id || null,
    best_offer_id: best?.id || null,
    sell_unit: best ? sellUnitLabel(best, product.base_unit) : null,
    price: best?.price ?? null,
    unit_price: best ? Math.round(best.unit_price * 100) / 100 : null,
    price_basis: best?.price_basis || null,
    product_url: best?.product_url || null,
    packs,
    supply,
    shipping,
    vat,
    total,
    lead_days: best?.lead_days ?? null,
    best_lead: fastest?.lead_days ?? null,
    best_lead_supplier: fastest?.supplier_name || null,
    supplier_rating: best?.rating ?? null,
    stock_on_hand: stock.on_hand,
    stock_available: stock.available,
    bought_before: Boolean(purchase),
    last_buy_price: purchase?.price ?? null,
    last_buy_unit_price: purchase ? Math.round(purchase.unit_price * 100) / 100 : null,
    last_buy_at: purchase?.at || null,
    last_buy_supplier: purchase?.supplier_name || null,
  };
}

/**
 * 비교표. rows 는 화면에 그릴 순서대로 내려가고, 각 행의 differs 가
 * "제품끼리 값이 갈리는 항목"을 표시합니다. 다른 곳만 눈에 띄게 하려는 것입니다.
 */
export function compareProducts(ids, quantity = 1) {
  const items = ids.map((id) => compareRow(id, quantity)).filter(Boolean);
  if (!items.length) return { quantity, items: [], groups: [] };

  // 종류가 섞이면 규격 필드가 서로 달라, 공통 필드만 비교합니다.
  const categories = [...new Set(items.map((item) => item.category))];
  const specFields = categories.length === 1
    ? (CATEGORIES[categories[0]] || CATEGORIES.etc).fields
    : [];

  const groups = [
    {
      key: "spec",
      label: "규격",
      note: categories.length === 1
        ? (CATEGORIES[categories[0]] || CATEGORIES.etc).label
        : "종류가 서로 달라 공통 항목만 비교합니다",
      rows: [
        { key: "category", label: "품목 분류", format: "category" },
        ...specFields.map((field) => ({
          key: `spec.${field.key}`, label: field.label, unit: field.unit || null, format: "spec",
        })),
        { key: "certification", label: "인증", format: "text" },
        { key: "manufacturer", label: "제조사", format: "text" },
      ],
    },
    {
      key: "price",
      label: "가격",
      note: `${quantity}${items[0].base_unit} 기준 · 부가세 10% 별도 표기`,
      rows: [
        { key: "best_supplier", label: "판매처", format: "text" },
        { key: "price_basis", label: "가격구분", format: "basis" },
        { key: "sell_unit", label: "판매단위", format: "text" },
        { key: "price", label: "단가", format: "won" },
        { key: "unit_price", label: `환산단가`, format: "won", suffix: "/기본단위" },
        { key: "packs", label: "구매 수량", format: "int", suffix: "묶음" },
        { key: "supply", label: "공급가액", format: "won" },
        { key: "shipping", label: "배송비", format: "won" },
        { key: "vat", label: "부가세", format: "won" },
        { key: "total", label: "총 구매금액", format: "won", strong: true },
      ],
    },
    {
      key: "lead",
      label: "납기 · 재고",
      rows: [
        { key: "lead_days", label: "납기", format: "lead" },
        { key: "best_lead", label: "최단 납기(전 업체)", format: "lead" },
        { key: "stock_available", label: "사내 가용재고", format: "int" },
        { key: "supplier_count", label: "비교 가능 업체", format: "int", suffix: "곳" },
      ],
    },
    {
      key: "history",
      label: "과거 구매",
      rows: [
        { key: "bought_before", label: "구매 이력", format: "bool" },
        { key: "last_buy_unit_price", label: "마지막 구매단가", format: "won" },
        { key: "last_buy_supplier", label: "마지막 구매처", format: "text" },
        { key: "last_buy_at", label: "마지막 구매일", format: "date" },
        { key: "delta", label: "가격변동", format: "delta" },
      ],
    },
    {
      key: "quality",
      label: "품질",
      rows: [{ key: "supplier_rating", label: "공급처 평점", format: "rating" }],
    },
  ];

  const pick = (item, key) => (key.startsWith("spec.")
    ? item.specs?.[key.slice(5)] ?? null
    : key === "delta"
      ? (item.last_buy_unit_price && item.unit_price !== null
        ? Math.round((item.unit_price - item.last_buy_unit_price) * 100) / 100 : null)
      : item[key] ?? null);

  for (const group of groups) {
    for (const row of group.rows) {
      row.values = items.map((item) => pick(item, row.key));
      row.differs = row.values.some((value) => !sameValue(value, row.values[0]));
    }
    // 값이 전부 비어 있는 행은 화면을 채우기만 하므로 내려보내지 않습니다.
    group.rows = group.rows.filter((row) => row.values.some((value) => value !== null && value !== ""));
  }

  // 최저 총액·최단 납기를 짚어 줍니다. 규격이 맞는지 본 다음에 볼 것들입니다.
  const totals = items.map((item) => item.total).filter((value) => value !== null);
  const leads = items.map((item) => item.lead_days).filter((value) => value !== null);
  return {
    quantity,
    items,
    groups: groups.filter((group) => group.rows.length),
    cheapestTotal: totals.length ? Math.min(...totals) : null,
    fastestLead: leads.length ? Math.min(...leads) : null,
    mixedCategory: categories.length > 1,
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
