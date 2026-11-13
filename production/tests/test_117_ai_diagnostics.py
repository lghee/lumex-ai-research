"""Regression tests for distinguishing AI upstream 403s without exposing secrets."""
import json, sys, unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import lumex_ai_worker as m

class FakeClient:
    def __init__(self, block=None):
        self.block=block
        self.calls=[]
    def get(self,name,**kwargs):
        self.calls.append(name)
        if self.block==name:raise HTTPError('https://lumexbot.com/wp-json/lumex/v1/research-lab/'+name,403,'Forbidden',None,None)
        return {'market':{'fresh':True},'technical':{'data_quality':'scored'},'research_history':[]}
    def post(self,name,body):
        self.calls.append(name)
        if self.block==name:raise HTTPError('https://lumexbot.com/wp-json/lumex/v1/research-lab/'+name,403,'Forbidden',None,None)
        if name=='reserve':return {'ok':True,'reservation_id':'r'*24,'model':'gpt-6-luna','max_output_tokens':1200}
        if name=='suggestions':return {'ok':True,'accepted':2}
        if name=='commit':return {'ok':True}
        raise AssertionError('unexpected post')

class TestAIDiagnostics(unittest.TestCase):
    def test_context_403(self):
        res=m.ai_ideas(FakeClient('context'),'secret','BTCUSDT',15)
        self.assertEqual((res['error'],res['stage'],res['http_status']),('wordpress_context_http_403','wordpress_context',403))
    def test_reservation_403(self):
        res=m.ai_ideas(FakeClient('reserve'),'secret','BTCUSDT',15)
        self.assertEqual((res['error'],res['stage']),('wordpress_ai_reservation_http_403','wordpress_ai_reservation'))
    def test_openai_403(self):
        c=FakeClient()
        with patch.object(m,'http_json',side_effect=HTTPError('https://api.openai.com/v1/responses',403,'Forbidden',None,None)):
            res=m.ai_ideas(c,'secret','BTCUSDT',15)
        self.assertEqual((res['error'],res['stage']),('openai_http_403','openai'))
        self.assertIn('commit',c.calls)
    def test_suggestions_403(self):
        c=FakeClient('suggestions')
        response={'status':'completed','usage':{'input_tokens':100,'output_tokens':50},'output':[{'type':'message','content':[{'type':'output_text','text':json.dumps({'ideas':[]})}]}]}
        with patch.object(m,'http_json',return_value=response):
            res=m.ai_ideas(c,'secret','BTCUSDT',15)
        self.assertEqual((res['error'],res['stage']),('wordpress_suggestions_http_403','wordpress_suggestions'))
        self.assertIn('commit',c.calls)

    def test_safe_wordpress_error_code_without_message(self):
        import io
        e=HTTPError('https://lumexbot.com/wp-json/lumex/v1/research-lab/reserve',403,'Forbidden',None,
                    io.BytesIO(json.dumps({'code':'lumex_ai_lab_ai_disabled','message':'sensitive detail'}).encode()))
        res=m.safe_http_failure('wordpress_ai_reservation',e)
        self.assertEqual(res['error'],'wordpress_ai_reservation_http_403_lumex_ai_lab_ai_disabled')
        self.assertNotIn('sensitive',' '.join(str(x) for x in res.values()))
    def test_safe_openai_error_code_without_message(self):
        import io
        e=HTTPError('https://api.openai.com/v1/responses',403,'Forbidden',None,
                    io.BytesIO(json.dumps({'error':{'code':'unsupported_country_region_territory','message':'secret-looking data'}}).encode()))
        res=m.safe_http_failure('openai',e)
        self.assertEqual(res['error'],'openai_http_403_unsupported_country_region_territory')
        self.assertNotIn('secret-looking',' '.join(str(x) for x in res.values()))
if __name__=='__main__':unittest.main()
