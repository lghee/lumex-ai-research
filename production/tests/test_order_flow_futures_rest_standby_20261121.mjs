import assert from 'node:assert/strict';
import {collectStandbySlice,standbyUrl,standbyRangeUrl,standbyR2Key,
 decideRestStandby,lastClosedSlice} from '../src/order-flow-futures-rest-standby.mjs';
const S=10000,now=Date.UTC(2026,10,21,11,59,50),slice=now-3*S;
const mult={BTC_USDT:0.0001};
const row=(id,at,symbol='BTC')=>({contract:symbol+'_USDT',id:String(id),
 price:'100000',size:'-1.25',create_time_ms:at/1000});
const u=new URL(standbyUrl('BTC',slice));
assert.equal(u.searchParams.get('contract'),'BTC_USDT');
assert.equal(u.searchParams.has('offset'),false);
assert.equal(u.searchParams.has('page'),false);
assert.equal(u.searchParams.get('from'),String(slice/1000));
assert.equal(u.searchParams.get('to'),String(slice/1000+9));
const second=new URL(standbyRangeUrl('BTC',slice,slice+1000));
assert.equal(second.searchParams.get('from'),second.searchParams.get('to'));
assert.match(standbyR2Key('BTC',slice),/BTC\/\d+\.json$/);
assert.equal(lastClosedSlice(now),now-S);
const simple=await collectStandbySlice('BTC',slice,mult,{now,fetchFn:async(url,opt)=>{
 assert.equal(opt.headers['X-Gate-Size-Decimal'],'1');
 return new Response(JSON.stringify([row(11,slice+2500),row(12,slice+5000)]));
}});
assert.equal(simple.ok,true);
assert.equal(simple.request_count,1);
assert.equal(simple.adaptive_time_partitioned,false);
assert.equal(simple.segment_proofs.length,1);
assert.equal(simple.segment_proofs[0].observed_trades,2);
assert.equal(simple.observed_trades,2);
assert.ok(Math.abs(simple.sell_quote_usdt-25)<1e-9);
assert.equal(simple.exchange_trade_completeness_verified,false);
assert.equal(simple.customer_launch_ready,false);
assert.equal(simple.websocket_merged,false);
assert.equal((await collectStandbySlice('BTC',slice,{}, {now})).status,'contract_unit_unverified');
assert.equal((await collectStandbySlice('BTC',now,mult,{now})).status,'out_of_range');
assert.equal((await collectStandbySlice('BTC',slice,mult,{now,fetchFn:async()=>new Response(JSON.stringify([row(11,slice-1000)]))})).status,'wrong_source_or_time');
assert.equal((await collectStandbySlice('BTC',slice,mult,{now,fetchFn:async()=>new Response(JSON.stringify([row(11,slice+1500),row(11,slice+2000)]))})).status,'duplicate_trade_id');
// 2,500 real distinct rows in 10 seconds triggers a 1,000-row response
// first, then two actual 5s partitions (1,250 rows each), then 2s/3s.
const all=Array.from({length:2500},(_,i)=>row(i+1,slice+i*4));
let reqs=0;
const high=await collectStandbySlice('BTC',slice,mult,{now,fetchFn:async(url,opt)=>{
 reqs++;
 const q=new URL(url).searchParams;
 const start=Number(q.get('from'))*1000,end=(Number(q.get('to'))+1)*1000;
 assert.equal(q.get('limit'),'1000');assert.equal(q.has('last_id'),false);
 assert.ok(end>start&&start>=slice&&end<=slice+S);
 const data=all.filter(x=>{
  const ts=Number(x.create_time_ms)*1000;
  return ts>=start&&ts<end;
 });
 return new Response(JSON.stringify(data.slice(0,1000)));
}});
assert.equal(high.ok,true,'2,500 legitimate prints require adaptive sub-second request partitions');
assert.equal(high.observed_trades,2500);
assert.ok(high.request_count>3&&high.request_count<=19);
assert.equal(high.request_count,reqs);
assert.equal(high.adaptive_time_partitioned,true);
assert.ok(high.segment_proofs.length>=4);
assert.equal(high.segment_proofs.reduce((n,x)=>n+x.observed_trades,0),2500);
assert.ok(high.segment_proofs.every(x=>x.observed_trades<1000));
assert.ok(high.min_partition_seconds>=1);
assert.ok(Math.abs(high.sell_quote_usdt-31250)<1e-9);
assert.equal(high.full_page_reused,false);
assert.equal(high.exchange_trade_completeness_verified,false);
assert.equal(high.source_join_allowed,false);
// Any 1-second window at exactly 1,000 trades is irreducibly ambiguous when
// the public REST endpoint has no guaranteed sub-second paging.
const singleSecondRows=Array.from({length:1100},(_,i)=>row(i+1,slice+Math.floor(i/1100*900)));
const saturated=await collectStandbySlice('BTC',slice,mult,{now,fetchFn:async(url)=>{
 const q=new URL(url).searchParams;
 const start=Number(q.get('from'))*1000,end=(Number(q.get('to'))+1)*1000;
 return new Response(JSON.stringify(singleSecondRows.filter(x=>{
  const ts=Number(x.create_time_ms)*1000;return ts>=start&&ts<end;
 }).slice(0,1000)));
}});
assert.equal(saturated.ok,false);
assert.equal(saturated.status,'one_second_saturated');
assert.equal(saturated.customer_launch_ready,false);
assert.ok(saturated.request_count<=19);
// Bounded failure does not advance the caller's contiguous checkpoint.
const capped=await collectStandbySlice('BTC',slice,mult,{now,maxRequests:1,fetchFn:async()=>new Response(JSON.stringify(Array.from({length:1000},(_,i)=>row(i+1,slice+i))))});
assert.equal(capped.ok,false);
assert.equal(capped.status,'request_cap_reached');
const empty=await collectStandbySlice('BTC',slice,mult,{now,fetchFn:async()=>new Response('[]')});
assert.equal(empty.ok,true);assert.equal(empty.status,'empty_rest_response');
assert.equal(empty.segment_proofs.length,1);assert.equal(empty.observed_trades,0);
assert.equal(empty.exchange_trade_completeness_verified,false);
assert.equal((await collectStandbySlice('BTC',slice,mult,{now,fetchFn:async()=>new Response('bad')})).status,'transport_or_json_error');
const state=decideRestStandby({futures_1006_recent_ms:[now-160000,now-120000,now-5000]},now);
assert.equal(state.use_rest_standby,true);
assert.equal(decideRestStandby({futures_1006_recent_ms:[now-160000,now-120000]},now).use_rest_standby,false);
assert.equal(decideRestStandby({futures_ws_circuit_until:now+30000},now).use_rest_standby,true);
console.log('PASS Phase39 Gate futures adaptive second partitions: 2,500 real rows without 1,000 cap and fail-closed single-second saturation');
