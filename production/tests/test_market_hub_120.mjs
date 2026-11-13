import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const raw=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
 .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {}');
const handler=(await import('data:text/javascript;base64,'+Buffer.from(raw).toString('base64'))).default;
const step=15*60000,now=Date.now(),last=Math.floor(now/step)*step-step,rows=800;
const lines=['timestamp,open,high,low,close,volume'];
for(let n=rows-1;n>=0;n--){const ts=last-n*step;const px=100+(rows-n)*0.01;lines.push([ts,px,px+1,px-1,px,10].join(','));}
const csv=lines.join('\n')+'\n',key='market/BTCUSDT_15.csv';
const mock={
  async head(k){return k===key?{size:csv.length,customMetadata:{schema:'ohlcv_v2',quality:'verified',rows:String(rows),lastCandleMs:String(last),source:'gateio_usdt_perpetual'}}:null},
  async get(k){return k===key?{text:async()=>csv}:null}
};
const env={MARKET_DATA:mock,LUMEX_AI_LAB_WORKER_TOKEN:'a'.repeat(64),
 LUMEX_CONTAINER_KEY:'b'.repeat(64),AUTO_FETCH:'false',AUTO_RESEARCH:'false',AUTO_AI:'false'};
const req=(url,secret)=>new Request('https://worker'+url,{headers:secret?{authorization:'Bearer '+secret}:{}});
const health=await (await handler.fetch(req('/market-hub/v1/health'),env)).json();
assert.equal(health.version,'1.2.5');assert.equal(health.live_exchange_ingestor,'disabled');
assert.equal((await handler.fetch(req('/market-hub/v1/candles?symbol=BTCUSDT&interval=15'),env)).status,401);
const result=await handler.fetch(req('/market-hub/v1/candles?symbol=BTCUSDT&interval=15',env.LUMEX_AI_LAB_WORKER_TOKEN),env);
assert.equal(result.status,200);const candles=await result.json();
assert.equal(candles.candles.length,500);assert.equal(candles.symbol,'BTCUSDT');
assert.equal(candles.feed_mode,'cloudflare_r2_verified_closed_candles');assert(candles.candles.every((c,i,a)=>i===0||c.t>a[i-1].t));
assert.equal(candles.orders_enabled,false);assert.equal(candles.last_candle_open_ms,last);
const missing=await handler.fetch(req('/market-hub/v1/candles?symbol=ETHUSDT&interval=15',env.LUMEX_AI_LAB_WORKER_TOKEN),env);
assert.equal(missing.status,503);assert.equal((await missing.json()).error,'market_not_verified');
const radar=await (await handler.fetch(req('/market-hub/v1/radar',env.LUMEX_AI_LAB_WORKER_TOKEN),env)).json();
assert.equal(radar.items.length,4);assert.equal(radar.items[0]['15m'].status,'ok');assert.equal(radar.market_realtime,false);
assert.equal((await handler.fetch(req('/market-hub/v1/ws?symbol=BTCUSDT&uid=1&exp=1999999999&sig='+'0'.repeat(64)),env)).status,401);
const illegal=new Request('https://worker/market-hub/v1/ingest?symbol=BTCUSDT',{method:'POST',
  headers:{'content-type':'application/json',authorization:'Bearer bad-key'},body:'{"events":[]}'});
assert.equal((await handler.fetch(illegal,env)).status,401);
console.log('PASS 1.2.0 market hub: verified R2 candles, auth, closed-bar labeling, radar, missing data and ingestion guard');
