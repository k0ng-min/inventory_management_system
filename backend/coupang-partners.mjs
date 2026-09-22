/* ==========================================================================
   coupang-partners.mjs — 쿠팡 파트너스 오픈API

   쿠팡 화면은 Cloudflare 가 막습니다(403). robots.txt 조차 읽히지 않으므로
   크롤링하지 않고 공식 제휴 API 만 씁니다.

     https://partners.coupang.com  →  제휴 승인 후 ACCESS/SECRET KEY 발급

   서명 규칙(CEA HMAC):
     signed-date = yyMMddTHHmmssZ (GMT)
     message     = signed-date + METHOD + path + query   (query 는 '?' 제외)
     signature   = hex( HMAC-SHA256(secretKey, message) )
     Authorization: CEA algorithm=HmacSHA256, access-key=..., signed-date=..., signature=...

   주의 — 키가 없어 실제 응답으로 검증하지 못했습니다. g2b-shop.mjs 와 같은
   방식으로 진단(probe)을 두었으니, 필드명이 다르면 FIELDS 만 고치면 됩니다.
   ========================================================================== */

import "./env.mjs";
import { createHmac } from "node:crypto";
import { get, run, nowIso, auditLog } from "./db.mjs";
import { ingestSupplierCatalog } from "./ingest.mjs";

const HOST = "https://api-gateway.coupang.com";
const SEARCH_PATH = "/v2/providers/affiliate_open_api/apis/openapi/products/search";

const credentials = () => ({
  access: (process.env.COUPANG_ACCESS_KEY || "").trim(),
  secret: (process.env.COUPANG_SECRET_KEY || "").trim(),
});

export function coupangStatus() {
  const connector = get("SELECT * FROM connectors WHERE id = 'coupang-partners'");
  const { access, secret } = credentials();
  const keyConfigured = Boolean(access && secret);
  return {
    enabled: Boolean(connector?.enabled),
    keyConfigured,
    live: Boolean(connector?.enabled && keyConfigured),
    lastSyncAt: connector?.last_sync_at || null,
    reason: !connector?.enabled
      ? "설정 > 연동설정에서 '쿠팡 파트너스'를 켜 주세요."
      : !keyConfigured
        ? "COUPANG_ACCESS_KEY / COUPANG_SECRET_KEY 환경변수가 설정되지 않았습니다."
        : null,
  };
}

/** yyMMddTHHmmssZ (GMT) — 쿠팡이 요구하는 서명 시각 표기입니다. */
export function signedDate(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "").slice(2);
}

/** CEA 서명 헤더를 만듭니다. */
export function authorization({ method, path, query, access, secret, now }) {
  const date = signedDate(now);
  const message = date + method + path + query;
  const signature = createHmac("sha256", secret).update(message).digest("hex");
  return `CEA algorithm=HmacSHA256, access-key=${access}, signed-date=${date}, signature=${signature}`;
}

/** 응답 필드명이 문서와 달라질 수 있어 후보를 여러 개 둡니다. */
const FIELDS = {
  name: ["productName", "title", "name"],
  price: ["productPrice", "salePrice", "price"],
  url: ["productUrl", "landingUrl", "link"],
  sku: ["productId", "productCode", "itemId"],
  image: ["productImage", "imageUrl"],
  vendor: ["vendorName", "sellerName", "mallName"],
  rocket: ["isRocket", "rocketShipping"],
};

const pick = (item, field) => {
  for (const candidate of FIELDS[field] || []) {
    const value = item?.[candidate];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return null;
};

/** 검색 한 번. 쿠팡은 한 번에 최대 100건을 줍니다. */
async function search({ keyword, limit }) {
  const { access, secret } = credentials();
  const query = `keyword=${encodeURIComponent(keyword)}&limit=${limit}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${HOST}${SEARCH_PATH}?${query}`, {
      signal: controller.signal,
      headers: {
        Authorization: authorization({ method: "GET", path: SEARCH_PATH, query, access, secret }),
        accept: "application/json",
      },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`쿠팡 오류 ${response.status}: ${text.slice(0, 200)}`);
    const payload = JSON.parse(text);
    if (payload.rCode && payload.rCode !== "0") {
      throw new Error(`쿠팡 오류 ${payload.rCode}: ${payload.rMessage || ""}`);
    }
    return payload?.data?.productData || payload?.data || [];
  } finally {
    clearTimeout(timer);
  }
}

/** 진단 — 실제 응답의 필드명과 현재 매핑 결과를 그대로 돌려줍니다. */
export async function probeCoupang({ keyword = "전선" } = {}) {
  const status = coupangStatus();
  if (!status.live) return { ok: false, reason: status.reason };
  const items = await search({ keyword, limit: 5 });
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

/** 검색 결과를 '쿠팡' 공급처 하나로 적재합니다. */
export async function syncCoupang({ query, maxRows = 100, dryRun = false, user }) {
  const status = coupangStatus();
  if (!status.live) return { ok: false, live: false, reason: status.reason };
  const keyword = String(query || "").trim();
  if (!keyword) return { ok: false, live: true, reason: "검색어를 입력해 주세요." };

  const items = await search({ keyword, limit: Math.min(100, maxRows) });
  const rows = [];
  let unmapped = 0;
  for (const item of items) {
    const name = String(pick(item, "name") || "").trim();
    const price = Number(String(pick(item, "price") ?? "").replace(/[^\d.]/g, ""));
    if (!name || !Number.isFinite(price) || price <= 0) { unmapped += 1; continue; }
    rows.push({
      name,
      sku: pick(item, "sku"),
      manufacturer: pick(item, "vendor"),
      price,
      shipping: pick(item, "rocket") ? 0 : null,
      priceBasis: "retail",
      url: pick(item, "url"),
    });
  }
  if (!rows.length) return { ok: false, live: true, reason: "가격이 있는 상품을 찾지 못했습니다.", unmapped };

  const supplier = supplierForCoupang();
  const outcome = ingestSupplierCatalog({
    supplierId: supplier.id, rows, filename: `쿠팡 · ${keyword}`,
    user, source: "coupang", dryRun,
  });

  if (!dryRun) {
    run("UPDATE connectors SET last_sync_at = ?, status = '정상 동기화' WHERE id = 'coupang-partners'", nowIso());
    auditLog(user, "기준정보", "쿠팡 파트너스 적재", `${keyword} / ${rows.length}건`);
  }
  return { ok: true, live: true, dryRun, query: keyword, fetched: rows.length, unmapped, summary: outcome.summary, preview: outcome.preview };
}

function supplierForCoupang() {
  const existing = get("SELECT * FROM suppliers WHERE name = '쿠팡'");
  if (existing) return existing;
  run("INSERT INTO suppliers (id, name, terms, status, note) VALUES ('SUP-COUPANG','쿠팡','온라인 시세','정상',?)",
    "쿠팡 파트너스 오픈API — 자동 등록");
  return get("SELECT * FROM suppliers WHERE id = 'SUP-COUPANG'");
}
