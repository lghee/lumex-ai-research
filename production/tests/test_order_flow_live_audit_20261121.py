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
if __name__=="__main__":
 unittest.main()
