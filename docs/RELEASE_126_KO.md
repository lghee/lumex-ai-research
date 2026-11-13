# LUMEX Market Hub 1.2.6 — WordPress 공개 시장 관측 기록 R2 백필

## 목적·범위
사용자 요청: WordPress 공유 호스팅 MySQL에 남아 있는 **실제 공개 청산·고래 이동·가격/OI 관측 이력**을 Cloudflare R2로 이전하면서, 기존 WordPress 기록, 회원/결제/주문/알림 기능을 손대지 않기. 이 버전은 먼저 *원본 보존·감사 가능한 이관*까지 구현한다. 기존 Cloudflare 실시간 청산 통계에 과거 기록을 합쳐 중복 집계하지 않는다.

## WordPress Core 0.5.05.28
신규 통합 클래스 `includes/class-lumex-cloudflare-legacy-export.php` (기존 Core에 추가; 독립 플러그인 아님).
- GET `/wp-json/lumex/v1/market-hub/legacy-export?source=liquidations|whales|market_snapshots&cursor=0&limit=100`
- 연구 Worker 공통 `lumex_ai_lab_worker_token_v1` 정확한 Bearer 인증이 필수. 동일 토큰 검사로 Guest REST Gate/Unpaid Gate에서 **이 한 GET 경로만** 통과. POST, 사용자/관리자/주문 등 다른 URL은 예외 불가.
- MySQL 단일 ID 인덱스 범위 쿼리 `WHERE id > cursor ORDER BY id ASC LIMIT 100`. 전체 테이블 Full Scan, OFFSET 페이지네이션, UPDATE, DELETE, INSERT 없음.
- 테이블 및 필드 allowlist:
  1. `lumex_liq_observed_events`: 공개 청산 fingerprint, coin, exchange_name, position_side, price, quantity, notional_usd, event_ts
  2. `lumex_whale_transfers`: 공개 주소/거래소 관측 fingerprint, provider, asset, amount_coin, transfer_direction, transaction_hash, event_ts 및 기존 출처 라벨.
  3. `lumex_liq_market_archive`: 기존 Bybit/Binance public price, oi_usd, sample_kind, sample_ts.
- 회원 이름/이메일/전화/API 키/결제/주문/거래소 계정/API secret/사용자 메타 조회 경로 없음.
- CSV/JSON 정밀도를 위해 DECIMAL은 문자열로 보존. limit 1–100, cursor 0–18자리 숫자 범위 엄격 검증. 오래된 DB의 35일 자동 삭제는 기존 동작 그대로 보존.

## Cloudflare Worker 1.2.6
- 기존 `BTC_RESERVE_COLLECTOR` Durable Object를 재사용하여 새 바인딩 없이 서버 내부 `/backfill`, `/backfill-status` 제공.
- 기존 5분 Cron이 Whale/Derivatives/Research와 독립적으로 한 번 실행: 자료 유형별 최대 100건, 요청 최대 3회. 지속 상태 `legacy-backfill:{source}`에는 가장 마지막으로 **R2 기록을 완료한 ID**와 누적 기록 수·파일 수·실패·원본 35일 보존 한계 저장.
- 원본은 `market-hub/legacy/wp/{source}/{first_id}-{last_id}-{sha256prefix}.json` 아래 별도 원본 JSON으로 저장. 각 파일에 원본 MySQL id/fingerprint/공급자/종목/시각 등 정보와 SHA256 digest를 Custom Metadata에 기록.
- 소스 응답의 exact field allowlist, id 단조증가, 스키마, 행 수, 시각 범위, 수량 유한 여부 등을 수신 측에서 재검증.
- R2 객체가 이미 있으면 중복 덮어쓰기 생략. R2 저장 성공 *후에만* Durable Object 체크포인트 갱신. 실패하면 같은 ID 커서에서 재시도. 기존 MySQL 삭제·수정 금지.
- 운영 GET `/market-hub/v1/legacy-backfill-health`: 공개 진행률 (유형별 가장 최근 ID/누적 기록 수/파일 수/마지막 오류만), 실제 원본 내용·토큰 공개 안 함.
- `AUTO_LEGACY_BACKFILL:true`지만 Core 0.5.05.28 설치 전에는 WP REST 401이 기록될 수 있다. 401이면 R2 저장 및 ID 커서 증가 금지. Core 설치 후 다음 Cron에서 자동 재시도.

## 중복·품질 유의
**예전 WordPress 청산 데이터와 새 Cloudflare Bybit 공개 청산 이벤트를 지금 합치면 안 된다.**
둘은 공급자, 관측 시점, fingerprint 형식, 시장 범위가 달라 동일 거래 이중 기록 위험이 있다. 이번 버전의 archive는 `merged_with_live_observations:false`. 과거 원본을 별도 보존한 뒤 출처·거래 ID 교차 감사와 중복 제거가 끝나면 추세/그래프에 통합할 수 있다.
BTC 과거 지갑 이동이 여러 주소로 합쳐 계산된 경우 Cloudflare 최신 주소별 순이동과 1:1로 대응하지 않을 수 있다.
WordPress 원본은 35일 삭제 정책이 있으므로 **이미 삭제된 자료는 이관으로 복원할 수 없다.** 누락 기간을 0/추정으로 채우지 않는다.
시장 price/OI는 공개 관측/시나리오용일 뿐 실제 투자자별 청산 계좌 정보가 아니다.

## 배포·수행 순서
1. GitHub PR을 자동 검사 통과 후 main 병합 → Worker `/health` 1.2.6 확인.
2. Core 0.5.05.28 기존 플러그인 업데이트. UI 테마는 이번 단계 불필요.
3. Cloudflare `/market-hub/v1/legacy-backfill-health`에서 `last_error:null`, `records_archived`, `chunks_archived` 증가 확인.
4. 현재 이용자 화면은 1.2.5 Core/Theme와 호환; 이관 기록을 바로 고객 청산 합계로 합치지 않음.
5. 기존 cPanel Cron은 다른 소비자/서버 분석이 있으므로 **이번에 제거하지 않음**.

## 자동 검사
- GitHub Actions `cd production && npm run check` 기존 시장·AI·컨테이너/파이썬 회귀, 새 `test_legacy_backfill_126.mjs`.
- PHP `php -l` 전체, `test_legacy_wp_export.php` signed path/auth/3개 원본 테이블/limit/커서/미인증 차단 검증.
- 실제 운영 R2 객체 수가 증가해야 **실제 이관 성공**. API health 200, GitHub CI 통과만으로 이관 완료라고 주장하지 않는다.

## 다음 차수
- 이전 WordPress 자료와 Cloudflare 관측 이벤트의 거래소별 timestamp/fingerprint 감사 후 중복 없는 자료 통합.
- 기존 시장·청산 리스크 계산기 중 Cloudflare 전환 가능한 부분의 종속성 목록과 결과 비교.
- 모든 WordPress 시장 수집 Cron은 기능별 이전 및 비교 검증이 끝난 뒤 순차 비활성화; 주문/회원/결제 Cron 별도 유지.
