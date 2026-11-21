import assert from 'node:assert/strict';
import {normalizedFourHour,regimeFourHourFallback} from '../src/regime-fourhour-fallback.mjs';
const frame=14400000,now=Date.now(),anchor=Math.floor(now/frame)*frame;
const data=[];
for(let i=0;i<240;i++){
  const t=anchor-(240-i)*frame,p=65000+i*7;
  data.push({t:t/1000,o:String(p),h:String(p+40),l:String(p-50),c:String(p+10),v:'222'});
}
assert.equal(normalizedFourHour('Gate',data,now).length,200);
assert.equal(normalizedFourHour('Gate',data,now).at(-1).t+frame,anchor);
let bad=data.map(x=>({...x}));bad.splice(190,1);
assert.equal(normalizedFourHour('Gate',bad,now).length,0);
bad=data.map(x=>({...x}));bad[30].h='1';
assert.equal(normalizedFourHour('Gate',bad,now).length,0);
const bybit={retCode:0,result:{list:data.map(x=>[String(x.t*1000),x.o,x.h,x.l,x.c,x.v]).reverse()}};
assert.equal(normalizedFourHour('Bybit',bybit,now).length,200);
assert.equal(normalizedFourHour('Bybit',{retCode:10001,result:{list:bybit.result.list}},now).length,0);
assert.equal(normalizedFourHour('Gate',data,now+10*3600000).length,0);
const objects=new Map();let count=0;
const env={MARKET_DATA:{get:async k=>objects.has(k)?{json:async()=>JSON.parse(objects.get(k))}:null,put:async(k,v)=>{objects.set(k,v)}}};
const original=globalThis.fetch;
try{
  globalThis.fetch=async()=>{count++;return {ok:true,headers:new Headers(),text:async()=>JSON.stringify(data)}};
  const result=await regimeFourHourFallback(env,'BTCUSDT',500,now);
  assert.equal(result.data_quality,'verified');
  assert.equal(result.feed_mode,'verified_public_exchange_4h_closed_candles');
  assert.equal(result.candles.length,200);
  assert.equal(result.source_type,'official_public_fallback');
  assert.equal(result.orders_enabled,false);
  assert.equal(count,1);
  const cached=await regimeFourHourFallback(env,'BTCUSDT',500,now+30000);
  assert.equal(cached.candles.length,200);
  assert.equal(count,1);
  await assert.rejects(regimeFourHourFallback(env,'DOGEUSDT',500,now));
  console.log('PASS Worker 4H source-regression: gap/stale rejected; R2 readback and cache verified');
}finally{globalThis.fetch=original;}
