# LUMEX 통합 시장 허브 1.3.1 / Core 0.6.01 / Theme 0.5.05.25

## 한 번에 진행한 기능 통합
이 릴리스는 1.3.0 소스 및 그 이전 1.2.7~1.2.12의 기능을 보존하며, **별도 분리 PR 없이 통합 PR #17**에서 개발합니다.

### Worker 1.3.1 — 실제 사용자 화면용, 한 번에 읽는 Cloudflare API
- `GET /market-hub/v1/terminal?symbol=BTCUSDT` (ETH/SOL/XRP 포함): 기존 WordPress PRO **90초 HMAC 서명 티켓** 또는 서버 Bearer로만 허용, 다른 종목으로 티켓 재사용 불가. 브라우저는 `https://lumexbot.com`만 CORS 허용. 별도 회원·주문 API 없음.
- R2 확정봉 15분(가격·SMA20/50·ATR14), Bybit 시세+계정 롱숏 비율, Binance 체결 매수 비중, 동일 거래소 원본으로 검증한 7일 OI(Bybit 또는 Binance), Gate 펀딩비·공개 OI, 24시간 Bybit 청산 + Binance 1초 청산 스냅샷 + BTC 주소 이동 건수를 **5개 독립 관측 섹션**으로 단일 요청에 포함합니다.
- 각 독립 자료는 `fresh|delayed|unavailable` 상태 및 원본 공급자를 보존. 미수집·오래된 데이터를 만들거나 0건이라고 추측하지 않고, 공급자 간 수치를 합산하지 않습니다. Binance 청산은 전체 체결이 아닌 1초 표본이며, OI와 계정비율은 각기 다른 모집단입니다.
- 보호 응답: `schema: lumex_pro_market_terminal_v1`, `scope: source_separated_public_market_observations_only`, `trading_enabled:false`, `orders_enabled:false`, `market_total_estimate:false`. 서버 비밀이나 고객 포지션·자동 주문·프라이빗 계정 응답 없음.
- 기존 Worker 1.3.0 운영 배포 진단·R2 일일 품질 확인·Cloudflare Research Queue·Containers·시장 Cron, 별도의 Derivatives 및 관측 스트림 API 유지.

### Theme 0.5.05.25 — 통합 사용자 페이지 개선
- **시장분석, 코인 레이더**: 각각 분리되어 중복 표시되던 Cloudflare 관측/파생 패널을 새로운 차콜톤 **단일 시장 허브 패널**로 교체. 종목 선택(BTC/ETH/SOL/XRP), 각 지표 출처 및 최신성·미수집 표시, 70초 화면 갱신. 매 갱신마다 WordPress MySQL 조회하지 않고 Cloudflare Worker로 **직접 조회**. WP는 PRO 티켓 발급 시에만 호출.
- **청산 분석, 고래 추적**: 기존 Cloudflare 관측 패널을 유지하면서 Binance 청산 **1초 표본 건수**를 Bybit와 분리 표시. 시간 그래프도 각각 Bybit/Binance/BTC 주소 관측 색을 분리. 네이비 스타일을 차콜로 변경.
- 모바일 390px/PC 1440px 정적 화면 검수: 카드 6개, 가로 오버플로 없음. CSS/JS 컴포넌트만 교체, 차트 확대·줌/자동매매 설정은 변경하지 않습니다.
- 필터 변경과 다른 UI 종목 선택 동기화, HMAC 티켓 90초 만료 전 갱신, 401 재발급, 탭 숨김 시 주기 갱신 중단, 개발자가 임의로 입력한 종목 미지원.

### Core 0.6.01 — 필수 Worker 버전 검증 호환
- 통합 관리자 `데이터 수집 점검`에서 1.3.1 Worker를 검증하게 수정. 기존 1.3.0 전용 버전 체크로 인해 신규 배포 후 감사가 실패하던 문제를 해소.
- 동일한 PRO 서명 티켓의 scope를 `public_market_read_only`로 정확히 표시(매매 권한 없음). 서명 방식/90초 만료·기존 사용자 유료 인증 유지.
- 기존 데이터베이스/회원·결제·자동매매 코드 및 Cron 전부 보존. 신규 WordPress 플러그인·관리자 메뉴 추가하지 않음.

## 설치·전환 순서
1. ZIP 전체 백업, 기존 Core 0.6.00/Theme 0.5.05.24 보관.
2. **통합 Worker PR #17 한 개만** 검토/병합하고 Worker 1.3.1을 운영에 배포. 기존 분리 PR #11~#16은 병합하지 말 것(중복 변경). R2/DO/Queues/Secrets/Containers 바인딩 기존 값 보존.
3. Worker `/health`와 `/market-hub/v1/health`의 실제 버전 **1.3.1** 확인. Market Data R2 확정봉이 최소 51개 존재하는지, Public Pulse/OI/Gate/Observations의 실제 수집 자료가 있는지 확인.
4. Core 0.6.01 플러그인 ZIP 덮어쓰기, Theme 0.5.05.25 ZIP 덮어쓰기. 데이터 수집 점검/PRO 계정에서 페이지별 데이터 확인. 데이터가 없는 경우 `자료 없음`으로 표시해야 하며 성공으로 보고하지 않음.
5. 1차 실제 API/화면 점검: PC+모바일, 종목 4개, 티켓 만료 후 재발급, PRO 미가입자 제한, Bybit/Binance 분리된 청산 표본, 관리자 QA 8개, R2 보관 파일. **실제 사이트 배포 및 R2 실물 검증은 현재 이 코드/테스트만으로 확인되지 않음**.

## 롤백
- Worker를 이전 버전 1.3.0으로 롤백할 경우 Theme도 0.5.05.24로, Core도 0.6.00으로 함께 복원. 1.3.1 전용 단일 조회 위젯은 1.3.0에서 지원하지 않습니다.
- 기존 WordPress 시장·청산·고래 Cron은 **전부 유지**. 실제 대체 신호/누적 검증 전 종료하지 않습니다. 고객 실거래/결제/회원 데이터는 수정하지 않습니다.

## 검증
- GitHub Actions `production/npm run check`의 기존 전체 JS+Python 회귀 및 신규 `test_pro_terminal_131.mjs` 검증.
- PHP 82개 + Theme PHP 24개 + Theme JS 42개 문법 검사; 기존+신규 Core 로컬 14개 그룹 성공. 테마 정적 계약 테스트 통과, 1440/390 폭 정적 렌더링 가로 오버플로 0.
- 모의 테스트가 실제 Cloudflare 배포/가상화 컨테이너 실행/운영 WordPress 사용자 트래픽을 증명하지는 않습니다.

## 알려진 제한
- 이 통합 UI는 R2에서 수집한 **가장 최근 확정된 15분 캔들**을 읽는 것이므로 틱 실시간 차트가 아님. 기존 전문 LUMEX 차트 전체 교체는 별도 고성능 작업이며, 사용자의 현재 차트 조작 기능을 건드리지 않았습니다.
- 실거래소 전체 청산 체결량, 고래 전체 주소·정체, 시장 전체 OI를 주장하지 않습니다. 일부 장외/연결 중단 구간은 근거가 남지 않을 수 있습니다.
- 공유 호스팅의 MySQL 분석 계산·경보 Cron 모두 제거한 것은 아님; 고객용 통합 패널의 반복 조회가 Worker 직접 호출로 옮겨졌을 뿐입니다.
