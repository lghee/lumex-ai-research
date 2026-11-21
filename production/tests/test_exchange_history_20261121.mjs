import assert from 'node:assert/strict';
import {archiveHourlyHistory,sanitizeHistoricalSnapshot,serveExchangeHistory} from '../src/exchange-history.mjs';
import {EX_PREFIX,EX_NAMES} from '../src/exchange-compare.mjs';
const now=Date.UTC(2026,10,21,13,32),HOUR=3600000;
function snapshot(t){return {schema:'lumex_exchange_compare_v1',symbol:'BTCUSDT',
  order_execution:false,aggregation:'none',missing_as_zero:false,generated_at_ms:t,
  exchanges:EX_NAMES.map(exchange=>({exchange,
    account:{long_pct:62,short_pct:38,denominator:'exchange_long_short_accounts',method:'provider_account',asof_ms:t},
    open_interest:{value:24000000,unit:'USD',asof_ms:t},
    funding:{rate_pct:0.01,interval_hours:8,asof_ms:t}}))};}
let archive=new Map();
for(let i=1;i<=24;i++){
  const t=now-i*HOUR+7*60000;
  const day=new Date(t).toISOString().slice(0,10).replaceAll('-','/');
  archive.set(EX_PREFIX+'history/'+day+'/BTC-'+t+'.json',snapshot(t));
}
let reads=0;
const env={MARKET_DATA:{
  list:async({prefix})=>({objects:[...archive.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key,size:4096})),truncated:false}),
  get:async key=>{reads++;return archive.has(key)?{size:4096,json:async()=>archive.get(key)}:null}
}};
let snapshots=await archiveHourlyHistory(env,'BTCUSDT',now);
assert.equal(snapshots.length,24);assert.equal(reads,24);
assert.equal(snapshots[0].exchanges[0].account.long_pct,62);
let response=await serveExchangeHistory(new Request('https://test/market-hub/v1/exchange-compare-history?symbol=BTCUSDT&hours=24'),env,now);
assert.equal(response.status,200);
let out=await response.json();
assert.equal(out.schema,'lumex_exchange_history_v1');assert.equal(out.verified_hourly_records,24);
assert.equal(out.market_total_estimate,false);assert.equal(out.order_execution,false);
let invalid=snapshot(now);invalid.exchanges[0].funding.asof_ms=now-40*60000;
assert.equal(sanitizeHistoricalSnapshot(invalid,'BTCUSDT',now,now).exchanges[0].funding,null);
invalid=snapshot(now);invalid.exchanges[0].account.denominator='volume_share';
assert.equal(sanitizeHistoricalSnapshot(invalid,'BTCUSDT',now,now).exchanges[0].account,null);
invalid=snapshot(now);invalid.exchanges[0].exchange='Wrong';
assert.equal(sanitizeHistoricalSnapshot(invalid,'BTCUSDT',now,now),null);
response=await serveExchangeHistory(new Request('https://test/market-hub/v1/exchange-compare-history?symbol=DOGEUSDT'),env,now);
assert.equal(response.status,400);
archive=new Map();
response=await serveExchangeHistory(new Request('https://test/market-hub/v1/exchange-compare-history?symbol=BTCUSDT'),env,now);
assert.equal((await response.json()).history_started,false);
env.MARKET_DATA.list=async()=>({objects:[],truncated:true});
response=await serveExchangeHistory(new Request('https://test/market-hub/v1/exchange-compare-history?symbol=BTCUSDT'),env,now);
assert.equal(response.status,503);
console.log('PASS source-isolated 24h exchange history & gap rejection');
