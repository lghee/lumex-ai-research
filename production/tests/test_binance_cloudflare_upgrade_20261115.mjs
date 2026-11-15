import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const raw=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
  .replace("import { DurableObject } from 'cloudflare:workers';",
    'class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}');
const {MarketLiveCollector}=await import('data:text/javascript;base64,'+Buffer.from(raw).toString('base64'));
const env={AUTO_LIVE_STREAM:'true',AUTO_BINANCE_LIQUIDATIONS:'true'};
const pending=[],ctx={storage:{getAlarm:async()=>100,setAlarm:async()=>{}},waitUntil:p=>pending.push(p)};
const collector=new MarketLiveCollector(ctx,env);
const originalFetch=globalThis.fetch;
class FakeWS{
 constructor(){this.readyState=0;this.listeners=new Map();this.accepted=false}
 addEventListener(k,cb){this.listeners.set(k,cb)}
 accept(){this.accepted=true;this.readyState=1}
 close(){this.readyState=3}
 send(){}
}
const url='wss://fstream.binance.com/market/stream?streams=!forceOrder@arr';
try{
  const sock=new FakeWS();let endpoint=null;
  globalThis.fetch=async (target,opts)=>{
    endpoint=target;assert.equal(opts.headers.Upgrade,'websocket');
    assert(target.startsWith('https://fstream.binance.com/'));
    return {status:101,webSocket:sock};
  };
  await collector.connectBinanceViaUpgrade(url);
  assert.equal(endpoint,'https://fstream.binance.com/market/stream?streams=!forceOrder@arr');
  assert.equal(sock.accepted,true);
  assert.equal(collector.streams.get('binance'),sock);
  assert.equal(collector.metrics.binance.state,'connected');
  assert.equal(collector.safeStatus().feeds.binance.connected,true);
  globalThis.fetch=async()=>({status:403,webSocket:null});
  await collector.connectBinanceViaUpgrade(url);
  assert.equal(collector.metrics.binance.error,'upgrade_http_403');
  assert.equal(collector.safeStatus().feeds.binance.connected,false);
  assert.equal(collector.metrics.binance.restarts,1);
  collector.metrics.binance.restarts=1;
  globalThis.fetch=async()=>({status:451,webSocket:null});
  collector.connect('binance');
  await Promise.all(pending);
  assert.equal(collector.metrics.binance.error,'upgrade_http_451');
  assert.equal(collector.metrics.binance.restarts,2);
  assert.equal(collector.streams.has('binance'),false);
  // Refuse arbitrary redirects/hosts even if called with an unexpected URL.
  await collector.connectBinanceViaUpgrade('wss://evil.example/stream');
  assert.equal(collector.metrics.binance.error,'upgrade_fetch_error');
}finally{globalThis.fetch=originalFetch}
console.log('PASS Cloudflare Binance fetch Upgrade fallback: 101 socket, 403/451 reason, origin guard');
