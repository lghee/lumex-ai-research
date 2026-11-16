import assert from 'node:assert/strict';
import {coinalyzeBinanceBackup} from '../src/coinalyze-binance.mjs';
import {collectExchangeCompare} from '../src/exchange-compare.mjs';
const now=Date.parse('2026-11-16T01:45:00.000Z'),t=Math.floor((now-60000)/1000);
const store=new Map();
const env={MARKET_DATA:{get:async k=>store.has(k)?{json:async()=>store.get(k)}:null,
 put:async(k,v)=>store.set(k,JSON.parse(v))},
 COINALYZE_API_KEY:'test_key_never_print',
 COINALYZE_COMMERCIAL_USE_APPROVED:'true',
 COINALYZE_FUNDING_UNIT:'percent'};
const ok=x=>({ok:true,text:async()=>JSON.stringify(x)});
const provider=async(url,opts)=>{
 if(!opts?.headers?.api_key||opts.headers.api_key!=='test_key_never_print')
  throw Error('key missing in secure header');
 if(url.includes('api_key='))throw Error('secret exposed via URL');
 if(url.endsWith('/exchanges'))return ok([{name:'Binance',code:'A'},{name:'Bybit',code:'B'}]);
 if(url.endsWith('/future-markets'))return ok([
  {exchange:'A',symbol:'BTCUSDT_PERP.A',symbol_on_exchange:'BTCUSDT',base_asset:'BTC',
   quote_asset:'USDT',is_perpetual:true,margined:'STABLE',has_long_short_ratio_data:true},
  {exchange:'B',symbol:'BTCUSDT_PERP.B',symbol_on_exchange:'BTCUSDT',base_asset:'BTC',
   quote_asset:'USDT',is_perpetual:true,margined:'STABLE',has_long_short_ratio_data:true}
 ]);
 if(url.includes('long-short-ratio-history'))return ok([{symbol:'BTCUSDT_PERP.A',history:[
  {t,l:73.2,s:26.8,r:73.2/26.8}]}]);
 if(url.includes('open-interest?'))return ok([{symbol:'BTCUSDT_PERP.A',value:3450000000,update:t}]);
 if(url.includes('funding-rate?'))return ok([{symbol:'BTCUSDT_PERP.A',value:0.0042,update:t}]);
 throw Error('Unexpected provider URL');
};
const denied=await coinalyzeBinanceBackup('BTC',{...env,COINALYZE_COMMERCIAL_USE_APPROVED:'false'},
  {now,fetchImpl:async()=>{throw Error('must not fetch without licensing')}});
assert.equal(denied.enabled,false);
assert.equal(denied.account,null);
const backup=await coinalyzeBinanceBackup('BTC',env,{now,fetchImpl:provider});
assert.equal(backup.account.long_pct,73.2);
assert.equal(backup.account.short_pct,26.8);
assert.equal(backup.account.venue,'Binance');
assert.equal(backup.open_interest.value,3450000000);
assert.equal(backup.open_interest.unit,'USD');
assert.equal(backup.funding.rate_pct,0.0042);
assert.equal(store.get('market-hub/exchange-compare/v1/coinalyze-market-map.json').markets.BTC,
 'BTCUSDT_PERP.A');
assert(!JSON.stringify([...store.values()]).includes('test_key_never_print'));
const invalid=await coinalyzeBinanceBackup('BTC',{...env,COINALYZE_FUNDING_UNIT:''},
  {now,fetchImpl:provider});
assert.equal(invalid.funding,null);
assert(invalid.errors.includes('funding_unit_not_confirmed'));
const fakeDirect=async(url,opts)=>{
 if(url.includes('fapi.binance.com'))return {ok:false,status:451,
   text:async()=>JSON.stringify({code:0,msg:'Service unavailable from a restricted location'})};
 if(url.includes('api.coinalyze.net'))return provider(url,opts);
 if(url.includes('api.bybit.com'))return ok({retCode:10001,result:{list:[]}});
 if(url.includes('api.bytick.com'))return ok({retCode:10001,result:{list:[]}});
 if(url.includes('www.okx.com'))return ok({code:'51000',data:[]});
 if(url.includes('api.bitget.com'))return ok({code:'40004',data:[]});
 if(url.includes('api.gateio.ws'))return ok([]);
 throw Error('Unexpected direct fetch '+url);
};
await collectExchangeCompare(env,{now,fetchImpl:fakeDirect,coins:['BTC']});
const latest=store.get('market-hub/exchange-compare/v1/latest/BTC.json');
const bin=latest.exchanges[0];
assert.equal(bin.exchange,'Binance');
assert.equal(bin.backup_provider,'Coinalyze');
assert.equal(bin.account.long_pct,73.2);
assert.equal(bin.open_interest.value,3450000000);
assert.equal(bin.funding.rate_pct,0.0042);
assert.equal(latest.coverage.account,1);
assert.equal(latest.coverage.open_interest,1);
assert.equal(latest.coverage.funding,1);
assert.equal(latest.aggregation,'none');
assert.equal(latest.order_execution,false);
console.log('PASS licensed provider only, Binance venue mapping, account percent, USD OI, funding-unit opt-in, 451 fallback and R2 provenance');
