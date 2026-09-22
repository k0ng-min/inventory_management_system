/* ==========================================================================
   copper.mjs — 전기동 고시가 · 전선 구리 원가

   전선값은 쇼핑몰이 정하는 게 아니라 **구리값이 정합니다.** 업계는 한국전선공업
   협동조합이 매달 내는 '전기동 고시가'(원/톤)를 기준으로 단가를 주고받습니다.
   그래서 판매 사이트를 긁지 않아도 전선 원가의 바닥값을 알 수 있습니다.

     도체중량(kg/km) = 단면적(SQ) × 심선수 × 8.89 × 연선 꼬임 보정
     구리 원가(원/m)  = 도체중량 ÷ 1000 × 고시가(원/kg)

   여기에 절연·시스·가공·유통 마진이 붙은 것이 실제 판매가입니다. 그러니
   **구리 원가보다 싼 견적은 뭔가 잘못된 것**이고, 두 배가 넘으면 비싼 것입니다.
   견적을 받았을 때 이 숫자 하나로 판단이 섭니다.

   자료 출처: 한국전선공업협동조합 산업정보 > 월별 LME 고시가.
   robots.txt 가 /04.members/ 등을 막지만 /04.industry/ 는 열려 있습니다.
   월 1회 갱신되는 표 하나라 부담을 주지 않습니다.
   ========================================================================== */

import { all, get, run, nowIso, today, auditLog } from "./db.mjs";

const SOURCE_URL = "https://www.koreacable.or.kr/04.industry/monthlylme.jsp?MENUCODE=p40101";

/** 구리 밀도 8.89 g/cm³ → 1SQ(mm²) 1km 당 8.89kg. */
const COPPER_KG_PER_SQ_KM = 8.89;
/** 연선은 소선을 꼬아 만들어 직선 길이보다 도체가 더 들어갑니다(약 2%). */
const STRANDING = 1.02;

/* ---------- 고시가 가져오기 ---------------------------------------------- */

const stripTags = (html) => String(html).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const toNumber = (text) => {
  const parsed = Number(String(text || "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
};

/** 표 한 장을 읽어 월별 고시가로 바꿉니다. */
export function parseCopperTable(html) {
  const rows = [];
  for (const block of String(html).match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []) {
    const cells = (block.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || []).map(stripTags);
    if (cells.length < 8) continue;

    const year = toNumber(cells[1]);
    const month = toNumber(cells[2]);
    const pricePerTon = toNumber(cells[7]);
    // 머리글 행과 빈 행을 거릅니다.
    if (!year || year < 2000 || !month || month < 1 || month > 12 || !pricePerTon) continue;

    rows.push({
      yearMonth: `${year}-${String(month).padStart(2, "0")}`,
      lmeUsd: toNumber(cells[4]),
      premiumUsd: toNumber(cells[5]),
      fx: toNumber(cells[6]),
      pricePerTon,
      pricePerKg: Math.round(pricePerTon / 1000),
    });
  }
  return rows;
}

/** 조합 페이지를 읽어 DB 에 채웁니다. 이미 있는 달은 값이 바뀐 것만 고칩니다. */
export async function syncCopperPrices({ user } = {}) {
  let html;
  try {
    const response = await fetch(SOURCE_URL, {
      // HTTP 헤더는 ASCII 만 담을 수 있습니다. 한글을 넣으면 요청 자체가 만들어지지 않습니다.
      headers: { "user-agent": "ElectroERP/1.0 (materials price reference; monthly)" },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    html = await response.text();
  } catch (error) {
    return { ok: false, reason: `조합 사이트를 읽지 못했습니다: ${String(error.message || error).slice(0, 60)}` };
  }

  const rows = parseCopperTable(html);
  if (!rows.length) return { ok: false, reason: "고시가 표를 찾지 못했습니다. 사이트 구조가 바뀌었을 수 있습니다." };

  let added = 0;
  let updated = 0;
  for (const row of rows) {
    const existing = get("SELECT * FROM copper_prices WHERE year_month = ?", row.yearMonth);
    if (!existing) {
      run(`INSERT INTO copper_prices (year_month, lme_usd, premium_usd, fx, price_per_ton, fetched_at)
           VALUES (?,?,?,?,?,?)`,
        row.yearMonth, row.lmeUsd, row.premiumUsd, row.fx, row.pricePerTon, nowIso());
      added += 1;
    } else if (existing.price_per_ton !== row.pricePerTon) {
      run("UPDATE copper_prices SET lme_usd = ?, premium_usd = ?, fx = ?, price_per_ton = ?, fetched_at = ? WHERE year_month = ?",
        row.lmeUsd, row.premiumUsd, row.fx, row.pricePerTon, nowIso(), row.yearMonth);
      updated += 1;
    }
  }

  auditLog(user || "시스템", "기준정보", "전기동 고시가 수집", `${rows.length}개월 · 신규 ${added} · 갱신 ${updated}`);
  return { ok: true, months: rows.length, added, updated, latest: rows[0] };
}

/* ---------- 조회 ---------------------------------------------------------- */

/** 최근 고시가와 전월 대비 변동. */
export function copperStatus() {
  const rows = all("SELECT * FROM copper_prices ORDER BY year_month DESC LIMIT 13");
  if (!rows.length) {
    return { has: false, reason: "아직 받아 온 고시가가 없습니다. '시세 새로고침' 을 눌러 주세요.", source: SOURCE_URL };
  }
  const [latest, previous] = rows;
  const change = previous
    ? Math.round(((latest.price_per_ton - previous.price_per_ton) / previous.price_per_ton) * 1000) / 10
    : null;

  return {
    has: true,
    source: SOURCE_URL,
    sourceName: "한국전선공업협동조합 월별 LME 고시가",
    yearMonth: latest.year_month,
    pricePerTon: latest.price_per_ton,
    pricePerKg: Math.round(latest.price_per_ton / 1000),
    lmeUsd: latest.lme_usd,
    fx: latest.fx,
    change,
    fetchedAt: latest.fetched_at,
    trend: rows.slice().reverse().map((row) => ({ at: row.year_month, price: row.price_per_ton })),
  };
}

/* ---------- 구리 원가 산출 ------------------------------------------------ */

/**
 * 규격에서 도체중량(kg/km)을 냅니다.
 * 전선이 아니거나 단면적을 모르면 null — 모르는 것을 꾸며 내지 않습니다.
 */
export function conductorWeight(category, specs) {
  if (category !== "cable") return null;
  const area = Number(specs?.area);
  if (!Number.isFinite(area) || area <= 0) return null;
  const cores = Number(specs?.cores) > 0 ? Number(specs.cores) : 1;
  return Math.round(area * cores * COPPER_KG_PER_SQ_KM * STRANDING * 10) / 10;
}

/**
 * 전선 한 가닥(1m)에 들어간 구리값.
 * 여기에 절연·시스·가공·유통이 더해진 것이 판매가라, 이 값은 **바닥선**입니다.
 */
export function copperFloor(category, specs, pricePerKg) {
  const weight = conductorWeight(category, specs);
  if (weight === null || !pricePerKg) return null;
  return Math.round((weight / 1000) * pricePerKg);
}

/**
 * 받은 단가가 구리값 대비 어디쯤인지 봅니다.
 * 1.0 보다 작으면 구리값도 안 되는 값이라 뭔가 잘못된 것입니다.
 */
export function judgeCablePrice(unitPrice, floor) {
  if (!floor || !unitPrice) return null;
  const ratio = Math.round((unitPrice / floor) * 100) / 100;
  const verdict = ratio < 1 ? "구리값 미만"
    : ratio < 1.6 ? "싼 편"
      : ratio < 2.6 ? "보통"
        : "비싼 편";
  return { ratio, verdict, floor };
}
