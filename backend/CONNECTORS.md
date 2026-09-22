# 외부 데이터 연동 규격

인증키는 **서버 프로세스 환경변수로만** 주입합니다. JSON·SQLite·프런트엔드 어디에도 저장하지 않습니다.
관리자가 **설정 > 연동설정**에서 소스를 켜기 전까지 해당 연동은 호출되지 않습니다.

---

## 1. 나라장터 입찰공고 — 구현 완료

| 항목 | 값 |
|---|---|
| 커넥터 ID | `g2b-bids` |
| 환경변수 | `G2B_SERVICE_KEY` |
| 기본 주소 | `https://apis.data.go.kr/1230000/ad/BidPublicInfoService` |
| 문서 | https://www.data.go.kr/data/15129394/openapi.do |
| 어댑터 | `backend/g2b.mjs` |

업무구분마다 오퍼레이션이 다릅니다.

| 구분 | operation |
|---|---|
| 공사 | `getBidPblancListInfoCnstwk` |
| 물품 | `getBidPblancListInfoThng` |
| 용역 | `getBidPblancListInfoServc` |
| 외자 | `getBidPblancListInfoFrgcpt` |

요청 파라미터: `serviceKey`, `pageNo`, `numOfRows`, `inqryDiv=1`(공고게시일시 기준),
`inqryBgnDt`·`inqryEndDt`(`YYYYMMDDHHMM`), `type=json`.

응답은 아래 필드로 정규화해 `bid_notices` 에 upsert 합니다.

| 정규화 컬럼 | 원본 필드 |
|---|---|
| `bid_no` / `bid_ord` | `bidNtceNo` / `bidNtceOrd` |
| `title` | `bidNtceNm` |
| `notice_inst` / `demand_inst` | `ntceInsttNm` / `dminsttNm` |
| `notice_date` / `close_date` / `open_date` | `bidNtceDt` / `bidClseDt` / `opengDt` |
| `base_amount` / `budget_amount` | `presmptPrce` / `asignBdgtAmt` |
| `region` | `prtcptPsblRgnNm` |
| `contract_method` | `cntrctCnclsMthdNm` |
| `url` | `bidNtceDtlUrl` |

**주의점**

- 포털은 Encoding / Decoding 두 가지 키를 줍니다. 이미 퍼센트 인코딩된 키를
  `URLSearchParams` 에 그대로 넣으면 이중 인코딩되어 인증에 실패합니다 — `serviceKey()` 가 처리합니다.
- 인증 실패는 JSON 이 아니라 XML 오류로 돌아옵니다. `returnAuthMsg` / `errMsg` 를 파싱해 안내합니다.
- `items` 가 배열 / `{item: [...]}` / 단건 객체로 섞여 옵니다. `extractItems()` 가 흡수합니다.
- 한 번에 최대 3개월까지만 조회합니다. 업무구분 4종은 병렬 호출 후 부분 실패를 개별 보고합니다.
- 키가 없거나 연동이 꺼져 있으면 호출하지 않고 샘플 공고로 화면이 동작합니다.

---

## 2. 자재 카탈로그 — 공급처 품목 적재 (구현 완료)

같은 물건을 업체마다 다르게 적는다는 것이 이 연동의 전제입니다.

```
"CV 2.5SQ 4C 0.6/1kV"   (전기자재24, 100m, 88,000원)  ┐
"0.6/1KV CV 4C × 2.5㎟"  (케이블마트, ROLL(100m), 86,500원)  ├─→ 제품 1행 + 업체별 가격 N행
"CV2.5SQ4C"             (검색어)                      ┘
```

`catalog.mjs` 가 제품명에서 규격을 읽어 `spec_key` 를 만들고, 키가 같으면 한 제품으로 묶습니다.
파싱이 애매하면 `confidence < 1` 로 남겨 **품목 마스터 > 규격 확인 필요** 에 모읍니다.

| 단계 | 모듈 | 하는 일 |
|---|---|---|
| 규격 파싱 · 매칭 | `catalog.mjs` | 품목 종류별 파서 → `spec_key` · 검색 점수 |
| 적재 | `ingest.mjs` | CSV/행 → 제품 매칭 또는 생성 → `supplier_products` upsert → `price_history` |
| 검색 · 비교 | `search.mjs` | 통합검색, 업체별 단가, 가격추이, 급등 감지 |

### CSV 적재

**기준정보 > 공급처 품목 등록** 에서 업체 엑셀을 CSV 로 붙여 넣습니다.
헤더는 업체마다 다르므로 흔한 표기를 넓게 받습니다 — `품명/품목명/제품명`, `단가/가격/공급가`,
`단위/판매단위`, `납기/리드타임`, `입수/환산수량` 등. **미리보기는 아무것도 쓰지 않고**
매칭 결과만 계산해 보여 줍니다(내부적으로 트랜잭션을 롤백합니다).

단위는 `ROLL(100m)`, `100m`, `박스 20개` 표기에서 환산수량을 뽑아 **1m/1개당 단가**로 비교합니다.

### 가격 이력

`supplier_products` 의 가격이 바뀔 때마다 `price_history` 에 남고,
`/api/catalog/price-alerts` 가 같은 공급처의 직전 가격 대비 상승률을 계산합니다.

### 재고에서 구매까지

사내 품목 `products.catalog_product_id`가 정규화 제품과 연결됩니다. 재고현황의 **구매** 버튼에서
업체별 조건을 비교해 선택하면 공급처·판매조건·단가가 구매요청에 보존되고, 승인 시 발주서의
기본값으로 이어집니다. 가격은 `price_basis`로 **시세(retail) / 계약(contract) / 견적(quote)** 을
구분하며, 공급처 원문 주소가 있으면 발주 전에 **상품보기**로 다시 확인할 수 있습니다.

---

## 3. 나라장터 종합쇼핑몰 품목정보 — 구현 완료

| 항목 | 값 |
|---|---|
| 커넥터 ID | `g2b-items` |
| 환경변수 | `G2B_SERVICE_KEY` (입찰공고와 같은 키) |
| 기본 주소 | `https://apis.data.go.kr/1230000/ao/ShoppingMallPrdctInfoService` |
| 문서 | https://www.data.go.kr/data/15129471/openapi.do |
| 어댑터 | `backend/g2b-shop.mjs` |

같은 물품을 여러 계약업체가 각자 단가로 등록해 두기 때문에, 우리가 원하는
**업체별 가격비교** 형태로 그대로 들어옵니다.

| 계약 유형 | operation |
|---|---|
| 다수공급자계약(MAS) | `getMASCntrctPrdctInfoList` |
| 제3자단가계약 | `getThptyUcntrctPrdctInfoList` |

계약업체는 `suppliers` 에 자동 등록되고(비고: `조달청 계약업체 — 오픈API 자동 등록`),
품목은 CSV 적재와 **같은 경로**(`ingestSupplierCatalog`)로 들어갑니다.

**주의점**

- 공공데이터포털은 서비스마다 필드명이 조금씩 다릅니다. 논리 필드 하나당 후보 이름을 여러 개 두고
  먼저 잡히는 것을 씁니다(`FIELD_CANDIDATES`).
- 매핑이 틀렸을 때를 대비해 **진단(probe)** 을 둡니다. `POST /api/catalog/g2b/probe` 가
  실제 응답의 필드명 목록과 현재 매핑 결과를 그대로 돌려주므로, 후보 이름만 고치면 됩니다.
- 한 번에 최대 50페이지(100건씩)까지만 받습니다.
- **이 어댑터는 공식 오픈API 만 호출합니다. 쇼핑몰 화면을 긁지 않습니다.**

---

## 4. 계약 공급처 REST API — 구현 완료

| 항목 | 값 |
|---|---|
| 커넥터 ID | `supplier-rest` |
| 환경변수 | `SUPPLIER_API_TOKEN`, `SUPPLIER_API_BASE_URL`, `SUPPLIER_API_NAME` |
| 인증 | `Authorization: Bearer <token>` |
| 어댑터 | `backend/supplier-rest.mjs` |

공급처 API는 JSON 배열 또는 `{ items: [] }`, `{ data: [] }`, `{ products: [] }` 응답을 받습니다.
품명·단가·단위·재고 등 흔히 쓰는 여러 필드명을 공통 행으로 정규화하며, 응답 행에 공급처명이
없으면 `SUPPLIER_API_NAME`을 사용합니다. API 주소는 서버에서 외부로 요청하므로 **HTTPS만 허용**합니다.

**기준정보 > 공급처 품목 등록** 상단에서 검색어를 입력하고 동기화하면 공급처가 자동 등록되고,
계약단가(`price_basis=contract`)로 카탈로그·가격이력에 들어갑니다.

## 5. 온라인 자재몰 목록 수집 — 구현 완료

| 항목 | 값 |
|---|---|
| 커넥터 ID | `mall-scrape` |
| 환경변수 | 없음 (인증키 불필요) |
| 어댑터 | `backend/mall-scrape.mjs` |
| 첫 대상 | 자재코리아 `https://jajekorea.com` |

국내 자재몰 상당수가 Cafe24 위에 올라가 있습니다. 스킨은 업체마다 달라도 상품 한 칸은
언제나 `<li id="anchorBoxId_{번호}">` 로 시작하므로, 이 앵커로 쪼갠 뒤 이름·가격을 후보
패턴으로 차례로 훑습니다. 몰을 추가할 때는 `MALLS` 에 주소 한 줄만 넣으면 됩니다.

카테고리 목록은 코드에 박지 않고 **매번 사이트의 좌측 메뉴에서 읽어 옵니다**(10분 캐시).
몰이 개편해도 조용히 틀어지지 않게 하기 위해서입니다.

**robots.txt 를 지킵니다.** 자재코리아가 막는 경로는 `/admin`, `/api`, `/exec/front/`,
`/member/`, `/myshop/` 이고 `/product/` 는 열려 있습니다. 상세 요청은 동시 3개·150ms 간격,
목록은 페이지 사이 300ms 를 둡니다.

### 이 몰은 가격을 거의 공개하지 않습니다

16개 카테고리를 전수 확인한 결과입니다.

| 카테고리 | 1페이지 상품 | 가격 공개 |
|---|---|---|
| 2.전선.전기자재 | 48 | 1 |
| 11.설비.배관자재 | 48 | 5 |
| 10.청소.계절용품.건자재 | 48 | 2 |
| 나머지 13개 | 각 48 이하 | 0~1 |

대부분 `전화문의` 입니다. 견적 기반 B2B 몰이라 그렇습니다. 그래서 이 커넥터는
**가격 소스가 아니라 품목·규격 소스**로 씁니다.

- 가격이 있는 행 → 기존 경로대로 `supplier_products` + `price_history` 까지
- 가격이 없는 행 → `ingestSupplierCatalog({ catalogOnly: true })` 로 **품목만** 생성

`catalogOnly` 는 CSV 적재에도 열려 있습니다(**기준정보 > 공급처 품목 등록**의
`단가 없이 품목만 등록`). 단가 열이 없는 품목 목록을 그대로 올릴 수 있습니다.

상세 페이지는 **제조사·배송비·상품코드**를 채우고, 목록에서 `전화문의` 였던 가격을
되살리기도 합니다(5.기계.전동공구에서 0건 → 18건).

---

## 6. 네이버 쇼핑 검색 — 구현 완료

| 항목 | 값 |
|---|---|
| 커넥터 ID | `naver-shop` |
| 환경변수 | `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET` |
| 기본 주소 | `https://openapi.naver.com/v1/search/shop.json` |
| 발급 | https://developers.naver.com/apps/#/register → '검색' API |
| 어댑터 | `backend/naver-shop.mjs` |

**이 연동이 가격비교의 중심입니다.** 응답 항목마다 `mallName` 이 붙어 오기 때문에,
검색 한 번이면 같은 자재를 파는 쇼핑몰 수십 곳의 가격이 몰별로 쪼개져 들어옵니다.
몰 하나가 공급처 하나가 되므로, 그 자체로 업체별 가격비교가 성립합니다.

| 정규화 | 원본 필드 |
|---|---|
| 공급처 | `mallName` |
| 품명 | `title` (`<b>` 강조 태그 제거) |
| 단가 | `lprice` |
| 제조사 | `maker` → `brand` |
| 품번 | `productId` |
| 상품주소 | `link` |

한 번에 `display` 최대 100건, `start` 는 1000 까지입니다.

> 이전 판 문서에 "네이버 쇼핑 API 는 2026-07-31 종료" 라고 적혀 있었으나,
> 2026-09-22 확인 결과 엔드포인트는 그대로 응답합니다(키 없이 호출하면
> `401 / errorCode 024 Not Exist Client ID`). 종료를 전제로 배제하지 않습니다.

---

## 7. 쿠팡 파트너스 — 구현 완료(키 미검증)

| 항목 | 값 |
|---|---|
| 커넥터 ID | `coupang-partners` |
| 환경변수 | `COUPANG_ACCESS_KEY`, `COUPANG_SECRET_KEY` |
| 기본 주소 | `https://api-gateway.coupang.com` |
| 발급 | https://partners.coupang.com (제휴 승인 필요) |
| 어댑터 | `backend/coupang-partners.mjs` |

쿠팡 화면은 Cloudflare 가 막습니다 — `robots.txt` 조차 403 입니다. 크롤링하지 않고
공식 제휴 API 만 씁니다.

서명(CEA HMAC):

```
signed-date = yyMMddTHHmmssZ (GMT)
message     = signed-date + METHOD + path + query      ('?' 제외)
signature   = hex( HMAC-SHA256(secretKey, message) )
Authorization: CEA algorithm=HmacSHA256, access-key=..., signed-date=..., signature=...
```

---

## 8. 알리익스프레스 오픈API — 구현 완료(키 미검증)

| 항목 | 값 |
|---|---|
| 커넥터 ID | `ali-open` |
| 환경변수 | `ALI_APP_KEY`, `ALI_APP_SECRET`, `ALI_TRACKING_ID` |
| 기본 주소 | `https://api-sg.aliexpress.com/sync` |
| 오퍼레이션 | `aliexpress.affiliate.product.query` |
| 어댑터 | `backend/ali-open.mjs` |

`robots.txt` 가 `/wholesale*`, `/item/*`, `/product/*` 를 **명시적으로 막습니다.**
화면을 긁지 않고 공식 오픈 플랫폼만 씁니다.

서명(TOP 시스템 게이트웨이): `sign` 을 뺀 파라미터를 키 이름순으로 정렬해
`k1v1k2v2...` 로 이어 붙인 뒤 `HMAC-SHA256(app_secret, …)` 를 대문자 hex 로.

`target_currency=KRW` 로 요청하되, 응답 통화가 KRW 가 아닌 행은 **버립니다.**
환산 없이 원화 단가와 섞이면 비교가 어긋나기 때문입니다. 관세·배송기간은 별도 확인해야
하므로 공급처 비고에 남깁니다.

> 7·8번은 키가 없어 실제 응답으로 검증하지 못했습니다. `g2b-shop.mjs` 와 같은 방식으로
> **진단(probe)** 을 두었습니다 — `POST /api/catalog/coupang/probe`,
> `POST /api/catalog/ali/probe` 가 실제 응답의 필드명과 현재 매핑 결과를 그대로
> 돌려주므로, 필드명이 다르면 각 어댑터의 `FIELDS` 만 고치면 됩니다.

---

## 9. LS ELECTRIC — 자동 수집 불가 (조사 결과)

| 항목 | 값 |
|---|---|
| 주소 | `https://www.ls-electric.com` |
| robots.txt | `Allow: /` — 크롤링 자체는 허용 |

그런데 **쓸 수 없습니다.**

- 제품 페이지(`/ko/product/main/power`)에 `원` 표기가 **0건** — 제조사 사이트라 사양만 싣고
  가격은 대리점가입니다.
- 사이트 전체가 클라이언트 렌더링입니다. `/ko/sitemap` 을 받아도 HTML 안의 링크가 9개뿐이고
  제품 목록이 들어 있지 않습니다. 공개 API 도 없습니다.

**대안** — LS 공식 대리점 가격표(엑셀/PDF)를 **기준정보 > 공급처 품목 등록**의 CSV 경로로
넣습니다. 이미 있는 경로이고, 계약단가로 들어가므로 온라인 시세와 `price_basis` 로 구분됩니다.

---

## 10. 추가 연동 후보


| 커넥터 | 용도 | 환경변수 |
|---|---|---|
| `g2b-prices` | 나라장터 가격정보 (전기·정보통신 시설자재 기준가격) | `G2B_SERVICE_KEY` |
| `supplier-csv` | 공급처 CSV/SFTP 정기 가격표 적재 | `SUPPLIER_SFTP_PASSWORD` |
| `manufacturer-catalog` | 제조사 규격 카탈로그 정규화 | — |

어댑터는 `ingestSupplierCatalog({ supplierId, rows, source })` 로 행을 넘기기만 하면 됩니다.
행 형식은 `{ name, sku, manufacturer, category, unit, unitQty, price, shipping, moq, lead, stock }`.

### 안전 원칙

- 가격과 재고에는 **조회 시각과 출처** 를 반드시 함께 보존합니다 (`quoted_at` · `source`).
- 구매 확정 전 공급처 원문을 다시 검증합니다.
- 수집 경로는 **robots.txt 가 정합니다.** 사이트가 해당 경로를 막지 않으면 목록을 읽되
  요청 간격을 두고, 막거나 봇을 차단하면(네이버·쿠팡·알리) **공식 API 로만** 갑니다.
  우회 시도는 하지 않습니다.
- 규격 파싱 결과에는 confidence 를 저장하고, 애매한 매칭은 자동 구매 대상으로 확정하지 않습니다.
- **연결 확인** 버튼은 설정값의 유무만 검사합니다. 실제 동기화는 공급처별 요청/응답 규격이
  확정된 뒤 어댑터에 연결합니다.

### 소스별 가격 성격

같은 화면에 섞어 놓아도 성격이 달라서, `price_basis` 로 항상 구분합니다.

| 소스 | price_basis | 주의 |
|---|---|---|
| 자재몰 수집 · 네이버 · 쿠팡 · 알리 | `retail` | 시세. 발주 전 원문 재확인 |
| 나라장터 · 계약 공급처 | `contract` | 계약단가 |
| 수기 입력 | `quote` | 견적 |

알리는 관세·통관·납기가 단가에 안 잡히므로, 최저가로 뽑혀도 그대로 발주 대상이 되지
않도록 공급처 비고에 표시합니다.
