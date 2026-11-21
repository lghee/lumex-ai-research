import assert from 'node:assert/strict';
import {matrix,archiveVenueHour,top50VenueHistory,serveTop50VenueHistory} from '../src/pro-venue-matrix.mjs';
const HOUR=3600000,now=Date.UTC(2026,10,21,4,16);
const names=['Binance','Bybit','OKX','Bitget','Gate'];
const objects=new Map();
const env={MARKET_DATA:{
 get:async key=>objects.has(key)?{size:JSON.stringify(objects.get(key)).length,json:async()=>objects.get(key)}:null,
 put:async(key,payload)=>objects.set(key,JSON.parse(payload))}};
const key='market-hub/universe/top50-five-venues-v1.json';
function snap(t,oi=2400000){
 const markets={BTCUSDT:names.map((exchange,i)=>({symbol:'BTCUSDT',exchange,
   status:i===1?'unavailable':'observed',mark_price:i===1?null:55000+i,
   funding_pct:i===1?null:-.01,oi_usd:i===1?null:oi+i*100000,
   observed_ms:i===1?null:t,oi_unit:i===1?null:'USD'}))};
 return {ok:true,schema:'lumex_uid_top50_venue_matrix_v1',generated_at_ms:t,
   order_execution:false,aggregation:'none',supported_symbols:['BTCUSDT'],
   markets,venues:names,observed_sources:Object.fromEntries(names.map(x=>[x,true]))};
}
for(let i=0;i<10;i++){
 const ts=now-i*HOUR;
 const doc=snap(ts,2400000+i*10000);
 objects.set(key,doc);
 assert.equal((await archiveVenueHour(env,doc,ts)).ok,true);
}
objects.set(key,snap(now));
const doc=await top50VenueHistory(env,'BTCUSDT',now);
assert.equal(doc.ok,true);
assert.equal(doc.schema,'lumex_exchange_history_v1');
assert.equal(doc.snapshots.length,10);
assert.equal(doc.snapshots[0].exchanges.length,5);
assert.equal(doc.snapshots[0].exchanges[1].open_interest,null);
assert.equal(doc.snapshots[0].exchanges[0].open_interest.unit,'USD');
assert.equal(doc.order_execution,false);
assert.equal(doc.missing_is_zero,false);
const keyHour='market-hub/universe/venue-history/v1/'+String(Math.floor(now/HOUR)*HOUR)+'.json';
const old=objects.get(keyHour);
assert.equal((await archiveVenueHour(env,snap(now,4400000),now)).stored,false);
assert.equal(objects.get(keyHour).markets.BTCUSDT[0].oi_usd,old.markets.BTCUSDT[0].oi_usd);
const response=await serveTop50VenueHistory(new Request('https://worker/market-hub/v1/pro-top50-history?symbol=BTCUSDT'),env,now);
assert.equal(response.status,200);
assert.equal((await response.json()).snapshots.length,10);
const bad=await serveTop50VenueHistory(new Request('https://worker/market-hub/v1/pro-top50-history?symbol=HACKUSDT'),env,now);
assert.equal(bad.status,503);
const k2='market-hub/universe/venue-history/v1/'+String(Math.floor((now-4*HOUR)/HOUR)*HOUR)+'.json';
const damaged=structuredClone(objects.get(k2));
damaged.markets.BTCUSDT[0].exchange='NotBinance';
objects.set(k2,damaged);
assert.equal((await top50VenueHistory(env,'BTCUSDT',now)).snapshots.length,9);
objects.delete(k2);
assert.equal((await top50VenueHistory(env,'BTCUSDT',now)).snapshots.length,9);
console.log('PASS 50-symbol R2 hourly provenance, 5-venue source isolation, no backfill');
