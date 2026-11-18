# LYRA candidate — independent research, 2026-11-18

**Status: paper-forward candidate ONLY. Not live approved.**

The LUMEX WordPress admin and Cloudflare production branches are unchanged. Candidate source code, tests and the full historic public data evidence are bundled separately in the conversation deliverable `LUMEX_LYRA_PAPER_RESEARCH_FULL_20261118.zip`.

## Evidence
- Gate public 4H BTC/ETH/SOL/XRP observations, October 2022–November 2026; 9,000 verified bars per asset after recovering one missing 2024-10-29 08:00 UTC bar per asset from official Gate API, no interpolation.
- Explored 25 variants on chronologically separated retrospective periods. This is a **selected-after-review** hypothesis, NOT blind future OOS confirmation.
- Frozen LYRA rules: 50% 14d+60d time-series momentum, 50% 28d cross-sectional winner-long / loser-short with >=5 percentage point dispersion; 3-day rebalance, <=1x gross exposure, volatility scaling.
- TRAIN 2023-03–2025-01: +18.20% net, 21.45% maximum drawdown, +7.66% double cost.
- VALIDATION 2025-01–2025-11: +5.65%, 16.40% maximum drawdown, +1.68% double cost.
- EVALUATION 2025-11–2026-11: +11.16%, 12.81% maximum drawdown, +5.49% double cost.
- 180-day independent reset windows: only 3 of 7 positive; **not enough robustness for live trading**.
- Fee/slippage proxy .09% per side and adverse funding proxy .015%/day; neither real exchange fills nor funding history, liquidation or intrabar risk are proven.

## Separate paper-forward eligibility
- Dedicated 10,000 USDT research-only seed with zero historical PnL carried into it.
- >=60 days, 360 consecutive verified 4H closed bars, >=20 rebalance opportunities and >=8 real-time paper changes.
- Positive forward net and double-cost return, <=10% paper max drawdown, zero gaps.
- No automatic real trading even if these pass. Manual admin approval and separate execution/funding/orderbook testing are required.

## Safety
No exchange key, trading/order endpoint, member data, WordPress changes, production Worker changes or customer-facing return display is part of this research update. Current LYRA shadow prototype is not deployed: no assertion of active forward-paper operation.
