import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
 .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}');
const {default:worker,pulseGateTickerQuote,pulseGateUserRatio,marketTerminalSummary}=
 await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const now=Math.floor(Date.now()/1000),frame=Math.floor(now/300)*300,token='h'.repeat(64);
const coins=['BTC','ETH','SOL','XRP'],calls=[],store=new Map(),written=[];
const stats=Array.from({length:6},(_,i)=>({
 time:frame-(5-i)*300,long_users:20200+i*10,short_users:9800+i*6,
 long_taker_size:600+i*7,short_taker_size:400+i*5,
 long_liq_usd_new:0,short_liq_usd_new:0}));
const quote=c=>[{contract:c+'_USDT',last:'50000',change_percentage:'-1.8',
 funding_rate:'0.00001',volume_24h_quote:'4000000'}];
assert.equal(pulseGateTickerQuote(quote('BTC'),'BTC').change_24h_pct,-1.8);
assert.equal(pulseGateTickerQuote(quote('BTC'),'BTC').last,50000);
assert.throws(()=>pulseGateTickerQuote([{contract:'ETH_USDT',last:'50000'}],'BTC'));
assert.equal(pulseGateUserRatio(stats,'BTC',now).exchange,'Gate');
assert(pulseGateUserRatio(stats,'BTC',now).long_pct>50);
assert.throws(()=>pulseGateUserRatio([{time:frame-300,long_users:-5,short_users:6}],'BTC',now));
const r2={
 async get(key){return store.has(key)?{json:async()=>JSON.parse(store.get(key))}:null},
 async head(key){return store.has(key)?{size:store.get(key).length}:null},
 async put(key,body){written.push(key);store.set(key,String(body))}
};
const env={MARKET_DATA:r2,LUMEX_AI_LAB_WORKER_TOKEN:token,
 AUTO_PUBLIC_PULSE_FETCH:'true',AUTO_BINANCE_TAKER_FETCH:'false',
 AUTO_FETCH:'false',AUTO_AI:'false',AUTO_RESEARCH:'false',AUTO_LIVE_STREAM:'false',
 AUTO_WHALE_FETCH:'false',AUTO_LEGACY_BACKFILL:'false',AUTO_DERIVATIVES_FETCH:'false'};
let gateDown=false;const old=globalThis.fetch;
globalThis.fetch=async uri=>{
 const url=new URL(uri);calls.push(url.href);
 if(url.hostname==='api.bybit.com')return new Response('{}',{status:403});
 if(url.hostname==='api.gateio.ws'||url.hostname==='fx-api.gateio.ws'){
  if(gateDown)return new Response('{}',{status:503});
  const contract=url.searchParams.get('contract')||'BTC_USDT';
  assert(coins.includes(contract.split('_')[0]));
  if(url.pathname==='/api/v4/futures/usdt/tickers')
   return new Response(JSON.stringify(quote(contract.split('_')[0])));
  if(url.pathname==='/api/v4/futures/usdt/contract_stats')
   return new Response(JSON.stringify(stats));
  throw Error('invalid Gate path');
 }
 if(url.hostname==='api.alternative.me')
  return new Response(JSON.stringify({data:[{value:'50',timestamp:String(now-1800),
    value_classification:'Neutral'}]}));
 throw Error('unexpected '+url.href);
};
async function tick(){
 const tasks=[];await worker.scheduled({cron:'*/5 * * * *'},env,{waitUntil:x=>tasks.push(x)});
 await Promise.all(tasks);
}
await tick();
const health=JSON.parse(store.get('market-hub/public-pulse/v1/health.json'));
assert.equal(health.updated,10);
assert.equal(health.total,10);
const doc=JSON.parse(store.get('market-hub/public-pulse/v1/latest.json'));
assert.equal(doc.feeds.tickers.source,'gateio_usdt_perpetual_tickers');
for(const c of coins){
 assert.equal(doc.feeds.ratios[c].source,'gateio_futures_contract_stats_user_ratio');
 assert.equal(doc.feeds.ratios[c].data.exchange,'Gate');
 assert.equal(doc.feeds.takers[c].source,'gateio_futures_contract_stats_taker_size');
 assert.equal(health.sources['ratio_'+c].fallback_reason,'bybit_public_unavailable');
}
assert.equal(calls.filter(x=>x.includes('api.bybit.com')).length,5);
assert(!calls.some(x=>x.includes('binance.com')));
const snap=await marketTerminalSummary({...env,MARKET_EVENT_HUB:null},'BTCUSDT');
assert.notEqual(snap.sections.pulse.status,'unavailable');
assert.equal(snap.sections.pulse.values.bybit_price,null);
assert.equal(snap.sections.pulse.values.gate_price,50000);
assert.equal(snap.sections.pulse.values.price_exchange,'Gate');
assert.equal(snap.sections.pulse.values.bybit_accounts_long_pct,null);
assert(snap.sections.pulse.values.gate_accounts_long_pct>50);
assert.equal(snap.sections.pulse.values.account_ratio_exchange,'Gate');
assert.equal(snap.sections.pulse.values.taker_exchange,'Gate');
assert.equal(snap.sections.pulse.values.source_status.bybit_account_ratio,'unavailable');
assert.equal(snap.sections.pulse.values.source_status.gate_account_ratio,'available');
assert(!written.some(x=>x.includes('orders')||x.includes('private')));
const before=store.get('market-hub/public-pulse/v1/latest.json');
gateDown=true;await tick();
assert.equal(store.get('market-hub/public-pulse/v1/latest.json'),before,
  'existing valid R2 snapshot retained if Bybit and Gate unavailable');
const failed=JSON.parse(store.get('market-hub/public-pulse/v1/health.json'));
assert.equal(failed.updated,1,'only independent FNG survives dual provider outage');
assert.equal(failed.sources.ratio_BTC.ok,false);
globalThis.fetch=old;
console.log('PASS source-separated Gate tickers and account ratios: 5 Bybit 403 -> 10/10 feeds, customer terminal Gate attribution, fail closed');
