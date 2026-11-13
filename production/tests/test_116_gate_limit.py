"""Regression: Gate returns 400/Candlestick too long ago for 5m older than 25d."""
import io, json, sys, tempfile, time, unittest, urllib.error
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs,urlparse
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from engine import lumex_ai_worker as e

class GateRecentLimitTests(unittest.TestCase):
    def test_bootstrap_falls_back_and_does_not_allow_research(self):
        attempted=[]
        def fake(url,**kw):
            params=parse_qs(urlparse(url).query)
            self.assertEqual(params['interval'][0],'5m')
            start=int(params['from'][0]);stop=int(params['to'][0]);now=int(time.time())
            attempted.append(start)
            if start < now-25*86400:
                body=b'{"label":"INVALID_PARAM_VALUE","message":"Candlestick too long ago. Maximum 10000 points recently are allowed"}'
                raise urllib.error.HTTPError(url,400,'Bad Request',{},io.BytesIO(body))
            return [{'t':t,'o':'100','h':'101','l':'99','c':'100','v':'15'} for t in range(start,stop+1,300)]
        with tempfile.TemporaryDirectory() as d,patch.object(e,'http_json',side_effect=fake):
            target=Path(d)/'test.csv'
            n=e.fetch_gate_futures_candles('BTCUSDT',5,target)
            self.assertGreater(n,14*288+250)
            self.assertLess(n,90*288+250)
            self.assertGreater(len(attempted),1)
            with self.assertRaises(e.ResearchError):e.load_csv(target,5,True)
            self.assertEqual(len(e.load_csv(target,5,True,min_history_days=14,keep_all=True)),n)

    def test_five_minute_recovery_paginates_without_truncating_archive(self):
        # Generate a 20-day valid archive, then request 2100 new bars (~7.3d).
        # This previously re-bootstrapped and could discard older history.
        step=300_000;now=int(time.time()*1000)//step*step
        latest=now-step-2100*step
        first=latest-(20*288+250-1)*step
        with tempfile.TemporaryDirectory() as d:
            original=Path(d)/'old.csv';dest=Path(d)/'new.csv'
            with original.open('w',encoding='utf8',newline='') as f:
                f.write('timestamp,open,high,low,close,volume\n')
                for t in range(first,latest+1,step):f.write(f'{t},100,101,99,100,15\n')
            calls=[]
            def fake(url,**kw):
                q=parse_qs(urlparse(url).query)
                a=int(q['from'][0])*1000;b=int(q['to'][0])*1000
                calls.append((a,b))
                return [{'t':t//1000,'o':'100','h':'101','l':'99','c':'100','v':'15'} for t in range(a,b+1,step)]
            with patch.object(e,'http_json',side_effect=fake):
                count=e.refresh_gate_futures_candles('BTCUSDT',5,dest,original)
            self.assertGreaterEqual(len(calls),2)
            rows=e.load_csv(dest,5,require_fresh=True,min_history_days=14,keep_all=True)
            self.assertEqual(int(rows[0,0]),first)
            self.assertEqual(count,len(rows))
            self.assertEqual(int(rows[-1,0]),now-step)

    def test_unrelated_gate_400_is_not_masked_by_fallback(self):
        calls=[]
        def bad(url,**kw):
            calls.append(url)
            raise urllib.error.HTTPError(url,400,'Bad Request',{},io.BytesIO(b'{"message":"invalid interval"}'))
        with tempfile.TemporaryDirectory() as d,patch.object(e,'http_json',side_effect=bad):
            with self.assertRaises(urllib.error.HTTPError):
                e.fetch_gate_futures_candles('BTCUSDT',5,Path(d)/'x.csv')
        self.assertEqual(len(calls),1)

if __name__=='__main__':unittest.main()
