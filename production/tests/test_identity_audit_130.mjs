import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const raw=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
 .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}');
const {MarketEventHub,default:worker}=await import('data:text/javascript;base64,'+Buffer.from(raw).toString('base64'));
const token='a'.repeat(64),coins=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT'],now=Date.now();
let failed='',reads=0;
const hubs=new Map(),env={LUMEX_AI_LAB_WORKER_TOKEN:token,MARKET_EVENT_HUB:{getByName(coin){
 assert(coins.includes(coin));if(!hubs.has(coin)){
  const sql={exec(query,...args){
   if(query.startsWith('PRAGMA'))return {toArray:()=>[{name:'rollup_done'}]};
   if(query.startsWith('SELECT payload')){
    reads++;const isLiq=query.includes("kind='liquidation'"),size=isLiq?101:2;
    return {toArray:()=>Array.from({length:size},(_,i)=>({payload:JSON.stringify(isLiq?
     {id:'bybit:liq:'+coin+':'+i.toString(16).padStart(32,'0'),ts:now-90000-i,
      price:50000+i,quantity:1.125,position_side:'long',price_type:'bankruptcy_price',capture:'public_stream'}:
     {txhash:(i+1).toString(16).padStart(64,'0'),ts:now-90000-i,side:i?'out':'in',quantity:1.5})}))};
   }
   return {toArray:()=>[]};
  }};
  hubs.set(coin,new MarketEventHub({storage:{sql}},env));
 }
 return {fetch(request){return coin===failed?
   Promise.resolve(new Response('{}',{status:503})):
   hubs.get(coin).fetch(request instanceof Request?request:new Request(request))}};
}}};
const url='https://worker/market-hub/v1/identity-audit';
assert.equal((await worker.fetch(new Request(url),env)).status,401);
assert.equal(reads,0,'without token no DO reads');
const response=await worker.fetch(new Request(url,{headers:{Authorization:'Bearer '+token}}),env);
assert.equal(response.status,200);
const data=await response.json();
assert.equal(data.schema,'lumex_identity_audit_v1');assert.equal(data.ok,true);
assert.equal(data.archive_merged,false);assert.equal(data.safe_to_disable_wordpress_crons,false);
assert.equal(data.native_bybit_event_id_available,false);assert.equal(data.items.length,4);
assert(data.items.every(x=>x.liquidations.length===100&&x.liquidations_truncated));
assert(data.items.every(x=>x.liquidations.every(e=>e.id.startsWith('bybit:liq:'+x.symbol+':'))));
assert.equal(data.items[0].whales.length,2);
assert(data.items.slice(1).every(x=>x.whales.length===0));
assert.equal(reads,5,'4 Bybit + 1 BTC chain indexed reads');
assert(!JSON.stringify(data).includes('watched_address'),'private watchlist raw address excluded');
failed='ETHUSDT';
const partial=await (await worker.fetch(new Request(url,{headers:{Authorization:'Bearer '+token}}),env)).json();
assert.equal(partial.ok,false);assert.equal(partial.items.find(x=>x.symbol==='ETHUSDT').ok,false);
assert.equal(partial.safe_to_disable_wordpress_crons,false);
const health=await (await worker.fetch(new Request('https://worker/market-hub/v1/health'),env)).json();
assert.equal(health.version,'1.2.12');
console.log('PASS 1.2.12: Bearer, four bounded public identity samples plus BTC txid, 100-cap, fail closed, no merge');
