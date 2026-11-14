# LUMEX Market Hub 1.2.10 / WordPress Core 0.5.05.33 — public event identity audit

## Prior baseline
Dependent draft branches: PR #11 Worker 1.2.7 → PR #12 Worker 1.2.8 → PR #13 Worker 1.2.9 → this 1.2.10 PR. WordPress Core 0.5.05.33 based on 0.5.05.32; Theme unchanged 0.5.05.24.

## Exact matching limitations
- WordPress archived Bybit liquidations store SHA-256 fingerprint: v089|Bybit|{symbol}|{position_side}|{timestamp_ms}|{price_8dp}|{qty_8dp}|{id}. Bybit stream processor passes **empty id**, so database does not preserve a native exchange event ID. Cloudflare public stream uses independently derived `bybit:liq:{symbol}:{sha256prefix}`, not the exchange-native ID.
- Core reconstructs WP fingerprint **from CF public packet payload** with exact original PHP `sprintf('%.8F')` formatting and queries existing UNIQUE fingerprint index. This is a payload-fingerprint equality test, not proof the original exchange ID is unique and not a complete stream continuity audit.
- BTC whale comparison uses case-normalized SHA256-format blockchain TXID intersection only. WordPress produces exchange-level net changes, Cloudflare produces watched-address net changes. **Identical TXID does not imply identical flow/direction/value**, and unmatched TXID does not prove an exchange failed. Keep separate.

## Worker 1.2.10
- New private service GET `/market-hub/v1/identity-audit`, strict existing Bearer, four DO hot-index reads and one BTC-only DO read. DO internal `/audit-identities` serves **last 24h** source-scoped, at most 100 Bybit liquidation packets per symbol and at most 100 BTC confirmed-watchlist TXID records. Explicit truncated flags. No raw watched addresses in network response. No full R2 archive scan; past 14d hot retention remains unchanged.
- Source `bybit`, kind `liquidation`, capture `public_stream`, price type `bankruptcy_price`; whale source `blockstream` only. Returns packet timestamp ms, price, quantity, long/short, derived Cloudflare public event ID and BTC hash/side/quantity. Other exchanges excluded, no union of ledgers.
- Protected response fields: schema `lumex_identity_audit_v1`, `archive_merged:false`, `native_bybit_event_id_available:false`, `safe_to_disable_wordpress_crons:false`.
- New automated `production/tests/test_identity_audit_130.mjs`. Existing research/market/queue/archives tests retained.

## WordPress Core 0.5.05.33
- Adds `Lumex_Cloudflare_Market::identity_audit()` read-only bridge to Worker endpoint; no open provider URL.
- Existing admin → Data Health, new explicit nonce+capability+90s cooldown button. No separate plugin/menu, no automatic background audit.
- Validates exact schema, four unique coin symbols, freshness, <=100 packets per symbol, allowlisted side/price/capture/times, duplicate IDs, BTC-only TXIDs. No customer, payment, API key or order data.
- SQL: two existence checks; at most four UNIQUE `fingerprint IN(...)` indexed reads of 100 hashes each; one **bounded** 300-row indexed `provider=esplora,asset=BTC,event_ts` whale query. No INSERT/UPDATE/DELETE of source tables.
- Only aggregate counts, truncated indicators and non-equivalence classification are saved to WordPress option `lumex_cf_identity_audit_v0533`. Never store raw event IDs or raw TXIDs in option/admin HTML.
- Permanent `safe_to_disable_wordpress_crons:false`. Neither WP collector Cron nor Cloudflare old live ledger is changed.

## Reality checks and rollout
A passing CI validates source and offline mocks, not production 24h completeness, provider access, R2 writes, live dedup or WordPress installation. Merge/deploy PRs strictly in dependency order; update WordPress Core afterward. Run Data Health → identity audit **manually** and inspect per-symbol truncation and count, plus Cloudflare/WebSocket/WordPress heartbeats. Zero samples may mean no data captured, never zero liquidation events in the market. Historical WP R2 chunks remain separate and are not added to new Cloudflare live observations.

## Next
A) preserve exchange-native event identifiers where actually supplied (Bybit allLiquidation currently lacks one in WP), B) add separate Binance public stream to Cloudflare while maintaining capture semantics, C) compare BTC watched-address sets and per-address net before proposing selective Cron retirement. Keep all existing WordPress Cron jobs until explicit production parity evidence.
