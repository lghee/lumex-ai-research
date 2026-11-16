# LUMEX Binance 무료 공개 데이터 복구 — 2026-11-16

## 요구
유료 API 구독 없이 Binance의 5개 거래소 비교 항목을 채운다. 임의의 거래소 수치를 Binance로 표시하는 것은 금지한다. 기존 Cloudflare Workers+R2 기반 5분 Cron, Core 0.6.32, Theme 0.5.05.48 구조를 유지한다.

## 실제 확인한 실패
GitHub Actions Read-only 검사 https://github.com/lghee/lumex-ai-research/actions/runs/43787628335 에서 Binance 공식 REST 3개 모두 HTTP 451(위치 제한). 단순 GitHub 또는 Cloudflare 서버 교체로 해결되지 않음.

## 무료 대체
Swolecharts 공개 문서 https://swolecharts.com/developers
- API 사용료 $0, 인증 키 불필요.
- 공개 문서는 30회/분(클라이언트별) 및 캐시 준수, 화면 출처 링크 명시 요구.
- 데이터와 차트는 출처 링크를 표시해 게시 가능하되 **원시 데이터 피드로 재판매·재배포하는 것은 금지**. LUMEX는 고객이 웹 대시보드에서만 보게 하고 별도 대량 다운로드·대행 API로 제공하지 않는다.
- 추가 요금/회원가입/Cloudflare Secret 설정 없음.

## 실시간 실제 확인 (API 직접 응답)
- BTCUSDT: 롱/숏 계정 비율, USD OI, 8h 기준 펀딩비 (정확한 Binance USDT 계약).
- ETHUSDT 롱·숏, SOLUSDT OI, XRPUSDT 펀딩도 실제 응답 확인.
- 반드시 `market=binance:perp:BTCUSDT`처럼 계약 단위 선택. `base=BTC&venue=binance`는 BTCUSDC 및 COIN-M까지 합산될 수 있어 사용 금지.
- `GET /api/series/long-short?market=binance%3Aperp%3ABTCUSDT&kind=accounts&range=2h&step=5m`
- `GET /api/series/oi?market=binance%3Aperp%3ABTCUSDT&range=2h&step=5m`
- `GET /api/series/funding?market=binance%3Aperp%3ABTCUSDT&range=2h&step=5m`
- 시각 Unix ms, OI USD, 계정 롱 비중 0~1, 펀딩 8h 분율; LUMEX UI에서는 각각 %, USD, %로 정확하게 변환.

## 구현
- `production/src/swolecharts-binance.mjs` 서버측 새 어댑터. 키/유료 API 없음.
- `production/src/exchange-compare.mjs` Binance 공식 API 451/빈 필드 발생 시에만 검증된 백업 수치 추가.
- 적용 우선순위: Binance 공식 공개 API의 실제 유효값 우선 → Swolecharts exact market 무료 백업 → 명시적으로 승인된 Coinalyze 선택사항.
- 완료되지 않은 수집주기는 그대로 null, 추정/0/다른 거래소 데이터 금지.
- 출처: `source=swolecharts_binance_...`, `vendor=Swolecharts`, `attribution='Data by Swolecharts'`, `attribution_url=https://swolecharts.com/developers`, Binance 원거래소 유지.
- 저장 구조 R2 latest/history 기존 키·스키마 유지, WordPress Core 기존 검증 통과.
- WP 테마는 Binance 수치가 Swolecharts 유래일 때 5개 거래소 비교 카드 하단에 출처 링크 표시하도록 별도 0.5.05.49 테마 ZIP에 반영.
- 시장 방향 합성, 실제 주문, 전략 연구, 사용자의 계정/결제 Cron은 변경하지 않음.

## 수집 빈도
기존 Cloudflare `*/5` Cron에서 BTC+ETH / SOL+XRP 각 2코인 10분 주기 목표. 기존 인증 Bearer → WordPress REST → PRO UI.
소스 내부 5분 관측, 일부 지연 허용 최대 25분. 지연시 이전 관측 별도 표기, 현재 수치 조작 금지.

## 검증 단계
1. GitHub `production/tests/test_free_binance_20261116.mjs`: 451 모의, 원거래소 계약 검사, stale/fake 차단, 3지표 파서, R2 출처·누락·무주문 확인.
2. GitHub CI 전체 소스 통과 후 PR main 병합.
3. GitHub 수동 Worker deploy, WordPress Theme 0.5.05.49 설치.
4. 실제 Worker 인증된 `exchange-compare-health`와 `exchange-compare?symbol=BTCUSDT` 조회, Swolecharts API 429 여부 확인.
5. 모바일 Binance의 롱·숏·OI·펀딩·출처 링크 노출 확인, 4개 종목·2회 이상 Cron에서 데이터 갱신 검증.

## 유의
무료 소스는 제3자 서비스이며 SLA가 없음. 응답이 오래되거나 막히면 정상값을 발명하지 않는다. 무료라서 서비스 가용성이 100% 보장되는 것은 아니다.
