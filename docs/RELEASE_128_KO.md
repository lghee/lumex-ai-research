# LUMEX Market Hub 1.2.8 — Source-matched OI R2 mirror

## Prior version and scope
Based on draft PR #11 / Worker 1.2.7. This is a separate dependent implementation, not merged to main or deployed. Core 0.5.05.31 is delivered as a separate WordPress plugin. No new standalone plugin, trading engine or private API.

## Collection
- 5-minute scheduler when `AUTO_OI_MIRROR_FETCH=true`; **default OFF**. One of 8 slots per run: BTC, ETH, SOL, XRP × 7-day (1h) or 30-day (4h), deterministic 40-minute rotation.
- Three Bybit public V5 requests per slot: linear ticker, open-interest, matching kline. If any Bybit request fails, try three Binance public requests *as a complete alternate source* (premiumIndex, openInterestHist, klines). Never combine Bybit price with Binance OI, and never replace either with Gate.
- Bybit openInterest base quantity × matched Bybit candle price ⇒ exchange-specific estimated notional; Binance sumOpenInterestValue is already quoted notional. Preserve exchange attribution.
- Strict >0 finite values, matching candle timestamps, strictly ascending history, 5-day/25-day minimum span, enough rows and recent last historical sample. A failed slot never overwrites the last valid snapshot or creates a fabricated zero. All timestamps in UTC.
- R2: `market-hub/oi/v1/latest/{BTC|ETH|SOL|XRP}-{7|30}.json`, dated 5-minute archives `market-hub/oi/v1/observations/{COIN}/{days}/{YYYYMMDD}/{HHmm}.json`, and `market-hub/oi/v1/health.json`. Re-entrant Cron uses existing archive bytes as latest to avoid within-slot source drift; read-only old archives.
- Authenticated reads (existing internal service Bearer): `/market-hub/v1/oi-history?symbol=BTCUSDT&days=7|30`, `/market-hub/v1/oi-preflight` with 8 slots. Bounded public health: `/market-hub/v1/oi-health`. No accounts, keys, orders, personal data, or live liquidation ledger.

## WordPress Core 0.5.05.31
- In existing plugin, add `Lumex_CF_OI_Mirror` opt-in; default `legacy`. Preflight must validate 8 correct coin/interval source-labeled, temporally current R2 records before manually switching. Nonce + admin capability; explicit rollback to old MySQL observer. No hidden direct HTTP fallback when Cloudflare mode is active.
- `Lumex_Liquidation_Lab::route` consumes source-matched Cloudflare snapshots as the existing normalized market observation shape and passes them to the existing risk/scenario calculator. 3-day requests subset the 7-day history. Data semantics and attribution are preserved.
- `Lumex_Observatory_Archive::collect_market` in CF mode skips external Bybit/Binance OI requests and MySQL new OI writes; remaining independent market intelligence Cron and billing/orders unchanged. Original cPanel HTTP Cron remains installed, and is not removed.
- **Do not remove** the WordPress public liquidation WebSocket Cron or BTC whale Cron. CF liquidation provides Bybit only; WordPress additionally captures Binance snapshots. CF BTC watchlist/fingerprints are not yet verified 1:1 with WordPress; legacy data backfill is audit-only.

## Verification
Run Worker `cd production && npm run check` and Core PHP lint + offline contract tests. CI mocks are not production API or R2 evidence. Before enabling in production: merge/deploy 1.2.7 dependency then 1.2.8, enable `AUTO_OI_MIRROR_FETCH`, allow >=40 minutes for 8 slots, confirm all 8 source snapshots and their timestamps, install Core .31, run admin preflight then explicitly enable. If any source remains inaccessible, stay in legacy mode.

## Rollback and known limits
Switch Core option `lumex_cf_oi_mode_v0531=legacy` via admin. Do not delete old SQL or tokens. Cloudflare OI snapshots are not the full market and are not actual individual liquidation prices. 7d and 30d history is a rolling ~200-row window; R2 archives do not automatically represent a continuous fully reconstructed timeseries. Source failures, 403/429, clock drift, race conditions across distinct Cron workers and real UI parity still require deployment checks.
