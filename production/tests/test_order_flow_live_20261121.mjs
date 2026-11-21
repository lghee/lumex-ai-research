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

assert.equal(parseGateExecution('um-futures',
 {...f,create_time_ms:undefined,create_time:Math.floor((now-500)/1000)},
 {BTC_USDT:0.0001},now)?.ts,Math.floor((now-500)/1000)*1000,
 'seconds-only REST date must validate');
assert.equal(parseGateExecution('um-futures',
 {...f,create_time_ms:(now-500)/1000},
 {BTC_USDT:0.0001},now)?.ts,now-500,
 'fractional seconds REST timestamp must normalize');
assert.equal(decimalId(9007199254740993),null,'unsafe 64bit numeric trade ID cannot dedupe');
assert.equal(decimalId('00009'),'9');assert.equal(orderIdAfter('100','99'),true);
assert.equal(orderIdAfter('100','100'),false);assert.equal(orderIdAfter('90','100'),false);
console.log('PASS phase33 Gate source unit validation, venue isolation, IDs and futures multiplier');

const {OrderFlowLiveLogic,gateReplayOptions}=await import('../src/order-flow-live.mjs');
assert.equal((await import('../src/order-flow-futures-rest-standby.mjs')).decideRestStandby({
 futures_1006_recent_ms:[Date.now()-10000,Date.now()-20000,Date.now()-30000]
}).use_rest_standby,true);
assert.equal(gateReplayOptions('um-futures').maxPages,6,'futures REST must inspect all six 10s windows');
assert.equal(gateReplayOptions('spot').maxPages,3,'spot keeps bounded native page count');
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
assert.equal(flow.health().runtime_revision,'phase36_futures_rest_standby_20261121');
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

flow.env.AUTO_ORDER_FLOW_REST_REPLAY='true';
const before=Date.now();
flow.queueRestGap('um-futures',before);
flow.queueRestGap('um-futures',before+60000);
assert.equal(flow.state.rest_replay_pending.length,4,'repeated future WS disconnects must coalesce by symbol');
flow.queueRestGap('spot',before);
assert.equal(flow.state.rest_replay_pending.length,8,'at most eight pending probes across venues');
for(let i=0;i<15;i++)flow.queueRestGap('um-futures',before+i*15000);
assert.equal(flow.state.rest_replay_pending.length,8,'15s reconnect cycles must not grow replay queue');
console.log('PASS Phase35 replay caller covers six futures slices without backlog saturation');

flow.env.AUTO_GATE_FUTURES_REST_STANDBY='true';
flow.state.futures_1006_recent_ms=[Date.now()-10000,Date.now()-20000,Date.now()-30000];
const nowFail=Date.now();
flow.state.futures_ws_circuit_until=nowFail+5*60000;
await flow.connect('um-futures');
assert.equal(flow.sockets.has('um-futures'),false,'must respect WS circuit, preserving spot');
const standbyState=flow.health().futures_rest_standby;
assert.equal(standbyState.active,true);
assert.equal(standbyState.websocket_merged,false);
assert.equal(flow.health().customer_launch_ready,false);
console.log('PASS Phase36 futures 1006 circuit failover, source isolation and customer launch lock');


// Phase 37: simulated Gate REST failures must not advance the cursor past
// a missing ten-second slice. Never treat a successfully-written error as data.
const {lastClosedSlice,standbyR2Key}=await import('../src/order-flow-futures-rest-standby.mjs');
const ms37=Math.floor(Date.now()/10000)*10000+2000;
const end37=lastClosedSlice(ms37);
const store37=new Map(),failWrites37=new Set();
const flow37=new OrderFlowLiveLogic({storage:{
 get:async()=>null,put:async()=>{},setAlarm:async()=>{}
}},{
 AUTO_GATE_FUTURES_REST_STANDBY:'true',
 MARKET_DATA:{put:async(key,value)=>{
  if(failWrites37.has(key))throw Error('simulated_R2_failure');
  store37.set(key,JSON.parse(value));
 }}
});
await flow37.ready;
flow37.state.multipliers=Object.fromEntries(['BTC','ETH','SOL','XRP'].map(s=>[s+'_USDT',0.0001]));
const mk37=(symbol,at,ok)=>({
 schema:'lumex_gate_futures_rest_standby_v1',source:'gateio_rest',
 symbol,market:'um-futures',slice_start_ms:at,
 checked_at_ms:ms37,ok,status:ok?'observed_rest_trades':'http_503',
 observed_trades:ok?2:0,buy_quote_usdt:ok?10:0,sell_quote_usdt:ok?10:0,
 last_trade_ms:ok?at+1000:null,
 websocket_merged:false,binance_archive_merged:false,
 exchange_trade_completeness_verified:false,customer_launch_ready:false,
 synthetic_values:false
});
let calls37=[];
await flow37.runFuturesRestStandby(ms37,async (symbol,at)=>{
 calls37.push([symbol,at]);
 return mk37(symbol,at,!(symbol==='BTC'&&at===end37-10000));
});
assert.equal(calls37.length,7,'BTC fails first slot, other three symbols process 2 slots each');
assert.equal(flow37.state.futures_rest_cursor.BTC,undefined,'failure must NOT advance BTC cursor');
assert.equal(flow37.state.futures_rest_cursor.ETH,end37);
assert.equal(flow37.state.futures_rest_last_error.BTC.reason,'http_503');
assert.equal(store37.get(standbyR2Key('BTC',end37-10000)).ok,false);
calls37=[];
await flow37.runFuturesRestStandby(ms37,async (symbol,at)=>{
 calls37.push([symbol,at]);return mk37(symbol,at,true);
});
assert.deepEqual(calls37,[['BTC',end37-10000],['BTC',end37]],
 'a later successful retry must fill the exact missing BTC slice before the following slice');
assert.equal(flow37.state.futures_rest_cursor.BTC,end37);
assert.equal(flow37.state.futures_rest_last_error.BTC,undefined);
assert.equal(store37.get(standbyR2Key('BTC',end37-10000)).ok,true);
assert.equal(flow37.health().futures_rest_standby.contiguous_success_cursor,true);
// A live WS object with stale last execution timestamps must not disable standby.
flow37.sockets.set('um-futures',{readyState:1});
const next37=ms37+10000,newEnd37=lastClosedSlice(next37);
failWrites37.add(standbyR2Key('XRP',newEnd37));
await flow37.runFuturesRestStandby(next37,async(symbol,at)=>mk37(symbol,at,true));
assert.equal(flow37.state.futures_rest_cursor.XRP,end37,'failed R2 write never commits progress');
assert.equal(flow37.state.futures_rest_last_error.XRP.reason,'rest_or_r2_failed');
failWrites37.clear();
await flow37.runFuturesRestStandby(next37,async(symbol,at)=>mk37(symbol,at,true));
assert.equal(flow37.state.futures_rest_cursor.XRP,newEnd37);
assert.equal(flow37.state.futures_rest_last_error.XRP,undefined);
console.log('PASS Phase37 sequential per-symbol standby retries, no false cursor advancement on Gate 503/R2 outage');
