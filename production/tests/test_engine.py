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

    def test_bybit_and_binance_403_rebuilds_gate_futures_only(self):
        from urllib.parse import parse_qs,urlparse
        from urllib.error import HTTPError
        seen=[]
        def provider(url,**kwargs):
            if url.startswith(m.BASE) or url.startswith(m.BINANCE_FUTURES_BASE):
                raise HTTPError(url,403,'Forbidden',None,None)
            self.assertTrue(url.startswith(m.GATE_FUTURES_BASE))
            q=parse_qs(urlparse(url).query)
            self.assertEqual(q['contract'],['BTC_USDT'])
            self.assertEqual(q['interval'],['1h'])
            self.assertNotIn('limit',q)
            first=int(q['from'][0])*1000
            last=int(q['to'][0])*1000
            self.assertTrue(last-first<2000*self.step)
            seen.append(first)
            return [{'t':ts//1000,'o':'100','h':'101','l':'99','c':'100','v':'42'}
                    for ts in range(first,last+1,self.step)]
        with patch.object(m,'http_json',side_effect=provider):
            count,source=m.refresh_public_perpetual_candles('BTCUSDT',60,self.result,self.previous,'bybit_public_linear')
        self.assertEqual(source,'gateio_usdt_perpetual')
        self.assertGreaterEqual(len(seen),2)
        self.assertTrue(count>=self.needed)
        data=m.load_csv(self.result,60,True)
        self.assertEqual(int(data[-1,0]),self.current)
        self.assertEqual(float(data[0,5]),42.)

    def test_existing_gate_uses_gate_only_for_incremental(self):
        # Gate 1h target expanded from 90d to 180d. Seed a complete cache.
        self.write_candles(self.previous,self.current-(180*24+251)*self.step,180*24+250)
        old=m.load_csv(self.previous,60,False)
        def provider(url,**kwargs):
            from urllib.parse import parse_qs,urlparse
            self.assertTrue(url.startswith(m.GATE_FUTURES_BASE))
            q=parse_qs(urlparse(url).query)
            self.assertEqual(q['contract'],['BTC_USDT'])
            return [{'t':int(old[-1,0])//1000,'o':str(old[-1,1]),'h':str(old[-1,2]),
                     'l':str(old[-1,3]),'c':str(old[-1,4]),'v':str(old[-1,5])},
                    {'t':(self.current-self.step)//1000,'o':'100','h':'101','l':'99','c':'100','v':'14'},
                    {'t':self.current//1000,'o':'100','h':'101','l':'99','c':'100','v':'15'}]
        with patch.object(m,'http_json',side_effect=provider):
            count,source=m.refresh_public_perpetual_candles('BTCUSDT',60,self.result,self.previous,'gateio_usdt_perpetual')
        self.assertEqual(source,'gateio_usdt_perpetual')
        self.assertGreater(count,2000)
        self.assertEqual(int(m.load_csv(self.result,60,True)[-1,0]),self.current)

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
            with self.assertRaisesRegex(m.ResearchError,'bybit_403_binance_403_gate_403_access_restricted'):
                m.refresh_public_perpetual_candles('BTCUSDT',60,self.result,self.previous,'bybit_public_linear')
        self.assertFalse(self.result.exists())
        self.assertTrue(self.previous.exists())

    def test_gate_400_short_probe_success_identifies_history_request(self):
        from urllib.error import HTTPError
        from urllib.parse import parse_qs,urlparse
        import io,json
        def fake(url,**kwargs):
            if url.startswith(m.BASE):raise HTTPError(url,403,'Forbidden',None,None)
            if url.startswith(m.BINANCE_FUTURES_BASE):raise HTTPError(url,451,'Unavailable',None,None)
            q=parse_qs(urlparse(url).query)
            if q.get('limit')==['2']:
                self.assertNotIn('from',q)
                return [{'t':1794500000,'o':'100','h':'101','l':'99','c':'100','v':'5'}]
            raise HTTPError(url,400,'Bad Request',None,io.BytesIO(json.dumps({'label':'INVALID_ARGUMENT','message':'invalid window'}).encode()))
        with patch.object(m,'http_json',side_effect=fake):
            with self.assertRaisesRegex(m.ResearchError,'bybit_403_binance_451_gate_history_400_probe_ok_INVALID_ARGUMENT'):
                m.refresh_public_perpetual_candles('BTCUSDT',60,self.result,None,'')
        self.assertFalse(self.result.exists())

    def test_gate_400_short_probe_rejected_reports_provider_label(self):
        from urllib.error import HTTPError
        from urllib.parse import parse_qs,urlparse
        import io,json
        def fake(url,**kwargs):
            if url.startswith(m.BASE):raise HTTPError(url,403,'Forbidden',None,None)
            if url.startswith(m.BINANCE_FUTURES_BASE):raise HTTPError(url,451,'Unavailable',None,None)
            q=parse_qs(urlparse(url).query)
            label='GEO_BLOCK' if q.get('limit')==['2'] else 'BAD_RANGE'
            raise HTTPError(url,400,'Bad Request',None,io.BytesIO(json.dumps({'label':label}).encode()))
        with patch.object(m,'http_json',side_effect=fake):
            with self.assertRaisesRegex(m.ResearchError,'bybit_403_binance_451_gate_history_400_probe_400_GEO_BLOCK'):
                m.refresh_public_perpetual_candles('BTCUSDT',60,self.result,None,'')
        self.assertFalse(self.result.exists())

    def test_zero_flat_candle_blocked_by_loader(self):
        p=self.dir/'flat.csv'
        self.write_candles(p,self.base,self.needed)
        with p.open() as f:rows=list(csv.reader(f))
        rows[1999]=[rows[1999][0],'100','100','100','100','0']
        with p.open('w',newline='') as f:csv.writer(f).writerows(rows)
        with self.assertRaisesRegex(m.ResearchError,'unverified_zero_flat_candle'):
            m.load_csv(p,60,False)

    def test_gate_page_boundary_placeholder_recovered(self):
        from urllib.parse import parse_qs,urlparse
        expected=self.current
        calls=[]
        def provider(url,**kwargs):
            self.assertTrue(url.startswith(m.GATE_FUTURES_BASE))
            query=parse_qs(urlparse(url).query)
            start=int(query['from'][0])*1000
            end=int(query['to'][0])*1000
            calls.append((start,end))
            rows=[]
            for ts in range(start,min(end,expected)+1,self.step):
                # Deliberately fake the final candle of each historical page.
                if ts==end and end<=expected:
                    rows.append({'t':ts//1000,'o':'100','h':'100','l':'100','c':'100','v':'0'})
                else:
                    rows.append({'t':ts//1000,'o':'100','h':'102','l':'99','c':'101','v':'88'})
            return rows
        with patch.object(m,'http_json',side_effect=provider):
            count=m.fetch_gate_futures_candles('BTCUSDT',60,self.result)
        values=m.load_csv(self.result,60,True)
        self.assertGreaterEqual(len(calls),3)
        self.assertGreaterEqual(count,len(values))
        self.assertEqual(int(values[-1,0]),expected)
        self.assertFalse(any(m.suspect_candle(x) for x in values))
        self.assertTrue(all(x[5]==88 for x in values))

    def test_gate_unverified_zero_cannot_publish(self):
        from urllib.parse import parse_qs,urlparse
        target=self.current-2*self.step
        def provider(url,**kwargs):
            query=parse_qs(urlparse(url).query)
            start=int(query['from'][0])*1000;end=int(query['to'][0])*1000
            rows=[]
            for ts in range(start,min(end,self.current)+1,self.step):
                if ts==target:rows.append({'t':ts//1000,'o':'100','h':'100','l':'100','c':'100','v':'0'})
                else:rows.append({'t':ts//1000,'o':'100','h':'102','l':'99','c':'101','v':'88'})
            return rows
        with patch.object(m,'http_json',side_effect=provider):
            with self.assertRaisesRegex(m.ResearchError,'gate_unverified_bar'):
                m.fetch_gate_futures_candles('BTCUSDT',60,self.result)
        self.assertFalse(self.result.exists())

    def test_gate_missing_bar_requeried_not_fabricated(self):
        from urllib.parse import parse_qs,urlparse
        target=self.current-1000*self.step
        calls=[]
        def provider(url,**kwargs):
            query=parse_qs(urlparse(url).query)
            start=int(query['from'][0])*1000;end=int(query['to'][0])*1000
            calls.append((start,end))
            rows=[]
            for ts in range(start,min(end,self.current)+1,self.step):
                if ts==target and end-start>=500*self.step:
                    continue
                rows.append({'t':ts//1000,'o':'100','h':'102','l':'99','c':'101','v':'88'})
            return rows
        with patch.object(m,'http_json',side_effect=provider):
            m.fetch_gate_futures_candles('BTCUSDT',60,self.result)
        self.assertGreaterEqual(len(calls),3)
        values=m.load_csv(self.result,60,True)
        self.assertIn(target,values[:,0])

    def test_previous_file_with_placeholder_forces_gate_rebuild(self):
        # Old v1 file should trigger full source-consistent re-download.
        with self.previous.open() as f:rows=list(csv.reader(f))
        rows[1999]=[rows[1999][0],'100','100','100','100','0']
        with self.previous.open('w',newline='') as f:csv.writer(f).writerows(rows)
        with patch.object(m,'fetch_gate_futures_candles',return_value=2400) as full:
            count=m.refresh_gate_futures_candles('BTCUSDT',60,self.result,self.previous)
        self.assertEqual(count,2400)
        full.assert_called_once()

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
