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
    proof = {"ok":len(fresh)==8 and not invalid,"schema":"lumex_gate_r2_audit_v1",
      "latest_observed_markets":len(fresh),"total_markets":8,
      "recent_markets":fresh,"snapshots_read":checks,"invalid":invalid,
      "live_verified":False,"customer_launch_ready":False,
      "continuity_24h_verified":False,"continuity_7d_verified":False,
      "source":"Gate WebSocket observer; Binance archive never combined"}
    return proof

def audit_futures_rest_standby(directory, now_ms):
    expected={"BTC","ETH","SOL","XRP"}
    found=[]
    bad=[]
    if not directory:
        return {"ok":False,"symbols":[],"invalid":["standby_evidence_directory_missing"]}
    for symbol in sorted(expected):
        path=pathlib.Path(directory)/(symbol+".json")
        try:
            obj=json.loads(path.read_text(encoding="utf-8"))
            assert obj.get("schema")=="lumex_gate_futures_rest_standby_v1"
            assert obj.get("symbol")==symbol
            assert obj.get("source")=="gateio_rest"
            assert obj.get("market")=="um-futures"
            assert obj.get("ok") is True
            assert obj.get("status") in ("observed_rest_trades","empty_rest_response")
            assert obj.get("websocket_merged") is False
            assert obj.get("binance_archive_merged") is False
            assert obj.get("customer_launch_ready") is False
            assert obj.get("synthetic_values") is False
            assert obj.get("exchange_trade_completeness_verified") is False
            at=obj.get("slice_start_ms")
            assert type(at) is int and at%10000==0 and 0<=now_ms-at<=120000
            checked=obj.get("checked_at_ms")
            assert type(checked) is int and 0<=now_ms-checked<=120000
            count=obj.get("observed_trades")
            assert type(count) is int and 0<=count<1000
            buy=obj.get("buy_quote_usdt")
            sell=obj.get("sell_quote_usdt")
            assert type(buy) in (int,float) and 0<=buy<1e25
            assert type(sell) in (int,float) and 0<=sell<1e25
            if count==0:assert buy==0 and sell==0
            else:assert buy+sell>0
            found.append(symbol)
        except Exception as e:
            bad.append(symbol+":"+type(e).__name__)
    return {"ok":len(found)==4 and not bad,"symbols":found,"invalid":bad,
        "source":"gateio_rest","websocket_merged":False,
        "exchange_complete":False,"customer_launch_ready":False}

def rest_contiguous_current(status, now_ms):
    """Latest REST success proves current bounded observations, never full fills."""
    if not isinstance(status,dict):return False
    last_ok=status.get("last_http_ok_ms") or {}
    cursor=status.get("cursor") or {}
    errors=status.get("last_error") or {}
    for symbol in ("BTC","ETH","SOL","XRP"):
        if errors.get(symbol):return False
        written=last_ok.get(symbol)
        at=cursor.get(symbol)
        if type(written) is not int or type(at) is not int:return False
        if not (0<=now_ms-written<60000 and 0<=now_ms-at<60000):return False
        if at%10000!=0:return False
    return True

def phase37_runtime_features_present(heartbeat):
    """Verify actual running Phase37 DO capabilities, not deployment version alone."""
    if not isinstance(heartbeat,dict):return False
    standby=heartbeat.get("futures_rest_standby")
    return (isinstance(standby,dict) and
            standby.get("contiguous_success_cursor") is True and
            isinstance(standby.get("pending_slice"),dict) and
            type(heartbeat.get("futures_ws_circuit_trips")) is int)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--dir",required=True)
    parser.add_argument("--status",default=None)
    parser.add_argument("--standby-dir",default=None)
    args=parser.parse_args()
    proof=audit(args.dir,int(time.time()*1000))
    heartbeat=None
    p=pathlib.Path(args.status) if args.status else None
    if p and p.is_file():
        try:
            heartbeat=json.loads(p.read_text(encoding="utf-8"))
            assert heartbeat.get("schema")=="lumex_gate_live_observation_health_v1"
            assert heartbeat.get("customer_launch_ready") is False
            assert heartbeat.get("live_verified") is False
            assert isinstance(heartbeat.get("status_written_at_ms"),int)
        except Exception:
            heartbeat=None
    if heartbeat:
        proof["heartbeat_age_seconds"]=round((int(time.time()*1000)-heartbeat["status_written_at_ms"])/1000)
        if not (0 <= proof["heartbeat_age_seconds"] <= 120):
            proof["ok"]=False
            proof["heartbeat_error"]="missing_current_heartbeat"
        proof["websocket_connections"]=heartbeat.get("websocket_connections",[])
        ws_connected="um-futures" in proof["websocket_connections"]
        futures_sources=[x for x in heartbeat.get("sources",[])
                         if x.get("market")=="um-futures"]
        ws_futures_fresh=(len(futures_sources)==4 and
            {x.get("symbol") for x in futures_sources}=={"BTC","ETH","SOL","XRP"} and
            all(type(x.get("last_observed_ms")) is int and
                0<=int(time.time()*1000)-x["last_observed_ms"]<=45000
                for x in futures_sources))
        futures_ws=(ws_connected and ws_futures_fresh and
            int(heartbeat.get("futures_ws_circuit_until") or 0)<=int(time.time()*1000))
        proof["futures_ws_connected_now"]=ws_connected
        proof["futures_ws_recent_trades"]=ws_futures_fresh
        spot={"spot:BTC","spot:ETH","spot:SOL","spot:XRP"}
        rest=audit_futures_rest_standby(args.standby_dir,int(time.time()*1000))
        proof["futures_rest_standby"]=rest
        proof["collection_mode"]="websocket_observed" if futures_ws else "degraded_rest_standby"
        if not futures_ws:
            status=heartbeat.get("futures_rest_standby") or {}
            state_ok=status.get("source")=="gateio_rest" and status.get("websocket_merged") is False
            last_ok=status.get("last_http_ok_ms") or {}
            cursors=status.get("cursor") or {}
            last_error=status.get("last_error") or {}
            proof["futures_rest_unresolved_errors"]={
                x:last_error.get(x) for x in ("BTC","ETH","SOL","XRP") if last_error.get(x)
            }
            verified_all=rest_contiguous_current(status,int(time.time()*1000))
            spot_sources=[x for x in heartbeat.get("sources",[]) if x.get("market")=="spot"]
            source_spot_ok=(len(spot_sources)==4 and
                {x.get("symbol") for x in spot_sources}=={"BTC","ETH","SOL","XRP"} and
                all(type(x.get("last_observed_ms")) is int and
                    0<=int(time.time()*1000)-x["last_observed_ms"]<120000
                    for x in spot_sources))
            proof["ok"]=(rest["ok"] and state_ok and verified_all and source_spot_ok and
                0<=proof.get("heartbeat_age_seconds",9999)<=120 and
                spot.issubset(set(proof["recent_markets"])) and not proof["invalid"])
            proof["degraded"]=proof["ok"]
        else:
            proof["degraded"]=False
            source_fresh=all(type(x.get("last_observed_ms")) is int and
                0<=int(time.time()*1000)-x["last_observed_ms"]<120000
                for x in heartbeat.get("sources",[])) and len(heartbeat.get("sources",[]))==8
            proof["ok"]=proof["ok"] and source_fresh

        proof["websocket_details"]=heartbeat.get("websocket_details",{})
        proof["websocket_close_details"]=heartbeat.get("websocket_close_details",[])[-6:]
        pong=heartbeat.get("futures_last_pong_ms")
        proof["futures_last_pong_age_seconds"]=(
            round((int(time.time()*1000)-pong)/1000) if isinstance(pong,int) and pong>0 else None
        )
        proof["recent_gaps"]=heartbeat.get("unresolved_gaps",[])[-6:]
        proof["invalid_messages"]=heartbeat.get("invalid_messages",0)
        proof["multiplier_check_ms"]=heartbeat.get("multiplier_check_ms")
        proof["collector_runtime_revision"]=heartbeat.get("runtime_revision","legacy_or_unknown")
        proof["phase37_runtime_features_verified"]=phase37_runtime_features_present(heartbeat)
        if not proof["phase37_runtime_features_verified"]:
            proof["ok"]=False
            proof["runtime_feature_error"]="deployed_DO_missing_phase37_contiguous_retry"
        if proof["collector_runtime_revision"] != "phase36_futures_rest_standby_20261121":
            proof["ok"]=False
            proof["runtime_error"]="old_durable_object_version"
        proof["futures_decimal_header_requested"]=heartbeat.get("futures_decimal_header_requested") is True
        proof["message_diagnostics"]=heartbeat.get("message_diagnostics",{})
        if "um-futures" in proof["websocket_connections"] and not proof["futures_decimal_header_requested"]:
            proof["ok"]=False
            proof["precision_error"]="futures_socket_not_proven_decimal_header"

        proof["collector_counts"]={str(i.get("market"))+":"+str(i.get("symbol")):i.get("observed_count")
                                   for i in heartbeat.get("sources",[])}
    else:
        proof["heartbeat_state"]="missing_or_invalid"
        proof["ok"]=False
    print(json.dumps(proof,ensure_ascii=False))
    with open("/tmp/lumex-flow-proof.md","w",encoding="utf-8") as f:
        f.write("## LUMEX Gate WebSocket minute snapshots\n\n")
        f.write(f"- Observed current markets: {proof['latest_observed_markets']} / 8\n")
        f.write(f"- Checked snapshots: {proof['snapshots_read']}\n")
        f.write(f"- Fresh markets: {', '.join(proof['recent_markets']) or 'none'}\n")
        f.write(f"- Invalid payloads: {', '.join(proof['invalid']) or 'none'}\n")
        f.write(f"- Collector heartbeat age: {proof.get('heartbeat_age_seconds','unavailable')}s\n")
        f.write(f"- WebSocket connections: {proof.get('websocket_connections',[])}\n")
        f.write(f"- Last recorded gaps: {proof.get('recent_gaps',[])}\n")
        f.write(f"- WS close codes: {proof.get('websocket_close_details',[])}\n")
        f.write(f"- Futures pong age: {proof.get('futures_last_pong_age_seconds','unknown')}s\n")

        f.write(f"- Collector revision: {proof.get('collector_runtime_revision','unavailable')}\n")
        f.write(f"- Phase37 DO runtime features verified: {proof.get('phase37_runtime_features_verified',False)}\n")
        f.write(f"- Runtime status: {proof.get('runtime_error','current')}\n")
        f.write(f"- Collection mode: {proof.get('collection_mode','unknown')}\n")
        f.write(f"- REST backup evidence: {proof.get('futures_rest_standby',{})}\n")
        f.write(f"- REST unresolved errors: {proof.get('futures_rest_unresolved_errors',{})}\n")

        f.write(f"- Futures decimal request: {proof.get('futures_decimal_header_requested','unavailable')}\n")
        f.write(f"- Filtered vs malformed: {proof.get('message_diagnostics',{})}\n")

        f.write("- **NOT a full market continuity/24h/7d certification. UID/PRO page remains hidden.**\n")
    if not proof["ok"]:
        raise SystemExit("Gate observed trades missing/stale/malformed OR decimal future precision not verified")
if __name__=="__main__":
    main()
