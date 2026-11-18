# LUMEX Phase 9 — Cloudflare-only Binance public capture (no VPS)

Date: 2026-11-19. Baseline: Phase 8 Source Recovery, Core 0.6.61 / Theme 0.5.05.83 unchanged.

## Goal and boundary
Architecture: Binance public market source → existing Cloudflare ResearchContainer → existing Worker MarketEventHub → existing R2. No external relay VPS, no additional WordPress plugin, no exchange credentials, no order execution, no simulated historical events. This implementation does NOT assert that Binance permits Cloudflare egress.

## Why conditional?
Existing Worker Durable Object outbound Binance WebSocket returned HTTP 403. Existing research Container probes the official Binance public HTTP Upgrade every 30 minutes. Phase 9 collection starts ONLY when that exact Container returned verified HTTP 101 within the past hour. HTTP 403/451 prevents opening the Container collector. No proxy or access-control bypass.

## Changed files
- production/cloudflare_binance_capture.py: bounded public-only WebSocket observer inside existing ResearchContainer, strict four-symbol allowlist, session ID per reconnect, 300-frame ring buffer and dropped count, 403/451 cooldown.
- production/server.py: authenticated internal /binance-cloudflare-capture route. Reuses existing LUMEX_CONTAINER_KEY.
- production/engine/requirements.txt: websocket-client==1.8.0.
- production/src/index.js: native one-minute Cron bounded read; strict source validation; MarketEventHub ingestion; source-isolated R2 write/readback; update cursor AFTER successful persistence; /market-hub/v1/binance-cloudflare-health.
- production/wrangler.jsonc: AUTO_BINANCE_CLOUDFLARE_CAPTURE true (conditionally gated on successful HTTP 101 probe).
- production/tests/test_cloudflare_binance_capture_20261119.py and .mjs; package.json test inclusion.

## Automatic behavior without additional server
1. Existing 5-minute Cloudflare Cron retains capability proof in R2.
2. Existing 1-minute Cloudflare Cron reads proof. On 403 or stale proof, no Container collector is started. Bybit/Gate and intermittent signed GitHub Binance observation remain unchanged.
3. Only on proven HTTP 101 does the already-existing ResearchContainer open a public Binance WebSocket. One daemon thread per Container and maximum 300 buffered frames.
4. Worker pulls <= 25 source frames per request, <= 4 requests per minute, verifies and deduplicates, stores in original MarketEventHub and R2, verifies readback, then commits cursor.
5. Container restart, socket reconnect, buffer overflow or failed Worker ingest means observation gaps; never infer uninterrupted collection.

## Read-only health
- /market-hub/v1/binance-egress-health: initial Container handshake capability only; HTTP 101 does not prove actual feed.
- /market-hub/v1/binance-cloudflare-health: connected, stale, checkpoint_seq, gap_detected, r2_readback_this_poll, continuous_seconds.
- /market-hub/v1/github-binance-health: existing intermittent GitHub source.
- /market-hub/v1/live-health: existing Bybit/Gate.
- /market-hub/v1/binance-external-health: legacy OPTIONAL VPS relay, NOT required for Cloudflare-only operation.

## Limitations and cost
- No claim that this code has been deployed or that Binance allows the Cloudflare Container to connect. Production verification still required.
- An HTTP 403 in the Container means Binance data cannot be captured continuously through the tested Cloudflare egress. Other venues and genuine intermittent Binance events remain source-separated.
- Cloudflare Containers may incur Cloudflare usage costs if continuously active; this avoids a second VPS but not necessarily all infrastructure charges.
- The Binance forceOrder feed is a snapshot (up to one recent event per symbol per second), not a complete list of liquidation trades.
- WordPress Core 0.6.61 / Theme 0.5.05.83, users, payments, orders, paper trading, existing scheduled tasks, Cron settings and other providers unchanged. Existing cPanel Cron must NOT be deleted from these source-only tests.

## Rollback
Set AUTO_BINANCE_CLOUDFLARE_CAPTURE=false and redeploy Worker, or revert PR. Keep Bybit/Gate and existing Cron untouched. No DB migration. New R2 status record can remain as audit.

## Validation state
New Python unit and Worker integration tests are included in the PR. GitHub CI and production Cloudflare read-only endpoints must be checked before claiming production capture.
