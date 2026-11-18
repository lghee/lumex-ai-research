import json
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from cloudflare_binance_capture import CloudflareBinanceCapture, clean_public_snapshot, MAX_BUFFER

NOW=int(time.time()*1000)
def frame(now=NOW):
    return json.dumps({"stream":"!forceOrder@arr","data":{
        "e":"forceOrder","E":now,"st":1,
        "o":{"s":"BTCUSDT","S":"SELL","X":"FILLED","T":now,
             "ap":"80000.25","z":"0.09"}}})

class FakeSocket:
    def __init__(self, msgs):
        self.messages=list(msgs)
        self.closed=False
    def settimeout(self, sec):
        assert sec==25
    def recv(self):
        if self.messages:
            return self.messages.pop(0)
        raise ConnectionError("fixture_closed")
    def close(self):
        self.closed=True

class CloudflareBinanceTests(unittest.TestCase):
    def test_public_snapshot_allowlist(self):
        self.assertEqual(clean_public_snapshot(frame())["data"]["o"]["s"],"BTCUSDT")
        self.assertIsNone(clean_public_snapshot(frame(NOW-400000)))
        self.assertIsNone(clean_public_snapshot(frame().replace("BTCUSDT","DOGEUSDT")))
        self.assertIsNone(clean_public_snapshot(frame().replace('"st": 1','"st": 0')))
        self.assertIsNone(clean_public_snapshot('{"data":{},"stream":"other"}'))
        self.assertIsNone(clean_public_snapshot('a'*6001))

    def test_session_cursor_non_destructive(self):
        ws=FakeSocket([frame()])
        c=CloudflareBinanceCapture(socket_factory=lambda *args, **kwargs:ws)
        c.ensure()
        c.thread.join(timeout=3)
        snapshot=c.peek("",0)
        self.assertTrue(snapshot["session_changed"])
        self.assertEqual(len(snapshot["frames"]),1)
        self.assertEqual(snapshot["frames"][0]["seq"],1)
        self.assertEqual(len(c.peek(snapshot["session_id"],0)["frames"]),1)
        self.assertEqual(len(c.peek(snapshot["session_id"],1)["frames"]),0)
        self.assertTrue(ws.closed)
        self.assertFalse(snapshot["connected"])
        self.assertTrue(snapshot["worker_is_source_of_truth"])
        self.assertFalse(snapshot["full_market_capture"])
        self.assertFalse(snapshot["trading_enabled"])

    def test_reconnect_reset_and_gap(self):
        c=CloudflareBinanceCapture()
        with c.lock:
            c.seq=MAX_BUFFER+1
            c.buffer.clear()
            for n in range(2,MAX_BUFFER+2):
                c.buffer.append({"seq":n,"frame":{"v":n}})
            c.dropped=1
        p=c.peek(c.session_id,0)
        self.assertTrue(p["cursor_gap"])
        self.assertEqual(p["oldest_seq"],2)
        self.assertEqual(len(p["frames"]),25)
        self.assertEqual(p["dropped_events"],1)

    def test_403_backoff(self):
        class Forbidden(Exception):
            status_code=403
        def forbidden(*args,**kwargs):
            raise Forbidden("forbidden")
        c=CloudflareBinanceCapture(socket_factory=forbidden)
        c.ensure();c.thread.join(timeout=3)
        h=c.status()
        self.assertIn("403",h["error_code"])
        self.assertGreater(h["next_retry_ms"],int(time.time()*1000)+29*60*1000)
        c.ensure()
        self.assertFalse(c.thread.is_alive())
        self.assertFalse(h["connected"])

if __name__=="__main__":
    unittest.main()
