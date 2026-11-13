import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
 .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {}');
const worker=(await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))).default;
const now=Date.now(),step=15*60000,last=Math.floor(now/step)*step-step;
const rows=['timestamp,open,high,low,close,volume'];
for(let i=Math.ceil(90*1440/15)+249;i>=0;i--)rows.push(`${last-i*step},100,101,99,100,12`);
const csv=rows.join('\n')+'\n';
const jobs=[{id:99,job_hash:'b'.repeat(64),symbol:'BTCUSDT',interval_min:15,
  finished_unix:Math.floor(last/1000)-1800,
  spec:{family:'breakout',lookback:15,fast:10,slow:60,rsi:55,volume_mult:1.1,stop_atr:1.5,take_atr:2,max_hold:24,trend_filter:true}}];
const marketMeta={schema:'ohlcv_v2',quality:'verified',source:'gateio_usdt_perpetual',rows:String(rows.length-1),lastCandleMs:String(last),fetchedAtMs:String(now)};
let writes=[],observations=[],requests=[];
class R2{
  map=new Map([['market/BTCUSDT_15.csv',{text:csv,meta:marketMeta}]]);
  async head(k){const x=this.map.get(k);return x?{size:new TextEncoder().encode(x.text).length,customMetadata:x.meta}:null;}
  async get(k){const x=this.map.get(k);return x?{size:new TextEncoder().encode(x.text).length,customMetadata:x.meta,text:async()=>x.text,json:async()=>JSON.parse(x.text)}:null;}
  async put(k,v,o={}){this.map.set(k,{text:String(v),meta:o.customMetadata||{}});}
}
const r2=new R2();
const oldFetch=globalThis.fetch;
globalThis.fetch=async(url,o={})=>{
  const path=new URL(url).pathname;requests.push(path);
  if(path.endsWith('/tick'))return Response.json({ok:true,state:'queued',enqueued:0});
  if(path.endsWith('/forward/jobs'))return Response.json({ok:true,jobs});
  if(path.endsWith('/jobs'))return Response.json({ok:true,jobs:[]});
  if(path.endsWith('/forward/records')){
    const r=JSON.parse(o.body);assert.equal(r.paper_only,true);observations.push(r);
    return Response.json({ok:true,state:'paper_observation_recorded'});
  }
  if(path.endsWith('/telemetry')){writes.push(JSON.parse(o.body));return Response.json({ok:true});}
  throw Error('unexpected endpoint: '+path);
};
const env={AUTO_FETCH:'false',AUTO_RESEARCH:'true',AUTO_AI:'false',LUMEX_SITE_URL:'https://lumexbot.com',
  LUMEX_AI_LAB_WORKER_TOKEN:'w'.repeat(64),LUMEX_CONTAINER_KEY:'k'.repeat(40),MARKET_DATA:r2,
  RESEARCH_CONTAINER:{getByName:()=>({fetch:async(url,o)=>{
    assert.equal(new URL(url).pathname,'/observe');const v=JSON.parse(o.body);
    assert.equal(v.market_source,'gateio_usdt_perpetual');assert.equal(v.jobs[0].id,99);
    return Response.json({mode:'paper_observation_only',reports:[{id:99,job_hash:'b'.repeat(64),symbol:'BTCUSDT',interval_min:15,
      candle_open_ms:last,direction:'flat',close_price:100,data_sha256:'a'.repeat(64),source:'gateio_usdt_perpetual',paper_only:true}]});
  }})},RESEARCH_QUEUE:{send:async()=>{}}};
const message={body:{kind:'orchestrate'},ack(){this.acked=true;},retry(){throw Error('unexpected retry');}};
await worker.queue({messages:[message]},env);
assert.equal(message.acked,true);assert.equal(observations.length,1);
assert.equal(writes.length,1);assert.equal(writes[0].forward.recorded,1);
assert(!requests.some(x=>x.includes('/order')||x.includes('/signal')),'public signals and orders must not be called');
console.log('PASS paper-forward: eligible-only WP candidate, R2 closed candle, Container observation, WP journal, NO order/signal');
globalThis.fetch=oldFetch;
