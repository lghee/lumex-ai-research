# LUMEX integrated data repair — Gate OI source rescue and Binance public liquidation probe

- OI: Bybit linear public 3-request same-source series first; if unavailable then complete Binance 3-request series; only if both fail use the independently verified Gate futures contract_stats `1h` / `4h` historical series (200 records per coin/frame, >=5d/25d, no gaps, only closed intervals). Each is **one single-exchange observation**. `exchange:'Gate'`, `sources:['Gate futures contract_stats public 1h|4h']`; never call it Bybit/Binance data and never mix the price/volume.
- OI reports persist true exchange origin, explicit Gate fallback flag and independent R2 history. WordPress companion Core 0.6.03 and theme 0.5.05.30 validate/display that source without turning on any Cron by default.
- Binance public forced-liquidation WebSocket: independently enable `AUTO_BINANCE_LIQUIDATIONS=true` using existing MarketLiveCollector. This is **one per-symbol latest snapshot each second, not all liquidations**; blocked connection must not stop Bybit/Gate. Strict source, position side and timestamp validation. If live Binance cannot connect from Cloudflare, report it as unavailable and keep WordPress legacy Cron; never invent Binance trades.
- Existing BTC reserve-address observer and hourly R2 archive collectors remain. They are **not** proven to represent exchange-wide whale transfer flows. WordPress legacy source Cron and trading/order cron unchanged.
- Market Terminal OI now accepts Gate as explicit exchange, with all 5 sections source separated. No new public access, no credentials, no orders.
- CI includes `production/tests/test_gate_oi_rescue_132.mjs` for Bybit/Binance 403 → source-labeled Gate OI, 7d/30d history, R2 readback and Bearer protections. Deploy only after CI green. Worker version remains 1.3.1 to preserve Core / Theme client compatibility.

## Operating checks
1. GitHub source CI green, then deploy existing named Worker via guarded Actions with configured Cloudflare secrets.
2. GET public `/market-hub/v1/oi-health` must list 8 slots; target 8/8 latest successful. May take 8 chronological 5-minute slot ticks; prior failed slots remain visible until that slot reruns.
3. GET `/market-hub/v1/live-health` must report Bybit and Gate connected; Binance may be blocked and has isolated error/status. GET `/market-hub/v1/whale-health` and `/market-hub/v1/archive-health` and WordPress administrator 6h R2 audit for actual data provenance.
4. Only then install Core 0.6.03 / theme 0.5.05.30; do not prematurely disable WordPress source or private order cron.
5. For any source fallback, customer-facing copy says Gate/Bybit/Binance by name; no financial market totals or guaranteed trading returns claimed.

## Limits
Cross-exchange OI values are **not equivalent**; replacing an unavailable Bybit series with Gate is always labelled and should not be silently merged into strategy research. Historical streams interrupted before Worker enable cannot be retroactively reconstructed from 1-second latest snapshots. End-to-end WordPress PRO chart HMAC checks require a live authenticated user session. Any remaining duplicate storage/cPanel Cron retirement requires independent operator verification, not code CI.
