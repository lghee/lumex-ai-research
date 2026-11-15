import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
 .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}');
const {MarketLiveCollector,probeBinanceContainerEgress,default:worker}=
 await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const now=Date.now(),ctx={storage:{},waitUntil(){}}; 
const env={AUTO_LIVE_STREAM:'true',AUTO_BINANCE_LIQUIDATIONS:'true'};
const collector=new MarketLiveCollector(ctx,env);
collector.disconnected('binance','upgrade_http_403');
assert(collector.retryAt.binance-now>=1790000,'403 must throttle for ~30 minutes');
assert.equal(collector.safeStatus().feeds.binance.connected,false);
assert(collector.safeStatus().feeds.binance.retry_after_seconds>=1750);
collector.disconnected('binance','upgrade_http_451');
assert(collector.retryAt.binance-Date.now()>=3590000,'451 must throttle for ~1 hour');
const r2=new Map(),record=[];
const r2stub={
 get:async key=>r2.has(key)?{json:async()=>r2.get(key)}:null,
 put:async(key,value)=>r2.set(key,JSON.parse(value))
};
const testEnv={AUTO_BINANCE_CONTAINER_EGRESS_PROBE:'true',MARKET_DATA:r2stub,
 LUMEX_CONTAINER_KEY:'s'.repeat(48),
 RESEARCH_CONTAINER:{getByName(name){assert.equal(name,'primary-research');return {
  fetch:async(url,opts)=>{
   assert.equal(url,'https://internal.lumex/binance-egress-probe');
   assert.equal(opts.method,'POST');
   assert.deepEqual(JSON.parse(opts.body),{scope:'public_usdm_forceOrder'});
   record.push(url);
   return new Response(JSON.stringify({ok:false,handshake_http_status:403,error_code:'upstream_http_forbidden'}),{status:200});
  }
 };}}
};
let result=await probeBinanceContainerEgress(testEnv,now);
assert.equal(result.status,'upstream_403');
assert.equal(result.handshake_http_status,403);
assert.equal(result.does_not_prove_feed_capture,true);
result=await probeBinanceContainerEgress(testEnv,now+60000);
assert.equal(result.cached,true);
assert.equal(record.length,1,'within 30min no repeated Binance container handshake');
const res=await worker.fetch(new Request('https://w/market-hub/v1/binance-egress-health'),testEnv);
const publicProof=await res.json();
assert.equal(publicProof.usable_as_liquidation_feed,false);
assert.equal(publicProof.cron_retirement_allowed,false);
assert.equal(publicProof.status,'upstream_403');
assert.equal((await probeBinanceContainerEgress({...testEnv,AUTO_BINANCE_CONTAINER_EGRESS_PROBE:'false'},now)).enabled,false);
console.log('PASS Binance 403/451 backoff + 30min container check + no false Cron readiness');
