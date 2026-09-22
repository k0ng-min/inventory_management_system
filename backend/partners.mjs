/* ==========================================================================
   partners.mjs — 거래처 일괄 등록 · 규격 검수

   회사가 이미 쓰던 거래처 명부를 엑셀에서 CSV 로 저장해 그대로 올립니다.
   처음부터 손으로 다시 넣게 하면 시스템을 쓰기 시작하는 문턱이 됩니다.

   규격 검수는 그 반대쪽입니다 — 파서가 자신 없어 한 제품(confidence < 1)을
   사람이 보고 확정합니다. 기계가 반쯤 읽은 것을 그대로 두면 비교가 어긋납니다.
   ========================================================================== */

import { all, get, run, tx, nowIso, today, newId, auditLog } from "./db.mjs";
import { parseCsv } from "./ingest.mjs";
import { parseSpec, specKey, specLabel, canonicalName, parseCerts, CATEGORIES } from "./catalog.mjs";

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const str = (value) => (value === undefined || value === null ? null : String(value).trim() || null);

/* ---------- 거래처 일괄 등록 --------------------------------------------- */

const squash = (value) => String(value || "").replace(/[\s_\-()]/g, "").toLowerCase();

/** 엑셀마다 머리글이 제각각이라 흔한 표기를 모두 받습니다. */
const PARTNER_ALIASES = {
  name: ["업체명", "거래처명", "상호", "회사명", "고객명", "공급처명", "name"],
  bizNo: ["사업자번호", "사업자등록번호", "사업자", "bizno"],
  contact: ["담당자", "담당", "성명", "contact"],
  phone: ["전화", "전화번호", "연락처", "휴대폰", "tel", "phone"],
  email: ["이메일", "메일", "email"],
  terms: ["결제조건", "거래조건", "결제", "terms"],
  leadTime: ["납기", "리드타임", "leadtime"],
  note: ["비고", "메모", "note"],
};

function mapPartnerHeaders(headers) {
  const map = {};
  headers.forEach((header, index) => {
    const key = squash(header);
    if (!key) return;
    for (const [field, aliases] of Object.entries(PARTNER_ALIASES)) {
      if (map[field] !== undefined) continue;
      if (aliases.some((alias) => key === squash(alias) || key.includes(squash(alias)))) {
        map[field] = index;
        return;
      }
    }
  });
  return map;
}

/**
 * 공급처·고객 CSV 적재.
 * kind: 'suppliers' | 'customers'
 * 같은 이름이 이미 있으면 빈 칸만 채웁니다 — 있던 정보를 덮어써 지우지 않습니다.
 */
export function importPartners({ kind, csv, filename, user, dryRun = false }) {
  const table = kind === "customers" ? "customers" : "suppliers";
  const label = table === "customers" ? "고객" : "공급처";

  const rows = parseCsv(String(csv || ""));
  if (!rows.length) fail("CSV 내용이 비어 있습니다.");
  const headers = rows[0].map((cell) => String(cell).trim());
  const map = mapPartnerHeaders(headers);
  if (map.name === undefined) {
    fail(`${label}명 열을 찾지 못했습니다. 첫 줄에 '업체명' 또는 '거래처명' 머리글이 있어야 합니다.`);
  }

  const pick = (line, field) => (map[field] === undefined ? null : str(line[map[field]]));
  const summary = { total: 0, created: 0, updated: 0, skipped: 0 };
  const preview = [];

  const apply = () => {
    for (const line of rows.slice(1)) {
      const name = pick(line, "name");
      if (!name) { summary.skipped += 1; continue; }
      summary.total += 1;

      const values = {
        biz_no: pick(line, "bizNo"),
        contact: pick(line, "contact"),
        phone: pick(line, "phone"),
        email: pick(line, "email"),
        terms: pick(line, "terms"),
        note: pick(line, "note"),
        ...(table === "suppliers" ? { lead_time: pick(line, "leadTime") } : {}),
      };

      const existing = get(`SELECT * FROM ${table} WHERE name = ?`, name);
      if (existing) {
        // 빈 칸만 채웁니다. 이미 있는 값을 CSV 로 지우는 사고를 막습니다.
        const updates = Object.entries(values).filter(([column, value]) => value && !existing[column]);
        if (updates.length && !dryRun) {
          run(`UPDATE ${table} SET ${updates.map(([column]) => `${column} = ?`).join(", ")} WHERE id = ?`,
            ...updates.map(([, value]) => value), existing.id);
        }
        summary.updated += updates.length ? 1 : 0;
        summary.skipped += updates.length ? 0 : 1;
        preview.push({ name, status: updates.length ? "보완" : "동일", id: existing.id });
        continue;
      }

      const id = newId(table === "customers" ? "CUS" : "SUP");
      if (!dryRun) {
        const columns = ["id", "name", ...Object.keys(values)];
        run(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
          id, name, ...Object.values(values));
      }
      summary.created += 1;
      preview.push({ name, status: "신규", id });
    }
  };

  if (dryRun) apply();
  else tx(apply);

  if (!dryRun) {
    auditLog(user, "기준정보", `${label} 일괄 등록`,
      `${filename || "csv"} / 신규 ${summary.created} · 보완 ${summary.updated}`);
  }
  return { kind: table, headers, mapped: map, summary, preview: preview.slice(0, 50) };
}

/* ---------- 규격 검수 ----------------------------------------------------- */

/**
 * 파서가 자신 없어 한 제품 목록.
 * confidence 1 미만이면 규격을 반만 읽었거나 아예 못 읽은 것입니다.
 * 이대로 두면 같은 물건이 두 줄로 남거나 엉뚱한 제품과 비교됩니다.
 */
export function reviewQueue() {
  return all(`
    SELECT c.*,
           (SELECT COUNT(*) FROM supplier_products WHERE product_id = c.id AND active = 1) AS supplier_count,
           (SELECT group_concat(raw_name, ' | ') FROM supplier_products WHERE product_id = c.id) AS raw_names
    FROM catalog_products c
    WHERE c.active = 1 AND c.confidence < 1
    ORDER BY c.confidence, supplier_count DESC, c.created_at DESC
    LIMIT 200`).map((row) => ({
    ...row,
    specs: JSON.parse(row.specs || "{}"),
    fields: (CATEGORIES[row.category] || CATEGORIES.etc).fields,
  }));
}

/**
 * 검수 결과 반영.
 * 사람이 고른 분류와 규격으로 spec_key 를 다시 만들고 confidence 를 1 로 올립니다.
 * 같은 규격의 제품이 이미 있으면 새 키로 바꾸지 않고 알려 줍니다 — 합치는 것은
 * 판매조건까지 옮겨야 하는 별개의 일이라, 조용히 하면 안 됩니다.
 */
export function resolveProduct(id, body, user) {
  return tx(() => {
    const product = get("SELECT * FROM catalog_products WHERE id = ?", id);
    if (!product) fail("제품을 찾을 수 없습니다.", 404);

    const category = str(body.category) || product.category;
    if (!CATEGORIES[category]) fail("분류가 올바르지 않습니다.");

    const definition = CATEGORIES[category];
    const specs = {};
    for (const field of definition.fields) {
      const value = body.specs?.[field.key];
      if (value === undefined || value === null || String(value).trim() === "") continue;
      specs[field.key] = field.numeric ? Number(value) : String(value).trim();
      if (field.numeric && !Number.isFinite(specs[field.key])) fail(`${field.label} 은(는) 숫자로 입력해 주세요.`);
    }
    const missing = definition.keyFields.filter((key) => specs[key] === undefined);
    if (missing.length) {
      const labels = missing.map((key) => definition.fields.find((field) => field.key === key)?.label || key);
      fail(`${labels.join(", ")} 은(는) 비워 둘 수 없습니다. 이 값들로 같은 제품을 찾습니다.`);
    }

    const key = specKey(category, specs);
    const clash = get("SELECT id, name FROM catalog_products WHERE spec_key = ? AND id <> ?", key, id);
    if (clash) {
      fail(`같은 규격의 제품이 이미 있습니다: ${clash.name} (${clash.id}). 합치려면 판매조건을 옮겨야 합니다.`);
    }

    const manufacturer = str(body.manufacturer) ?? product.manufacturer;
    run(`UPDATE catalog_products
         SET category = ?, specs = ?, spec_key = ?, spec_label = ?, name = ?,
             manufacturer = ?, certification = ?, confidence = 1, updated_at = ?
         WHERE id = ?`,
      category, JSON.stringify(specs), key, specLabel(category, specs),
      canonicalName(category, specs, null) || product.name,
      manufacturer, str(body.certification) ?? product.certification, nowIso(), id);

    auditLog(user, "기준정보", "규격 확정", `${id} / ${key}`);
    return get("SELECT * FROM catalog_products WHERE id = ?", id);
  });
}

/** 검수에서 "쓰지 않는 제품" 으로 내려놓습니다. 지우지 않고 숨깁니다. */
export function retireProduct(id, user) {
  const product = get("SELECT * FROM catalog_products WHERE id = ?", id);
  if (!product) fail("제품을 찾을 수 없습니다.", 404);
  run("UPDATE catalog_products SET active = 0, updated_at = ? WHERE id = ?", nowIso(), id);
  auditLog(user, "기준정보", "제품 비활성", `${id} / ${product.name}`);
  return { ok: true };
}
