# LUMEX AI Research 1.1.4 — 실측 캔들 품질 복구 (2026-11-13)

## 출발점 / 운영 사실
- 배포된 1.1.3에서 Gate.io 선물 BTCUSDT:15와 BTCUSDT:60의 실제 시세가 Cloudflare R2에 저장되는 것까지 사용자 확인.
- 제공된 원본 CSV(`market_BTCUSDT_15.csv`, `market_BTCUSDT_60.csv`)는 시간순으로 연속되지만, 15m에 5개·60m에 2개의 거래량 0/동일 OHLC 의심봉 확인. 일부는 정확히 1,999개 페이지 경계에 위치.
- 정확한 과거 가격은 공급처로 재조회해야만 확인 가능하며, 이 버전에서는 임의의 OHLC를 생성하거나 교정하지 않음.

## 실제 변경 파일
- `production/engine/lumex_ai_worker.py`: Gate 공식 `from/to` 최대 2,000건, 3개 봉 경계 중복 조회, 누락·0거래량 동일 OHLC 타깃 재조회(최대 24개), 실패 시 저장 금지, 90일+250봉 완성봉 검사, 기존 손상 파일 발견 시 전체 동일 공급처 재수집.
- `production/src/index.js`: 모든 새 CSV를 별도 검사, `ohlcv_v2/verified` 메타데이터, 동일 공급처 15m/60m 교차 검증, v1/무검증 R2 캐시 자동 연구 차단. `/health=1.1.4`, `/status`에 rows/schema/quality 노출.
- `production/tests/test_engine.py`: 손상 과거 이력/페이지 경계 재조회/미복구 실패/누락 보수 테스트.
- `production/tests/test-production.mjs` + `test-quality.mjs`: 90일+250봉, 가짜봉 거부, 기존 검증파일 보호, 교차 시간봉 충돌 차단.
- `production/tools/audit_market_csv.py`: 별도 CSV 파일 감사 도구(읽기 전용).
- 프로젝트 버전/문서/QA 기록 업데이트.

## 검증
- Python deterministic unittest 16/16 PASS (네트워크 없는 모의 응답).
- Node Worker 모의 QA PASS, 별도 15m/60m 교차 품질 QA PASS.
- 직접 전달된 BTCUSDT CSV 두 개 모두 신규 loader에서 **정상적으로 거부** (`unverified_zero_flat_candle`).
- 실제 운영 R2에 다시 올린 새 데이터의 품질, Gate API 재조회 결과, 12개 전체 조합 확보, WordPress 자동 연구는 **아직 미검증**.

## 배포
1. GitHub `lumex-ai-research`의 기존 `main`에 이 ZIP의 폴더 구조를 유지한 채 새 파일 덮어쓰기. Cloudflare 빌드 Root directory `production` 유지.
2. `https://lumex-ai-research2.kpiplus195.workers.dev/health`에서 `version=1.1.4` 확인.
3. `AUTO_FETCH=true`, `AUTO_RESEARCH=false`, `AUTO_AI=false` 유지.
4. Queue `lumex-research-jobs` → Messages → Send: `{"kind":"fetch","symbol":"BTCUSDT","interval_min":60}`.
5. R2 `control/fetch-BTCUSDT-60.json`에서 `ok=true` 및 `quality=verified` 확인. 같은 방식으로 15분봉 확인.
6. `market/`에서 R2 CSV metadata `schema=ohlcv_v2`, `quality=verified`, `rows` 확인. 기존 v1 파일은 백테스트에서 자동 제외됨.
7. `ok=false`이면 `error` 문자열을 보고 공급처 갱신 실패나 데이터 충돌을 진단. **수동 삭제/강제 성공 처리 금지**.

## 사용자 기존 설정 보존
Worker/Queue/Container/R2/Secret/Cron, `LUMEX_SITE_URL`, `keep_vars=true`, WordPress Core 0.5.05.20, 실거래 주문 모두 변경 없음.

## 추가 안전 정책
- 같은 거래소라 하더라도 서로 다른 시점의 15m/60m 데이터는 일부 소폭 수정될 수 있어 소규모 허용 오차 적용. 오차를 넘으면 안전을 위해 저장 실패. 이 경우 시세가 손상된 것인지 공급처의 시간봉 이력 수정인지 확인 필요.
- 비정상 캔들 출현 원인이 Gate 응답의 인위적 최종봉인지 100% 입증한 것은 아니므로, 소스는 원인 단정 대신 재조회/차단을 수행.
