import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const raw=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
  .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}');
const {default:worker}=await import('data:text/javascript;base64,'+Buffer.from(raw).toString('base64'));
const storage=new Map(),writes=[],calls=[];
const r2={
 async get(k){return storage.has(k)?{json:async()=>JSON.parse(storage.get(k))}:null},
 async head(k){return storage.has(k)?{size:storage.get(k).length}:null},
 async put(k,v){writes.push(k);storage.set(k,String(v))}
};
const token='x'.repeat(64);
const env={MARKET_DATA:r2,LUMEX_AI_LAB_WORKER_TOKEN:token,
 AUTO_PUBLIC_PULSE_FETCH:'true',AUTO_LEGACY_BACKFILL:'false',AUTO_RESEARCH:'false',
 AUTO_FETCH:'false',AUTO_AI:'false',AUTO_DERIVATIVES_FETCH:'false',
 AUTO_WHALE_FETCH:'false',AUTO_LIVE_STREAM:'false'};
const now=Math.floor(Date.now()/1000);
let outage=false;
const original=globalThis.fetch;
globalThis.fetch=async u=>{
 const url=new URL(u);calls.push(url.href);
 if(outage)return new Response('unavailable',{status:503});
 const sym=url.searchParams.get('symbol')||'BTCUSDT',coin=sym.replace('USDT','');
 let value;
 if(url.pathname==='/v5/market/tickers'){
   assert.equal(url.origin,'https://api.bybit.com');
   value={retCode:0,result:{category:'linear',list:['BTC','ETH','SOL','XRP'].map(c=>({
     symbol:c+'USDT',lastPrice:'50000',price24hPcnt:'0.025',
     fundingRate:'0.0001',openInterestValue:'90000',turnover24h:'1200000'
   }))}};
 }else if(url.pathname==='/v5/market/account-ratio'){
   assert.equal(url.origin,'https://api.bybit.com');
   value={retCode:0,result:{list:[{symbol:sym,buyRatio:'0.58',sellRatio:'0.42',timestamp:String((now-120)*1000)}]}};
 }else if(url.pathname==='/futures/data/takerlongshortRatio'){
   assert.equal(url.origin,'https://fapi.binance.com');
   value=Array.from({length:6},(_,i)=>({
     timestamp:String((Math.floor((now-1200)/300)*300+i*300)*1000),
     buyVol:'60',sellVol:'40'
   }));
 }else if(url.pathname==='/fng/'){
   assert.equal(url.origin,'https://api.alternative.me');
   value={data:[{value:'45',timestamp:String(now-900),value_classification:'Fear'}]};
 }else throw Error('unexpected_public_url '+url.href);
 return new Response(JSON.stringify(value),{status:200});
};
const once=async()=>{
 const work=[];await worker.scheduled({cron:'*/5 * * * *'},env,{waitUntil:p=>work.push(p)});
 await Promise.all(work);
};
await once();
assert.equal(calls.length,10,'one Bybit ticker + four account ratios + four Binance taker + FNG');
const latest=JSON.parse(storage.get('market-hub/public-pulse/v1/latest.json'));
assert.equal(latest.schema,'lumex_public_pulse_v1');
assert.equal(latest.order_execution,false);
assert.deepEqual(Object.keys(latest.feeds.ratios).sort(),['BTC','ETH','SOL','XRP']);
assert.deepEqual(Object.keys(latest.feeds.takers).sort(),['BTC','ETH','SOL','XRP']);
assert.equal(latest.feeds.ratio.data.long_pct,58);
assert.equal(latest.feeds.takers.SOL.data.buy_pct,60);
assert.equal(latest.feeds.takers.SOL.symbol,'SOLUSDT');
assert.equal(latest.feeds.ratios.ETH.symbol,'ETHUSDT');
assert.equal(latest.feeds.sentiment.source,'alternative_me_fng');
assert(writes.some(k=>k.startsWith('market-hub/public-pulse/v1/observations/')));
assert(!writes.some(k=>k.includes('orders')||k.includes('live-ledger')));
const naked=await worker.fetch(new Request('https://worker/market-hub/v1/public-pulse'),env);
assert.equal(naked.status,401,'no unauthenticated data access');
const auth=await worker.fetch(new Request('https://worker/market-hub/v1/public-pulse',
 {headers:{Authorization:'Bearer '+token}}),env);
assert.equal(auth.status,200,'server Bearer access');
assert.equal((await auth.json()).feeds.tickers.data.breadth.total,4);
const health=await worker.fetch(new Request('https://worker/market-hub/v1/public-pulse-health'),env);
assert.equal((await health.json()).report.updated,10);
const before=storage.get('market-hub/public-pulse/v1/latest.json');
outage=true;await once();
assert.equal(storage.get('market-hub/public-pulse/v1/latest.json'),before,'outage must preserve last observation');
const status=(await (await worker.fetch(new Request('https://worker/market-hub/v1/public-pulse-health'),env)).json());
assert.equal(status.report.updated,0);
const version=await worker.fetch(new Request('https://worker/market-hub/v1/health'),env);
assert.equal((await version.json()).version,'1.2.7');
globalThis.fetch=original;
console.log('PASS 1.2.7 pulse: 10 bounded public feeds, strict provenance, independent R2 archive, Bearer gate, no hidden fallback');