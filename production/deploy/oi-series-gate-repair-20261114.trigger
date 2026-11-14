LUMEX production market-data repair 2026-11-14
Source label: single-exchange historical OI Bybit/Binance with Gate 1h/4h fallback.
Binance public 1-second forced-liquidation websocket is independently enabled; errors are isolated.
No customer orders/keys, no WordPress Cron removal or personal data.
Deploy once after PR #20 merges to main and full source QA passes.

Retry deployment after correcting time-boundary QA; no production logic changes; all source checks still run before deploy.
