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
const unordered=parseGatePacket('um-futures',{channel:'futures.trades',event:'update',
 result:[{...f,id:34},{...f,id:32},{...f,id:33}]},{BTC_USDT:0.0001},now);
assert.deepEqual(unordered.map(x=>x.id),['32','33','34'],'reverse-ordered exchange packets must not lose valid trades');

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
const baseNow=Date.now();
flow.state.multipliers={BTC_USDT:0.0001};
flow.consume('um-futures',{event:'update',channel:'futures.trades',
 result:[{id:'412',contract:'BTC_USDT',create_time_ms:baseNow-1000,size:'1.25',
 price:'80000',is_internal:true}]});
assert.equal(flow.state.filtered_internal_trades,1);
assert.equal(flow.state.bad_events,0,'documented internal liquidation transfer must not count as malformed');
flow.consume('um-futures',{event:'update',channel:'futures.trades',
 result:[{id:'413',contract:'BTC_USDT',create_time_ms:baseNow-1000,size:'not_a_size',
 price:'80000'}]});
assert.equal(flow.state.rejected_trade_rows,1);
assert.equal(flow.state.bad_events,1,'genuinely malformed trade must be counted');
assert.equal(flow.health().runtime_revision,'phase34.1_precision_20261121');
assert.equal(flow.health().message_diagnostics.filtered_internal_trades,1);

await flow.persist();
const status=objects.get('market-hub/order-flow/v1/live/gate/status.json');
assert.equal(status?.schema,'lumex_gate_live_observation_health_v1');
assert.equal(status?.customer_launch_ready,false);
assert.equal(status?.live_verified,false);
assert.equal(status?.sources?.length,8);
assert.equal(objects.size,1,'never invent minute snapshots when the source is silent');
console.log('PASS phase33 observer heartbeat is independent of trade collection and fail-closed');

let closedOld=0;const refreshed=[];
flow.sockets.set('um-futures',{readyState:1,close:()=>{closedOld++;}});
flow.state.futures_decimal_header_requested=false;
flow.multipliers=async()=>true;
flow.connect=async market=>{refreshed.push(market);};
await flow.ensure();
assert.equal(closedOld,1,'old futures connection must close for decimal rollover');
assert.ok(refreshed.includes('um-futures'),'futures must reconnect instead of trusting integer websocket');
assert.ok(flow.state.gaps.some(x=>x.reason==='precision_upgrade_reconnect'));
console.log('PASS Phase34.1 legacy futures socket requires explicit decimal handshake rollover');
