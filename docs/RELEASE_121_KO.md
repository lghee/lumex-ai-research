# LUMEX AI Research / Market Hub 1.2.1 — Public realtime observation collector

## 목적
공유 호스팅 PHP가 실행하던 공개 청산 정보 및 가격 조회를 Cloudflare Durable Object에 부분 이전. 기존 AI 연구, 사용자 구독/결제, 실주문 Cron은 유지한다.

## 검증한 공개 소스
- **Bybit V5 public linear WebSocket**: `wss://stream.bybit.com/v5/public/linear` `allLiquidation.{symbol}`.
- **Gate.io USDT futures public WebSocket**: `wss://fx-ws.gateio.ws/v4/ws/usdt` `futures.trades`, `futures.tickers`.
- 대상: BTCUSDT / ETHUSDT / SOLUSDT / XRPUSDT.
- 실제 Bybit 청산 패킷의 가격 `p`는 **파산가격(bankruptcy price)**. 실체결 가격으로 해석하면 안 된다.
- Gate 선물 체결/티커는 중복 저장 및 비용 제어를 위해 종목당 체결 1초/티커 2초 간격으로 샘플링한다. 원시 전체 거래 내역 아님. 실제 코인 고래 온체인 거래와 별개다.

## 신규 Durable Object
- `MarketLiveCollector` (binding `MARKET_LIVE_COLLECTOR`) 1개, 내부 이름 `public-linear`.
- 거래소별 WebSocket을 동시에 유지하며 공개 구독만 사용한다. 비밀키, 주문 서명, 계정 조회 없음.
- 기존 Cloudflare 매 1분 Cron이 `/ensure` 호출; 10초 DO Alarm으로 핑, 수집 버퍼 flush, 끊김 자동 재연결.
- 입수한 공개 이벤트는 `MarketEventHub` DO에 직접 제출: 중복 ID 저장 금지, 최신 조회 14일 인덱스, R2 immutable batch JSONL 누적.
- Bybit 청산 `id`는 관측 항목의 핵심 속성 해시; Gate 거래는 거래소 거래 ID, Gate ticker는 시각별 샘플 ID.
- 기록에 `capture:public_stream|sampled_1s|sampled_2s`, `price_type:bankruptcy_price|trade_price|last_trade_price`와 `position_side` 유지.
- Heartbeat, 마지막 메시지 수신 시각, 재연결 및 실패 개수는 별도로 표시. 수신 중단 구간은 보충/추정하지 않는다.

## 새 공개 상태 API
`GET /market-hub/v1/live-health`은 수집 연결 상태와 마지막 수신 시각만 보여준다(비밀키 미노출).
`GET /market-hub/v1/health`는 1.2.1 버전, `live_exchange_ingestor: enabled_check_live_health`로 설정 활성화를 표시하지만 실제 수집 여부 증명은 반드시 `live-health`로 판단한다.
기존 `/market-hub/v1/events`는 WordPress Core의 PRO REST 프록시를 통해 읽는다.

## 설정/안전
- Wrangler `AUTO_LIVE_STREAM: "true"` 추가하여 배포 후 자체 시작 (실제로 Cloudflare WebSocket 기간/DO 사용료가 발생할 수 있음).
- 기존 R2/ResearchContainer/Queue/1분·5분 Cron/AI 설정/Secrets 유지.
- 실제 체결 OHLCV 전체를 저장하는 시스템이 아님; 저빈도 샘플 시세와 **공개 관측 청산** 데이터만 누적.
- 거래소 연결이 거부되면 상태와 마지막 수신 시각을 표시하고 실시간 수신 완료라고 주장하지 않음.
- 기존 Core 플러그인 0.5.05.23에 있는 PRO WebSocket ticket, Cloudflare Market Hub 이벤트 프록시와 호환되며, 플러그인 운영 설치 여부는 별도.

## 아직 남은 작업
1. 공개 거래소 WebSocket 실제 연결이 Cloudflare에서 이루어졌는지 `live-health` 확인.
2. 기존 WP MySQL 청산·고래 기록 Cloudflare R2 마이그레이션, 누락·중복 감사.
3. BTC 온체인 준비금 주소별 전송 체크포인트/이력 수집기 및 회원 화면 교체.
4. 초 단위 실시간 고객 차트에 Cloudflare PRO WebSocket 구독 연결 및 Gate 샘플 체결 vs Bybit 기존 차트 출처 차이 UI.
5. 기존 WordPress Cron은 Cloudflare 수집/열람의 결과 일치 확인 후 분야별로 제거. 주문감시·결제·회원 Cron은 유지.

## 검증 계획
`cd production && npm run check` 및 `test_public_stream_121.mjs`: Bybit 청산 방향과 파산가격, Gate 샘플링, DO 내부 ingest, 연결 상태, 미인증 접근 차단, 버전 호환성.
Github Actions success 후 PR 병합, Cloudflare /health 및 /market-hub/v1/health, /market-hub/v1/live-health 운영 확인.

## 출처
- https://bybit-exchange.github.io/docs/v5/websocket/public/all-liquidation
- https://bybit-exchange.github.io/docs/v5/ws/connect
- https://www.gate.com/docs/developers/futures/
- https://developers.cloudflare.com/durable-objects/best-practices/websockets/
