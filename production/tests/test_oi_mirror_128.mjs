import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const raw=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
 .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}');
const {default:worker}=await import('data:text/javascript;base64,'+Buffer.from(raw).toString('base64'));
const blobs=new Map(),writes=[];
const R2={async get(k){return blobs.has(k)?{json:async()=>JSON.parse(blobs.get(k)),text:async()=>blobs.get(k)}:null},
 async head(k){return blobs.has(k)?{size:blobs.get(k).length}:null},
 async put(k,v){blobs.set(k,String(v));writes.push(k)}};
const key='z'.repeat(64),env={MARKET_DATA:R2,LUMEX_AI_LAB_WORKER_TOKEN:key,
 AUTO_OI_MIRROR_FETCH:'true',AUTO_PUBLIC_PULSE_FETCH:'false',AUTO_RESEARCH:'false',
 AUTO_FETCH:'false',AUTO_AI:'false',AUTO_DERIVATIVES_FETCH:'false',AUTO_LEGACY_BACKFILL:'false',
 AUTO_WHALE_FETCH:'false',AUTO_LIVE_STREAM:'false'};
let blockBybit=false,blockBinance=false;const calls=[];
function fixture(url){
 const days=url.searchParams.get('intervalTime')==='4h'||url.searchParams.get('period')==='4h'||
  url.searchParams.get('interval')==='240'||url.searchParams.get('interval')==='4h'?30:7;
 const frame=(days===30?4:1)*3600000,now=Date.now(),end=Math.floor(now/frame)*frame;
 const opens=Array.from({length:200},(_,i)=>end-(200-i)*frame);
 return {oi:opens.map(t=>({timestamp:String(t+frame),openInterest:'30',sumOpenInterestValue:'1500000'})),
  klines:opens.map(t=>[String(t),'50000','50100','49900','50000','200'])};
}
const original=globalThis.fetch;
globalThis.fetch=async value=>{
 const u=new URL(value),binance=u.hostname==='fapi.binance.com';calls.push(u.href);
 if((binance&&blockBinance)||(!binance&&blockBybit))return new Response('{}',{status:503});
 const {oi,klines}=fixture(u);let json;
 if(!binance){
  if(u.pathname==='/v5/market/tickers')json={retCode:0,result:{list:[{symbol:u.searchParams.get('symbol'),markPrice:'50000',openInterestValue:'1500000'}]}};
  else if(u.pathname==='/v5/market/open-interest')json={retCode:0,result:{list:oi}};
  else if(u.pathname==='/v5/market/kline')json={retCode:0,result:{list:klines}};
  else throw Error('unexpected Bybit path '+u.pathname);
 }else{
  if(u.pathname.endsWith('/premiumIndex'))json={markPrice:'50000'};
  else if(u.pathname.endsWith('/openInterestHist'))json=oi;
  else if(u.pathname.endsWith('/klines'))json=klines;
  else throw Error('unexpected Binance path '+u.pathname);
 }
 return new Response(JSON.stringify(json),{status:200});
};
const scheduled=async()=>{const pending=[];await worker.scheduled({cron:'*/5 * * * *'},env,{waitUntil:x=>pending.push(x)});await Promise.all(pending)};
await scheduled();
const oiKeys=[...blobs.keys()].filter(x=>x.startsWith('market-hub/oi/v1/latest/'));
assert.equal(oiKeys.length,1,'one coin/frame per five-minute tick');
assert.equal(calls.length,3,'bounded 3 Bybit public endpoints');
const one=JSON.parse(blobs.get(oiKeys[0]));
assert.equal(one.schema,'lumex_oi_mirror_v1');assert.equal(one.exchange,'Bybit');
assert.equal(one.source_scope,'single_exchange_public_oi_only');
assert.equal(one.order_execution,false);assert.equal(one.merged_with_gate,false);
assert(one.history.length>=90||one.history.length>=48);
assert(one.history.at(-1).ts>one.history[0].ts);
assert(!writes.some(x=>/orders|live-ledger|legacy\/wp/.test(x)));
const bad=await worker.fetch(new Request('https://worker/market-hub/v1/oi-history?symbol='+one.pair+'&days='+one.days),env);
assert.equal(bad.status,401,'Bearer required');
const get=await worker.fetch(new Request('https://worker/market-hub/v1/oi-history?symbol='+one.pair+'&days='+one.days,{headers:{Authorization:'Bearer '+key}}),env);
assert.equal(get.status,200);assert.equal((await get.json()).history.length,200);
const invalid=await worker.fetch(new Request('https://worker/market-hub/v1/oi-history?symbol=FAKEUSDT&days=7',{headers:{Authorization:'Bearer '+key}}),env);
assert.equal(invalid.status,400);
const pre=await worker.fetch(new Request('https://worker/market-hub/v1/oi-preflight',{headers:{Authorization:'Bearer '+key}}),env);
const packet=await pre.json();assert.equal(packet.slots.length,8);assert.equal(packet.ok,false);
assert.equal(packet.slots.filter(x=>x.ok).length,1);
const stored=blobs.get(oiKeys[0]);blockBybit=true;await scheduled();
assert.equal(calls.length,9,'Bybit 503 then 3 Binance requests');
assert.equal(blobs.get(oiKeys[0]),stored,'archive consistent on repeated Cron');
let h=JSON.parse(blobs.get('market-hub/oi/v1/health.json'));
assert.equal(h.sources[one.coin+'-'+one.days].source,'Bybit','health source matches saved observation');
blockBinance=true;await scheduled();
assert.equal(blobs.get(oiKeys[0]),stored,'outage preserves good snapshot');
h=JSON.parse(blobs.get('market-hub/oi/v1/health.json'));
assert.equal(h.sources[one.coin+'-'+one.days].ok,false);
assert.equal((await (await worker.fetch(new Request('https://worker/market-hub/v1/health'),env)).json()).version,'1.2.10');
globalThis.fetch=original;
console.log('PASS 1.2.10 OI: source-matched history, bounded Binance fallback, 8-slot preflight, auth, R2 retry provenance, outage preservation');