# LUMEX Market Hub 1.2.0 — Cloudflare 기반 데이터 분리 1차 작업

## 범위
기존 LUMEX AI 연구 Worker `lumex-ai-research2` 및 R2 `lumex-ai-data` 유지. WordPress Core 0.5.05.22가 직접 호출하던 시장 캔들·레이다용 읽기 API를 Cloudflare로 분리하는 1차 인프라. 청산·고래 이벤트의 공개 관측 이력을 저장하기 위한 원장 추가. **실시간 거래소 수집기 자체는 이번 릴리스에 연결되지 않았으므로 전체 실시간 서비스 완성은 아님.**

## Cloudflare 신규 API
- `GET /market-hub/v1/health` — 버전과 활성 범위. 공개하되 내부 상태/비밀키 노출 없음.
- `GET /market-hub/v1/candles?symbol=BTCUSDT&interval=15` — 인증된 서비스에서 검증된 R2 캔들만 반환. 5/15/60/240/1440분 지원, 240/1440은 60분 확정봉 기준 재구성(장기 이력이 부족하면 503). 제공처와 `stale`, 마지막 확정봉 시각 표시.
- `GET /market-hub/v1/radar` — 4개 코인의 15분/1시간 SMA20·SMA50·ATR14 및 캔들 기반 24h 변동률. 체결가 WebSocket이나 USD 거래대금으로 허위 표기하지 않음.
- `POST /market-hub/v1/ingest?symbol=...` — 인증된 컨테이너 서비스만 공개 관측 이벤트 배치 입력. 최대 100개/배치, 크기 제한 및 타입·출처·수량·시각 검증.
- `GET /market-hub/v1/events?symbol=...&kind=...&limit=...` — 서비스 인증된 최신 14일 인덱스, 그 이전 원본은 R2에 불변 배치 파일로 누적.
- `GET /market-hub/v1/ws?symbol=...&uid=...&exp=...&sig=...` — WordPress PRO 회원에게 발급한 90초 HMAC 티켓으로 WebSocket 연결. 새 관측 이벤트만 전송.

## 아키텍처와 데이터 무결성
- Worker → 기존 검증된 5/15/60m R2 CSV를 읽고 시간 간격·OHLC·행 수·마지막 확정봉 교차 검증.
- `MarketEventHub` SQLite Durable Object는 종목별 단일 writer로 관측 ID 중복을 제거하고 새 이벤트를 WebSocket 구독자에 전달.
- DO 15초 알람으로 검증된 원본 JSONL을 `market-hub/events/{type}/{year}/{month}/{day}/{hour}/{timestamp}-{uuid}.jsonl` R2에 불변 저장.
- R2 쓰기 실패 시 아직 archive되지 않은 이벤트는 DO에 남겨 30초 후 재시도. 이중 아카이브가 발생하더라도 각 이벤트 ID로 중복 제거 가능.
- DO는 최근 14일 조회 인덱스만 유지. 그 이전 원본 R2 아카이브 보관은 버킷 라이프사이클 정책에 따름.
- `trade`, `liquidation`, `whale_transfer`, `ticker`는 실제 공개 관측 기반 이벤트만 허용. 히트맵 추정치/예상 청산 레벨은 이 원장에 입력하지 않음.
- 실제 시장의 전체 청산 집계량이나 전체 거래소/고래 자금 흐름이라고 주장하지 않음. 공개 API 누락 구간은 보완하지 않고 coverage gap으로 표시할 예정.

## WordPress Core 0.5.05.23 설치 패키지 (별도)
- 기존 Core 플러그인에 `Lumex_Cloudflare_Market` 브리지를 통합. 독립 플러그인 없음.
- `/lumex/v1/market/candles`, `/lumex/v1/market/scanner` 주소 유지. UI/차트의 기존 REST 계약 보호.
- PRO 회원 권한 검사 유지. WP가 Worker 서비스 토큰으로 직접 호출하며 브라우저에는 토큰 노출 없음.
- `/lumex/v1/market-hub/ticket` PRO 회원에게 90초 유효 WebSocket HMAC 티켓 제공.
- `/lumex/v1/market-hub/events` 회원 관측 이벤트 조회 프록시.
- 기존 시장·고래·청산·알림·주문 Cron을 **이 릴리스에서는 삭제하거나 비활성화하지 않음**. 기존 의존 기능의 단계적 이전 전에 전부 삭제하면 데이터 공백 위험.

## 미구현 / 다음 단계 (중요)
1. Cloudflare Container의 지속 WebSocket 수집기(Gate 공개 거래/호가, Bybit 공개 청산 등), heartbeat·재연결·누락 기록 및 실제 이벤트 입력. 게이트 선물 청산 WebSocket은 인증 필요하므로 공개 청산 데이터를 대체할 수 없음.
2. 기존 WordPress 고래 추적 주소/checkpoint와 청산 DB 이력 R2 백필, 복합 시계열 집계.
3. 청산 리스크 지표·고래 반응·시장분석·지표 연산을 Cloudflare로 이동, WordPress cron 호출 부하 단계적 제거.
4. 차트 실시간 틱·마크가격, 15m/1h/4h/1d 재구성, 클라이언트 WS 구독 실제 실시간 표시, 수집 지연·중단 시 stale UI.
5. 가입·결제·MY·실거래 주문 전용 WP/기존 주문 실행은 연구·데이터와 독립 유지.

## 검증
- Github Actions `cd production && npm run check`와 `test_market_hub_120.mjs` 신규 테스트 통과 후에만 배포.
- Cloudflare `/health`는 기존 Worker가 버전 1.2.0인지, `/market-hub/v1/health`는 live_exchange_ingestor가 not_activated인지 확인.
- WordPress Core 업데이트 전에는 Worker API만 배포해도 기존 서비스에는 영향 없음.
- 업데이트 설치 후 실제 회원 차트·레이다를 최종 확인해야 성공 판정 가능. WordPress 운영 서버에 직접 접근할 권한은 없음.

## 비밀키·사용량
- 기존 `LUMEX_AI_LAB_WORKER_TOKEN`, `LUMEX_CONTAINER_KEY` 사용. 새 비밀키 수동 재설정 불필요.
- WebSocket 회원 티켓은 최소 90초 유효하고 반복 사용 가능한 비밀키가 아님. API 사용료와 Cloudflare Durable Object/Storage/Streams 비용 발생 가능.
- R2/Queue/Container 기존 연결 변경 없음, Cloudflare MarketEventHub Durable Object 바인딩 1개만 추가.

## 개발 원칙
완성·오프라인 테스트·운영 검증을 명확히 구분한다. 사용자의 기존 WordPress 데이터 및 실거래 주문 상태는 수정하지 않는다.