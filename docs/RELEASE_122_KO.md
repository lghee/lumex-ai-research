# LUMEX Market Hub 1.2.2 — BTC reserve watchlist migration and R2 archive diagnostics

## 목적
공유 호스팅 WordPress가 직접 조회하던 BTC 공개 준비금 주소의 온체인 **확인 거래 순변화**를 Cloudflare에 이전하는 1차 백엔드. 기존 AI 연구·회원·결제·거래 주문·cPanel Cron 상태는 유지한다. 전체 거래소 입출금이나 실거래 매수/매도 근거로 해석하면 안 된다.

## 코드 변경
- `BtcReserveCollector` SQLite Durable Object, `BTC_RESERVE_COLLECTOR` binding. 독립 5분 Cloudflare Cron에서 주소 한 개씩 순환 호출.
- Blockstream Esplora `GET /api/address/{address}/txs/chain` 확정 트랜잭션 조회(기본 25건 및 이전 페이지 최대 1건/회).
- 1 BTC = 1e8 satoshi. 입력들의 이전 출력에 명시된 해당 주소의 금액 합계와 새 출력에서 해당 주소 금액 합계의 **순변화**만 계산. 순변화 0은 저장하지 않음.
- `whale_transfer`, `source:blockstream`, `capture:confirmed_chain_poll`, `price:0` (가격 비추정), `quantity:BTC`, `side:in|out`, 거래 해시 및 관측 주소를 기록.
- Event ID는 거래 txid + 관측 주소 기반. MarketEventHub SQL 원장이 중복 기록을 차단. DO 알람이 immutable JSONL로 R2에 누적.
- DO 상태에 주소별 체크포인트·이력 보충 커서·관측 수·확인 시각·가능한 누락 구간·실패 코드 저장.
- 처음 설치 시 이전 35일 이력을 순차 보충한다. 페이지 제한/장애/높은 거래량으로 전량 보장 불가하면 `gap_possible`로 보고한다.
- `GET /market-hub/v1/whale-health`: 공개 저장/수집 상태 (주소 전체 대신 마지막 8자리).
- `GET /market-hub/v1/archive-health`: R2 immutable batch 객체 샘플 수·최신 수정시각. 표본 25개까지만, 누적 전체 개수 아님.

## WordPress Core 0.5.05.24 (별도 설치)
- 기존 Core 내부 `/wp-json/lumex/v1/market-hub/watchlist` 신설. Worker Bearer Token의 정확한 일치 검증 후 기존 `Lumex_Whale_Flows::watchlist()`를 최대 20개로 제공.
- `/wp-json/lumex/v1/market-hub/live-status` 관리자 전용 API: Worker, Gate·Bybit, BTC onchain, R2 archive 진단.
- 플러그인·테마·정책/주문 코드 유지. 독립 플러그인 미생성.
- Core 미설치 상태에서 WP REST 404인 경우에만 현재 기존 Core의 초기 관측 주소 4개를 임시 사용하며 결과에 `legacy_seed_fallback` 표시. 403/서버 오류를 성공으로 간주하거나 목록을 추측하지 않음.
- WordPress 주소 설정 변경이 Cloudflare에 반영되려면 Core 0.5.05.24 설치가 필수. 설치 전 DB 내용 임의 추정 금지.

## 안전·데이터 품질
- 서버 키·실거래 Exchange API Key는 Cloudflare Worker 로그나 브라우저에 노출 안 함.
- 주소의 라벨은 기존 WP 관리자 출처에서 받은 관측명이며 거래소가 주소 소유를 공식적으로 보증하는 것은 아님.
- Confirmed BTC 거래만. 미확정 거래/ETH·SOL·XRP 체인/클러스터링/실제 고래 엔티티 추정은 포함되지 않음.
- 보유자별 다중 주소를 하나의 고래로 통합하지 않음. 거래 관련 시장 반응 해석은 별도의 검증 데이터로만 수행.
- cPanel의 기존 BTC·청산·시장 cron은 아직 삭제하지 않음. Cloudflare 결과 일치 확인 및 WP Core 설치 후 단계별 이전.
- 기존 AI 연구, 1분 시세 조회, Bybit 청산·Gate tick 스트림, ResearchContainer, 주문/회원/결제 로직 미변경.

## 테스트
- GitHub Actions에서 `cd production && npm run check` 실행.
- 신규 `test_btc_whale_122.mjs`: 확인 거래의 순유입·순유출/중립 거래, 가격 비추정, Watchlist 404 폴백, 403 차단, R2 archive list.
- PHP 74개 파일 `php -l` 통과.
- 운영 `/health` 1.2.2, `/market-hub/v1/whale-health` 및 `/market-hub/v1/archive-health` 확인 후에만 배포 성공 선언.

## 남은 단계
- WordPress Core 실제 운영 설치/PRO UI 조회 경로 전환.
- 기존 WordPress MySQL 이력을 Cloudflare R2에 일회성 이관 및 중복·수집 시간 감사.
- BTC 공개 주소 이외의 네트워크/지갑 엔티티 추적, 정확한 USD 환산 시점 및 추가 제공처 결정.
- 청산·시장분석·시장 지표의 데이터 조회/연산을 WordPress에서 Cloudflare로 완전 분리.
- 실시간 PRO 차트의 WebSocket 연결과 데이터 출처 일치 처리. 기존 Bybit 직접 실시간과 Gate 공개 샘플을 혼합하지 않음.

## 공식 근거
- https://github.com/Blockstream/esplora/blob/master/API.md
- https://developers.cloudflare.com/durable-objects/best-practices/websockets/
