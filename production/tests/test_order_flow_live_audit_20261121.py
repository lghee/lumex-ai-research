"""Fail-closed Gate R2 8/8 live snapshot audit contracts."""
import importlib.util
import json
import pathlib
import tempfile
import time
import unittest
P=pathlib.Path(__file__).resolve().parents[1]/"scripts"/"order-flow-live-audit.py"
spec=importlib.util.spec_from_file_location("flow_audit",P)
mod=importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
M=60000
class GateObservedAudit(unittest.TestCase):
 def test_all_eight_required(self):
  now=int(time.time()*1000)
  minute=now//M*M-M
  base={"schema":"lumex_gate_ws_observed_minute_v1","source":"gateio",
   "complete_trades_verified":False,"customer_launch_ready":False,
   "historical_binance_archive_combined":False,"synthetic_values":False,
   "observed_minute_ms":minute}
  with tempfile.TemporaryDirectory() as folder:
   path=pathlib.Path(folder)/"sample.json"
   rows=[{"source":"gateio","market":market,"symbol":symbol,
     "observed_trades":1,"buy_quote_usdt":10,"sell_quote_usdt":5,
     "last_trade_ms":minute+1000}
     for market in ("spot","um-futures") for symbol in ("BTC","ETH","SOL","XRP")]
   path.write_text(json.dumps({**base,"rows":rows}),encoding="utf-8")
   self.assertEqual(mod.audit(folder,now)["latest_observed_markets"],8)
   self.assertTrue(mod.audit(folder,now)["ok"])
   path.write_text(json.dumps({**base,"rows":rows[:1]}),encoding="utf-8")
   self.assertEqual(mod.audit(folder,now)["latest_observed_markets"],1)
   self.assertFalse(mod.audit(folder,now)["ok"])
   path.write_text(json.dumps({**base,"rows":rows,
     "synthetic_values":True}),encoding="utf-8")
   self.assertFalse(mod.audit(folder,now)["ok"])
 def test_standby_requires_fresh_exact_four_rest_objects(self):
  now=int(time.time()*1000)
  slot=now//10000*10000-20000
  def sample(symbol):
   return {"schema":"lumex_gate_futures_rest_standby_v1",
    "symbol":symbol,"market":"um-futures","source":"gateio_rest",
    "slice_start_ms":slot,"checked_at_ms":now-1000,
    "ok":True,"status":"observed_rest_trades",
    "observed_trades":2,"buy_quote_usdt":1.2,"sell_quote_usdt":1.3,
    "websocket_merged":False,"binance_archive_merged":False,
    "exchange_trade_completeness_verified":False,
    "customer_launch_ready":False,"synthetic_values":False,
    "source_join_allowed":False,"full_page_reused":False,
    "request_count":1,"adaptive_time_partitioned":False,
    "min_partition_seconds":10,
    "segment_proofs":[{"from_ms":slot,"to_ms":slot+10000,
      "observed_trades":2,"api_limit":1000,"source":"gateio_rest"}]}
  with tempfile.TemporaryDirectory() as folder:
   p=pathlib.Path(folder)
   for sym in ("BTC","ETH","SOL","XRP"):
    (p/(sym+".json")).write_text(json.dumps(sample(sym)),encoding="utf-8")
   self.assertTrue(mod.audit_futures_rest_standby(folder,now)["ok"])
   (p/"BTC.json").write_text(json.dumps({**sample("BTC"),"websocket_merged":True}),encoding="utf-8")
   self.assertFalse(mod.audit_futures_rest_standby(folder,now)["ok"])
   (p/"BTC.json").write_text(json.dumps(sample("BTC")),encoding="utf-8")
   (p/"XRP.json").unlink()
   self.assertFalse(mod.audit_futures_rest_standby(folder,now)["ok"])
   (p/"XRP.json").write_text(json.dumps({**sample("XRP"),"checked_at_ms":now-200000}),encoding="utf-8")
   self.assertFalse(mod.audit_futures_rest_standby(folder,now)["ok"])
 def test_contiguous_rest_status_rejects_errors_and_stale_cursors(self):
  now=int(time.time()*1000)
  at=now//10000*10000-10000
  symbols=("BTC","ETH","SOL","XRP")
  base={"last_http_ok_ms":{x:now-1000 for x in symbols},
        "cursor":{x:at for x in symbols},
        "last_error":{}}
  self.assertTrue(mod.rest_contiguous_current(base,now))
  self.assertFalse(mod.rest_contiguous_current(
    {**base,"last_error":{"ETH":{"reason":"http_503","at_ms":now}}},now))
  self.assertFalse(mod.rest_contiguous_current(
    {**base,"cursor":{**base["cursor"],"BTC":now-180000}},now))
  self.assertFalse(mod.rest_contiguous_current(
    {**base,"last_http_ok_ms":{**base["last_http_ok_ms"],"XRP":now-80000}},now))
  self.assertFalse(mod.rest_contiguous_current(
    {**base,"cursor":{**base["cursor"],"SOL":None}},now))
  self.assertFalse(mod.rest_contiguous_current({},now))
 def test_phase37_requires_live_runtime_feature_fingerprint(self):
  features={"futures_rest_standby":{"contiguous_success_cursor":True,"pending_slice":{}},
            "futures_ws_circuit_trips":2}
  self.assertTrue(mod.phase37_runtime_features_present(features))
  self.assertFalse(mod.phase37_runtime_features_present(
    {**features,"futures_rest_standby":{"pending_slice":{}}}))
  self.assertFalse(mod.phase37_runtime_features_present(
    {**features,"futures_rest_standby":{"contiguous_success_cursor":True}}))
  self.assertFalse(mod.phase37_runtime_features_present(
    {**features,"futures_ws_circuit_trips":"2"}))
  self.assertFalse(mod.phase37_runtime_features_present({}))
 def test_adaptive_rest_proves_2500_real_rows_without_reusing_full_pages(self):
  slot=int(time.time()*1000)//10000*10000-20000
  parts=[]
  cursor=slot
  for span,count in ((2000,500),(3000,750),(2000,500),(3000,750)):
   parts.append({"from_ms":cursor,"to_ms":cursor+span,
     "observed_trades":count,"api_limit":1000,"source":"gateio_rest"})
   cursor+=span
  base={"slice_start_ms":slot,"observed_trades":2500,
    "request_count":7,"adaptive_time_partitioned":True,
    "segment_proofs":parts,"min_partition_seconds":2,
    "source_join_allowed":False,"full_page_reused":False}
  self.assertTrue(mod.verify_rest_partition_proofs(base))
  self.assertFalse(mod.verify_rest_partition_proofs(
    {**base,"segment_proofs":[{**parts[0],"observed_trades":1000},*parts[1:]]}))
  self.assertFalse(mod.verify_rest_partition_proofs(
    {**base,"segment_proofs":[parts[0],{**parts[1],"from_ms":parts[1]["from_ms"]+1000},*parts[2:]]}))
  self.assertFalse(mod.verify_rest_partition_proofs({**base,"request_count":20}))
  self.assertFalse(mod.verify_rest_partition_proofs({**base,"full_page_reused":True}))
  self.assertFalse(mod.verify_rest_partition_proofs({**base,"adaptive_time_partitioned":False}))
  self.assertFalse(mod.verify_rest_partition_proofs({**base,"observed_trades":2499}))
  self.assertFalse(mod.verify_rest_partition_proofs({**base,"source_join_allowed":True}))
  now=int(time.time()*1000)
  with tempfile.TemporaryDirectory() as folder:
   directory=pathlib.Path(folder)
   for symbol in ("BTC","ETH","SOL","XRP"):
    payload={"schema":"lumex_gate_futures_rest_standby_v1",
      "source":"gateio_rest","market":"um-futures","symbol":symbol,
      "checked_at_ms":now-1000,"ok":True,"status":"observed_rest_trades",
      "websocket_merged":False,"binance_archive_merged":False,
      "customer_launch_ready":False,"synthetic_values":False,
      "exchange_trade_completeness_verified":False,
      "buy_quote_usdt":25000,"sell_quote_usdt":30000,**base}
    (directory/(symbol+".json")).write_text(json.dumps(payload),encoding="utf-8")
   proof=mod.audit_futures_rest_standby(folder,now)
   self.assertTrue(proof["ok"])
   self.assertEqual(set(proof["adaptive_symbols"]),{"BTC","ETH","SOL","XRP"})
   self.assertEqual(proof["api_requests"],28)
   broken=json.loads((directory/"ETH.json").read_text())
   broken["segment_proofs"][1]["observed_trades"]=1000
   (directory/"ETH.json").write_text(json.dumps(broken))
   self.assertFalse(mod.audit_futures_rest_standby(folder,now)["ok"])
if __name__=="__main__":
 unittest.main()
