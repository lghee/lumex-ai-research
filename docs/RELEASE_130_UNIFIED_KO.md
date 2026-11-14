# LUMEX 통합 시장 허브 1.3.0 / WordPress Core 0.6.00

## 통합 범위
기존 분리 초안 PR #11, #12, #13, #14, #15, #16의 *모든* 변경을 1개 통합 릴리스 PR로 main에 제안합니다. 현재 원격 main은 Worker 1.2.6이며, PR들은 개발 소스일 뿐 운영 배포 검증이 아닙니다. 이 작업은 수익/회원/자동매매/주문 코드를 변경하지 않습니다.

### 1.2.7–1.2.12 회귀 포함
- Bybit USDT 선형 4종목 시세·롱숏 계정 비중, Binance 체결 비중, Alternative.me 공포탐욕 → 5분 수집·R2 보관(10개 독립 요청), 명확한 공급자 구분
- Bybit 원본 시세·OI 또는 Binance 원본 시세·OI를 *완전한 세트*로 사용, 7일/30일×4종목 R2 시계열(8개 세트); Gate OI와 섞지 않음
- Bybit 공개 청산과 Binance 1초 강제청산 스냅샷 별도 관측·원장·R2, Binance 스냅샷은 전체 청산을 의미하지 않음
- BTC 공개 주소 확인 거래의 수집 상태·주소집합 SHA256 검증, WordPress TXID 비교(주소 순유입 = 거래소 순유입 아님)
- Worker의 R2 레거시 과거 자료(WordPress 청산/고래/OI) 수집은 현재 실시간 원장과 *병합하지 않음*
- 최근 24h 지문/TXID 및 6h 시간대별 실관측/R2 객체 실제 읽기·형식 검증. 모든 품질 상태는 read-only, WordPress 수집 Cron 제거 자격으로 사용하지 않음

## Worker 1.3.0 신규
1. `GET /market-hub/v1/release-readiness`: 기존 서비스 Bearer 필수. 8개 작업 단계를 한 번에 검증. R2 확정봉 4종목, 공개 지표 10개, OI 8개, Gate 파생 지표, Gate/Bybit 연결, Binance 1초 표본 스트림, BTC 주소 관측, R2 JSONL 실제 읽기. **존재와 실제 관측을 별도로 표현**하며 모든 8개가 설정/검증돼도 `safe_to_disable_wordpress_crons=false`.
2. `AUTO_MARKET_QA_DAILY=true`일 때 기존 5분 Cron의 **00:15 UTC 트리거**에 한 번만 일별 품질 요약을 R2에 저장합니다. 기존 파일이 있으면 다시 쓰지 않으며, 객체를 실제 재읽기한 후에만 latest를 갱신합니다. 출처별 원장이나 고객 데이터는 저장하지 않습니다. 기본 OFF. 00:15 호출이 누락되면 해당 날짜는 결측으로 남기고 성공을 꾸며내지 않습니다.
3. `GET /market-hub/v1/quality-history`: 서비스 Bearer 필수. R2 `market-hub/ops/v1/daily/YYYYMMDD.json`의 최근 7 UTC 날짜를 최대 7개 읽어 기록/미기록을 구분합니다.
4. 일별 품질 기록은 **관측 증거와 설정값의 스냅샷**입니다. Binance 1초 스냅샷 누락 없는 청산 전체 기록, BTC 실제 거래소 전체 자금 흐름, WordPress Cron 중단 가능을 인증하지 않습니다.

## WP Core 0.6.00 신규
- 기존 `LUMEX Core` 플러그인 통합, 별도 플러그인 금지. `데이터 수집 점검`의 맨 위에 **시장 통합 배포 센터** 설치.
- 관리자 nonce + `manage_options` + 120초 쿨다운. 한 번 클릭하면 준비도 + 7일 품질 기록을 읽어 표로 보여줍니다. 네트워크 검사는 자동 Cron을 생성하지 않음.
- 엄격한 응답 검사: 정확한 Worker 버전/스키마/8개 고유 체크, 일별 기록 7개/날짜 순서, 최신 5분 이내, 가짜 통과 건수, 외부 Cron 종료 허용, HTML/script 흔적을 모두 차단.
- 옵션에는 자격증명/원본 이벤트 ID/주소/R2 객체 키를 저장하지 않고 준비도·검증 결과만 저장. 기존 WP 청산·고래·OI/회원·결제·주문 Cron 불변.
- WP Cron 인벤토리는 소수의 알려진 예약 훅만 표시; **외부 cPanel curl Cron의 성공·존재는 WP 예약 여부로 알 수 없습니다**.
- 이전 Core 설치 ZIP 0.5.05.35 및 Theme 0.5.05.24를 롤백용으로 유지.

## 운용 배포
- GitHub 통합 PR의 `production` 자동 전체 JS+Python 테스트 성공을 먼저 확인합니다.
- 이전 종속 PR들을 별도로 병합하지 마세요. **통합 PR 하나**를 확인한 뒤 main으로 병합하는 방식입니다. 사용자 승인 없이 운영 Worker를 자동 배포하거나 WordPress 파일을 교체하지 않습니다.
- Worker 배포 전 백업: 기존 Cloudflare Worker 설정·R2 버킷 스냅샷·WP 데이터베이스 및 PHP 플러그인 ZIP. Docker/DO migrations/R2/Queue bindings 확인.
- 통합 Worker `1.3.0` 배포 → 공개 `/health`·`/market-hub/v1/health` 버전 확인 → R2에 필수 자료 준비 → Core `0.6.00` 설치 → 데이터 수집 점검 1회 → 세부 옵트인 전환 검증. 8개 단계 중 일부 옵션은 기본 비활성이고, 실제 공급자 403·429/SSL 차단이 발생할 수 있으므로 모든 설정을 무조건 한 번에 켜지 마세요.
- `AUTO_MARKET_QA_DAILY=true`는 **옵션**입니다. 기존 Wrangler 파일에 존재하는 5분 Cron만 재사용하며 새 Cron을 추가하지 않습니다.
- **핵심 미해결**: 운영 Worker 배포, 실사이트 R2 보관 연속성/비용 검증, 거래소/WebSocket 권한, WordPress SQL 소비자 전량 CF 이전, 모든 유료 PRO 차트 실시간 검증, 사용 중인 기존 cPanel curl Cron 목록과 정상 작동 여부. 아직 WordPress 수집 Cron 중단 금지.

## 검증
- `cd production && npm run check` (새 `test_integrated_ops_130.mjs` 포함), PHP 82 파일 문법 검사 + 0.6.00 신규·기존 12개 회귀 그룹 확인. CI/mock의 성공은 실데이터 수집·배포 성공을 대체하지 않습니다.
