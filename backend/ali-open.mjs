/* ==========================================================================
   ali-open.mjs — AliExpress Open Platform (제휴 상품 조회)

   알리익스프레스는 robots.txt 에서 `/wholesale*`, `/item/*`, `/product/*` 를
   명시적으로 막습니다. 화면을 긁지 않고 공식 오픈 플랫폼 API 만 씁니다.

     https://openservice.aliexpress.com  →  앱 등록 후 APP_KEY / APP_SECRET

   서명 규칙(TOP 시스템 게이트웨이):
     1. sign 을 뺀 모든 파라미터를 키 이름순으로 정렬
     2. k1v1k2v2... 로 이어 붙임
     3. HMAC-SHA256(app_secret, 이어붙인 문자열) 을 대문자 hex 로

   주의 — 키가 없어 실제 응답으로 검증하지 못했습니다. 진단(probe)으로
   응답 필드명을 확인한 뒤 FIELDS 만 고치면 됩니다.
   ========================================================================== */

import "./env.mjs";
import { createHmac } from "node:crypto";
import { get, run, nowIso, auditLog } from "./db.mjs";
import { ingestSupplierCatalog } from "./ingest.mjs";

const GATEWAY = "https://api-sg.aliexpress.com/sync";
const METHOD = "aliexpress.affiliate.product.query";

const credentials = () => ({
  key: (process.env.ALI_APP_KEY || "").trim(),
  secret: (process.env.ALI_APP_SECRET || "").trim(),
  tracking: (process.env.ALI_TRACKING_ID || "").trim(),
});

export function aliStatus() {
  const connector = get("SELECT * FROM connectors WHERE id = 'ali-open'");
  const { key, secret } = credentials();
  const keyConfigured = Boolean(key && secret);
  return {
    enabled: Boolean(connector?.enabled),
    keyConfigured,
    live: Boolean(connector?.enabled && keyConfigured),
    lastSyncAt: connector?.last_sync_at || null,
    reason: !connector?.enabled
      ? "설정 > 연동설정에서 '알리익스프레스 오픈API'를 켜 주세요."
      : !keyConfigured
        ? "ALI_APP_KEY / ALI_APP_SECRET 환경변수가 설정되지 않았습니다."
        : null,
  };
}

/** 키 이름순으로 이어 붙인 뒤 HMAC-SHA256 대문자 hex. */
export function sign(params, secret) {
  const base = Object.keys(params).sort().map((key) => `${key}${params[key]}`).join("");
  return createHmac("sha256", secret).update(base, "utf8").digest("hex").toUpperCase();
}

const FIELDS = {
  name: ["product_title", "productTitle", "title"],
  price: ["target_sale_price", "sale_price", "target_app_sale_price", "app_sale_price"],
  currency: ["target_sale_price_currency", "sale_price_currency"],
  url: ["product_detail_url", "promotion_link", "productDetailUrl"],
  sku: ["product_id", "productId"],
  image: ["product_main_image_url", "productMainImageUrl"],
  shop: ["shop_name", "shopName", "store_name"],
};

const pick = (item, field) => {
  for (const candidate of FIELDS[field] || []) {
    const value = item?.[candidate];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return null;
};

/** 응답 구조가 버전마다 달라서 상품 배열이 있을 만한 자리를 차례로 봅니다. */
function extractItems(payload) {
  const response = payload?.aliexpress_affiliate_product_query_response || payload?.resp_result || payload;
  const result = response?.resp_result?.result || response?.result || response;
  const products = result?.products;
  if (!products) return [];
  if (Array.isArray(products)) return products;
  if (Array.isArray(products.product)) return products.product;
  if (products.product) return [products.product];
  return [];
}

async function query({ keywords, pageNo, pageSize }) {
  const { key, secret, tracking } = credentials();
  const params = {
    app_key: key,
    method: METHOD,
    format: "json",
    v: "2.0",
    sign_method: "sha256",
    timestamp: String(Date.now()),
    keywords,
    page_no: String(pageNo),
    page_size: String(pageSize),
    target_currency: "KRW",
    target_language: "KO",
    ship_to_country: "KR",
  };
  if (tracking) params.tracking_id = tracking;
  params.sign = sign(params, secret);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(GATEWAY, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(params).toString(),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`알리 오류 ${response.status}: ${text.slice(0, 200)}`);
    const payload = JSON.parse(text);
    if (payload.error_response) {
      const problem = payload.error_response;
      throw new Error(`알리 오류 ${problem.code || ""}: ${problem.msg || problem.sub_msg || ""}`);
    }
    return { items: extractItems(payload), raw: payload };
  } finally {
    clearTimeout(timer);
  }
}

/** 진단 — 응답 필드명과 현재 매핑 결과를 그대로 돌려줍니다. */
export async function probeAli({ keyword = "cable" } = {}) {
  const status = aliStatus();
  if (!status.live) return { ok: false, reason: status.reason };
  const { items } = await query({ keywords: keyword, pageNo: 1, pageSize: 5 });
  const sample = items[0] || null;
  return {
    ok: true,
    returned: items.length,
    fields: sample ? Object.keys(sample) : [],
    sample,
    mapped: sample
      ? Object.fromEntries(Object.keys(FIELDS).map((field) => [field, pick(sample, field)]))
      : null,
  };
}

export async function syncAli({ query: keyword, maxRows = 100, dryRun = false, user }) {
  const status = aliStatus();
  if (!status.live) return { ok: false, live: false, reason: status.reason };
  const needle = String(keyword || "").trim();
  if (!needle) return { ok: false, live: true, reason: "검색어를 입력해 주세요." };

  const collected = [];
  const pageSize = 50;
  for (let pageNo = 1; collected.length < maxRows && pageNo <= 20; pageNo += 1) {
    const { items } = await query({ keywords: needle, pageNo, pageSize });
    if (!items.length) break;
    collected.push(...items);
  }

  const rows = [];
  let unmapped = 0;
  let nonKrw = 0;
  for (const item of collected.slice(0, maxRows)) {
    const name = String(pick(item, "name") || "").trim();
    const price = Number(String(pick(item, "price") ?? "").replace(/[^\d.]/g, ""));
    if (!name || !Number.isFinite(price) || price <= 0) { unmapped += 1; continue; }
    // target_currency 를 KRW 로 요청했지만, 응답이 다른 통화면 원가 비교가 어긋납니다.
    const currency = String(pick(item, "currency") || "KRW").toUpperCase();
    if (currency !== "KRW") { nonKrw += 1; continue; }
    rows.push({
      name,
      sku: pick(item, "sku"),
      manufacturer: pick(item, "shop"),
      price,
      priceBasis: "retail",
      url: pick(item, "url"),
    });
  }
  if (!rows.length) {
    return { ok: false, live: true, reason: "원화 가격이 있는 상품을 찾지 못했습니다.", unmapped, nonKrw };
  }

  const supplier = supplierForAli();
  const outcome = ingestSupplierCatalog({
    supplierId: supplier.id, rows, filename: `알리익스프레스 · ${needle}`,
    user, source: "aliexpress", dryRun,
  });

  if (!dryRun) {
    run("UPDATE connectors SET last_sync_at = ?, status = '정상 동기화' WHERE id = 'ali-open'", nowIso());
    auditLog(user, "기준정보", "알리익스프레스 적재", `${needle} / ${rows.length}건`);
  }
  return { ok: true, live: true, dryRun, query: needle, fetched: rows.length, unmapped, nonKrw, summary: outcome.summary, preview: outcome.preview };
}

function supplierForAli() {
  const existing = get("SELECT * FROM suppliers WHERE name = '알리익스프레스'");
  if (existing) return existing;
  run("INSERT INTO suppliers (id, name, terms, status, note) VALUES ('SUP-ALI','알리익스프레스','해외 직구 시세','정상',?)",
    "AliExpress Open Platform — 자동 등록 (관세·배송기간 별도 확인)");
  return get("SELECT * FROM suppliers WHERE id = 'SUP-ALI'");
}
