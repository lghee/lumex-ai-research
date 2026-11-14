import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const src=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
 .replace("import { DurableObject } from 'cloudflare:workers';",
 'class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}');
const {default:worker,oiGateHistory,marketTerminalSummary}=
 await import('data:text/javascript;base64,'+Buffer.from(src).toString('base64'));
const ms=Date.now(),st='q'.repeat(64),span=14400000,frame=Math.floor(ms/span)*span;
const fixture=(days,missing=false)=>{
 const delta=days===30?14400000:3600000,end=Math.floor(ms/delta)*delta;
 return Array.from({length:200},(_,i)=>{
    const t=end-(200-i)*delta;
    return {time:Math.floor(t/1000),mark_price:String(2300+i*.01),
      open_interest_usd:String(1.2e9+i*300),open_interest:String(500000+i),
      long_liq_usd_new:0,short_liq_usd_new:0};
 }).filter((x,i)=>!missing||i!==100);
};
for(const days of [7,30]){
 const h=oiGateHistory(fixture(days),'ETH',days,ms);
 assert.equal(h.exchange,'Gate');assert.equal(h.history.length,199);
 assert.equal(h.sources.length,1);assert(h.sources[0].startsWith('Gate '));
 assert.equal(h.history.at(-1).price>0,true);
 assert.equal(h.history.at(-1).oi_usd>0,true);
 assert.equal(h.history[0].ts<h.history.at(-1).ts,true);
 assert(h.history.at(-1).ts<=ms,'no open current 4h/1h observation');
 assert.throws(()=>oiGateHistory(fixture(days,true),'ETH',days,ms),/missing_interval/,
  'disallow silently skipping a missing historical observation');
}
assert.throws(()=>oiGateHistory([{time:Math.floor(ms/1000),mark_price:1,open_interest_usd:3}],'ETH',30,ms));
const store=new Map(),writes=[];
const r2={
 async get(k){return store.has(k)?{json:async()=>JSON.parse(store.get(k)),text:async()=>store.get(k)}:null},
 async head(k){return store.has(k)?{size:store.get(k).length}:null},
 async put(k,v){store.set(k,String(v));writes.push(k);}
};
const env={MARKET_DATA:r2,LUMEX_AI_LAB_WORKER_TOKEN:st,
 AUTO_OI_MIRROR_FETCH:'true',AUTO_PUBLIC_PULSE_FETCH:'false',
 AUTO_AI:'false',AUTO_RESEARCH:'false',AUTO_FETCH:'false',
 AUTO_LIVE_STREAM:'false',AUTO_BINANCE_LIQUIDATIONS:'false',
 AUTO_DERIVATIVES_FETCH:'false',AUTO_WHALE_FETCH:'false',AUTO_LEGACY_BACKFILL:'false'};
const requests=[];const original=globalThis.fetch;
globalThis.fetch=async input=>{
 const u=new URL(input);requests.push(u.href);
 if(u.hostname==='api.bybit.com'||u.hostname==='fapi.binance.com')
   return new Response('blocked',{status:403});
 if(u.hostname==='api.gateio.ws'||u.hostname==='fx-api.gateio.ws'){
   assert.equal(u.pathname,'/api/v4/futures/usdt/contract_stats');
   assert(['BTC_USDT','ETH_USDT','SOL_USDT','XRP_USDT'].includes(u.searchParams.get('contract')));
   const interval=u.searchParams.get('interval');
   assert(['1h','4h'].includes(interval));
   return new Response(JSON.stringify(fixture(interval==='4h'?30:7)),{status:200});
 }
 throw Error('unrecognized '+u.href);
};
const waits=[];await worker.scheduled({cron:'*/5 * * * *'},env,{waitUntil:p=>waits.push(p)});
await Promise.all(waits);
assert.equal(requests.filter(x=>x.includes('api.bybit.com')).length,3);
assert.equal(requests.filter(x=>x.includes('fapi.binance.com')).length,3);
assert.equal(requests.filter(x=>x.includes('api.gateio.ws')).length,1);
const health=JSON.parse(store.get('market-hub/oi/v1/health.json'));
const id=Object.keys(health.sources)[0];
assert.equal(health.sources[id].ok,true);assert.equal(health.sources[id].source,'Gate');
assert.equal(health.sources[id].fallback_used,true);
const record=JSON.parse(store.get('market-hub/oi/v1/latest/'+id+'.json'));
assert.equal(record.exchange,'Gate');
assert.equal(record.sources.length,1);
assert.equal(record.merged_with_gate,false,'even when source is Gate it is not blended');
assert.equal(record.source_scope,'single_exchange_public_oi_only');
assert.equal(record.fallback_used,true);
assert.equal(record.history.length,199);
const url='https://worker/market-hub/v1/oi-history?symbol='+record.pair+'&days='+record.days;
assert.equal((await worker.fetch(new Request(url),env)).status,401);
const authorized=await (await worker.fetch(new Request(url,{headers:{Authorization:'Bearer '+st}}),env)).json();
assert.equal(authorized.exchange,'Gate');
const term=await marketTerminalSummary(env,record.pair,Date.now());
if(record.days===7){
 assert.equal(term.sections.oi.values.exchange,'Gate');
 assert.equal(term.sections.oi.source,'gate_single_exchange_open_interest');
}
assert(writes.some(k=>k.startsWith('market-hub/oi/v1/observations/')));
globalThis.fetch=original;
console.log('PASS Gate OI 7d/30d 200 closed source-labeled samples, Bybit+Binance 403 fallback, R2 archive, Bearer protection and no provider mixing');
