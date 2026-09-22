/* ==========================================================================
   ingest.mjs — 공급처 판매품목 적재
   공급처를 등록하고 그 업체가 파는 물품을 통째로 넣으면,
   규격을 읽어 기존 제품에 붙이거나 새 제품을 만들고, 가격 이력까지 남깁니다.

     원본 행  →  규격 파싱  →  spec_key  →  기존 제품 매칭 / 신규 생성
                                        →  supplier_products upsert
                                        →  price_history 기록
   ========================================================================== */

import { run, get, tx, nowIso, today, auditLog, newId } from "./db.mjs";
import { parseSpec, specKey, specLabel, canonicalName, CATEGORIES } from "./catalog.mjs";

/* ---------- 입력 정규화 ---------------------------------------------------- */

const toNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
};

/** "100m", "ROLL(100m)", "박스 20개" 같은 표기에서 단위와 환산수량을 뽑습니다. */
export function parseUnit(rawUnit, baseUnit) {
  const text = String(rawUnit || "").trim();
  if (!text) return { unit: baseUnit, qty: 1 };

  // 괄호 안의 환산수량을 우선합니다. ROLL(100m) → ROLL, 100
  const bracket = /^(.+?)[\s(（]+([\d.]+)\s*([A-Za-z가-힣]*)[)）]?$/.exec(text);
  if (bracket && toNumber(bracket[2])) {
    return { unit: bracket[1].trim().toUpperCase(), qty: toNumber(bracket[2]) };
  }
  // 100m, 300M 처럼 숫자+단위가 붙은 경우
  const inline = /^([\d.]+)\s*([A-Za-z가-힣]+)$/.exec(text);
  if (inline && toNumber(inline[1])) {
    return { unit: text.toUpperCase(), qty: toNumber(inline[1]) };
  }
  return { unit: text.toUpperCase(), qty: 1 };
}

/** "3일", "당일", "D+2" 등을 일수로 바꿉니다. */
export function parseLeadDays(value) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value);
  if (/당일|오늘|즉시|재고/.test(text)) return 0;
  if (/내일/.test(text)) return 1;
  const digits = /(\d+)/.exec(text);
  return digits ? Number(digits[1]) : null;
}

/* ---------- 헤더 매핑 ------------------------------------------------------ */

/** 업체마다 엑셀 헤더가 달라서, 흔한 표기를 넓게 받아들입니다. */
const HEADER_ALIASES = {
  name: ["품명", "품목명", "제품명", "상품명", "규격명", "name", "product", "item"],
  sku: ["품번", "코드", "제품코드", "상품코드", "sku", "code", "모델", "모델명"],
  manufacturer: ["제조사", "메이커", "brand", "maker", "manufacturer"],
  category: ["분류", "품목종류", "카테고리", "category"],
  unit: ["단위", "판매단위", "규격단위", "unit"],
  unitQty: ["환산수량", "입수", "입수량", "단위수량", "qty", "packqty"],
  price: ["단가", "가격", "판매가", "공급가", "price", "amount"],
  shipping: ["배송비", "운임", "shipping"],
  moq: ["최소수량", "최소주문", "moq"],
  lead: ["납기", "리드타임", "배송", "leadtime", "lead"],
  stock: ["재고", "보유재고", "stock"],
};

const squash = (text) => String(text || "").toLowerCase().replace(/[\s_()[\]/-]/g, "");

/** 헤더 행에서 우리가 아는 필드로 연결되는 열 번호를 찾습니다. */
export function mapHeaders(headers) {
  const map = {};
  headers.forEach((header, index) => {
    const key = squash(header);
    if (!key) return;
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (map[field] !== undefined) continue;
      if (aliases.some((alias) => key === squash(alias) || key.includes(squash(alias)))) {
        map[field] = index;
        return;
      }
    }
  });
  return map;
}

/* ---------- CSV 파싱 ------------------------------------------------------- */

/** 따옴표와 줄바꿈을 포함한 CSV 를 읽습니다. (엑셀에서 '다른 이름으로 저장 → CSV') */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  const source = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') { field += '"'; index += 1; }
        else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ",") { row.push(field); field = ""; continue; }
    if (char === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += char;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((line) => line.some((cell) => String(cell).trim() !== ""));
}

/* ---------- 적재 ---------------------------------------------------------- */

/**
 * 한 행을 제품 마스터에 붙입니다.
 * 반환: { productId, status: 'matched' | 'created', confidence }
 */
function attachProduct(input) {
  const parsed = parseSpec(input.name, input.category);
  const key = specKey(parsed.category, parsed.specs);
  const definition = CATEGORIES[parsed.category] || CATEGORIES.etc;

  const existing = get("SELECT * FROM catalog_products WHERE spec_key = ?", key);
  if (existing) {
    // 제조사 정보가 비어 있었다면 채워 줍니다.
    if (!existing.manufacturer && input.manufacturer) {
      run("UPDATE catalog_products SET manufacturer = ?, updated_at = ? WHERE id = ?",
        input.manufacturer, nowIso(), existing.id);
    }
    return { productId: existing.id, status: "matched", confidence: parsed.confidence, category: parsed.category };
  }

  const id = `P-${key.replace(/[^A-Za-z0-9]+/g, "").slice(0, 18).toUpperCase()}-${Math.random().toString(36).slice(2, 6)}`;
  run(`INSERT INTO catalog_products
         (id, spec_key, category, name, specs, spec_label, manufacturer, base_unit,
          safety_stock, barcode, note, confidence, active, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,0,NULL,NULL,?,1,?,?)`,
    id, key, parsed.category,
    canonicalName(parsed.category, parsed.specs, null) || input.name,
    JSON.stringify(parsed.specs), specLabel(parsed.category, parsed.specs),
    input.manufacturer || null, definition.baseUnit,
    parsed.confidence, nowIso(), nowIso());

  return { productId: id, status: "created", confidence: parsed.confidence, category: parsed.category };
}

/** 공급처 판매정보를 넣거나 갱신하고, 가격이 바뀌면 이력을 남깁니다. */
function upsertSupplierProduct(productId, supplierId, input, source) {
  const previous = get("SELECT * FROM supplier_products WHERE product_id = ? AND supplier_id = ?", productId, supplierId);
  const unitPrice = input.unitQty > 0 ? input.price / input.unitQty : input.price;
  const priceBasis = input.priceBasis || (/^g2b/i.test(source) ? "contract" : /naver|shop/i.test(source) ? "retail" : "quote");

  if (previous) {
    run(`UPDATE supplier_products SET
           supplier_sku = ?, raw_name = ?, sell_unit = ?, unit_qty = ?, price = ?,
           shipping = ?, moq = ?, lead_days = ?, stock = ?, quoted_at = ?, source = ?,
           price_basis = ?, product_url = ?, active = 1
         WHERE id = ?`,
      input.sku || previous.supplier_sku, input.name, input.unit, input.unitQty, input.price,
      input.shipping ?? previous.shipping, input.moq ?? previous.moq,
      input.leadDays ?? previous.lead_days, input.stock ?? previous.stock,
       input.quotedAt || today(), source, priceBasis, input.url || previous.product_url, previous.id);

    if (previous.price !== input.price) {
      run(`INSERT INTO price_history (product_id, supplier_id, price, unit_price, sell_unit, unit_qty, at, source)
           VALUES (?,?,?,?,?,?,?,?)`,
        productId, supplierId, input.price, unitPrice, input.unit, input.unitQty, nowIso(), source);
    }
    return previous.price === input.price ? "unchanged" : "updated";
  }

  run(`INSERT INTO supplier_products
         (id, product_id, supplier_id, supplier_sku, raw_name, sell_unit, unit_qty,
           price, shipping, moq, lead_days, stock, quoted_at, source, price_basis, product_url, active)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
    newId("SP"), productId, supplierId, input.sku || null, input.name, input.unit, input.unitQty,
    input.price, input.shipping ?? 0, input.moq ?? 1, input.leadDays ?? null, input.stock ?? null,
    input.quotedAt || today(), source, priceBasis, input.url || null);

  run(`INSERT INTO price_history (product_id, supplier_id, price, unit_price, sell_unit, unit_qty, at, source)
       VALUES (?,?,?,?,?,?,?,?)`,
    productId, supplierId, input.price, unitPrice, input.unit, input.unitQty, nowIso(), source);
  return "added";
}

/**
 * 공급처 품목 일괄 적재.
 * rows: [{ name, sku, manufacturer, category, unit, unitQty, price, shipping, moq, lead, stock }]
 */
export function ingestSupplierCatalog({
  supplierId, rows, filename, user, source = "excel", dryRun = false, catalogOnly = false,
}) {
  const supplier = get("SELECT * FROM suppliers WHERE id = ?", supplierId);
  if (!supplier) throw Object.assign(new Error("공급처를 찾을 수 없습니다."), { status: 400 });

  const summary = {
    total: 0, matched: 0, created: 0, added: 0, updated: 0,
    unchanged: 0, catalog: 0, review: 0, skipped: 0,
  };
  const preview = [];

  const apply = () => {
    for (const raw of rows) {
      const name = String(raw.name || "").trim();
      const price = toNumber(raw.price);
      if (!name) { summary.skipped += 1; continue; }
      // 품목만 적재할 때는 가격이 없어도 받습니다.
      // 가격을 공개하지 않는 몰에서 품명·규격만 거둬 품목 마스터를 채우는 경로입니다.
      if (!catalogOnly && (price === null || price <= 0)) { summary.skipped += 1; continue; }

      summary.total += 1;
      const parsedSpec = parseSpec(name, raw.category);
      const definition = CATEGORIES[parsedSpec.category] || CATEGORIES.etc;
      const unitInfo = parseUnit(raw.unit, definition.baseUnit);
      const unitQty = toNumber(raw.unitQty) ?? unitInfo.qty;

      const input = {
        name,
        sku: raw.sku ? String(raw.sku).trim() : null,
        manufacturer: raw.manufacturer ? String(raw.manufacturer).trim() : null,
        category: raw.category,
        unit: unitInfo.unit,
        unitQty: unitQty > 0 ? unitQty : 1,
        price: price === null ? null : Math.round(price),
        shipping: toNumber(raw.shipping) ?? 0,
        moq: toNumber(raw.moq) ?? 1,
        leadDays: parseLeadDays(raw.lead),
        stock: toNumber(raw.stock),
        quotedAt: raw.quotedAt || today(),
        priceBasis: raw.priceBasis,
        url: raw.url,
      };

      const attached = attachProduct(input);
      summary[attached.status] += 1;
      if (attached.confidence < 1) summary.review += 1;

      const action = catalogOnly
        ? "catalog"
        : upsertSupplierProduct(attached.productId, supplierId, input, source);
      summary[action] += 1;

      if (preview.length < 200) {
        preview.push({
          raw: name,
          productId: attached.productId,
          category: attached.category,
          specLabel: specLabel(attached.category, parsedSpec.specs),
          match: attached.status,
          action,
          confidence: attached.confidence,
          unit: input.unit,
          unitQty: input.unitQty,
          price: input.price,
          unitPrice: input.price === null ? null : Math.round((input.price / input.unitQty) * 100) / 100,
        });
      }
    }
  };

  if (dryRun) {
    // 미리보기: 실제로 쓰지 않고 결과만 계산합니다.
    let error = null;
    try {
      tx(() => { apply(); throw new Error("__ROLLBACK__"); });
    } catch (problem) {
      if (problem.message !== "__ROLLBACK__") error = problem;
    }
    if (error) throw error;
    return { summary, preview, dryRun: true };
  }

  tx(() => {
    apply();
    run(`INSERT INTO catalog_imports (id, supplier_id, filename, total, matched, created, review, at, user)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      newId("IMP"), supplierId, filename || null,
      summary.total, summary.matched, summary.created, summary.review, nowIso(), user || null);
  });

  auditLog(user, "기준정보", "공급처 품목 적재",
    `${supplier.name} / ${summary.total}건 (신규 ${summary.created} · 매칭 ${summary.matched} · 확인필요 ${summary.review})`);

  return { summary, preview, dryRun: false };
}

/** CSV 텍스트를 행 객체로 바꿉니다. */
export function rowsFromCsv(text) {
  const table = parseCsv(text);
  if (!table.length) return { rows: [], headers: [], map: {} };
  const headers = table[0].map((cell) => String(cell).trim());
  const map = mapHeaders(headers);
  if (map.name === undefined) {
    throw Object.assign(new Error("품명 열을 찾지 못했습니다. 첫 줄에 '품명' 또는 '품목명' 머리글이 있어야 합니다."), { status: 400 });
  }
  const pick = (line, field) => (map[field] === undefined ? null : line[map[field]]);
  const rows = table.slice(1).map((line) => ({
    name: pick(line, "name"),
    sku: pick(line, "sku"),
    manufacturer: pick(line, "manufacturer"),
    category: pick(line, "category"),
    unit: pick(line, "unit"),
    unitQty: pick(line, "unitQty"),
    price: pick(line, "price"),
    shipping: pick(line, "shipping"),
    moq: pick(line, "moq"),
    lead: pick(line, "lead"),
    stock: pick(line, "stock"),
  }));
  return { rows, headers, map };
}
