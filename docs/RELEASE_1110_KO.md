# LUMEX AI Research 1.1.10 — 이전 Container AI 403 상태 복구

## 확인된 원인
사용자 관리자에 반복 노출된 `container_ai_422_HTTP_Error_403__Forbidden` 오류는 1.1.7 이하의 Python Container AI 네트워크 호출 방식에서 생성된 과거 상태입니다. 1.1.8~1.1.9의 신규 AI 호출은 Cloudflare Worker에서 직접 이뤄지므로 해당 컨테이너 오류를 새로 생성하지 않습니다.

구버전 실패 후 Scheduler의 `aiLastExecution`에 남은 과거 오류가, 신규 Worker의 `cooldown`에서도 그대로 `AI 최근 실행 오류`로 전달됐습니다. 그래서 최신 배포 후에도 이전 오류가 현재 실패처럼 보였습니다.

## 1.1.10 수정
- 이전 `container_ai_...`, `ai_container_ai_...` 실패가 남아 있는 경우에만 새 Worker AI 경로로 단 한 번 복구 재시도합니다.
- AI가 비활성, OpenAI 키 없음, 검증된 15분봉 없음이면 복구하지 않습니다.
- 복구 재시도에도 WordPress 인증/시장 자료 조회와 연구 예산 예약을 생략하지 않습니다. 유료 API 요청이 실제 수행되면 WordPress 월·일 한도 내에서 정산됩니다.
- 상태의 `aiLegacyRecoveryVersion`을 **호출 전에** 1.1.10으로 기록하여 같은 이유로 복구 호출이 반복되지 않게 합니다.
- 새 AI 실행 이력에 `workerVersion`, `route: worker_direct`, `recoveredLegacyError`, `attemptedAt`, `state`, `error` 등을 기록하고 과거 Container 실패 코드를 대체합니다.
- 새로 실패하면 30분 대기, 성공이면 6시간 대기를 정상적으로 적용합니다. 다른 실패와 성공 상태의 기존 쿨다운을 절대 우회하지 않습니다.
- 과거 오류 리스트를 삭제하거나 기존 연구·백테스트·시그널·거래 데이터를 초기화하지 않습니다.
- SOL/ETH/XRP 15분/1시간봉 교차 검증 불일치는 별도의 데이터 품질 문제이므로 무시하지 않습니다.

## 변경 파일
- `production/src/index.js`, `src/index.js`
- `production/tests/test_118_worker_ai_direct.mjs`
- `VERSION.txt`, `production/package.json`, README
- `docs/RELEASE_1110_KO.md`

## 테스트
- 레거시 Container AI 오류 → Worker 직접 재시도 → 새로운 WordPress 단계 오류로 교체 확인
- 동일 호출 이후 중복 재시도 없는 쿨다운 확인
- 신규 OpenAI API 실패와 일반 오류에 대한 기존 쿨다운 유지
- 실제 API 키, 토큰, WordPress DB/설정 변경 없음
- GitHub Actions offline-qa가 통과한 경우에만 main으로 병합

## 운영 검증
GitHub `lghee/lumex-ai-research` → Cloudflare Worker `lumex-ai-research2` (build root `production`) 자동 배포.
`/health` 버전 1.1.10 이후 WordPress AI 연구소의 `AI 최근 실행 오류`에 새 코드가 나타나는지 확인합니다.
`control/research-scheduler-v1.json`에서는 `aiLastExecution.workerVersion = "1.1.10"`과 `route = "worker_direct"`가 새로운 실행의 증거입니다.
실제 WordPress AI 후보 1건 이상 생성 여부는 운영 호출 결과가 있어야만 확정할 수 있습니다.

## 보안 및 비용
AI 유료 과금이 발생할 수 있으므로 기존 WordPress 예약/정산·일/월 한도 안에서만 수행됩니다. 사용자 제공 Cloudflare Secrets와 WordPress 토큰 값은 수정하거나 로깅하지 않습니다. 실거래 주문과 고객 시그널 생성 경로는 변경하지 않습니다.
