# LUMEX Binance 공용 청산 데이터 24/7 중계기

**문제:** Cloudflare Worker에서 Binance USDT 선물 공개 WebSocket 접속이 HTTP 403으로 차단됨. GitHub Actions는 제한된 관측 시간만 제공하고 연속 수집을 보장하지 못함. Gate나 Bybit의 청산을 Binance로 위장하지 않음.

**방법:** Binance WSS 접속이 허용된 *별도의 상시 실행 서버(VPS)* 에서 Node 22 read-only relay를 실행하여, 기존 Cloudflare Worker의 인증된 `/market-hub/v1/binance-external-ingest` 로 공식 Binance 원본 메시지(최대 25건/회)를 보냅니다. Worker가 시장/수량/가격/시각/중복 ID를 재검증하고 기존 MarketEventHub와 R2에 저장합니다. 별도의 주문/거래 계정, Binance API Key 없음.

## 필수 1회 설정

1. Cloudflare `lumex-ai-research2` → Settings → Variables and Secrets에 48자 이상 무작위 값 `LUMEX_BINANCE_RELAY_SECRET` 을 **Secret**으로 등록. 같은 값을 VPS의 `/etc/lumex/binance-relay.env` 에만 저장. GitHub 공개 저장소/채팅에 절대 붙여넣지 마세요.
2. VPS에서 Node >=22를 설치하고 `production/relay/binance-public-relay.mjs` 를 `/opt/lumex-binance-relay/binance-public-relay.mjs` 에 배치. 시스템 사용자 `lumex` 생성.
3. `/etc/lumex/binance-relay.env` 예시:

```dotenv
LUMEX_RELAY_ENDPOINT=https://lumex-ai-research2.kpiplus195.workers.dev/market-hub/v1/binance-external-ingest
LUMEX_RELAY_SECRET=GENERATE_RANDOM_SECRET_WITH_AT_LEAST_48_CHARACTERS
```

4. 소유권 root:lumex, 권한 `0640`. `production/relay/lumex-binance-relay.service`를 `/etc/systemd/system/`에 등록하고 `sudo systemctl daemon-reload && sudo systemctl enable --now lumex-binance-relay` 실행.
5. Binance 접속 실패·서버 지연·503이 생기면 `journalctl -u lumex-binance-relay -n 80 --no-pager` 로 상태를 확인. 비밀키는 로깅하지 않음.
6. Worker 상태 `/market-hub/v1/binance-external-health` 에서 `connected:true`, `stale:false`, `verified_contiguous_seconds` 증가 및 `source_r2_readback_verified:true` 확인. **연속 6시간 이상의 관측, R2 청산 샘플, 다른 거래소 원본과 분리된 기록과 재시작 복구 검증 후에만** WP 청산 Cron 삭제 검토.

**주의:** Binance `!forceOrder@arr` 는 동일 심볼 1초당 최대 1건만 전달하는 공개 스냅샷입니다. 전체 청산을 보장하지 않습니다. Cloudflare 기본 네트워크에서 Binance 403은 이 배포만으로 해소되지 않으며 **실제 외부 VPS를 실행해야** 데이터가 들어옵니다. 소유자가 VPS를 아직 제공하지 않았다면 cPanel `lumex_liq_stream_cron` 유지. `wp-cron.php`와 가상매매 Cron은 건드리지 않습니다.

## Docker Compose 방식 (추가 선택 사항)
기존 systemd 배포 대신 VPS에서 Docker Compose를 이용할 수 있습니다. **두 방식을 동시에 실행하면 동일 청산 패킷이 중복 전달될 수 있으니 하나만 선택하세요.**

1. Cloudflare Secret \`LUMEX_BINANCE_RELAY_SECRET\` 설정(48~200자). 기존 설정 삭제 금지.
2. \`production/relay/.env.example\` 을 \`production/relay/.env.binance-relay\`로 복사하고 같은 비밀값을 \`LUMEX_RELAY_SECRET\`에 입력. \`chmod 600\` 적용. **실제 비밀값은 저장소에 커밋하지 않습니다.**
3. VPS의 배포 저장소 루트에서 \`docker compose -f production/relay/compose.yml up -d --build\` 실행.
4. 로그: \`docker compose -f production/relay/compose.yml logs --tail=80\`.
5. Docker는 자동 재시작·읽기 전용 파일시스템·특권 제거·자원 제한으로 운용됩니다. 공개 상태 API를 확인하는 헬스체크는 **약 1분 간격**, 세션 연결·수신 시각을 확인합니다. 헬스체크 정상은 24시간 데이터가 완전하다는 증명이 아닙니다.

외부 서버 배포 및 Cloudflare Secret 등록은 이 코드 변경만으로 자동 수행되지 않습니다. 시스템이 설치되지 않은 동안은 바이낸스 연속 수집을 '미구축'으로 유지해야 합니다.
