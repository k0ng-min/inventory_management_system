/* ==========================================================================
   standard-catalog.mjs — 표준 전기자재 규격으로 카탈로그 채우기

   제조사 사이트(LS ELECTRIC·현대일렉트릭 등)는 가격을 싣지 않고 화면을 자바스크립트로
   그려서 자동 수집이 막혀 있습니다. 그런데 전기자재는 사정이 다릅니다 —
   **규격이 KS/IEC 표준으로 정해져 있어 종류가 유한합니다.**

     CV 케이블 = 종류 × 단면적(1.5~300SQ) × 심선수(1~4C)
     차단기    = 종류 × 정격전류(15~800A) × 극수(2P·3P·4P)
     전선관    = 종류 × 호칭경(14~104mm)

   그래서 "어디서 긁어올까" 대신 **표준 규격표를 펼쳐** 카탈로그를 채웁니다.
   제조사가 누구든 CV 2.5SQ 4C 는 같은 물건이라, 규격 하나에 제품 하나를 둡니다.
   어느 회사 제품을 얼마에 파는지는 판매조건(supplier_products)이 들고 있습니다.

   이렇게 채워 두면 검색·비교·견적이 첫날부터 돌아가고, 가격은 나중에
   단가표 CSV 나 네이버 쇼핑으로 덧씌우면 됩니다.
   ========================================================================== */

import { createHash } from "node:crypto";

import { all, get, run, tx, nowIso, auditLog } from "./db.mjs";
import { specKey, specLabel, canonicalName, CATEGORIES } from "./catalog.mjs";

/* ---------- 표준 규격표 --------------------------------------------------- */

/** 전선·케이블. KS C IEC 60502 / KS C 3341 계열에서 실제로 생산되는 조합만 담았습니다. */
const CABLE_SPECS = [
  // 종류, 정격전압, 단면적(SQ), 심선수(C)
  { type: "CV", volt: "0.6/1KV", areas: [1.5, 2.5, 4, 6, 10, 16, 25, 35, 50, 70, 95, 120, 150, 185, 240, 300], cores: [1, 2, 3, 4] },
  { type: "TFR-CV", volt: "0.6/1KV", areas: [1.5, 2.5, 4, 6, 10, 16, 25, 35, 50, 70, 95, 120, 150, 185, 240], cores: [1, 2, 3, 4] },
  { type: "F-CV", volt: "0.6/1KV", areas: [1.5, 2.5, 4, 6, 10, 16, 25, 35, 50, 70, 95, 120], cores: [1, 2, 3, 4] },
  { type: "CVV", volt: "0.6/1KV", areas: [1.5, 2.5], cores: [2, 3, 4, 5, 6, 8, 10, 12] },
  { type: "HFIX", volt: "450/750V", areas: [1.5, 2.5, 4, 6, 10, 16, 25, 35, 50, 70, 95, 120, 150, 185, 240], cores: [1] },
  { type: "IV", volt: "450/750V", areas: [1.5, 2.5, 4, 6, 10, 16, 25, 35, 50, 70, 95, 120], cores: [1] },
  { type: "KIV", volt: "450/750V", areas: [0.75, 1.25, 2, 3.5, 5.5, 8, 14, 22, 30, 38, 50, 60, 80, 100], cores: [1] },
  { type: "VCTF", volt: "300/300V", areas: [0.75, 1.25, 1.5, 2.5, 4], cores: [2, 3, 4] },
  { type: "VCT", volt: "0.6/1KV", areas: [1.25, 2, 3.5, 5.5, 8, 14, 22, 30, 38], cores: [2, 3, 4] },
  { type: "NRI", volt: "300/500V", areas: [0.75, 1.25, 2, 3.5, 5.5], cores: [1] },
];

/* 색상은 펼치지 않습니다.
   동일제품 매칭 키가 [종류·단면적·심선수] 라 색이 달라도 같은 제품으로 봅니다.
   여기서 색까지 펼치면 같은 키를 가진 제품이 다섯 개씩 생겨 비교가 어긋납니다.
   실제로 색을 구분해 재고를 잡아야 하면 사내 품목(products)에서 나눕니다. */

/** 차단기. KS C 8321(배선용) · KS C 4613(누전) 계열의 표준 정격입니다. */
const BREAKER_SPECS = [
  { type: "MCCB", amps: [15, 20, 30, 40, 50, 60, 75, 100, 125, 150, 175, 200, 225, 250, 300, 400, 500, 600, 630, 800], poles: [2, 3, 4] },
  { type: "ELB", amps: [15, 20, 30, 40, 50, 60, 75, 100, 125, 150, 200, 225, 250, 300, 400], poles: [2, 3, 4] },
  { type: "MCB", amps: [6, 10, 15, 16, 20, 25, 30, 32, 40, 50, 63], poles: [1, 2, 3, 4] },
];

/** 전선관. 호칭경은 KS C 8431(합성수지제) · KS C 8401(금속제) 기준입니다. */
const CONDUIT_SPECS = [
  { type: "CD", sizes: [14, 16, 22, 28, 36, 42] },
  { type: "PF", sizes: [14, 16, 22, 28, 36, 42] },
  { type: "HI-PVC", sizes: [14, 16, 22, 28, 36, 42, 54, 70, 82, 92, 104] },
  { type: "EMT", sizes: [16, 22, 28, 36, 42, 54, 70, 82, 92, 104] },
  { type: "금속관", sizes: [16, 22, 28, 36, 42, 54, 70, 82, 92, 104] },
];

/** 압착단자. 형상 × 적용 단면적. */
const TERMINAL_SPECS = [
  { shape: "R", areas: [1.25, 2, 3.5, 5.5, 8, 14, 22, 38, 60, 80, 100, 150, 200] },
  { shape: "Y", areas: [1.25, 2, 3.5, 5.5, 8, 14, 22, 38, 60] },
  { shape: "O", areas: [1.25, 2, 3.5, 5.5, 8, 14, 22] },
];

/** 배선기구. */
const WIRING_SPECS = [
  { type: "콘센트", gangs: [1, 2, 3, 4], amps: [16] },
  { type: "스위치", gangs: [1, 2, 3, 4, 6], amps: [16] },
];

/**
 * 참고용 주요 제조사.
 * 규격이 같으면 어느 회사 제품이든 비교 대상이라 제품에 붙이지는 않습니다.
 * 단가표를 올릴 때 공급처·제조사를 고르는 데 쓰라고 목록만 내려보냅니다.
 */
export const KNOWN_MAKERS = {
  cable: ["LS전선", "대한전선", "가온전선", "일진전기", "극동전선", "대원전선", "서한전선", "TAIHAN"],
  breaker: ["LS ELECTRIC", "현대일렉트릭", "상도전기", "진흥전기", "SCHNEIDER", "ABB", "SIEMENS"],
  conduit: ["세홍산업", "동아플렉스", "피케이전자", "한국전선관"],
  terminal: ["동아전기", "KSS", "대성단자", "PANDUIT"],
  wiring: ["르그랑", "위너스", "한국단자", "융"],
};

/* ---------- 규격 펼치기 --------------------------------------------------- */

/** 표준 규격표를 제품 목록으로 펼칩니다. DB 를 건드리지 않아 미리보기에도 씁니다. */
export function expandStandardSpecs({ categories } = {}) {
  const want = (key) => !categories?.length || categories.includes(key);
  const out = [];

  if (want("cable")) {
    for (const family of CABLE_SPECS) {
      for (const area of family.areas) {
        for (const cores of family.cores) {
          out.push({ category: "cable", specs: { type: family.type, area, cores, volt: family.volt } });
        }
      }
    }
  }

  if (want("breaker")) {
    for (const family of BREAKER_SPECS) {
      for (const amp of family.amps) {
        for (const poles of family.poles) {
          out.push({ category: "breaker", specs: { type: family.type, amp, poles } });
        }
      }
    }
  }

  if (want("conduit")) {
    for (const family of CONDUIT_SPECS) {
      for (const size of family.sizes) out.push({ category: "conduit", specs: { type: family.type, size } });
    }
  }

  if (want("terminal")) {
    for (const family of TERMINAL_SPECS) {
      for (const area of family.areas) out.push({ category: "terminal", specs: { shape: family.shape, area } });
    }
  }

  if (want("wiring")) {
    for (const family of WIRING_SPECS) {
      for (const gang of family.gangs) {
        for (const amp of family.amps) {
          out.push({ category: "wiring", specs: { type: family.type, gang, amp } });
        }
      }
    }
  }

  return out.map((item) => ({
    ...item,
    key: specKey(item.category, item.specs),
    label: specLabel(item.category, item.specs),
    name: canonicalName(item.category, item.specs, null),
  }));
}

/* ---------- 채우기 -------------------------------------------------------- */

/**
 * 규격 키로 제품 코드를 만듭니다.
 * 기호를 떼면 2.5 와 25 가 같은 글자가 되어 부딪히므로(CV 2.5SQ vs CV 25SQ),
 * 읽을 수 있는 앞부분에 규격 키의 해시를 붙여 유일하게 만듭니다.
 */
function standardId(key) {
  const readable = key.replace(/[^A-Za-z0-9]+/g, "").slice(0, 18).toUpperCase();
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 6).toUpperCase();
  return `STD-${readable}-${hash}`;
}

/**
 * 표준 규격을 카탈로그에 넣습니다.
 * 이미 같은 규격(spec_key)이 있으면 건드리지 않습니다 — 업체가 올린 실제 제품이
 * 표준 껍데기로 덮이면 안 되기 때문입니다.
 */
export function fillStandardCatalog({ categories, user, dryRun = false } = {}) {
  const items = expandStandardSpecs({ categories });
  const existing = new Set(all("SELECT spec_key FROM catalog_products").map((row) => row.spec_key));

  const fresh = items.filter((item) => !existing.has(item.key));
  const summary = {
    total: items.length,
    created: fresh.length,
    skipped: items.length - fresh.length,
    byCategory: {},
  };
  for (const item of items) {
    const bucket = summary.byCategory[item.category] || (summary.byCategory[item.category] = { total: 0, created: 0 });
    bucket.total += 1;
    if (!existing.has(item.key)) bucket.created += 1;
  }

  if (dryRun) {
    return { ...summary, preview: fresh.slice(0, 40).map((item) => ({ name: item.name, category: item.category })) };
  }

  tx(() => {
    for (const item of fresh) {
      const definition = CATEGORIES[item.category] || CATEGORIES.etc;
      run(`INSERT OR IGNORE INTO catalog_products
             (id, spec_key, category, name, specs, spec_label, manufacturer, base_unit,
              safety_stock, barcode, note, certification, confidence, active, created_at, updated_at)
           VALUES (?,?,?,?,?,?,NULL,?,0,NULL,'KS 표준 규격',NULL,1,1,?,?)`,
        standardId(item.key),
        item.key, item.category, item.name, JSON.stringify(item.specs), item.label,
        definition.baseUnit, nowIso(), nowIso());
    }
  });

  auditLog(user, "기준정보", "표준 규격 채우기",
    `${summary.created}건 추가 · ${summary.skipped}건 이미 있음`);
  return { ...summary, preview: fresh.slice(0, 40).map((item) => ({ name: item.name, category: item.category })) };
}

/** 화면이 분류별 개수를 미리 보여 줄 수 있게, 넣지 않고 세어만 봅니다. */
export function standardCatalogSummary() {
  const items = expandStandardSpecs({});
  const existing = new Set(all("SELECT spec_key FROM catalog_products").map((row) => row.spec_key));
  const rows = Object.entries(CATEGORIES).map(([key, definition]) => {
    const mine = items.filter((item) => item.category === key);
    return {
      category: key,
      label: definition.label,
      total: mine.length,
      missing: mine.filter((item) => !existing.has(item.key)).length,
      makers: KNOWN_MAKERS[key] || [],
    };
  }).filter((row) => row.total > 0);
  return { rows, total: items.length, missing: rows.reduce((sum, row) => sum + row.missing, 0) };
}
