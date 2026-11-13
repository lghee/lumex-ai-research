# LUMEX Market Hub 1.2.5 — Gate 펀딩·미결제약정·시장 데이터 Cloudflare 이전

## 요구와 현재 범위
시장분석/코인 레이더의 펀딩비, 마크·지수 가격, 미결제약정, 24시간 변동/거래대금을 공유 호스팅에서 직접 조회하지 않고 Cloudflare에서 정기 수집하고 R2에 저장. 이번 단계는 Gate USDT 선물 BTC·ETH·SOL·XRP 네 종목의 **공개 API만** 사용합니다. 거래소의 전체 선물시장 수치나 여러 거래소의 합계가 아닙니다.

## 수집 알고리즘
- Cloudflare 기존 `*/5 * * * *` Cron에 별도 awaitable 작업 `collectGateDerivatives` 추가.
- 대상별 공개 API: `/futures/usdt/tickers?contract=...`, `/futures/usdt/contract_stats?contract=...&interval=5m&limit=3`, `/futures/usdt/contracts/{contract}`.
- 한 종목에서 최신 ticker의 last·mark·index를 반드시 유한한 양수로 검증해야 저장. Funding rate는 원본 비율과 퍼센트를 별도로 보관. `volume_24h_quote`는 USDT 거래대금으로만 표기.
- OI는 contract_stats의 `open_interest_usd`로 공급자가 보고한 USDT 환산 수치만 사용. `open_interest`는 계약 수량으로 별도 보관. 20분 초과 또는 미래 2분 이상 통계는 배제하고 0으로 채우지 않음.
- `funding_next_apply`가 실제 현재 시각 이후 48시간 이내인 경우만 예정 시각 노출. 펀딩 주기는 API `funding_interval` 초.
- API 403/429/일시 장애는 Gate futures 대체 호스트에 한 번만 재시도. 임의 타 거래소 값을 혼합하지 않음.
- R2 보관: `market-hub/derivatives/v1/latest/{symbol}.json`과 `daily/{symbol}/{YYYYMMDD}.json` 5분 간격 관측, UTC 날짜별 최대 300개. 기록되지 않은 구간은 공백으로 유지.
- 종목별 실패 시 이전 정상 데이터를 덮어쓰지 않음. 응답값은 15분 초과 시 `stale:true`.
- 상태 보고 `status.json`에 각 종목 수집 성공·누락 필드만 기록(비밀키나 원시 응답 보존 없음).

## 조회
- `GET /market-hub/v1/derivatives-health`: 공개 상태·소스·수집 오류 확인.
- `GET /market-hub/v1/derivatives?symbol=BTCUSDT`: 최신 5분 스냅샷. WordPress Worker 서비스 Bearer 또는 90초 PRO HMAC 티켓 필수.
- `GET /market-hub/v1/derivatives-history?symbol=BTCUSDT&window=24h|7d`: 24시간/7일 관측 시계열, 168개 점으로 제한. 프로 접속권 필요.
- 브라우저는 90초 WordPress 티켓으로 Cloudflare 직접 요청. WordPress MySQL에 매 새로고침마다 시장 데이터 저장·집계하지 않음.

## 데이터 해석
- **펀딩비**: Gate 제공 원본 비율/%, 예정 시각은 공급자 계약 정보가 있을 때만.
- **OI**: Gate 한 거래소의 미결제약정 명목가치. 상승을 곧바로 매수세로 해석하거나 순매수·순매도라고 단정하지 않음.
- **프리미엄**: `(mark/index - 1) × 100`, Gate 선물의 실제 mark/index 출처.
- **24시간 거래대금**: Gate `volume_24h_quote`. 별도 샘플 체결과 합치지 않음.
- 거래소/수집 중단 구간, 오래된 OI, 확인되지 않는 장부 상태는 명시적 없음/지연 표시.
- 실거래 주문·전략의 승인·WordPress 회원/결제/기존 연구 Cron 변경 없음.

## 후속
- Core 0.5.05.27, Theme 0.5.05.24: 기존 시장분석·코인 레이더에 새 펀딩/OI 관측 패널 연동.
- 기존 MySQL 청산·고래 이력 R2 백필 및 중복 감사 (이번 단계 미포함).
- OI/funding을 이용한 다중 거래소 비교는 공급자별 단위 정규화 확인 후 별도 개발.
- 실제 Worker 배포 성공, API 인증, 수집 성공 여부는 각각 독립적으로 운영 검증.

## 공식 문서
- https://www.gate.com/docs/developers/apiv4/en/futures/
- https://www.gate.com/docs/developers/apiv4/en/
