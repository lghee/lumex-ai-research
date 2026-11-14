# LUMEX Market Hub 1.2.7 — Cloudflare public pulse R2 mirror

Source: Bybit V5 USDT linear ticker (BTC/ETH/SOL/XRP), Bybit 5m account long/short ratio (four coins), Binance USDⓈ-M taker buy/sell volume ratio (four coins), Alternative.me Fear & Greed. Ten independent, bounded HTTP reads per 5-minute scheduled run. The ratios are not position size, net trades, exchange-wide sums or forecasts.

## Safety
- Feature gate: **AUTO_PUBLIC_PULSE_FETCH must equal 'true'**, otherwise no provider fetch or write. Other Cron and trading/order services unchanged.
- R2 latest: `market-hub/public-pulse/v1/latest.json`; append-only bucket archive: `market-hub/public-pulse/v1/observations/YYYYMMDD/HHmm.json`; progress: `market-hub/public-pulse/v1/health.json`.
- Read GET `/market-hub/v1/public-pulse` requires existing service Bearer; public GET `/market-hub/v1/public-pulse-health` returns bounded diagnostics without secret. Old good entries retain their **original sample timestamps** when a source fails. No fabricated zero or cross-provider blending.
- WordPress Core 0.5.05.30 is a separate deployable ZIP, default source legacy. Admin preflight requires all four coins, the correct source semantics and fresh samples before manual opt-in. Failure must not trigger a hidden Bybit/Binance fallback; original WP caches remain.
- User/order/credential/private API data never moved. Whale/liquidation/legacy OI collectors remain until distinct source audits pass.

## Validation
Run `cd production && npm run check` (legacy suites included). New `tests/test_public_pulse_127.mjs` mocks 10 feeds, auth rejection/acceptance, R2 writes, source attribution, all-provider outage preserving last snapshot. Actual provider connectivity, R2 growth, scheduled Cron and WordPress installation remain deployment checks, not CI guarantees.
