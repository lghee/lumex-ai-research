# LUMEX AI Research 1.1.1 — Bybit 403 시세 수집 복구

- 버그: Bybit 공개 `api.bybit.com/v5/market/kline` GET 에서 HTTP 403이 발생해 Container /fetch 422, R2 시장 CSV 0건.
- 수정: HTTP 403/451에서 Binance 공식 USD-M 무기한 선물 `/fapi/v1/klines`로 전체 재백필. 이후 Binance 캐시는 동일 공급자 증분 갱신.
- 무결성: 90일+250봉/완료봉/갭/시각/가격 검증, 실패시 정상 캐시 유지, 공급자 전환 시 기존 Bybit와 데이터 혼합 방지.
- 추적성: R2 metadata source, Worker `/status` source, WordPress 연구결과 source 기록.
- 실제 운영 재배포·Bybit/Binance 외부 접근은 아직 검증되지 않음. 403이 양쪽에 발생하면 데이터 공급 경로 재설계 필요.
- Core 0.5.05.20 유지, Cloudflare Secret 및 토글 유지.
