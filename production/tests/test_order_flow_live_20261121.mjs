import assert from 'node:assert/strict';
import {parseGateExecution,parseGatePacket,orderIdAfter,decimalId} from '../src/order-flow-live-contract.mjs';
const now=1763760000000;
const s={currency_pair:'BTC_USDT',id:31,id_market:18,create_time_ms:String(now-1000)+'.1234',
 side:'buy',amount:'0.15',price:'80000',money:'USDT'};
const f={contract:'BTC_USDT',id:34,create_time_ms:now-500,size:-25,price:'80000'};
const v=parseGateExecution('spot',s,{},now);
assert.equal(v.id,'18');assert.equal(v.taker,'buy');assert.equal(v.quote_usdt,12000);
assert.equal(v.ts,now-1000);
const p=parseGateExecution('um-futures',f,{BTC_USDT:'0.0001'},now);
assert.equal(p.taker,'sell');assert.equal(p.base_qty,0.0025);assert.equal(p.quote_usdt,200);
assert.equal(parseGateExecution('um-futures',f,{},now),null,'no fabricated futures multiplier');
assert.equal(parseGateExecution('um-futures',{...f,is_internal:true},{BTC_USDT:0.0001},now),null);
assert.equal(parseGateExecution('spot',{...s,money:'USDC'}, {}, now),null);
assert.equal(parseGateExecution('spot',{...s,create_time_ms:String(now-180000000)}, {}, now),null);
assert.equal(parseGateExecution('spot',{...s,amount:'0'}, {}, now),null);
assert.equal(parseGateExecution('spot',{...s,side:'unknown'}, {}, now),null);
assert.equal(parseGateExecution('spot',{...s,id_market:'bogus'}, {}, now),null);
assert.equal(parseGateExecution('spot',{...s,currency_pair:'DOGE_USDT'}, {}, now),null);
assert.equal(parseGatePacket('spot',{channel:'spot.trades',event:'update',result:s},{},now).length,1);
assert.equal(parseGatePacket('spot',{channel:'futures.trades',event:'update',result:s},{},now).length,0);
assert.equal(decimalId('00009'),'9');assert.equal(orderIdAfter('100','99'),true);
assert.equal(orderIdAfter('100','100'),false);assert.equal(orderIdAfter('90','100'),false);
console.log('PASS phase33 Gate source unit validation, venue isolation, IDs and futures multiplier');

const {OrderFlowLiveLogic}=await import('../src/order-flow-live.mjs');
const objects=new Map();
const state=new Map();
const ctx={storage:{
 get:async key=>state.get(key)||null,
 put:async(key,value)=>state.set(key,value),
 setAlarm:async()=>{}
}};
const flow=new OrderFlowLiveLogic(ctx,{MARKET_DATA:{
 put:async (key,body)=>objects.set(key,JSON.parse(body))
}});
await flow.ready;
await flow.persist();
const status=objects.get('market-hub/order-flow/v1/live/gate/status.json');
assert.equal(status?.schema,'lumex_gate_live_observation_health_v1');
assert.equal(status?.customer_launch_ready,false);
assert.equal(status?.live_verified,false);
assert.equal(status?.sources?.length,8);
assert.equal(objects.size,1,'never invent minute snapshots when the source is silent');
console.log('PASS phase33 observer heartbeat is independent of trade collection and fail-closed');
