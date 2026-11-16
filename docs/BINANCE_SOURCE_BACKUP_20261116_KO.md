# LUMEX Binance 공식 REST 451 대응: Coinalyze 라이선스 확인형 백업 경로
2026-11-16 · Worker 기능 개발 기록

## 확정된 현상
- 기존 Cloudflare Worker `fapi.binance.com`: 지역 제한(기존 운영 로그).
- GitHub Actions ubuntu-latest 실제 read-only probe: Binance USDT-M REST 계정비율, OI, 펀딩 3/3 모두 HTTP 451 `restricted location`.
- 확인된 CI: https://github.com/lghee/lumex-ai-research/actions/runs/43787628335
- GitHub-hosted egress에 같은 공식 REST URL을 추가하는 것만으로는 수집 불가. 지역 제한 우회 시도하지 않음.

## 대안 공급자와 이용 권한
- Coinalyze `https://api.coinalyze.net/v1/doc/`: API 키 기반, 무료(2026-11-16 문서), 40req/min; 실제 Binance 거래소 시장을 표시하는 데이터. 공급자 측 공개 문서에서 기사/차트에 출처 링크를 부탁함.
- 다만 **유료회원 대상 웹 대시보드 재표시 및 계속 저장하는 용도의 허가 여부를 Coinalyze에 확인해야 함.** 승인 전 `COINALYZE_COMMERCIAL_USE_APPROVED` 플래그를 `true`로 설정하지 말 것.
- CoinGlass 상업용 Standard $379/월(월 결제, 2026-11-16 기준 문서) 대안. 5분 계정 비율 지원 여부는 Standard 플랜 확인 후 계약.
- 키 없는 웹사이트 HTML 파싱, 사용자 위치/지역 제한 회피, 타 거래소 데이터를 Binance라 표기하는 방법은 사용하지 않음.

## 적용 코드
- `production/src/coinalyze-binance.mjs`: 공식 Coinalyze API 서버 측 호출; API 키는 요청 헤더에만 사용.
- `production/src/exchange-compare.mjs`: Binance 공식 API 실패/누락 시 **유효한 본래 거래소 수치만** 백업으로 연결, 원래 실패 코드는 운영 기록에 보존.
- 시장 카탈로그: `/exchanges`에서 Binance 코드 검증, `/future-markets`에서 Binance + USDT + perpetual + stable margin + 원본 BTCUSDT 등 시장 이름 정확히 매칭. 검증된 키만 23시간 R2 캐시.
- 롱/숏: `/long-short-ratio-history` 5min, t/l/s/r 검증, 관측 25분 초과 폐기.
- OI: `/open-interest?convert_to_usd=true`의 USD 명목 가치로만 표기.
- 펀딩: Raw API `value`의 percent/fraction 의미가 실조회로 확인돼야 `COINALYZE_FUNDING_UNIT` 명시적으로 설정. 기본은 **미확인**. 잘못된 100배 값 금지.
- R2 스냅샷: `backup_provider: Coinalyze`, `backup_venue: Binance`, `attribution` / `attribution_url` 기록. 원본 분리 보존. 두 소스의 평균/합산 없음.
- Web frontend에서 Coinaylze 유래 값 옆에 출처를 반드시 표기하도록 별도 UI 체크 필요. 라이선스 검증 전 활성화 불가.

## 사용자가 Coinalyze 사용권을 허가받은 후 필요 설정
1. Coinalyze에서 API 키 발급: https://api.coinalyze.net/v1/doc/
2. Coinalyze에 LUMEX 유료회원 웹 표시, 출처 표기, R2 시계열 저장 가능 여부 확인.
3. Cloudflare Worker `lumex-ai-research2`의 Secret에 `COINALYZE_API_KEY` 설정(키를 코드/채팅에 기록하지 않음).
4. 허가 확보 및 UI 출처 구현 후 `COINALYZE_COMMERCIAL_USE_APPROVED=true` 변수 활성화.
5. 펀딩값 실측에 기반한 단위 확인 전에는 `COINALYZE_FUNDING_UNIT` 비워둠.
6. 기존 운영 배포 수동 워크플로우 실행, 2회 이상 5분 Cron 후 관리자 인증 상태에서 `/market-hub/v1/exchange-compare-health`와 `exchange-compare?symbol=BTCUSDT` 확인.
7. BTC/ETH/SOL/XRP 네 종목에서 데이터 출처, 샘플 시각, 데이터 누락/403 기록과 실제 운영 화면 검증.
8. **모든 코인·거래소 완전 복구, 실시간성은 운영 검증 전까지 주장하지 않음.** 원본 미확인 빈칸은 빈칸 그대로 둠.

## 비용 및 위험
- 코드·테스트 추가는 유료 API 구매 자체가 아님. 현재 이 경로는 비활성.
- Coinalyze가 외부 상업용 재표시를 허용하지 않으면 이 경로를 활성화하지 않고 다른 정식 라이선스 데이터 제공처와 계약.
- Github Action 5분 예약은 SLA가 아니고, worker cron도 일부 지연이 있을 수 있음.
- 기타 Worker의 시세, 실주문, 회원·결제, 자동매매 전략과 무관.
