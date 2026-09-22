/* ==========================================================================
   orders.mjs — 발주서 (헤더 + 품목 줄)

   발주번호 하나에 품목 여러 줄이 달립니다. 공급처에 보내는 발주서가 한 장이면
   내부 번호도 하나여야 대조가 어긋나지 않기 때문입니다.

     purchase_orders        헤더 — 공급처 · 납기 · 상태 · 합계
       └ purchase_order_lines  줄 — 품목 · 공사 · 수량 · 단가 · 입고

   수량과 입고는 줄에 붙고, 헤더의 quantity/received/amount 는 줄의 합입니다.
   합과 상태를 고치는 길은 recalcOrder() 하나뿐입니다 — 두 군데서 고치면
   반드시 갈라집니다.
   ========================================================================== */

import { all, get, run, tx, nowIso, today, yearMonth, nextDocNo, auditLog, moveStock } from "./db.mjs";

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

const str = (value) => (value === undefined || value === null ? null : String(value).trim() || null);
const int = (value) => {
  if (value === "" || value === undefined || value === null) return 0;
  const parsed = Number(String(value).replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
};

export const ORDER_SQL = `
  SELECT o.*, s.name AS supplier_name, s.biz_no AS supplier_biz_no,
         s.contact AS supplier_contact, s.phone AS supplier_phone, s.email AS supplier_email,
         (o.quantity - o.received) AS remaining
  FROM purchase_orders o
  LEFT JOIN suppliers s ON s.id = o.supplier_id`;

const LINE_SQL = `
  SELECT l.*, p.name AS product_name, p.unit, p.manufacturer, p.spec,
         pr.name AS project_name,
         (l.quantity - l.received) AS remaining
  FROM purchase_order_lines l
  LEFT JOIN products p ON p.id = l.product_id
  LEFT JOIN projects pr ON pr.id = l.project_id`;

export const linesOf = (orderId) => all(`${LINE_SQL} WHERE l.order_id = ? ORDER BY l.line_no`, orderId);

export const orderWithLines = (orderId) => {
  const order = get(`${ORDER_SQL} WHERE o.id = ?`, orderId);
  if (!order) fail("발주서를 찾을 수 없습니다.", 404);
  return { ...order, lines: linesOf(orderId) };
};

/** 목록 — 줄을 한 번에 읽어 헤더에 묶습니다. 건수가 적어 N+1 을 걱정할 규모가 아닙니다. */
export function listOrders() {
  const orders = all(`${ORDER_SQL} ORDER BY o.id DESC`);
  const lines = all(`${LINE_SQL} ORDER BY l.order_id, l.line_no`);
  const byOrder = new Map();
  for (const line of lines) {
    if (!byOrder.has(line.order_id)) byOrder.set(line.order_id, []);
    byOrder.get(line.order_id).push(line);
  }
  return orders.map((order) => ({ ...order, lines: byOrder.get(order.id) || [] }));
}

/**
 * 합계와 상태를 줄에서 다시 계산합니다. 발주를 건드리는 모든 길이 여기로 모입니다.
 * 취소와 승인대기는 입고가 없으니 그대로 둡니다.
 */
export function recalcOrder(orderId) {
  const order = get("SELECT * FROM purchase_orders WHERE id = ?", orderId);
  if (!order) return null;
  const sum = get(`SELECT COUNT(*) AS n,
                          COALESCE(SUM(quantity),0) AS quantity,
                          COALESCE(SUM(received),0) AS received,
                          COALESCE(SUM(amount),0) AS amount
                   FROM purchase_order_lines WHERE order_id = ?`, orderId);

  let status = order.status;
  if (order.status !== "취소" && order.status !== "승인대기") {
    status = sum.received === 0 ? "발주완료"
      : sum.received >= sum.quantity ? "입고완료" : "부분입고";
  }
  run(`UPDATE purchase_orders SET line_count = ?, quantity = ?, received = ?, amount = ?, status = ?
       WHERE id = ?`, sum.n, sum.quantity, sum.received, sum.amount, status, orderId);
  return orderWithLines(orderId);
}

/* ---------- 생성 --------------------------------------------------------- */

/**
 * 줄 입력을 다듬습니다.
 * 품목 하나짜리 옛 형식({ productId, quantity, unitPrice })도 줄 하나로 받습니다 —
 * 기존 화면과 스크립트를 깨지 않기 위해서입니다.
 */
function normalizeLines(body) {
  const raw = Array.isArray(body.lines) && body.lines.length
    ? body.lines
    : (body.productId ? [{
      productId: body.productId, quantity: body.quantity,
      unitPrice: body.unitPrice, projectId: body.projectId,
      supplierProductId: body.supplierProductId, requestId: body.requestId,
    }] : []);
  if (!raw.length) fail("발주할 품목을 한 줄 이상 넣어 주세요.");

  return raw.map((line, index) => {
    const product = get("SELECT * FROM products WHERE id = ?", str(line.productId));
    if (!product) fail(`${index + 1}번 줄: 품목을 선택해 주세요.`);
    const quantity = int(line.quantity);
    if (quantity < 1) fail(`${index + 1}번 줄(${product.name}): 수량은 1 이상이어야 합니다.`);
    const projectId = str(line.projectId);
    if (projectId && !get("SELECT id FROM projects WHERE id = ?", projectId)) {
      fail(`${index + 1}번 줄: 공사를 찾을 수 없습니다.`);
    }
    const offer = str(line.supplierProductId)
      ? get("SELECT * FROM supplier_products WHERE id = ?", str(line.supplierProductId)) : null;
    const unitPrice = line.unitPrice !== undefined && line.unitPrice !== null
      ? int(line.unitPrice) : (offer?.price ?? product.price ?? 0);
    return {
      product, projectId, quantity, unitPrice,
      supplierProductId: offer?.id || null,
      sourceUrl: offer?.product_url || null,
      requestId: str(line.requestId),
      note: str(line.note),
    };
  });
}

/** 줄을 실제로 넣습니다. 줄 번호는 1부터, 줄 id 는 발주번호-01 꼴입니다. */
function insertLines(orderId, lines) {
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    run(`INSERT INTO purchase_order_lines
           (id, order_id, line_no, product_id, project_id, request_id, supplier_product_id,
            source_url, quantity, received, unit_price, amount, note)
         VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?)`,
      `${orderId}-${String(lineNo).padStart(2, "0")}`, orderId, lineNo,
      line.product.id, line.projectId, line.requestId, line.supplierProductId,
      line.sourceUrl, line.quantity, line.unitPrice, line.unitPrice * line.quantity, line.note);
  });
}

/** 발주 확정 시 입고예정 수량을 줄마다 올립니다. */
function addExpected(lines, warehouseId) {
  if (!warehouseId) return;
  for (const line of lines) {
    run(`INSERT INTO inventory_balances (product_id, warehouse_id, expected, safety_stock)
         VALUES (?,?,?,?)
         ON CONFLICT(product_id, warehouse_id) DO UPDATE SET expected = expected + excluded.expected`,
      line.product.id, warehouseId, line.quantity, line.product.safety_stock || 0);
  }
}

const defaultWarehouse = () => get("SELECT id FROM warehouses WHERE active = 1 ORDER BY id LIMIT 1")?.id || null;

export function createOrder(body, user) {
  return tx(() => {
    const supplier = get("SELECT * FROM suppliers WHERE id = ?", str(body.supplierId));
    if (!supplier) fail("공급처를 선택해 주세요.");
    const lines = normalizeLines(body);
    const status = str(body.status) === "발주완료" ? "발주완료" : "승인대기";

    const id = nextDocNo("purchase_orders", "PO");
    run(`INSERT INTO purchase_orders
           (id, supplier_id, line_count, quantity, received, amount, due_date, status, approver, note, created_at)
         VALUES (?,?,0,0,0,0,?,?,?,?,?)`,
      id, supplier.id, str(body.dueDate), status, user.name, str(body.note), nowIso());
    insertLines(id, lines);
    if (status === "발주완료") addExpected(lines, str(body.warehouseId) || defaultWarehouse());

    const order = recalcOrder(id);
    auditLog(user.name, "구매", "발주 등록",
      `${id} / ${supplier.name} / ${lines.length}품목 / ₩${order.amount.toLocaleString("ko-KR")}`);
    return order;
  });
}

/**
 * 승인된 구매요청 여러 건을 발주서 한 장으로 묶습니다.
 * 견적에서 한 업체에 여러 품목을 시키는 경우가 이 길로 들어옵니다.
 */
export function bundleRequests(body, user) {
  return tx(() => {
    const ids = (Array.isArray(body.requestIds) ? body.requestIds : []).map(String).filter(Boolean);
    if (ids.length < 1) fail("묶을 구매요청을 선택해 주세요.");

    const requests = ids.map((id) => {
      const request = get("SELECT * FROM purchase_requests WHERE id = ?", id);
      if (!request) fail(`구매요청 ${id} 를 찾을 수 없습니다.`, 404);
      if (request.status !== "구매요청") fail(`${id} 는 이미 ${request.status} 상태입니다.`);
      return request;
    });

    // 공급처가 섞이면 발주서 한 장으로 보낼 수 없습니다.
    const supplierId = str(body.supplierId) || requests[0].preferred_supplier_id;
    if (!supplierId) fail("발주할 공급처를 선택해 주세요.");
    const mixed = requests.find((request) =>
      request.preferred_supplier_id && request.preferred_supplier_id !== supplierId);
    if (mixed) fail(`${mixed.id} 의 공급처가 다릅니다. 같은 공급처끼리만 묶을 수 있습니다.`);
    const supplier = get("SELECT * FROM suppliers WHERE id = ?", supplierId);
    if (!supplier) fail("공급처를 찾을 수 없습니다.");

    const lines = normalizeLines({
      lines: requests.map((request) => ({
        productId: request.product_id,
        projectId: request.project_id,
        quantity: request.quantity,
        unitPrice: request.quoted_unit_price ?? undefined,
        supplierProductId: request.supplier_product_id,
        requestId: request.id,
      })),
    });

    const id = nextDocNo("purchase_orders", "PO");
    // 납기를 안 주면 요청들 중 가장 이른 희망납기를 씁니다. 그것도 없으면 비워 둡니다.
    const dueDate = str(body.dueDate)
      || requests.map((request) => request.requested_date).filter(Boolean).sort()[0]
      || null;
    run(`INSERT INTO purchase_orders
           (id, supplier_id, line_count, quantity, received, amount, due_date, status, approver, note, created_at)
         VALUES (?,?,0,0,0,0,?,'발주완료',?,?,?)`,
      id, supplier.id, dueDate, user.name, str(body.note), nowIso());
    insertLines(id, lines);

    for (const request of requests) {
      run("UPDATE purchase_requests SET status = '발주완료', approver = ?, approved_at = ? WHERE id = ?",
        user.name, nowIso(), request.id);
    }
    addExpected(lines, str(body.warehouseId) || defaultWarehouse());

    const order = recalcOrder(id);
    auditLog(user.name, "구매", "구매요청 묶어 발주",
      `${ids.join(", ")} → ${id} / ${lines.length}품목 / ₩${order.amount.toLocaleString("ko-KR")}`);
    return order;
  });
}

/* ---------- 승인 · 취소 -------------------------------------------------- */

export function approveOrder(id, body, user) {
  return tx(() => {
    const order = get("SELECT * FROM purchase_orders WHERE id = ?", id);
    if (!order) fail("발주서를 찾을 수 없습니다.", 404);
    if (order.status !== "승인대기") fail(`이미 ${order.status} 상태입니다.`);

    run("UPDATE purchase_orders SET status = '발주완료', approver = ? WHERE id = ?", user.name, id);
    const lines = linesOf(id).map((line) => ({
      product: get("SELECT * FROM products WHERE id = ?", line.product_id),
      quantity: line.quantity,
    })).filter((line) => line.product);
    addExpected(lines, str(body?.warehouseId) || defaultWarehouse());

    auditLog(user.name, "승인", "발주 승인", `${id} / ₩${order.amount.toLocaleString("ko-KR")}`);
    return orderWithLines(id);
  });
}

export function cancelOrder(id, user) {
  return tx(() => {
    const order = get("SELECT * FROM purchase_orders WHERE id = ?", id);
    if (!order) fail("발주서를 찾을 수 없습니다.", 404);
    if (order.received > 0) fail("이미 입고된 발주는 취소할 수 없습니다. 반품으로 처리해 주세요.");

    // 확정된 발주였다면 잡아 둔 입고예정을 되돌립니다.
    if (order.status === "발주완료") {
      for (const line of linesOf(id)) {
        run(`UPDATE inventory_balances SET expected = MAX(0, expected - ?)
             WHERE product_id = ? AND expected > 0`, line.quantity, line.product_id);
      }
    }
    run("UPDATE purchase_orders SET status = '취소' WHERE id = ?", id);
    auditLog(user.name, "구매", "발주 취소", id);
    return orderWithLines(id);
  });
}

/* ---------- 입고 --------------------------------------------------------- */

/**
 * 입고. 한 번의 호출이 입고 한 묶음(batch)이고, 줄마다 입고 행이 남습니다.
 * 자재는 나뉘어 들어오는 것이 보통이라 줄별로 수량을 따로 받습니다.
 *
 * body: { warehouseId, receivedAt, note, lines: [{ lineId, quantity, bin }] }
 * 줄이 하나뿐인 발주는 옛 형식({ quantity })도 받습니다.
 */
export function receiveOrder(id, body, user, hooks = {}) {
  return tx(() => {
    const order = get("SELECT * FROM purchase_orders WHERE id = ?", id);
    if (!order) fail("발주서를 찾을 수 없습니다.", 404);
    if (order.status === "승인대기") fail("승인되지 않은 발주는 입고할 수 없습니다.");
    if (order.status === "취소") fail("취소된 발주입니다.");

    const warehouseId = str(body.warehouseId);
    const warehouse = get("SELECT * FROM warehouses WHERE id = ?", warehouseId);
    if (!warehouse) fail("입고 창고를 선택해 주세요.");

    const orderLines = linesOf(id);
    const wanted = Array.isArray(body.lines) && body.lines.length
      ? body.lines
      : (orderLines.length === 1 ? [{ lineId: orderLines[0].id, quantity: body.quantity, bin: body.bin }] : []);
    if (!wanted.length) fail("입고할 품목과 수량을 지정해 주세요.");

    const receivedAt = str(body.receivedAt) || today();
    const batchId = nextBatchNo();
    const results = [];
    let batchAmount = 0;

    for (const input of wanted) {
      const line = orderLines.find((row) => row.id === str(input.lineId));
      if (!line) fail(`발주서에 없는 줄입니다: ${input.lineId}`);
      const quantity = int(input.quantity);
      if (quantity === 0) continue;                       // 안 온 품목은 0 으로 두고 넘깁니다
      const remaining = line.quantity - line.received;
      if (quantity < 0 || quantity > remaining) {
        fail(`${line.product_name || line.product_id}: 입고 가능 수량은 1 ~ ${remaining} 입니다.`);
      }

      run("UPDATE purchase_order_lines SET received = received + ? WHERE id = ?", quantity, line.id);

      moveStock({
        type: "PURCHASE_RECEIPT", productId: line.product_id, warehouseId,
        qty: quantity, refType: "PO", refId: id, projectId: line.project_id,
        user: user.name, note: str(body.note) || `${warehouse.name} 입고`,
      });
      run(`UPDATE inventory_balances SET expected = MAX(0, expected - ?)
           WHERE product_id = ? AND warehouse_id = ?`, quantity, line.product_id, warehouseId);
      if (str(input.bin)) {
        run("UPDATE inventory_balances SET bin = ? WHERE product_id = ? AND warehouse_id = ?",
          str(input.bin), line.product_id, warehouseId);
      }

      // 불량·오배송은 받은 수량 중 못 쓰는 몫입니다. 재고에는 이미 안 넣었고
      // 여기서는 "왜 모자란지" 를 남깁니다. 발주 잔량은 그만큼 다시 살아납니다.
      const defectQty = Math.max(0, int(input.defectQty));
      if (defectQty > quantity) fail(`${line.product_name || line.product_id}: 불량 수량이 입고 수량보다 많습니다.`);

      const receiptId = `${batchId}-${String(line.line_no).padStart(2, "0")}`;
      run(`INSERT INTO goods_receipts
             (id, order_id, line_id, batch_id, warehouse_id, product_id, quantity,
              received_at, receiver, defect_qty, defect_kind, note)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        receiptId, id, line.id, batchId, warehouseId, line.product_id, quantity,
        receivedAt, user.name, defectQty, defectQty ? (str(input.defectKind) || "불량") : null, str(body.note));

      batchAmount += line.unit_price * quantity;
      hooks.onLineReceived?.({ order, line, quantity, receivedAt, user });
      results.push({ lineId: line.id, productId: line.product_id, quantity, receiptId });
    }

    if (!results.length) fail("입고 수량이 모두 0 입니다.");

    // 매입 전표는 입고 묶음마다 한 장입니다. 품목마다 끊으면 전표가 부풀어 오릅니다.
    const entryId = hooks.onBatch?.({ order, batchId, amount: batchAmount, receivedAt, results, user }) || null;

    const updated = recalcOrder(id);
    auditLog(user.name, "입고", "입고 처리",
      `${id} / ${results.length}품목 / ${results.reduce((sum, row) => sum + row.quantity, 0)} / ${warehouse.name}`);
    return { order: updated, batchId, entryId, lines: results };
  });
}

/**
 * 입고 묶음 번호.
 * 줄 입고 행의 id 는 GR-202609-0001-02 처럼 묶음번호에 줄번호를 붙인 것이라,
 * 다음 번호는 id 가 아니라 batch_id 열에서 세야 합니다.
 */
function nextBatchNo() {
  const head = `GR-${yearMonth()}-`;
  const row = get("SELECT batch_id FROM goods_receipts WHERE batch_id LIKE ? ORDER BY batch_id DESC LIMIT 1",
    `${head}%`);
  const serial = row?.batch_id ? Number(row.batch_id.slice(head.length)) + 1 : 1;
  return `${head}${String(Number.isFinite(serial) ? serial : 1).padStart(4, "0")}`;
}

/* ---------- 인쇄용 발주서 ------------------------------------------------ */

/** 공급처에 보내는 A4 발주서 한 장에 필요한 것 전부. */
export function orderSheet(id, organization) {
  const order = orderWithLines(id);
  const supply = order.lines.reduce((sum, line) => sum + line.amount, 0);
  const vat = Math.round(supply * 0.1);
  return {
    order,
    organization,
    supply,
    vat,
    total: supply + vat,
    amountInWords: koreanAmount(supply + vat),
    printedAt: today(),
  };
}

const DIGITS = ["", "일", "이", "삼", "사", "오", "육", "칠", "팔", "구"];
const SMALL_UNITS = ["", "십", "백", "천"];
const BIG_UNITS = ["", "만", "억", "조"];

/** 금액을 한글로 적습니다 — 발주서·세금계산서의 관행입니다. (일금 ○○○원정) */
export function koreanAmount(value) {
  const number = Math.floor(Math.abs(Number(value) || 0));
  if (!number) return "영원정";
  const groups = [];
  let rest = number;
  while (rest > 0) { groups.push(rest % 10000); rest = Math.floor(rest / 10000); }

  const text = groups.map((group, index) => {
    if (!group) return "";
    let part = "";
    String(group).split("").reverse().forEach((digit, position) => {
      const n = Number(digit);
      if (!n) return;
      // 십·백·천 자리의 '일'은 적지 않습니다. (일십 → 십)
      part = `${n === 1 && position > 0 ? "" : DIGITS[n]}${SMALL_UNITS[position]}${part}`;
    });
    return `${part}${BIG_UNITS[index]}`;
  }).reverse().join("");

  return `${text}원정`;
}
