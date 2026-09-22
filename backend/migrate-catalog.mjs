/**
 * 카탈로그 구조 전환 — 이미 운영 중인 DB 를 새 구조로 옮깁니다.
 *
 *   기존: products 1행 = 제품 1개 + 공급처 1곳 + 가격 1개   (비교 불가)
 *   신규: catalog_products(정규화 제품) 1 : N supplier_products(업체별 가격)
 *
 *   node backend/migrate-catalog.mjs          기존 품목을 카탈로그로 이전
 *   node backend/migrate-catalog.mjs --purge  데모/샘플 데이터까지 전부 삭제
 *
 * 테이블 생성과 이전 로직은 db.mjs 가 들고 있습니다(새 설치는 시드가 같은 경로를 씁니다).
 * 이 스크립트는 그것을 기존 DB 에 한 번 적용하고 결과를 보고할 뿐입니다.
 */

import { run, get, tx, catalogFromLegacy } from "./db.mjs";

const purge = process.argv.includes("--purge");

console.log("1) 카탈로그 테이블 확인 완료 (db.mjs 스키마)");

if (purge) {
  tx(() => {
    // 업무 데이터 전부 비웁니다. 사용자·창고·연동 설정은 남깁니다.
    for (const table of [
      "inventory_transactions", "inventory_balances", "goods_receipts", "stock_transfers",
      "stock_adjustments", "project_allocations", "purchase_orders", "purchase_requests",
      "payments", "sales_orders", "accounting_entries", "projects", "customers",
      "price_history", "supplier_products", "catalog_products", "products", "suppliers",
      "catalog_imports", "bid_notices", "audit_logs",
    ]) {
      run(`DELETE FROM ${table}`);
    }
  });
  console.log("2) 데모·샘플 데이터 전량 삭제 (사용자·창고·연동설정은 유지)");
  console.log("   남은 사용자:", get("SELECT COUNT(*) n FROM users").n, "· 창고:", get("SELECT COUNT(*) n FROM warehouses").n);
} else {
  const result = tx(() => catalogFromLegacy());
  console.log(`2) 기존 품목 ${result.moved}건 → 카탈로그로 이전`);
  console.log("   제품 마스터:", get("SELECT COUNT(*) n FROM catalog_products").n);
  console.log("   공급처 가격:", get("SELECT COUNT(*) n FROM supplier_products").n);
}

console.log("\n현재 상태");
for (const table of ["catalog_products", "supplier_products", "price_history", "suppliers", "warehouses", "users"]) {
  console.log(`  ${table.padEnd(20)} ${get(`SELECT COUNT(*) n FROM ${table}`).n}`);
}
console.log("");
