/**
 * 백엔드 전 흐름 스모크 테스트.
 * 임시 DB로 서버를 띄우고 구매→발주→입고→재고→배정→출고→매출→수금→입찰까지 실제 호출합니다.
 *
 *   npm run smoke
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = fileURLToPath(new URL(".", import.meta.url));
const workDir = mkdtempSync(join(tmpdir(), "inventory-erp-smoke-"));
const dbPath = join(workDir, "smoke.db");
const port = 4899;
const base = `http://127.0.0.1:${port}`;

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) { passed += 1; console.log(`  ok   ${label}`); }
  else { failed += 1; failures.push(label); console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

/* ---- 테스트용 계정을 미리 만들어 둡니다 ---------------------------------- */

process.env.ERP_DB_PATH = dbPath;
const db = await import("./db.mjs");
const { normalizeSupplierFeed } = await import("./supplier-rest.mjs");

const admin = { email: "admin@smoke.test", password: "smoke-pass-1234" };
const warehouse = { email: "wh@smoke.test", password: "smoke-pass-1234" };
const viewer = { email: "viewer@smoke.test", password: "smoke-pass-1234" };
const purchasing = { email: "pur@smoke.test", password: "smoke-pass-1234" };

for (const [account, name, role] of [[admin, "관리자", "admin"], [warehouse, "창고", "warehouse"],
  [viewer, "조회", "viewer"], [purchasing, "구매", "purchasing"]]) {
  const record = db.passwordRecord(account.password);
  db.run(`INSERT INTO users (id, name, email, role, active, password_salt, password_hash, created_at)
          VALUES (?,?,?,?,1,?,?,?)`,
    db.newId("USR"), name, account.email, role, record.salt, record.hash, db.nowIso());
}
db.db.close();

/* ---- 서버 기동 ------------------------------------------------------------ */

const server = spawn(process.execPath, ["--no-warnings", join(backendDir, "server.mjs")], {
  env: { ...process.env, ERP_DB_PATH: dbPath, PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch { /* 아직 기동 중 */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("서버가 기동되지 않았습니다.");
}

/* ---- HTTP 헬퍼 ------------------------------------------------------------ */

function client() {
  let cookie = "";
  return async function call(method, path, body) {
    const response = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = response.headers.getSetCookie?.() || [];
    for (const entry of raw) if (entry.startsWith("electro_session=")) cookie = entry.split(";")[0];
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    return { status: response.status, body: payload };
  };
}

async function main() {
  await waitForServer();
  const as = client();
  const asWarehouse = client();
  const asViewer = client();
  const asPurchasing = client();

  console.log("\n인증");
  check("헬스체크", (await as("GET", "/api/health")).body.ok === true);
  const login = await as("POST", "/api/auth/login", admin);
  check("관리자 로그인", login.status === 200 && login.body.user.role === "admin", JSON.stringify(login.body));
  check("잘못된 비밀번호 거부", (await client()("POST", "/api/auth/login", { ...admin, password: "wrong" })).status === 401);
  check("비로그인 API 차단", (await client()("GET", "/api/summary")).status === 401);
  await asWarehouse("POST", "/api/auth/login", warehouse);
  await asViewer("POST", "/api/auth/login", viewer);
  await asPurchasing("POST", "/api/auth/login", purchasing);

  console.log("\n기준정보 CRUD");
  const product = await as("POST", "/api/products", {
    id: "MAT-SMOKE-01", name: "스모크 테스트 케이블", unit: "100m", price: 100000, unitPrice: 1000, safetyStock: 5,
  });
  check("품목 등록", product.status === 201 && product.body.id === "MAT-SMOKE-01", JSON.stringify(product.body));
  check("품목 수정", (await as("PUT", "/api/products/MAT-SMOKE-01", { price: 120000 })).body.price === 120000);
  check("중복 코드 거부", (await as("POST", "/api/products", { id: "MAT-SMOKE-01", name: "중복" })).status === 400);
  check("필수값 누락 거부", (await as("POST", "/api/products", { name: "" })).status === 400);

  const supplier = await as("POST", "/api/suppliers", { name: "스모크 공급처", terms: "월말" });
  check("공급처 등록", supplier.status === 201);
  const wh = await as("POST", "/api/warehouses", { id: "WH-SMOKE", name: "스모크 창고" });
  check("창고 등록", wh.status === 201);
  const project = await as("POST", "/api/projects", { name: "스모크 공사", manager: "테스터", budget: 50_000_000 });
  check("공사 등록", project.status === 201);
  check("조회전용 사용자 쓰기 차단", (await asViewer("POST", "/api/products", { name: "불가" })).status === 403);

  console.log("\n구매 → 발주 → 입고");
  const request = await as("POST", "/api/purchase-requests", {
    productId: "MAT-SMOKE-01", projectId: project.body.id, quantity: 10, purpose: "스모크 테스트",
  });
  check("구매요청 생성", request.status === 201 && request.body.status === "구매요청", JSON.stringify(request.body));
  check("수량 0 거부", (await as("POST", "/api/purchase-requests", {
    productId: "MAT-SMOKE-01", projectId: project.body.id, quantity: 0, purpose: "x",
  })).status === 400);

  const approve = await as("POST", `/api/purchase-requests/${request.body.id}/approve`, {
    supplierId: supplier.body.id, unitPrice: 120000, warehouseId: "WH-SMOKE",
  });
  check("요청 승인 → 발주 생성", approve.status === 200 && approve.body.order.status === "발주완료", JSON.stringify(approve.body));
  const orderId = approve.body.order.id;
  check("발주금액 계산", approve.body.order.amount === 1_200_000, String(approve.body.order.amount));
  check("재승인 차단", (await as("POST", `/api/purchase-requests/${request.body.id}/approve`, {})).status === 400);

  check("창고권한 없는 사용자 입고 차단",
    (await asViewer("POST", `/api/purchase-orders/${orderId}/receive`, { quantity: 1, warehouseId: "WH-SMOKE" })).status === 403);
  check("초과 입고 거부",
    (await asWarehouse("POST", `/api/purchase-orders/${orderId}/receive`, { quantity: 99, warehouseId: "WH-SMOKE" })).status === 400);

  const receive1 = await asWarehouse("POST", `/api/purchase-orders/${orderId}/receive`, { quantity: 4, warehouseId: "WH-SMOKE" });
  check("부분 입고", receive1.status === 200 && receive1.body.order.status === "부분입고", JSON.stringify(receive1.body.order));
  check("입고 후 재고 반영", receive1.body.inventory.on_hand === 4, String(receive1.body.inventory?.on_hand));
  check("매입 전표 자동 생성", Boolean(receive1.body.entryId));

  const receive2 = await asWarehouse("POST", `/api/purchase-orders/${orderId}/receive`, { quantity: 6, warehouseId: "WH-SMOKE" });
  check("잔량 입고 → 입고완료", receive2.body.order.status === "입고완료");
  check("입고 완료 후 현재고 10", receive2.body.inventory.on_hand === 10, String(receive2.body.inventory?.on_hand));

  const txns = await as("GET", "/api/inventory/transactions?productId=MAT-SMOKE-01");
  check("수불 이력 2건 기록", txns.body.filter((row) => row.type === "PURCHASE_RECEIPT").length === 2, String(txns.body.length));
  check("수불 잔량 추적", txns.body[0].balance_after === 10, String(txns.body[0]?.balance_after));

  console.log("\n재고 이동 · 조정");
  const transfer = await asWarehouse("POST", "/api/stock-transfers", {
    productId: "MAT-SMOKE-01", fromWarehouse: "WH-SMOKE", toWarehouse: "WH-HQ", quantity: 3,
  });
  check("재고 이동", transfer.status === 201, JSON.stringify(transfer.body));
  check("같은 창고 이동 거부", (await asWarehouse("POST", "/api/stock-transfers", {
    productId: "MAT-SMOKE-01", fromWarehouse: "WH-SMOKE", toWarehouse: "WH-SMOKE", quantity: 1,
  })).status === 400);
  check("재고 초과 이동 거부", (await asWarehouse("POST", "/api/stock-transfers", {
    productId: "MAT-SMOKE-01", fromWarehouse: "WH-SMOKE", toWarehouse: "WH-HQ", quantity: 999,
  })).status === 400);

  let inventory = await as("GET", "/api/inventory?warehouse=WH-SMOKE");
  const smokeRow = inventory.body.find((row) => row.product_id === "MAT-SMOKE-01");
  check("이동 후 출발창고 7", smokeRow.on_hand === 7, String(smokeRow?.on_hand));

  const adjust = await asWarehouse("POST", "/api/stock-adjustments", {
    productId: "MAT-SMOKE-01", warehouseId: "WH-SMOKE", afterQty: 6, reason: "실사 차이",
  });
  check("재고 조정", adjust.status === 201 && adjust.body.diff === -1, JSON.stringify(adjust.body));
  check("차이 없는 조정 거부", (await asWarehouse("POST", "/api/stock-adjustments", {
    productId: "MAT-SMOKE-01", warehouseId: "WH-SMOKE", afterQty: 6, reason: "동일",
  })).status === 400);

  console.log("\n공사 배정 · 출고");
  const allocation = await asWarehouse("POST", "/api/allocations", {
    projectId: project.body.id, productId: "MAT-SMOKE-01", warehouseId: "WH-SMOKE", quantity: 4,
  });
  check("공사 자재 배정", allocation.status === 201, JSON.stringify(allocation.body));
  inventory = await as("GET", "/api/inventory?warehouse=WH-SMOKE");
  const afterAllocate = inventory.body.find((row) => row.product_id === "MAT-SMOKE-01");
  check("배정으로 가용재고 감소", afterAllocate.available === 2, `available=${afterAllocate?.available}`);
  check("현재고는 그대로", afterAllocate.on_hand === 6, String(afterAllocate?.on_hand));
  check("가용 초과 배정 거부", (await asWarehouse("POST", "/api/allocations", {
    projectId: project.body.id, productId: "MAT-SMOKE-01", warehouseId: "WH-SMOKE", quantity: 99,
  })).status === 400);

  const issue = await asWarehouse("POST", `/api/allocations/${allocation.body.id}/issue`, { quantity: 4 });
  check("배정분 출고", issue.status === 200 && issue.body.status === "사용완료", JSON.stringify(issue.body));
  inventory = await as("GET", "/api/inventory?warehouse=WH-SMOKE");
  const afterIssue = inventory.body.find((row) => row.product_id === "MAT-SMOKE-01");
  check("출고로 현재고 감소", afterIssue.on_hand === 2, String(afterIssue?.on_hand));
  check("출고로 배정 해제", afterIssue.allocated === 0, String(afterIssue?.allocated));

  console.log("\n영업 · 수금");
  const sale = await as("POST", "/api/sales-orders", {
    customer: "스모크 발주처", projectId: project.body.id, amount: 10_000_000, description: "1차 기성",
  });
  check("매출 등록", sale.status === 201, JSON.stringify(sale.body));
  check("초과 수금 거부", (await as("POST", "/api/payments", { salesOrderId: sale.body.id, amount: 99_000_000 })).status === 400);
  const payment1 = await as("POST", "/api/payments", { salesOrderId: sale.body.id, amount: 4_000_000 });
  check("부분 수금", payment1.body.order.status === "부분수금", JSON.stringify(payment1.body.order));
  const payment2 = await as("POST", "/api/payments", { salesOrderId: sale.body.id, amount: 6_000_000 });
  check("잔액 수금 → 수금완료", payment2.body.order.status === "수금완료");
  check("수금 전표 자동 생성", Boolean(payment2.body.entryId));

  console.log("\n회계");
  const entry = await as("POST", "/api/accounting-entries", {
    date: "2026-09-21", type: "경비", account: "차량유지비", counterparty: "주유소", debit: 100_000,
  });
  check("전표 등록", entry.status === 201, JSON.stringify(entry.body));
  check("전표 수정", (await as("PUT", `/api/accounting-entries/${entry.body.id}`, { status: "승인" })).body.status === "승인");
  check("전표 삭제", (await as("DELETE", `/api/accounting-entries/${entry.body.id}`)).status === 200);
  check("전표 권한 제한", (await asWarehouse("POST", "/api/accounting-entries", { date: "2026-09-21", type: "경비" })).status === 403);

  console.log("\n입찰정보 (나라장터)");
  const bidStatus = await as("GET", "/api/bids/status");
  check("입찰 연동 상태 조회", bidStatus.status === 200 && typeof bidStatus.body.live === "boolean");
  check("인증키 없으면 샘플 모드", bidStatus.body.live === false || Boolean(process.env.G2B_SERVICE_KEY));
  const bids = await as("GET", "/api/bids?from=2020-01-01&to=2030-12-31");
  check("입찰공고 조회", bids.status === 200 && bids.body.notices.length > 0, `${bids.body.notices?.length}건`);
  const calendar = await as("GET", "/api/bids/calendar?from=2020-01-01&to=2030-12-31&dateField=close_date");
  check("입찰 캘린더 집계", calendar.body.days.length > 0 && calendar.body.days[0].count > 0);
  const firstBid = bids.body.notices[0];
  check("관심공고 등록", (await as("PUT", `/api/bids/${encodeURIComponent(firstBid.id)}/star`, { starred: true })).body.starred === 1);
  check("관심공고 필터", (await as("GET", "/api/bids?from=2020-01-01&to=2030-12-31&starred=1")).body.notices.length === 1);
  check("공고 메모 저장", (await as("PUT", `/api/bids/${encodeURIComponent(firstBid.id)}/memo`, { memo: "검토중" })).body.memo === "검토중");
  const syncWithoutKey = await as("POST", "/api/bids/sync", { from: "2026-09-01", to: "2026-09-30" });
  check("키 없이 동기화 시 안내 반환", syncWithoutKey.status === 200 && (syncWithoutKey.body.live === true || syncWithoutKey.body.ok === false));

  console.log("\n집계 · 보고서");
  const summary = await as("GET", "/api/summary");
  check("대시보드 집계", summary.status === 200 && summary.body.activeProjects > 0);
  check("재고자산 계산", summary.body.inventoryValue > 0, String(summary.body.inventoryValue));
  const reports = await as("GET", "/api/reports");
  check("보고서 조회", reports.status === 200 && Array.isArray(reports.body.purchaseBySupplier));
  check("공사수익 집계 포함", reports.body.projectMargin.some((row) => row.id === project.body.id));
  const receipt = await as("GET", `/api/receipts/${project.body.id}`);
  check("작업별 영수증", receipt.status === 200 && receipt.body.summary.itemCount === 1, JSON.stringify(receipt.body.summary));
  check("영수증에 출고내역 포함", receipt.body.issues.length === 1, String(receipt.body.issues?.length));

  console.log("\n자재 카탈로그 · 통합검색");
  const categories = await as("GET", "/api/catalog/categories");
  check("분류 정의 조회", categories.status === 200 && Boolean(categories.body.cable), Object.keys(categories.body).join(","));

  // 같은 물건을 업체마다 다르게 적어 올립니다 — 하나로 묶이는지가 핵심입니다.
  const csvA = [
    "품명,단위,단가,납기,재고",
    "CV 2.5SQ 4C 0.6/1kV,100m,88000,3일,12",
    "HFIX 2.5SQ 녹색,100m,42000,당일,40",
  ].join("\n");
  const csvB = [
    "품목명,판매단위,가격,리드타임",
    "0.6/1KV CV 4C × 2.5㎟,ROLL(100m),86500,2일",
  ].join("\n");

  const preview = await as("POST", "/api/catalog/import/preview", {
    supplierId: supplier.body.id, csv: csvA, filename: "smoke-a.csv",
  });
  check("적재 미리보기", preview.status === 200 && preview.body.summary.total === 2, JSON.stringify(preview.body.summary));
  check("미리보기는 쓰지 않음",
    (await as("GET", "/api/catalog/imports")).body.length === 0, "적재 이력이 생겼습니다");
  check("품명 열 없으면 거부",
    (await as("POST", "/api/catalog/import/preview", { supplierId: supplier.body.id, csv: "가격\n1000" })).status === 400);

  const importA = await as("POST", "/api/catalog/import", {
    supplierId: supplier.body.id, csv: csvA, filename: "smoke-a.csv",
  });
  check("공급처 품목 적재", importA.status === 201 && importA.body.summary.created === 2, JSON.stringify(importA.body.summary));
  check("적재 이력 기록", (await as("GET", "/api/catalog/imports")).body.length === 1);

  const supplierB = await as("POST", "/api/suppliers", { name: "스모크 공급처B", terms: "현금" });
  const importB = await as("POST", "/api/catalog/import", {
    supplierId: supplierB.body.id, csv: csvB, filename: "smoke-b.csv",
  });
  check("표기가 달라도 같은 제품으로 매칭",
    importB.status === 201 && importB.body.summary.matched === 1 && importB.body.summary.created === 0,
    JSON.stringify(importB.body.summary));

  const found = await as("GET", "/api/catalog/search?q=CV%202.5%204C");
  check("통합검색", found.status === 200 && found.body.products.length >= 1, String(found.body.total));
  const cv = found.body.products[0];
  check("규격 인식", found.body.parsed.recognized === true && found.body.parsed.category === "cable",
    JSON.stringify(found.body.parsed));
  check("업체 2곳이 한 제품에", cv.supplier_count === 2, String(cv.supplier_count));
  check("최저단가는 1m 기준 환산", cv.best_unit_price === 865, String(cv.best_unit_price));

  const squashed = await as("GET", "/api/catalog/search?q=CV2.5SQ4C");
  check("붙여쓴 검색어도 같은 결과", squashed.body.products[0]?.id === cv.id,
    `${squashed.body.products[0]?.id} vs ${cv.id}`);
  check("분류명 검색", (await as("GET", `/api/catalog/search?q=${encodeURIComponent("케이블")}`)).body.products.length >= 1);
  check("없는 제품은 빈 결과", (await as("GET", `/api/catalog/search?q=${encodeURIComponent("ZZZ없는자재")}`)).body.products.length === 0);

  const offers = await as("GET", `/api/catalog/products/${cv.id}/offers`);
  check("업체별 비교 — 단가 오름차순", offers.status === 200 && offers.body.length === 2
    && offers.body[0].unit_price <= offers.body[1].unit_price, offers.body.map((row) => row.unit_price).join(" / "));
  check("ROLL(100m) 환산", offers.body[0].unit_qty === 100, String(offers.body[0].unit_qty));

  const detail = await as("GET", `/api/catalog/products/${cv.id}`);
  check("제품 상세", detail.status === 200 && detail.body.offers.length === 2);
  check("가격 이력 적재", (await as("GET", `/api/catalog/products/${cv.id}/trend`)).body.length === 2);

  const selectedOffer = detail.body.offers[0];
  const comparedRequest = await as("POST", "/api/purchase-requests", {
    productId: cv.id, projectId: project.body.id, quantity: 2,
    purpose: "판매처 비교 선택 검증", requestedDate: "2026-10-10",
    supplierProductId: selectedOffer.id,
  });
  check("비교 선택 → 구매요청", comparedRequest.status === 201
    && comparedRequest.body.preferred_supplier_id === selectedOffer.supplier_id
    && comparedRequest.body.price === selectedOffer.price, JSON.stringify(comparedRequest.body));
  const comparedOrder = await as("POST", `/api/purchase-requests/${comparedRequest.body.id}/approve`, {
    warehouseId: wh.body.id, dueDate: "2026-10-10",
  });
  check("선택 공급처·단가 → 발주", comparedOrder.status === 200
    && comparedOrder.body.order.supplier_id === selectedOffer.supplier_id
    && comparedOrder.body.order.unit_price === selectedOffer.price
    && comparedOrder.body.order.supplier_product_id === selectedOffer.id, JSON.stringify(comparedOrder.body.order));
  await asWarehouse("POST", `/api/purchase-orders/${comparedOrder.body.order.id}/receive`, {
    quantity: 2, warehouseId: wh.body.id, receivedAt: "2026-09-22",
  });
  const stockedCv = await as("GET", "/api/catalog/search?q=CV%202.5%204C");
  check("카탈로그에 사내재고 연결", stockedCv.body.products[0]?.on_hand === 2
    && stockedCv.body.products[0]?.available === 2, JSON.stringify(stockedCv.body.products[0]));

  // 값을 올리면 이력이 쌓이고 급등으로 잡혀야 합니다.
  await as("POST", "/api/catalog/import", {
    supplierId: supplier.body.id, csv: "품명,단위,단가\nCV 2.5SQ 4C 0.6/1kV,100m,99000", filename: "smoke-a2.csv",
  });
  const alerts = await as("GET", "/api/catalog/price-alerts?days=30&threshold=5");
  check("가격 급등 감지", alerts.status === 200 && alerts.body.some((row) => row.product_id === cv.id && row.change > 0),
    JSON.stringify(alerts.body));

  check("품목 마스터 목록", (await as("GET", "/api/catalog/products")).body.length >= 2);
  const shop = await as("GET", "/api/catalog/g2b/status");
  check("쇼핑몰 연동 상태 조회", shop.status === 200 && Array.isArray(shop.body.operations));
  check("키 없으면 쇼핑몰 동기화 불가",
    (await as("POST", "/api/catalog/g2b/sync", { keyword: "전선" })).body.ok === false);

  const normalizedFeed = normalizeSupplierFeed({ supplierName: "계약전기", items: [{
    productName: "CV 4SQ 4C", productCode: "CV44", supplyPrice: "₩120,000",
    sellUnit: "ROLL(100m)", stockQty: 7, productUrl: "https://supplier.example/CV44",
  }] });
  check("계약 API 응답 정규화", normalizedFeed.length === 1
    && normalizedFeed[0].supplierName === "계약전기"
    && normalizedFeed[0].row.price === 120000
    && normalizedFeed[0].row.priceBasis === "contract", JSON.stringify(normalizedFeed));
  check("계약 API 불완전 행 제외", normalizeSupplierFeed({ items: [{ name: "가격없음" }] }, "계약전기").length === 0);
  const supplierRest = await as("GET", "/api/catalog/supplier-rest/status");
  check("계약 API 연동 상태 조회", supplierRest.status === 200 && supplierRest.body.live === false);
  check("키 없이 계약 API 동기화 불가",
    (await as("POST", "/api/catalog/supplier-rest/sync", { query: "전선" })).body.ok === false);

  console.log("\n가격비교 소스");
  const sources = await as("GET", "/api/catalog/sources");
  const SOURCE_KEYS = ["mall", "naver", "coupang", "ali", "g2b", "supplierRest"];
  check("소스 상태 한 번에 조회", sources.status === 200
    && SOURCE_KEYS.every((key) => typeof sources.body[key]?.live === "boolean"),
  JSON.stringify(sources.body));
  check("자재몰 수집은 인증키가 필요 없음", sources.body.mall.keyConfigured === true);
  // 키가 없을 때 500 으로 터지면 화면이 이유를 안내하지 못합니다. 200 + ok:false 여야 합니다.
  for (const [label, path] of [["네이버", "naver"], ["쿠팡", "coupang"], ["알리", "ali"]]) {
    const result = await as("POST", `/api/catalog/${path}/sync`, { query: "전선" });
    check(`키 없이 ${label} 동기화 불가`,
      result.status === 200 && result.body.ok === false && Boolean(result.body.reason),
      JSON.stringify(result.body));
  }
  check("창고담당 자재몰 수집 차단",
    (await asWarehouse("POST", "/api/catalog/mall/sync", { categoryNo: "54" })).status === 403);

  // 가격을 공개하지 않는 몰에서 거둔 품명은 판매조건 없이 품목만 만들어야 합니다.
  const nameOnlyCsv = "품명\nHFIX 6SQ 전화문의품\n";
  const beforeRows = (await as("GET", "/api/catalog/products")).body;
  const before = beforeRows.length;
  const beforeIds = new Set(beforeRows.map((row) => row.id));
  check("단가 열이 없으면 기본 적재에서 전량 제외",
    (await as("POST", "/api/catalog/import/preview", {
      supplierId: supplier.body.id, csv: nameOnlyCsv,
    })).body.summary.skipped === 1);

  const catalogOnly = await as("POST", "/api/catalog/import", {
    supplierId: supplier.body.id, csv: nameOnlyCsv, filename: "품목만", catalogOnly: true,
  });
  check("품목만 적재는 가격 없는 행을 받는다",
    catalogOnly.status === 201 && catalogOnly.body.summary.catalog === 1
    && catalogOnly.body.summary.skipped === 0, JSON.stringify(catalogOnly.body.summary));
  check("품목만 적재는 판매조건을 만들지 않는다",
    catalogOnly.body.summary.added === 0
    && (await as("GET", "/api/catalog/products")).body.length === before + 1,
    JSON.stringify(catalogOnly.body.summary));
  // 품명은 규격 파서가 정규화하므로, 이름이 아니라 '새로 생긴 제품'으로 찾습니다.
  const added = (await as("GET", "/api/catalog/products")).body.filter((row) => !beforeIds.has(row.id));
  check("품목만 적재한 제품엔 판매처가 없다",
    added.length === 1 && added[0].supplier_count === 0, JSON.stringify(added));

  console.log("\n카탈로그 권한");
  check("창고담당 적재 차단",
    (await asWarehouse("POST", "/api/catalog/import", { supplierId: supplier.body.id, csv: csvA })).status === 403);
  const viewerSearch = await asViewer("GET", "/api/catalog/search?q=CV%202.5%204C");
  check("조회전용도 검색은 가능", viewerSearch.status === 200 && viewerSearch.body.products.length >= 1);
  check("조회전용에겐 단가 없음", viewerSearch.body.products.every((row) => row.best_unit_price === undefined),
    JSON.stringify(viewerSearch.body.products[0]));
  check("조회전용 상세에 단가 숨김",
    (await asViewer("GET", `/api/catalog/products/${cv.id}`)).body.pricesHidden === true);
  check("조회전용 업체비교 차단", (await asViewer("GET", `/api/catalog/products/${cv.id}/offers`)).status === 403);
  check("창고담당 가격추이 차단", (await asWarehouse("GET", `/api/catalog/products/${cv.id}/trend`)).status === 403);

  console.log("\n관리자");
  const users = (await as("GET", "/api/admin/users")).body;
  check("사용자 목록", [admin, warehouse, viewer].every((account) =>
    users.some((row) => row.email === account.email)), `${users.length}명`);
  check("사용자 생성", (await as("POST", "/api/admin/users", {
    name: "신규", email: "new@smoke.test", role: "purchasing", password: "another-pass-99",
  })).status === 201);
  check("짧은 비밀번호 거부", (await as("POST", "/api/admin/users", {
    name: "x", email: "x@smoke.test", role: "viewer", password: "short",
  })).status === 400);
  check("비관리자 관리자API 차단", (await asWarehouse("GET", "/api/admin/users")).status === 403);
  check("회사정보 수정", (await as("PUT", "/api/admin/organization", { name: "스모크주식회사" })).body.name === "스모크주식회사");
  const connectors = await as("GET", "/api/admin/connectors");
  check("연동 목록에 나라장터 포함", connectors.body.some((row) => row.id === "g2b-bids"));
  check("연동 켜기", (await as("PUT", "/api/admin/connectors/g2b-bids", { enabled: true })).body.enabled === true);

  const logs = await as("GET", "/api/audit-logs");
  check("감사로그 누적", logs.body.length > 10, `${logs.body.length}건`);
  check("삭제 제약 동작", (await as("DELETE", "/api/products/MAT-SMOKE-01")).status === 400);

  console.log("\n관리자 전용 모듈 (입찰·회계·분석)");
  // 화면에서 가리는 것과 별개로, 주소창으로 직접 열어도 막혀야 합니다.
  for (const [label, path] of [
    ["입찰 목록", "/api/bids"],
    ["입찰 캘린더", "/api/bids/calendar?from=2026-01-01&to=2026-12-31"],
    ["입찰 상태", "/api/bids/status"],
    ["경영분석", "/api/reports"],
  ]) {
    check(`구매담당 ${label} 차단`, (await asPurchasing("GET", path)).status === 403);
    check(`창고담당 ${label} 차단`, (await asWarehouse("GET", path)).status === 403);
    check(`조회전용 ${label} 차단`, (await asViewer("GET", path)).status === 403);
    check(`관리자 ${label} 허용`, (await as("GET", path)).status === 200);
  }
  check("구매담당 입찰 동기화 차단", (await asPurchasing("POST", "/api/bids/sync", {})).status === 403);
  check("회계 전표는 이미 관리자 전용", (await asPurchasing("GET", "/api/accounting-entries")).status === 403);

  console.log("\n팀 공유 일정");
  const mk = (over = {}) => ({
    kind: "work", title: "3층 배관 작업", startDate: "2026-10-05", endDate: "2026-10-08",
    assignees: "김현우, 박지민", location: "본사 3층", ...over,
  });

  const made = await as("POST", "/api/schedules", mk());
  check("일정 등록", made.status === 201 && made.body.start_date === "2026-10-05", JSON.stringify(made.body));
  check("담당자를 목록으로 돌려줌", made.body.assignee_list.length === 2, JSON.stringify(made.body.assignee_list));
  check("제목 없으면 거부", (await as("POST", "/api/schedules", mk({ title: "" }))).status === 400);
  check("날짜 형식이 틀리면 거부", (await as("POST", "/api/schedules", mk({ startDate: "2026/10/05" }))).status === 400);
  check("없는 공사에 연결 거부", (await as("POST", "/api/schedules", mk({ projectId: "PRJ-NONE" }))).status === 400);

  // 끝날짜가 시작보다 앞서면 뒤집어서 저장합니다 — 달력이 음수 폭으로 깨지지 않게.
  const flipped = await as("POST", "/api/schedules", mk({ title: "뒤집힌 일정", startDate: "2026-10-20", endDate: "2026-10-18" }));
  check("시작·종료가 뒤바뀌면 바로잡음",
    flipped.body.start_date === "2026-10-18" && flipped.body.end_date === "2026-10-20",
    JSON.stringify(flipped.body));

  const leave = await as("POST", "/api/schedules", {
    kind: "leave", title: "연차", startDate: "2026-10-07", endDate: "2026-10-07", assignees: "정미라",
  });
  check("휴가는 승인 없이 바로 등록", leave.status === 201 && leave.body.kind === "leave");

  // 겹침 조회 — 기간에 걸치기만 하면 잡혀야 합니다(포함이 아니라 겹침).
  const overlap = await as("GET", "/api/schedules?from=2026-10-07&to=2026-10-07");
  check("기간에 걸친 일정을 겹침으로 조회",
    overlap.body.some((row) => row.id === made.body.id) && overlap.body.some((row) => row.id === leave.body.id),
    JSON.stringify(overlap.body.map((row) => row.title)));
  check("기간 밖 일정은 제외",
    !(await as("GET", "/api/schedules?from=2026-11-01&to=2026-11-30")).body.some((row) => row.id === made.body.id));
  check("구분으로 좁히기",
    (await as("GET", "/api/schedules?from=2026-10-01&to=2026-10-31&kind=leave")).body.every((row) => row.kind === "leave"));

  // 서로 고칠 수 있어야 합니다 — 창고담당이 관리자가 만든 일정을 옮깁니다.
  const moved = await asWarehouse("PUT", `/api/schedules/${made.body.id}`, { startDate: "2026-10-06", endDate: "2026-10-09" });
  check("남이 만든 일정도 옮길 수 있음", moved.status === 200 && moved.body.start_date === "2026-10-06",
    JSON.stringify(moved.body));
  check("바꾼 사람이 기록됨", moved.body.updated_by === "창고", moved.body.updated_by);
  check("일정 이동이 변경이력에 남음",
    (await as("GET", "/api/audit-logs")).body.some((row) => row.module === "일정" && /2026-10-05 → 2026-10-06/.test(row.detail || "")));
  check("조회전용은 일정을 못 바꿈", (await asViewer("POST", "/api/schedules", mk())).status === 403);
  check("조회전용도 일정 조회는 가능", (await asViewer("GET", "/api/schedules")).status === 200);
  check("없는 일정 수정은 404", (await as("PUT", "/api/schedules/SCH-NONE", { title: "x" })).status === 404);

  // 달력 한 장에 필요한 것을 한 번에
  const cal = await as("GET", "/api/calendar?from=2026-10-01&to=2026-10-31");
  check("달력 피드 조회", cal.status === 200 && Array.isArray(cal.body.schedules) && Array.isArray(cal.body.projects),
    JSON.stringify(Object.keys(cal.body)));
  check("달력 기간 없으면 거부", (await as("GET", "/api/calendar")).status === 400);
  check("비관리자 달력엔 입찰이 비어 있음",
    (await asWarehouse("GET", "/api/calendar?from=2026-10-01&to=2026-10-31")).body.bids.length === 0);

  check("일정 삭제", (await asWarehouse("DELETE", `/api/schedules/${leave.body.id}`)).status === 200);
  check("삭제 후 조회되지 않음",
    !(await as("GET", "/api/schedules?from=2026-10-01&to=2026-10-31")).body.some((row) => row.id === leave.body.id));

  console.log("\n보안");
  check("정적 경로 탈출 차단",
    !(await (await fetch(`${base}/../backend/erp.db`)).text()).includes("SQLite"), "경로 탈출");
  check("로그아웃", (await as("POST", "/api/auth/logout", {})).status === 200);
  check("로그아웃 후 차단", (await as("GET", "/api/summary")).status === 401);
}

try {
  await main();
} catch (error) {
  failed += 1;
  failures.push(`예외: ${error.message}`);
  console.error("\n치명적 오류:", error);
} finally {
  server.kill();
  await new Promise((resolve) => setTimeout(resolve, 200));
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* 잠금 시 무시 */ }

  console.log(`\n${"─".repeat(52)}`);
  console.log(`  통과 ${passed} · 실패 ${failed}`);
  if (failures.length) console.log(`  실패 항목:\n${failures.map((item) => `    - ${item}`).join("\n")}`);
  console.log(`${"─".repeat(52)}\n`);
  process.exit(failed ? 1 : 0);
}
