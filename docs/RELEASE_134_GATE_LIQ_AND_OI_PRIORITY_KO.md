# LUMEX continuation: Gate 5min liquidation aggregates and failed OI priority

## Observed live failures after PR #20 deployment
- Real Cloudflare Worker 1.3.1 installed, Bybit/Gate public WebSockets connected, BTC confirmed-address poll connected.
- Binance USDT public forceOrder 1-second WebSocket `enabled=true` produced `state=reconnecting`, `connected=false`, zero packets and `exchange_websocket_error`. This is **not** successful Binance capture. Disable useless repeat attempts to protect reliability.
- ETH 30d OI health still shows the *earlier* HTTP 403 until its 40-minute rotation slot is revisited; the Gate source-isolated rescue code exists, but old status cannot be marked success prematurely.

## New source-safe behavior
- `AUTO_BINANCE_LIQUIDATIONS=false`: Bybit + Gate public live observers remain; Binance missing is explicitly `null`, never a fabricated 0 event count.
- Gate `futures/usdt/contract_stats` 5m public rows already used for taker volume provide **long_liq_usd_new / short_liq_usd_new**, falling back to older `long_liq_usd / short_liq_usd` fields only where source includes them. Aggregate at most three closed 5m bars, store with the *Gate* symbol, time window and label. These are **exchange public summary statistics**, not individual transaction/trade event counts and NOT Binance liquidations. No new external API calls.
- Customer market panel displays `Gate 최근 15분 청산 규모` only when both source amounts are valid; the old Bybit/Binance actual live event panel remains separate.
- OI health prioritizes an already failed OI slot after 10-minute retry cooldown before normal 40-minute rotation. Exactly **one** source-labeled OI slot per five-minute Cron (not increased load). After successful Gate rescue, normal rotation resumes. This reduces the time a known failed `ETH-30` remains blank.
- Worker HMAC authorizations, PRO access, trading/order/member/payment services remain unchanged. WordPress Core 0.6.03 already supports Gate OI; Theme 0.5.05.31 adds source-labelled liquidation summary and zero-event correction.

## QA and deployment
- Original Gate collector and OI fixture regression extended to actual 5min liquidation fields and forced failed ETH-30 priority.
- Terminal regression confirms Gate aggregated USD fields and Binance disabled -> `null`.
- Full production JS+research regression required before merge, one-time deploy event on merge. Operating acceptance: `public-pulse-health 10/10`, `oi-health 8/8` as slots refresh, `live-health gate/bybit true, binance disabled`, `whale-health enabled/source wordpress_configured`.
- Do NOT stop cPanel WordPress public market, liquidation, whale, risk, alerts or user trading/order/payment Cron yet. R2 sample ≠ proof of all missing event-free time windows.
