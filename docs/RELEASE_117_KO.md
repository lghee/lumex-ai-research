# LUMEX AI Research 1.1.7 — AI HTTP 403 진단 및 재시도 상태 수정

## 수정 범위
- 기존 Core 0.5.05.22 변경 없음. 기존 연구·시그널·주문 데이터 변경 없음.
- GitHub/Cloudflare 소스 수정: `production/engine/lumex_ai_worker.py`, `production/server.py`, `production/src/index.js`, 동일한 루트 `src/index.js`, 버전 및 테스트.
- 외부 HTTP 실패를 `wordpress_context`, `wordpress_ai_reservation`, `openai`, `wordpress_suggestions` 단계로 구분. HTTP 상태와 안전하게 필터링한 upstream 오류 코드만 기록. 전체 URL, 인증 헤더, API 키, 원문 오류 메시지는 기록하지 않음.
- Container 외부에서 포착된 예외의 원격 호스트를 `wordpress/openai/other`로만 표시해 오류 발생 시스템을 분리.
- AI 호출 실패 뒤 `cooldown`이어도 직전 실제 실행 실패를 `lastAttempt/error`로 함께 기록하고 R2 상태에 유지.
- AI 결과 `ok:true`이지만 WordPress 수락 후보가 0개인 응답을 **실제 성공으로 간주하지 않음**. 기존 30분 실패 제한 및 6시간 성공 제한 유지.
- 지표·실거래·고객 시그널·백테스트 심사조건·Cron·R2/Queue/Secret 설정 변경 없음.

## 사용자가 제공한 운영 로그 (2026-11-13 KST)
- `aiAttempts=1794543537757` = 13:18:57 KST
- 재시도 예정 `1794545337757` = 13:48:57 KST (실제 실행 여부는 운영 로그 확인 필요)
- 직전 AI 오류 `ai_container_ai_422_HTTP_Error_403__Forbidden` — HTTP 403의 정확한 대상은 기존 로그로 확정 불가
- `aiLastOk=false`, `aiLastResult= cooldown` — 전략 생성 성공 증거 없음
- 시장 데이터 성공 누적 47 / 실패 누적 42, 검증 시장 5 / 12
- ETH/SOL/XRP 60m `cross_frame_15m_60m_mismatch` — 기존 품질 차단 유지. API 접근 오류와 별개.

## 설치 방법
1. 현재 GitHub `main`과 Cloudflare Worker 배포를 백업한다.
2. ZIP 내부 파일을 기존 GitHub 저장소 **같은 경로**에 반영한다. Cloudflare 빌드 루트는 `production`을 유지한다.
3. `main`에 Commit하여 GitHub 자동 배포를 실행한다.
4. Cloudflare `Workers & Pages → lumex-ai-research2 → Deployments`에서 새 버전 성공 확인.
5. `/health`에서 `version: 1.1.7` 확인.
6. Cron·Runtime secrets·cPanel Cron·WordPress Core는 다시 설정하지 않는다.
7. R2 `lumex-ai-data/control/research-scheduler-v1.json`의 `aiLastExecution`, `aiLastResult.error`, `lastSummary.ai`에서 **새로운 실행 기록**을 확인한다.
8. `WordPress 관리자 → AI 전략 연구소`의 `AI 최근 실행 오류`에서 새로 구분된 오류 상태를 확인한다.

## 결과 해석
- `wordpress_context_http_403`: WordPress `context` 조회 거부. WP/Cloudflare WAF 및 REST 접근 검사.
- `wordpress_ai_reservation_http_403_lumex_ai_lab_ai_disabled`: WordPress AI 사용 제한이 반환한 403. 설정값 확인. 유사한 `lumex_ai_lab_*` 코드는 WP 정책 단계.
- `openai_http_403` 또는 `openai_http_403_<provider_code>`: OpenAI Responses API 단계 접근 거부. API 프로젝트·권한·지역 정책 확인.
- `wordpress_suggestions_http_403`: 생성 후 후보 저장 API가 거부됨.
- `wordpress_unhandled_http_403` 또는 `openai_unhandled_http_403`: Container 외부에서 잡힌 예외, 해당 원격 호스트를 표시.
- `cooldown`과 함께 `error`: 직전 실패 사유를 잃지 않고 유지.
- `ai_zero_candidates_accepted`: AI 응답은 성공 표시됐으나 WordPress가 신규 후보를 하나도 수락하지 않음.

## 보안 및 비용
- 비밀키 값을 복사하거나 변경할 필요 없음. API 키를 GitHub에 올리지 말 것.
- 인증 우회 및 WAF 전역 비활성화를 하지 말 것.
- AI 호출은 유료일 수 있으며, WordPress 예약/커밋 정책과 기존 스케줄러 호출 제한을 유지.
- AI 원인 진단이 끝나기 전 전략의 실거래 자동 승격 금지.

## 검증
- Python unittest 28개 통과 (신규 HTTP 단계 분리/응답 코드 안전성 포함).
- Worker 생산·품질·1분 수집·포워드·AI 대기 상태 모의 테스트 통과.
- 실제 Cloudflare Container/WordPress/OpenAI 운영 요청은 이번 패키지로 수행하지 않았으므로 운영상 성공을 주장하지 않음.
