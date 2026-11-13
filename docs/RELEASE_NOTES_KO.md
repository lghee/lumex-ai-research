# 1.1.3 운용 로그 기반 수정 (2026-11-13 KST)

**운영 확인**: `/health` 1.1.2, 수동 BTCUSDT:5 `2026-11-13T01:58:03.567Z` 실패. R2 `control/last-market-fetch.json`과 `control/fetch-BTCUSDT-5.json`은 `container_fetch_422_bybit_403_binance_451_gate_400_access_restricted`를 기록. 스케줄러 누적 13회 시도/0회 성공/13회 실패.

**중요한 정정**: Gate HTTP 400은 지역 차단의 증거가 아님. 1.1.2는 HTTPError.code가 400이어도 무조건 `_access_restricted`를 붙이는 버그가 있어 단정할 수 없었음.

**변경 파일**: `production/engine/lumex_ai_worker.py` (Gate HTTP 오류 분류/짧은 probe), `production/src/index.js` (헬스 버전), 문서/VERSION. 클라이언트 키, 크론, 연구, 실거래 주문 기능은 변경 없음.

**진단 방식**: Gate 과거 이력 from/to 요청이 HTTP 400일 때 JSON 오류의 label/code/message 일부만 정규화해 포함. `limit=2` 최신 캔들 테스트를 단 1회 수행: 성공하면 과거 쿼리 파라미터/기간/이력 지원 문제, 실패하면 반환 HTTP 상태와 오류 label로 원인을 더 좁힘. 403/451은 접근 제한으로 표시. API 키/요청 URL/비밀 헤더/임의의 응답 본문을 R2에 저장하지 않음.

**한계**: Bybit 403은 지역 제한뿐 아니라 IP 과다 요청 등이 원인일 수 있음. Binance 451은 접근 제한 신호지만 구체적 사유 불명. Gate 400은 진단 결과 전까지 불명. 이 버전도 실계정 Cloudflare와 Gate 연결 테스트는 불가했으며 시세 성공을 보장하지 않음.

**검증**: Python 모의 API 단위테스트 및 JS 모의 통합테스트. 운영 전 배포 성공/health 1.1.3, `AUTO_FETCH=true`, `AUTO_RESEARCH=false`, `AUTO_AI=false` 유지. Queue에 BTC 5m 수동 fetch 1회, R2 `control/last-market-fetch.json`의 정확한 최신 `error` 확인.

---

# LUMEX AI Research v1.1.3 릴리스 노트

일시: 2026-11-13 KST

## 사용자 보고
- Cloudflare Worker 1.1.1 적용 후에도 R2 `market/` 폴더 없음.
- 1.1.1 적용 이후의 실행 로그나 R2 JSON은 미제공이므로 실패가 Bybit/Binance 동시 차단인지, 다른 오류인지 확인되지 않음.

## 변경
- Python Container: 공식 Gate.io USDT 무기한 선물 시장 캔들 API 3차 공급자 추가.
- Bybit HTTP 403/451 → Binance USDM, Binance도 HTTP 403/451 → Gate.io USDT 무기한 선물로 전체 이력 재수집.
- 기존 Binance 수집분은 Binance API로만 증분 갱신; Binance 403/451 시 Gate로 전체 이력 전환.
- 기존 Gate 수집분은 Gate API로만 증분 갱신. 각 공급자의 거래량 단위가 다르므로 데이터 혼합 절대 금지.
- 시장 데이터 검증: 90일 이상+250개 워밍업, 캔들 연속성, 완성봉, 유효 OHLCV, 오래된 데이터 거부.
- Worker `fetchPair`에 실패·성공 시 사유를 사설 R2 `control/last-market-fetch.json` 및 `control/fetch-<symbol>-<interval>.json` 저장. 이 파일들은 R2에 시장 데이터 저장 성공이 없는 경우에도 원인을 추적하는 용도.
- `/health` 버전 1.1.3. 기존 Cron/Queue/Secret/WordPress Core/실거래 주문 로직 변경하지 않음.

## 검증
- Worker Node.js mock R2/Queue 통합 실행 테스트 통과. 실패 시 JSON 진단 생성과 Queue 재시도 확인.
- Python unittest 9개 통과. Bybit와 Binance가 모두 403일 때 Gate만 전체 히스토리로 전환, Gate 캐시 증분 갱신, 모든 공급자 차단 시 실패 및 기존 데이터 보존 확인.
- node --check, py_compile 통과.
- **미검증**: 실제 운영 Cloudflare IP에서 Gate.io API 접근·실제 R2 CSV 생성·90일간 데이터 가용성.

## 사용 지침
1. GitHub 저장소 `main`의 기존 파일을 같은 상대경로로 교체. Cloudflare Root `production`, Worker `lumex-ai-research2` 유지.
2. `/health`에서 `version: 1.1.3` 확인. AUTO_FETCH true, AUTO_RESEARCH false, AUTO_AI false 유지.
3. Cloudflare → Queues → `lumex-research-jobs` → Messages → Send: `{ "kind": "fetch", "symbol": "BTCUSDT", "interval_min": 5 }`
4. R2 `lumex-ai-data`에서 `control/last-market-fetch.json` 먼저 확인; `ok:true`이면 `market/BTCUSDT_5.csv` 확인. `ok:false`이면 `error`에 Bybit/Binance/Gate 접속 오류 정보가 남음.
5. Gate까지 403이면 임의 위치 우회가 아니라 해당 실행 환경에서 이용할 수 있는 승인된 시세 공급자/실행 호스트를 별도 선택해야 함.

## 금지
- 시장 데이터 저장 성공 전 AUTO_RESEARCH/AUTO_AI를 켜지 말 것.
- 실거래 주문 연결 또는 비밀키를 로그/GitHub에 노출하지 말 것.
- `control` 상태 파일을 수동 수정하여 성공 처리하지 말 것.
