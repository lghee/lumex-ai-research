import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const raw=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
  .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {}');
const {default:handler}=await import('data:text/javascript;base64,'+Buffer.from(raw).toString('base64'));
const market=new Map();const status=new Map();
const interval=15,now=Date.now(),last=Math.floor(now/900000)*900000-900000;
const totalRows=9000;
const csv=['timestamp,open,high,low,close,volume'];
for(let n=totalRows-1;n>=0;n--){const ts=last-n*15*60000;const px=100+(totalRows-n)/10000;csv.push(`${ts},${px},${px+1},${px-1},${px},12`);}
const content=csv.join('\n')+'\n';
status.set('market/BTCUSDT_15.csv',{size:content.length,customMetadata:{schema:'ohlcv_v2',quality:'verified',rows:String(totalRows),lastCandleMs:String(last),source:'gateio_usdt_perpetual'}});
market.set('market/BTCUSDT_15.csv',content);
const R2={
 async head(key){return status.get(key)||null},
 async get(key){return market.has(key)?{json:async()=>JSON.parse(market.get(key)),text:async()=>market.get(key)}:null},
 async put(key,val){market.set(key,String(val))}
};
let mode='wp403',openaiCalls=0,commitCalls=0;
const original=globalThis.fetch;
globalThis.fetch=async (url,init)=>{
  const host=new URL(url).hostname;const path=new URL(url).pathname;
  const respond=(v,status=200)=>new Response(JSON.stringify(v),{status});
  if(host==='api.openai.com'){
    openaiCalls++;
    if(mode==='openai403')return respond({error:{code:'unsupported_country_region_territory',message:'Never reveal this'}},403);
    return respond({status:'completed',usage:{input_tokens:200,output_tokens:100},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({ideas:[{family:'momentum',fast:10,slow:70,lookback:24,rsi:60,max_hold:15,volume_mult:1.4,stop_atr:1.2,take_atr:2.1,trend_filter:true}]})}]}]});
  }
  assert.equal(host,'lumexbot.com');assert.equal(init.headers.authorization,'Bearer '+'w'.repeat(64));
  if(path.endsWith('/context'))return mode==='wp403'?respond({code:'rest_forbidden'},403):respond({ok:true,market:{fresh:mode!=='wp_stale'},technical:{data_quality:mode==='wp_stale'?'missing':'scored'}});
  if(path.endsWith('/reserve'))return respond({ok:true,reservation_id:'a'.repeat(24),model:'gpt-6-luna',max_output_tokens:1200});
  if(path.endsWith('/commit')){commitCalls++;return respond({ok:true})}
  if(path.endsWith('/suggestions'))return respond({ok:true,accepted:1});
  if(path.endsWith('/telemetry'))return respond({ok:true});
  throw Error('Unexpected test endpoint '+path);
};
const env={MARKET_DATA:R2,AUTO_AI:'true',AUTO_FETCH:'false',AUTO_RESEARCH:'false',
  LUMEX_AI_LAB_WORKER_TOKEN:'w'.repeat(64),LUMEX_CONTAINER_KEY:'k'.repeat(64),
  LUMEX_SITE_URL:'https://lumexbot.com',OPENAI_API_KEY:'secret_for_mock_only'};
function msg(){return {body:{kind:'ai',symbol:'BTCUSDT',interval_min:15},ack(){this.acked=true},retry(){throw Error('unexpected queue retry')}}}
const oldlog=console.info;console.info=()=>{};
async function run(){let m=msg();await handler.queue({messages:[m]},env);assert(m.acked);return JSON.parse(market.get('control/research-scheduler-v1.json'))}
let s=await run();assert.equal(s.aiLastExecution.error,'ai_context_wordpress_context_403');assert.equal(openaiCalls,0);assert.equal(commitCalls,0);
assert.equal((await run()).aiLastResult.state,'cooldown');
market.delete('control/research-scheduler-v1.json');mode='openai403';
s=await run();assert.equal(s.aiLastExecution.error,'ai_openai_http_403_unsupported_country_region_territory');assert.equal(openaiCalls,1);assert.equal(commitCalls,1);
market.delete('control/research-scheduler-v1.json');mode='success';
s=await run();assert.equal(s.aiLastExecution.state,'completed');assert.equal(s.aiLastExecution.accepted,1);assert.equal(s.aiLastExecution.transport,undefined);assert.equal(commitCalls,2);
assert.equal((await run()).aiLastResult.state,'cooldown');assert.equal(openaiCalls,2);
market.delete('control/research-scheduler-v1.json');mode='wp_stale';
s=await run();assert.equal(s.aiLastExecution.state,'completed');assert.equal(openaiCalls,3);
market.delete('control/research-scheduler-v1.json');market.delete('market/BTCUSDT_15.csv');
s=await run();assert.equal(s.aiLastExecution.error,'ai_r2_market_missing');assert.equal(openaiCalls,3);
console.info=oldlog;globalThis.fetch=original;
console.log('PASS Worker-native AI: WP 403, OpenAI 403 reason, budget settlement, successful hypothesis, cooldown');
