import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const raw=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
  .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {}');
const {default:handler}=await import('data:text/javascript;base64,'+Buffer.from(raw).toString('base64'));
const now=Date.now();const latest15=Math.floor(now/(15*60000))*15*60000-15*60000;
const records=new Map();
const env={AUTO_AI:'true',AUTO_FETCH:'false',AUTO_RESEARCH:'false',LUMEX_CONTAINER_KEY:'x'.repeat(48),LUMEX_AI_LAB_WORKER_TOKEN:'w'.repeat(64),LUMEX_SITE_URL:'https://lumexbot.com',OPENAI_API_KEY:'fake-key-for-tests',MARKET_DATA:{
  async head(key){const v=records.get(key);return v?.metadata?{customMetadata:v.metadata,size:v.bytes.length}:null},
  async get(key){const v=records.get(key);return v?{json:async()=>JSON.parse(v.bytes),text:async()=>v.bytes}:null},
  async put(key,value,opt){records.set(key,{bytes:String(value),metadata:opt?.customMetadata??null})}
}};
records.set('market/BTCUSDT_15.csv',{bytes:'x'.repeat(35000),metadata:{schema:'ohlcv_v2',quality:'verified',rows:String(9000),lastCandleMs:String(latest15),source:'gateio_usdt_perpetual'}});
let aiCalls=0;
const savedFetch=globalThis.fetch;
let errorMode='context403';
const response=(v,status=200)=>new Response(JSON.stringify(v),{status});
globalThis.fetch=async (url,opts)=>{
  const u=new URL(url);
  if(u.hostname==='api.openai.com'){
    aiCalls++;
    return response({status:'completed',usage:{input_tokens:200,output_tokens:100},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({ideas:[{family:'breakout',fast:10,slow:50,lookback:25,rsi:50,max_hold:12,volume_mult:1.2,stop_atr:1.5,take_atr:2.5,trend_filter:true}]})}]}]});
  }
  const path=u.pathname;
  if(path.endsWith('/context'))return errorMode==='context403'?response({code:'rest_forbidden'},403):response({ok:true,market:{fresh:true},technical:{data_quality:'scored'}});
  if(path.endsWith('/reserve'))return response({ok:true,reservation_id:'a'.repeat(24),model:'gpt-6-luna',max_output_tokens:1200});
  if(path.endsWith('/suggestions'))return response({ok:true,accepted:0});
  if(path.endsWith('/commit'))return response({ok:true});
  if(path.endsWith('/telemetry'))return response({ok:true});
  throw Error('unexpected_mock_path_'+path);
};
const origConsole=console.info;console.info=()=>{};
function mkMsg(){return {body:{kind:'orchestrate'},ack(){this.acked=true},retry(){throw Error('unexpected retry')}}}
const first=mkMsg();await handler.queue({messages:[first]},env);assert(first.acked);
const state1=JSON.parse(records.get('control/research-scheduler-v1.json').bytes);
assert.equal(state1.aiLastOk,false);
assert.equal(state1.aiLastResult.error,'ai_context_wordpress_context_403');
assert.equal(state1.aiLastExecution.error,'ai_context_wordpress_context_403');
const second=mkMsg();await handler.queue({messages:[second]},env);assert(second.acked);
const state2=JSON.parse(records.get('control/research-scheduler-v1.json').bytes);
assert.equal(state2.aiLastResult.state,'cooldown');
assert.equal(state2.aiLastResult.error,'ai_context_wordpress_context_403');
assert.equal(state2.aiLastResult.lastAttempt.error,'ai_context_wordpress_context_403');
assert.equal(aiCalls,0);
// A zero-candidate upstream response is not an AI generation success and must
// not apply the 6-hour success cooldown.
records.delete('control/research-scheduler-v1.json');
errorMode='zero';
const third=mkMsg();await handler.queue({messages:[third]},env);assert(third.acked);
const state3=JSON.parse(records.get('control/research-scheduler-v1.json').bytes);
assert.equal(state3.aiLastOk,false);
assert.equal(state3.aiLastResult.error,'ai_zero_candidates_accepted');
assert.equal(aiCalls,1);
globalThis.fetch=savedFetch;
console.info=origConsole;
console.log('PASS 1.1.7 AI failed-upstream status preserved across cooldown, one bounded attempt');
