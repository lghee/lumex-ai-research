# LUMEX AI Research 1.1.9 — 검증된 R2 시장 증거로 AI 연구 연결

## 원인
1.1.8은 R2에 최신 검증된 15분봉 시세가 있어도 WordPress의 별도 `lumex_market_snapshot_..._15` 갱신 시각이 15분을 넘거나 지표 등급이 scored/partial이 아니면 AI 호출 전에 `ai_context_stale_market`으로 중단했습니다.
WordPress Cron과 Cloudflare 시세 Cron은 독립적이므로 이 조건은 불필요한 결합입니다.

## 변경
- AI는 WordPress REST 인증·연구 이력 조회를 그대로 수행합니다. 인증 403은 우회하지 않습니다.
- R2 15분봉 `ohlcv_v2 / verified`, 90일+워밍업, 최신 확정봉, 정상 행/시간순, 동일 메타데이터를 다시 검사하고 시장 요약을 만듭니다.
- AI 입력: 실제 시세 출처, 최근 확정봉, 24시간 변동률, 15분 실현 변동성 및 평균 거래량, 마지막 확정봉 12개.
- WordPress 지표가 오래된 경우 지표를 최신 수치처럼 보내지 않고 `stale_wp_not_used`로 표시합니다. WordPress 과거 연구/시그널·지표 관측 이력은 참고용으로 유지합니다.
- 모델과 WordPress 예약/월·일 사용 한도/정산, 30분 실패·6시간 성공 제한은 유지합니다.
- 분당 1회 수집, 5분 연구·AI 점검, R2 품질 기준 및 실거래 주문 엔진은 변경하지 않습니다.
- 시장 데이터 전용 Python Container에 더는 OpenAI API 키를 전달하지 않습니다. OpenAI 요청은 Worker 전용입니다.

## 보안 및 데이터 무결성
- 미검증·오래된 R2 데이터, 누락 파일, 메타데이터/행 수 불일치, 비정상 OHLC, 진행 중 캔들은 AI 생성 차단.
- WordPress 인증 실패, API 제공처 403, 예산 제한은 우회하지 않음.
- AI 연구 후보는 기존 WordPress `suggestions` API로 등록될 뿐 승인/고객 시그널/실주문으로 자동 승격되지 않음.
- API 키/토큰 전체 값/원시 오류 응답은 GitHub나 로그에 기록하지 않음.

## 테스트 및 결과
- Python 기존 28개 단위 테스트 통과.
- JavaScript Worker·시장 품질·1분 수집·포워드 테스트 통과.
- 1.1.8 AI 테스트 보강: WordPress 403 차단, OpenAI 403 단계 구분, 성공·예산 정산, WordPress 스냅샷 지연 시 R2 기반 AI 경로, R2 CSV 누락 시 OpenAI 미호출.
- 운영 `/health`에서 배포 버전 확인은 GitHub main 병합 후 별도로 수행.
- 운영 OpenAI 실제 API 과금·후보 등록까지 성공했다고 주장하지 않음.

## 배포
GitHub `lghee/lumex-ai-research`의 `main`에 병합 후 Cloudflare 자동 배포를 확인합니다.
Worker: `lumex-ai-research2`, 빌드 루트: `production`.
WordPress Core 0.5.05.22, cPanel Cron, Secrets, R2, Queue 설정 변경 없음.

## 다음 진단
운영 AI 재시도 성공: WordPress AI 연구소의 AI 마지막 후보 수가 1개 이상, R2 `control/research-scheduler-v1.json`의 `aiLastExecution` 상태가 `completed`, `accepted` 1 이상.
실패시 동일 파일 `aiLastExecution.error`로 HTTP 403, 예산, 데이터 품질 및 후보 수락 오류를 구분합니다.
