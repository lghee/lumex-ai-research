> **1.1.1 (2026-11-13):** Bybit HTTP 403 접근 거부가 실제 Cloudflare Container에서 확인되어, 공식 Binance USD-M 무기한 선물 Kline 공개 API 대체 수집을 추가했습니다. 동일 소스만 증분 갱신하며 공급자 전환 시 90일 이상 전체 이력을 재수집합니다. **실제 Cloudflare 환경의 Binance API 응답은 아직 미검증입니다.**

# LUMEX AI RESEARCH 1.1.1 — 실행 자동화 + 기존 GitHub/Cloudflare 유지

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
