import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const raw=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
 .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}');
const {default:worker,decodeBinanceLiquidations,summarizeObservedRollups,BtcReserveCollector,MarketLiveCollector}=
 await import('data:text/javascript;base64,'+Buffer.from(raw).toString('base64'));
const now=Date.now();
const valid={e:'forceOrder',E:now,st:1,ps:'BTCUSDT',
  o:{s:'BTCUSDT',S:'SELL',o:'LIMIT',q:'0.6',p:'60000',ap:'60120',X:'FILLED',l:'0.2',z:'0.4',T:now}};
let events=decodeBinanceLiquidations(valid,now);
assert.equal(events.length,1);
assert.deepEqual({...events[0],kind:'liquidation'},events[0]);
assert.equal(events[0].source,'binance');assert.equal(events[0].position_side,'long');
assert.equal(events[0].side,'sell');assert.equal(events[0].quantity,0.4);
assert.equal(events[0].price,60120);assert.equal(events[0].price_type,'avg_execution_price');
assert.equal(events[0].capture,'sampled_1s');
assert.equal(decodeBinanceLiquidations({...valid,st:2},now).length,0,'reject COIN-M mixed scope');
assert.equal(decodeBinanceLiquidations({...valid,o:{...valid.o,s:'BCHUSDT'}},now).length,0);
assert.equal(decodeBinanceLiquidations({...valid,o:{...valid.o,z:'0'}},now).length,0);
assert.equal(decodeBinanceLiquidations({...valid,o:{...valid.o,ap:'0'}},now).length,0);
assert.equal(decodeBinanceLiquidations({...valid,o:{...valid.o,T:now-900000}},now).length,0);
assert.equal(decodeBinanceLiquidations({...valid,o:{...valid.o,S:'BUY'}},now)[0].position_side,'short');
const wrapped={stream:'btcusdt@forceOrder',data:valid};
assert.equal(decodeBinanceLiquidations(wrapped,now).length,1);
assert.equal(decodeBinanceLiquidations({...wrapped,stream:'ethusdt@forceOrder'},now).length,0);
const bucket=Math.floor(now/3600000)*3600000;
const roll=summarizeObservedRollups([
  {bucket,kind:'liquidation',source:'bybit',side:'sell',events:2,quantity:1,first_ts:now-1000,last_ts:now-100},
  {bucket,kind:'liquidation',source:'binance',side:'sell',events:3,quantity:2,first_ts:now-1000,last_ts:now-100}
],'BTCUSDT','24h',now);
assert.equal(roll.captures.liquidations.events,2,'Bybit legacy tally unchanged');
assert.equal(roll.captures.binance_liquidation_snapshots.events,3,'Binance separated');
assert.equal(roll.hourly[0].liquidation,2);
assert.equal(roll.hourly[0].binance_liquidation_sampled,3);
const token='w'.repeat(64),store=new Map();
const ctx={storage:{get:async k=>store.get(k),put:async(k,v)=>store.set(k,v)}};
const env={AUTO_WHALE_FETCH:'true',LUMEX_AI_LAB_WORKER_TOKEN:token,
  BTC_RESERVE_COLLECTOR:{getByName(id){
    assert.equal(id,'reserve-btc');
    return {fetch:req=>collector.fetch(typeof req==='string'?new Request(req):req)};
  }}};
const collector=new BtcReserveCollector(ctx,env);
const watched='34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo';
const cryptoModule=globalThis.crypto;
const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(watched))),
 n=>n.toString(16).padStart(2,'0')).join('');
await store.set('state',{watchlist_source:'wordpress_configured',
  watchlist_count:1,watchlist_sha256:digest,watchlist_checked_ms:now,last_success_ms:now});
const noauth=await worker.fetch(new Request('https://worker/market-hub/v1/watchlist-parity'),env);
assert.equal(noauth.status,401);
const auth=await worker.fetch(new Request('https://worker/market-hub/v1/watchlist-parity',{headers:{authorization:'Bearer '+token}}),env);
const parity=await auth.json();
assert.equal(parity.ok,true);assert.equal(parity.enabled,true);assert.equal(parity.address_count,1);
assert.equal(parity.address_set_sha256,digest);
assert.equal(parity.safe_to_disable_wordpress_crons,false);
assert(!JSON.stringify(parity).includes(watched),'watchlist address must never leak');
await store.set('state',{watchlist_source:'legacy_seed_fallback',
  watchlist_count:1,watchlist_sha256:digest,watchlist_checked_ms:now,last_success_ms:now});
const fallback=await (await worker.fetch(new Request('https://worker/market-hub/v1/watchlist-parity',{headers:{authorization:'Bearer '+token}}),env)).json();
assert.equal(fallback.ok,false);
env.AUTO_WHALE_FETCH='false';
const disabled=await (await worker.fetch(new Request('https://worker/market-hub/v1/watchlist-parity',{headers:{authorization:'Bearer '+token}}),env)).json();
assert.equal(disabled.ok,false);assert.equal(disabled.enabled,false);
env.AUTO_WHALE_FETCH='true';
const live=new MarketLiveCollector({storage:{getAlarm:async()=>0},waitUntil:()=>{}},{AUTO_LIVE_STREAM:'true',AUTO_BINANCE_LIQUIDATIONS:'false'});
assert.equal(live.safeStatus().feeds.binance.enabled,false);
const enabled=new MarketLiveCollector({storage:{getAlarm:async()=>0},waitUntil:()=>{}},{AUTO_LIVE_STREAM:'true',AUTO_BINANCE_LIQUIDATIONS:'true'});
assert.equal(enabled.safeStatus().feeds.binance.enabled,true);
const h=await (await worker.fetch(new Request('https://worker/market-hub/v1/health'),env)).json();
assert.equal(h.version,'1.2.11');
console.log('PASS 1.2.11 Binance sample filter + 1s provenance, original Bybit count isolation, salted-free canonical BTC watchlist hash, Bearer + fallback gate');
