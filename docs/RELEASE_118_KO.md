# LUMEX AI Research 1.1.8 — Worker 직접 AI 요청 전환

## 배경
1.1.7 운영 환경에서 시장 수집·연구 큐·WordPress 텔레메트리는 작동했으나 AI 요청이 Python Container 경로에서 `HTTP 403` 오류로 실패했습니다. 403의 정확한 반환 주체는 기존 로그만으로 확정되지 않았습니다.

## 변경 내용
- AI 요청을 Cloudflare Worker로 이전: WordPress 시장 자료 조회 → AI 호출 예약 → OpenAI Responses API 요청 → WordPress 신규 전략 후보 저장 → 사용량 정산.
- WordPress Core 0.5.05.22 및 DB 구조는 변경하지 않습니다.
- 검증된 최신 15분봉과 WordPress 시장/지표 데이터 신선도 조건을 충족할 때만 AI를 호출합니다.
- API 모델, 출력 토큰 제한, 일별/월별 호출 예산은 WordPress의 예약 계약을 따릅니다.
- HTTP 오류를 `ai_context_*`, `ai_reserve_*`, `ai_openai_http_*`, `ai_suggestions_*`로 구분해 R2 상태에 기록합니다.
- AI 실패 시 재시도 30분, 성공 시 재시도 6시간. `{"kind":"ai"}` 수동 큐 메시지도 해당 제한을 우회하지 못합니다.
- 후보 0건은 생성 성공으로 처리하지 않습니다. 실거래 주문·고객 시그널은 생성하지 않습니다.

## 변경 파일
- `production/src/index.js`, `src/index.js`
- `production/package.json`, `VERSION.txt`
- `production/tests/test-production.mjs`, `production/tests/test_117_ai_cooldown.mjs`, `production/tests/test_118_worker_ai_direct.mjs`
- `docs/RELEASE_118_KO.md`, README 문서

## 점검
- 로컬 패키지: JavaScript 문법 검사, Worker HTTP 403 구분, 예약 정산·후보 승인·쿨다운 테스트 통과.
- GitHub PR의 검사 결과도 확인 후 main에 반영합니다.
- 실제 WordPress/OpenAI 운영 호출 성공 및 Cloudflare 배포는 별도로 확인해야 합니다.

## 운영 주의
- Cloudflare Worker `lumex-ai-research2` 및 Root directory `production` 유지.
- R2, Queue, Cron, Runtime Secret, 주문 엔진, WordPress Core 설정은 변경하지 않습니다.
- `/health` 버전은 `1.1.8`인지 확인하고, R2 `control/research-scheduler-v1.json`의 `aiLastExecution`에서 실전 성공/실패를 구분합니다.
- ETH/SOL/XRP의 15m/60m 시세 불일치는 이번 AI 패치 범위가 아니며 기존 데이터 검증 차단을 유지합니다.
