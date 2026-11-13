"""LUMEX Cloudflare Container HTTP interface. Never sends exchange orders."""
from __future__ import annotations
import csv, io, json, os, tempfile, hmac, urllib.error, urllib.parse, hashlib, math
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from engine.lumex_ai_worker import (ResearchError, fetch_bybit_candles, load_csv, refresh_public_perpetual_candles, MARKET_SOURCES,
                                     indicators, evaluate, vector_signals, Client, ai_ideas, refresh_bybit_candles)
SUPPORTED={'BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT'}
FRAMES={5,15,60}
MAX_PAYLOAD=12_500_000
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def send(self, status:int, value, content_type='application/json', extra_headers=None):
        if isinstance(value,(dict,list)):body=json.dumps(value,ensure_ascii=False,separators=(',',':')).encode()
        elif isinstance(value,bytes):body=value
        else:body=str(value).encode()
        self.send_response(status)
        self.send_header('content-type',content_type)
        self.send_header('cache-control','no-store')
        for name,value in (extra_headers or {}).items():self.send_header(name,value)
        self.send_header('content-length',str(len(body)))
        self.end_headers();self.wfile.write(body)
    def do_GET(self):
        if self.path=='/health':self.send(200,{'ok':True,'service':'lumex-container','orders':False})
        else:self.send(404,{'error':'not_found'})
    def do_POST(self):
        secret=os.environ.get('LUMEX_CONTAINER_KEY','')
        provided=self.headers.get('X-Lumex-Internal-Key','')
        if len(secret)<32 or not hmac.compare_digest(provided,secret):return self.send(401,{'error':'unauthorized'})
        try:
            size=int(self.headers.get('content-length','0'))
            if size<2 or size>MAX_PAYLOAD:return self.send(413,{'error':'payload_size_invalid'})
            arg=json.loads(self.rfile.read(size))
            if self.path=='/fetch':
                sym=arg.get('symbol');interval=int(arg.get('interval_min',0))
                if sym not in SUPPORTED or interval not in FRAMES:raise ResearchError('bad_market')
                with tempfile.TemporaryDirectory() as tmp:
                    filename=Path(tmp)/'candles.csv'
                    existing=arg.get('existing_csv','')
                    if not isinstance(existing,str) or len(existing)>12_000_000:raise ResearchError('bad_previous_csv')
                    previous=Path(tmp)/'previous.csv'
                    if existing:previous.write_text(existing,encoding='utf-8')
                    prior_source=str(arg.get('existing_source',''))
                    if prior_source not in ('', *MARKET_SOURCES):raise ResearchError('bad_previous_source')
                    _,source=refresh_public_perpetual_candles(sym,interval,filename,previous if existing else None,prior_source)
                    data=filename.read_bytes()
                    return self.send(200,data,'text/csv',{'X-Lumex-Market-Source':source})
            if self.path=='/evaluate':
                interval=int(arg.get('interval_min',0));jobs=arg.get('jobs',[]);csv_data=arg.get('csv','')
                if interval not in FRAMES or not isinstance(jobs,list) or len(jobs)>24 or len(csv_data)>MAX_PAYLOAD:raise ResearchError('bad_job_batch')
                source=arg.get('market_source','')
                if source not in MARKET_SOURCES:raise ResearchError('unverified_market_source')
                with tempfile.TemporaryDirectory() as tmp:
                    filename=Path(tmp)/'candles.csv';filename.write_text(csv_data,encoding='utf-8')
                    data=load_csv(filename,interval,True);common=indicators(data)
                    reports=[]
                    for job in jobs:
                        try:
                            report=evaluate(job,data,common)
                            report['source']=source+'_ohlcv_csv_90d'
                            reports.append(report)
                        except (ResearchError,ValueError,KeyError,TypeError) as e:
                            reports.append({'id':job.get('id'), 'job_hash':job.get('job_hash'),'claim_token':job.get('claim_token'),'error':True,'error_code':str(e)[:70],'source':'cloudflare_research_validation'})
                    return self.send(200,{'reports':reports})
            if self.path=='/observe':
                interval=int(arg.get('interval_min',0));jobs=arg.get('jobs',[]);csv_data=arg.get('csv','')
                source=arg.get('market_source','')
                if interval not in (15,60) or source not in MARKET_SOURCES or not isinstance(jobs,list) or len(jobs)>8 or not isinstance(csv_data,str) or len(csv_data)>MAX_PAYLOAD:
                    raise ResearchError('bad_forward_request')
                with tempfile.TemporaryDirectory() as tmp:
                    path=Path(tmp)/'candles.csv';path.write_text(csv_data,encoding='utf-8')
                    data=load_csv(path,interval,True)
                    commons=indicators(data)
                    last=int(data[-1,0]);close=float(data[-1,4]);digest=hashlib.sha256(data.tobytes()).hexdigest()
                    reports=[]
                    for job in jobs:
                        try:
                            spec=job['spec']
                            if (not isinstance(spec,dict) or spec.get('family') not in ('breakout','pullback','mean_revert','momentum') or
                                not 5<=int(spec['fast'])<=40 or not 25<=int(spec['slow'])<=240 or int(spec['fast'])>=int(spec['slow']) or
                                not 8<=int(spec['lookback'])<=80):
                                raise ResearchError('invalid_forward_spec')
                            d=int(vector_signals(data,spec,commons)[-1])
                            reports.append({'id':job['id'],'job_hash':job['job_hash'],'symbol':job['symbol'],
                                'interval_min':interval,'candle_open_ms':last,'direction':'long' if d>0 else ('short' if d<0 else 'flat'),
                                'close_price':close,'data_sha256':digest,'source':source,'paper_only':True})
                        except (ResearchError,KeyError,TypeError,ValueError,OverflowError):
                            reports.append({'id':job.get('id'),'job_hash':job.get('job_hash'),'error':True,'error_code':'invalid_forward_spec'})
                    return self.send(200,{'reports':reports,'mode':'paper_observation_only'})
            if self.path=='/ai':
                sym=arg.get('symbol');interval=int(arg.get('interval_min',0))
                if sym not in SUPPORTED or interval not in FRAMES:raise ResearchError('bad_market')
                key=os.environ.get('OPENAI_API_KEY','')
                if not key:raise ResearchError('openai_disabled')
                client=Client(os.environ.get('LUMEX_SITE_URL',''),os.environ.get('LUMEX_AI_LAB_WORKER_TOKEN',''))
                return self.send(200,ai_ideas(client,key,sym,interval))
            return self.send(404,{'error':'not_found'})
        except urllib.error.HTTPError as e:
            # Unexpected upstream HTTP error: identify only the upstream host, never
            # log the request URL, Authorization headers, prompt, or response body.
            host=urllib.parse.urlparse(getattr(e,'url','')).hostname or ''
            upstream='wordpress' if host=='lumexbot.com' else ('openai' if host=='api.openai.com' else 'other')
            self.send(422,{'ok':False,'error_code':'upstream_http_error',
                'detail':f'{upstream}_unhandled_http_{int(e.code)}'})
        except (ResearchError,ValueError,KeyError,TypeError,urllib.error.URLError) as e:
            self.send(422,{'ok':False,'error_code':type(e).__name__,'detail':str(e)[:120]})
        except Exception as e:
            self.send(500,{'ok':False,'error_code':type(e).__name__})
if __name__=='__main__':ThreadingHTTPServer(('0.0.0.0',8080),Handler).serve_forever()
