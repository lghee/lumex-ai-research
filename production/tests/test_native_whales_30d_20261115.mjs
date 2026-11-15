import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const raw=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
  .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}');
const {nativeWhales30d}=await import('data:text/javascript;base64,'+Buffer.from(raw).toString('base64'));
const now=Date.UTC(2026,10,15,8,0),floor=Math.floor(now/3600000)*3600000;
const candles=Array.from({length:850},(_,i)=>({
  t:floor-(849-i)*3600000,o:100,h:110,l:90,c:100+i*0.1,v:2}));
const ev=(id,ts,side='in',q=12.5)=>({ts,source:'blockstream',payload:JSON.stringify({
 kind:'whale_transfer',source:'blockstream',symbol:'BTCUSDT',id:'btc:addressflow:'+id,
 side,txhash:id.repeat(64).slice(0,64),quantity:q,capture:'confirmed_chain_poll',
 watched_address:'1BoatSLRHtKNngkdXEeobR76b53LETtpyT',watch_label:'Binance',unit:'BTC'})});
const obs=nativeWhales30d([ev('a',now-120000),ev('b',now-3600000,'out',7.5)],candles,now);
assert.equal(obs.schema,'lumex_cf_native_whales_30d_v1');
assert.equal(obs.source,'cloudflare_native_confirmed_btc_watchlist');
assert.equal(obs.rows.length,2);
assert.equal(obs.rows[0].amount_coin,12.5);
assert.equal(obs.rows[1].transfer_direction,'out');
assert.equal(obs.legacy_sql_read,false);
assert.equal(obs.cron_retirement_authorized,false);
assert.equal(obs.live_ledger_merged,false);
assert.equal(obs.price_method,'verified_r2_btc_usdt_60m_close_estimate');
assert(Object.keys(obs.price_series).length>=30);
assert(obs.price_usd>100);
assert.throws(()=>nativeWhales30d([ev('a',now-120000),ev('a',now-130000)],candles,now),/event_invalid/);
assert.throws(()=>nativeWhales30d([ev('a',now-32*86400000)],candles,now),/event_invalid/);
assert.throws(()=>nativeWhales30d([ev('a',now-3600000)],candles.slice(0,400),now),/input_limit/);
assert.throws(()=>nativeWhales30d([ev('a',now-120000,'long')],candles,now),/event_invalid/);
console.log('PASS Cloudflare independent BTC 30d reserve watchlist: 850-hour OHLCV price source, no duplicate events and original chart metadata');
