# LYRA regime V2 — 2026-11-18 (research / no production merge)

Research objective: pause during broad sudden selloffs; do not chase the crash with new shorts; allow limited short exposure only after confirmed sustained bear trend and lower volatility. Independently backtested 2022–2026 on verified Gate public 4H BTC/ETH/SOL/XRP candles.

**Critical historical results (independently reset 10,000 USDT account):**

| Historical window | Original LYRA | Default crash pause | Optional confirmed bearish shorts |
|---|---:|---:|---:|
| 2022–23 | -24.87% | -9.07% (halted at 12% DD) | -9.12% (halted) |
| 2023–24 | +27.05% | +35.16% | +34.74% |
| 2024–25 transition | +6.15% | -2.19% | -7.56% (halted) |
| 2025–26 | +8.40% | +2.24% | +4.50% (halted) |
| Recent 2026 | +5.11% | +2.62% | -6.93% (halted) |

Caution: current and earlier research already observed these historical ranges; results are retrospective/selected-after-review and **NOT blind future OOS or audited exchange performance**. Fee/slippage proxy 0.09% per turnover side, adverse funding proxy 0.015% per day; no orderbook/intrabar liquidation modeling. Under 2x costs the default pause system is negative in several periods. **No strategy promoted to live.**

Proposed *initial, not optimized* risk states from completed 4H candles:
- SHOCK: BTC 4H <= -4.5% or 24H <= -9%, or three of four assets each 4H <= -6.5%. Reduce target exposure to zero at **NEXT 4H OPEN**.
- COOLDOWN: minimum 12 bars / 48h, then three calm completed bars before reconsidering entry.
- BEAR: BTC below EMA200 + EMA20 < EMA80 + three closes below EMA80 + 14-day negative momentum; default to PAUSE, optional bounded short-only on preexisting negative LYRA signals, gross <=0.4, only with daily volatility below 9%.
- CAUTION: uncertain trend, gross <=0.35. Portfolio DD >=8% reduces exposure. DD >=12% forces permanent paper halt pending manual review.
- NORMAL: bull trend, usual LYRA with <=1x gross.
- Data gaps halt shadow observations rather than fabricating fills.

A stand-alone downloadable code/evidence package in the associated ChatGPT conversation includes risk module, independent new-schema paper engine, 12 unit tests, 72-bar retrospective replay, official historical OHLCV evidence, full stress-test JSON and Korean handoff. Original WordPress Core/Theme, main Cloudflare Worker, original research scheduler, exchange credentials, existing 7 paper traders, R2 balances and live orders **not changed**.

Known safety corrections in package: persist shock cooldown using absolute candle timestamp / 4h (not the rolling 500-bar array index); after 12% paper halt, book next bar's risk flattening rather than freezing nonzero positions; do not backdate profits; reject v1-to-v2 state reuse or changing short-enabled mode midway. The 4H shock detector can react late; true real-order readiness requires 1m/real-time exchange risk checks, reduce-only order auditing, actual funding/slippage, and 60–90 days forward paper evidence.

**Status: PAPER research candidate only; intentionally not merged into main.**