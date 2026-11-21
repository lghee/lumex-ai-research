import assert from 'node:assert/strict';
import {normalizeWhaleCandles,normalizeWhalePortfolio,whaleHistoryRoute} from '../src/hyperliquid-whale-history.mjs';
const now=Date.UTC(2026,10,21,9,30),A='0x'+'a'.repeat(40);
const interval=3600000,begin=Math.floor(now/interval)*interval-12*interval;
const raw=Array.from({length:12},(_,i)=>({s:'BTC',i:'1h',t:begin+i*interval,T:begin+(i+1)*interval-1,o:'100',h:'104',l:'99',c:'101',v:'4'}));
raw.push({...raw.at(-1),t:Math.floor(now/interval)*interval,T:Math.floor(now/interval)*interval+interval-1});
const c=normalizeWhaleCandles(raw,'BTC','1h',now);
assert.equal(c.candles.length,12);assert.equal(c.verified_closed_only,true);
assert.equal(normalizeWhaleCandles([{...raw[0],o:'1000'},raw[1]],'BTC','1h',now),null);
const dates=Array.from({length:6},(_,i)=>[now-6*interval+i*interval,String(100+i*12)]);
const rawP=[['week',{pnlHistory:dates.map(([t,v])=>[t,String(+v+1000)])}],['month',{pnlHistory:dates}],
 ['perpWeek',{pnlHistory:dates}],['perpMonth',{pnlHistory:dates}],['perpAllTime',{pnlHistory:dates}]];
const p=normalizeWhalePortfolio(rawP,A,now);
assert.equal(p.pnl_scope.week,'perpWeek');assert.equal(p.pnl_scope.month,'perpMonth');
assert.equal(p.pnl_history.week.length,6);assert.equal(p.trading_enabled,false);
const memory=new Map([['market-hub/hyperliquid-whales/v1/latest.json',{ok:true,rows:[{address:A}]}],
 ['market-hub/hyperliquid-whales/v1/profiles/'+A+'.json',{positions:[{coin:'BTC'}],fills:[]}]]);
const env={MARKET_DATA:{get:async key=>memory.has(key)?{json:async()=>memory.get(key)}:null,
 put:async(key,val)=>memory.set(key,JSON.parse(val))}};
let posts=0;
const fetchImpl=async(url,req)=>{posts++;const body=JSON.parse(req.body);
 return {ok:true,headers:new Headers(),text:async()=>JSON.stringify(body.type==='portfolio'?rawP:raw)};};
const url='https://test/market-hub/v1/hyperliquid-whale-candles?address='+A+'&coin=BTC&interval=1h';
const result=await whaleHistoryRoute(new Request(url),env,{now,fetchImpl});
assert.equal(result.status,200);assert.equal((await result.json()).candles.length,12);
assert.equal(posts,1);
const cached=await whaleHistoryRoute(new Request(url),env,{now:now+30000,fetchImpl});
assert.equal(cached.status,200);assert.equal(posts,1);
const pr=await whaleHistoryRoute(new Request('https://test/market-hub/v1/hyperliquid-whale-portfolio?address='+A),env,{now,fetchImpl});
assert.equal(pr.status,200);assert.equal((await pr.json()).pnl_history.month.length,6);
assert.equal((await whaleHistoryRoute(new Request(url.replace('coin=BTC','coin=DOGE')),env,{now,fetchImpl})).status,404);
assert.equal((await whaleHistoryRoute(new Request(url.replace(A,'0x'+'b'.repeat(40))),env,{now,fetchImpl})).status,404);
console.log('PASS Hyperliquid authenticated-scope public history: perp PnL, real OHLC, freshness, no synthetic, R2 cache and wallet/coin allowlist');
