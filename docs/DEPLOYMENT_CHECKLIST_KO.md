# LUMEX AI Research 1.1.2 배포·복구 체크리스트

1. Cloudflare → Workers & Pages → lumex-ai-research2 → Settings → Builds: main / root=production.
2. GitHub ZIP **안쪽 파일** 전체를 저장소 루트에 올려 기존 파일을 교체; ZIP 자체를 GitHub에 업로드하지 말 것.
3. Deployments에서 새 배포 성공. Container 설정 반영 실패 시 동일 커밋의 Retry build 1회만.
4. `https://lumex-ai-research2.kpiplus195.workers.dev/health`에서 version=1.1.2인지 확인.
5. Settings → Runtime variables and secrets: AUTO_FETCH=true, AUTO_RESEARCH=false, AUTO_AI=false. Secret 이름은 LUMEX_CONTAINER_KEY / LUMEX_ADMIN_API_TOKEN / LUMEX_AI_LAB_WORKER_TOKEN으로 정확히 입력. Secret 값 공유 금지.
6. Queue `lumex-research-jobs` → Messages → Send → JSON: `{ "kind": "fetch", "symbol": "BTCUSDT", "interval_min": 5 }`. 직접 fetch는 scheduler state counters를 갱신하지 않음.
7. R2 `lumex-ai-data` → Objects → `control/last-market-fetch.json`: timestamp가 최신인지 확인. `ok:false`이면 error 확인.
8. `ok:true`: `market/BTCUSDT_5.csv` 존재, 크기·최근 수정 시각 확인. source 값은 bybit_public_linear / binance_usdm_perpetual / gateio_usdt_perpetual 중 하나.
9. `ok:false`의 `container_fetch_422_bybit_403_binance_403_gate_403...`: 세 거래소 접근 제한. R2/Queue 재설정만으로 해결되지 않음.
10. `control/last-market-fetch.json` 자체가 새로 안 생기면 Worker Queue 실행/버전/런타임 토큰/Observability error 확인.
11. 성공 확인 전 연구·AI를 켜지 말 것.
12. 긴급 복구: 이전 `LUMEX_AI_RESEARCH_GITHUB_111_BYBIT403_FAILOVER.zip` 소스를 같은 경로로 커밋하고 배포. WordPress Core 변경 필요 없음.
