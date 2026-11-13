import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const raw=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
  .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {}');
const {default:handler}=await import('data:text/javascript;base64,'+Buffer.from(raw).toString('base64'));
const now=Date.now();const latest15=Math.floor(now/(15*60000))*15*60000-15*60000;
const records=new Map();
const env={AUTO_AI:'true',AUTO_FETCH:'false',AUTO_RESEARCH:'false',LUMEX_CONTAINER_KEY:'x'.repeat(48),OPENAI_API_KEY:'fake-key-for-tests',MARKET_DATA:{
  async head(key){const v=records.get(key);return v?.metadata?{customMetadata:v.metadata,size:v.bytes.length}:null},
  async get(key){const v=records.get(key);return v?{json:async()=>JSON.parse(v.bytes),text:async()=>v.bytes}:null},
  async put(key,value,opt){records.set(key,{bytes:String(value),metadata:opt?.customMetadata??null})}
}};
records.set('market/BTCUSDT_15.csv',{bytes:'x'.repeat(35000),metadata:{schema:'ohlcv_v2',quality:'verified',rows:String(9000),lastCandleMs:String(latest15),source:'gateio_usdt_perpetual'}});
let aiCalls=0;
env.RESEARCH_CONTAINER={getByName:()=>({fetch:async()=>{aiCalls++;return new Response(JSON.stringify({ok:false,error:'wordpress_context_http_403'}),{status:200})}})};
const origConsole=console.info;console.info=()=>{};
function mkMsg(){return {body:{kind:'orchestrate'},ack(){this.acked=true},retry(){throw Error('unexpected retry')}}}
const first=mkMsg();await handler.queue({messages:[first]},env);assert(first.acked);
const state1=JSON.parse(records.get('control/research-scheduler-v1.json').bytes);
assert.equal(state1.aiLastOk,false);
assert.equal(state1.aiLastResult.error,'wordpress_context_http_403');
assert.equal(state1.aiLastExecution.error,'wordpress_context_http_403');
const second=mkMsg();await handler.queue({messages:[second]},env);assert(second.acked);
const state2=JSON.parse(records.get('control/research-scheduler-v1.json').bytes);
assert.equal(state2.aiLastResult.state,'cooldown');
assert.equal(state2.aiLastResult.error,'wordpress_context_http_403');
assert.equal(state2.aiLastResult.lastAttempt.error,'wordpress_context_http_403');
assert.equal(aiCalls,1);
// A zero-candidate upstream response is not an AI generation success and must
// not apply the 6-hour success cooldown.
records.delete('control/research-scheduler-v1.json');
env.RESEARCH_CONTAINER={getByName:()=>({fetch:async()=>new Response(JSON.stringify({ok:true,accepted:0}),{status:200})})};
const third=mkMsg();await handler.queue({messages:[third]},env);assert(third.acked);
const state3=JSON.parse(records.get('control/research-scheduler-v1.json').bytes);
assert.equal(state3.aiLastOk,false);
assert.equal(state3.aiLastResult.error,'ai_zero_candidates_accepted');
console.info=origConsole;
console.log('PASS 1.1.7 AI failed-upstream status preserved across cooldown, one bounded attempt');
