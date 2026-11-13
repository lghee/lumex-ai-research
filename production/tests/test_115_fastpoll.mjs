import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
 .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {}');
const handler=(await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))).default;
const queue=[];
const env={AUTO_FETCH:'true',AUTO_RESEARCH:'true',AUTO_AI:'false',
  LUMEX_ADMIN_API_TOKEN:'z'.repeat(40),
  RESEARCH_QUEUE:{send:async msg=>{queue.push(msg)}}};
for(const cron of ['* * * * *','*/5 * * * *']){
  let complete;await handler.scheduled({cron},env,{waitUntil(x){complete=x}});await complete;
}
assert.deepEqual(queue.map(x=>x.kind),['market_tick','orchestrate']);
assert.equal((await handler.fetch(new Request('https://worker/health'),env)).status,200);
assert.equal((await (await handler.fetch(new Request('https://worker/health'),env)).json()).version,'1.1.7');
const request=new Request('https://worker/enqueue',{method:'POST',headers:{authorization:'Bearer '+'z'.repeat(40)},body:JSON.stringify({kind:'market_tick'})});
assert.equal((await handler.fetch(request,env)).status,400,'market_tick must not be external action');

const step=300_000,now=Date.now(),last=Math.floor(now/step)*step-step;
const min=Math.ceil(30*1440/5)+250;
const rows=['timestamp,open,high,low,close,volume'];
for(let i=min-1;i>=0;i--)rows.push(`${last-i*step},100,101,99,100,12`);
const partial=rows.join('\n')+'\n';
class Bucket {
  data=new Map();
  async get(k){const v=this.data.get(k);return v?{size:v.bytes.length,customMetadata:v.meta,text:async()=>new TextDecoder().decode(v.bytes),json:async()=>JSON.parse(new TextDecoder().decode(v.bytes))}:null;}
  async head(k){const v=this.data.get(k);return v?{size:v.bytes.length,customMetadata:v.meta}:null;}
  async put(k,content,opts={}){this.data.set(k,{bytes:content instanceof ArrayBuffer?new Uint8Array(content):new TextEncoder().encode(content),meta:opts.customMetadata||{}})}
}
const bucket=new Bucket();
const live={...env,MARKET_DATA:bucket,LUMEX_CONTAINER_KEY:'q'.repeat(40),RESEARCH_CONTAINER:{getByName:()=>({fetch:async()=>new Response(partial,{headers:{'x-lumex-market-source':'gateio_usdt_perpetual'}})})}};
const message={body:{kind:'fetch',symbol:'BTCUSDT',interval_min:5},ack(){this.acked=true},retry(){throw Error('unexpected retry')}};
await handler.queue({messages:[message]},live);
assert.equal(message.acked,true);
assert.equal((await bucket.head('market/BTCUSDT_5.csv')).customMetadata.quality,'collecting');
const res=await handler.fetch(new Request('https://worker/status',{headers:{authorization:'Bearer '+'z'.repeat(40)}}),live);
const info=await res.json();const cand=info.markets.find(x=>x.symbol==='BTCUSDT'&&x.interval_min===5);
assert.equal(cand.ready,false,'30-day history must never be used as 90-day research data');
assert.equal(cand.quality,'collecting');
console.log('PASS Worker 1.1.7: split schedule, 5m collecting-only archive, backtest blocked, no external cron action');
