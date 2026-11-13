# LUMEX Market Hub 1.2.3 — 실시간 Gate 선물 진행봉 WebSocket

## 핵심 개발
1. 기존 Cloudflare Gate 선물 웹소켓에 `futures.candlesticks` 공개 구독을 4종목×(5m,15m,1h,4h,1d) 연결.
2. 진행 중 Gate 캔들을 `decodeGateCandles`로 OHLCV, 간격, 출처, 시각 검증하고 같은 종목/주기를 12초 최소 간격으로 샘플링.
3. MarketEventHub Durable Object `/publish`는 **메모리 WebSocket 브로드캐스트 전용**, DB·R2에 미저장. `type:'provisional_kline'`, `confirmed:false`, `source:'gateio'` 전송.
4. 90일+ 검증 R2 확정봉과 절대 병합/덮어쓰기하지 않음. AI 연구, 전략 신호, 주문 진입에도 진행봉 사용 금지.
5. 기존 WordPress Core의 PRO HMAC 90초 티켓으로만 클라이언트 WebSocket 연결 허용. Worker /market-hub/v1/ingest는 내부 서비스 키 필요.
6. Gate 수신 차단 시 해당 주기 실시간 갱신을 '지연'으로 표시하고 임의 캔들 생성 금지. 다른 거래소 Bybit 데이터를 동일 차트에 혼합하지 않음.

## 부하/비용
한 개 Collector가 Gate/Bybit 소켓을 유지하고, 클라이언트들은 기존 MarketEventHub DO를 통해 분기 수신. 페이지마다 거래소에 직접 접속하지 않음. 진행봉 메시지는 SQL·R2에 기록하지 않아 고빈도 R2 쓰기 비용 방지. 샘플링 때문에 체결 틱 전체 재현이 아님.

## 관리자/고객
- 별도 LUMEX Core 0.5.05.25: 기존 `/market-hub/watchlist`의 REST 401 인증 버그 수정 및 고객 API 읽기 권한 유지.
- 별도 LUMEX Pro Theme 0.5.05.22: `lumex-live-feed.js`가 직통 Bybit 대신 Cloudflare HMAC 티켓 기반 WebSocket을 이용. 5m/15m/60m/240m/D 진행봉을 차트에 표시.
- 다른 비표준 시간봉·별도 터미널 보조 조회는 이번 변경에서 그대로 둠. 실시간 데이터 소스 단일화는 지원된 시간봉에 한정.

## 테스트
- Gate 진행봉 15m 가짜 데이터 파서 검증 (오류 OHLCV 차단)
- 12초 최소 브로드캐스트 간격
- DO 메모리 WS 전송, SQL INSERT/UPDATE 발생하지 않음
- 기존 Worker 연구·Python 백테스트 회귀 검사
- 운영 배포 후 /market-hub/v1/live-health preview_sent 증가 여부 확인

## 운영 검증 분리
GitHub Actions 통과와 Cloudflare /health 1.2.3은 배포 확인. 실제 Gate 진행봉 메시지를 받았는지는 live-health의 preview_sent 증가로만 확인. WordPress 실제 차트 UI는 Core와 Theme ZIP 운영 설치 후 사용자 환경에서 검사.
