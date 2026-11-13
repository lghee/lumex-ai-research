"""Offline, deterministic tests: no exchange, WordPress, or OpenAI requests."""
import csv, os, sys, tempfile, time, unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import lumex_ai_worker as m

class ResearchEngineTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.dir=Path(self.temp.name)
        self.interval=60;self.step=60*60000
        self.current=(int(time.time()*1000)//self.step-1)*self.step
        self.needed=90*24+250
        self.base=self.current-(self.needed+1)*self.step
        self.previous=self.dir/'previous.csv';self.result=self.dir/'result.csv'
        self.write_candles(self.previous,self.base,self.needed)
    @staticmethod
    def write_candles(path,start,n,step=60*60000):
        with path.open('w',newline='',encoding='utf-8') as f:
            w=csv.writer(f);w.writerow(['timestamp','open','high','low','close','volume'])
            for i in range(n):
                price=100+np.sin(i/13)*2+i*.002
                w.writerow([start+i*step,price,price+1,price-1,price+.1,10+i%30])
    def test_incremental_updates_only_missing_closed_candles(self):
        old=m.load_csv(self.previous,60,require_fresh=False)
        self.assertEqual(old.shape[0],self.needed)
        self.assertEqual(int(old[-1,0]),self.current-2*self.step)
        def mocked_http(url,**kwargs):
            from urllib.parse import parse_qs,urlparse
            q=parse_qs(urlparse(url).query)
            self.assertEqual(q['limit'],['8'])
            return {'retCode':0,'result':{'list':[
                [str(self.current), '101','102','100','101.2','12'],
                [str(self.current-self.step),'100','101','99','100.2','11'],
                # Provider's overlap row must exactly match the old closed candle.
                [str(int(old[-1,0])),*map(str,old[-1,1:])]
            ]}}
        with patch.object(m,'http_json',side_effect=mocked_http):
            count=m.refresh_bybit_candles('BTCUSDT',60,self.result,self.previous)
        self.assertEqual(count,self.needed)
        updated=m.load_csv(self.result,60,True)
        self.assertEqual(int(updated[-1,0]),self.current)
    def test_provider_gap_rejects_without_overwriting(self):
        old=m.load_csv(self.previous,60,False)
        def gap(url,**kwargs):
            return {'retCode':0,'result':{'list':[
                [str(self.current),'101','102','100','101.2','12'],
                [str(int(old[-1,0])),*map(str,old[-1,1:])]
            ]}}
        with patch.object(m,'http_json',side_effect=gap):
            with self.assertRaisesRegex(m.ResearchError,'incremental_provider_gap'):
                m.refresh_bybit_candles('BTCUSDT',60,self.result,self.previous)
        self.assertFalse(self.result.exists())
    def test_bybit_403_rebuilds_full_binance_futures_history(self):
        from urllib.parse import parse_qs,urlparse
        from urllib.error import HTTPError
        calls=[]
        latest=self.current
        start=latest-(92*24+250)*self.step
        def provider(url,**kwargs):
            if url.startswith(m.BASE):raise HTTPError(url,403,'Forbidden',None,None)
            self.assertTrue(url.startswith(m.BINANCE_FUTURES_BASE))
            q=parse_qs(urlparse(url).query)
            self.assertEqual(q['interval'],['1h'])
            self.assertEqual(q['symbol'],['BTCUSDT'])
            self.assertEqual(q['limit'],['1500'])
            first=int(q['startTime'][0]);calls.append(first)
            rows=[]
            for ts in range(first,min(first+1500*self.step,latest+self.step),self.step):
                rows.append([ts,'100','101','99','100','12',ts+self.step-1,'','','','',''])
            return rows
        with patch.object(m,'http_json',side_effect=provider):
            count,source=m.refresh_public_perpetual_candles('BTCUSDT',60,self.result,self.previous,'bybit_public_linear')
        self.assertEqual(source,'binance_usdm_perpetual')
        self.assertTrue(len(calls)>=2)
        self.assertTrue(count>=self.needed)
        validated=m.load_csv(self.result,60,True)
        self.assertEqual(int(validated[-1,0]),latest)
        self.assertEqual(float(validated[0,1]),100.)  # old Bybit history was discarded

    def test_existing_binance_never_mixes_bybit_when_updating(self):
        old=m.load_csv(self.previous,60,False)
        endpoints=[]
        def provider(url,**kwargs):
            from urllib.parse import parse_qs,urlparse
            endpoints.append(url)
            self.assertTrue(url.startswith(m.BINANCE_FUTURES_BASE))
            q=parse_qs(urlparse(url).query)
            return [[int(old[-1,0]),*map(str,old[-1,1:])]+[0]*6,
                    [self.current-self.step,'100','101','99','100','10',0,0,0,0,0,0],
                    [self.current,'100','101','99','100','10',0,0,0,0,0,0]]
        with patch.object(m,'http_json',side_effect=provider):
            count,source=m.refresh_public_perpetual_candles('BTCUSDT',60,self.result,self.previous,'binance_usdm_perpetual')
        self.assertEqual(source,'binance_usdm_perpetual')
        self.assertGreater(count,2000)
        self.assertTrue(endpoints)

    def test_alternate_provider_403_preserves_existing_file(self):
        from urllib.error import HTTPError
        def blocked(url,**kwargs):raise HTTPError(url,403,'Forbidden',None,None)
        with patch.object(m,'http_json',side_effect=blocked):
            with self.assertRaisesRegex(m.ResearchError,'bybit_403_binance_403_access_restricted'):
                m.refresh_public_perpetual_candles('BTCUSDT',60,self.result,self.previous,'bybit_public_linear')
        self.assertFalse(self.result.exists())
        self.assertTrue(self.previous.exists())

    def test_ai_feedback_is_structured_and_billed_once(self):
        history=[{'spec':{'family':'momentum','lookback':12},'gate':'failed_gate','oos':{'profit_factor':0.8}}]
        class StubClient:
            commits=[];suggestions=[]
            def get(self,name,**kwargs):
                self_name=name
                assert self_name=='context'
                return {'market':{'fresh':True},'technical':{'data_quality':'scored'},'research_history':history}
            def post(self,name,body):
                if name=='reserve':return {'ok':True,'reservation_id':'f'*24,'model':'gpt-6-luna','max_output_tokens':1200,'max_input_tokens':6000}
                if name=='suggestions':self.suggestions.append(body);return {'ok':True,'accepted':1,'requested':1}
                if name=='commit':self.commits.append(body);return {'ok':True}
                raise AssertionError(name)
        client=StubClient()
        spec={'family':'breakout','lookback':20,'fast':10,'slow':55,'rsi':55,'volume_mult':1.1,'stop_atr':1.5,'take_atr':3.0,'max_hold':12,'trend_filter':False}
        def fake_api(url,method,data,key,timeout):
            self.assertEqual(url,'https://api.openai.com/v1/responses')
            self.assertEqual(data['text']['format']['type'],'json_schema')
            self.assertIn('research_history',data['input'])
            self.assertEqual(data['reasoning']['effort'],'none')
            return {'status':'completed','usage':{'input_tokens':500,'output_tokens':350},'output':[{'type':'message','content':[{'type':'output_text','text':__import__('json').dumps({'ideas':[spec]})}]}]}
        with patch.object(m,'http_json',side_effect=fake_api):
            answer=m.ai_ideas(client,'dummy_not_live_key','BTCUSDT',15)
        self.assertEqual(answer['accepted'],1)
        self.assertEqual(len(client.suggestions),1)
        self.assertEqual(len(client.commits),1)
        self.assertTrue(client.commits[0]['usage_confirmed'])
    def test_bounded_real_backtest_evaluation(self):
        # Use a final fresh candle, full 90-day+warm-up synthetic OHLCV sequence.
        self.write_candles(self.previous,self.current-(self.needed-1)*self.step,self.needed)
        data=m.load_csv(self.previous,60,True)
        spec={'family':'breakout','lookback':20,'fast':10,'slow':50,'rsi':52,'volume_mult':.8,
              'stop_atr':1.5,'take_atr':3.0,'max_hold':12,'trend_filter':False}
        job={'id':1,'job_hash':'c'*64,'claim_token':'a'*24,'spec':spec,'interval_min':60}
        report=m.evaluate(job,data,m.indicators(data))
        self.assertEqual(report['oos_days'],30)
        self.assertIn('double_cost',report);self.assertIn('one_bar_delay',report)
        self.assertEqual(len(report['data_sha256']),64)
        self.assertFalse(report.get('error',False))
        for name in ('train','oos','double_cost','one_bar_delay'):
            metrics=report[name]
            for k in ('trades','net_return_pct','mdd_pct','profit_factor','win_rate_pct'):
                self.assertTrue(np.isfinite(metrics[k]))

if __name__=='__main__': unittest.main(verbosity=2)
