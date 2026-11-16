import assert from 'node:assert/strict';
import {readBinance,readBybit,readOKX,readBitget,readGate,buildExchangeComparison,collectExchangeCompare,serveExchangeCompare,EX_NAMES} from '../src/exchange-compare.mjs';
const NOW=Date.parse('2026-11-16T00:30:00Z'),ms=NOW-60000;
const ok=body=>({ok:true,text:async()=>JSON.stringify(body)});
function fake(url){
 if(url.includes('fapi.binance.com')){
  if(url.includes('globalLongShort'))return ok([{timestamp:ms,longAccount:'.61',shortAccount:'.39'}]);
  if(url.includes('openInterestHist'))return ok([{timestamp:ms,sumOpenInterestValue:'990000000'}]);
  return ok({time:ms,lastFundingRate:'0.0002'});
 }
 if(url.includes('api.bybit.com')){
  if(url.includes('account-ratio'))return ok({retCode:0,result:{list:[{symbol:'BTCUSDT',timestamp:ms,buyRatio:'.65',sellRatio:'.35'}]}});
  return ok({retCode:0,result:{list:[{symbol:'BTCUSDT',openInterestValue:'80000000',fundingRate:'0.0001'}]}});
 }
 if(url.includes('www.okx.com')){
  if(url.includes('rubik'))return ok({code:'0',data:[[ms,'1.5']]});
  if(url.includes('open-interest'))return ok({code:'0',data:[{instId:'BTC-USDT-SWAP',oiUsd:'50000000',ts:ms}]});
  return ok({code:'0',data:[{instId:'BTC-USDT-SWAP',fundingRate:'0.00007',ts:ms}]});
 }
 if(url.includes('api.bitget.com')){
  if(url.includes('futures-account'))return ok({code:'00000',data:[{ts:ms,longAccountRatio:'.60',shortAccountRatio:'.40'}]});
  if(url.includes('open-interest'))return ok({code:'00000',data:{list:[{symbol:'BTCUSDT',timestamp:ms,openInterestValue:'78000000'}]}});
  return ok({code:'00000',data:[{symbol:'BTCUSDT',fundingRate:'0.0001',fundingRateInterval:'8'}]});
 }
 if(url.includes('api.gateio.ws')){
  if(url.includes('contract_stats'))return ok([{time:ms/1000,long_users:6400,short_users:3600,open_interest_usd:52000000}]);
  return ok([{contract:'BTC_USDT',funding_rate:'0.0003'}]);
 }
 throw Error('unexpected_mock_endpoint');
}
const rows=await Promise.all([readBinance('BTC',fake,NOW),readBybit('BTC',fake,NOW),readOKX('BTC',fake,NOW),readBitget('BTC',fake,NOW),readGate('BTC',fake,NOW)]);
assert.deepEqual(rows.map(x=>x.exchange),EX_NAMES);
assert.deepEqual(rows.map(x=>x.account?.long_pct),[61,65,60,60,64]);
for(const r of rows){assert.equal(r.status,'ok');assert(r.open_interest?.value>0);assert(r.funding?.rate_pct>0);}
const report=buildExchangeComparison('BTC',rows,NOW);
assert.equal(report.coverage.long_dominant,5);
assert.equal(report.aggregation,'none');assert.equal(report.missing_as_zero,false);assert.equal(report.order_execution,false);
const blocked=async()=>({ok:false,status:403,text:async()=>''});
const b=await readBinance('BTC',blocked,NOW);
assert.equal(b.status,'unavailable');assert.equal(b.account,null);assert.equal(b.open_interest,null);
assert.throws(()=>buildExchangeComparison('DOGE',rows,NOW));
const restricted=await readBinance('BTC',async()=>ok({code:0,msg:'Service unavailable from a restricted location'}),NOW);
assert.equal(restricted.status,'unavailable');
assert(restricted.errors.some(e=>e.includes('provider_region_restricted')));

const store=new Map(),env={MARKET_DATA:{put:async(k,v)=>store.set(k,JSON.parse(v)),get:async k=>store.has(k)?{json:async()=>store.get(k)}:null}};
await collectExchangeCompare(env,{now:NOW,fetchImpl:fake,coins:['BTC','ETH']});
assert(store.has('market-hub/exchange-compare/v1/latest/BTC.json'));
const partiallyBlocked=async(url)=>url.includes('api.bitget.com')?{ok:false,status:403,text:async()=>''}:fake(url);
await collectExchangeCompare(env,{now:NOW+5*60000,fetchImpl:partiallyBlocked,coins:['BTC','ETH']});
const fallback=store.get('market-hub/exchange-compare/v1/latest/BTC.json');
assert.equal(fallback.exchanges[3].account,null);
assert.equal(fallback.exchanges[3].open_interest,null);
assert.equal(fallback.exchanges[3].funding,null);
assert.equal(fallback.exchanges[3].last_verified?.account?.asof_ms,ms);
assert.equal(fallback.coverage.account,4);
assert.equal(store.get('market-hub/exchange-compare/v1/health.json').schema,'lumex_exchange_compare_health_v2');

assert([...store.keys()].some(k=>k.includes('/history/2026/11/16/BTC-')));
const original=Date.now;Date.now=()=>NOW+5*60000;
let res=await serveExchangeCompare(new Request('https://w/market-hub/v1/exchange-compare?symbol=BTCUSDT'),env);
assert.equal(res.status,200);
res=await serveExchangeCompare(new Request('https://w/market-hub/v1/exchange-compare?symbol=DOGEUSDT'),env);
assert.equal(res.status,400);
Date.now=()=>NOW+3600000;
res=await serveExchangeCompare(new Request('https://w/market-hub/v1/exchange-compare?symbol=BTCUSDT'),env);
assert.equal(res.status,503);assert.equal((await res.json()).error,'snapshot_stale');
Date.now=original;
console.log('PASS five-exchange public R2 comparison: schema, 403, no fabricated data, freshness, history, auth-compatible route');
