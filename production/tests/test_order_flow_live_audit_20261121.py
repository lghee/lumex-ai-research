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
    "customer_launch_ready":False,"synthetic_values":False}
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
if __name__=="__main__":
 unittest.main()
