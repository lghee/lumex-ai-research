import assert from 'node:assert/strict';
import {boundedGateRestReplay,gateRestUrl,recoveryKey} from '../src/order-flow-rest-replay.mjs';
import {parseGateExecution} from '../src/order-flow-live-contract.mjs';
const M=60000,now=Date.UTC(2026,10,21,12,7),minute=Math.floor((now-4*M)/M)*M;
const spot=(id,ms)=>({id:String(id),currency_pair:'BTC_USDT',create_time_ms:String(ms),
  side:id%2?'buy':'sell',amount:'0.1',price:'100'});
const future=(id,ms)=>({id:String(id),contract:'BTC_USDT',
  create_time_ms:ms/1000,size:'-12',price:'100'});
const mock=async url=>{
 const i=Number(new URL(url).searchParams.get('page'))-1;
 return new Response(JSON.stringify(i===0?[spot(1,minute+100),spot(2,minute+200)]:[spot(3,minute+500)]));
};
const a=await boundedGateRestReplay('spot','BTC',minute,{},{
 now,limit:2,maxPages:3,fetchFn:mock});
assert.equal(a.status,'bounded_rest_pages_exhausted');
assert.equal(a.rows,3);assert.equal(a.pages,2);
assert.equal(a.observed_buy_quote_usdt,20);
assert.equal(a.observed_sell_quote_usdt,10);
assert.equal(a.exchange_complete_verified,false);
assert.equal(a.customer_launch_ready,false);
assert.equal(a.restored_to_customer_series,false);
assert.equal(new URL(gateRestUrl('spot','BTC',minute,1,100)).searchParams.get('page'),'2');
let futureUrls=[];
const f=await boundedGateRestReplay('um-futures','BTC',minute,{BTC_USDT:0.0001},{
 now,limit:1000,maxPages:6,fetchFn:async (url,opts)=>{
  assert.equal(opts.headers['X-Gate-Size-Decimal'],'1');
  const u=new URL(url);
  assert.equal(u.searchParams.has('offset'),false,'futures API does NOT support offset');
  assert.equal(u.searchParams.has('page'),false,'futures API does NOT support page');
  futureUrls.push(url);
  const i=futureUrls.length-1;
  return new Response(JSON.stringify([future(i+1,minute+i*10000+200)]));
 }});
assert.equal(f.status,'bounded_futures_time_slices_observed');
assert.equal(f.pages,6);
assert.equal(f.rows,6);
assert.ok(Math.abs(f.observed_sell_quote_usdt-0.72)<1e-9);
assert.equal(f.exchange_complete_verified,false);
assert.equal(f.restored_to_customer_series,false);
assert.equal(new URL(futureUrls[0]).searchParams.get('from'),String(minute/1000));
assert.equal(new URL(futureUrls[1]).searchParams.get('from'),String(minute/1000+10));
assert.equal(new URL(futureUrls[5]).searchParams.get('to'),String(minute/1000+59));
const parsed=parseGateExecution('um-futures',future(42,minute+1000),{BTC_USDT:0.0001},now);
assert.equal(parsed.ts,minute+1000,'REST second decimal timestamps must be normalized');
assert.equal(parseGateExecution('um-futures',{...future(42,minute+1000),create_time_ms:undefined,create_time:minute/1000+1},{BTC_USDT:0.0001},now).ts,minute+1000);
assert.equal((await boundedGateRestReplay('um-futures','BTC',minute,{}, {now})).status,'futures_contract_units_unverified');
assert.equal((await boundedGateRestReplay('spot','BTC',now,{}, {now})).status,'invalid_or_unsettled_window');
assert.equal((await boundedGateRestReplay('spot','BTC',minute,{},{
 now,limit:2,maxPages:1,fetchFn:mock})).status,'pagination_cap_reached');
assert.equal((await boundedGateRestReplay('spot','BTC',minute,{},{
 now,limit:2,maxPages:2,fetchFn:async()=>new Response(JSON.stringify([spot(4,minute-5000)]))})).status,'rest_time_or_schema_mismatch');
assert.equal((await boundedGateRestReplay('spot','BTC',minute,{},{
 now,limit:2,maxPages:2,fetchFn:async()=>new Response(JSON.stringify([spot(4,minute+500),spot(4,minute+500)]))})).status,'rest_duplicate_or_unstable_page');
assert.equal((await boundedGateRestReplay('spot','BTC',minute,{},{
 now,limit:2,maxPages:2,fetchFn:async()=>new Response(JSON.stringify([]))})).status,'empty_unverified');
assert.equal((await boundedGateRestReplay('um-futures','BTC',minute,{BTC_USDT:0.0001},{
 now,limit:1000,maxPages:2,fetchFn:async url=>{
 const start=Number(new URL(url).searchParams.get('from'))*1000;
 return new Response(JSON.stringify([future(3+start,start+200)]));
}})).status,'futures_time_slices_incomplete');
assert.equal((await boundedGateRestReplay('um-futures','BTC',minute,{BTC_USDT:0.0001},{
 now,limit:2,maxPages:6,fetchFn:async url=>{
 const start=Number(new URL(url).searchParams.get('from'))*1000;
 return new Response(JSON.stringify([future(1,start+100),future(2,start+200)]));
}})).status,'futures_time_slice_saturated');
assert.match(recoveryKey('spot','BTC',minute),/recovery\/v1\/.*\/spot\/BTC\//);
console.log('PASS Phase35 Gate spot paging, futures time slices/no offset, seconds/ms, no false recovery');
