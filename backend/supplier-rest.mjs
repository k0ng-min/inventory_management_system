/* ========================================================================== 
   supplier-rest.mjs — 계약 공급처 REST 가격표 어댑터

   공급처마다 필드 이름은 달라도, 이 파일에서 공통 행으로 바꾼 뒤
   ingestSupplierCatalog() 하나의 적재 경로로 보냅니다.
   ========================================================================== */

import "./env.mjs";
import { get, run, nowIso, auditLog, newId } from "./db.mjs";
import { ingestSupplierCatalog } from "./ingest.mjs";

const text = (value) => value === undefined || value === null ? "" : String(value).trim();
const first = (row, names) => {
  for (const name of names) if (row?.[name] !== undefined && row[name] !== null && text(row[name])) return row[name];
  return null;
};
const numeric = (value) => {
  const parsed = Number(String(value ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
};
const cleanName = (value) => text(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

/** 다양한 공급처 응답을 [{ supplierName, row }] 구조로 정규화합니다. */
export function normalizeSupplierFeed(payload, fallbackSupplier = "") {
  const items = Array.isArray(payload) ? payload
    : Array.isArray(payload?.items) ? payload.items
      : Array.isArray(payload?.data) ? payload.data
        : Array.isArray(payload?.products) ? payload.products : [];
  const topSupplier = text(payload?.supplierName || payload?.supplier?.name || fallbackSupplier);

  return items.map((item) => {
    const name = cleanName(first(item, ["name", "productName", "itemName", "goodsName", "title"]));
    const price = numeric(first(item, ["price", "unitPrice", "salePrice", "supplyPrice", "amount"]));
    const supplierName = text(first(item, ["supplierName", "supplier", "vendorName", "mallName"])) || topSupplier;
    if (!name || !(price > 0) || !supplierName) return null;
    return {
      supplierName,
      row: {
        name,
        sku: first(item, ["sku", "productCode", "itemCode", "model"]),
        manufacturer: first(item, ["manufacturer", "maker", "brand"]),
        category: first(item, ["category", "categoryName"]),
        unit: first(item, ["unit", "sellUnit", "orderUnit"]) || "EA",
        unitQty: numeric(first(item, ["unitQty", "packQty", "conversionQty"])) || 1,
        price,
        shipping: numeric(first(item, ["shipping", "shippingFee", "deliveryFee"])) || 0,
        moq: numeric(first(item, ["moq", "minimumOrderQty", "minQty"])) || 1,
        lead: first(item, ["lead", "leadDays", "deliveryDays"]),
        stock: numeric(first(item, ["stock", "stockQty", "availableQty"])),
        quotedAt: first(item, ["quotedAt", "updatedAt", "priceDate"]),
        priceBasis: first(item, ["priceBasis"]) || "contract",
        url: first(item, ["url", "productUrl", "link"]),
      },
    };
  }).filter(Boolean);
}

export function supplierRestStatus() {
  const connector = get("SELECT * FROM connectors WHERE id = 'supplier-rest'");
  const baseUrl = process.env.SUPPLIER_API_BASE_URL || connector?.base_url || "";
  const tokenConfigured = Boolean(process.env.SUPPLIER_API_TOKEN);
  let secureUrl = false;
  try { secureUrl = new URL(baseUrl).protocol === "https:"; } catch { /* 안내에서 처리 */ }
  return {
    enabled: Boolean(connector?.enabled),
    tokenConfigured,
    baseUrl,
    supplierName: process.env.SUPPLIER_API_NAME || "",
    lastSyncAt: connector?.last_sync_at || null,
    live: Boolean(connector?.enabled && tokenConfigured && secureUrl),
    reason: !connector?.enabled ? "설정 > 연동설정에서 '계약 공급처 REST API'를 켜 주세요."
      : !baseUrl ? "SUPPLIER_API_BASE_URL 또는 API 주소를 설정해 주세요."
        : !secureUrl ? "공급처 API 주소는 HTTPS만 사용할 수 있습니다."
          : !tokenConfigured ? "SUPPLIER_API_TOKEN 환경변수가 설정되지 않았습니다." : null,
  };
}

export async function syncSupplierRest({ query = "", limit = 1000, user }) {
  const status = supplierRestStatus();
  if (!status.live) return { ok: false, live: false, reason: status.reason };

  const url = new URL(status.baseUrl);
  if (query) url.searchParams.set("q", query);
  url.searchParams.set("limit", String(Math.min(5000, Math.max(1, limit))));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let payload;
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json", authorization: `Bearer ${process.env.SUPPLIER_API_TOKEN}` },
    });
    const raw = await response.text();
    if (!response.ok) throw Object.assign(new Error(`공급처 API HTTP ${response.status}: ${raw.slice(0, 160)}`), { status: 502 });
    try { payload = JSON.parse(raw); }
    catch { throw Object.assign(new Error("공급처 API가 JSON이 아닌 응답을 반환했습니다."), { status: 502 }); }
  } finally {
    clearTimeout(timer);
  }

  const normalized = normalizeSupplierFeed(payload, status.supplierName);
  const groups = new Map();
  for (const item of normalized) {
    if (!groups.has(item.supplierName)) groups.set(item.supplierName, []);
    groups.get(item.supplierName).push(item.row);
  }

  const results = [];
  for (const [supplierName, rows] of groups) {
    let supplier = get("SELECT * FROM suppliers WHERE name = ?", supplierName);
    if (!supplier) {
      const id = newId("SUP");
      run(`INSERT INTO suppliers (id, name, terms, status, note)
           VALUES (?,?,'계약 API','정상','계약 공급처 API 자동 등록')`, id, supplierName);
      supplier = get("SELECT * FROM suppliers WHERE id = ?", id);
    }
    const outcome = ingestSupplierCatalog({
      supplierId: supplier.id, rows, filename: `계약 API${query ? ` · ${query}` : ""}`,
      user, source: "supplier-rest",
    });
    results.push({ supplier: supplierName, ...outcome.summary });
  }

  run("UPDATE connectors SET last_sync_at = ?, status = '정상 동기화' WHERE id = 'supplier-rest'", nowIso());
  auditLog(user, "기준정보", "계약 공급처 API 적재", `${query || "전체"} / 유효 ${normalized.length}건 / 업체 ${groups.size}곳`);
  return {
    ok: true, live: true, received: Array.isArray(payload) ? payload.length : (payload?.items || payload?.data || payload?.products || []).length,
    imported: normalized.length, skipped: Math.max(0, (Array.isArray(payload) ? payload.length : (payload?.items || payload?.data || payload?.products || []).length) - normalized.length),
    suppliers: groups.size, results,
  };
}
