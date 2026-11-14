# LUMEX Market Hub 1.2.9 — Source coverage & duplicate-safety audit

## Purpose
The existing WordPress Core public liquidation collector retains **Bybit + Binance** records. The Cloudflare public Market Hub currently records **Bybit observed allLiquidation**, while its BTC whale net flows cover only selected confirmed watched reserve addresses. These sources are **not equivalent**, and previous WordPress historical records in R2 are stored **separately from live events**.

This release adds a strictly read-only, Bearer-protected 4-symbol public observation audit. It does NOT decommission or auto-disable any WordPress Cron, nor change orders, accounts, indicators, settlement or alert logic.

## Worker
- GET `/market-hub/v1/collector-audit` requires existing service Bearer (same security as R2 candles).
- Concurrent bounded reads (4 total) from BTC/ETH/SOL/XRP MarketEventHub's 24h SQL hourly materialized rollups. No MySQL, raw event IDs or R2 history scan.
- Per symbol: only `kind=liquidation,source=bybit` event count; BTC only `kind=whale_transfer,source=blockstream` count; rollup up-to-date flag and pending count. **Binance is excluded**, not silently conflated with Bybit.
- Fixed explicit flags `observed_only:true`, `archive_merged:false`, `safe_to_disable_wordpress_crons:false`. Any unavailable symbol is marked `ok:false`, all four preserved, no fabricated 0 meaning full market.
- No user data, customer credentials, exchange keys, trade orders or write operations.

## WordPress Core 0.5.05.32
- `includes/class-lumex-collector-cutover-audit.php` integrated into existing LUMEX Core and Data Health screen. No new plugin.
- Explicit administrator-only nonce-gated action, 90-second cooldown. SQL aggregate only: public observed liquidations by coin/exchange and whale transfers by provider, within 24h, with table-presence guard. Source and counters whitelisted, latest report stored as option.
- Cloudflare probe uses server Bearer and validates 4 unique symbols, zero/negative/malformed data, 15-minute report age, no false decommission flag; also reads existing read-only R2 legacy backfill health.
- UI marks 0 as **captured observations** only. A report with four good rollups still says **different_capture_scopes**; NEVER allows Cron shutdown. Legacy R2 archive stays disjoint from live and must not be counted in aggregate.

## Verification and operating handoff
- Run GitHub Actions `cd production && npm run check`, including `test_collector_audit_129.mjs`; run `php -l` for Core and local `test_collector_cutover_audit_0532.php` plus previous Core .28-.31 QA suites.
- Must deploy dependent PR #11 then PR #12 before this PR #13; source code success is not deployed Worker. Never enable any previous optional cutovers before their live preflight.
- WordPress plugin 0.5.05.32 may be installed before 1.2.9 Worker; until deployed, audit fetch fails closed and prior Cron remains unchanged.
- Next migration: compare native Bybit event IDs/normalized price and quantity timestamps, Binance stream coverage separately, Bitcoin address/txid/fingerprint and watched-address completeness. Only after a defensible cross-source dedup and continuous observation comparison could independent Cron retirement be considered.
