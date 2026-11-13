import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const raw=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
  .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env} }');
const {summarizeObservedRollups,MarketEventHub,default:worker}=
  await import('data:text/javascript;base64,'+Buffer.from(raw).toString('base64'));
const now=Date.now(),bucket=Math.floor((now-1800000)/3600000)*3600000;
const rows=[
 {bucket,kind:'liquidation',source:'bybit',side:'buy',events:3,quantity:1.25,first_ts:bucket+100,last_ts:bucket+200},
 {bucket,kind:'liquidation',source:'bybit',side:'sell',events:2,quantity:0.5,first_ts:bucket+300,last_ts:bucket+400},
 {bucket,kind:'whale_transfer',source:'blockstream',side:'in',events:4,quantity:7.5,first_ts:bucket+500,last_ts:bucket+600},
 {bucket,kind:'whale_transfer',source:'blockstream',side:'out',events:1,quantity:2.25,first_ts:bucket+700,last_ts:bucket+800},
 {bucket,kind:'trade',source:'gateio',side:'buy',events:9,quantity:12,first_ts:bucket+900,last_ts:bucket+1000},
 {bucket:bucket-8*86400000,kind:'trade',source:'gateio',side:'sell',events:100,quantity:100,
    first_ts:bucket-8*86400000,last_ts:bucket-8*86400000}
];
const summary=summarizeObservedRollups(rows,'BTCUSDT','24h',now);
assert.equal(summary.observed_events,19);
assert.equal(summary.captures.liquidations.events,5);
assert.equal(summary.captures.btc_address_net.in_btc,7.5);
assert.equal(summary.captures.btc_address_net.out_btc,2.25);
assert.equal(summary.captures.btc_address_net.net_btc,5.25);
assert.equal(summary.captures.trades.events,9);
assert.equal(summary.market_total_estimate,false);
assert.equal(summary.hourly.length,1);
assert.equal(summary.captures.liquidations.price_type,'bankruptcy_price');
assert.throws(()=>summarizeObservedRollups([],'BTCUSDT','all',now),/unsupported_insight_window/);
const sqlLog=[];let pending=[];
const sql={exec(q,...params){
 sqlLog.push({q,params});
 if(q.startsWith('PRAGMA table_info'))return {toArray:()=>[{name:'rollup_done'}]};
 if(q.startsWith('SELECT bucket,kind,source'))return {toArray:()=>rows};
 if(q.startsWith('SELECT COUNT(*) AS n'))return {toArray:()=>[{n:pending.length}]};
 if(q.startsWith('SELECT id,ts,kind,source,payload FROM hub_events WHERE rollup_done=0'))return {toArray:()=>pending.slice()};
 if(q.startsWith('UPDATE hub_events SET rollup_done=1')){pending=pending.filter(r=>r.id!==params[0]);return {toArray:()=>[]};}
 return {toArray:()=>[]};
}};
let syncCalls=0;
const hub=new MarketEventHub({storage:{sql,transactionSync(fn){syncCalls++;fn()}},getWebSockets:()=>[]},{});
const unauth=await worker.fetch(new Request('https://market/market-hub/v1/insights?symbol=BTCUSDT&window=24h'),
  {MARKET_EVENT_HUB:{getByName:()=>hub},LUMEX_AI_LAB_WORKER_TOKEN:'a'.repeat(64)});
assert.equal(unauth.status,401);
const env={MARKET_EVENT_HUB:{getByName:name=>{assert.equal(name,'BTCUSDT');return hub}},
  LUMEX_AI_LAB_WORKER_TOKEN:'a'.repeat(64)};
const authorized=new Request('https://market/market-hub/v1/insights?symbol=BTCUSDT&window=24h',
 {headers:{authorization:'Bearer '+env.LUMEX_AI_LAB_WORKER_TOKEN}});
const routed=await worker.fetch(authorized,env);
assert.equal(routed.status,200);const j=await routed.json();
assert.equal(j.captures.liquidations.events,5);
assert.equal(j.rollup.up_to_date,true);assert.equal(j.rollup.older_r2_archive_reimported,false);
// The same WordPress short-lived PRO HMAC ticket used for WebSockets can
// authorize read-only Cloudflare insights without any WordPress SQL polling.
const exp=Math.floor(Date.now()/1000)+70,uid='1234',signedText='mh1:'+uid+':BTCUSDT:'+exp;
const signingKey=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.LUMEX_AI_LAB_WORKER_TOKEN),
 {name:'HMAC',hash:'SHA-256'},false,['sign']);
const sig=Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',signingKey,new TextEncoder().encode(signedText))),
 b=>b.toString(16).padStart(2,'0')).join('');
const direct=await worker.fetch(new Request('https://market/market-hub/v1/insights?symbol=BTCUSDT&window=24h&uid='+uid+'&exp='+exp+'&sig='+sig),env);
assert.equal(direct.status,200);
assert.equal(direct.headers.get('access-control-allow-origin'),'https://lumexbot.com');
assert.equal((await direct.json()).captures.btc_address_net.net_btc,5.25);
const wrongSymbol=await worker.fetch(new Request('https://market/market-hub/v1/insights?symbol=ETHUSDT&window=24h&uid='+uid+'&exp='+exp+'&sig='+sig),env);
assert.equal(wrongSymbol.status,401);
const oldToken=await worker.fetch(new Request('https://market/market-hub/v1/insights?symbol=BTCUSDT&window=24h&uid='+uid+'&exp='+(exp-3600)+'&sig='+sig),env);
assert.equal(oldToken.status,401);
const unsupported=await worker.fetch(new Request('https://market/market-hub/v1/insights?symbol=BTCUSDT&window=365d',
 {headers:{authorization:'Bearer '+env.LUMEX_AI_LAB_WORKER_TOKEN}}),env);
assert.equal(unsupported.status,400);
// Previously accepted events are processed in bounded batches and cannot count twice.
const observed={id:'b'.repeat(40),kind:'whale_transfer',source:'blockstream',ts:bucket+1000,
 payload:JSON.stringify({quantity:2,side:'out'})};
pending=[observed];
assert.equal(hub.rollupPending(),false);
assert.equal(pending.length,0);
assert.equal(hub.rollupPending(),false);
assert.equal(syncCalls,1);
const writes=sqlLog.filter(x=>x.q.startsWith('INSERT INTO hub_hourly'));
assert.equal(writes.length,1);
assert.equal(writes[0].params[5],2);
assert(!sqlLog.some(x=>x.q.includes('DELETE FROM hub_hourly')));
console.log('PASS 1.2.4: observed-only hourly liquidation/BTC whale metrics, window guard, authenticated proxy, idempotent bounded SQL rollups');
