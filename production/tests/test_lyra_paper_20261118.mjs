import assert from 'node:assert/strict';
import {COINS,BAR,closedBars,marketFromBars,initial,advance,evaluateForward,
  runPaperTick,report,privateReport} from '../src/lyra-paper.mjs';
const MS=Date.UTC(2026,10,18,12,5,0);
const latest=Math.floor(MS/1000/BAR)*BAR-BAR;
const rows=(t=latest)=>Array.from({length:510},(_,i)=>{
 const p=100*(1+.0002*(i-509));
 return {t:t+(i-509)*BAR,o:p,h:p*1.004,l:p*.996,c:p*1.001,v:500};
});
const market=(t=latest)=>marketFromBars(Object.fromEntries(COINS.map(c=>[c,closedBars(rows(t),(t+BAR)*1000+5*60000)])));
const m=market(),quotes=Object.fromEntries(COINS.map(c=>[c,100]));
assert.equal(m.t,latest);
let state=initial(quotes,m,MS);
assert.equal(state.nav,10000);
assert.equal(state.orders_enabled,false);
assert.equal(state.weights.BTC,0);
assert.equal(advance(state,quotes,null,MS).state.ticks,1);
assert.throws(()=>advance(state,quotes,null,MS-60000),/clock_reversed/);
state=advance(state,quotes,null,MS+60000).state;
assert.equal(state.ticks,2);
assert.equal(state.nav,10000);
const testShock=structuredClone(state);
testShock.weights={BTC:.5,ETH:.2,SOL:-.2,XRP:.1};
const drops={BTC:93,ETH:96,SOL:97,XRP:98};
const shock=advance(testShock,drops,null,MS+2*60000).state;
assert.equal(shock.weights.BTC,0);
assert.equal(shock.regime,'COOLDOWN');
assert.ok(shock.risk.shock_until_ms>MS+2*60000);
assert.ok(shock.nav<10000);
const repeat=advance(shock,drops,null,MS+3*60000).state;
assert.equal(repeat.risk.shock_until_ms,shock.risk.shock_until_ms);
const stale=structuredClone(state);
stale.weights={BTC:1,ETH:0,SOL:0,XRP:0};
assert.equal(advance(stale,quotes,null,MS+11*60000).state.status,'halted_data_gap');
const halted=advance(stale,{...quotes,BTC:87},null,MS+2*60000).state;
assert.equal(halted.status,'halted_drawdown');
assert.equal(halted.weights.BTC,0);
assert.equal(halted.orders_enabled,false);
const gapMarket={...m,t:m.t+2*BAR};
assert.equal(advance(state,quotes,gapMarket,MS+2*60000).state.status,'halted_data_gap');
assert.ok(evaluateForward(state).reasons.length>=3);
const gapRows=rows();gapRows.splice(100,1);
assert.throws(()=>closedBars(gapRows,MS),/history_gap/);
const corrupt=rows();corrupt[12].c=-100;
assert.throws(()=>closedBars(corrupt,MS),/bad_ohlcv/);
const storageMap=new Map(),r2Map=new Map();
const storage={get:async k=>storageMap.get(k),put:async(k,v)=>storageMap.set(k,v)};
const token='A'.repeat(64);
const env={MARKET_DATA:{put:async(k,v)=>r2Map.set(k,v)},
  LYRA_PAPER_RUNNER:{getByName:()=>({fetch:async()=>Response.json(await report(storage))})},
  LUMEX_AI_LAB_WORKER_TOKEN:token};
const fetch0=globalThis.fetch;
try{
 globalThis.fetch=async url=>{
   const u=new URL(url),symbol=u.searchParams.get('contract')?.replace('_USDT','');
   return Response.json(u.pathname.endsWith('/tickers')?
     [{contract:symbol+'_USDT',last:'100',mark_price:'100'}]:rows());
 };
 const t1=await runPaperTick(storage,env,MS);
 const t2=await runPaperTick(storage,env,MS+60000);
 assert.equal(t1.ok,true);
 assert.equal(t2.ok,true);
 assert.equal((await report(storage)).ticker_observations,2);
 assert.ok([...r2Map.keys()].some(k=>k.endsWith('latest.json')));
 const denied=await privateReport(new Request('https://worker/market-hub/v1/lyra-paper-report'),env);
 assert.equal(denied.status,401);
 const authorized=await privateReport(new Request('https://worker/market-hub/v1/lyra-paper-report',
   {headers:{authorization:'Bearer '+token}}),env);
 assert.equal(authorized.status,200);
 const inspected=await authorized.json();
 assert.equal(inspected.orders_enabled,false);
 assert.equal(inspected.live_approved,false);
}finally{globalThis.fetch=fetch0;}
console.log('LYRA V2 shadow: 4h evidence, minute observations, crash, cooldown, gaps, loss-stop, R2, auth and no-orders PASS');
