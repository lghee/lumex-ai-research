import assert from 'node:assert/strict';
import {normalizeTop50,checkTop50,collectTop50,serveTop50} from '../src/pro-top50.mjs';
const now=Date.UTC(2026,10,21,3,30);
const list=Array.from({length:65},(_,i)=>({symbol:'COIN'+String(i+1).padStart(2,'0')+'USDT',
 lastPrice:'3.4',turnover24h:String(900000000-i*1000000),price24hPcnt:String(i%2?.02:-.01),
 openInterestValue:'19000000',fundingRate:'0.00015',markPrice:'3.4',
 highPrice24h:'3.9',lowPrice24h:'3.1'}));
const body={retCode:0,result:{list}};
const data=normalizeTop50(body,now);
assert.equal(data.count,50);assert.equal(data.items[0].symbol,'COIN01USDT');
assert.equal(data.items[49].symbol,'COIN50USDT');assert.equal(data.items[0].funding_pct,.015);
assert.equal(checkTop50(data,now),true);
assert.equal(checkTop50({...data,generated_at_ms:now-16*60000},now),false);
assert.equal(checkTop50({...data,items:data.items.map((x,i)=>i===2?{...x,symbol:data.items[0].symbol}:x)},now),false);
assert.equal(normalizeTop50({...body,retCode:10005},now),null);
const cache=new Map();
const env={MARKET_DATA:{put:async(k,v)=>{cache.set(k,v)},
 get:async k=>cache.has(k)?{json:async()=>JSON.parse(cache.get(k))}:null}};
const fetchImpl=async()=>({ok:true,headers:new Headers(),text:async()=>JSON.stringify(body)});
assert.equal((await collectTop50(env,{now,fetchImpl})).verified_r2,true);
const served=await serveTop50(env,now);
assert.equal(served.status,200);
assert.equal((await served.json()).items.length,50);
assert.equal((await serveTop50(env,now+16*60000)).status,503);
const fails=await collectTop50(env,{now,fetchImpl:async()=>({ok:false,status:403})});
assert.equal(fails.ok,false);assert.equal(fails.reason,'bybit_status_403');
console.log('PASS UID/PRO top50 ranking, field validation, R2 readback, stale denial');
