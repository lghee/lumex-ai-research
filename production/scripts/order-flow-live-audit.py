#!/usr/bin/env python3
"""Read-only attestation for observed Gate minute snapshots (never launch proof)."""
import argparse
import json
import pathlib
import time
from collections import defaultdict

MARKETS = {"spot", "um-futures"}
SYMBOLS = {"BTC", "ETH", "SOL", "XRP"}
def audit(root, now_ms):
    files = sorted(pathlib.Path(root).glob("*.json"))
    observed = defaultdict(int)
    last = defaultdict(int)
    checks = 0
    invalid = []
    for file in files:
        try:
            v = json.loads(file.read_text(encoding="utf-8"))
            assert v["schema"] == "lumex_gate_ws_observed_minute_v1"
            assert v["source"] == "gateio"
            assert v["complete_trades_verified"] is False
            assert v["customer_launch_ready"] is False
            assert v["historical_binance_archive_combined"] is False
            assert v["synthetic_values"] is False
            stamp = v["observed_minute_ms"]
            assert isinstance(stamp, int) and stamp % 60000 == 0
            assert stamp < now_ms + 60000 and now_ms - stamp < 3600000
            rows = v["rows"]
            assert isinstance(rows, list) and len(rows) <= 8
            for r in rows:
                assert r["source"] == "gateio"
                assert r["market"] in MARKETS and r["symbol"] in SYMBOLS
                n = r["observed_trades"]
                buy = r["buy_quote_usdt"]
                sell = r["sell_quote_usdt"]
                assert type(n) is int and 0 < n < 100000000
                assert type(buy) in (int,float) and 0 <= buy < 1e25
                assert type(sell) in (int,float) and 0 <= sell < 1e25
                assert buy+sell > 0
                assert r["last_trade_ms"] >= stamp
                key = r["market"] + ":" + r["symbol"]
                observed[key] += n
                last[key] = max(stamp, last[key])
            checks += 1
        except Exception as err:
            invalid.append(f"{file.name}: {type(err).__name__}")
    fresh = sorted(k for k,t in last.items() if now_ms-t < 8*60000)
    proof = {"ok":bool(fresh) and not invalid,"schema":"lumex_gate_r2_audit_v1",
      "latest_observed_markets":len(fresh),"total_markets":8,
      "recent_markets":fresh,"snapshots_read":checks,"invalid":invalid,
      "live_verified":False,"customer_launch_ready":False,
      "continuity_24h_verified":False,"continuity_7d_verified":False,
      "source":"Gate WebSocket observer; Binance archive never combined"}
    return proof

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--dir",required=True)
    args=parser.parse_args()
    proof=audit(args.dir,int(time.time()*1000))
    print(json.dumps(proof,ensure_ascii=False))
    with open("/tmp/lumex-flow-proof.md","w",encoding="utf-8") as f:
        f.write("## LUMEX Gate WebSocket minute snapshots\n\n")
        f.write(f"- Observed current markets: {proof['latest_observed_markets']} / 8\n")
        f.write(f"- Checked snapshots: {proof['snapshots_read']}\n")
        f.write(f"- Fresh markets: {', '.join(proof['recent_markets']) or 'none'}\n")
        f.write(f"- Invalid payloads: {', '.join(proof['invalid']) or 'none'}\n")
        f.write("- **NOT a full market continuity/24h/7d certification. UID/PRO page remains hidden.**\n")
    if not proof["ok"]:
        raise SystemExit("Gate observed trade snapshots absent, stale or malformed (no invented fallback)")
if __name__=="__main__":
    main()
