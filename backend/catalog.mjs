/* ==========================================================================
   catalog.mjs — 전기자재 규격 파서 / 동일제품 매칭
   업체마다 제품명 표기가 달라도 같은 물건이면 하나로 묶는 것이 목적입니다.

     "CV2.5 4C"        ┐
     "CV 2.5SQ 4C"     ├─→ spec_key: cable|CV|2.5|4|0.6/1KV
     "CV 2.5㎟ 4C"     ┘

   품목 종류마다 비교해야 하는 규격이 다르므로, 종류별로 파서와 필드를 따로 둡니다.
   ========================================================================== */

/** 품목 종류 정의. 규격 필드는 비교 화면의 열이 되기도 합니다. */
export const CATEGORIES = {
  cable: {
    label: "전선/케이블",
    baseUnit: "m",
    fields: [
      { key: "type", label: "종류" },
      { key: "area", label: "단면적", unit: "SQ", numeric: true },
      { key: "cores", label: "심선수", unit: "C", numeric: true },
      { key: "volt", label: "정격전압" },
      { key: "color", label: "색상" },
    ],
    keyFields: ["type", "area", "cores"],
  },
  breaker: {
    label: "차단기",
    baseUnit: "EA",
    fields: [
      { key: "type", label: "종류" },
      { key: "amp", label: "정격전류", unit: "A", numeric: true },
      { key: "poles", label: "극수", unit: "P", numeric: true },
      { key: "volt", label: "정격전압" },
      { key: "ka", label: "차단용량", unit: "kA", numeric: true },
    ],
    keyFields: ["type", "amp", "poles"],
  },
  conduit: {
    label: "전선관/배관",
    baseUnit: "m",
    fields: [
      { key: "type", label: "종류" },
      { key: "size", label: "호칭경", unit: "mm", numeric: true },
      { key: "color", label: "색상" },
    ],
    keyFields: ["type", "size"],
  },
  panel: {
    label: "분전반",
    baseUnit: "EA",
    fields: [
      { key: "type", label: "종류" },
      { key: "circuits", label: "회로수", numeric: true },
      { key: "volt", label: "정격전압" },
    ],
    keyFields: ["type", "circuits"],
  },
  wiring: {
    label: "콘센트/스위치",
    baseUnit: "EA",
    fields: [
      { key: "type", label: "형식" },
      { key: "gang", label: "구수", unit: "구", numeric: true },
      { key: "amp", label: "정격전류", unit: "A", numeric: true },
      { key: "color", label: "색상" },
    ],
    keyFields: ["type", "gang"],
  },
  terminal: {
    label: "터미널/압착단자",
    baseUnit: "EA",
    fields: [
      { key: "shape", label: "형상" },
      { key: "area", label: "적용단면적", unit: "SQ", numeric: true },
    ],
    keyFields: ["shape", "area"],
  },
  tool: { label: "공구", baseUnit: "EA", fields: [{ key: "model", label: "모델" }], keyFields: ["model"] },
  consumable: { label: "소모품", baseUnit: "EA", fields: [{ key: "spec", label: "규격" }], keyFields: ["spec"] },
  etc: { label: "기타", baseUnit: "EA", fields: [{ key: "spec", label: "규격" }], keyFields: ["spec"] },
};

export const CATEGORY_KEYS = Object.keys(CATEGORIES);

/* ---------- 표기 정규화 ------------------------------------------------- */

/** 단면적 표기를 모두 숫자로 통일합니다. 2.5SQ / 2.5㎟ / 2.5mm2 / 2.5스퀘어 → 2.5 */
const AREA_UNIT = "(?:sq|㎟|mm2|mm²|스퀘어|스퀘아)?";

/** 전각·기호·단위 흔들림을 먼저 없앱니다. */
export function normalizeText(raw) {
  return String(raw || "")
    .toUpperCase()
    .replace(/[㎟]/g, "SQ")
    .replace(/MM2|MM²/g, "SQ")
    .replace(/스퀘어|스퀘아/g, "SQ")
    .replace(/[×*]/g, "X")
    .replace(/[（(]/g, " ").replace(/[）)]/g, " ")
    .replace(/[-_/]+/g, (match) => (match === "/" ? "/" : "-"))
    .replace(/\s+/g, " ")
    .trim();
}

/* ---------- 종류별 파서 -------------------------------------------------- */

const CABLE_TYPES = [
  "TFR-CV", "F-CV", "FR-CV", "CVV-S", "CVV", "CV", "HFIX", "HIV", "VCTF", "VCT",
  "KIV", "IV", "NRI", "FR-8", "TFR-8", "UTP", "STP", "MI", "EV", "CE",
];
const CONDUIT_TYPES = ["CD", "PF", "HI-PVC", "PVC", "후렉시블", "금속관", "스틸", "EMT"];
const BREAKER_TYPES = ["MCCB", "ELB", "ELCB", "MCB", "NFB", "ABB", "RCD", "배선용", "누전"];
const COLORS = ["흑색", "백색", "적색", "청색", "녹색", "황색", "회색", "갈색", "흑", "백", "적", "청", "녹", "황"];

const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const findFirst = (text, list) => list.find((item) => text.includes(item)) || null;
const findColor = (text) => {
  const hit = COLORS.find((color) => text.includes(color));
  if (!hit) return null;
  return { 흑: "흑색", 백: "백색", 적: "적색", 청: "청색", 녹: "녹색", 황: "황색" }[hit] || hit;
};

/** 전선/케이블: 종류 + 단면적 + 심선수 (+ 전압/색상) */
function parseCable(text) {
  const type = findFirst(text, CABLE_TYPES);
  if (!type) return null;

  // "2.5 4C", "2.5SQ X 4C", "2.5SQ-4C", "4C 2.5SQ" 모두 허용
  let area = null;
  let cores = null;

  const forward = new RegExp(`([\\d.]+)\\s*${AREA_UNIT}\\s*(?:X\\s*)?(\\d+)\\s*(?:C|심)\\b`, "i").exec(text);
  if (forward) { area = num(forward[1]); cores = num(forward[2]); }

  if (area === null) {
    const backward = new RegExp(`(\\d+)\\s*(?:C|심)\\s*(?:X\\s*)?([\\d.]+)\\s*${AREA_UNIT}`, "i").exec(text);
    if (backward) { cores = num(backward[1]); area = num(backward[2]); }
  }
  if (area === null) {
    const areaOnly = new RegExp(`([\\d.]+)\\s*(?:SQ)\\b`, "i").exec(text);
    if (areaOnly) area = num(areaOnly[1]);
  }
  if (area === null) {
    // KIV 1.5 처럼 단위를 생략한 표기. 종류 바로 뒤의 숫자를 단면적으로 봅니다.
    const escaped = type.replace(/[-]/g, "\\-");
    const bare = new RegExp(`${escaped}\\s*([\\d.]+)(?!\\s*(?:C\\b|심|P\\b|A\\b))`, "i").exec(text);
    if (bare) area = num(bare[1]);
  }
  if (cores === null) {
    const coreOnly = /(\d+)\s*(?:C|심)\b/i.exec(text);
    if (coreOnly) cores = num(coreOnly[1]);
  }
  if (area === null) return null;

  const voltMatch = /(\d+(?:\.\d+)?\/\d+(?:\.\d+)?\s*KV|\d+\s*V)\b/i.exec(text);
  const volt = voltMatch ? voltMatch[1].replace(/\s+/g, "") : (type === "CV" || type === "TFR-CV" ? "0.6/1KV" : null);

  // KIV/IV 처럼 본래 단심인 전선만 1C 로 보정합니다.
  // CV 같은 다심 전선에서 심선수를 임의로 채우면 엉뚱한 제품과 묶입니다.
  const SINGLE_CORE = ["KIV", "IV", "HIV", "HFIX", "NRI"];
  const resolvedCores = cores ?? (SINGLE_CORE.includes(type) ? 1 : null);
  return { type, area, cores: resolvedCores, volt, color: findColor(text) };
}

/** 차단기: 종류 + 정격전류 + 극수 */
function parseBreaker(text) {
  const type = findFirst(text, BREAKER_TYPES);
  const amp = num(/(\d+)\s*A\b/i.exec(text)?.[1]);
  const poles = num(/(\d+)\s*P\b/i.exec(text)?.[1]);
  if (!type && poles === null) return null;   // 'A' 만 있는 배선기구를 차단기로 오인하지 않도록
  return {
    type: type || "차단기",
    amp,
    poles,
    volt: /(\d+)\s*V\b/i.exec(text)?.[0]?.replace(/\s+/g, "") || null,
    ka: num(/(\d+(?:\.\d+)?)\s*KA\b/i.exec(text)?.[1]),
  };
}

/** 전선관: 종류 + 호칭경 */
function parseConduit(text) {
  const type = findFirst(text, CONDUIT_TYPES);
  if (!type) return null;
  const size = num(/(\d+(?:\.\d+)?)\s*(?:MM|Φ|파이)?\b/i.exec(text.replace(type, ""))?.[1]);
  return { type, size, color: findColor(text) };
}

/** 터미널: 형상(R/Y/O) + 적용 단면적 */
function parseTerminal(text) {
  if (!/터미널|단자|압착/.test(text)) return null;
  const shape = /\b([RYO])\s*형/i.exec(text)?.[1]?.toUpperCase()
    || (/\bR형|링/.test(text) ? "R" : /\bY형|포크/.test(text) ? "Y" : null);
  const area = num(new RegExp(`([\\d.]+)\\s*${AREA_UNIT}`, "i").exec(text)?.[1]);
  if (!shape && area === null) return null;
  return { shape: shape || "기타", area };
}

/** 콘센트/스위치 */
function parseWiring(text) {
  if (!/콘센트|스위치|매입|노출|플러그/.test(text)) return null;
  return {
    type: /콘센트/.test(text) ? "콘센트" : /스위치/.test(text) ? "스위치" : "배선기구",
    // 한글 뒤에는 \b 가 기대대로 걸리지 않아 경계를 쓰지 않습니다.
    gang: num(/(\d+)\s*(?:구|GANG)/i.exec(text)?.[1]),
    amp: num(/(\d+)\s*A\b/i.exec(text)?.[1]),
    color: findColor(text),
  };
}

const PARSERS = [
  ["cable", parseCable],
  ["conduit", parseConduit],
  ["terminal", parseTerminal],
  ["wiring", parseWiring],     // 'A' 표기가 겹치므로 차단기보다 먼저
  ["breaker", parseBreaker],
];

/**
 * 제품명에서 종류와 규격을 뽑습니다.
 * hintCategory 를 주면 그 종류의 파서를 우선 적용합니다.
 * 반환: { category, specs, confidence }
 *   confidence — 1.0 자신 있음 / 0.5 일부만 / 0 못 읽음(수동 확인 필요)
 */
export function parseSpec(rawName, hintCategory) {
  const text = normalizeText(rawName);
  if (!text) return { category: hintCategory || "etc", specs: {}, confidence: 0 };

  const ordered = hintCategory && PARSERS.some(([key]) => key === hintCategory)
    ? [...PARSERS.filter(([key]) => key === hintCategory), ...PARSERS.filter(([key]) => key !== hintCategory)]
    : PARSERS;

  for (const [category, parse] of ordered) {
    const specs = parse(text);
    if (!specs) continue;
    const required = CATEGORIES[category].keyFields;
    const filled = required.filter((field) => specs[field] !== null && specs[field] !== undefined).length;
    return {
      category,
      specs: Object.fromEntries(Object.entries(specs).filter(([, value]) => value !== null && value !== undefined)),
      confidence: filled === required.length ? 1 : filled > 0 ? 0.5 : 0,
    };
  }

  return { category: hintCategory || "etc", specs: { spec: text }, confidence: 0 };
}

/**
 * 제품명에 적힌 인증 표기를 뽑습니다.
 * 전기자재는 규격이 같아도 인증 유무가 현장 반입 가부를 가르므로 비교 항목입니다.
 * 이름에 없는 인증을 만들어 내지는 않습니다 — 적힌 것만 읽습니다.
 */
const CERT_MARKS = [
  [/\bKS\s?C\b|\bKS\b/, "KS"],
  [/\bKC\b|전기용품안전|안전인증/, "KC"],
  [/\bUL\b/, "UL"],
  [/\bCE\b/, "CE"],
  [/\bTUV\b/, "TUV"],
  [/\bIEC\b/, "IEC"],
  [/\bROHS\b/, "RoHS"],
  [/고효율|에너지절약/, "고효율"],
];

export function parseCerts(rawName) {
  const text = normalizeText(rawName);
  if (!text) return null;
  const hits = CERT_MARKS.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
  return hits.length ? [...new Set(hits)].join("·") : null;
}

/**
 * 동일제품 매칭 키. 같은 키를 가지면 같은 물건으로 봅니다.
 * 제조사는 키에 넣지 않습니다 — 규격이 같으면 비교 대상이기 때문입니다.
 */
export function specKey(category, specs) {
  const definition = CATEGORIES[category] || CATEGORIES.etc;
  const parts = definition.keyFields.map((field) => {
    const value = specs?.[field];
    if (value === null || value === undefined || value === "") return "";
    return typeof value === "number" ? String(value) : normalizeText(value);
  });
  return [category, ...parts].join("|");
}

/** 규격을 사람이 읽는 한 줄로 만듭니다. (예: CV 2.5SQ 4C 0.6/1KV) */
export function specLabel(category, specs) {
  const definition = CATEGORIES[category] || CATEGORIES.etc;
  return definition.fields
    .map((field) => {
      const value = specs?.[field.key];
      if (value === null || value === undefined || value === "") return null;
      return field.unit ? `${value}${field.unit}` : String(value);
    })
    .filter(Boolean)
    .join(" ");
}

/** 표준 제품명 — 검색 결과에 보이는 이름입니다. */
export function canonicalName(category, specs, manufacturer) {
  const label = specLabel(category, specs);
  return manufacturer ? `${label} (${manufacturer})` : label || CATEGORIES[category]?.label || "미분류";
}

/**
 * 검색어도 같은 파서를 태워 규격으로 바꿉니다.
 * 덕분에 "CV 2.5 4C" 와 "CV2.5SQ4C" 가 같은 결과를 냅니다.
 */
export function parseQuery(query) {
  const text = normalizeText(query);
  const parsed = parseSpec(query);
  return {
    text,
    tokens: text.split(/\s+/).filter(Boolean),
    category: parsed.confidence > 0 ? parsed.category : null,
    specs: parsed.confidence > 0 ? parsed.specs : {},
    key: parsed.confidence === 1 ? specKey(parsed.category, parsed.specs) : null,
  };
}

/**
 * 검색어 규격과 제품 규격의 일치도(0~100).
 * 규격이 어긋나는 제품을 위로 올리지 않기 위한 점수입니다.
 */
export function matchScore(query, product) {
  if (!query.category) {
    // 규격을 못 읽은 검색어는 문자열 포함 여부로만 판단합니다.
    // 업체가 쓰는 원래 제품명과 공급처명까지 포함해야 "전기자재24" 같은 검색이 걸립니다.
    const haystack = [product.name, product.spec_label, product.manufacturer, product.supplier_blob]
      .filter(Boolean).join(" ").toUpperCase();
    const hits = query.tokens.filter((token) => haystack.includes(token)).length;
    return query.tokens.length ? Math.round((hits / query.tokens.length) * 100) : 100;
  }
  if (query.category !== product.category) return 0;

  const definition = CATEGORIES[product.category] || CATEGORIES.etc;
  const specs = typeof product.specs === "string" ? JSON.parse(product.specs || "{}") : (product.specs || {});
  const wanted = Object.entries(query.specs);
  if (!wanted.length) return 60;

  let matched = 0;
  for (const [field, value] of wanted) {
    const actual = specs[field];
    if (actual === undefined || actual === null) continue;
    const same = typeof value === "number"
      ? Math.abs(Number(actual) - value) < 1e-9
      : normalizeText(actual) === normalizeText(value);
    if (same) matched += definition.keyFields.includes(field) ? 2 : 1;
  }
  const total = wanted.reduce((sum, [field]) => sum + (definition.keyFields.includes(field) ? 2 : 1), 0);
  return Math.round((matched / total) * 100);
}
