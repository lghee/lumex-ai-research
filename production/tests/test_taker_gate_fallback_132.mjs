import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const raw=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
 .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}');
const {default:worker,pulseGateTaker}=await import('data:text/javascript;base64,'+Buffer.from(raw).toString('base64'));
const now=Math.floor(Date.now()/1000),frame=Math.floor(now/300)*300,token='g'.repeat(64);
const gateRows=Array.from({length:6},(_,i)=>({
 time:frame-(5-i)*300,
 long_taker_size:String(100+i*20),short_taker_size:String(200+i*10),
 long_liq_usd_new:100+i,short_liq_usd_new:20+i,
 lsr_taker:0.7,lsr_account:1.4
}));
const computed=pulseGateTaker(gateRows,'BTC',now);
assert(computed.sample_unix<=now&&now-computed.sample_unix<900);
assert.equal(computed.exchange,'Gate');
assert.equal(computed.liquidation.exchange,'Gate');
assert.equal(computed.liquidation.source,'gateio_public_contract_stats_liquidation_aggregates');
assert(computed.liquidation.long_usdt>0);
assert(computed.liquidation.short_usdt>0);
assert.equal(computed.volume_unit,'gate_futures_contracts');
assert(computed.buy_pct>0&&computed.buy_pct<100);
assert.equal(computed.buy_pct+computed.sell_pct,100);
assert.throws(()=>pulseGateTaker([{time:frame-300,long_taker_size:'-1',short_taker_size:'2'}],'BTC',now));
assert.throws(()=>pulseGateTaker([{time:frame-300,long_taker_size:'1',short_taker_size:'NaN'}],'BTC',now));
assert.throws(()=>pulseGateTaker([{time:frame-3900,long_taker_size:'1',short_taker_size:'2'}],'BTC',now));
assert.throws(()=>pulseGateTaker([{time:frame-300,long_taker_size:'0',short_taker_size:'0'}],'BTC',now));
const storage=new Map(),writes=[],calls=[];
const env={
 MARKET_DATA:{
   async get(k){return storage.has(k)?{json:async()=>JSON.parse(storage.get(k))}:null},
   async head(k){return storage.has(k)?{size:storage.get(k).length}:null},
   async put(k,v){writes.push(k);storage.set(k,String(v))}
 },LUMEX_AI_LAB_WORKER_TOKEN:token,
 AUTO_PUBLIC_PULSE_FETCH:'true',AUTO_BINANCE_TAKER_FETCH:'false',
 AUTO_AI:'false',AUTO_FETCH:'false',AUTO_RESEARCH:'false',AUTO_DERIVATIVES_FETCH:'false',
 AUTO_LEGACY_BACKFILL:'false',AUTO_WHALE_FETCH:'false',AUTO_LIVE_STREAM:'false'
};
let gateOutage=false,binance403=true;
const prior=globalThis.fetch;
globalThis.fetch=async url=>{
 const u=new URL(url),sym=u.searchParams.get('symbol')||'BTCUSDT';calls.push(u.href);
 if(u.hostname==='fapi.binance.com')
   return new Response('restricted',{status:binance403?403:200});
 if(u.hostname==='api.gateio.ws'||u.hostname==='fx-api.gateio.ws'){
   assert.equal(u.pathname,'/api/v4/futures/usdt/contract_stats');
   assert(['BTC_USDT','ETH_USDT','SOL_USDT','XRP_USDT'].includes(u.searchParams.get('contract')));
   if(gateOutage)return new Response('unavailable',{status:503});
   return new Response(JSON.stringify(gateRows),{status:200});
 }
 if(u.pathname==='/v5/market/tickers')
   return new Response(JSON.stringify({retCode:0,result:{category:'linear',
     list:['BTC','ETH','SOL','XRP'].map(c=>({symbol:c+'USDT',lastPrice:'50000',
       price24hPcnt:'0.02',fundingRate:'0.0001',openInterestValue:'100000',
       turnover24h:'120000'}))}}));
 if(u.pathname==='/v5/market/account-ratio')
   return new Response(JSON.stringify({retCode:0,result:{list:[
     {symbol:sym,buyRatio:'0.53',sellRatio:'0.47',timestamp:String((now-90)*1000)}]}}));
 if(u.pathname==='/fng/')
   return new Response(JSON.stringify({data:[{value:'44',
     timestamp:String(now-3600),value_classification:'Fear'}]}));
 throw Error('Unexpected '+u.href);
};
const scheduled=async()=>{
 const waits=[];await worker.scheduled({cron:'*/5 * * * *'},env,{waitUntil:x=>waits.push(x)});
 await Promise.all(waits);
};
await scheduled();
assert.equal(calls.length,10,'4 Gate + 4 Bybit accounts + Bybit ticker + FNG; no Binance');
assert(!calls.some(x=>x.includes('binance.com')),'403 restricted Binance must not be retried without opt-in');
const snap=JSON.parse(storage.get('market-hub/public-pulse/v1/latest.json'));
for(const c of ['BTC','ETH','SOL','XRP']){
 const t=snap.feeds.takers[c];
 assert.equal(t.symbol,c+'USDT');
 assert.equal(t.source,'gateio_futures_contract_stats_taker_size');
 assert.equal(t.data.exchange,'Gate');
 assert.equal(t.data.scope,'gateio_futures_contract_stats_closed_5m');
 assert(!JSON.stringify(t).includes('"binance":'));
}
const health=JSON.parse(storage.get('market-hub/public-pulse/v1/health.json'));
assert.equal(health.updated,10);
assert.equal(health.sources.taker_BTC.source,'gateio_futures_contract_stats_taker_size');
assert.equal(health.sources.taker_BTC.fallback_reason,'binance_disabled_due_to_http_403');
const before=storage.get('market-hub/public-pulse/v1/latest.json');
gateOutage=true;
await scheduled();
const resampled=JSON.parse(storage.get('market-hub/public-pulse/v1/latest.json'));
assert.equal(resampled.feeds.tickers.data.quotes.BTCUSDT.last,50000,
  'Bybit valid quote persists after independent Gate outage');
assert.equal(resampled.feeds.ratios.BTC.data.long_pct,53,
  'Bybit valid account ratio persists after independent Gate outage');
assert.equal(resampled.feeds.takers.BTC.source,'gateio_futures_contract_stats_taker_size',
  'the last validated Gate source remains source-labelled');
assert(resampled.collected_at_unix>=JSON.parse(before).collected_at_unix,
  'snapshot time can advance over a one-second boundary');
const health2=JSON.parse(storage.get('market-hub/public-pulse/v1/health.json'));
assert.equal(health2.updated,6,'only non-Gate providers succeeded after Gate outage');
assert.equal(health2.sources.taker_BTC.ok,false);
assert(health2.sources.taker_BTC.error.startsWith('gate_taker_unavailable'));
const retained=JSON.parse(storage.get('market-hub/public-pulse/v1/latest.json'));
assert.equal(retained.feeds.takers.BTC.source,'gateio_futures_contract_stats_taker_size',
 'a provider outage must not replace previous data with imaginary zeros');
gateOutage=false;binance403=true;
env.AUTO_BINANCE_TAKER_FETCH='true';calls.length=0;
await scheduled();
assert.equal(calls.filter(x=>x.includes('fapi.binance.com')).length,4);
const health3=JSON.parse(storage.get('market-hub/public-pulse/v1/health.json'));
assert.equal(health3.updated,10);
assert.equal(health3.sources.taker_BTC.fallback_reason,'provider_http_403');
assert.equal(health3.sources.taker_BTC.source,'gateio_futures_contract_stats_taker_size');
globalThis.fetch=prior;
console.log('PASS Gate fallback: official 5min volume fields, 4 symbols, 10/10 source-attributed feeds, Binance403 isolation, no fabricated zeros');
