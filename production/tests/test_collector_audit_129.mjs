import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const raw=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
 .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}');
const {default:worker}=await import('data:text/javascript;base64,'+Buffer.from(raw).toString('base64'));
const token='q'.repeat(64),calls=[];
let missing='';const symbols=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT'];
const env={LUMEX_AI_LAB_WORKER_TOKEN:token,MARKET_EVENT_HUB:{
 getByName(symbol){assert(symbols.includes(symbol));return {async fetch(request){
   const url=new URL(request.url);calls.push({symbol,path:url.pathname,window:url.searchParams.get('window')});
   if(symbol===missing)return new Response(JSON.stringify({error:'missing'}),{status:503});
   return new Response(JSON.stringify({ok:true,symbol,window:'24h',
    scope:'observed_public_events_only',market_total_estimate:false,
    by_source:[
      {kind:'liquidation',source:'bybit',side:'long',events:7},
      {kind:'liquidation',source:'bybit',side:'short',events:3},
      {kind:'liquidation',source:'binance',side:'long',events:99},
      {kind:'whale_transfer',source:'blockstream',side:'in',events:2},
      {kind:'whale_transfer',source:'blockstream',side:'out',events:1}],
    rollup:{up_to_date:true,pending_hot_events:0}}),{status:200});
 }};}}};
const url='https://worker/market-hub/v1/collector-audit';
const blocked=await worker.fetch(new Request(url),env);assert.equal(blocked.status,401);
assert.equal(calls.length,0,'unauthorized cannot query durable object');
const allowed=await worker.fetch(new Request(url,{headers:{Authorization:'Bearer '+token}}),env);
assert.equal(allowed.status,200);
const body=await allowed.json();
assert.equal(body.schema,'lumex_collector_audit_v1');
assert.equal(body.ok,true);assert.equal(body.safe_to_disable_wordpress_crons,false);
assert.equal(body.archive_merged,false);assert.equal(body.observed_only,true);
assert.equal(body.items.length,4);assert.equal(calls.length,4,'four bounded queries');
assert(body.items.every(x=>x.bybit_liquidations_24h===10),'exclude unrelated Binance');
assert.equal(body.items[0].btc_watchlist_flows_24h,3);
assert(body.items.slice(1).every(x=>x.btc_watchlist_flows_24h===0));
assert(calls.every(x=>x.path==='/insights'&&x.window==='24h'));
missing='ETHUSDT';const partial=await (await worker.fetch(new Request(url,{headers:{Authorization:'Bearer '+token}}),env)).json();
assert.equal(partial.ok,false);
assert.equal(partial.items.find(x=>x.symbol==='ETHUSDT').ok,false);
assert.equal(partial.safe_to_disable_wordpress_crons,false);
const health=await (await worker.fetch(new Request('https://worker/market-hub/v1/health'),env)).json();
assert.equal(health.version,'1.2.12');
console.log('PASS 1.2.12 audit: Bearer gate, four bounded source-filtered 24h rollups, explicit non-merge, missing-symbol refusal');