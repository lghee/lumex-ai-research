import assert from 'node:assert/strict';
import {swolechartsBinanceBackup} from '../src/swolecharts-binance.mjs';
import {collectExchangeCompare} from '../src/exchange-compare.mjs';
const now=Date.parse('2026-11-16T02:12:30Z'),ts=now-180000;
function response(body){return {ok:true,text:async()=>JSON.stringify(body)}}
const source=async url=>{
  if(url.includes('fapi.binance.com'))
    return {ok:false,status:451,text:async()=>JSON.stringify({code:0,msg:'restricted location'})};
  if(url.includes('swolecharts.com/api/series/')){
    const u=new URL(url),m=u.searchParams.get('market');
    assert.equal(m,'binance:perp:BTCUSDT');
    const kind=u.pathname.split('/').pop();
    const v=kind==='long-short'?.742:kind==='oi'?6074297200:-.0000163;
    return response({metric:kind,step:300000,db:true,market:m,kind:kind==='long-short'?'accounts':undefined,
      fields:['v'],t:[ts],v:[v],gaps:[]});
  }
  if(url.includes('api.coinalyze.net'))throw Error('no paid-key fallback');
  if(url.includes('api.bybit.com')||url.includes('api.bytick.com'))
    return response({retCode:10001,result:{list:[]}});
  if(url.includes('www.okx.com'))return response({code:'5000',data:[]});
  if(url.includes('api.bitget.com'))return response({code:'40004',data:[]});
  if(url.includes('api.gateio.ws'))return response([]);
  throw Error('unexpected mock network '+url);
};
const b=await swolechartsBinanceBackup('BTC',{now,fetchImpl:source});
assert.deepEqual(b.errors,[]);
assert.equal(b.account.long_pct,74.2);
assert.equal(b.account.short_pct,25.8);
assert.equal(b.account.denominator,'exchange_long_short_accounts');
assert.equal(b.open_interest.value,6074297200);
assert.equal(b.open_interest.unit,'USD');
assert.equal(b.funding.rate_pct,-.00163);
assert.equal(b.account.vendor,'Swolecharts');
assert.equal(b.funding.source_market,'binance:perp:BTCUSDT');
const bad=await swolechartsBinanceBackup('BTC',{now,fetchImpl:async url=>{
 const u=new URL(url);return response({metric:u.pathname.split('/').pop(),db:true,
 market:'binance:perp:BTCUSDC',t:[ts],v:[.7]})}});
assert.equal(bad.account,null);assert.equal(bad.open_interest,null);assert.equal(bad.funding,null);
const stale=await swolechartsBinanceBackup('BTC',{now,fetchImpl:async url=>{
 const u=new URL(url);return response({metric:u.pathname.split('/').pop(),db:true,
 market:'binance:perp:BTCUSDT',t:[now-26*60000],v:[.7]})}});
assert.equal(stale.account,null);assert.equal(stale.open_interest,null);assert.equal(stale.funding,null);
const records=new Map(),env={MARKET_DATA:{
 get:async k=>records.has(k)?{json:async()=>records.get(k)}:null,
 put:async(k,v)=>records.set(k,JSON.parse(v))}};
await collectExchangeCompare(env,{now,fetchImpl:source,coins:['BTC']});
const out=records.get('market-hub/exchange-compare/v1/latest/BTC.json');
assert.equal(out.exchanges[0].account.long_pct,74.2);
assert.equal(out.exchanges[0].open_interest.value,6074297200);
assert.equal(out.exchanges[0].funding.rate_pct,-.00163);
assert.equal(out.exchanges[0].backup_provider,'Swolecharts');
assert.equal(out.exchanges[0].attribution,'Data by Swolecharts');
assert.equal(out.coverage.account,1);
assert.equal(out.order_execution,false);
assert.equal(out.aggregation,'none');
assert.equal(out.missing_as_zero,false);
console.log('PASS free Binance BTCUSDT exact market, 451 alternate, timestamp, vendor attribution, R2');
