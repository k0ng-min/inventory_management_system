/**
 * 나라장터(조달청) 입찰공고정보서비스 어댑터.
 *
 * 공공데이터포털 인증키(G2B_SERVICE_KEY)가 환경변수에 있으면 실제 API를 호출하고,
 * 없으면 DB에 시드된 샘플 공고로 화면이 그대로 동작합니다.
 * 참고: https://www.data.go.kr/data/15129394/openapi.do
 */

import "./env.mjs";
import { all, get, run, nowIso, auditLog } from "./db.mjs";

const DEFAULT_BASE_URL = "https://apis.data.go.kr/1230000/ad/BidPublicInfoService";

/** 업무구분별 오퍼레이션. 나라장터는 업무 유형마다 엔드포인트가 다릅니다. */
export const BID_KINDS = [
  { key: "공사", operation: "getBidPblancListInfoCnstwk" },
  { key: "물품", operation: "getBidPblancListInfoThng" },
  { key: "용역", operation: "getBidPblancListInfoServc" },
  { key: "외자", operation: "getBidPblancListInfoFrgcpt" },
];

export function serviceKey() {
  const raw = process.env.G2B_SERVICE_KEY;
  if (!raw) return null;
  // 포털은 Encoding/Decoding 두 가지 키를 주는데, 이미 퍼센트 인코딩된 키를
  // URLSearchParams 에 그대로 넣으면 이중 인코딩되어 인증에 실패합니다.
  try {
    const decoded = decodeURIComponent(raw);
    return decoded.includes("%") ? raw : decoded;
  } catch {
    return raw;
  }
}

export function connectorConfig() {
  return get("SELECT * FROM connectors WHERE id = 'g2b-bids'");
}

export function bidStatus() {
  const connector = connectorConfig();
  const key = serviceKey();
  return {
    enabled: Boolean(connector?.enabled),
    keyConfigured: Boolean(key),
    live: Boolean(connector?.enabled && key),
    baseUrl: connector?.base_url || DEFAULT_BASE_URL,
    lastSyncAt: connector?.last_sync_at || null,
    reason: !connector?.enabled
      ? "관리자 센터 > 연동설정에서 '나라장터 입찰공고'를 켜 주세요."
      : !key
        ? "G2B_SERVICE_KEY 환경변수가 설정되지 않아 샘플 공고를 표시합니다."
        : null,
  };
}

const pad = (value) => String(value).padStart(2, "0");
/** 나라장터는 조회기간을 YYYYMMDDHHMM 으로 받습니다. */
const stamp = (date, end) =>
  `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${end ? "2359" : "0000"}`;

/** "20260921090000" / "2026-09-21 09:00" 등 섞여 오는 값을 "YYYY-MM-DD HH:mm" 으로 통일합니다. */
function normalizeDate(value) {
  if (!value) return null;
  const digits = String(value).replace(/\D/g, "");
  if (digits.length < 8) return null;
  const date = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  if (digits.length < 12) return `${date} 00:00`;
  return `${date} ${digits.slice(8, 10)}:${digits.slice(10, 12)}`;
}

const toInt = (value) => {
  const n = Number(String(value ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? Math.round(n) : 0;
};

function normalizeNotice(item, kind) {
  const bidNo = item.bidNtceNo || item.bidNtceNo1 || "";
  const bidOrd = item.bidNtceOrd || "00";
  return {
    id: `G2B-${bidNo}-${bidOrd}`,
    source: "g2b",
    bid_no: bidNo,
    bid_ord: bidOrd,
    title: item.bidNtceNm || "(공고명 없음)",
    kind,
    notice_inst: item.ntceInsttNm || "",
    demand_inst: item.dminsttNm || "",
    notice_date: normalizeDate(item.bidNtceDt || item.rgstDt),
    close_date: normalizeDate(item.bidClseDt),
    open_date: normalizeDate(item.opengDt),
    base_amount: toInt(item.presmptPrce || item.bssamt),
    budget_amount: toInt(item.asignBdgtAmt),
    region: item.prtcptPsblRgnNm || item.rgnLmtBidLocplcJdgmBssNm || "전국",
    contract_method: item.cntrctCnclsMthdNm || item.bidMethdNm || "",
    url: item.bidNtceDtlUrl || item.bidNtceUrl || "https://www.g2b.go.kr/",
  };
}

/** API 응답에서 항목 배열을 꺼냅니다. items 가 배열/객체/단건 모두로 올 수 있습니다. */
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

async function fetchKind({ operation, kind, beginDate, endDate, key, baseUrl, rows }) {
  const params = new URLSearchParams({
    serviceKey: key,
    pageNo: "1",
    numOfRows: String(rows),
    inqryDiv: "1", // 1 = 공고게시일시 기준
    inqryBgnDt: stamp(beginDate, false),
    inqryEndDt: stamp(endDate, true),
    type: "json",
  });
  const url = `${baseUrl.replace(/\/$/, "")}/${operation}?${params}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status} — ${text.slice(0, 160)}`);

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      // 인증 실패 등은 XML 에러로 돌아옵니다.
      const message = /<returnAuthMsg>(.*?)<\/returnAuthMsg>/.exec(text)?.[1]
        || /<errMsg>(.*?)<\/errMsg>/.exec(text)?.[1]
        || text.slice(0, 160);
      throw new Error(`나라장터 응답 오류: ${message}`);
    }

    const header = payload?.response?.header;
    if (header && header.resultCode && header.resultCode !== "00") {
      throw new Error(`나라장터 오류 ${header.resultCode}: ${header.resultMsg || ""}`);
    }
    return extractItems(payload).map((item) => normalizeNotice(item, kind));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 지정 기간의 입찰공고를 나라장터에서 내려받아 bid_notices 에 upsert 합니다.
 * 키가 없거나 연동이 꺼져 있으면 호출하지 않고 이유를 반환합니다.
 */
export async function syncBidNotices({ from, to, kinds, user, rows = 100 }) {
  const status = bidStatus();
  if (!status.live) {
    return { ok: false, live: false, reason: status.reason, imported: 0 };
  }

  const beginDate = new Date(`${from}T00:00:00+09:00`);
  const endDate = new Date(`${to}T00:00:00+09:00`);
  if (Number.isNaN(beginDate.getTime()) || Number.isNaN(endDate.getTime())) {
    throw new Error("조회 기간이 올바르지 않습니다.");
  }
  if (endDate < beginDate) throw new Error("종료일이 시작일보다 빠릅니다.");
  if ((endDate - beginDate) / 86400000 > 92) throw new Error("한 번에 최대 3개월까지 조회할 수 있습니다.");

  const selected = BID_KINDS.filter((item) => !kinds?.length || kinds.includes(item.key));
  const key = serviceKey();
  const baseUrl = status.baseUrl;
  const errors = [];
  let imported = 0;

  const results = await Promise.allSettled(selected.map((item) =>
    fetchKind({ operation: item.operation, kind: item.key, beginDate, endDate, key, baseUrl, rows })));

  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      errors.push(`${selected[index].key}: ${result.reason?.message || result.reason}`);
      continue;
    }
    for (const notice of result.value) {
      if (!notice.bid_no) continue;
      run(`INSERT INTO bid_notices
            (id, source, bid_no, bid_ord, title, kind, notice_inst, demand_inst, notice_date, close_date, open_date,
             base_amount, budget_amount, region, contract_method, url, fetched_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title, notice_inst = excluded.notice_inst, demand_inst = excluded.demand_inst,
             notice_date = excluded.notice_date, close_date = excluded.close_date, open_date = excluded.open_date,
             base_amount = excluded.base_amount, budget_amount = excluded.budget_amount,
             region = excluded.region, contract_method = excluded.contract_method,
             url = excluded.url, fetched_at = excluded.fetched_at`,
        notice.id, notice.source, notice.bid_no, notice.bid_ord, notice.title, notice.kind,
        notice.notice_inst, notice.demand_inst, notice.notice_date, notice.close_date, notice.open_date,
        notice.base_amount, notice.budget_amount, notice.region, notice.contract_method, notice.url, nowIso());
      imported += 1;
    }
  }

  run("UPDATE connectors SET last_sync_at = ?, status = ? WHERE id = 'g2b-bids'",
    nowIso(), errors.length ? "일부 오류" : "정상 동기화");
  auditLog(user, "입찰", "나라장터 동기화", `${from}~${to} / ${imported}건${errors.length ? ` / 오류 ${errors.length}건` : ""}`);

  return { ok: errors.length === 0, live: true, imported, errors, syncedAt: nowIso() };
}

/* ------------------------------------------------------------------ */
/* 조회 — 화면에서 쓰는 읽기 함수들                                     */
/* ------------------------------------------------------------------ */

/** 날짜 범위 + 필터로 공고 목록을 반환합니다. dateField 는 공고일/마감일 기준 전환용. */
export function listBidNotices({ from, to, kinds, keyword, region, starred, dateField = "notice_date" }) {
  const column = dateField === "close_date" ? "close_date" : "notice_date";
  const where = [`${column} IS NOT NULL`, `date(substr(${column},1,10)) BETWEEN date(?) AND date(?)`];
  const params = [from, to];

  if (kinds?.length) {
    where.push(`kind IN (${kinds.map(() => "?").join(",")})`);
    params.push(...kinds);
  }
  if (keyword?.trim()) {
    where.push("(title LIKE ? OR notice_inst LIKE ? OR demand_inst LIKE ?)");
    const like = `%${keyword.trim()}%`;
    params.push(like, like, like);
  }
  if (region?.trim()) {
    where.push("region LIKE ?");
    params.push(`%${region.trim()}%`);
  }
  if (starred) where.push("starred = 1");

  return all(
    `SELECT * FROM bid_notices WHERE ${where.join(" AND ")} ORDER BY ${column} ASC, base_amount DESC LIMIT 500`,
    ...params,
  );
}

/** 달력 렌더용 — 날짜별 건수/금액 집계. */
export function bidCalendar({ from, to, kinds, dateField = "notice_date" }) {
  const notices = listBidNotices({ from, to, kinds, dateField });
  const byDate = new Map();
  for (const notice of notices) {
    const day = (dateField === "close_date" ? notice.close_date : notice.notice_date).slice(0, 10);
    if (!byDate.has(day)) byDate.set(day, { date: day, count: 0, amount: 0, kinds: {}, items: [] });
    const bucket = byDate.get(day);
    bucket.count += 1;
    bucket.amount += notice.base_amount;
    bucket.kinds[notice.kind] = (bucket.kinds[notice.kind] || 0) + 1;
    if (bucket.items.length < 8) bucket.items.push({ id: notice.id, title: notice.title, kind: notice.kind, amount: notice.base_amount });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function toggleStar(id, starred, user) {
  const notice = get("SELECT * FROM bid_notices WHERE id = ?", id);
  if (!notice) throw new Error("공고를 찾을 수 없습니다.");
  run("UPDATE bid_notices SET starred = ? WHERE id = ?", starred ? 1 : 0, id);
  auditLog(user, "입찰", starred ? "관심공고 등록" : "관심공고 해제", notice.title);
  return get("SELECT * FROM bid_notices WHERE id = ?", id);
}

export function saveMemo(id, memo, user) {
  run("UPDATE bid_notices SET memo = ? WHERE id = ?", memo || null, id);
  auditLog(user, "입찰", "공고 메모 수정", id);
  return get("SELECT * FROM bid_notices WHERE id = ?", id);
}
