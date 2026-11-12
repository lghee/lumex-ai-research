"""LUMEX Cloudflare Container HTTP interface. Never sends exchange orders."""
from __future__ import annotations
import csv, io, json, os, tempfile, hmac, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from engine.lumex_ai_worker import (ResearchError, fetch_bybit_candles, load_csv,
                                     indicators, evaluate, Client, ai_ideas)
SUPPORTED={'BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT'}
FRAMES={5,15,60}
MAX_PAYLOAD=12_500_000
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def send(self, status:int, value, content_type='application/json'):
        if isinstance(value,(dict,list)):body=json.dumps(value,ensure_ascii=False,separators=(',',':')).encode()
        elif isinstance(value,bytes):body=value
        else:body=str(value).encode()
        self.send_response(status)
        self.send_header('content-type',content_type)
        self.send_header('cache-control','no-store')
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
                    fetch_bybit_candles(sym,interval,filename)
                    data=filename.read_bytes()
                    return self.send(200,data,'text/csv')
            if self.path=='/evaluate':
                interval=int(arg.get('interval_min',0));jobs=arg.get('jobs',[]);csv_data=arg.get('csv','')
                if interval not in FRAMES or not isinstance(jobs,list) or len(jobs)>12 or len(csv_data)>MAX_PAYLOAD:raise ResearchError('bad_job_batch')
                with tempfile.TemporaryDirectory() as tmp:
                    filename=Path(tmp)/'candles.csv';filename.write_text(csv_data,encoding='utf-8')
                    data=load_csv(filename,interval,True);common=indicators(data)
                    reports=[]
                    for job in jobs:
                        try:reports.append(evaluate(job,data,common))
                        except (ResearchError,ValueError,KeyError,TypeError) as e:
                            reports.append({'id':job.get('id'), 'job_hash':job.get('job_hash'),'claim_token':job.get('claim_token'),'error':True,'error_code':str(e)[:70],'source':'cloudflare_research_validation'})
                    return self.send(200,{'reports':reports})
            if self.path=='/ai':
                sym=arg.get('symbol');interval=int(arg.get('interval_min',0))
                if sym not in SUPPORTED or interval not in FRAMES:raise ResearchError('bad_market')
                key=os.environ.get('OPENAI_API_KEY','')
                if not key:raise ResearchError('openai_disabled')
                client=Client(os.environ.get('LUMEX_SITE_URL',''),os.environ.get('LUMEX_AI_LAB_WORKER_TOKEN',''))
                return self.send(200,ai_ideas(client,key,sym,interval))
            return self.send(404,{'error':'not_found'})
        except (ResearchError,ValueError,KeyError,TypeError,urllib.error.URLError) as e:
            self.send(422,{'ok':False,'error_code':type(e).__name__,'detail':str(e)[:120]})
        except Exception as e:
            self.send(500,{'ok':False,'error_code':type(e).__name__})
if __name__=='__main__':ThreadingHTTPServer(('0.0.0.0',8080),Handler).serve_forever()
