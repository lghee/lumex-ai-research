import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
 .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}');
const {default:worker,marketTerminalSummary}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const symbol='BTCUSDT',now=Date.now(),frame=900000;
const end=Math.floor(now/frame)*frame;
const bars=Array.from({length:121},(_,i)=>{
 const t=end-(121-i)*frame,p=50000+i*2;
 return [t,p,p+40,p-40,p+10,1+i/10];
});
const raw='timestamp,open,high,low,close,volume\n'+bars.map(x=>x.join(',')).join('\n')+'\n';
const latest=bars.at(-1)[0], token='n'.repeat(64);
let reads=0;
const store=new Map([
 ['market-hub/public-pulse/v1/latest.json',{
  schema:'lumex_public_pulse_v1',order_execution:false,
  feeds:{
   tickers:{source:'bybit_v5_linear',sampled_unix:Math.floor(now/1000)-110,data:{quotes:{[symbol]:{last:50100,change_24h_pct:3.4}}}},
   ratios:{BTC:{symbol,source:'bybit_v5_account_ratio',sampled_unix:Math.floor(now/1000)-160,
     data:{long_pct:54,short_pct:46}}},
   takers:{BTC:{symbol,source:'binance_futures_taker_volume',sampled_unix:Math.floor(now/1000)-200,
     data:{buy_pct:62,sell_pct:38}}},
   sentiment:{data:{value:48}}
  }
 }],
 ['market-hub/oi/v1/latest/BTC-7.json',{
  schema:'lumex_oi_mirror_v1',pair:symbol,days:7,exchange:'Bybit',
  source_scope:'single_exchange_public_oi_only',order_execution:false,
  history:Array.from({length:65},(_,i)=>({ts:now-i*3600000})),
  sample_unix:Math.floor(now/1000)-180,price:50000,oi_usd:7000000
 }],
 ['market-hub/derivatives/v1/latest/BTCUSDT.json',{
   schema:'lumex_derivatives_v1',symbol,scope:'single_public_exchange_not_global',
   order_execution:false,snapshot_ms:now-190000,
   price:{mark_price:50020,funding_rate_pct:0.01},
   open_interest:{open_interest_usdt:8000000},oi_change_1h_pct:1.4
 }]
]);
const env={LUMEX_AI_LAB_WORKER_TOKEN:token, AUTO_BINANCE_LIQUIDATIONS:'true', MARKET_DATA:{
 async head(k){reads++;if(k!=='market/'+symbol+'_15.csv')return null;
  return {size:raw.length,customMetadata:{schema:'ohlcv_v2',quality:'verified',
   lastCandleMs:String(latest),rows:String(bars.length),source:'gateio_usdt_perpetual'}};},
 async get(k){reads++;
  if(k==='market/'+symbol+'_15.csv')return {text:async()=>raw};
  if(!store.has(k))return null;
  return {json:async()=>store.get(k)};}
 },
 MARKET_EVENT_HUB:{getByName(s){assert.equal(s,symbol);return {
   async fetch(req){const u=new URL(req);assert.equal(u.pathname,'/insights');
    return new Response(JSON.stringify({ok:true,symbol,window:'24h',
      scope:'observed_public_events_only',market_total_estimate:false,
      rollup:{up_to_date:true,pending_hot_events:0},
      captures:{liquidations:{events:3},binance_liquidation_snapshots:{events:7},
        btc_address_net:{events:2}},
      last_observed_ms:now-25000,generated_at:new Date(now).toISOString()
    }))}}}}
};
let res=await worker.fetch(new Request('https://worker/market-hub/v1/terminal?symbol='+symbol),env);
assert.equal(res.status,401);assert.equal(reads,0);
res=await worker.fetch(new Request('https://worker/market-hub/v1/terminal?symbol=FAKEUSDT',{headers:{authorization:'Bearer '+token}}),env);
assert.equal(res.status,400);
res=await worker.fetch(new Request('https://worker/market-hub/v1/terminal?symbol='+symbol,{headers:{authorization:'Bearer '+token}}),env);
assert.equal(res.status,200);
assert.equal(res.headers.get('access-control-allow-origin'),'https://lumexbot.com');
const body=await res.json();
assert.equal(body.schema,'lumex_pro_market_terminal_v1');
assert.equal(body.quality.total,5);
assert.equal(body.quality.available,5);
assert.equal(body.sections.candles.values.trend,'up');
assert.equal(body.sections.pulse.values.bybit_price,50100);
assert.equal(body.sections.pulse.values.bybit_accounts_long_pct,54);
const pulseSnapshot=store.get('market-hub/public-pulse/v1/latest.json');
const takerSnapshot=pulseSnapshot.feeds.takers.BTC;
delete pulseSnapshot.feeds.takers.BTC;
const withoutBinance=await marketTerminalSummary(env,symbol,now);
assert.notEqual(withoutBinance.sections.pulse.status,'unavailable',
  'Binance HTTP 403 must not hide valid Bybit account and ticker data');
assert.equal(withoutBinance.sections.pulse.values.bybit_price,50100);
assert.equal(withoutBinance.sections.pulse.values.bybit_accounts_long_pct,54);
assert.equal(withoutBinance.sections.pulse.values.binance_taker_buy_pct,null);
assert.equal(withoutBinance.sections.pulse.values.source_status.binance_taker,'unavailable');
pulseSnapshot.feeds.takers.BTC=takerSnapshot;
const gateTaker={...takerSnapshot,source:'gateio_futures_contract_stats_taker_size',
  data:{status:'ok',buy_pct:57.4,sell_pct:42.6,exchange:'Gate',
    scope:'gateio_futures_contract_stats_closed_5m',volume_unit:'gate_futures_contracts',
    period_minutes:15,bars:3,sample_unix:Math.floor(now/1000)-200,
    liquidation:{long_usdt:12345,short_usdt:54321,period_minutes:15,exchange:'Gate',
      source:'gateio_public_contract_stats_liquidation_aggregates'}}};
pulseSnapshot.feeds.takers.BTC=gateTaker;
const sourced=await marketTerminalSummary(env,symbol,now);
assert.equal(sourced.sections.pulse.values.gate_taker_buy_pct,57.4);
assert.equal(sourced.sections.pulse.values.gate_liquidation_long_usdt,12345);
assert.equal(sourced.sections.pulse.values.gate_liquidation_short_usdt,54321);
assert.equal(sourced.sections.pulse.values.gate_liquidation_window_minutes,15);
assert.equal(sourced.sections.pulse.values.binance_taker_buy_pct,null,
  'Never label Gate figures as Binance');
assert.equal(sourced.sections.pulse.values.taker_exchange,'Gate');
assert.equal(sourced.sections.pulse.values.source_status.binance_taker,'unavailable');
assert.equal(sourced.sections.pulse.values.source_status.gate_taker,'available');
pulseSnapshot.feeds.takers.BTC=takerSnapshot;
assert.equal(body.sections.pulse.values.binance_taker_buy_pct,62);
assert.equal(body.sections.oi.values.exchange,'Bybit');
assert.equal(body.sections.gate.values.funding_rate_pct,0.01);
assert.equal(body.sections.observations.values.bybit_liquidation_events_24h,3);
assert.equal(body.sections.observations.values.binance_liquidation_snapshots_24h,7);
const disabled=await marketTerminalSummary({...env,AUTO_BINANCE_LIQUIDATIONS:'false'},symbol,now);
assert.equal(disabled.sections.observations.values.binance_liquidation_snapshots_24h,null,
  'disabled Binance must never be shown as 0 snapshots');
// Regression: optional Binance/whale captures may be absent from a valid
// hourly rollup, but must never blank the independently observed Bybit events.
async function partialObservations(captures,binanceEnabled='false',upToDate=true){
 const partialEnv={...env,AUTO_BINANCE_LIQUIDATIONS:binanceEnabled,
   MARKET_EVENT_HUB:{getByName(name){assert.equal(name,symbol);return {
     async fetch(){return new Response(JSON.stringify({
       ok:true,symbol,window:'24h',scope:'observed_public_events_only',
       market_total_estimate:false,
       rollup:{up_to_date:upToDate,pending_hot_events:0},
       captures,generated_at:new Date(now).toISOString(),last_observed_ms:now-20000
     }));}
   }}}};
 return await marketTerminalSummary(partialEnv,symbol,now);
}
const bybitOnly=await partialObservations({liquidations:{events:3}});
assert.equal(bybitOnly.sections.observations.status,'fresh');
assert.equal(bybitOnly.sections.observations.values.bybit_liquidation_events_24h,3);
assert.equal(bybitOnly.sections.observations.values.binance_liquidation_snapshots_24h,null);
assert.equal(bybitOnly.sections.observations.values.btc_watchlist_address_flows_24h,null);
const binanceOnly=await partialObservations({binance_liquidation_snapshots:{events:5}},'true');
assert.equal(binanceOnly.sections.observations.status,'fresh');
assert.equal(binanceOnly.sections.observations.values.bybit_liquidation_events_24h,null);
assert.equal(binanceOnly.sections.observations.values.binance_liquidation_snapshots_24h,5);
const disabledBinanceOnly=await partialObservations({binance_liquidation_snapshots:{events:5}});
assert.equal(disabledBinanceOnly.sections.observations.status,'unavailable',
  'disabled Binance alone must not create a misleading observed section');
const whaleOnly=await partialObservations({btc_address_net:{events:4}});
assert.equal(whaleOnly.sections.observations.status,'unavailable',
  'whale-only capture must not fabricate a liquidation observation');
const noCaptures=await partialObservations({});
assert.equal(noCaptures.sections.observations.status,'unavailable');
const unrolled=await partialObservations({liquidations:{events:3}},'false',false);
assert.equal(unrolled.sections.observations.status,'unavailable',
  'pending rollup must never show verified observed counts');

assert.equal(body.orders_enabled,false);assert.equal(body.market_total_estimate,false);
assert(!JSON.stringify(body).includes('positions'));
const exp=Math.floor(Date.now()/1000)+70;
const text='mh1:7:'+symbol+':'+exp;
const cryptoKey=await crypto.subtle.importKey('raw',new TextEncoder().encode(token),
 {name:'HMAC',hash:'SHA-256'},false,['sign']);
const hmac=await crypto.subtle.sign('HMAC',cryptoKey,new TextEncoder().encode(text));
const sig=Array.from(new Uint8Array(hmac),x=>x.toString(16).padStart(2,'0')).join('');
const session=new URL('https://worker/market-hub/v1/terminal');
session.searchParams.set('uid','7');session.searchParams.set('symbol',symbol);
session.searchParams.set('exp',String(exp));session.searchParams.set('sig',sig);
res=await worker.fetch(new Request(session),env);
assert.equal(res.status,200,'existing 90 second PRO ticket works for direct client API');
session.searchParams.set('symbol','ETHUSDT');
res=await worker.fetch(new Request(session),env);
assert.equal(res.status,401,'ticket cannot be reused for another coin');
const empty=await marketTerminalSummary({...env, MARKET_DATA:{get:async()=>null,head:async()=>null},MARKET_EVENT_HUB:null},'ETHUSDT',now);
assert.equal(empty.quality.available,0);
assert.equal(empty.quality.all_sources_fresh,false);
assert(Object.values(empty.sections).every(x=>x.status==='unavailable'),'missing data cannot be fabricated');
console.log('PASS 1.3.1 PRO terminal: 5 sources, HMAC ticket, source separation, no missing-data fabrication, CORS and no orders');
