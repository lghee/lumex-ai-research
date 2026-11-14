import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const raw=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
  .replace("import { DurableObject } from 'cloudflare:workers';",
    'class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}');
const {default:worker,MarketEventHub}=
  await import('data:text/javascript;base64,'+Buffer.from(raw).toString('base64'));
const now=Date.now(),hour=Math.floor(now/3600000)*3600000,token='c'.repeat(64);
let doReads=0,listReads=0,r2Reads=0,failSymbol='',corrupt=false;
const history=[];
for(const symbol of ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT']){
 const sql={exec(query,...values){
   if(query.startsWith('PRAGMA'))return {toArray:()=>[{name:'rollup_done'}]};
   if(query.includes('SELECT bucket,kind,source,events')){
     doReads++;
     const rows=[
       {bucket:hour,kind:'liquidation',source:'bybit',events:2},
       {bucket:hour,kind:'liquidation',source:'binance',events:3},
       {bucket:hour,kind:'trade',source:'gateio',events:15}];
     if(symbol==='BTCUSDT')rows.push({bucket:hour,kind:'whale_transfer',source:'blockstream',events:1});
     return {toArray:()=>rows};
   }
   if(query.includes('rollup_done=0'))return {toArray:()=>[{n:0}]};
   if(query.includes('archived=0'))return {toArray:()=>[{n:4}]};
   return {toArray:()=>[]};
 }};
 history.push([symbol,new MarketEventHub({storage:{sql}}, {})]);
}
const hubs=new Map(history);
const fmt=t=>new Date(t).toISOString().slice(0,13).replaceAll('-','/');
const r2={
 async list({prefix,limit}){
   listReads++;assert.equal(limit,1);
   const eventHour=fmt(hour),belongs=prefix.endsWith(eventHour+'/');
   if(!belongs)return {objects:[]};
   const kind=prefix.includes('/whale_transfer/')?'whale_transfer':'liquidation';
   const key=prefix+'archive-test.jsonl';
   const e={id:kind==='liquidation'?'bybit:liq:BTCUSDT:'+'a'.repeat(32):
      'btc:addressflow:'+'b'.repeat(64)+':abcdef',
     kind,source:kind==='liquidation'?'bybit':'blockstream',symbol:'BTCUSDT',
     ts:now-1000,quantity:1,price:kind==='liquidation'?50000:0,observed:true};
   const body=JSON.stringify(e)+'\n';
   return {objects:[{key,size:Buffer.byteLength(body),uploaded:new Date(now)}]};
 },
 async get(key){
   r2Reads++;
   const kind=key.includes('/whale_transfer/')?'whale_transfer':'liquidation';
   const e={id:kind==='liquidation'?'bybit:liq:BTCUSDT:'+'a'.repeat(32):
       'btc:addressflow:'+'b'.repeat(64)+':abcdef',
      kind:corrupt?'ticker':kind,source:kind==='liquidation'?'bybit':'blockstream',
      symbol:'BTCUSDT',ts:now-1000,price:50000,quantity:1};
   return {text:async()=>JSON.stringify(e)+'\n'};
 }
};
const env={LUMEX_AI_LAB_WORKER_TOKEN:token,MARKET_DATA:r2,
 MARKET_EVENT_HUB:{getByName(symbol){
   return {fetch:req=>symbol===failSymbol?
    Promise.resolve(new Response('{}',{status:503})):
    hubs.get(symbol).fetch(req instanceof Request?req:new Request(req))};
 }},
 MARKET_LIVE_COLLECTOR:{getByName(){return {fetch:async()=>new Response(JSON.stringify({
  ok:true,enabled:true,feeds:{
   bybit:{enabled:true,connected:true,last_received_ms:now-1000,packets:44,age_seconds:1},
   binance:{enabled:true,connected:true,last_received_ms:now-3000,packets:11,age_seconds:3},
   gate:{enabled:true,connected:true,last_received_ms:now-1200,packets:9,age_seconds:1}
  }}))}}},
 BTC_RESERVE_COLLECTOR:{getByName(){return {fetch:async()=>new Response(JSON.stringify({
  ok:true,enabled:true,source:'wordpress_configured',
  last_success_ms:now-10000,watchlist:[{gap_possible:false}] }))}}}
};
const url='https://worker/market-hub/v1/continuity-audit';
const denied=await worker.fetch(new Request(url),env);
assert.equal(denied.status,401);assert.equal(doReads+listReads+r2Reads,0);
const good=await worker.fetch(new Request(url,{headers:{authorization:'Bearer '+token}}),env);
assert.equal(good.status,200);
const report=await good.json();
assert.equal(report.ok,true);assert.equal(report.schema,'lumex_continuity_audit_v1');
assert.equal(report.window_hours,6);assert.equal(report.symbols.length,4);
assert(report.symbols.every(x=>x.hourly.length===6));
assert.equal(report.symbols[0].hourly.at(-1).bybit_liquidation,2);
assert.equal(report.symbols[0].hourly.at(-1).binance_liquidation_sampled,3);
assert.equal(report.symbols[0].hourly.at(-1).btc_watchlist_flow,1);
assert.equal(report.symbols[1].hourly.at(-1).btc_watchlist_flow,0);
assert.equal(report.symbols[0].pending_archive,4);
assert.equal(report.r2.list_checks,12);assert.equal(listReads,12);
assert.equal(report.r2.kinds.liquidation.sample_verified,true);
assert.equal(report.r2.kinds.whale_transfer.sample_verified,true);
assert.equal(report.r2.kinds.liquidation.verified_records,1);
assert.equal(r2Reads,2);
assert.equal(report.feeds.binance.connected,true);
assert.equal(report.whale.watchlist_source,'wordpress_configured');
assert.equal(report.safe_to_disable_wordpress_crons,false);
assert.equal(report.archive_merged,false);
assert.equal(report.complete_market_capture,false);
assert(!JSON.stringify(report).includes('archive-test.jsonl'),'R2 object keys are not exposed');
failSymbol='SOLUSDT';corrupt=true;
const partial=await (await worker.fetch(new Request(url,{headers:{authorization:'Bearer '+token}}),env)).json();
assert.equal(partial.symbols.find(x=>x.symbol==='SOLUSDT').ok,false);
assert.equal(partial.r2.kinds.liquidation.sample_verified,false);
assert.equal(partial.safe_to_disable_wordpress_crons,false);
const health=await (await worker.fetch(new Request('https://worker/market-hub/v1/health'),env)).json();
assert.equal(health.version,'1.2.12');
console.log('PASS 1.2.12 continuity: 4 DO hot-index windows, 12 bounded R2 probes, 2 real JSONL readbacks, source health, fail-closed/isolated, no Cron changes');