import assert from 'node:assert/strict';
import {parseVenueBulk,matrix,collectVenueMatrix,serveVenueMatrix} from '../src/pro-venue-matrix.mjs';
import {normalizedFourHour,regimeFourHourFallback} from '../src/pro50-fourhour.mjs';
const now=Date.UTC(2026,10,21,4,0),symbol='BTCUSDT';
const universe={schema:'lumex_uid_top50_v1',generated_at_ms:now-60000,order_execution:false,items:[
{symbol,coin:'BTC',venue:'Bybit'},{symbol:'ETHUSDT',coin:'ETH',venue:'Bybit'}]};
const venueRaw={
 Bybit:{retCode:0,result:{list:[{symbol,markPrice:'85000',openInterestValue:'4000000000',fundingRate:'-0.0001'}]}},
 Gate:[{contract:'BTC_USDT',mark_price:'84997',open_interest_usd:'3600000000',funding_rate:'-0.00012'}],
 Binance:[{symbol,markPrice:'85001',lastFundingRate:'-0.00011'}],
 OKX:{code:'0',data:[{instId:'BTC-USDT-SWAP',oiUsd:'2000000000'}]},
 Bitget:{code:'00000',data:[{symbol,markPrice:'84999',fundingRate:'-0.00007'}]}
};
const d=matrix(universe,venueRaw,now);
assert.equal(d.ok,true);assert.equal(d.markets[symbol].length,5);
assert.deepEqual(d.venues,['Binance','Bybit','OKX','Bitget','Gate']);
assert.equal(d.markets[symbol][0].oi_usd,null); // Binance OI cannot be invented
assert.equal(d.markets[symbol][2].oi_usd,2000000000);
assert.equal(d.markets[symbol][3].funding_pct,-0.007);
assert.equal(d.markets.ETHUSDT.filter(x=>x.status==='unavailable').length,5);
assert.equal(parseVenueBulk('Gate',venueRaw.Gate,new Set([symbol]),now).size,1);
assert.equal(matrix({...universe,generated_at_ms:now-20*60000},venueRaw,now),null);
const store=new Map([['market-hub/universe/bybit-linear-top50-v1.json',universe]]);
const env={MARKET_DATA:{
 get:async k=>store.has(k)?{json:async()=>store.get(k)}:null,
 put:async(k,v)=>{store.set(k,JSON.parse(v))}
}};
const original=globalThis.fetch;
try{
 globalThis.fetch=async url=>{
  let raw=url.includes('bybit')?venueRaw.Bybit:url.includes('gateio')?venueRaw.Gate:
   url.includes('binance')?venueRaw.Binance:url.includes('okx')?venueRaw.OKX:venueRaw.Bitget;
  return {ok:true,headers:new Headers(),text:async()=>JSON.stringify(raw)};
 };
 const a=await collectVenueMatrix(env,now);
 assert.equal(a.ok,true);assert.equal(a.sources,5);
 const r=await serveVenueMatrix(new Request('https://worker/market-hub/v1/pro-top50-venues?symbol=BTCUSDT'),env,now);
 assert.equal(r.status,200);
 assert.equal((await r.json()).venues.length,5);
 assert.equal((await serveVenueMatrix(new Request('https://worker/?symbol=BTCUSDT'),env,now+16*60000)).status,503);
}finally{globalThis.fetch=original;}
const span=14400000,anchor=Math.floor(now/span)*span;
const candles=Array.from({length:240},(_,i)=>{const t=anchor-(240-i)*span;
 return {t:t/1000,o:'80000',h:'81000',l:'79000',c:'80500',v:'456'};});
assert.equal(normalizedFourHour('Gate',candles,now).length,200);
const missing=candles.map(x=>({...x}));missing.splice(190,1);
assert.equal(normalizedFourHour('Gate',missing,now).length,0);
const r2=new Map([['market-hub/universe/bybit-linear-top50-v1.json',universe]]);
const env4={MARKET_DATA:{get:async k=>r2.has(k)?{json:async()=>r2.get(k)}:null,put:async(k,v)=>r2.set(k,JSON.parse(v))}};
try{
 globalThis.fetch=async url=>({ok:true,headers:new Headers(),text:async()=>JSON.stringify(candles)});
 const data=await regimeFourHourFallback(env4,symbol,500,now);
 assert.equal(data.candles.length,200);
 assert.equal(data.feed_mode,'verified_public_exchange_4h_closed_candles');
 await assert.rejects(regimeFourHourFallback(env4,'UNLISTEDUSDT',500,now));
}finally{globalThis.fetch=original;}
console.log('PASS top50 5-venue source-isolated matrix and 4h exact-candle recovery');
