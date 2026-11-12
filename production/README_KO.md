# Production Container 후보 — 자동 배포 연결 후 별도 활성화

**현재 GitHub 연결 화면에서는 반드시 저장소 루트(`/`)를 Root Directory로 사용**하세요. `production/`은 대량 연구를 켜는 **후속 배포**를 위한 프로젝트이며 운영 환경에서 검증되지 않았습니다.

## Cloudflare 측 준비
1. Workers Paid 활성화 (Containers 사용 필요)
2. R2 `lumex-ai-data` (비공개)
3. Queues `lumex-research-jobs`, `lumex-research-dead`
4. Cloudflare Worker Runtime Secrets: `LUMEX_ADMIN_API_TOKEN` (32+ chars), `LUMEX_AI_LAB_WORKER_TOKEN` (기존 Core의 64글자), `LUMEX_CONTAINER_KEY` (32+ chars, 새로 생성), AI 기능을 쓸 때만 `OPENAI_API_KEY`
5. Cloudflare Settings → Build에서 **Root directory를 `production`으로 변경**하고 `npx wrangler deploy` 실행. 이 조치는 Worker와 Container를 새 버전으로 배포하며 연구 기능은 전부 기본 OFF.

## 기능
- `/health` 누구나 조회: 자동 연구 OFF, 실주문 불가 표시
- `/status` 관리자 Bearer 키 필요: 연구 설정 및 WordPress 상태 확인
- `POST /enqueue` 관리자 Bearer 키 필요, `{"kind":"fetch","symbol":"BTCUSDT","interval_min":5}` / `{"kind":"research"}` / `{"kind":"ai","symbol":"BTCUSDT"}`
- Queues 작업 처리는 실행 토글에 의해 차단되며 기본적으로 **아무 작업도 하지 않음**
- `fetch`: Container에서 Bybit 90일 완료봉 수집→정합성 검증→R2 CSV 저장
- `research`: WordPress 연구용 작업 최대 10건 임대→R2 데이터 로드→Container Python 평가→Core 연구 결과 제출
- `ai`: WordPress Core 연구 예산 예약 후 OpenAI 전략 가설 제안

## 환경 변수
- `AUTO_FETCH="false"`: Bybit API 90일 수집 OFF
- `AUTO_RESEARCH="false"`: 자동 큐 처리 OFF
- `AUTO_AI="false"`: AI 호출 OFF

각 토글을 `true`로 바꾸기 전에 Bybit 접근·API 응답·R2 CSV 생성·WordPress Bearer 인증을 수동으로 검증하세요. `AUTO_RESEARCH` true면 5분마다 큐가 등록됩니다. `AUTO_FETCH`와 `AUTO_AI`는 별도로 승인된 큐 작업으로 호출하며 배포만으로 자동 실행되지 않습니다.

## 위험·미검증
- Cloudflare 실계정 Container/R2/Queues 통합 실행은 **미검증**입니다. GitHub 연결용 초기 단계가 아닙니다.
- 이 구조는 단일 Container, 단일 큐 소비자를 사용하는 1차 검증 설계입니다. 지속적 5,000건/일 처리량을 보장하지 않습니다.
- Bybit API HTTP 403, 최신 데이터 결손, 처리 도중 네트워크 실패 시 건너뛰고 성공으로 처리하지 않음.
- 모델 점수는 실거래 수익률 검증과 별개입니다. 거래소 주문·취소 기능은 존재하지 않습니다.
- Cloudflare 배포 오류 시 앱이 부분 배포될 수 있습니다. 기존 WordPress 주문 시스템에는 영향을 주지 않지만, Research Worker 롤백을 준비하세요.
