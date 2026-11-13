# LUMEX Market Hub 1.2.4 — Cloudflare 누적 관측 데이터 집계 · 공유 호스팅 분리 단계

## 기준
- 기존 GitHub main: `lghee/lumex-ai-research` 1.2.3, Gate/Bybit 공개 스트림 수집기, BTC 공개 주소 확인 거래.
- WordPress Core 기준 업로드된 0.5.05.25 플러그인 및 LUMEX Pro 0.5.05.22 테마.
- 모든 신규 기능은 기존 Worker·Core·테마에 통합, 별도 플러그인 없음.
- WP Cron/주문/회원/결제 기존 서비스는 이번 단계에서 변경·삭제하지 않음.

## 기능
`GET /market-hub/v1/insights?symbol=BTCUSDT&window=24h` 서비스 베어러 인증, 1h/24h/7d/14d/30d 지원.
종목별 Durable Object의 기존 `hub_events` hot index를 최대 500건씩 SQL 롤업으로 소급 처리한 뒤, 시간별 이벤트 요약 저장 `hub_hourly`.
- Bybit 청산: 공개 스트림 이벤트 건수, Buy/Sell 주문 방향 별도. `p`는 실체결가가 아닌 파산가격. 실제 전체 청산 규모 추정 금지.
- Gate 선물 체결: 1초당 종목별 최대 1회 샘플 관측. 전체 거래량/시장 체결 총수로 합산 금지.
- BTC 준비금 주소 확인 거래: 추적 주소의 유입·유출·순 BTC 이동; 거래소 전체 입출금, 개인 고래 지갑 전체 흐름 아님.
- 거래소별 수량 단위는 비교 불가능하므로 `by_source`에서 출처·종류·방향별로 분리.
- 1h/24h/7d/14d/30d 기간에 시간대별 관측 횟수 반환. 관측 공백은 청산 0으로 해석하지 않음.
- 기존 R2 이벤트 원본 JSONL은 그대로 불변 저장. SQL 최근 14일분만 점진 소급 집계; R2-only 이전 기록은 재처리 필요.
- SQL 롤업은 원본 이벤트별 `rollup_done` 플래그를 사용해 중복 집계를 방지. `transactionSync` 가능한 Durable Object에서는 시간별 집계와 플래그 변경을 하나의 트랜잭션으로 처리.
- 계속 남은 미집계 이벤트는 `rollup.pending_hot_events`에 표시하며 이 동안 `up_to_date:false`를 반환.

## 데이터 보관 정책
- 원본 이벤트: R2 `market-hub/events/` 불변 JSONL 저장.
- SQL hot 원장: 현재 14일 정리 유지.
- SQL 시간별 요약: 누적 보존(운영 정책 결정 전 자동 삭제 없음).
- 확정봉 R2와 고객 진행봉 WebSocket, AI 전략 연구는 분리 유지.
- 네트워크 연결이 끊긴 과거 기록을 AI로 추측·복원하지 않음.

## WordPress 연결 계획
Core 0.5.05.26에 PRO 전용 `/lumex/v1/market-hub/insights` REST 프록시 추가.
브라우저의 직접 Worker Bearer 사용 금지, 기존 WordPress PRO 회원 권한과 로그인/미결제 차단 유지.
고객 청산·고래 페이지는 실제 원장 기반 관측 카드로 단계적 보강. 기존 MySQL 이력 페이지는 삭제하지 않고 점검 후 전환.

## 남은 작업
1. 실제 회원 API 응답 및 PHP 프록시 화면 검증.
2. 오래된 WordPress MySQL 청산/고래 기록의 R2 1회 마이그레이션(원본 매핑·중복·누락 감사).
3. Funding/OI/시장분석 복합지표를 Cloudflare 데이터 계층에 단계적 이전.
4. Cloudflare 조회를 사용하는 화면 검증 후에만 관련 WordPress 수집 Cron을 개별 중단.
5. 실거래 주문/회원/결제/알림 Cron은 독립적으로 유지.

## 검증
- GitHub Actions `cd production && npm run check` 전체 회귀검사.
- `test_market_insights_124.mjs` 종목·기간/인증/청산·고래 누적 건수/SQL 중복 방지 검증.
- 운영 `/health` Worker 1.2.4 및 Market Hub `/market-hub/v1/health` 배포 확인.
- `/market-hub/v1/insights` 공개 비인증 요청이 401을 반환해야 안전. 실제 데이터는 WordPress PRO 프록시 설치 후 확인.

## 기록 상태
이번 릴리스는 누적 집계 API와 SQL 엔진 배포에 집중. 실제 전체 시장/고래/청산 데이터 확보 완료, WordPress 서버 부하 완전 제거 또는 DB 마이그레이션 완료를 주장하지 않음.
