/* ==========================================================================
   quotes.mjs — 견적함 / 업체별 견적 비교

   자재는 한 번에 여러 품목을 삽니다. 품목을 하나씩 최저가로 골라 봐야
   "그래서 어디에 주문할 것인가" 에는 답이 안 나옵니다. 배송비는 주문마다
   붙고, 한 업체가 세 품목 중 둘만 팔면 나머지는 따로 시켜야 하기 때문입니다.

     견적함(품목 + 수량)
        │
        ├─→ 업체별 견적    "이 업체에 다 맡기면 얼마"   (못 파는 품목도 같이 표시)
        └─→ 품목별 최적    "쪼개서 사면 얼마"           (업체 수 · 절감액)

   두 값을 나란히 놓는 것이 이 화면의 전부입니다. 결정은 사람이 합니다.
   ========================================================================== */

import { all, get, run, tx, nowIso, today, newId, auditLog } from "./db.mjs";

const VAT_RATE = 0.1;

// server.mjs 가 error.status 를 그대로 상태코드로 씁니다. schedule.mjs 와 같은 방식입니다.
const bad = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
const notFound = (message) => { throw Object.assign(new Error(message), { status: 404 }); };

/* ---------- 견적함 ------------------------------------------------------- */

const CART_SQL = `
  SELECT c.*,
         (SELECT COUNT(*) FROM quote_items WHERE cart_id = c.id) AS item_count
  FROM quote_carts c`;

export function listCarts(owner) {
  return all(`${CART_SQL} ORDER BY c.updated_at DESC LIMIT 50`).map((cart) => ({
    ...cart,
    mine: cart.owner === owner,
  }));
}

export function getCart(id) {
  const cart = get(`${CART_SQL} WHERE c.id = ?`, id);
  if (!cart) notFound("견적함을 찾을 수 없습니다.");
  return cart;
}

/** 견적함의 품목 — 제품 규격과 사내 재고를 함께 답니다. */
export function cartItems(cartId) {
  return all(`
    SELECT i.*, c.name AS product_name, c.spec_label, c.category, c.base_unit,
           c.manufacturer, c.certification, pr.name AS project_name,
           COALESCE((SELECT SUM(b.on_hand - b.reserved - b.allocated)
                     FROM inventory_balances b JOIN products p ON p.id = b.product_id
                     WHERE p.catalog_product_id = c.id), 0) AS available,
           (SELECT COUNT(*) FROM supplier_products WHERE product_id = c.id AND active = 1) AS supplier_count
    FROM quote_items i
    JOIN catalog_products c ON c.id = i.product_id
    LEFT JOIN projects pr ON pr.id = i.project_id
    WHERE i.cart_id = ?
    ORDER BY i.added_at`, cartId);
}

export function createCart(body, user) {
  const id = newId("QT");
  const title = String(body.title || "").trim() || `견적 ${today()}`;
  run(`INSERT INTO quote_carts (id, title, owner, status, note, created_at, updated_at)
       VALUES (?,?,?,'작성중',?,?,?)`,
    id, title, user.name, String(body.note || "").trim() || null, nowIso(), nowIso());
  auditLog(user.name, "구매", "견적함 생성", `${id} / ${title}`);
  return getCart(id);
}

/**
 * 담기. 같은 제품을 다시 담으면 수량을 더합니다 — 검색하다 두 번 담는 일이
 * 흔한데, 그때마다 줄이 늘면 견적이 어긋납니다.
 */
export function addItem(cartId, body, user) {
  const cart = getCart(cartId);
  if (cart.status !== "작성중") bad(`${cart.status} 상태의 견적함은 고칠 수 없습니다.`);

  const productId = String(body.productId || "").trim();
  const product = get("SELECT id, name, base_unit FROM catalog_products WHERE id = ?", productId);
  if (!product) bad("제품을 찾을 수 없습니다.");

  const quantity = Number(body.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) bad("수량은 0보다 커야 합니다.");

  const projectId = String(body.projectId || "").trim() || null;
  if (projectId && !get("SELECT id FROM projects WHERE id = ?", projectId)) bad("공사를 찾을 수 없습니다.");

  const existing = get("SELECT * FROM quote_items WHERE cart_id = ? AND product_id = ?", cartId, productId);
  if (existing) {
    run("UPDATE quote_items SET quantity = ?, project_id = ?, note = ? WHERE id = ?",
      existing.quantity + quantity, projectId || existing.project_id,
      String(body.note || "").trim() || existing.note, existing.id);
  } else {
    run(`INSERT INTO quote_items (id, cart_id, product_id, quantity, project_id, note, added_at)
         VALUES (?,?,?,?,?,?,?)`,
      newId("QI"), cartId, productId, quantity, projectId,
      String(body.note || "").trim() || null, nowIso());
  }
  touch(cartId);
  auditLog(user.name, "구매", "견적함 담기", `${cartId} / ${product.name} ${quantity}${product.base_unit}`);
  return cartItems(cartId);
}

export function updateItem(cartId, itemId, body, user) {
  const cart = getCart(cartId);
  if (cart.status !== "작성중") bad(`${cart.status} 상태의 견적함은 고칠 수 없습니다.`);
  const item = get("SELECT * FROM quote_items WHERE id = ? AND cart_id = ?", itemId, cartId);
  if (!item) notFound("견적 품목을 찾을 수 없습니다.");

  const updates = [];
  const params = [];
  if (body.quantity !== undefined) {
    const quantity = Number(body.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) bad("수량은 0보다 커야 합니다.");
    updates.push("quantity = ?"); params.push(quantity);
  }
  if (body.projectId !== undefined) {
    const projectId = String(body.projectId || "").trim() || null;
    if (projectId && !get("SELECT id FROM projects WHERE id = ?", projectId)) bad("공사를 찾을 수 없습니다.");
    updates.push("project_id = ?"); params.push(projectId);
  }
  if (body.note !== undefined) { updates.push("note = ?"); params.push(String(body.note || "").trim() || null); }
  if (updates.length) {
    run(`UPDATE quote_items SET ${updates.join(", ")} WHERE id = ?`, ...params, itemId);
    touch(cartId);
    auditLog(user.name, "구매", "견적 품목 수정", `${cartId} / ${itemId}`);
  }
  return cartItems(cartId);
}

export function removeItem(cartId, itemId, user) {
  const cart = getCart(cartId);
  if (cart.status !== "작성중") bad(`${cart.status} 상태의 견적함은 고칠 수 없습니다.`);
  const item = get("SELECT * FROM quote_items WHERE id = ? AND cart_id = ?", itemId, cartId);
  if (!item) notFound("견적 품목을 찾을 수 없습니다.");
  run("DELETE FROM quote_items WHERE id = ?", itemId);
  touch(cartId);
  auditLog(user.name, "구매", "견적함 비우기", `${cartId} / ${itemId}`);
  return cartItems(cartId);
}

export function removeCart(id, user) {
  const cart = getCart(id);
  run("DELETE FROM quote_items WHERE cart_id = ?", id);
  run("DELETE FROM quote_carts WHERE id = ?", id);
  auditLog(user.name, "구매", "견적함 삭제", `${id} / ${cart.title}`);
  return { ok: true };
}

const touch = (cartId) => run("UPDATE quote_carts SET updated_at = ? WHERE id = ?", nowIso(), cartId);

/* ---------- 견적 비교 ---------------------------------------------------- */

/**
 * 한 판매조건으로 필요한 수량을 살 때의 값.
 * 판매단위가 100m 릴이면 300m 는 3릴입니다. 최소주문수량도 함께 봅니다.
 */
function lineFor(offer, quantity, baseUnit) {
  const perPack = offer.unit_qty > 0 ? offer.unit_qty : 1;
  const packs = Math.max(offer.moq || 1, Math.ceil(quantity / perPack));
  return {
    supplier_id: offer.supplier_id,
    supplier_name: offer.supplier_name,
    offer_id: offer.id,
    sell_unit: offer.sell_unit,
    unit_qty: offer.unit_qty,
    price: offer.price,
    unit_price: Math.round((offer.price / perPack) * 100) / 100,
    price_basis: offer.price_basis,
    lead_days: offer.lead_days,
    shipping: offer.shipping || 0,
    packs,
    // 묶음으로 사면 필요한 양보다 더 사게 됩니다. 그 차이를 숨기지 않습니다.
    buy_quantity: Math.round(packs * perPack * 100) / 100,
    over: Math.round((packs * perPack - quantity) * 100) / 100,
    supply: packs * offer.price,
    base_unit: baseUnit,
  };
}

const money = (supply, shipping) => {
  const vat = Math.round((supply + shipping) * VAT_RATE);
  return { supply, shipping, vat, total: supply + shipping + vat };
};

/** 여러 줄을 한 주문으로 묶습니다. 배송비는 주문마다 한 번만 붙습니다. */
function summarize(lines) {
  const supply = lines.reduce((sum, line) => sum + line.supply, 0);
  // 품목마다 배송비가 다르게 적혀 있어도, 한 번 주문하면 한 번 냅니다. 가장 큰 값으로 잡습니다.
  const shipping = lines.length ? Math.max(...lines.map((line) => line.shipping)) : 0;
  // 전부 도착해야 일을 시작하므로 가장 늦은 납기가 그 주문의 납기입니다.
  const leads = lines.map((line) => line.lead_days).filter((value) => value !== null && value !== undefined);
  return {
    ...money(supply, shipping),
    lead_days: leads.length ? Math.max(...leads) : null,
    line_count: lines.length,
  };
}

/**
 * 견적함 비교.
 *  bySupplier — 업체마다 "이 견적함을 맡기면 얼마". 못 파는 품목은 missing 에 남깁니다.
 *  bestSplit  — 품목별 최저가 업체로 쪼갠 조합.
 */
export function compareCart(cartId) {
  const cart = getCart(cartId);
  const items = cartItems(cartId);
  if (!items.length) return { cart, items: [], suppliers: [], bestSplit: null, cheapestFull: null };

  // 견적함에 담긴 제품들의 모든 판매조건을 한 번에 읽습니다.
  const placeholders = items.map(() => "?").join(",");
  const offers = all(`
    SELECT sp.*, s.name AS supplier_name, s.rating, s.terms
    FROM supplier_products sp
    JOIN suppliers s ON s.id = sp.supplier_id
    WHERE sp.active = 1 AND sp.product_id IN (${placeholders})`, ...items.map((item) => item.product_id));

  const byProduct = new Map();
  for (const offer of offers) {
    if (!byProduct.has(offer.product_id)) byProduct.set(offer.product_id, []);
    byProduct.get(offer.product_id).push(offer);
  }

  /* --- 업체별: 이 업체에 다 맡기면 --- */
  const supplierIds = [...new Set(offers.map((offer) => offer.supplier_id))];
  const suppliers = supplierIds.map((supplierId) => {
    const lines = [];
    const missing = [];
    for (const item of items) {
      const candidates = (byProduct.get(item.product_id) || []).filter((offer) => offer.supplier_id === supplierId);
      if (!candidates.length) { missing.push({ product_id: item.product_id, product_name: item.product_name }); continue; }
      // 같은 업체가 여러 판매단위로 팔면 환산단가가 싼 쪽을 씁니다.
      const best = candidates.sort((a, b) => (a.price / (a.unit_qty || 1)) - (b.price / (b.unit_qty || 1)))[0];
      lines.push({ ...lineFor(best, item.quantity, item.base_unit), product_id: item.product_id, product_name: item.product_name, quantity: item.quantity });
    }
    const supplier = offers.find((offer) => offer.supplier_id === supplierId);
    return {
      supplier_id: supplierId,
      supplier_name: supplier.supplier_name,
      rating: supplier.rating,
      terms: supplier.terms,
      covers: lines.length,
      coverage: Math.round((lines.length / items.length) * 100),
      full: missing.length === 0,
      missing,
      lines,
      ...summarize(lines),
    };
  }).sort((a, b) => (b.full ? 1 : 0) - (a.full ? 1 : 0) || a.total - b.total);

  /* --- 품목별 최적: 쪼개서 사면 --- */
  const splitLines = items.map((item) => {
    const candidates = byProduct.get(item.product_id) || [];
    if (!candidates.length) return null;
    const scored = candidates.map((offer) => ({
      offer, line: lineFor(offer, item.quantity, item.base_unit),
    }));
    // 실제로 나가는 돈(묶음 반영 공급가)이 가장 작은 조건을 고릅니다.
    const best = scored.sort((a, b) => a.line.supply - b.line.supply)[0];
    return { ...best.line, product_id: item.product_id, product_name: item.product_name, quantity: item.quantity };
  }).filter(Boolean);

  const splitBySupplier = new Map();
  for (const line of splitLines) {
    if (!splitBySupplier.has(line.supplier_id)) splitBySupplier.set(line.supplier_id, []);
    splitBySupplier.get(line.supplier_id).push(line);
  }
  const splitOrders = [...splitBySupplier.entries()].map(([supplierId, lines]) => ({
    supplier_id: supplierId,
    supplier_name: lines[0].supplier_name,
    lines,
    ...summarize(lines),
  }));

  const bestSplit = splitOrders.length ? {
    orders: splitOrders,
    supplier_count: splitOrders.length,
    covers: splitLines.length,
    supply: splitOrders.reduce((sum, order) => sum + order.supply, 0),
    shipping: splitOrders.reduce((sum, order) => sum + order.shipping, 0),
    vat: splitOrders.reduce((sum, order) => sum + order.vat, 0),
    total: splitOrders.reduce((sum, order) => sum + order.total, 0),
    lead_days: Math.max(...splitOrders.map((order) => order.lead_days ?? 0)),
  } : null;

  const cheapestFull = suppliers.find((supplier) => supplier.full) || null;

  return {
    cart,
    items,
    suppliers,
    bestSplit,
    cheapestFull,
    // 쪼개 사면 얼마나 아끼는가. 배송비가 업체 수만큼 붙어 오히려 비쌀 수도 있습니다.
    splitSaving: cheapestFull && bestSplit ? cheapestFull.total - bestSplit.total : null,
    unpriced: items.filter((item) => !byProduct.has(item.product_id))
      .map((item) => ({ product_id: item.product_id, product_name: item.product_name })),
  };
}

/* ---------- 견적 → 구매요청 --------------------------------------------- */

/**
 * 고른 조합을 구매요청으로 넘깁니다.
 * 승인 → 발주로 이어지는 기존 흐름을 그대로 타되, 어느 견적에서 나왔는지
 * 품목마다 공급처와 단가를 붙여 보냅니다.
 *
 * lines: [{ productId, quantity, supplierProductId, projectId }]
 */
export function requestFromQuote(cartId, body, createRequest, user) {
  const cart = getCart(cartId);
  if (cart.status !== "작성중") bad(`${cart.status} 상태의 견적함은 다시 요청할 수 없습니다.`);
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length) bad("구매요청할 품목을 선택해 주세요.");

  return tx(() => {
    const created = [];
    for (const line of lines) {
      const item = get("SELECT * FROM quote_items WHERE cart_id = ? AND product_id = ?",
        cartId, String(line.productId || ""));
      if (!item) bad("견적함에 없는 품목입니다.");
      const offer = get("SELECT * FROM supplier_products WHERE id = ?", String(line.supplierProductId || ""));
      if (!offer) bad("판매조건을 찾을 수 없습니다.");
      if (offer.product_id !== item.product_id) bad("다른 제품의 판매조건입니다.");

      created.push(createRequest({
        productId: item.product_id,
        projectId: line.projectId || item.project_id,
        quantity: Math.ceil(item.quantity),
        purpose: String(body.purpose || "").trim() || `견적 ${cart.title}`,
        requestedDate: body.requestedDate,
        supplierProductId: offer.id,
      }, user));
    }
    run("UPDATE quote_carts SET status = '발주완료', updated_at = ? WHERE id = ?", nowIso(), cartId);
    auditLog(user.name, "구매", "견적 → 구매요청", `${cartId} / ${created.length}건`);
    return { cart: getCart(cartId), requests: created };
  });
}
