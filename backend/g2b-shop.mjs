/* ==========================================================================
   g2b-shop.mjs — 나라장터 종합쇼핑몰 품목정보 연동
   조달청이 운영하는 공식 오픈API 입니다. 같은 물품을 여러 계약업체가
   각자 단가로 등록해 두기 때문에, 우리가 원하는 "업체별 가격비교" 형태로
   바로 들어옵니다.

     https://www.data.go.kr/data/15129471/openapi.do

   주의 — 이 파일은 공식 API 만 호출합니다. 쇼핑몰 화면을 긁지 않습니다.
   기획제안서 20장(리스크)의 "공식 API/제휴/허가된 데이터 우선" 방침을 따릅니다.
   ========================================================================== */

import "./env.mjs";
import { get, run, nowIso, auditLog } from "./db.mjs";
import { serviceKey } from "./g2b.mjs";
import { ingestSupplierCatalog } from "./ingest.mjs";

const DEFAULT_BASE = "https://apis.data.go.kr/1230000/ao/ShoppingMallPrdctInfoService";

/** 계약 유형별 오퍼레이션. 전기자재는 대부분 다수공급자계약(MAS)에 있습니다. */
export const SHOP_OPERATIONS = [
  { key: "MAS", label: "다수공급자계약", operation: "getMASCntrctPrdctInfoList" },
  { key: "THIRD", label: "제3자단가계약", operation: "getThptyUcntrctPrdctInfoList" },
];

/**
 * 공공데이터포털 응답은 서비스마다 필드명이 조금씩 다릅니다.
 * 논리 필드 하나당 후보 이름을 여러 개 두고 먼저 잡히는 것을 씁니다.
 * (키가 없어 실제 응답을 확인할 수 없으므로, 틀려도 진단으로 바로 잡을 수 있게 합니다.)
 */
const FIELD_CANDIDATES = {
  name: ["prdctClsfcNoNm", "prdctIdntNoNm", "prdctNm", "goodsNm", "itemNm"],
  spec: ["prdctSpecNm", "prdctSpec", "specNm", "dtilPrdctClsfcNoNm"],
  sku: ["prdctIdntNo", "prdctClsfcNo", "goodsNo", "itemNo"],
  supplier: ["cntrctCorpNm", "corpNm", "bizNm", "cntrctCoNm", "prcrmntCorpNm"],
  supplierBizNo: ["cntrctCorpBizno", "bizno", "corpBizno"],
  manufacturer: ["mnfctCorpNm", "mnfctNm", "makerNm", "brandNm"],
  price: ["prdctUprc", "cntrctPrceAmt", "untprcAmt", "prdctPrce", "uprc", "price"],
  unit: ["prdctUnit", "untNm", "unit", "goodsUnit"],
  lead: ["dlvrTmlmtDaynum", "dlvTmlmtDaynum", "dlvrDaynum"],
  url: ["shopngMallPrdctUrl", "prdctUrl", "goodsUrl", "dtlsUrl"],
  category: ["prdctClsfcNo", "dtilPrdctClsfcNo"],
};

const pick = (item, field) => {
  for (const candidate of FIELD_CANDIDATES[field] || []) {
    const value = item[candidate];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return null;
};

/** API 응답에서 항목 배열을 꺼냅니다. */
function extractItems(payload) {
  const body = payload?.response?.body;
  if (!body) return [];
  const items = body.items;
  if (!items) return [];
  if (Array.isArray(items)) return items;
  if (Array.isArray(items.item)) return items.item;
  if (items.item) return [items.item];
  return [];
}

export function shopStatus() {
  const connector = get("SELECT * FROM connectors WHERE id = 'g2b-items'");
  const key = serviceKey();
  return {
    enabled: Boolean(connector?.enabled),
    keyConfigured: Boolean(key),
    live: Boolean(connector?.enabled && key),
    baseUrl: connector?.base_url || DEFAULT_BASE,
    lastSyncAt: connector?.last_sync_at || null,
    reason: !connector?.enabled
      ? "설정 > 연동설정에서 '나라장터 쇼핑몰 품목정보'를 켜 주세요."
      : !key ? "G2B_SERVICE_KEY 환경변수가 설정되지 않았습니다." : null,
  };
}

/** 한 페이지를 내려받습니다. */
async function fetchPage({ operation, keyword, pageNo, rows, baseUrl, key, classNo }) {
  const params = new URLSearchParams({
    serviceKey: key,
    pageNo: String(pageNo),
    numOfRows: String(rows),
    type: "json",
  });
  if (keyword) params.set("prdctClsfcNoNm", keyword);
  if (classNo) params.set("prdctClsfcNo", classNo);

  const url = `${baseUrl.replace(/\/$/, "")}/${operation}?${params}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status} — ${text.slice(0, 200)}`);

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      const message = /<returnAuthMsg>(.*?)<\/returnAuthMsg>/.exec(text)?.[1]
        || /<errMsg>(.*?)<\/errMsg>/.exec(text)?.[1] || text.slice(0, 200);
      throw new Error(`나라장터 응답 오류: ${message}`);
    }
    const header = payload?.response?.header;
    if (header?.resultCode && header.resultCode !== "00") {
      throw new Error(`나라장터 오류 ${header.resultCode}: ${header.resultMsg || ""}`);
    }
    return { items: extractItems(payload), total: Number(payload?.response?.body?.totalCount) || 0, raw: payload };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 진단 — 인증키를 넣은 뒤 실제 응답의 필드명을 그대로 돌려줍니다.
 * 매핑이 틀렸을 때 한 번에 바로잡기 위한 장치입니다.
 */
export async function probe({ keyword = "전선", operationKey = "MAS" } = {}) {
  const status = shopStatus();
  if (!status.live) return { ok: false, reason: status.reason };
  const definition = SHOP_OPERATIONS.find((item) => item.key === operationKey) || SHOP_OPERATIONS[0];

  const page = await fetchPage({
    operation: definition.operation, keyword, pageNo: 1, rows: 3,
    baseUrl: status.baseUrl, key: serviceKey(),
  });
  const sample = page.items[0] || null;
  return {
    ok: true,
    operation: definition.operation,
    totalCount: page.total,
    returned: page.items.length,
    fields: sample ? Object.keys(sample) : [],
    sample,
    mapped: sample
      ? Object.fromEntries(Object.keys(FIELD_CANDIDATES).map((field) => [field, pick(sample, field)]))
      : null,
  };
}

/**
 * 쇼핑몰 품목을 내려받아 카탈로그에 적재합니다.
 * 계약업체를 공급처로 자동 등록하고, 업체별 단가를 그대로 넣습니다.
 */
export async function syncShoppingMall({ keyword, classNo, operationKey = "MAS", maxRows = 1000, user }) {
  const status = shopStatus();
  if (!status.live) return { ok: false, live: false, reason: status.reason };

  const definition = SHOP_OPERATIONS.find((item) => item.key === operationKey) || SHOP_OPERATIONS[0];
  const key = serviceKey();
  const perPage = 100;
  const collected = [];
  let total = 0;

  for (let pageNo = 1; collected.length < maxRows; pageNo += 1) {
    const page = await fetchPage({
      operation: definition.operation, keyword, classNo, pageNo, rows: perPage,
      baseUrl: status.baseUrl, key,
    });
    total = page.total;
    if (!page.items.length) break;
    collected.push(...page.items);
    if (collected.length >= total) break;
    if (pageNo >= 50) break;   // 안전장치
  }

  // 계약업체별로 나눠 각각 공급처로 적재합니다.
  const bySupplier = new Map();
  let unmapped = 0;
  for (const item of collected) {
    const supplierName = String(pick(item, "supplier") || "").trim();
    const name = [pick(item, "name"), pick(item, "spec")].filter(Boolean).join(" ").trim();
    const price = Number(String(pick(item, "price") ?? "").replace(/[^\d.]/g, ""));
    if (!supplierName || !name || !Number.isFinite(price) || price <= 0) { unmapped += 1; continue; }

    if (!bySupplier.has(supplierName)) bySupplier.set(supplierName, []);
    bySupplier.get(supplierName).push({
      name,
      sku: pick(item, "sku"),
      manufacturer: pick(item, "manufacturer"),
      unit: pick(item, "unit"),
      price,
      lead: pick(item, "lead"),
      priceBasis: "contract",
      url: pick(item, "url"),
    });
  }

  const results = [];
  for (const [supplierName, rows] of bySupplier) {
    let supplier = get("SELECT * FROM suppliers WHERE name = ?", supplierName);
    if (!supplier) {
      const id = `SUP-G2B-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      run(`INSERT INTO suppliers (id, name, terms, status, note)
           VALUES (?,?, '나라장터 종합쇼핑몰', '정상', '조달청 계약업체 — 오픈API 자동 등록')`, id, supplierName);
      supplier = get("SELECT * FROM suppliers WHERE id = ?", id);
    }
    const outcome = ingestSupplierCatalog({
      supplierId: supplier.id, rows, filename: `나라장터 ${definition.label}${keyword ? ` · ${keyword}` : ""}`,
      user, source: "g2b-shop",
    });
    results.push({ supplier: supplierName, ...outcome.summary });
  }

  run("UPDATE connectors SET last_sync_at = ?, status = '정상 동기화' WHERE id = 'g2b-items'", nowIso());
  auditLog(user, "기준정보", "나라장터 쇼핑몰 적재",
    `${definition.label}${keyword ? ` / ${keyword}` : ""} / 품목 ${collected.length}건 / 업체 ${bySupplier.size}곳`);

  return {
    ok: true,
    live: true,
    operation: definition.operation,
    fetched: collected.length,
    totalAvailable: total,
    suppliers: bySupplier.size,
    unmapped,
    results,
  };
}
