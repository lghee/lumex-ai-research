import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const file=new URL('../src/index.js',import.meta.url);
const source=(await readFile(file,'utf8')).replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }');
const mod=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const handler=mod.default;
const now=Date.now();const step=5*60000;
const latest=Math.floor(now/step)*step-step;
const csvLines=['timestamp,open,high,low,close,volume'];
for(let i=Math.ceil(90*1440/5)+250-1;i>=0;i--){const n=latest-i*step;csvLines.push(`${n},100,101,99,100,12`);}
const validCsv=csvLines.join('\n')+'\n';assert(validCsv.length>20000);
class Store {
  records=new Map();
  async head(key){const r=this.records.get(key);return r?{size:r.bytes.byteLength,customMetadata:r.meta}:null;}
  async get(key){const r=this.records.get(key);return r?{size:r.bytes.byteLength,customMetadata:r.meta,text:async()=>new TextDecoder().decode(r.bytes),json:async()=>JSON.parse(new TextDecoder().decode(r.bytes))}:null;}
  async put(key,value,options={}){const bytes=value instanceof ArrayBuffer?new Uint8Array(value):typeof value==='string'?new TextEncoder().encode(value):new Uint8Array(value);this.records.set(key,{bytes,meta:options.customMetadata||{}});}
}
let failEvaluate=false;let claimed=false;let released=[];let results=[];let eventHistory=[];let queued=[];let aiCalls=0;let wpJobs=true;
const response=(v,code=200)=>new Response(JSON.stringify(v),{status:code,headers:{'content-type':'application/json'}});
const savedFetch=globalThis.fetch;
globalThis.fetch=async (url,opts)=>{
  const u=new URL(url);assert.equal(u.hostname,'lumexbot.com');
  assert.equal(opts.headers.authorization,'Bearer '+'w'.repeat(64));
  eventHistory.push(u.pathname);
  if(u.pathname.endsWith('/forward/jobs'))return response({ok:true,jobs:[]});
  if(u.pathname.endsWith('/tick'))return response({ok:true,state:'queued',enqueued:100,cursor:100});
  if(u.pathname.endsWith('/jobs')){
    assert(u.searchParams.get('markets')?.includes('BTCUSDT:5'),'ready-market filter must be supplied');
    if(wpJobs && !claimed){claimed=true;return response({ok:true,jobs:[{id:42,symbol:'BTCUSDT',interval_min:5,claim_token:'a'.repeat(24),job_hash:'b'.repeat(64),spec:{family:'breakout'}}]});}
    return response({ok:true,jobs:[]});
  }
  if(u.pathname.endsWith('/results')){results.push(JSON.parse(opts.body));return response({ok:true,state:'completed'});}
  if(u.pathname.endsWith('/release')){released.push(JSON.parse(opts.body));return response({ok:true,state:'pending'});}
  if(u.pathname.endsWith('/telemetry'))return response({ok:true});
  if(u.pathname.endsWith('/status'))return response({settings:{enabled:true},count_total:2,today:{completed:1}});
  throw Error('unexpected_url:'+url);
};
const R2=new Store();const queue={send:async x=>{queued.push(x);}};
const metrics={trades:35,net_return_pct:1,mdd_pct:3,profit_factor:1.25,win_rate_pct:55};
const env={MARKET_DATA:R2,RESEARCH_QUEUE:queue,LUMEX_ADMIN_API_TOKEN:'a'.repeat(40),LUMEX_AI_LAB_WORKER_TOKEN:'w'.repeat(64),LUMEX_CONTAINER_KEY:'k'.repeat(40),OPENAI_API_KEY:'key-not-real',LUMEX_SITE_URL:'https://lumexbot.com',AUTO_FETCH:'false',AUTO_RESEARCH:'false',AUTO_AI:'false',RESEARCH_BATCHES_PER_TICK:'1'};
let fetchRequests=[];
env.RESEARCH_CONTAINER={getByName:(name)=>{
  assert.equal(name,'primary-research');
  return {fetch:async(url,opts)=>{
    const path=new URL(url).pathname;const body=JSON.parse(opts.body);
    if(path==='/fetch'){fetchRequests.push(body);return new Response(validCsv,{headers:{'content-type':'text/csv','x-lumex-market-source':'binance_usdm_perpetual'}});}
    if(path==='/evaluate'){assert.equal(body.market_source,'binance_usdm_perpetual');
      if(failEvaluate)return response({reports:body.jobs.map(job=>({...job,error:true,error_code:'bad_test_market'}))});
      return response({reports:body.jobs.map(job=>({id:job.id,job_hash:job.job_hash,claim_token:job.claim_token,train:metrics,oos:metrics,double_cost:metrics,one_bar_delay:metrics,oos_days:30,data_sha256:'c'.repeat(64),last_candle_unix:Math.floor(latest/1000)}))});
    }
    if(path==='/ai'){aiCalls++;return response({ok:true,accepted:3});}
    throw Error('unexpected_container_path:'+path);
  }};
}};
function message(kind){return {body:{kind},attempts:1,ack(){this.acked=true;},retry(){throw Error('unexpected_retry');}};}
async function schedule(){let pending;await handler.scheduled({},env,{waitUntil(p){pending=p;}});if(pending)await pending;}
async function consume(kind){const msg=message(kind);await handler.queue({messages:[msg]},env);assert.equal(msg.acked,true);}
assert.equal((await handler.fetch(new Request('https://worker/health'),env)).status,200);
assert.equal((await handler.fetch(new Request('https://worker/status'),env)).status,401);
assert.equal((await handler.fetch(new Request('https://worker/order'),env)).status,401);
await schedule();assert.equal(queued.length,0,'disabled Cron must not enqueue');
env.AUTO_FETCH='true';await schedule();assert.equal(queued.length,1);assert.equal(queued.shift().kind,'orchestrate');
await consume('orchestrate');
assert.equal(fetchRequests.length,1,'Cold start must be bounded');
assert(await R2.head('market/BTCUSDT_5.csv'));assert.equal((await R2.head('market/BTCUSDT_5.csv')).customMetadata.source,'binance_usdm_perpetual');
assert.equal((await R2.head('market/BTCUSDT_5.csv')).customMetadata.schema,'ohlcv_v2');
assert.equal((await R2.head('market/BTCUSDT_5.csv')).customMetadata.quality,'verified');
const diagOK=await (await R2.get('control/last-market-fetch.json')).json();assert.equal(diagOK.ok,true);assert.equal(diagOK.market,'BTCUSDT:5');assert.equal((await (await R2.get('control/fetch-BTCUSDT-5.json')).json()).ok,true);
assert.equal(results.length,0);
assert.equal(eventHistory.length,1,'Telemetry should be the only WordPress operation for fetch-only');
env.AUTO_FETCH='false';env.AUTO_RESEARCH='true';
await schedule();assert.equal(queued.shift().kind,'orchestrate');await consume('orchestrate');
assert.equal(results.length,1,'One result must be posted');assert.equal(results[0].id,42);
assert.equal(released.length,0);
const status=await handler.fetch(new Request('https://worker/status',{headers:{authorization:'Bearer '+env.LUMEX_ADMIN_API_TOKEN}}),env);
assert.equal(status.status,200);const info=await status.json();assert.equal(info.markets.filter(m=>m.ready).length,1);assert.equal(info.trading_enabled,false);
failEvaluate=true;claimed=false;await consume('orchestrate');assert.equal(released.length,1,'Failed evaluation must release its lease');assert.equal(results.length,1,'Failed evaluation must not become success');
env.AUTO_RESEARCH='false';env.AUTO_AI='true';await consume('orchestrate');
assert.equal(aiCalls,0,'AI must require verified 15m history');
const aiSkip=await (await R2.get('control/research-scheduler-v1.json')).json();
assert.equal(aiSkip.lastSummary.ai.state,'no_verified_15m_market');
const step15=15*60000,latest15=Math.floor(Date.now()/step15)*step15-step15;
const rows15=Math.ceil(90*1440/15)+250;
const market15=['timestamp,open,high,low,close,volume'];
for(let i=rows15-1;i>=0;i--)market15.push(`${latest15-i*step15},100,101,99,100,12`);
await R2.put('market/BTCUSDT_15.csv',market15.join('\n')+'\n',{
  customMetadata:{schema:'ohlcv_v2',quality:'verified',source:'binance_usdm_perpetual',rows:String(rows15),lastCandleMs:String(latest15),fetchedAtMs:String(Date.now())}
});
await consume('orchestrate');assert.equal(aiCalls,1,'AI runs when verified 15m is ready');
await consume('orchestrate');assert.equal(aiCalls,1,'AI must be rate limited');
assert.equal((await handler.fetch(new Request('https://worker/admin/order',{headers:{authorization:'Bearer '+env.LUMEX_ADMIN_API_TOKEN}}),env)).status,404);
env.RESEARCH_CONTAINER={getByName:()=>({fetch:async()=>response({detail:'bybit_403_binance_403_gate_403_access_restricted'},422)})};
let failing={body:{kind:'fetch',symbol:'XRPUSDT',interval_min:5},attempts:1,ack(){throw Error('must_not_ack');},retry(){this.retried=true;}};
env.AUTO_FETCH='true';env.AUTO_AI='false';
await handler.queue({messages:[failing]},env);assert.equal(failing.retried,true);
const diagFail=await (await R2.get('control/last-market-fetch.json')).json();
assert.equal(diagFail.ok,false);assert.equal(diagFail.market,'XRPUSDT:5');
assert(diagFail.error.includes('bybit_403_binance_403_gate_403_access_restricted'));assert.equal((await (await R2.get('control/fetch-XRPUSDT-5.json')).json()).ok,false);
globalThis.fetch=savedFetch;
console.log('PASS production Worker: disabled default, authenticated status, bounded market fetch, research result, release on failure, AI cadence, no order routes');

// Reject a plausible-length CSV containing a synthetic zero/flat row.
const oldHead=await R2.head('market/BTCUSDT_5.csv');
const corruptLines=validCsv.trimEnd().split('\n');
const badColumns=corruptLines[2000].split(',');
corruptLines[2000]=`${badColumns[0]},100,100,100,100,0`;
const corruptCsv=corruptLines.join('\n')+'\n';
env.RESEARCH_CONTAINER={getByName:()=>({fetch:async()=>new Response(corruptCsv,{headers:{'x-lumex-market-source':'binance_usdm_perpetual'}})})};
const invalid={body:{kind:'fetch',symbol:'BTCUSDT',interval_min:5},attempts:1,ack(){throw Error('must_not_ack');},retry(){this.retried=true;}};
await handler.queue({messages:[invalid]},env);
assert.equal(invalid.retried,true,'zero/flat candle must fail');
assert.equal((await R2.head('market/BTCUSDT_5.csv')).customMetadata.quality,'verified','must retain old verified cache on failed fetch');
assert.equal((await R2.head('market/BTCUSDT_5.csv')).size,oldHead.size);
const rejected=await (await R2.get('control/last-market-fetch.json')).json();
assert.equal(rejected.error,'market_unverified_zero_flat_candle');
// Pre-v2 CSV cannot qualify as research-ready, even if it is large and fresh.
const previousObject=R2.records.get('market/BTCUSDT_5.csv');
R2.records.set('market/BTCUSDT_5.csv',{...previousObject,meta:{...previousObject.meta,schema:'ohlcv_v1',quality:undefined}});
const infoOld=await (await handler.fetch(new Request('https://worker/status',{headers:{authorization:'Bearer '+env.LUMEX_ADMIN_API_TOKEN}}),env)).json();
assert.equal(infoOld.markets.find(x=>x.symbol==='BTCUSDT'&&x.interval_min===5).ready,false);
R2.records.set('market/BTCUSDT_5.csv',previousObject);
console.log('PASS market quality v2: 90d+warmup, zero/flat quarantine, no overwrite, legacy backtest blocked');
