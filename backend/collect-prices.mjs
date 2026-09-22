/* ==========================================================================
   collect-prices.mjs — 가격비교 사이트에서 판매가 수집 (별도 실행 도구)

   서버 본체는 외부 의존성이 0개입니다. 그 원칙을 깨지 않으려고 이 수집기만
   따로 떼어 놓았습니다. 서버는 이 파일을 부르지 않습니다 — 사람이 필요할 때
   직접 돌리고, 결과는 평소 쓰는 적재 경로로 들어갑니다.

     node backend/collect-prices.mjs --limit 30
     node backend/collect-prices.mjs --category breaker --csv out.csv

   왜 브라우저가 필요한가 —

     쿠팡        robots.txt 조회부터 Access Denied. 수집 대상이 아닙니다.
     네이버쇼핑   robots.txt 가 Disallow: / 이고 검색 API 도 2026-07-31 종료.
     다나와·에누리 robots.txt 가 검색·상품 페이지를 **허용**합니다. 그리고 이
                 두 곳이 쿠팡·11번가·G마켓·옥션 가격을 한 자리에 모읍니다.
                 다만 목록을 자바스크립트로 그려서 순수 fetch 로는 안 잡힙니다.

   그래서 허용된 페이지를 **브라우저로 열어** 읽습니다. 막아 둔 곳을 우회하는
   것이 아니라, 열어 둔 곳을 사람이 보는 그대로 읽는 것입니다.

   브라우저(playwright 또는 patchright)가 없으면 무엇을 설치해야 하는지 알리고
   끝냅니다. 조용히 실패하지 않습니다.
   ========================================================================== */

import { writeFileSync } from "node:fs";

import { all, get } from "./db.mjs";
import { parseSpec, specKey } from "./catalog.mjs";

const args = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const LIMIT = Math.max(1, Math.min(200, Number(argOf("limit", 20)) || 20));
const CATEGORY = argOf("category", "");
const CSV_OUT = argOf("csv", "");
const BASE_URL = argOf("server", "http://127.0.0.1:4173");
const DELAY_MS = Math.max(800, Number(argOf("delay", 1500)) || 1500);

/* ---------- 브라우저 찾기 -------------------------------------------------- */

/**
 * playwright / patchright 중 있는 것을 씁니다.
 * 둘 다 없으면 설치 안내를 내고 멈춥니다 — 서버 본체에는 넣지 않습니다.
 */
async function openBrowser() {
  for (const name of ["patchright", "playwright", "playwright-core"]) {
    try {
      const mod = await import(name);
      const chromium = mod.chromium || mod.default?.chromium;
      if (!chromium) continue;
      const browser = await chromium.launch({ headless: true });
      return { browser, driver: name };
    } catch { /* 다음 후보 */ }
  }
  return null;
}

/* ---------- 수집 ---------------------------------------------------------- */

/** 가격이 아직 없는 제품을 고릅니다. 이미 있는 것을 또 훑으면 시간만 씁니다. */
function targets() {
  const clauses = ["c.active = 1", "(SELECT COUNT(*) FROM supplier_products WHERE product_id = c.id AND active = 1) = 0"];
  const params = [];
  if (CATEGORY) { clauses.push("c.category = ?"); params.push(CATEGORY); }
  return all(`
    SELECT c.id, c.name, c.category, c.spec_label, c.base_unit
    FROM catalog_products c WHERE ${clauses.join(" AND ")}
    ORDER BY c.category, c.name LIMIT ?`, ...params, LIMIT);
}

/** 카탈로그 이름을 쇼핑몰에서 쓰는 말에 가깝게 다듬습니다. */
const termFor = (product) => String(product.spec_label || product.name || "")
  .replace(/0\.6\/1KV|450\/750V|300\/300V|300\/500V/gi, "")
  .replace(/\s+/g, " ")
  .trim();

/**
 * 에누리 검색 결과에서 상품명·가격·판매처를 읽습니다.
 * 선택자가 바뀔 수 있으므로 여러 후보를 두고 먼저 잡히는 것을 씁니다.
 */
async function searchEnuri(page, term) {
  await page.goto(`https://www.enuri.com/search.jsp?keyword=${encodeURIComponent(term)}`,
    { waitUntil: "domcontentloaded", timeout: 40000 });
  await page.waitForTimeout(3000);

  // 첫 화면에는 제휴 영역(쿠팡)만 뜹니다. 아래로 내려야 11번가·G마켓·옥션까지
  // 지연 로딩됩니다. 내리지 않으면 한 몰만 긁고 비교가 되지 않습니다.
  for (let step = 0; step < 6; step += 1) {
    await page.mouse.wheel(0, 1400);
    await page.waitForTimeout(700);
  }

  return page.evaluate(() => {
    const out = [];
    const blocks = document.querySelectorAll("li[class*='item'], .prodItem, .item_box, li[data-goodsno]");
    for (const block of blocks) {
      const text = (block.innerText || "").trim();
      if (!text || text.length < 8) continue;
      const priceMatch = text.match(/([0-9]{1,3}(?:,[0-9]{3})+)\s*원/);
      if (!priceMatch) continue;
      const name = text.split("\n").map((line) => line.trim())
        .find((line) => line.length > 6 && !/원$/.test(line));
      if (!name) continue;
      const alt = [...block.querySelectorAll("img[alt]")]
        .map((image) => image.getAttribute("alt") || "")
        .find((value) => /로고/.test(value)) || "";
      const mall = alt.replace(/\s*로고\s*/, "").trim();
      out.push({ name: name.slice(0, 120), price: Number(priceMatch[1].replace(/,/g, "")), mall: mall || "에누리" });
      if (out.length >= 30) break;
    }
    return out;
  });
}

/** 수집한 이름이 정말 그 규격인지 확인합니다. 아니면 버립니다. */
function matchesSpec(product, rawName) {
  const parsed = parseSpec(rawName, product.category);
  if (parsed.confidence < 1) return false;
  return specKey(parsed.category, parsed.specs) === get(
    "SELECT spec_key FROM catalog_products WHERE id = ?", product.id)?.spec_key;
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/* ---------- 실행 ---------------------------------------------------------- */

async function main() {
  const list = targets();
  if (!list.length) {
    console.log("가격이 비어 있는 제품이 없습니다. 먼저 '자재 채우기'로 표준 규격을 넣어 주세요.");
    return;
  }

  const opened = await openBrowser();
  if (!opened) {
    console.log([
      "브라우저를 찾지 못했습니다.",
      "",
      "다나와·에누리는 robots.txt 가 수집을 허용하지만 목록을 자바스크립트로 그립니다.",
      "그래서 이 수집기만 브라우저가 필요합니다(서버 본체는 그대로 의존성 0개입니다).",
      "",
      "  npm i -D playwright && npx playwright install chromium",
      "",
      "설치 뒤 다시 실행해 주세요:  node backend/collect-prices.mjs --limit 30",
    ].join("\n"));
    process.exitCode = 1;
    return;
  }

  console.log(`${opened.driver} 로 ${list.length}개 제품을 찾습니다. (요청 간격 ${DELAY_MS}ms)`);
  const page = await opened.browser.newPage();
  const rows = [];

  for (const product of list) {
    const term = termFor(product);
    if (!term) continue;
    try {
      const found = await searchEnuri(page, term);
      const kept = found.filter((item) => matchesSpec(product, item.name));
      for (const item of kept) {
        rows.push({
          productId: product.id, product: product.name, term,
          mall: item.mall, rawName: item.name, price: item.price, unit: product.base_unit,
        });
      }
      console.log(`  ${product.name.padEnd(28)} 검색 ${found.length} · 규격 일치 ${kept.length}`);
    } catch (error) {
      console.log(`  ${product.name.padEnd(28)} 실패: ${String(error.message || error).slice(0, 60)}`);
    }
    await sleep(DELAY_MS);
  }

  await opened.browser.close();

  if (!rows.length) {
    console.log("\n규격이 일치하는 판매 상품을 찾지 못했습니다. 검색어를 바꿔 보거나 범위를 넓혀 주세요.");
    return;
  }

  // 판매처(몰)별로 묶어 평소 쓰는 CSV 형식으로 냅니다.
  const byMall = new Map();
  for (const row of rows) {
    if (!byMall.has(row.mall)) byMall.set(row.mall, []);
    byMall.get(row.mall).push(row);
  }

  const csv = ["판매처,품명,단위,단가"];
  for (const [mall, items] of byMall) {
    for (const item of items) csv.push([mall, item.rawName, item.unit, item.price].map(csvCell).join(","));
  }
  const text = csv.join("\n");

  const outPath = CSV_OUT || "backend/collected-prices.csv";
  writeFileSync(outPath, `﻿${text}`, "utf8");
  console.log(`\n${rows.length}건을 ${outPath} 에 저장했습니다. 판매처 ${byMall.size}곳.`);
  console.log("자재 > 자재 채우기 화면에서 판매처별로 나눠 올리면 가격비교에 바로 들어갑니다.");
  console.log(`(서버 주소는 ${BASE_URL} 로 잡혀 있습니다.)`);
}

const csvCell = (value) => {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

main().catch((error) => {
  console.error("수집 중 오류:", error);
  process.exitCode = 1;
});
