import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
 .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {}');
const {parseGateTicker,parseGateOpenInterest,default:worker}=
 await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const now=Date.now(),time=Math.floor(now/1000),contract='BTC_USDT';
const ticker={contract,last:'65000',mark_price:'64990',index_price:'64980',
 funding_rate:'0.00012',funding_rate_indicative:'0.00013',change_percentage:'1.50',
 volume_24h_quote:'12340000'};
const price=parseGateTicker([ticker],'BTCUSDT');
assert.equal(price.funding_rate_pct,0.012);
assert.equal(price.turnover_24h_usdt,12340000);
assert.equal(price.mark_price,64990);
assert.equal(parseGateTicker([{...ticker,contract:'ETH_USDT'}],'BTCUSDT'),null);
assert.equal(parseGateTicker([{...ticker,mark_price:'bad'}],'BTCUSDT'),null);
const openInterest=parseGateOpenInterest([{time,open_interest:'5000',open_interest_usd:'123456.75'}],now);
assert.equal(openInterest.open_interest_usdt,123456.75);
assert.equal(openInterest.contracts,5000);
assert.equal(parseGateOpenInterest([{time:time-2000,open_interest:'10',open_interest_usd:'999'}],now),null);
assert.equal(parseGateOpenInterest([{time,open_interest:'10',open_interest_usd:null}],now),null);
const storage=new Map(),r2={
  async get(key){return storage.has(key)?{json:async()=>JSON.parse(storage.get(key))}:null},
  async put(key,value){storage.set(key,String(value));return {}}
};
const env={MARKET_DATA:r2,LUMEX_AI_LAB_WORKER_TOKEN:'a'.repeat(64),AUTO_DERIVATIVES_FETCH:'true',
 AUTO_RESEARCH:'false',AUTO_FETCH:'false',AUTO_AI:'false'};
const original=globalThis.fetch;let callCount=0;
globalThis.fetch=async (url)=>{
 const u=new URL(url);assert(['api.gateio.ws','fx-api.gateio.ws'].includes(u.hostname));
 callCount++;
 const c=u.searchParams.get('contract')||(u.pathname.match(/contracts\/([^/]+)$/)||[])[1];
 if(c==='SOL_USDT')return new Response(JSON.stringify([{contract:'SOL_USDT',last:'bad'}]),{status:200});
 if(u.pathname.endsWith('/tickers'))return new Response(JSON.stringify([{
   ...ticker,contract:c||contract}]),{status:200});
 if(u.pathname.endsWith('/contract_stats'))return new Response(JSON.stringify([
   {time,open_interest:'5000',open_interest_usd:'123456.75'}
 ]),{status:200});
 if(u.pathname.includes('/contracts/'))return new Response(JSON.stringify({
   name:c,funding_interval:28800,funding_next_apply:time+7200
 }),{status:200});
 throw Error('test_unknown_endpoint');
};
const wait=[];
await worker.scheduled({cron:'*/5 * * * *'},env,{waitUntil:p=>wait.push(p)});
await Promise.all(wait);
const status=JSON.parse(storage.get('market-hub/derivatives/v1/status.json'));
assert.equal(status.items.length,4);
assert.equal(status.items.find(x=>x.symbol==='SOLUSDT').ok,false);
assert(status.items.find(x=>x.symbol==='BTCUSDT').ok);
assert(!storage.has('market-hub/derivatives/v1/latest/SOLUSDT.json'));
const latest=JSON.parse(storage.get('market-hub/derivatives/v1/latest/BTCUSDT.json'));
assert.equal(latest.quality,'observed_public_snapshot');
assert.equal(latest.price.funding_rate_pct,0.012);
assert.equal(latest.open_interest.open_interest_usdt,123456.75);
assert.equal(latest.funding_schedule.interval_seconds,28800);
assert.equal(latest.scope,'single_public_exchange_not_global');
assert.equal(latest.order_execution,false);
const date=new Date(latest.snapshot_ms).toISOString().slice(0,10).replaceAll('-','');
assert(storage.has('market-hub/derivatives/v1/daily/BTCUSDT/'+date+'.json'));
const unauth=await worker.fetch(new Request('https://worker/market-hub/v1/derivatives?symbol=BTCUSDT'),env);
assert.equal(unauth.status,401);
const req=(path)=>new Request('https://worker'+path,{headers:{authorization:'Bearer '+env.LUMEX_AI_LAB_WORKER_TOKEN}});
const read=await worker.fetch(req('/market-hub/v1/derivatives?symbol=BTCUSDT'),env);
assert.equal(read.status,200);assert.equal(read.headers.get('access-control-allow-origin'),'https://lumexbot.com');
const item=await read.json();assert.equal(item.stale,false);assert.equal(item.price.turnover_24h_usdt,12340000);
const historical=await worker.fetch(req('/market-hub/v1/derivatives-history?symbol=BTCUSDT&window=24h'),env);
assert.equal(historical.status,200);
const points=await historical.json();assert(points.points.length>0);assert.equal(points.missing_intervals_not_filled,true);
const invalid=await worker.fetch(req('/market-hub/v1/derivatives-history?symbol=BTCUSDT&window=365d'),env);
assert.equal(invalid.status,400);
const healthy=await worker.fetch(new Request('https://worker/market-hub/v1/derivatives-health'),env);
assert.equal((await healthy.json()).report.items.length,4);
// Ticket used by PRO browser must authenticate only the exact symbol and expire.
const uid='99',exp=Math.floor(Date.now()/1000)+60;
const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.LUMEX_AI_LAB_WORKER_TOKEN),
 {name:'HMAC',hash:'SHA-256'},false,['sign']);
const signed='mh1:'+uid+':BTCUSDT:'+exp;
const sig=Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(signed))),
 b=>b.toString(16).padStart(2,'0')).join('');
const viaTicket=await worker.fetch(new Request('https://worker/market-hub/v1/derivatives?symbol=BTCUSDT&uid='+uid+'&exp='+exp+'&sig='+sig),env);
assert.equal(viaTicket.status,200);
const wrongSymbol=await worker.fetch(new Request('https://worker/market-hub/v1/derivatives?symbol=ETHUSDT&uid='+uid+'&exp='+exp+'&sig='+sig),env);
assert.equal(wrongSymbol.status,401);
globalThis.fetch=original;
console.log('PASS 1.2.5: Gate funding and OI parsing, stale statistics, R2 daily/last snapshot, partial failures, secured PRO history, no orders');
