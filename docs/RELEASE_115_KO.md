# LUMEX AI RESEARCH 1.1.5 / CORE 0.5.05.21 — 통합 관리자 및 시세 이력 확장
기준일: 2026-11-13 (KST)

## 목표 및 상태
- 기존 LUMEX AI 전략 연구소가 유일한 *신규 자동 전략 연구* 엔진이 됩니다.
- 독립 관리자 메뉴 '전략 연구', '전략 검증 · 포워드', '시그널 관리', '지표 평가'를 없애고 AI 연구소 내부의 탭으로 통합합니다.
- 과거 연구 원장·수동 CSV 검증 결과·전략 카탈로그는 삭제하지 않고 읽기 전용으로 보존합니다.
- AI 가설 생성의 인증된 WordPress context API는 기존 기술지표 외에 승인된 시그널 이벤트 기록과 지표 관측 기록을 참조합니다. 거래 신호/승격/실주문은 자동화하지 않습니다.
- Cloudflare 시장 데이터 점검은 매분, AI 연구/가설 생성은 5분 주기로 분리합니다. 미완성 캔들, 데이터 신선도 및 R2 품질 격리는 유지합니다.
- Gate 5분봉: 공식 최근 캔들 한계에 대응해 처음 30+일 확보 후 R2에서 시간에 따라 연속 누적; 90일+웜업 이전에는 quality=collecting, 백테스트 불허.
- Gate 1시간봉: 최초 180일 + 워밍업 자동 재수집, 연속 갱신 시 최대 180일+워밍업 유지. 실제 거래소 접근 가능여부는 재배포 후 검증해야 합니다.
- 15분봉: 기존 90일 이상 및 동일 거래소 내 1시간봉 교차 검증 유지.

## 수정된 주요 파일과 방식
1. `lumex-core/includes/class-lumex-admin.php`: 내비게이션·기존 URL 별칭 통합, 연구 탭 추가, 이전 기록 read-only 전환, 통합 진단/필수 Cron 안내.
2. `lumex-core/includes/class-lumex-market.php`: 기존 market collector, indicator observer 및 history archive는 유지하고 중복 구형 자동 연구와 strategy factory 단계만 제거.
3. `lumex-core/lumex-core.php`: 버전 0.5.05.21, 첫 설치/업그레이드에서 `lumex_research_auto_daily`만 비활성화하는 1회 마이그레이션.
4. `lumex-core/includes/class-lumex-ai-research-lab.php`: 기존 Worker REST 계약 유지, 시세 조합별 품질/이력/최신 완료봉 수신 및 관리자 표출, AI context에 승인 시그널 및 지표 관측 레코드 read-only 추가.
5. `lumex-core/assets/admin.css`: PC/모바일 AI 연구소 탭 UI.
6. `production/src/index.js` 및 `src/index.js`: 1.1.5, 1분 market_tick 분리, 5분 기존 연구, 5분봉 collecting 보존과 90일 전 백테스트 차단, Cloudflare 시장 인벤토리 WordPress telemetry 전송.
7. `production/engine/lumex_ai_worker.py` 및 `research/lumex_ai_worker.py`: 5분봉 초기 최근 32일 회수 후 추가 데이터 누적, Gate 1시간봉 180일 유지, API 10000개 캔들 제한 대응. 데이터 원본에 따른 90일 엄격 평가 조건은 여전히 유지.
8. `production/wrangler.jsonc`/`wrangler.jsonc`: 1분/5분 Cron + 기존 Durable Object/R2/Queue 유지, GitHub Observability 로그 설정 반영, keep_vars 유지.

## 절대 삭제하면 안 되는 스케줄러
- Cloudflare Worker 1분 + 5분 Cron (새로운 연구 시세/AI 자동 연구).
- cPanel LUMEX 시장 HTTPS Cron (WordPress 차트, 지표 관측, 가격 알림, 과거 자료).
- cPanel LUMEX Demo/Live 자동매매 전용 HTTPS Cron (거래소 실주문/포지션 감시 경로).
- WordPress WP-Cron/기타 예약 작업: 실제 의존성 대조 전 삭제 금지.

## 자동매매 정책 및 데이터 출처
- 이 릴리스는 고객 API, 거래소 주문 제출, 결제, 권한 제어, 실거래 설정을 변경하지 않습니다.
- AI 연구 결과는 candidate_review를 포함해 실거래 승인으로 자동 승격되지 않습니다. failed_gate는 실패한 전략 심사이며 Worker 예외가 아닙니다.
- 기존 WordPress 지표는 cPanel 시장 Cron과 Bybit 공개 시장/기존 서버 데이터에서 생성됩니다. Cloudflare 연구는 Gate USD-T 선물 캔들을 사용할 수 있으며 제공처가 다르므로 양자를 혼합해 동일한 체결값으로 표시하지 않습니다.
- 이 버전에서 추가한 1분 점검은 '확정봉에 대한 단기 갱신 점검'이지 웹소켓 체결/호가 초단위 실시간 스트림이 아닙니다.

## 설치 순서
1. WordPress 운영 Core와 DB 사전 백업.
2. Core ZIP을 LUMEX 관리자 > 테마·플러그인 또는 WordPress 플러그인 업로드로 기존 LUMEX Core에 교체 설치(최상위 폴더 lumex-core 보존).
3. WordPress `/lumex-admin/?tab=ai-research`에서 상단 5개 탭과 연구 통계 확인, 기존 `?tab=research`/`strategy-lab`/`signals`/`indicator-review`가 새 화면 섹션으로 열리는지 확인.
4. GitHub `lumex-ai-research` 저장소의 `main`에 Worker 소스 ZIP 압축 풀어 동일 경로로 커밋 (Cloudflare Root directory = production).
5. Cloudflare Worker `lumex-ai-research2` 배포 성공 및 `/health`에서 `version:1.1.5` 확인.
6. Cloudflare -> Settings -> Triggers에서 `* * * * *`와 `*/5 * * * *` 존재 확인. R2/Queue/Container/Secret/WordPress Token 기존 값 유지.
7. R2 `market/`에서 5분봉 collecting/15분봉 verified/1시간봉 연장 이력 확인. WP 관리자 Worker 최근 실행 및 12개 시세 테이블에 최신 시각 표시 확인.
8. 기존 cPanel 시장·자동매매 Cron 삭제하지 말 것.

## 검증 (오프라인 및 정적)
- PHP 73개 파일 `php -l` 성공.
- WordPress 메뉴 별칭/통합 PHP 테스트 통과.
- Python `unittest discover` 18개 통과 (5분봉 최근 Gate 데이터/1시간봉 180일 mock 포함).
- Worker Node `test-production.mjs`, `test-quality.mjs`, `test_115_fastpoll.mjs` 통과 (모의 R2, 인증, 캔들 품질, 연구 반환, 1분/5분 스케줄 분기).
- 실계정 Cloudflare Containers/R2/Gate/WordPress end-to-end 신규 버전 실증은 아직 미실시. 임의 수익/시그널/실거래 성공을 주장하지 않습니다.

## 후속 필수 작업 (미구현 구분)
- 진짜 초단위 실시간 체결/호가 WebSocket 수집과 지표/실거래 신호 간 확정봉 승격 프로토콜은 이번 릴리스에서 미구현. 별도 안정적인 스트림·리플레이·유효성/중복 검증 필요.
- 5분봉 90일의 즉시 역사 확보는 Gate API의 최근 기록 제한으로 불가능. 30일 데이터부터 실시간 축적해 90일 이상 쌓이기 전까지 자동 연구 금지.
- 신규 연구의 시그널 자동 공개, paper/forward execution, 사용자 PRO 화면 신호 송출은 미구현. 별도 검증/승인 게이트 필요.
- Cloudflare 1분 Cron은 비용과 Container 사용량 증가 가능; 배포 후 사용량/에러율 감시.
