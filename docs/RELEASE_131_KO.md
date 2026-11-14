# LUMEX Market Hub 1.2.11 — Binance USDⓈ-M sampled liquidation and BTC reserve watchlist parity

## Scope
Dependent, **unmerged draft**: PR #11 (public pulse), #12 (OI), #13 (coverage audit), #14 (event identity audit), then this 1.2.11. Companion WordPress Core 0.5.05.34. Theme unchanged.

### Binance public liquidation snapshots
- Cloudflare existing MarketLiveCollector Durable Object connects the **documented** Binance USDⓈ-M public WebSocket `wss://fstream.binance.com/market/ws/!forceOrder@arr` only if `AUTO_LIVE_STREAM=true` AND `AUTO_BINANCE_LIQUIDATIONS=true`. **Default OFF**. No private/user data, order submission or trading change.
- Binance push is latest order snapshot **per symbol per 1000 ms** (not exhaustive liquidation trades). Only BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT; reject COIN-M `st=2`; reject unfilled or nonpositive quantities and invalid times/prices; use average executed price `o.ap` and cumulative executed quantity `o.z`. SELL liquidation ⇒ long position, BUY ⇒ short position. `capture=sampled_1s`, `price_type=avg_execution_price`.
- No guaranteed native exchange ID in documented payload. Deterministic SHA256-based synthetic identity, source prefixed `binance:liq:`; dedup within the existing hot ledger but **possible same-order follow-on snapshots** are not claimed complete or counted as exact volumes. Timestamp + price + quantity dedup is a conservative fingerprint, NOT a market completeness guarantee.
- Binance is separate `source=binance`. Existing Bybit `captures.liquidations.events` and hourly `liquidation` retain Bybit-only semantics, Binance enters `captures.binance_liquidation_snapshots` and hourly `binance_liquidation_sampled`. Older count meaning preserved; no cross-exchange summing. Existing immutable R2 events archive includes source attribution.
- Health status reports the Binance socket enabled/connected/last packet separately. Binance WebSocket uses protocol ping/pong: no unsupported application text ping. Idleness is not proof of no liquidations. Disconnected periods remain gaps.

### BTC watchlist parity
- Cloudflare `BTC_RESERVE_COLLECTOR` continues to retrieve exact authorized WordPress `/wp-json/lumex/v1/market-hub/watchlist`. Each successful list fetch creates a SHA-256 digest of sorted, unique **exact-address-case** list joined with LF, and records count, last checked UTC, source mode. Public raw addresses are **not** exposed by the new route.
- Service Bearer GET `/market-hub/v1/watchlist-parity` returns bounded status: `schema=lumex_watchlist_parity_v1`, source `wordpress_configured`, count, set digest, freshness, last collector success; if missing/old, fails closed. Stale list and fallback seed mode do NOT qualify as matching the WP configuration.
- WordPress Core 0.5.05.34 manually computes the digest with the same canonical rules from `Lumex_Whale_Flows::watchlist()` in the existing plugin. Requires administrator nonce and capability; no new plugin or cron. No raw addresses or Worker token are persisted in audit results. Reports match/mismatch, stale list, and collector enabled state. An equal address set is NOT evidence of complete flow histories or matching per-address net interpretation.
- Always `safe_to_disable_wordpress_crons:false`. WordPress liquidations Bybit+Binance, BTC whale cron, OI, market, research, member/payment/order Cron unchanged.

## Verification and rollout
- Source tests `cd production && npm run check` including new `test_binance_parity_131.mjs`.
- PHP Core `php -l` entire plugin and local offline tests. Production proof requires observing actual Binance 1s snapshot messages with correct st/symbol and R2 archiving + same-address parity under real WordPress credentials; none claimed by CI alone.
- Upgrade sequence: merge/deploy PRs #11→#12→#13→#14→#15, verify Worker health 1.2.11, enable `AUTO_BINANCE_LIQUIDATIONS` only after readiness, update Core 0.5.05.34, manually run Data Health audit. Never disable original WordPress cron until exchange and address-level 24h+ continuity/parity is proven. Existing public cloud collector can continue without enabling Binance.
- Binance official docs: https://developers.binance.info/docs/derivatives/usds-margined-futures/websocket-market-streams/All-Market-Liquidation-Order-Streams
