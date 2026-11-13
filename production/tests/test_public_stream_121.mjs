import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
 .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {}');
const mod=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const {MarketLiveCollector,decodeBybitLiquidations,decodeGatePublic}=mod;
const now=Date.now();
const liq={topic:'allLiquidation.BTCUSDT',type:'snapshot',ts:now,
  data:[{T:now,s:'BTCUSDT',S:'Buy',v:'5',p:'95000'},{T:now,s:'ETHUSDT',S:'Sell',v:'2',p:'3100'}]};
const data=decodeBybitLiquidations(liq);
assert.equal(data.length,2);
assert.equal(data[0].position_side,'long');assert.equal(data[0].price_type,'bankruptcy_price');
assert.equal(data[0].side,'buy');
assert.deepEqual(decodeBybitLiquidations({topic:'other',data:liq.data}),[]);
const gate=decodeGatePublic({channel:'futures.trades',event:'update',result:[
  {id:111,contract:'BTC_USDT',size:'-12',price:'105000',create_time_ms:now},
  {id:112,contract:'BTC_USDT',size:3,price:'105005',create_time_ms:now,is_internal:true}
]});
assert.equal(gate.length,1);assert.equal(gate[0].side,'sell');assert.equal(gate[0].capture,'sampled_1s');
const tick=decodeGatePublic({channel:'futures.tickers',event:'update',time_ms:now,result:{contract:'BTC_USDT',last:'99000'}});
assert.equal(tick.length,1);assert.equal(tick[0].capture,'sampled_2s');
const observed=[];
const storage={current:null,async getAlarm(){return this.current},async setAlarm(ms){this.current=ms}};
const waiting=[];
const ctx={storage,waitUntil(p){waiting.push(p);p.catch(()=>{})}};
const env={AUTO_LIVE_STREAM:'true',MARKET_EVENT_HUB:{getByName:s=>({fetch:async req=>{
  const body=await req.json();assert.equal(s,body.symbol);observed.push(...body.events);
  return new Response(JSON.stringify({ok:true,accepted:body.events.length,invalid:0}),{status:200});
}})}};
class FakeWebSocket {
  static all=[];
  static OPEN=1;
  constructor(uri){this.url=uri;this.handlers={};this.readyState=0;this.sent=[];FakeWebSocket.all.push(this);}
  addEventListener(t,cb){(this.handlers[t]??=[]).push(cb)}
  emit(type,msg){for(const cb of this.handlers[type]||[])cb(msg)}
  send(data){this.sent.push(data)}
  close(){this.readyState=3}
}
const oldWS=globalThis.WebSocket;globalThis.WebSocket=FakeWebSocket;
const collector=new MarketLiveCollector(ctx,env);
const start=await collector.fetch(new Request('https://collector/ensure'));
assert.equal(start.status,200);
assert.equal(FakeWebSocket.all.length,2);
const gateWs=FakeWebSocket.all.find(w=>w.url.includes('gateio')),bybitWs=FakeWebSocket.all.find(w=>w.url.includes('bybit'));
assert(gateWs&&bybitWs);
for(const ws of [gateWs,bybitWs]){ws.readyState=1;ws.emit('open',{})}
assert(gateWs.sent.some(x=>x.includes('futures.trades')));
assert(gateWs.sent.some(x=>x.includes('futures.tickers')));
assert(bybitWs.sent.some(x=>x.includes('allLiquidation.BTCUSDT')));
gateWs.emit('message',{data:JSON.stringify({channel:'futures.tickers',event:'update',time_ms:now,
  result:{contract:'BTC_USDT',last:'100000'}})});
bybitWs.emit('message',{data:JSON.stringify(liq)});
await Promise.all(waiting);
await collector.flush();
assert.equal(observed.filter(x=>x.kind==='liquidation').length,2);
assert.equal(observed.filter(x=>x.kind==='ticker').length,1);
assert(observed.every(e=>/^[A-Za-z0-9:_-]{8,128}$/.test(e.id)));
assert(observed.filter(e=>e.kind==='liquidation').every(e=>e.price_type==='bankruptcy_price'));
const status=await (await collector.fetch(new Request('https://collector/status'))).json();
assert.equal(status.feeds.bybit.state,'connected');
assert.equal(status.feeds.gate.state,'connected');
assert(status.accepted>=3);
env.AUTO_LIVE_STREAM='false';
const stopped=await (await collector.fetch(new Request('https://collector/ensure'))).json();
assert.equal(stopped.enabled,false);
globalThis.WebSocket=oldWS;
console.log('PASS 1.2.1 public Gate/Bybit streams: normalization, price provenance, observation sink, startup, no private auth');
