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
let blockBybit=false,blockBinance=false;const calls=[];let T=Date.UTC(2026,10,22,2,0,0);const realNow=Date.now;Date.now=()=>T;
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
// Four consecutive five-minute Crons must refresh every coin/frame (8 combinations).
const sampled=new Map();
for(let i=0;i<4;i++){await scheduled();
  for(const k of blobs.keys())if(k.startsWith('market-hub/oi/v1/latest/'))sampled.set(k,JSON.parse(blobs.get(k)).sample_unix);
  T+=300000;}
assert.equal(sampled.size,8,'all 4 coins x 2 frames refreshed within 4 Crons (20 min)');
// Steady state: no combination is ever older than 20 minutes.
for(let i=0;i<12;i++){await scheduled();T+=300000;
  const now=Math.floor((T-300000)/1000);
  for(const k of blobs.keys())if(k.startsWith('market-hub/oi/v1/latest/'))assert(now-JSON.parse(blobs.get(k)).sample_unix<=20*60,k+' stale');}
Date.now=realNow;globalThis.fetch=original;
console.log('PASS OI cadence 1.3.2: 8 coin/frame combinations each refreshed within 20 minutes');
