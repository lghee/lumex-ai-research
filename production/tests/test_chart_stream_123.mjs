process.on('uncaughtException',error=>{console.error('CHART_TEST_DIAGNOSTIC',error.name,String(error.message),String(error.stack||'').slice(-600));process.exit(1)});
process.on('unhandledRejection',error=>{console.error('CHART_TEST_REJECTION',String(error?.message||error));process.exit(1)});
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
 .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}');
const {decodeGateCandles,MarketLiveCollector,MarketEventHub,default:worker}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const now=Date.now(),opening=Math.floor(now/900000)*900000;
const row={n:'15m_BTC_USDT',t:opening/1000,o:'100',h:'110',l:'99',c:'105',v:'55'};
const valid=decodeGateCandles({channel:'futures.candlesticks',event:'update',time_ms:now,result:[row]});
assert.equal(valid.length,1);assert.equal(valid[0].confirmed,false);assert.equal(valid[0].interval_min,15);
assert.equal(valid[0].open_ms,opening);assert.equal(valid[0].c,105);
assert.equal(decodeGateCandles({channel:'futures.candlesticks',event:'update',time_ms:now,result:[{...row,c:'500'}]}).length,0);
assert.equal(decodeGateCandles({channel:'futures.candlesticks',event:'update',time_ms:now,result:[{...row,n:'bad_USDT'}]}).length,0);
assert.equal(decodeGateCandles({channel:'futures.tickers',event:'update',result:[row]}).length,0);
const captured=[];const env={MARKET_EVENT_HUB:{getByName:s=>({fetch:async req=>{
 const body=await req.json();captured.push({symbol:s,previews:body.previews});
 return new Response(JSON.stringify({ok:true,broadcast:body.previews.length}),{status:200});
}})}};
const collector=new MarketLiveCollector({storage:{getAlarm:async()=>null,setAlarm:async()=>{}}},env);
await collector.publishCandles(valid);
assert.equal(captured.length,1);assert.equal(captured[0].symbol,'BTCUSDT');
assert.equal(collector.safeStatus().preview_sent,1);
await collector.publishCandles(valid);
assert.equal(captured.length,1,'identical open candle must throttle broadcast');
const messages=[],sqlCalls=[];
const hubContext={
 storage:{sql:{exec(q,...args){sqlCalls.push(q);return {toArray:()=>[]}}}},
 getWebSockets(){return [{send:m=>messages.push(JSON.parse(m))}]}
};
const hub=new MarketEventHub(hubContext,{});
const result=await hub.fetch(new Request('https://hub/publish',{method:'POST',
 headers:{'content-type':'application/json'},
 body:JSON.stringify({symbol:'BTCUSDT',previews:valid})}));
assert.equal(result.status,200);
assert.equal((await result.json()).stored,false);
assert.equal(messages.length,1);
assert.equal(messages[0].type,'provisional_kline');
assert.equal(messages[0].data.confirmed,false);
assert(!sqlCalls.some(q=>/INSERT|UPDATE/.test(q)),'partial candles must never enter SQL or R2');
const fail=await hub.fetch(new Request('https://hub/publish',{method:'POST',
headers:{'content-type':'application/json'},body:JSON.stringify({symbol:'ETHUSDT',previews:valid})}));
assert.equal((await fail.json()).broadcast,0);
const health=await (await worker.fetch(new Request('https://worker/market-hub/v1/health'),{})).json();
assert.equal(health.version,'1.2.3');
assert(health.capabilities.includes('provisional_gate_futures_candles'));
console.log('PASS 1.2.3: Gate 5/15/60/240/1D provisional parsing, bounded fanout, never stored as verified R2 bars');
