import assert from 'node:assert/strict';
import {validateHourlyArchive,computeOrderFlow,serveOrderFlowHistory} from '../src/order-flow-verified.mjs';
const H=3600000,now=Date.UTC(2026,10,21,13,30),last=Math.floor(now/H)*H-H,first=last-2231*H;
const mk=(market,change=0)=>({schema:'lumex_flow_hourly_v1',symbol:'BTCUSDT',
 market,origin:'official_binance_public_1h_klines',unit:'USDT_quote',bar_ms:H,
 filled_missing_hours:false,synthetic_values:false,sha256_csv:'a'.repeat(64),created_at_ms:now,
 rows:Array.from({length:2232},(_,i)=>[first+i*H,40000+i*.1,
  100000+change,100+(i%20),55000+change*.4]),
 start_ms:first,end_ms:last,count:2232});
const spot=mk('spot'),futures=mk('um-futures',30000);
assert.equal(validateHourlyArchive(spot,'BTC','spot',now).rows.length,2232);
const result=computeOrderFlow(validateHourlyArchive(spot,'BTC','spot',now),
 validateHourlyArchive(futures,'BTC','um-futures',now),now);
assert.equal(result.coverage_hours,2160);
assert.equal(result.daily.length,90);
assert.equal(result.daily[0].spot_delta,240000);
assert.equal(result.latest.futures_delta,24*(2*(55000+30000*.4)-(100000+30000)));
assert.equal(result.customer_launch_ready,false);
assert.equal(result.live_verified,false);
assert.equal(result.true_trade_footprint_available,false);
const gap=structuredClone(spot);gap.rows.splice(100,1);gap.count--;
assert.equal(validateHourlyArchive(gap,'BTC','spot',now),null);
const overlap=structuredClone(spot);overlap.rows[32][0]=overlap.rows[31][0];
assert.equal(validateHourlyArchive(overlap,'BTC','spot',now),null);
const bogus=structuredClone(spot);bogus.rows[7][4]=200000;
assert.equal(validateHourlyArchive(bogus,'BTC','spot',now),null);
const future=structuredClone(spot);future.rows.at(-1)[0]=Math.floor(now/H)*H;
assert.equal(validateHourlyArchive(future,'BTC','spot',now),null);
const noTs=structuredClone(spot);noTs.rows[3][0]*=1000;
assert.equal(validateHourlyArchive(noTs,'BTC','spot',now),null);
const short=structuredClone(spot);short.rows=short.rows.slice(-2000);short.start_ms=short.rows[0][0];short.count=2000;
assert.equal(validateHourlyArchive(short,'BTC','spot',now),null);
const store=new Map([['market-hub/order-flow/v1/hourly/BTC-spot.json',spot],
 ['market-hub/order-flow/v1/hourly/BTC-um-futures.json',futures]]);
const env={MARKET_DATA:{get:async key=>store.has(key)?{size:JSON.stringify(store.get(key)).length,json:async()=>store.get(key)}:null}};
let r=await serveOrderFlowHistory(new Request('https://worker/market-hub/v1/order-flow-history?symbol=BTC'),env,{now});
assert.equal(r.status,200);assert.equal((await r.json()).daily.length,90);
r=await serveOrderFlowHistory(new Request('https://worker/market-hub/v1/order-flow-history?symbol=ETH'),env,{now});
assert.equal(r.status,503);
r=await serveOrderFlowHistory(new Request('https://worker/market-hub/v1/order-flow-history?symbol=INVALID'),env,{now});
assert.equal(r.status,400);
const stale=now+50*H;
assert.equal(computeOrderFlow(validateHourlyArchive(spot,'BTC','spot',stale),
 validateHourlyArchive(futures,'BTC','um-futures',stale),stale),null);
console.log('PASS 90d source-specific CVD, average fills, exact coverage, no gap, no future data, no fake live launch');
