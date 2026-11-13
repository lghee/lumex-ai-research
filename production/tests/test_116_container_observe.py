"""The paper observation endpoint uses complete candles only and never orders."""
import json,os,sys,threading,time,unittest,urllib.request
from pathlib import Path
from http.server import ThreadingHTTPServer
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from server import Handler

class PaperObserveTests(unittest.TestCase):
    def test_evidence_without_order(self):
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        old=os.environ.get('LUMEX_CONTAINER_KEY')
        os.environ['LUMEX_CONTAINER_KEY']='k'*48
        try:
            step=900000;last=(int(time.time()*1000)//step-1)*step
            rows=['timestamp,open,high,low,close,volume']
            for n in range(90*96+250-1,-1,-1):
                t=last-n*step
                rows.append(f'{t},100,101,99,100,12')
            payload={'csv':'\n'.join(rows)+'\n','interval_min':15,'market_source':'gateio_usdt_perpetual',
             'jobs':[{'id':7,'job_hash':'b'*64,'symbol':'BTCUSDT','spec':{
                 'family':'breakout','lookback':15,'fast':10,'slow':60,'rsi':55,'volume_mult':1.1,
                 'stop_atr':1.5,'take_atr':2,'max_hold':20,'trend_filter':True}}]}
            req=urllib.request.Request(f'http://127.0.0.1:{server.server_port}/observe',
                 data=json.dumps(payload).encode(),headers={'Content-Type':'application/json','X-Lumex-Internal-Key':'k'*48},method='POST')
            with urllib.request.urlopen(req,timeout=10) as response: result=json.load(response)
            self.assertEqual(result['mode'],'paper_observation_only')
            self.assertEqual(result['reports'][0]['direction'],'flat')
            self.assertEqual(result['reports'][0]['candle_open_ms'],last)
            self.assertTrue(result['reports'][0]['paper_only'])
            self.assertNotIn('order',result)
        finally:
            server.shutdown();server.server_close();thread.join(timeout=5)
            if old is None:os.environ.pop('LUMEX_CONTAINER_KEY',None)
            else:os.environ['LUMEX_CONTAINER_KEY']=old

if __name__=='__main__':unittest.main()
