import assert from 'node:assert/strict';
import {CRYPTO_BASES,normalizeTickers,collectPublicHeatmap,heatmapPublicRoute} from '../src/public-heatmap.mjs';
const NOW=Date.parse('2026-11-18T11:00:00Z');
const tick=(i)=>({
  contract:CRYPTO_BASES[i]+'_USDT',
  last:String(100+i),change_percentage:String((i%3===0?-1:1)*(1+i/10)),
  volume_24h_quote:String(1000000000-i*1000000),funding_rate:'0.0001'
});
const raw=[...Array.from({length:65},(_,i)=>tick(i)),{...tick(66),contract:'SOXL_USDT',volume_24h_quote:'99999999999'},{...tick(67),contract:'SNDK_USDT',volume_24h_quote:'99999999999'}];
const d=normalizeTickers(raw,NOW);
assert.equal(d.schema,'lumex_public_heatmap_v1');
assert.equal(d.coins.length,50);
assert.equal(d.breadth.up+d.breadth.down+d.breadth.flat,50);
assert.equal(d.coins[0].coin,'BTC');
assert.equal(d.coins[49].coin,CRYPTO_BASES[49]);
assert.ok(!d.coins.some(x=>['SOXL','SNDK'].includes(x.coin)));
assert.equal(d.coverage.excludes_unclassified_contracts,true);
assert.equal(d.coins[0].funding_rate_pct,.01);
assert.equal(d.collected_ms,NOW);
assert.equal(d.interpretation.mood,'혼조');
assert.equal(d.coverage.does_not_include_all_exchanges,true);
assert.throws(()=>normalizeTickers(raw.slice(0,45),NOW),/ticker_rows_invalid/);
const malformed=raw.map((x,i)=>i<30?{...x,last:'NaN'}:x);
assert.throws(()=>normalizeTickers(malformed,NOW),/fewer_than_50_valid_futures/);
const saved=new Map();
const bucket={get:async key=>saved.has(key)?{json:async()=>JSON.parse(saved.get(key))}:null,
  put:async(key,data)=>saved.set(key,String(data))};
const originalFetch=globalThis.fetch;
try{
 globalThis.fetch=async()=>new Response(JSON.stringify(raw),{status:200,
   headers:{'content-type':'application/json'}});
 const env={MARKET_DATA:bucket};
 assert.equal((await collectPublicHeatmap(env,NOW)).ok,true);
 assert.equal(saved.has('market-hub/free-heatmap/v1/latest.json'),true);
 assert.equal((await (await heatmapPublicRoute(new Request('https://worker/market-hub/v1/public-heatmap'),env,NOW)).json()).coins.length,50);
 assert.equal((await heatmapPublicRoute(new Request('https://worker/market-hub/v1/public-heatmap'),env,NOW)).headers.get('access-control-allow-origin'),'*');
 const old=await (await heatmapPublicRoute(new Request('https://worker/market-hub/v1/public-heatmap'),env,NOW+21*60000)).json();
 assert.equal(old.stale,true);
 assert.equal(old.status,'stale');
 assert.equal((await heatmapPublicRoute(new Request('https://worker/market-hub/v1/public-heatmap',{method:'POST'}),env,NOW)).status,405);
 assert.equal((await heatmapPublicRoute(new Request('https://worker/market-hub/v1/public-heatmap',{method:'OPTIONS'}),env,NOW)).status,204);
 const backup=saved.get('market-hub/free-heatmap/v1/latest.json');
 globalThis.fetch=async()=>new Response('quota exceed',{status:429});
 const fail=await collectPublicHeatmap(env,NOW+300000);
 assert.equal(fail.ok,false);
 assert.equal(saved.get('market-hub/free-heatmap/v1/latest.json'),backup);
 const empty=await heatmapPublicRoute(new Request('https://worker/market-hub/v1/public-heatmap'),{MARKET_DATA:{get:async()=>null}},NOW);
 assert.equal(empty.status,503);
}finally{globalThis.fetch=originalFetch;}
console.log('PASS LUMEX free 50: all real-candidate validation, breadth, scope, 5min R2, no private data, stale and failure preservation');
