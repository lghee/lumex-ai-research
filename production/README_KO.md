# LUMEX AI Research 1.1.0 — Cloudflare/GitHub/WordPress 실제 적용 가이드

## 원칙
- 운영 Worker: **`lumex-ai-research2`** (기존 프로젝트를 그대로 업데이트)
- GitHub 저장소: `lumex-ai-research`, 브랜치 `main`, Cloudflare 빌드 Root directory: **`production`**
- 워드프레스: 기존 Core 플러그인 버전 **0.5.05.20**으로 교체(별도 플러그인 생성 금지)
- R2: `lumex-ai-data`; Queue: `lumex-research-jobs`; Consumer: `lumex-ai-research2`
- 시스템 목적: **공개 코인 시세 기반 연구 백테스트**, 실주문/Bybit API 개인키를 사용하지 않음
- `AUTO_FETCH`, `AUTO_RESEARCH`, `AUTO_AI`는 Wrangler 설정에서 하드코딩하지 않으며 **기존 Cloudflare Dashboard의 설정을 유지**하도록 `keep_vars: true` 사용
- 소스 설치만으로 자동 연구를 켜지 않음. **기본 OFF**.

## 1. WordPress Core 먼저 설치

1. `https://lumexbot.com/wp-admin/` 관리자 로그인 (또는 전용 LUMEX 관리자에서 플러그인 업로드 메뉴 이용)
2. 플러그인 → 플러그인 추가 → 플러그인 업로드 → **`LUMEX_AI_CORE_0520.zip`** 선택
3. 같은 `lumex-core`가 설치돼 있다면 **현재 파일 덮어쓰기/교체** 확인; 설치된 기존 설정/DB/토큰은 삭제하지 않음
4. 관리자 → AI 전략 연구소 (`https://lumexbot.com/lumex-admin/?tab=ai-research`)에서 화면이 열리는지 확인
5. 처음에는 **대량 연구 큐 사용 / AI 가설 생성 사용 모두 해제**. 토큰 재발급을 누르지 마세요.

## 2. GitHub에 새 소스 배포

1. `LUMEX_AI_RESEARCH_GITHUB_110.zip`을 **PC에 압축해제**.
2. GitHub에서 기존 private 저장소 `lumex-ai-research`의 main 브랜치 파일을 갱신. **압축 내부 최상위 파일/폴더들을 업로드**(ZIP만 업로드 X).
3. `production/src/index.js`, `production/engine/lumex_ai_worker.py`, `production/server.py`, `production/wrangler.jsonc`, `production/tests`가 모두 반영됐는지 확인.
4. Cloudflare → Workers & Pages → **`lumex-ai-research2`** → **Deployments**에서 **새 배포 성공** 확인.
5. Settings → Builds → Git repository/Production branch/Root directory: **기존 GitHub / main / production** 을 유지. 배포 명령도 기존 `npx wrangler deploy --name lumex-ai-research2 --compatibility-date 2026-11-01` 그대로 사용 가능.
6. `https://lumex-ai-research2.kpiplus195.workers.dev/health` 접속 → `"version":"1.1.0"`, 모든 auto 토글 `false`, `trading_enabled:false` 확인.

## 3. 환경변수 / 비밀키 등록

Cloudflare → Workers & Pages → **lumex-ai-research2** → Settings → Variables and Secrets → **Add variable**.

| 이름 | 종류 | 값 / 조치 |
|---|---|---|
| `LUMEX_SITE_URL` | Variable | `https://lumexbot.com` 기존 설정 유지 |
| `LUMEX_AI_LAB_WORKER_TOKEN` | **Secret** | WordPress 기존 `lumex_ai_lab_worker_token_v1` 옵션값 64자리(별도 생성하면 WordPress와 불일치) |
| `LUMEX_CONTAINER_KEY` | **Secret** | 새 난수 최소 32자리. Container 호출 인증 전용 |
| `LUMEX_ADMIN_API_TOKEN` | **Secret** | 별도 새 난수 최소 32자리. `/status`, `/enqueue` 호출 인증 전용 |
| `OPENAI_API_KEY` | **Secret** | AI 가설 사용 시에만 필요; 시세·백테스트 전용 실행에 불필요 |
| `AUTO_FETCH` | Variable | 처음 `false`; 시세 연결 테스트 때만 `true` |
| `AUTO_RESEARCH` | Variable | 처음 `false`; WordPress 활성화·시세 확보 후 `true` |
| `AUTO_AI` | Variable | 처음 `false`; OpenAI 키·WP AI 설정 확인 후 `true` |
| `MAX_FETCH_PER_TICK` | Variable (선택) | 기본 1, 1~2 권장. 초반 전체 12조합 캐시가 없으면 첫 수집에 시간이 소요됨 |
| `RESEARCH_BATCH_SIZE` | Variable (선택) | 기본 12, 1~24 제한 |
| `RESEARCH_BATCHES_PER_TICK` | Variable (선택) | 기본 2, 1~2 제한 |

WordPress Worker 토큰은 웹페이지에 노출하지 않습니다. 호스팅 cPanel Terminal 또는 WP-CLI에서 WordPress 설치 디렉터리로 이동 후 다음 명령으로 조회합니다. 운영자 권한/SSH가 없는 경우 호스팅 관리자에게 보안 채널로 요청하세요.

```bash
wp option get lumex_ai_lab_worker_token_v1
```

**토큰은 GitHub, 스크린샷, 채팅, URL, 로그에 붙여넣지 마세요.** `LUMEX_CONTAINER_KEY`와 `LUMEX_ADMIN_API_TOKEN`은 서로 다른 값을 사용하세요.

## 4. 단계적 활성화

**A. 시세 자동 수집:** Cloudflare `AUTO_FETCH=true`, 나머지 false → 저장/Deploy. Cloudflare → Observability → Events (기간 Last 1 hour)에서 `lumex_scheduler`, `market_fetches` 로그 확인. R2 → `lumex-ai-data` → Objects → `market/BTCUSDT_5.csv` 등 생성 여부 확인. 모든 12개 조합은 순차로 초기 적재되어 첫 Cron만으로 완료되지 않을 수 있습니다.

**B. 자동 연구:** LUMEX 관리자 → AI 전략 연구소 → **대량 연구 큐 사용** 체크 후 저장. 다음으로 Cloudflare `AUTO_RESEARCH=true`. 5분 예약 실행 후 관리자에서 **마지막 큐 생성**, **처리 중**, **완료**, **Cloudflare Worker 최근 실행** 확인. Cloudflare Observability에서 `processed`/`released` 확인. R2 시세가 없으면 작업을 잘못 평가하지 않고 보류합니다.

**C. AI 가설 반복:** WordPress 연구소 → **AI 가설 생성 사용** 체크; Cloudflare OPENAI_API_KEY 설정 후 `AUTO_AI=true`. WP의 시장 컨텍스트가 실제 갱신 중이어야 하며 AI 결과는 **최대 6시간 간격 한 번**(실패 시 30분 재시도 간격) 생성합니다. 지난 OOS·비용증가·진입지연 결과를 힌트로 사용하고 새 DSL 규칙으로 다시 백테스트합니다. 월/일별 OpenAI 비용 상한은 WP 연구소 설정이 우선합니다. AI 후보는 실주문으로 자동 등록하지 않습니다.

## 5. 실제 동작 경로 및 확인방법

1. Cron (5분): `scheduled` → Queue `orchestrate`
2. Worker: 12개 R2 캔들 캐시의 **완료봉 시각**·파일 크기 검사
3. 필요 시 Container `POST /fetch` → 최초 약 92일 전체/이후 증분 공개 Bybit 데이터 → 유효성 검사 → R2 CSV 덮어쓰기
4. WordPress `research-lab/tick`: 연구 조합 100개까지 등록, 400건 이상 대기 시 backpressure, 최대 일일 목표 설정 준수
5. Worker는 **준비된 마켓만** `research-lab/jobs?markets=...`로 임대
6. Container `POST /evaluate` → train 60일 이상 + OOS 30일 + 비용 두 배 + 한 봉 지연 테스트
7. `results` 제출 → WP 완료/후보 저장. 평가/인프라 실패면 `release` 호출, 180초 대기 후 재시도(최대 3회)
8. AI 허용 시 `context → reserve → OpenAI Responses JSON Schema → suggestions → commit` 반복. 결과 이력을 다음 AI 가설의 입력으로 포함
9. Worker R2 `control/research-scheduler-v1.json`에 최근 실행/오류 저장, WordPress `telemetry`를 통해 관리자 상태 표시

## 6. 정확한 문제별 진단

- **Cron 성공인데 백테스트 0**: AUTO_RESEARCH false, WP 연구 큐 체크 해제, R2 `ready_markets=0`, 또는 WordPress 인증 토큰 누락 가능성. Observability의 `lumex_scheduler` 요약을 확인.
- **`container_key_not_configured`**: Worker Secret에 `LUMEX_CONTAINER_KEY` 등록하지 않음.
- **`research_token_not_configured` / `wordpress_tick_401`**: `LUMEX_AI_LAB_WORKER_TOKEN` 누락 또는 WordPress와 불일치.
- **`container_fetch_422` / `bybit_unavailable_or_rate_limited` / `HTTPError`**: Bybit HTTP 지역 제한/429, 응답 결손 등. R2 이전 정상 파일은 유지, 새 파일 교체 안 함.
- **`no_fresh_market_data`**: R2에 최소 90일+250봉 또는 최근 완료봉이 부족함. 연구 작업을 강제로 오류 처리하지 않음.
- **`research_*` 오류**: REST 인증·WordPress 연결/DB·Container 평가 결과를 분리 조사.
- **AI 실행 없음**: 6시간 제한, Worker OPENAI_API_KEY, WP AI 토글, 최신 시장 컨텍스트, 비용 한도 점검.
- **Queue에 메시지 계속 쌓임**: Queues → lumex-research-jobs → Metrics → Backlog, Consumer 상태 확인. 코드에서는 토글 OFF 시 새 Cron을 발행하지 않지만 이미 대기 중인 메시지는 소비/skip 될 수 있음.
- **상태 확인**: `/status`는 Cloudflare 관리자 Secret Bearer 인증이 필요. `/health`에 실제 R2 데이터/전략 완료 증거는 없음.

## 7. 비상 정지/복구

1. Cloudflare Worker → Settings → Variables and Secrets에서 `AUTO_FETCH`, `AUTO_RESEARCH`, `AUTO_AI` **모두 false** 저장.
2. WordPress 연구소에서 연구/AI 체크 해제(기존 완료 결과 및 데이터는 보존).
3. 데이터가 훼손됐다는 근거가 없으면 R2/Queue/DB 절대 삭제하지 않음.
4. 이전 Worker GitHub commit으로 `production/`만 되돌리고 `main`에 다시 커밋; Cloudflare 배포 확인.
5. WordPress Core가 원인이면 기존 제공된 **0.5.05.19 ZIP**을 설치/교체(단, 이전 API에는 `release`·`telemetry`가 없어 새 Worker 자동 연구 ON과 함께 사용하면 안 됨).
6. 비밀키가 외부 유출된 경우에만 교체. WordPress 토큰 재발급 시 Cloudflare Secret도 같은 새 토큰으로 갱신 필요.

## 8. 검증 범위

- PHP 문법 검사, Node Worker 흐름 모의 통합 테스트, Python 증분/갭/백테스트 합성 데이터 테스트는 수행.
- **미검증**: 실제 Cloudflare 컨테이너 기동·Bybit 공개 API 수집 성공·운영 WordPress/MySQL REST 왕복·OpenAI 결제 호출·5,000건/일 실제 처리량·실거래 수익성.
- Auto Research가 실주문/실계정 전략을 활성화하지 않도록 분리 유지.
