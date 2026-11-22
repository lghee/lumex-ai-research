import assert from 'node:assert/strict';
import {readBinance,readBybit,readOKX,readBitget,readGate,buildExchangeComparison} from '../src/exchange-compare.mjs';
import {parseVenueBulk,matrix} from '../src/pro-venue-matrix.mjs';
const now=1795370000000;
const res=(body,status=200)=>({ok:status===200,status,text:async()=>JSON.stringify(body)});
function mock(map){return async url=>{for(const [k,v] of Object.entries(map))if(url.includes(k))return typeof v==='function'?v():res(v);return res({},404);};}
// Binance mark price from premiumIndex
let r=await readBinance('BTC',mock({premiumIndex:{markPrice:'98420.5',lastFundingRate:'0.0001',time:now}}),now);
assert.equal(r.price.value,98420.5);assert.equal(r.price.source,'binance_premium_index_mark_price');
// Binance geo-block: no price, reason recorded, never zero
r=await readBinance('BTC',mock({premiumIndex:()=>res({msg:'Service unavailable from a restricted location'},200)}),now);
assert.equal(r.price,null);assert.ok(r.errors.some(e=>e.startsWith('funding:provider_region_restricted')));
assert.ok(r.errors.includes('price:missing_or_invalid'));
// Bybit mark + 24h change
r=await readBybit('BTC',mock({tickers:{retCode:0,result:{list:[{symbol:'BTCUSDT',markPrice:'98421',price24hPcnt:'0.0182',openInterestValue:'1000',fundingRate:'0.0001'}]}}}),now);
assert.equal(r.price.value,98421);assert.equal(r.price.change_24h_pct,1.82);
// OKX ticker from sodUtc0
r=await readOKX('BTC',mock({'market/ticker':{code:'0',data:[{instId:'BTC-USDT-SWAP',last:'101',sodUtc0:'100',ts:String(now)}]}}),now);
assert.equal(r.price.value,101);assert.equal(r.price.change_24h_pct,1);
// Bitget v2 ticker
r=await readBitget('BTC',mock({'v2/mix/market/ticker':{code:'00000',data:[{symbol:'BTCUSDT',markPrice:'98415',change24h:'-0.011',ts:String(now)}]}}),now);
assert.equal(r.price.value,98415);assert.equal(r.price.change_24h_pct,-1.1);
// Gate change_percentage is already percent
r=await readGate('BTC',mock({tickers:[{contract:'BTC_USDT',mark_price:'98419',change_percentage:'0.94',funding_rate:'0.0001'}]}),now);
assert.equal(r.price.value,98419);assert.equal(r.price.change_24h_pct,0.94);
// stale price dropped
r=await readOKX('BTC',mock({'market/ticker':{code:'0',data:[{instId:'BTC-USDT-SWAP',last:'101',ts:String(now-40*60000)}]}}),now);
assert.equal(r.price,null);assert.ok(r.errors.includes('price:source_stale'));
// price never changes status coverage
const rows=await Promise.all([readBinance,readBybit,readOKX,readBitget,readGate].map(f=>f('BTC',mock({}),now)));
const snap=buildExchangeComparison('BTC',rows,now);assert.equal(snap.coverage.price,0);assert.ok(rows.every(x=>x.status==='unavailable'));
// venue matrix OKX price from mark-price bulk
const allow=new Set(['BTCUSDT']);
const okx=parseVenueBulk('OKX',{code:'0',data:[{instId:'BTC-USDT-SWAP',oiUsd:'5e9'}]},allow,now,{code:'0',data:[{instId:'BTC-USDT-SWAP',markPx:'98416'}]});
assert.equal(okx.get('BTCUSDT').mark_price,98416);assert.equal(okx.get('BTCUSDT').oi_usd,5e9);
const okxOnlyMark=parseVenueBulk('OKX',null,allow,now,{code:'0',data:[{instId:'BTC-USDT-SWAP',markPx:'98416'}]});
assert.equal(okxOnlyMark.get('BTCUSDT').mark_price,98416);assert.equal(okxOnlyMark.get('BTCUSDT').oi_usd,null);
assert.equal(parseVenueBulk('OKX',null,allow,now,null),null);
const m=matrix({schema:'lumex_uid_top50_v1',generated_at_ms:now,items:[{symbol:'BTCUSDT'}]},{OKX:null,OKX_MARK:{code:'0',data:[{instId:'BTC-USDT-SWAP',markPx:'1'}]}},now);
assert.equal(m.markets.BTCUSDT[2].mark_price,1);assert.equal(m.observed_sources.OKX,true);assert.equal(m.venues.length,5);
console.log('PASS venue-own prices for 5 exchanges, OKX mark-price bulk, stale/geo-block never fabricated, status unchanged');
