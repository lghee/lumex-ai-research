"""Guard 5m accumulation and 1h extended history using synthetic, deterministic Gate HTTP data."""
import csv, sys, tempfile, time, unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlparse, parse_qs
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from engine import lumex_ai_worker as e

class History115Tests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.path=Path(self.tmp.name)

    def gate(self,url,**kwargs):
        assert url.startswith(e.GATE_FUTURES_BASE)
        query=parse_qs(urlparse(url).query)
        step={'5m':300_000,'1h':3_600_000}[query['interval'][0]]
        first=int(query['from'][0])*1000;last=int(query['to'][0])*1000
        assert (last-first)//step < 2000
        return [{'t':t//1000,'o':'100','h':'101','l':'99','c':'100','v':'20'} for t in range(first,last+1,step)]

    def test_five_minute_recent_30d_is_collecting_not_90d_research(self):
        target=self.path/'partial.csv'
        with patch.object(e,'http_json',side_effect=self.gate):
            count=e.fetch_gate_futures_candles('BTCUSDT',5,target)
        assert 30*24*12+250 <= count < 90*24*12+250
        all_rows=e.load_csv(target,5,True,min_history_days=30,keep_all=True)
        self.assertEqual(len(all_rows),count)
        with self.assertRaises(e.ResearchError):e.load_csv(target,5,True)
        # A second incremental fetch is allowed to retain all existing bars.
        with patch.object(e,'http_json',side_effect=self.gate):
            next_count=e.refresh_gate_futures_candles('BTCUSDT',5,self.path/'updated.csv',target)
        self.assertEqual(count,next_count)

    def test_hourly_gate_backfill_180_days(self):
        target=self.path/'hourly.csv'
        with patch.object(e,'http_json',side_effect=self.gate):
            count=e.fetch_gate_futures_candles('BTCUSDT',60,target)
        self.assertGreaterEqual(count,180*24+250)
        r=e.load_csv(target,60,True,min_history_days=180,keep_all=True)
        self.assertEqual(len(r),count)
        self.assertLessEqual((time.time()*1000-r[-1,0]),2*3_600_000)

if __name__=='__main__':unittest.main()
