import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const code=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
 .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {}');
const {externalBinanceRelayRoute,externalBinanceRelayHealth}=
 await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const key='a'.repeat(64),now=Date.now(),store=new Map(),collected=[];
const env={LUMEX_BINANCE_RELAY_SECRET:key,
 MARKET_DATA:{async put(k,v){store.set(k,v)},async get(k){
  if(!store.has(k))return null;const value=store.get(k);
  return {json:async()=>JSON.parse(value),text:async()=>value};
 }},
 MARKET_EVENT_HUB:{getByName:()=>({async fetch(req){
  const body=await req.json();collected.push(...body.events);
  return new Response(JSON.stringify({ok:true,accepted:body.events.length,invalid:0}),{status:200});
 }})}};
const url='https://test/market-hub/v1/binance-external-ingest',session_id='d2b5b570-8ea8-4d14-b8e9-6878abf19a9d';
const body=(frames=[],connected=true,dropped_events=0)=>({
 schema:'lumex_binance_public_relay_v1',session_id,observed_ms:now,connected,
 provider_messages:frames.length,dropped_events,frames});
const request=(b,secret=key)=>new Request(url,{method:'POST',
 headers:{authorization:'Bearer '+secret,'content-type':'application/json'},
 body:JSON.stringify(b)});
assert.equal((await externalBinanceRelayRoute(request(body([]),'wrong'),env,now)).status,401);
assert.equal((await externalBinanceRelayRoute(request({...body([]),session_id:'bad'}),env,now)).status,400);
assert.equal((await externalBinanceRelayRoute(request(body([])),{...env,LUMEX_BINANCE_RELAY_SECRET:''},now)).status,503);
let res=await externalBinanceRelayRoute(request(body([])),env,now);
assert.equal(res.status,200);
let state=await externalBinanceRelayHealth(env,now);
assert.equal(state.source_r2_readback_verified,false,'heartbeat cannot invent liquidation sample');
assert.equal(state.cron_retirement_allowed,false);
const frame={e:'forceOrder',E:now-5000,st:1,o:{
 s:'BTCUSDT',T:now-5000,S:'SELL',X:'FILLED',ap:'65000',z:'0.4'
}};
res=await externalBinanceRelayRoute(request(body([frame])),env,now+10000);
assert.equal(res.status,200);
assert.equal((await res.json()).accepted,1);
assert.equal(collected.length,1);
assert.equal(collected[0].source,'binance');
assert.equal(collected[0].quantity,0.4);
assert.equal(collected[0].capture,'sampled_1s');
assert.equal(collected[0].price_type,'avg_execution_price');
state=await externalBinanceRelayHealth(env,now+10000);
assert.equal(state.source_r2_readback_verified,true);
assert.equal(state.stale,false);
assert.equal(state.cron_retirement_allowed,false,'source proof is not full continuous capture');
assert.equal(state.verified_contiguous_seconds,10);
assert.equal([...store.keys()].some(k=>k.includes('events-source-proof/binance/v1/')),true);
await externalBinanceRelayRoute(request(body([])),env,now+15000);
state=await externalBinanceRelayHealth(env,now+15000);
assert.equal(state.verified_contiguous_seconds,15);
await externalBinanceRelayRoute(request(body([],false,2)),env,now+20000);
state=await externalBinanceRelayHealth(env,now+20000);
assert.equal(state.verified_contiguous_seconds,0,'disconnect and dropped data reset continuity');
assert.equal(state.cron_retirement_allowed,false);
console.log('PASS Binance continuous external relay endpoint: authenticated, official source, durable R2 proof, fail-closed Cron readiness');
