/* ==========================================================================
   mall-scrape.mjs — 온라인 자재몰 목록 수집 (범용 Cafe24 스킨)

   국내 자재몰 상당수가 Cafe24 위에 올라가 있습니다. 스킨은 업체마다 달라도
   상품 한 칸은 언제나 `<li id="anchorBoxId_{번호}">` 로 시작하므로, 이 앵커를
   기준으로 쪼갠 뒤 이름·가격을 여러 후보 패턴으로 훑습니다.
   덕분에 몰을 추가할 때는 MALLS 에 주소 한 줄만 넣으면 됩니다.

     목록 페이지  →  앵커로 분할  →  이름·가격·URL
                                  →  (선택) 상세 페이지의 기본정보 표
                                  →  ingestSupplierCatalog()

   robots.txt 를 존중합니다. 자재코리아는 /product/ 를 막지 않습니다
   (차단 대상: /admin, /api, /exec/front/, /member/, /myshop/).
   ========================================================================== */

import { get, run, nowIso, auditLog } from "./db.mjs";
import { ingestSupplierCatalog } from "./ingest.mjs";

/** 수집 대상 몰. 같은 Cafe24 스킨이면 주소만 추가하면 됩니다. */
export const MALLS = [
  {
    id: "jajekorea",
    name: "자재코리아",
    origin: "https://jajekorea.com",
    listPath: "/product/list.html",
    detailPath: "/product/detail.html",
    perPage: 48,
    priceBasis: "retail",
    note: "온라인 자재몰 — 목록 수집 (robots 허용 경로)",
  },
];

export const mallById = (id) => MALLS.find((mall) => mall.id === id) || null;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
  + "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------- HTTP ---------------------------------------------------------- */

/**
 * 한 페이지를 문자열로 받습니다.
 * 몰이 EUC-KR 인 경우가 있어 meta charset 을 보고 다시 디코딩합니다.
 */
async function fetchHtml(url, { timeout = 20000, retry = 1 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: {
          "user-agent": UA,
          accept: "text/html,application/xhtml+xml",
          "accept-language": "ko-KR,ko;q=0.9",
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());

      const head = buffer.subarray(0, 2048).toString("latin1");
      const declared = /charset=["']?([\w-]+)/i.exec(head)?.[1]?.toLowerCase();
      const header = /charset=([\w-]+)/i.exec(response.headers.get("content-type") || "")?.[1]?.toLowerCase();
      const charset = header || declared || "utf-8";
      if (/euc-kr|ks_c_5601|cp949/.test(charset)) return new TextDecoder("euc-kr").decode(buffer);
      return buffer.toString("utf8");
    } catch (problem) {
      if (attempt >= retry) throw new Error(`${url} 요청 실패: ${problem.message}`);
      await sleep(600);
    } finally {
      clearTimeout(timer);
    }
  }
}

/* ---------- HTML 유틸 ------------------------------------------------------ */

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

/** 태그를 걷어내고 공백을 정리합니다. */
export function textOf(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (whole, name) => {
      const key = name.toLowerCase();
      if (ENTITIES[key]) return ENTITIES[key];
      if (key.startsWith("#x")) return String.fromCodePoint(parseInt(key.slice(2), 16));
      if (key.startsWith("#")) return String.fromCodePoint(Number(key.slice(1)));
      return whole;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** "55,000원", "55000" → 55000. "전화문의", "" → null */
export function wonOf(text) {
  const source = String(text || "");
  if (!source.trim() || /전화|문의|품절|별도/.test(source)) return null;
  const digits = /([0-9][0-9,]*)/.exec(source.replace(/\s/g, ""));
  if (!digits) return null;
  const value = Number(digits[1].replace(/,/g, ""));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/* ---------- 목록 파싱 ------------------------------------------------------ */

/**
 * 상품 목록 한 페이지를 항목 배열로 바꿉니다.
 * Cafe24 스킨 공통 앵커(anchorBoxId_)로 쪼개고, 이름·가격은 후보를 차례로 시도합니다.
 */
export function parseList(html, mall) {
  const blocks = html.split(/<li[^>]*\bid="anchorBoxId_/i).slice(1);
  const items = [];

  for (const block of blocks) {
    const productNo = /^(\d+)/.exec(block)?.[1];
    if (!productNo) continue;

    // 이름 — ① 상품명 링크의 마지막 span ② class="name" ③ 썸네일 alt
    let name = null;
    const nameLink = /<a[^>]*class="[^"]*(?:df-prl-name|prdName|name)[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (nameLink) {
      const spans = [...nameLink[1].matchAll(/<span[^>]*>([\s\S]*?)<\/span>/gi)].map((m) => textOf(m[1]));
      name = (spans.filter(Boolean).pop() || textOf(nameLink[1])).replace(/^상품명\s*:?\s*/, "").trim();
    }
    if (!name) name = textOf(/<strong[^>]*class="[^"]*\bname\b[^"]*"[^>]*>([\s\S]*?)<\/strong>/i.exec(block)?.[1] || "");
    if (!name) name = textOf(/<img[^>]*\balt="([^"]{2,})"[^>]*class="[^"]*thumb/i.exec(block)?.[1] || "");
    if (!name) continue;

    // 가격 — ① 숨은 데이터 span(순수 숫자) ② 판매가 셀 ③ 블록 안 "N,NNN원"
    let price = wonOf(/class="[^"]*df-prl-data-price[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(block)?.[1]);
    if (price === null) {
      const cell = /class="[^"]*product_price[^"]*"[^>]*>([\s\S]*?)<\/li>/i.exec(block)?.[1];
      price = wonOf(textOf(cell || "").replace(/^.*?판매가\s*:?/, ""));
    }
    if (price === null) price = wonOf(/([0-9][0-9,]{2,})\s*원/.exec(textOf(block))?.[0]);

    const image = /<img[^>]*\bsrc="([^"]+)"[^>]*class="[^"]*thumb/i.exec(block)?.[1] || null;

    items.push({
      productNo,
      name,
      price,
      soldOut: /품절|sold\s*out/i.test(block),
      image: image ? (image.startsWith("//") ? `https:${image}` : image) : null,
      url: `${mall.origin}${mall.detailPath}?product_no=${productNo}`,
    });
  }
  return items;
}

/* ---------- 상세 파싱 ------------------------------------------------------ */

/** 상세의 '기본 정보' 표를 {머리말: 값} 으로 읽습니다. 행 구성은 몰마다 다릅니다. */
export function parseInfoTable(html) {
  const table = {};
  for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const th = /<th[^>]*>([\s\S]*?)<\/th>/i.exec(row[1]);
    const td = /<td[^>]*>([\s\S]*?)<\/td>/i.exec(row[1]);
    if (!th || !td) continue;
    const label = textOf(th[1]);
    if (!label || table[label] !== undefined) continue;   // 먼저 나온 값을 씁니다
    table[label] = textOf(td[1].replace(/<option[\s\S]*?<\/option>/gi, " "));
  }
  return table;
}

/** 라벨 표기가 몰마다 조금씩 달라서 후보를 여러 개 둡니다. */
const LABELS = {
  manufacturer: ["제조사", "제조회사", "브랜드", "메이커"],
  origin: ["원산지", "제조국"],
  shipping: ["배송비", "배송료", "택배비"],
  sku: ["상품코드", "자체상품코드", "품번", "모델명"],
  price: ["판매가", "가격", "소비자가"],
  unit: ["판매단위", "단위", "규격"],
};

function labelPick(table, field) {
  for (const label of LABELS[field]) {
    const value = table[label];
    if (value && value !== "-" && value !== "0") return value;
  }
  return null;
}

/** 상세 페이지에서 제조사·배송비·상품코드를 보강합니다. */
export async function fetchDetail(mall, productNo) {
  const html = await fetchHtml(`${mall.origin}${mall.detailPath}?product_no=${productNo}`);
  const table = parseInfoTable(html);
  return {
    manufacturer: labelPick(table, "manufacturer"),
    shipping: wonOf(labelPick(table, "shipping")) ?? 0,
    sku: labelPick(table, "sku"),
    unit: labelPick(table, "unit"),
    origin: labelPick(table, "origin"),
    price: wonOf(labelPick(table, "price")),
    fields: Object.keys(table),
  };
}

/* ---------- 카테고리 ------------------------------------------------------- */

const categoryCache = new Map();   // mallId → { at, list }

/**
 * 좌측 카테고리 메뉴를 그대로 읽어 옵니다.
 * 목록을 코드에 박아두면 몰이 개편될 때 조용히 틀어지므로 매번 사이트에서 가져옵니다.
 */
export async function fetchCategories(mallId, { maxAgeMs = 10 * 60 * 1000 } = {}) {
  const mall = mallById(mallId);
  if (!mall) throw Object.assign(new Error("등록되지 않은 몰입니다."), { status: 400 });

  const cached = categoryCache.get(mallId);
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.list;

  const html = await fetchHtml(`${mall.origin}${mall.listPath}`);
  const list = [];
  const seen = new Set();
  const patterns = [
    /df-cate-no="(\d+)"[^>]*df-cate-depth="(\d+)"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/gi,
    /<a[^>]*href="[^"]*cate_no=(\d+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi,
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const no = match[1];
      const isPrimary = pattern === patterns[0];
      const label = textOf(isPrimary ? match[3] : match[2]);
      if (!label || seen.has(no)) continue;
      seen.add(no);
      list.push({ no, depth: isPrimary ? Number(match[2]) : 1, label });
    }
    if (list.length) break;
  }
  categoryCache.set(mallId, { at: Date.now(), list });
  return list;
}

/* ---------- 수집 ---------------------------------------------------------- */

/** 상세 요청은 동시 3개까지, 매 요청 사이에 간격을 둡니다. */
async function enrichDetails(mall, items, { concurrency = 3, gapMs = 150 } = {}) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      try {
        const detail = await fetchDetail(mall, item.productNo);
        item.manufacturer = detail.manufacturer;
        item.shipping = detail.shipping;
        item.sku = detail.sku;
        item.unit = detail.unit;
        item.origin = detail.origin;
        if (item.price === null) item.price = detail.price;   // 목록이 '전화문의' 였던 경우
      } catch {
        item.detailError = true;
      }
      await sleep(gapMs);
    }
  });
  await Promise.all(workers);
  return items;
}

/**
 * 카테고리 한 곳을 지정한 페이지 수만큼 수집합니다.
 * 반환 행은 ingestSupplierCatalog() 가 그대로 받는 형식입니다.
 */
export async function scrapeCategory({ mallId, categoryNo, pages = 1, detail = true, limit = 2000 }) {
  const mall = mallById(mallId);
  if (!mall) throw Object.assign(new Error("등록되지 않은 몰입니다."), { status: 400 });
  if (!categoryNo) throw Object.assign(new Error("카테고리를 선택해 주세요."), { status: 400 });

  const items = [];
  const seen = new Set();
  let pagesRead = 0;

  for (let page = 1; page <= pages && items.length < limit; page += 1) {
    const url = `${mall.origin}${mall.listPath}?cate_no=${encodeURIComponent(categoryNo)}&page=${page}`;
    const parsed = parseList(await fetchHtml(url), mall);
    if (!parsed.length) break;                       // 마지막 페이지를 넘어섰습니다
    pagesRead += 1;

    const fresh = parsed.filter((item) => !seen.has(item.productNo));
    if (!fresh.length) break;                        // 같은 페이지가 반복되면 중단합니다
    for (const item of fresh) {
      seen.add(item.productNo);
      items.push({ ...item, url: `${item.url}&cate_no=${categoryNo}` });
    }
    if (page < pages) await sleep(300);
  }

  if (detail && items.length) await enrichDetails(mall, items);

  // 가격이 없는 행도 버리지 않습니다. 견적 기반 몰은 대부분 '전화문의' 라서,
  // 그 품명·규격만 거둬도 품목 마스터를 채우는 값어치가 있습니다.
  const rows = items.map((item) => ({
    name: item.name,
    sku: item.sku || `${mall.id}-${item.productNo}`,
    manufacturer: item.manufacturer,
    unit: item.unit,
    price: item.price,
    shipping: item.shipping ?? 0,
    stock: item.soldOut ? 0 : null,
    priceBasis: mall.priceBasis,
    url: item.url,
  }));

  return {
    mall: { id: mall.id, name: mall.name },
    categoryNo: String(categoryNo),
    pagesRead,
    scanned: items.length,
    priced: rows.filter((row) => row.price !== null).length,
    noPrice: rows.filter((row) => row.price === null).length,
    detailFailed: items.filter((item) => item.detailError).length,
    rows,
  };
}

/* ---------- 공급처 연결 ---------------------------------------------------- */

/** 몰 이름으로 공급처를 찾고, 없으면 한 번만 만듭니다. */
export function supplierForMall(mall) {
  const existing = get("SELECT * FROM suppliers WHERE name = ?", mall.name);
  if (existing) return existing;
  const id = `SUP-${mall.id.toUpperCase().slice(0, 8)}`;
  run("INSERT INTO suppliers (id, name, terms, status, note) VALUES (?,?,?,'정상',?)",
    id, mall.name, "온라인 시세", `${mall.origin} — 목록 자동 수집`);
  return get("SELECT * FROM suppliers WHERE id = ?", id);
}

export function mallStatus() {
  const connector = get("SELECT * FROM connectors WHERE id = 'mall-scrape'");
  const approved = connector?.policy_status === "approved";
  return {
    enabled: Boolean(connector?.enabled),
    live: Boolean(connector?.enabled && approved),
    keyConfigured: true,                 // 인증키가 필요 없는 소스입니다
    policyStatus: connector?.policy_status || "review_required",
    sourceGrade: connector?.source_grade || "C",
    lastSyncAt: connector?.last_sync_at || null,
    malls: MALLS.map(({ id, name, origin, note }) => ({ id, name, origin, note })),
    reason: approved
      ? (connector?.enabled ? null : "설정 > 연동설정에서 온라인 자재몰 수집을 켜 주세요.")
      : "robots.txt만으로 자동수집 허용을 확정할 수 없습니다. 판매처의 서면 허용 또는 제휴 승인이 필요합니다.",
  };
}

/** 수집 후 카탈로그에 적재합니다. dryRun 이면 미리보기만 계산합니다. */
export async function syncMall({ mallId, categoryNo, pages = 1, detail = true, dryRun = false, user }) {
  const status = mallStatus();
  if (!status.live) return { ok: false, live: false, reason: status.reason };

  const mall = mallById(mallId);
  const harvest = await scrapeCategory({ mallId, categoryNo, pages, detail });
  if (!harvest.rows.length) {
    const { rows, ...rest } = harvest;
    return { ok: false, live: true, reason: "상품을 찾지 못했습니다.", ...rest };
  }

  const supplier = supplierForMall(mall);
  const category = (await fetchCategories(mallId).catch(() => []))
    .find((row) => row.no === String(categoryNo));
  const label = `${mall.name} · ${category?.label || `카테고리 ${categoryNo}`}`;

  // 가격이 있으면 판매조건까지, 없으면 품목만 — 두 경로로 나눠 넣습니다.
  const priced = harvest.rows.filter((row) => row.price !== null);
  const nameOnly = harvest.rows.filter((row) => row.price === null);

  const outcome = ingestSupplierCatalog({
    supplierId: supplier.id, rows: priced, filename: label,
    user, source: `mall:${mall.id}`, dryRun,
  });
  const catalogOutcome = nameOnly.length
    ? ingestSupplierCatalog({
      supplierId: supplier.id, rows: nameOnly, filename: `${label} (품목만)`,
      user, source: `mall:${mall.id}`, dryRun, catalogOnly: true,
    })
    : { summary: {}, preview: [] };

  for (const [key, value] of Object.entries(catalogOutcome.summary)) {
    outcome.summary[key] = (outcome.summary[key] || 0) + value;
  }
  outcome.preview = [...outcome.preview, ...catalogOutcome.preview].slice(0, 200);

  if (!dryRun) {
    run("UPDATE connectors SET last_sync_at = ?, status = '정상 동기화' WHERE id = 'mall-scrape'", nowIso());
    auditLog(user, "기준정보", "온라인 자재몰 수집",
      `${mall.name} / ${category?.label || categoryNo} / ${harvest.rows.length}건 (가격 ${priced.length})`);
  }

  return {
    ok: true,
    live: true,
    dryRun,
    mall: harvest.mall,
    category: category?.label || String(categoryNo),
    supplier: supplier.name,
    scanned: harvest.scanned,
    priced: harvest.priced,
    noPrice: harvest.noPrice,
    detailFailed: harvest.detailFailed,
    pagesRead: harvest.pagesRead,
    fetched: harvest.rows.length,
    summary: outcome.summary,
    preview: outcome.preview,
  };
}
