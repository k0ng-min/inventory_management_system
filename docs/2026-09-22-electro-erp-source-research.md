# ELECTRO ERP 전기자재 데이터 소스 조사 보고서

- 조사 기준일: 2026-09-22 (Asia/Seoul)
- 범위: Phase 1 — 기존 프로젝트 분석, 제조사/판매처 후보, API·파일·공개페이지·robots.txt·약관 확인
- 원칙: 확인하지 못한 항목은 `확인 필요`로 표기한다. 공개 페이지의 존재를 자동수집 허용으로 해석하지 않는다.
- 상태: 이 문서는 구현 전 의사결정 문서다. 이 조사 단계에서는 기능 코드를 변경하지 않았다.

## 1. 결론

1. **제품 Master의 첫 연동 소스는 공식 데이터만 사용한다.**
   - LS ELECTRIC: 공식 제품 페이지·Product Finder·카탈로그를 이용한 **승인된 파일/수동 적재 경로(B)**부터 시작한다.
   - Schneider Electric: 공식 Product Catalog API는 존재하지만 한국은 공개 지원 국가 목록에 없으므로 **한국 법인/담당자와 API 온보딩 후(D→A)** 사용한다.
   - LS전선·대한전선: 공식 카탈로그 PDF와 제품 페이지를 **출처 보존형 파일 적재(B)**로 사용하되, 대량 추출·재배포 권한은 사전 확인한다.
2. **가격 소스의 첫 운영 연동은 조달청 나라장터 쇼핑몰 품목정보 OpenAPI(A)**가 가장 안전하다. 단, 조달계약 가격은 일반 민간 구매가와 성격이 다르므로 `price_basis=public_contract`로 분리한다.
3. **2SK, 구매솔루션 EOS, 전자단가 시스템, 자재코리아는 공개 가격/규격을 확인했지만 자동수집 허용은 확인하지 못했다.** 현재 등급은 모두 C이며, 서면 제휴/API/CSV 제공 여부를 먼저 문의한다. 허가 전 Production 크롤러는 실행하지 않는다.
4. **네이버 쇼핑 검색 API는 제거 대상(E)**이다. 네이버 공식 공지상 2026-07-31 종료됐고 별도 대체 API도 제공되지 않는다.
5. 기존 시스템의 `catalog_products → supplier_products → price_history → 구매요청 → 발주 → 입고 → 재고` 흐름은 재사용 가치가 높다. 다만 새 요구사항을 충족하려면 마스터 필드, 매칭 검수, 동적 필터, 소스 상태 및 관리자 덮어쓰기 보호를 확장해야 한다.
6. 기존 `mall-scrape`는 자재코리아 HTML 구조에 결합되어 있고 기본 활성화되어 있다. 정책 확인 전에는 **비활성화/보류**가 맞다.

## 2. 현재 프로젝트 분석

### 2.1 기술 및 기능 현황

| 영역 | 현재 구현 | 판정 |
|---|---|---|
| 기술 | Node.js 22 내장 모듈, `node:sqlite`, Vanilla JS, 외부 런타임 의존성 없음 | 유지 |
| DB | SQLite, 코드상 30개 테이블 | 유지·마이그레이션 확장 |
| API | 정적 경로 기준 74개 이상, 인증/재고/구매/카탈로그/연동/입찰 포함 | 유지·버전 호환 |
| UI | 화면 등록 41개, 구매 통합검색·비교·공급처 적재·연동상태 화면 존재 | 자재 Catalog 중심으로 재구성 |
| 인증 | 메모리 세션, scrypt 비밀번호, `admin/purchasing/warehouse/viewer` | 유지, 관리자 검수 권한 세분화 검토 |
| 권한 | 관리자·구매·창고·조회 역할, 서버 측 검사 | 유지·보완 |
| 구매 | 구매요청 → 승인 → 다품목 발주 → 부분입고 | 적극 재사용 |
| 재고 | 입고/이동/조정/공사배정/출고가 단일 `moveStock()` 경로로 원장 기록 | 적극 재사용 |
| 감사 | `audit_logs` 존재 | 관리자 수동수정/매칭 승인 이력에 확장 |
| 테스트 | `npm run check` 통과(2026-09-22) | 유지 |

### 2.2 이미 요구사항과 맞는 구조

```text
catalog_products              supplier_products              price_history
(현재 Product Master 역할)  1 ─────────────── N  (판매상품)  1 ───── N (가격이력)
        │
        └─ products.catalog_product_id
                  │
                  └─ 구매요청 → 발주서/발주줄 → 입고 → inventory_balances/transactions
```

- `catalog_products`와 `supplier_products`가 이미 분리돼 있다.
- 공급처별 판매단위, 환산수량, 가격, 배송비, MOQ, 납기, 재고, 상품 URL을 저장한다.
- 가격 변경 시 `price_history`에 추가한다.
- 사내 재고 품목 `products`는 `catalog_product_id`로 마스터와 연결된다.
- 선택한 공급처 판매상품과 단가가 구매요청/발주줄로 이어지고, 입고 완료 시 기존 재고가 증가한다.
- 카테고리별 규격 파서와 비교 화면이 이미 있다.

### 2.3 요구사항 대비 핵심 Gap

| 요구사항 | 현재 상태 | 필요한 조치 |
|---|---|---|
| Product Master 필드 | `category/name/specs/manufacturer/certification` 중심 | brand, subcategory, series, model, product_code, normalized_name, 이미지/공식URL/datasheet/catalog, source 시각, status 추가 |
| Supplier Product 필드 | 핵심 가격 필드는 일부 존재 | external_product_id, normalized_title, raw/parsed specification, VAT, original_price, stock_status, 문자열 lead_time, image_url, last_checked_at, match_confidence 추가 |
| 동일상품 매칭 우선순위 | `spec_key`가 같으면 즉시 병합 | 제품코드→모델→제조사+모델→핵심규격→이름 순 점수화, 임계값 미만 검수큐 |
| 제조사 분리 | 판매처 적재가 새 마스터를 직접 생성 가능 | 제조사 원본/staging과 승인된 Master 분리, 판매처만으로 자동 확정 금지 |
| 카테고리 트리 | 9개 평면 분류 | parent/child 트리 + 제조사 분류 매핑 |
| Dynamic Filter | 카테고리 정의는 있으나 검색 UI 필터가 제한적 | category schema에서 필터 정의/값/단위/정렬 생성 |
| 상세페이지 | 패널 형태 비교 중심 | 공식 규격·인증·문서·이미지 + 가격비교 전용 상세페이지 |
| 가격 신선도 | `quoted_at` 중심 | `last_checked_at`, stale 정책, 사용자 경고, 백그라운드 갱신 |
| 가격 이력 | 가격 변경 시만 기록, 배송/재고 없음 | snapshot 정책, shipping/stock/VAT 포함, 최저가/변동률 집계 |
| Source 상태 | `connectors.status/last_sync_at`만 존재 | 마지막 성공/시도/오류, 정책상태, 인증상태, 연속실패, 다음실행 추가 |
| 관리자 수동수정 보호 | 부분 CRUD만 존재 | field provenance와 `locked/manual_override`로 동기화 덮어쓰기 방지 |
| Adapter 인터페이스 | 모듈별 함수 형태가 제각각 | Manufacturer/Supplier 공통 계약 및 capability 선언 |
| 구매 후보 | 구매요청은 존재 | 외부 이동 전 후보 이벤트와 실제 구매 확정 상태 구분 |

### 2.4 즉시 중단/수정해야 할 기존 연동

| 모듈 | 현 상태 | 판정 |
|---|---|---|
| `backend/naver-shop.mjs` | 종료된 쇼핑 검색 API에 의존, 커넥터 기본 활성 | **중단/E** — 운영 호출 제거, 과거 데이터는 출처/시각과 함께 보존 가능 |
| `backend/mall-scrape.mjs` | Cafe24 HTML 패턴 기반, 자재코리아, 커넥터 기본 활성 | **보류/C** — robots/약관/서면허가 전 비활성 |
| `backend/g2b-shop.mjs` | 조달청 공식 OpenAPI 사용 | **유지/A** — 현 구현의 필드 매핑을 실제 응답으로 검증 |
| `backend/supplier-rest.mjs` | 계약 공급처용 범용 JSON API | **유지** — 가장 권장되는 제휴 방식 |
| `backend/coupang-partners.mjs` | 파트너스 자격/키 필요 | **보조/D** — 전기자재 전문성이 낮고 제휴 조건 확인 필요 |
| `backend/ali-open.mjs` | 해외 제휴 API | **핵심 제외/E** — 국내 공사업체 조달의 가격·인증·납기 기준과 불일치 가능성이 큼 |

## 3. 제조사/공식 제품 데이터 조사

### 3.1 상세 조사표

| 제조사/공식 소스 | URL | 제품·카테고리 | 검색/상세/모델·코드·규격 | 문서·인증·이미지 | API/구조화 파일 | robots.txt·약관·자동수집 | 업데이트 | 난이도 | 추천 데이터 확보 방법 |
|---|---|---|---|---|---|---|---|---|---|
| LS ELECTRIC | [제품](https://www.ls-electric.com/ko/product/) · [Product Finder](https://pfinder.ls-electric.com/IEC/product/mccb_susol.do) · [자료실](https://www.ls-electric.com/ko/download/) | 저압/고압 차단기, 개폐기, 접촉기, 계전기, 자동화 등. 제품 페이지는 제품군 중심 계층 | Product Finder에 품목코드/설명 검색과 MCCB의 AF, 차단용량, Trip, 극수, 정격전류 필터 확인. 제품 상세 페이지 존재 | 카탈로그, DataSheet, CAD, 인증서, 이미지 확인 | 공개 공식 API/CSV/Excel/XML/JSON은 **확인 필요**. Product Finder 내부 구조를 공개 API로 간주하지 않음 | 본 사이트 robots는 `/` 허용, `/ko/upload`, `/ko/dl`, 관리 경로 차단. Product Finder 별도 robots/이용조건은 **확인 필요**. robots 허용만으로 수집 허가는 아님 | 문서별 수정일 제공. 보장 주기/SLA는 확인 필요 | 중 | 1) 공식 제공 파일/승인된 다운로드 B 2) 제휴 데이터 요청 3) 허가 시 Product Finder adapter. 자동 PDF 대량수집은 금지 |
| Schneider Electric Korea | [제품 목록](https://www.se.com/kr/ko/work/support/sc/product-list.jsp) · [A-Z](https://www.se.com/kr/ko/product-range-az/) · [공식 API](https://api-explorer.se.com/en/api/product-catalog-v2) | 배전, Acti9, Compact/MasterPact, 자동화, 배선/빌딩 제품 등 | 제품 검색·상세·상태·최소주문수량·사양 확인. 상업 참조번호 중심 | 제품 문서, 데이터시트, 브로슈어, 미디어 제공 | **공식 Product Catalog API 존재**, OAuth, ETIM 10.0, 문서/미디어 포함. Product Availability API도 존재 | 파트너/고객 온보딩 필요. API 공개 지원 국가 목록에 한국이 없어 한국 담당자 확인 필요. 웹 robots/약관은 확인 필요 | API delta 조회(`date-of-reference`) 지원. SLA 확인 필요 | 중(승인 후 낮음) | 한국 법인/담당자에게 Product Catalog + Availability + 가능 시 Net Price API 접근 신청. 승인 전 웹 수집 금지 |
| LS전선 | [제품 소개](https://www.lscns.co.kr/kr/product/prod_index.asp) · [카탈로그](https://www.lscns.co.kr/kr/product/catalog.asp) | 에너지(초고압/배전/버스덕트), 산업전선, 통신, 소재 | Product Quick Search와 상세 페이지 존재. 일반 공사용 케이블은 카탈로그 내 규격표 중심 | 공식 PDF 카탈로그와 이미지 확인. 인증은 제품별 확인 필요 | 공개 API/CSV/Excel/XML/JSON은 확인 필요 | robots 응답 확인 실패. 일부 카탈로그에 복제·재배포 제한 문구가 있으므로 데이터 추출/재배포 허가는 확인 필요 | 페이지/파일별 갱신, 정기주기 확인 필요 | 중~상(PDF 표) | 공식 PDF를 수동 업로드→staging→검수. 모델/규격 DB 또는 ETIM/BMEcat 제공 가능 여부 제휴 문의 |
| 대한전선 | [제품](https://www.taihan.com/business/product/electricity) · [카탈로그](https://www.taihan.com/customer/catalogue) | 송전, 배전용 중저압/제어·계장/절연/소방 케이블, 산업용, 버스덕트 | Quick Search·제품 상세 존재. 상세 규격은 카탈로그 중심 | 공식 카탈로그·지명원 다운로드 확인. 인증정보 구조는 확인 필요 | 공개 API/CSV/Excel/XML/JSON은 확인 필요 | robots/이용약관/자동수집 허용은 확인 필요 | 정기주기 확인 필요 | 중~상 | 공식 파일 B + 제조사 제공 데이터 요청. 허가 없는 웹/PDF 일괄 추출 금지 |
| HD현대일렉트릭 | 공식 제품/카탈로그 URL **확인 필요** | 저압/고압 차단기, 배전기기 후보 | 이번 조사에서 안정적인 제품 검색/상세 URL 확인 실패 | 카탈로그 존재 여부 확인 필요 | API/Feed 확인 필요 | robots/약관 확인 필요 | 확인 필요 | 상 | Phase 1B 후보. 담당자/대리점에 공식 카탈로그 또는 제품 DB 요청 후 채택 판단 |
| 르그랑코리아 | [공식 사이트](https://www.legrand.co.kr/) | 배선기구, 콘센트/스위치, 데이터센터/배선 시스템 후보 | 제품 검색·개별 상업참조번호 구조는 추가 확인 필요 | 공식 PDF 카탈로그 확인 | API/Feed/CSV 확인 필요 | robots/약관/자동수집 허용 확인 필요 | 확인 필요 | 중 | 배선기구 대표 후보. 공식 품번 목록/카탈로그 제공 여부 문의 후 B 또는 D 분류 |
| 대양엔지니어링 | [공식 전기배관자재 카탈로그 PDF](https://www.daeyangeng.co.kr/__Commonlib/_img/%EB%8C%80%EC%96%91%EC%97%94%EC%A7%80%EB%8B%88%EC%96%B4%EB%A7%81_%EC%A0%84%EA%B8%B0%EB%B0%B0%EA%B4%80%EC%9E%90%EC%9E%AC%282025%29.pdf) | 금속제 가요전선관, 방폭 후렉시블/피팅 등 | 호칭, 길이, 치수, KS 정보가 표로 확인됨 | PDF 도면·KS·제품 이미지 확인 | API/Feed/CSV 확인 필요 | robots/약관/재사용 조건 확인 필요 | 2025 카탈로그 확인, 주기 확인 필요 | 중 | 전선관 schema 검증용 공식 카탈로그 후보. 상업적 DB 적재 허가 후 B |
| 터미널/압착단자 제조사 | URL/제조사 **확인 필요** | 링/포크/핀/슬리브/단자대 | 모델·전선범위·볼트홀 규격 필요 | 확인 필요 | 확인 필요 | 확인 필요 | 확인 필요 | 상 | 실제 거래처 구매이력에서 상위 제조사를 먼저 산출한 뒤 공식 데이터 요청. 추측으로 제조사를 확정하지 않음 |

### 3.2 제조사 데이터 판단 근거

- LS ELECTRIC의 공식 제품 페이지는 Susol MCCB에 제품 특징과 카탈로그·인증서를 제공하며, Product Finder는 품목코드 검색과 MCCB 규격 필터를 제공한다: [LS 제품 페이지](https://www.ls-electric.com/ko/product/view/P01022), [LS Product Finder](https://pfinder.ls-electric.com/IEC/product/mccb_susol.do).
- LS ELECTRIC robots.txt는 루트 허용과 일부 업로드/다운로드·관리 경로 차단을 명시한다: [robots.txt](https://www.ls-electric.com/robots.txt). 이는 개별 콘텐츠의 복제 허가가 아니다.
- Schneider의 공식 Product Catalog API는 OAuth 기반으로 상세 사양, ETIM 분류, 문서·미디어를 제공한다. 다만 한국은 공개 지원 국가 목록에 없다: [Product Catalog API](https://api-explorer.se.com/en/api/product-catalog-v2). Availability API는 납기예정과 GTIN을 제공하지만 지역/고객 자격에 따라 접근이 달라진다: [Product Availability API](https://api-explorer.se.com/en/api/product-availability-v2).
- LS전선은 제품 Quick Search와 공식 PDF 카탈로그를 제공한다: [제품 소개](https://www.lscns.co.kr/kr/product/prod_index.asp), [카탈로그](https://www.lscns.co.kr/kr/product/catalog.asp). 확인된 일부 PDF에는 사전 서면허가 없는 복제·배포 제한 문구가 있다.
- 대한전선은 중저압/제어·계장/절연/소방 케이블 등 공식 분류와 다운로드 카탈로그를 제공한다: [제품](https://www.taihan.com/business/product/electricity), [자료실](https://www.taihan.com/customer/catalogue).

## 4. 판매처/가격 데이터 조사

### 4.1 상세 조사표

| 판매처/소스 | URL | 판매 품목 | 공개가격/비회원/로그인 | 검색·제조사·모델·규격 | 재고·배송비·납기 | 공식 API/Feed/파일 | robots·약관·크롤링 | 로그인 자동화 | 신뢰도/난이도 | 추천 방식 |
|---|---|---|---|---|---|---|---|---|---|---|
| 조달청 나라장터 쇼핑몰 품목정보 | [공공데이터포털](https://www.data.go.kr/data/15129471/openapi.do) | MAS/제3자단가 등 등록 품목. 전기자재 포함 여부는 품명별 조회 필요 | API 계약가격 공개. 포털 활용신청/서비스키 필요 | 계약·인증정보 조회. 제조사/모델/규격 필드는 실제 응답 probe 필요 | 계약/인증 중심. 재고·일반 배송비는 확인 필요, 납품조건 필드는 명세/응답 확인 필요 | **공식 REST OpenAPI, JSON/XML**, 참고문서 제공 | 이용허락 제한 없음, 무료, 개발 자동승인. 포털 트래픽 정책 준수 | 불필요(API 키만 사용) | 높음/낮음~중 | **A, 1순위 가격·계약 소스**. 민간 시세와 분리하고 실제 필드 probe 후 운영 |
| 2SK | [사이트](https://2sk.co.kr/) · [예시 상품](https://2sk.co.kr/shop_view/?idx=1561) | LS ELECTRIC 중심 차단기, 개폐기, 제어/고압기기 등 | 상품가격 비회원 공개 확인. VAT 포함/별도는 페이지군마다 표기 차이가 있어 상품별 정규화 필요 | 검색, Maker, 모델, 전압, 극수, kA, AF 등 우수 | 배송비와 주문품 납기(예: 2~3주) 확인. 일부 재고는 확인 필요 | 공식 API/Feed/CSV/Excel 확인 필요 | 이용약관 링크 존재하나 자동수집 허용 문구 확인 못함. robots 응답 확인 실패. **크롤링 가능 여부 확인 필요** | 하지 않음 | 데이터 좋음/중 | **C**. 제휴 API/CSV 또는 서면 허가 요청. 허가 전 수동 링크/견적 등록만 |
| 구매솔루션 EOS(화정산전) | [사이트](https://hjts.co.kr/) · [예시 상품](https://hjts.co.kr/shop_view/?idx=968) | 차단기, 개폐기, 계전·계측, 인버터, 변압기 등 | 공개 가격 확인, 사이트는 VAT 포함이라고 명시. 로그인 없이 일부 열람 가능 | 검색/제조사/모델/상품 설명 확인 | 일부 상품에 남은 재고 수량, 기본 배송비, 재고품 당일배송 마감 정보 확인 | 공식 API/Feed/CSV/Excel 확인 필요 | 이용약관 링크 존재하나 자동수집 허용 확인 못함. 직접 자동접근은 403 관찰. robots 확인 실패. **크롤링 가능 여부 확인 필요** | 하지 않음 | 좋음/중~상 | **C**. 사업자 제휴 및 가격·재고 Feed 협의가 우선 |
| 전자단가 시스템 | [가격표](https://hj119.co.kr/PriceList.aspx) | LS ELECTRIC, 삼화콘덴서 등 전기기기 기준단가 | 비회원 가격표 공개, VAT 별도. 실제 판매가와 다를 수 있다고 명시 | 제조사/대분류/중분류/품목코드/품목명 검색·표시 | 재고·배송비·납기 확인 필요 | 공식 API/Feed/CSV/Excel 확인 필요 | robots/약관/자동수집 허용 확인 필요 | 불필요해 보이나 확인 필요 | 기준단가로 유용/중 | **C**. `price_basis=reference`로만 사용. 실제구매가처럼 표시 금지, 운영자 서면허가 우선 |
| 자재코리아 | [사이트](https://jajekorea.com/) | 조명, 전선/전기자재, 소방, 공구, 배관 등 시설관리 범용 | 비회원 공개. 많은 품목이 전화문의이고 일부만 가격 공개 | 사이트 검색/카테고리 확인. 제조사·모델·정밀규격 품질은 상품별 편차 | 배송비와 품절 표시 확인. 납기 확인 필요 | 공식 API/Feed/CSV/Excel 확인 필요 | 이용약관 링크 존재하나 자동수집 허용 확인 못함. robots 확인 실패. **크롤링 가능 여부 확인 필요** | 하지 않음 | 보통/중 | **C(낮은 우선순위)**. 현 `mall-scrape` 운영 중지, 제휴/CSV 허가 시 보조 소스 |
| 쿠팡 파트너스 API | [공식 가이드](https://partners.coupangcdn.com/partners-guide/partners-guide-20240716100922.pdf) | 범용 오픈마켓, 전기자재 일부 | 파트너 승인/키 필요 | 상품 API 제공. 전문 규격 품질·동일제품성은 낮을 수 있음 | API 응답 범위 확인 필요 | 공식 파트너스 API 존재 | API 약관·속도제한 준수. 일반 쿠팡 Seller Open API는 자기 판매상품 관리용이므로 전체 가격검색 소스로 혼동 금지 | 파트너 로그인/승인 필요 | 보통/중 | **D, 보조 소스**. 핵심 Master나 유일 가격소스로 사용하지 않음 |
| 네이버 쇼핑 검색 API | [종료 공지](https://developers.naver.com/notice/article/32564) | 과거 쇼핑검색 | 2026-07-31 종료 | 해당 없음 | 해당 없음 | 대체 API 없음 | 비공식 endpoint 금지 | 금지 | 없음 | **E — 사용 중단** |

### 4.2 판매처 확인 근거와 주의

- 나라장터 쇼핑몰 품목정보 서비스는 조달청 공식 REST API이고 JSON/XML, 무료, 이용허락 제한 없음, 개발단계 자동승인, 기본 1,000건 트래픽 조건이 확인된다: [공공데이터포털](https://www.data.go.kr/data/15129471/openapi.do).
- 2SK 상품 페이지는 제조사, 모델, 전압, 극수, 차단용량, AF, 가격, 배송비, 주문품 납기를 공개한다: [ABN802c 예시](https://2sk.co.kr/shop_view/?idx=1561), [MMS32S 예시](https://2sk.co.kr/shop_view/?idx=2370).
- EOS는 공개가격, VAT 포함, 재고품 당일배송 안내를 표시하고 일부 상품은 잔여재고와 배송비를 제공한다: [EOS 홈](https://hjts.co.kr/), [재고 예시](https://hjts.co.kr/shop_view/?idx=968).
- 전자단가 시스템은 제조사·품목코드·품목명·기준단가를 제공하지만 VAT 별도이며 실제 판매가와 다를 수 있다고 스스로 경고한다: [전자단가 시스템](https://hj119.co.kr/PriceList.aspx).
- 자재코리아는 전선/전기자재 카테고리와 배송비/품절을 공개하지만 많은 제품이 전화문의다: [자재코리아](https://jajekorea.com/).
- 네이버는 쇼핑 검색 API 종료와 별도 대체 API 미제공을 공식 공지했다: [종료 공지](https://developers.naver.com/notice/article/32564), [API HUB 이관 제외 안내](https://developers.naver.com/notice/article/32530).

## 5. 최종 Source Matrix

등급 정의:

- A = 공식 API 사용 가능
- B = 공식 Feed/파일 사용 가능
- C = 공개페이지 활용 가능 여부 추가 검토
- D = 로그인/사업자/파트너 가격으로 별도 협의 필요
- E = 사용하지 않는 것이 좋음

| Source | 역할 | API | 공개가격 | 로그인 | 크롤링 | 규격정보 | 가격정보 | 안정성 | 등급 | 추천 |
|---|---|---|---|---|---|---|---|---|---|---|
| 조달청 나라장터 쇼핑몰 | 판매/계약 | 공식 REST JSON/XML | O(계약가) | API 키 | 불필요 | 좋음 예상, probe 필요 | O | 높음 | **A** | 1차 가격 Adapter |
| Schneider Electric | 제조사 Master/가용성 | 공식 Catalog/Availability API | 가격 API는 별도 자격 | 파트너 OAuth | 웹수집 불필요 | 매우 좋음(ETIM) | 자격 기반 | 높음 | **D→A** | 한국 접근 승인 신청 |
| LS ELECTRIC | 제조사 Master | 공개 API 확인 필요 | - | X | Product Finder 별도 확인 필요 | 매우 좋음 | 없음 | 높음 | **B/C** | 공식 파일 우선, 제휴 요청 |
| LS전선 | 제조사 Master | 확인 필요 | - | X | 확인 필요 | 좋음(PDF) | 없음 | 높음 | **B** | 공식 파일+검수 |
| 대한전선 | 제조사 Master | 확인 필요 | - | X | 확인 필요 | 좋음(PDF) | 없음 | 높음 | **B** | 공식 파일+검수 |
| 대양엔지니어링 | 제조사 Master(전선관) | 확인 필요 | - | X | 확인 필요 | 좋음(PDF) | 없음 | 중 | **B/C** | 허가 후 카탈로그 적재 |
| 르그랑코리아 | 제조사 Master(배선기구) | 확인 필요 | - | 확인 필요 | 확인 필요 | 확인 필요 | 없음 | 중 | **C/D** | 공식 데이터 문의 |
| 2SK | 판매처 | 확인 필요 | O | X(열람) | **확인 필요** | 매우 좋음 | O | 중 | **C** | Feed/CSV 제휴 우선 |
| 구매솔루션 EOS | 판매처 | 확인 필요 | O | X(일부 열람) | **확인 필요** | 좋음 | O | 중 | **C** | Feed/CSV 제휴 우선 |
| 전자단가 시스템 | 기준가격 | 확인 필요 | O(VAT 별도) | X | **확인 필요** | 좋음 | 기준단가 | 중 | **C** | 참고가격 전용 |
| 자재코리아 | 판매처 | 확인 필요 | 일부 O/전화문의 | X(열람) | **확인 필요** | 보통 | 일부 O | 중하 | **C** | 낮은 우선순위, 현 수집 중지 |
| 쿠팡 파트너스 | 판매처 보조 | 공식 제휴 API | O | 파트너 승인 | API만 | 편차 큼 | O | 중 | **D** | 보조 시세만 |
| 네이버 쇼핑 검색 | 판매처 집계 | 종료/대체 없음 | - | - | 비공식 방식 금지 | - | - | 없음 | **E** | 제거 |
| AliExpress Open API | 해외 보조 | 제휴 API | O | 앱 승인 | API만 | 편차 큼 | O | 중 | **E(초기)** | 국내 전기공사 핵심에서 제외 |

## 6. 추천 초기 Source 조합

### 운영 투입 가능

1. **조달청 나라장터 쇼핑몰 API**
   - 가격/계약/인증 데이터
   - 소스 타입: `official_api`
   - 가격 타입: `public_contract`
   - 주의: 공공조달 계약가를 일반 온라인 최저가와 같은 열에서 비교하되 가격 성격을 명확히 표시한다.

2. **회사 기존 거래처 CSV/Excel 또는 계약 REST API**
   - 실제 회사 구매가격·MOQ·배송비·납기·재고에 가장 가까운 데이터
   - 현 `supplier-rest.mjs`와 CSV 적재 흐름을 재사용한다.
   - 공급처가 Excel만 주면 원본 파일 보관→변환→검수→적재 이력을 남긴다.

### 승인/협의 후 투입

3. **Schneider 공식 Product Catalog/Availability API** — 한국 접근 승인 후.
4. **LS ELECTRIC 공식 데이터** — 공식 파일 사용 범위 또는 제품 DB 제공 협의 후.
5. **LS전선/대한전선 공식 카탈로그** — 상업적 DB 적재·이미지/문서 링크 사용 범위 확인 후.
6. **2SK/EOS/전자단가** — API/CSV/제휴 또는 서면 자동수집 허가 후.

### 투입하지 않음

- 네이버 쇼핑 검색 API 및 비공식 대체 endpoint
- CAPTCHA·로그인·접근제어 우회가 필요한 소스
- 이용조건/robots를 확인하지 못한 판매몰의 Production HTML 수집
- 출처·확인시각 없는 임의 가격

## 7. 소스별 수집 주기 제안

정책·제휴 계약이 확정되기 전의 설계값이며, 사이트에 실제 호출하지 않는다.

| 데이터 | 기본 주기 | 조건부 동작 | 근거 |
|---|---|---|---|
| 제조사 Master API | 주 1회 delta | 신제품/단종 공지 시 수동 실행 | 마스터 변화가 상대적으로 느림 |
| 공식 카탈로그 파일 | 주 1회 HEAD/메타 확인 또는 월 1회 수동 | 파일 버전/수정일 변경 시 staging | 원문 전체 반복 다운로드 방지 |
| 계약 공급처 API | 1~6시간(계약 한도 내) | 실패 시 지수 백오프 | 실제 구매 가격/재고 변화 |
| 조달청 API | 일 1회 또는 필요한 품목 중심 | 포털 트래픽 한도 준수 | 계약 데이터 성격 |
| 상세화면 가격 | stale 기준 초과 시 비동기 갱신 | 기존 값에는 확인시각/경고 표시 | 사용자 대기와 부하 절충 |
| 서면 허가된 웹페이지 | 허가된 빈도만 | ETag/Last-Modified, 저속 큐, 캐시 | 사이트 부담과 정책 준수 |

권장 stale 기본값:

- 실재고/실판매가 API: 6시간
- 계약가/기준단가: 24시간
- 수동 견적: 견적 유효일까지, 없으면 7일
- 72시간 초과 시 경고, 30일 초과 시 기본 정렬에서 후순위

## 8. 구현 전 승인 체크리스트

다음이 끝나기 전에는 해당 소스의 자동수집 Adapter를 Production에서 켜지 않는다.

- [ ] API/Feed/파일 제공 방식과 담당자 확인
- [ ] 상업적 내부 DB 저장 및 사내 사용자 노출 허용 범위 확인
- [ ] 이미지·PDF는 원문 링크만 가능한지, 캐시/복제가 가능한지 확인
- [ ] robots.txt 원문과 확인시각 저장
- [ ] 이용약관 원문 URL/버전/확인시각 저장
- [ ] 허용 User-Agent, 호출빈도, 일일 한도 확인
- [ ] 비회원 가격과 사업자 가격의 노출/저장 조건 확인
- [ ] VAT, 배송비, MOQ, 납기, 재고 필드의 의미 확인
- [ ] 삭제/정정/단종 반영 규칙 확인
- [ ] 장애 시 마지막 정상 데이터의 표시 및 stale 경고 검증

## 9. 다음 구현 순서 제안

이 보고서를 기준으로 다음 순서를 권장한다.

1. 네이버 커넥터와 무허가 `mall-scrape`를 운영 비활성화하고 상태 사유를 표시한다.
2. 기존 DB를 파괴하지 않는 additive migration으로 `product_master`, `supplier_product`, `source`, `match_review`, `field_provenance` 요구 필드를 보강한다.
3. 실제 제조사/판매처 분류를 반영한 Category Tree와 category-specific schema를 만든다.
4. 나라장터 공식 API Adapter를 새 공통 인터페이스에 맞춰 이전하고 실제 응답 probe 테스트를 추가한다.
5. 공식 파일용 Manufacturer import staging/검수 흐름을 만든다. LS 데이터를 무단 자동수집하지 않는다.
6. 제품코드/모델 우선 Matching Engine과 관리자 검수큐를 만든다.
7. Catalog 목록·동적 필터·제품 상세·가격비교·신선도 경고 UI를 붙인다.
8. 구매후보→구매요청→발주→입고→재고의 기존 흐름을 연결하고 회귀 테스트한다.

## 10. 조사 한계와 확인 필요 목록

- LS ELECTRIC 공개 API 또는 공식 BMEcat/ETIM/CSV 제공 여부
- LS Product Finder의 별도 robots.txt와 자동화/데이터 재사용 조건
- Schneider API의 대한민국 조직 접근 가능 여부와 가격/가용성 API 자격
- LS전선·대한전선·르그랑코리아·대양엔지니어링의 데이터베이스 적재/이미지 사용 허가
- 2SK/EOS/전자단가/자재코리아의 공식 API·CSV·상품 Feed·제휴 조건
- 각 판매처 robots.txt의 실제 응답 및 자동수집 조항
- 사업자회원 가격과 비회원 가격의 차이, 저장/사내공유 허용 범위
- 터미널/압착단자 부문의 실제 회사 사용 상위 제조사
- HD현대일렉트릭 공식 제품 데이터 URL과 제공 형식

확인되지 않은 위 항목은 구현 과정에서 추측으로 채우지 않는다.
