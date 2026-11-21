import assert from 'node:assert/strict';
import {buildHourlyObservedProof,buildRollingObservedProof,collectGateObservedCoverage,
  observedMinuteKey,hourlyProofKey,rollingProofKey,readObservedMinute} from '../src/order-flow-coverage.mjs';
const H=3600000,M=60000,now=Date.UTC(2026,10,21,11,7),start=Date.UTC(2026,10,21,10);
const mk=(ms)=>({schema:'lumex_gate_ws_observed_minute_v1',source:'gateio',observed_minute_ms:ms,
  complete_trades_verified:false,synthetic_values:false,customer_launch_ready:false,
  historical_binance_archive_combined:false,gaps_observed:false,
  rows:['spot','um-futures'].flatMap(m=>['BTC','ETH','SOL','XRP'].map(s=>({
    source:'gateio',market:m,symbol:s,observed_trades:1,buy_quote_usdt:42,
    sell_quote_usdt:24,last_trade_ms:ms+1000})))});
const full=Array.from({length:60},(_,i)=>mk(start+i*M));
let p=buildHourlyObservedProof(start,full,now);
assert.equal(p.observed_minute_continuity,true);
assert.equal(p.exchange_full_trade_completeness,false);
assert.equal(p.markets.length,8);
assert.equal(readObservedMinute(mk(start),start).present.length,8);
let incomplete=full.slice();incomplete[3]=null;
assert.equal(buildHourlyObservedProof(start,incomplete,now).observed_minute_continuity,false);
assert.equal(buildHourlyObservedProof(start,incomplete,now).missing_or_gap_minutes.length,1);
incomplete=full.slice();incomplete[4]={...mk(start+4*M),gaps_observed:true};
assert.equal(buildHourlyObservedProof(start,incomplete,now).observed_minute_continuity,false);
incomplete=full.slice();incomplete[1]={...mk(start+M),rows:[mk(start+M).rows[0],mk(start+M).rows[0]]};
assert.equal(buildHourlyObservedProof(start,incomplete,now).invalid_minutes.length,1);
const previous=Array.from({length:168},(_,i)=>({
 ...p,hour_start_ms:Math.floor(now/H)*H-168*H+i*H}));
let roll=buildRollingObservedProof(now,previous);
assert.equal(roll.observed_minutes_continuous_24h,true);
assert.equal(roll.observed_minutes_continuous_7d,true);
assert.equal(roll.exchange_full_trade_completeness,false);
assert.equal(roll.customer_launch_ready,false);
previous[5]=null;
roll=buildRollingObservedProof(now,previous);
assert.equal(roll.observed_minutes_continuous_7d,false);
assert.equal(roll.observed_minutes_continuous_24h,true);
previous[167]=null;
assert.equal(buildRollingObservedProof(now,previous).observed_minutes_continuous_24h,false);
const db=new Map(full.map((x,i)=>[observedMinuteKey(start+i*M),x]));
const env={MARKET_DATA:{
  get:async k=>db.has(k)?{json:async()=>db.get(k)}:null,
  put:async (k,v)=>{db.set(k,JSON.parse(v));}}};
const result=await collectGateObservedCoverage(env,now);
assert.equal(result.ok,true);assert.equal(result.hourly_observed,true);
assert.equal(db.get(hourlyProofKey(start)).customer_launch_ready,false);
assert.equal(db.get(rollingProofKey).accepted_hours_24h,1,'the just-written closed hour is valid, earlier hours are missing');
assert.equal(db.get(rollingProofKey).observed_minutes_continuous_7d,false);
console.log('PASS Phase34 60-minute source-isolated windows, immutable historical proof, no premature 24h/7d/live release');
