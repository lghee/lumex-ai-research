# LUMEX Market Hub 1.2.12 — 6-hour R2 readback and collection continuity evidence

## Dependency and deployment
This code is based on draft Worker PR #15 and therefore depends on PRs #11 → #12 → #13 → #14 → #15. It does not merge or deploy them. Companion WordPress Core 0.5.05.35 is a separate install ZIP; Theme remains unchanged.

## What was built
- Service-Bearer-only `GET /market-hub/v1/continuity-audit`; no public visitor or user session access. No raw R2 filenames or event IDs returned.
- Durable Object `GET /source-continuity`, limited to six UTC hourly buckets for each BTCUSDT/ETHUSDT/SOLUSDT/XRPUSDT. Uses existing hourly SQL rollup, not a scan of WordPress MySQL or R2 event history. Keeps Bybit liquidation, Binance sampled liquidation, Gate sampled trades and BTC confirmed watched-address observations in **separate** counters.
- Per-symbol `pending_rollup` and `pending_archive` to distinguish visible aggregation delay from archival delay. A zero-hour count says no **observed** packet; it does NOT prove zero market liquidations or a disconnected feed.
- R2 verification: bounded `list(prefix, limit:1)` for the two archive kinds (liquidation, whale_transfer) × last six UTC hour folders, maximum 12 list calls. Per kind, the newest listed JSONL object's **actual bytes** are read back with a 400KB cap and each line's kind, exchange source, symbol, event timestamp and public event ID shape is checked (max 300 lines). Report is a bounded **sample proof only**, not a full R2 completeness certificate. Sparse whales may legitimately have no recent object.
- Report also samples current Gate/Bybit/Binance WebSocket health and BTC public watcher success age. It cannot prove source completeness; an inactive Binance forced-liquidation feed can be quiet without being broken.
- Always `observed_only:true`, `archive_merged:false`, `complete_market_capture:false`, `safe_to_disable_wordpress_crons:false`. No billing, members, exchange API credentials, orders, auto-trading, or WP Cron modified.
- WordPress Core 0.5.05.35 reads this authenticated report **manually** from Data Health. Nonce+admin capability and 90s cooldown. Validates exact schema and six ordered bucket timestamps; retains only aggregated counters/proof/status; never raw R2 key, raw events or secrets.

## Validation
- Run `cd production && npm run check`, including `test_continuity_r2_132.mjs`: unauthorized access blocked before any DO/R2 read, 4 symbols, 6 hourly buckets, 12 R2 list checks, 2 actual JSONL readbacks, invalid R2 sample fail closed, one DO unavailable isolated, previous Bybit/Binance counts kept separate.
- Run plugin `php -l` on all files, JS syntax checks and all Core regression suites plus `test_r2_continuity_0535.php`. Passing CI is only offline simulation; it is not evidence that an operating Worker or production R2 has been verified.
- Operational checklist: sequentially merge and deploy prerequisite Worker changes; GET worker health must show 1.2.12; use WordPress Data Health manual audit; check R2 list errors, actual readback records, DO rollup pending, live source heartbeats, BTC watcher. Collect several days of evidence before considering source Cron retirement. Old Cron remains running.
