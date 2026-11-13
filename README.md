> **1.2.2:** confirmed BTC reserve-address onchain net transfers via Esplora public API, checkpointed Cloudflare DO polling, WordPress watchlist sync (new Core 0.5.05.24), immutable R2 archive audit. Existing public Gate/Bybit streams and trading safety unchanged. See docs/RELEASE_122_KO.md.

> **1.2.1:** Gate USDT futures public trades/tickers (sampled) + Bybit V5 public allLiquidation observed data collector in Cloudflare Durable Object; reconnect/heartbeat/lag status, typed observed events → existing MarketEventHub → R2. No exchange API keys, orders or fictitious liquidation fills. See `docs/RELEASE_121_KO.md`.

> **1.2.0 (2026-11-13):** Cloudflare Market Hub 기반 기능 도입. 검증된 R2 캔들·코인 레이더 읽기, 서명된 PRO WebSocket 연결, 청산·고래 공개 관측 데이터용 Durable Object 중복방지·R2 원본 누적 아카이브. 거래소 상시 스트리밍 수집은 아직 별도 연결이 필요하며 자동매매 주문은 변경하지 않습니다. 상세: `docs/RELEASE_120_KO.md`.

> **1.1.10 (2026-11-13):** 오래된 Container AI HTTP 403 실패가 새 Worker의 쿨다운과 관리자에 남는 문제를 수정. 레거시 오류에 한해 Worker 직접 경로 1회 복구 재시도를 수행하며 버전·경로·결과를 기록합니다. 사용료/예약 제한·기타 재시도 제한과 시세 검증은 유지. 상세: `docs/RELEASE_1110_KO.md`.

> **1.1.9 (2026-11-13):** AI 가설 생성에서 WordPress 시장 스냅샷의 갱신 지연이 R2 검증 시세를 무조건 차단하던 조건을 수정. 15분봉 검증 완료 R2 데이터를 직접 읽어 시장 요약을 구성하며, WordPress 지표가 오래됐을 때는 연구 이력만 참고합니다. 권한·예산·실거래 안전장치 유지. `docs/RELEASE_119_KO.md` 참고.

> **1.1.8 (2026-11-13):** AI 가설 생성 HTTP 요청을 Python Container에서 Cloudflare Worker로 이전. WordPress 예약/정산과 재시도·비용 제한 유지, 원인별 HTTP 오류 진단 및 연구 전용 실행. 상세: `docs/RELEASE_118_KO.md`.

> **1.1.4 (2026-11-13):** 실제 운영에서 `Gate.io` → Cloudflare Container → R2의 BTC 15분봉·1시간봉 CSV 저장 성공을 확인했습니다. 하지만 전달된 두 CSV에서 페이지 경계와 최근 구간의 0거래량·동일 OHLC 캔들이 발견됐습니다. 이번 릴리스는 Gate 페이지 오버랩·의심봉 재조회·빈 구간 재조회·완성봉/90일 검증·같은 공급자의 15분/1시간봉 교차 검증, `ohlcv_v2` 품질 메타데이터를 추가합니다. **검증 이전 R2 파일은 연구 대상에서 자동 제외됩니다.** 운영 환경에서 재조회가 성공했는지는 새 버전 배포 후 확인 필요합니다.

> **1.1.3 (2026-11-13):** 실제 운영 로그에서 Bybit 403, Binance 451, Gate 400 확인. 1.1.2 코드가 Gate의 모든 HTTP 400을 `access_restricted`로 잘못 분류함을 정정. Gate 오류 본문에서 제한된 오류 필드만 읽고, 문제가 발생한 경우 2개 캔들 요청으로 짧게 진단하여 R2 실패 코드에 남깁니다. **이 릴리스는 데이터 접근 복구가 아니라 원인 분류용이며 실제 수집 성공은 확인되지 않았습니다.**

> **1.1.3 (2026-11-13):** R2 시세가 저장되지 않는 문제를 재점검하여 Bybit/Binance IP 접근 거부 시 Gate.io 공식 USDT 무기한 선물 OHLCV를 추가했습니다. 성공·실패 모두 `control/last-market-fetch.json` 및 종목별 진단 JSON에 기록합니다. **운영 Cloudflare에서 실제 성공 여부는 아직 확인하지 못했습니다.**

# LUMEX AI RESEARCH 1.1.4 — 실행 자동화 + 기존 GitHub/Cloudflare 유지

**2026-11-13 업데이트. 현재 사용자의 실 배포 프로젝트는 `lumex-ai-research2`이며 Cloudflare Build의 Root directory는 `production` 입니다.** 기존 Worker를 삭제하거나 이름을 바꾸지 마세요.

## 저장소 구조

- `production/src/index.js` — **현재 배포되는** Cloudflare Cron / Queue / R2 / Container 자동 실행 코드
- `production/engine/lumex_ai_worker.py` — 시장 데이터 검증, 증분 갱신, 전략 백테스트, OpenAI 가설 생성
- `production/server.py` + `production/Dockerfile` — Container 웹 API
- `production/wrangler.jsonc` — 실제 `lumex-ai-research2` 배포 설정 및 `keep_vars=true`
- `production/tests` — 실제 운영 계정을 호출하지 않는 테스트
- `src/`, `research/`, 루트 `wrangler.jsonc` — 최초 연결 검증을 위한 **과거 bootstrap 보존 소스**. 현재 배포에는 사용되지 않음.

## 안전한 적용 순서

1. **먼저** `LUMEX_AI_CORE_0520.zip`을 WordPress의 기존 LUMEX Core에 덮어 설치합니다. 플러그인 추가 설치가 아닙니다.
2. 이 ZIP의 **최상위 파일/폴더 내용 전체**를 기존 GitHub `lumex-ai-research` 저장소의 `main`에 반영합니다. ZIP 파일을 GitHub에 그대로 올리지 마세요.
3. Cloudflare → Workers & Pages → `lumex-ai-research2` → Settings → Builds 에서 **Root directory `production`**, Production branch `main`, 기존 Deploy command가 `wrangler deploy ...`인지 확인합니다. 현재 연결은 그대로 유지합니다.
4. GitHub 변경 후 Cloudflare → Deployments에 새 버전이 성공했는지 확인합니다. 비활성화된 자동 실행 환경변수는 기본적으로 계속 `false`입니다.
5. Cloudflare → Settings → Variables and Secrets 에 필요한 비밀키를 등록하고, **시세 갱신만 먼저 활성화**합니다. Worker의 연구/AI 토글은 단계적으로 활성화합니다.
6. `/health`는 인증 없이 버전·토글만 표시하며 `/status`는 별도 관리자 Bearer로만 읽을 수 있습니다. `LUMEX_ADMIN_API_TOKEN`을 URL에 넣지 마세요.

**전체 메뉴 경로, 상태 기준, 장애 시 복구 절차, 비용 통제:** `production/README_KO.md` 및 배포 패키지에 포함된 인수인계서를 참고하세요.

## 검증 (실계정 호출 없음)

```bash
cd production
npm run check
```

`npm run check`는 Node Worker 가짜 R2/Queue/WordPress 테스트 + Python 실계산 합성 OHLCV 백테스트/시세 증분 테스트입니다. 실제 Cloudflare/Bybit/OpenAI/WordPress 통합 성공을 의미하지 않습니다.

**주의:** 활성화되어도 연구는 주문 실행과 무관하며 전략 후보는 실거래 가능 판정이 아닙니다. CPU/요금과 가용성은 실제 계정 테스트가 필요합니다.


## 1.1.5 통합 운영 참고
- Cloudflare 1분(시장) + 5분(연구) Cron, Core 0.5.05.21과 함께 사용
- 상세 내용: docs/RELEASE_115_KO.md

## 1.1.7 운영 참고
- Cloudflare 1분 시장 점검, 5분 연구/AI/포워드 관측 Cron. WordPress Core **0.5.05.22** 선설치 필요.
- R2 `collecting` 품질 5분봉은 백테스트 금지, Gate 10,000 최근봉 한계와 누적 이력 보호.
- AI 미호출 원인과 `failed_gate` 탈락 사유는 관리자에서 확인. paper-forward 원장은 체결·손익·고객 시그널이 아닙니다.
