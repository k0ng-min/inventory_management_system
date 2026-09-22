/* ==========================================================================
   price-fill.mjs — 카탈로그 제품에 가격 붙이기 (일괄)

   자재 목록은 표준 규격으로 채웠지만, 규격만 있고 가격이 없으면 비교할 것이
   없습니다. 제품 이름으로 판매 사이트를 한 번씩 검색해 판매처별 가격을 답니다.

   판매 사이트를 직접 긁지 않는 이유 —

     쿠팡        robots.txt 조회 자체가 차단됩니다(Access Denied).
     네이버쇼핑   robots.txt 가 'Disallow: /' 로 전면 금지이고, 공식 검색 API 도
                 2026-07-31 자로 종료됐습니다. 대체 API 는 나오지 않았습니다.
     제조사       LS ELECTRIC 은 /ko/api/download.ashx 가 열려 있지만 내용은
                 카탈로그 PDF 목록(4,594건)이지 제품 규격 DB 가 아닙니다.

   그래서 **허가가 분명한 공식 API 만** 씁니다. 지금 쓸 수 있는 것은 조달청
   나라장터 종합쇼핑몰 품목정보(계약단가)입니다. 민간 구매가와 성격이 다르므로
   가격구분을 'contract' 로 남겨 견적 화면에서 구분해 보여 줍니다.

   소스는 갈아끼울 수 있게 두었습니다. 계약 공급처 REST 나 단가표 CSV 가
   붙으면 그쪽이 먼저 쓰입니다.
   ========================================================================== */

import { all, get, nowIso, auditLog } from "./db.mjs";
import { syncShoppingMall, shopStatus } from "./g2b-shop.mjs";
import { syncSupplierRest, supplierRestStatus } from "./supplier-rest.mjs";

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * 가격이 아직 없는 제품을 먼저 고릅니다.
 * 이미 판매조건이 있는 제품을 또 부르면 한도만 씁니다.
 */
export function pendingProducts({ limit = 40, category = "" } = {}) {
  const clauses = ["c.active = 1", "(SELECT COUNT(*) FROM supplier_products WHERE product_id = c.id AND active = 1) = 0"];
  const params = [];
  if (category) { clauses.push("c.category = ?"); params.push(category); }

  return all(`
    SELECT c.id, c.name, c.category, c.spec_label, c.base_unit
    FROM catalog_products c
    WHERE ${clauses.join(" AND ")}
    ORDER BY c.category, c.name
    LIMIT ?`, ...params, Math.max(1, Math.min(200, limit)));
}

/** 가격 채우기 현황 — 화면이 "몇 건 중 몇 건에 가격이 있나" 를 보여 줍니다. */
export function priceCoverage() {
  const rows = all(`
    SELECT c.category,
           COUNT(*) AS total,
           SUM(CASE WHEN (SELECT COUNT(*) FROM supplier_products WHERE product_id = c.id AND active = 1) > 0
                    THEN 1 ELSE 0 END) AS priced
    FROM catalog_products c WHERE c.active = 1
    GROUP BY c.category ORDER BY total DESC`);
  const total = rows.reduce((sum, row) => sum + row.total, 0);
  const priced = rows.reduce((sum, row) => sum + row.priced, 0);
  return {
    rows: rows.map((row) => ({ ...row, missing: row.total - row.priced })),
    total, priced, missing: total - priced,
    sources: priceSources(),
  };
}

/**
 * 제품 이름으로 검색어를 만듭니다.
 * 카탈로그 이름("CV 2.5SQ 4C 0.6/1KV")을 그대로 넣으면 결과가 거의 없습니다.
 * 쇼핑몰에서 실제로 쓰는 표기에 가깝게 다듬습니다.
 */
export function searchTermFor(product) {
  const label = String(product.spec_label || product.name || "").trim();
  return label
    .replace(/0\.6\/1KV|450\/750V|300\/300V|300\/500V/gi, "")   // 전압 표기는 검색을 좁히기만 합니다
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 쓸 수 있는 가격 소스를 순서대로 알려 줍니다.
 * 앞에 있는 것부터 씁니다 — 계약 공급처가 있으면 그게 가장 정확합니다.
 */
export function priceSources() {
  return [
    { key: "supplier-rest", label: "계약 공급처 REST", basis: "contract", ...supplierRestStatus() },
    { key: "g2b-shop", label: "나라장터 종합쇼핑몰", basis: "contract", ...shopStatus() },
  ].map((source) => ({
    key: source.key, label: source.label, basis: source.basis,
    live: Boolean(source.live), reason: source.reason || null,
  }));
}

/**
 * 일괄 가격 채우기.
 * 제품을 하나씩 검색해 판매처별 가격을 supplier_products 로 넣습니다.
 * 실제 적재는 각 어댑터가 합니다 — 규격을 다시 읽어 같은 제품에 붙입니다.
 */
export async function fillPrices({ limit = 20, category = "", delayMs = 350, user } = {}) {
  const sources = priceSources();
  const source = sources.find((item) => item.live);
  if (!source) {
    return {
      ok: false, live: false, sources,
      reason: "지금 켤 수 있는 가격 소스가 없습니다.",
      hint: "공공데이터포털에서 '조달청 나라장터 종합쇼핑몰 품목정보서비스' 를 활용신청한 뒤 "
        + "설정 > 가격 소스 연동에서 켜 주세요. 그 전까지는 공급처 단가표(CSV)로 채웁니다.",
    };
  }

  const runOne = source.key === "supplier-rest"
    ? (term) => syncSupplierRest({ query: term, limit: 30, user })
    : (term) => syncShoppingMall({ keyword: term, maxRows: 30, user });

  const targets = pendingProducts({ limit, category });
  const results = [];
  let added = 0;
  let failed = 0;

  for (const product of targets) {
    const term = searchTermFor(product);
    if (!term) { results.push({ id: product.id, name: product.name, skipped: "검색어 없음" }); continue; }
    try {
      const outcome = await runOne(term);
      const count = outcome?.summary?.added ?? outcome?.summary?.updated ?? 0;
      added += count;
      if (outcome?.ok === false) failed += 1;
      results.push({ id: product.id, name: product.name, term, found: count, ok: outcome?.ok !== false });
    } catch (error) {
      failed += 1;
      results.push({ id: product.id, name: product.name, term, error: String(error.message || error).slice(0, 80) });
    }
    await sleep(delayMs);          // 상대 서버를 몰아치지 않습니다
  }

  auditLog(user, "기준정보", "가격 일괄 채우기",
    `${source.label} / ${targets.length}개 검색 · 판매조건 ${added}건 · 실패 ${failed}`);
  return { ok: true, live: true, source: source.label, tried: targets.length, added, failed, at: nowIso(), results };
}
