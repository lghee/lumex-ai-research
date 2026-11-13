# LUMEX AI Research 1.1.6 / LUMEX Core 0.5.05.22
작성: 2026-11-13 · 연구/관측 전용 · 운영서버 신규 버전 미배포

## 우선 결론
- 전 버전 기준 운영 스크린샷: 연구 완료 125, 대기 175, 채택 후보 0, 검증 시세 4/12, OpenAI 실행 0회. 새 버전 배포 전 기록이며 성공률로 보지 않음.
- 실제 수정 대상: 5분봉 최초 수집 400 응답, 누적 데이터 장기 보존, AI 비활성 원인 공개, 탈락 전략 이유/파라미터 표시, 승인 후보만 종가 방향 관측, 시그널/지표 최근 관측 시각 표시.
- **실시간 WebSocket 체결/호가, 실제 포워드 주문/체결/손익, 고객 시그널 자동 발행, 실거래 자동 승격은 미개발**. 의도적으로 기존 주문/고객 신호 원장 코드는 변경하지 않음.

## 변경 상세
### 1. 5분봉 Gate.io 조회 실패 대응
`production/engine/lumex_ai_worker.py` / `research/lumex_ai_worker.py`
- 초기 32일+250봉 요청이 명시적 **400 Candlestick too long ago** 로 거절되면 28→24→21→17일 범위로 다시 요청. 403·451·파라미터 오타 400은 이 경로로 우회하지 않음.
- 최초 14일+250봉 이상 정상·연속·완성 캔들이 필요; 초기 17~32일은 `quality=collecting` 이며 연구 불가. 기존 Worker 측 검증도 14일 인입만 허용하되 `quality=verified`는 종전대로 **90일+250봉** 유지.
- 누적 5분봉이 900봉 이상 비었다고 즉시 짧은 과거 이력으로 덮어쓰지 않음. 5,000봉 이하 누락은 1,999봉 이하 중첩 페이지로 복구. 5,000봉 초과는 `gate_5m_outage_exceeds_safe_recovery`로 실패하고 기존 저장본 유지.
- 거래소가 제공하지 않는 오래된 캔들, 빈 봉, 거래량 0 가상 봉 등 생성 금지. 데이터 공급자 교체 시에도 혼합 금지.
- 현재 Gate.io 최근 10,000봉 한계 때문에 5분봉 90일을 **즉시 확보할 수 없음**. 앞으로 연속 수집되면 축적 가능. 배포 후 R2 `market/`에서 수집 품질을 확인해야 함.

### 2. AI 가설 생성의 원인 보고
`production/src/index.js` / `src/index.js`, `lumex-core/includes/class-lumex-ai-research-lab.php`, Python `ai_ideas`.
- 미실행 이유 구분: `disabled_in_cloudflare`, `openai_key_missing`, `no_verified_15m_market`, `cooldown`, `failed`, `completed`.
- API/WordPress 오류는 민감 응답/토큰 없이 상태 코드만 보고. WordPress 관리자 `최근 Worker 실행`에 AI 상태·최근 오류·받아들인 아이디어 수 표시.
- 검증된 15분봉이 있어야 AI가 WordPress의 시장·시그널·지표 컨텍스트 기반으로 가설 생성 시도. 모델·API 사용료·월 한도는 WordPress 설정이 통제함.
- AI 가설은 DSL 연구 작업으로만 등록. 주문/공개 시그널로 자동 승격하지 않음.

### 3. 탈락 전략 자세히 보기
- 최근 100개 연구 기록 조회, 최대 50행 표시. 전체 / 추가 검증 후보 / 심사 탈락 필터.
- 개별 연구의 전략군·OOS 거래수·수익률·PF·MDD·수수료 2배·진입 1봉 지연·전략 파라미터를 상세 보기로 표시.
- `failed_gate` 탈락 사유를 OOS 25건 미만, 수익률, PF 1.2, MDD 10%, 비용 2배, 1봉 지연 등 실제 코드 게이트 조건대로 계산.

### 4. 승인 후보만 paper-only 포워드 관측
- Core 연구 테이블의 `candidate_review` 상태와 R2 검증된 15분·1시간봉이 **모두** 존재하면, 5분 연구 Cron에서 새 확정봉의 DSL 방향(`long|short|flat`)을 관측.
- 새로운 Core DB 테이블 `{$wpdb->prefix}lumex_ai_forward_observations` 생성. job+candle unique, SHA256 증거 해시, 원본 제공처, 종가/완료봉 시각 기록. 재전송은 멱등.
- REST: 워커 전용 인증 `GET /wp-json/lumex/v1/research-lab/forward/jobs`와 `POST .../forward/records` 추가. 후보 ID·해시·심사 상태·완료 이후 캔들·신선도 재검증.
- Python Container의 내부 `/observe`는 검증 CSV와 원래 전략 DSL로 방향을 계산, 체결 또는 주문은 실행하지 않음.
- `candidate_review=0`이면 관측 기록이 0인 것이 정상. 포워드 수익률이나 실거래 체결 성과를 주장하지 않음.

### 5. 지표·시그널 연결 상태
- 독립된 기존 승인 시그널 원장과 지표 관측 테이블에서 마지막 이벤트 시각을 가져와 AI 전략 연구소 통합 화면에 표시. 원본은 변경하지 않음.
- 실제 고객용 시그널 발행은 기존 별도 검증·승인 레지스트리 경로로 유지. 연구 단계 자동 발행은 안전을 위해 차단.

## 배포
1. WP 사이트/DB 백업, `LUMEX_CORE_0522_AI_INTEGRATION.zip`으로 Core 0.5.05.22 교체.
2. 관리자 `/lumex-admin/?tab=ai-research`에서 연구 결과 상세, 포워드 관측, AI 실행 상태 확인. Core 최초 호출 시 `lumex_ai_lab_db_version` 1.1.0으로 자동 마이그레이션됨.
3. `LUMEX_AI_RESEARCH_GITHUB_116_INTEGRATION.zip` 압축 해제 후 기존 GitHub 저장소 `main`에 경로 그대로 커밋. Cloudflare Build Root `production`, `lumex-ai-research2` 그대로.
4. `/health`에서 1.1.6 확인. Runtime Secret과 `AUTO_FETCH/AUTO_RESEARCH/AUTO_AI`는 현재값 유지 (`keep_vars:true`). 신규 키 불필요.
5. Cloudflare Cron `* * * * *` + `*/5 * * * *` 유지. **cPanel 시장 수집, 실거래/포지션 감시, WP-Cron 삭제 금지.**
6. Observability에 `lumex_scheduler`, `lumex_queue_result` 확인. 오류는 R2 `control/fetch-<SYMBOL>-<FRAME>.json` 참고.
7. UI에서 AI 상태, 실제 candidate_review 수, 새로운 forward record 유무 검사. 오류가 있으면 운영 로그 및 R2 파일을 확인.

## 롤백
- 이전 Core 0.5.05.21 / Worker 1.1.5 ZIP은 전체 인수인계 패키지에 함께 보관.
- DB에 추가된 포워드 관측 테이블은 **롤백 때 삭제하지 않음**. 기록 보존.
- 다운그레이드 후 예전 워커가 추가된 REST를 사용하지 않아 신규 관측만 중지됨. cPanel Cron 유지.

## 오프라인 QA와 미검증
- PHP Core 모든 파일 `php -l` 검사. Worker/Container Python `unittest`, Node 모의 검증, JSON config check.
- Gate HTTP 400 이력 제한, 임의 400 우회 금지, 누적 데이터 복구, AI 15분 검증 마켓 게이트, 결과 필터·탈락 이유, REST 경계, 종가 관측·미발행 테스트.
- Cloudflare 실운영 Gate 응답, WordPress 실제 데이터 마이그레이션, 실제 OpenAI 과금·가설 수락, 수익성·통과 후보·고객용 시그널 및 실거래 안정성은 운영 배포 후 검증해야 함.
