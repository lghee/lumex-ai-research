import assert from 'node:assert/strict';
import {boundedGateRestReplay,gateRestUrl,recoveryKey} from '../src/order-flow-rest-replay.mjs';
const M=60000,now=Date.UTC(2026,10,21,12,7),minute=Math.floor((now-4*M)/M)*M;
const spot=(id,ms)=>({sequence_id:String(id),id:String(id),currency_pair:'BTC_USDT',
 create_time_ms:String(ms),side:id%2?'buy':'sell',amount:'0.1',price:'100',trade_quote:'USDT'});
const future=(id,ms)=>({id:String(id),contract:'BTC_USDT',create_time_ms:ms,
 size:id%2?'12':'-12',price:'100'});
let urls=[];
const mock=async url=>{
 urls.push(url);const i=Number(new URL(url).searchParams.get('page'))-1;
 const rows=i===0?[spot(1,minute+100),spot(2,minute+200)]:[spot(3,minute+500)];
 return new Response(JSON.stringify(rows),{status:200});
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
assert.equal(urls.length,2);
assert.equal(new URL(urls[0]).searchParams.get('from'),String(minute/1000));
assert.equal(new URL(urls[1]).searchParams.get('page'),'2');
let futureUrls=[];
const f=await boundedGateRestReplay('um-futures','BTC',minute,
 {BTC_USDT:0.0001},{now,limit:2,maxPages:2,fetchFn:async (url,opts)=>{
  assert.equal(opts.headers['X-Gate-Size-Decimal'],'1');
  futureUrls.push(url);return new Response(JSON.stringify([future(10,minute+200)]));}});
assert.equal(f.status,'bounded_rest_pages_exhausted');
assert.ok(Math.abs(f.observed_sell_quote_usdt-0.12)<1e-10,'floating-point USDT totals must compare with tolerance');
assert.equal(new URL(futureUrls[0]).searchParams.get('offset'),'0');
assert.equal((await boundedGateRestReplay('um-futures','BTC',minute,{}, {now})).status,
 'futures_contract_units_unverified');
assert.equal((await boundedGateRestReplay('spot','BTC',now,{}, {now})).status,
 'invalid_or_unsettled_window');
assert.equal((await boundedGateRestReplay('spot','BTC',minute,{},{
 now,limit:2,maxPages:1,fetchFn:mock})).status,'pagination_cap_reached');
assert.equal((await boundedGateRestReplay('spot','BTC',minute,{},{
 now,limit:2,maxPages:2,fetchFn:async()=>new Response(JSON.stringify([spot(4,minute-5000)]))})).status,'rest_time_or_schema_mismatch');
assert.equal((await boundedGateRestReplay('spot','BTC',minute,{},{
 now,limit:2,maxPages:2,fetchFn:async()=>new Response(JSON.stringify([spot(4,minute+500),spot(4,minute+500)]))})).status,'rest_duplicate_or_unstable_page');
assert.equal((await boundedGateRestReplay('spot','BTC',minute,{},{
 now,limit:2,maxPages:2,fetchFn:async()=>new Response(JSON.stringify([]))})).status,'empty_unverified');
assert.equal(gateRestUrl('um-futures','BTC',minute,1,100).includes('offset=100'),true);
assert.match(recoveryKey('spot','BTC',minute),/recovery\/v1\/.*\/spot\/BTC\//);
console.log('PASS Phase34 REST bounded time, pagination cap, source units, no fabricated recovery');
