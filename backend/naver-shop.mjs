/* ==========================================================================
   naver-shop.mjs — 네이버 쇼핑 검색 API

   이 연동이 특별한 이유: 응답 한 건마다 `mallName` 이 붙어 옵니다.
   검색 한 번이면 같은 자재를 파는 쇼핑몰 수십 곳의 가격이 몰별로 쪼개져
   들어오므로, 그 자체로 "사이트끼리 가격비교" 가 성립합니다.

     검색어 → items[] → mallName 별로 묶기 → 몰마다 공급처 1곳
                                          → ingestSupplierCatalog()

   인증키(Client ID/Secret)는 서버 환경변수로만 읽습니다.
   발급: https://developers.naver.com/apps/#/register (검색 API 선택)
   ========================================================================== */

import "./env.mjs";
import { get, run, nowIso, auditLog } from "./db.mjs";
import { ingestSupplierCatalog } from "./ingest.mjs";

const ENDPOINT = "https://openapi.naver.com/v1/search/shop.json";
const MAX_DISPLAY = 100;    // 한 번에 받을 수 있는 최대 건수
const MAX_START = 1000;     // start 는 1000 을 넘길 수 없습니다

const credentials = () => ({
  id: (process.env.NAVER_CLIENT_ID || "").trim(),
  secret: (process.env.NAVER_CLIENT_SECRET || "").trim(),
});

export function naverStatus() {
  const connector = get("SELECT * FROM connectors WHERE id = 'naver-shop'");
  const { id, secret } = credentials();
  const keyConfigured = Boolean(id && secret);
  return {
    enabled: Boolean(connector?.enabled),
    keyConfigured,
    live: false,
    retired: true,
    sourceGrade: "E",
    lastSyncAt: connector?.last_sync_at || null,
    reason: "네이버 쇼핑 검색 Open API가 2026-07-31 종료되어 신규 수집에 사용하지 않습니다.",
  };
}

/** `<b>` 강조 태그와 HTML 엔티티가 섞여 오므로 걷어냅니다. */
function plainTitle(title) {
  return String(title || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 한 페이지를 내려받습니다. */
async function fetchPage({ query, start, display, sort }) {
  const { id, secret } = credentials();
  const params = new URLSearchParams({
    query, display: String(display), start: String(start), sort,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${ENDPOINT}?${params}`, {
      signal: controller.signal,
      headers: {
        "X-Naver-Client-Id": id,
        "X-Naver-Client-Secret": secret,
        accept: "application/json",
      },
    });
    const text = await response.text();
    if (!response.ok) {
      let message = text.slice(0, 200);
      try { message = JSON.parse(text).errorMessage || message; } catch { /* 본문 그대로 씁니다 */ }
      throw new Error(`네이버 오류 ${response.status}: ${message}`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 진단 — 키를 넣은 뒤 실제 응답 한 건을 그대로 돌려줍니다.
 * 몰 이름이 어떻게 들어오는지 눈으로 확인하는 용도입니다.
 */
export async function probeNaver({ query = "CV 케이블" } = {}) {
  const status = naverStatus();
  if (!status.live) return { ok: false, reason: status.reason };
  const payload = await fetchPage({ query, start: 1, display: 5, sort: "asc" });
  return {
    ok: true,
    total: payload.total,
    returned: payload.items?.length || 0,
    malls: [...new Set((payload.items || []).map((item) => item.mallName).filter(Boolean))],
    sample: payload.items?.[0] || null,
  };
}

/**
 * 검색어로 몰별 가격을 가져와 카탈로그에 적재합니다.
 * mallName 하나가 공급처 하나가 됩니다.
 */
export async function syncNaverShop({ query, maxRows = 300, sort = "asc", dryRun = false, user }) {
  const status = naverStatus();
  if (!status.live) return { ok: false, live: false, reason: status.reason };
  const keyword = String(query || "").trim();
  if (!keyword) return { ok: false, live: true, reason: "검색어를 입력해 주세요." };

  const collected = [];
  let total = 0;
  for (let start = 1; start <= MAX_START && collected.length < maxRows; start += MAX_DISPLAY) {
    const display = Math.min(MAX_DISPLAY, maxRows - collected.length);
    const payload = await fetchPage({ query: keyword, start, display, sort });
    total = Number(payload.total) || 0;
    const items = payload.items || [];
    if (!items.length) break;
    collected.push(...items);
    if (collected.length >= total) break;
  }

  // 몰 이름으로 묶습니다 — 이 묶음이 곧 비교 대상 사이트입니다.
  const byMall = new Map();
  let unmapped = 0;
  for (const item of collected) {
    const mallName = String(item.mallName || "").trim();
    const name = plainTitle(item.title);
    const price = Number(item.lprice);
    if (!mallName || !name || !Number.isFinite(price) || price <= 0) { unmapped += 1; continue; }

    if (!byMall.has(mallName)) byMall.set(mallName, []);
    byMall.get(mallName).push({
      name,
      sku: item.productId || null,
      manufacturer: item.maker || item.brand || null,
      price,
      priceBasis: "retail",
      url: item.link || null,
    });
  }

  const results = [];
  for (const [mallName, rows] of byMall) {
    const supplier = supplierForMall(mallName);
    const outcome = ingestSupplierCatalog({
      supplierId: supplier.id, rows,
      filename: `네이버쇼핑 · ${keyword}`,
      user, source: "naver-shop", dryRun,
    });
    results.push({ supplier: mallName, ...outcome.summary });
  }

  if (!dryRun) {
    run("UPDATE connectors SET last_sync_at = ?, status = '정상 동기화' WHERE id = 'naver-shop'", nowIso());
    auditLog(user, "기준정보", "네이버 쇼핑 적재",
      `${keyword} / 상품 ${collected.length}건 / 몰 ${byMall.size}곳`);
  }

  return {
    ok: true,
    live: true,
    dryRun,
    query: keyword,
    fetched: collected.length,
    totalAvailable: total,
    suppliers: byMall.size,
    unmapped,
    results,
  };
}

/** 네이버가 알려준 몰 이름으로 공급처를 찾고, 없으면 한 번만 만듭니다. */
function supplierForMall(mallName) {
  const existing = get("SELECT * FROM suppliers WHERE name = ?", mallName);
  if (existing) return existing;
  const id = `SUP-NV-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  run("INSERT INTO suppliers (id, name, terms, status, note) VALUES (?,?,?,'정상',?)",
    id, mallName, "온라인 시세", "네이버 쇼핑 검색 — 자동 등록");
  return get("SELECT * FROM suppliers WHERE id = ?", id);
}
