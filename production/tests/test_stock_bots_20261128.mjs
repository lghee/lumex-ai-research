// AI 봇 주식 계좌 + 주식 고래 상세 (2026-11-28). Simulated only; QA 예시 prices.
import assert from 'node:assert/strict';
import {stockStrategies,pickBasket,stockLeagueTick,leaguePayload,leagueDetail,leagueTrades,BASKET_SIZE} from '../src/stock-league.mjs';
import {groupFills,detailPositions,whaleDetail} from '../src/stock-whales.mjs';
import {stockHubRoute} from '../src/stock-hub.mjs';
const store=new Map();const bucket={get:async k=>store.has(k)?{json:async()=>JSON.parse(store.get(k))}:null,put:async(k,v)=>{store.set(k,String(v));}};
const env={MARKET_DATA:bucket};const put=(k,v)=>store.set(k,JSON.stringify(v));const get=k=>JSON.parse(store.get(k)||'null');
// basket: ranked only, by turnover, 10
const items=[];for(let i=0;i<14;i++)items.push({symbol:'S'+i+'USDT',ranked:i!==2,turnover_24h_usd:1e9-i*1e7});
items.push({symbol:'BAD SYMBOL',ranked:true,turnover_24h_usd:9e12});
assert.deepEqual(pickBasket({items}),['S0USDT','S1USDT','S3USDT','S4USDT','S5USDT','S6USDT','S7USDT','S8USDT','S9USDT','S10USDT']);
const [def]=stockStrategies(pickBasket({items}));
assert.equal(def.id,'stock-chart-4h');assert.equal(def.interval,'240');assert.equal(def.symbols.length,BASKET_SIZE);assert.match(def.symbols_label,/등 10종목$/);
// a 4H series where EMA20 crosses above EMA50 on the newest closed bar with RSI ≥ 50 → enter long at the next open
const H4=4*3600000,NOW=Date.parse('2026-11-30T08:02:00Z'),lastBar=Math.floor(NOW/H4)*H4-H4;
import {replay} from '../src/paper-league-chartsig.mjs';
// closes: a slow fall, then a rise; cut right at the first long signal so it is the newest closed bar
const CLOSES=(()=>{const c=[];for(let i=0;i<180;i++)c.push(100-i*0.05);for(let i=0;i<60;i++)c.push(c.at(-1)+0.35);
  const bars=c.map((x,i)=>({t:i,o:x,h:x+0.4,l:x-0.4,c:x}));const sig=replay(bars).events.find(e=>e.type==='signal'&&e.side==='long');return c.slice(0,sig.t+1);})();
function series(cross){const c=cross?CLOSES:CLOSES.map((_,i)=>100-i*0.05);const n=c.length;return c.map((x,i)=>[lastBar-(n-1-i)*H4,x,x+0.4,x-0.4,x,1000]);}
let mode='cross';const calls=[];
const fx=async url=>{calls.push(url);const U=new URL(url);const sym=U.searchParams.get('symbol');
  const ok=b=>({ok:true,status:200,text:async()=>JSON.stringify(b)});
  if(U.pathname.endsWith('/kline')){const iv=U.searchParams.get('interval');
    if(iv==='240'){const s=series(mode==='cross'&&sym==='S0USDT');return ok({retCode:0,result:{list:s.slice().reverse().map(r=>r.map(String))}});}
    if(iv==='1'){const from=Number(U.searchParams.get('start'));const list=[];for(let t=from;t+60000<=NOW;t+=60000)list.push([t,110,110.2,109.8,110,10].map(String));return ok({retCode:0,result:{list:list.reverse()}});}}
  if(U.pathname.endsWith('/tickers'))return ok({retCode:0,result:{list:[{symbol:sym,lastPrice:'110',markPrice:'110'}]}});
  if(U.pathname.endsWith('/funding/history'))return ok({retCode:0,result:{list:[]}});
  return {ok:false,status:404,text:async()=>''};};
// no radar → no basket → not started
let r=await stockLeagueTick(env,{now:NOW,fetchImpl:fx});assert.deepEqual(r,{ok:false,reason:'no_basket'});
put('stock-hub/v1/radar.json',{items});
r=await stockLeagueTick(env,{now:NOW-H4,fetchImpl:fx});assert.equal(r.ok,true,'first tick creates the account (decides from the next closed bar)');
let st=get('stock-league/v1/state.json');assert.equal(st.basket.length,10);assert.equal(st.accounts['stock-chart-4h'].equity,10000);
assert.equal(Object.keys(st.accounts['stock-chart-4h'].positions).length,0,'nothing at start');
r=await stockLeagueTick(env,{now:NOW,fetchImpl:fx});assert.equal(r.ok,true);
st=get('stock-league/v1/state.json');const acc=st.accounts['stock-chart-4h'];
assert.deepEqual(Object.keys(acc.positions),['S0USDT'],'only the symbol whose newest closed 4H bar crossed');
const p=acc.positions.S0USDT;assert.equal(p.side,'long');assert.ok(p.stop<p.entry&&p.take>p.entry,'1R stop and 1R take');assert.equal(p.take_frac,0.5);assert.ok(Math.abs(p.qty*p.entry-1000)<5,'10% of 10,000 USDT');
assert.equal(r.ok,true);assert.equal(await stockLeagueTick(env,{now:NOW+60000,fetchImpl:fx}).then(x=>x.skipped),'recent_tick');
// payloads
let pl=await leaguePayload(env,NOW+60000);assert.equal(pl.status,200);assert.equal(pl.body.strategies[0].positions.length,1);assert.equal(pl.body.order_execution,false);
assert.equal((await leaguePayload(env,NOW+31*60000)).status,503,'stale summary not served');
let dt=await leagueDetail(env,'stock-chart-4h');assert.equal(dt.status,200);assert.equal(dt.body.trades[0].type,'open');
assert.equal((await leagueDetail(env,'../x')).status,400);assert.equal((await leagueDetail(env,'nope')).status,404);
let tr=await leagueTrades(env,'S0USDT');assert.equal(tr.body.trades.length,1);assert.equal(tr.body.open[0].side,'long');
assert.equal((await leagueTrades(env,'s0usdt')).status,400);
// coin paper league keys untouched
assert.ok(![...store.keys()].some(k=>k.startsWith('paper-league/')),'separate from the coin paper league');
// routes
let res=await stockHubRoute(new Request('https://w.dev/stock-hub/v1/bots'),env,{now:NOW+60000});assert.equal(res.status,200);assert.equal(res.headers.get('access-control-allow-origin'),'*');
res=await stockHubRoute(new Request('https://w.dev/stock-hub/v1/bots-trades?symbol=s0usdt'),env,{now:NOW+60000});assert.equal(res.status,200,'symbol upper-cased by the route');

// whale detail
const markets=[{coin:'xyz:NVDA',ticker:'NVDA',slug:'nvda',name:'NVIDIA'},{coin:'xyz:TSLA',ticker:'TSLA',slug:'tsla',name:'Tesla'}];
const T0=1795800000000;
const fills=[{coin:'xyz:NVDA',px:'150',sz:'100',time:T0,dir:'Open Short',closedPnl:'0',fee:'1'},{coin:'xyz:NVDA',px:'152',sz:'100',time:T0+60000,dir:'Open Short',closedPnl:'0',fee:'1'},
  {coin:'xyz:NVDA',px:'149',sz:'50',time:T0+3600000,dir:'Close Short',closedPnl:'125',fee:'0.5'},{coin:'xyz:XYZ100',px:'26000',sz:'1',time:T0,dir:'Open Short',closedPnl:'0',fee:'1'},
  {coin:'BTC',px:'90000',sz:'1',time:T0,dir:'Open Long',closedPnl:'0',fee:'1'},{coin:'xyz:TSLA',px:'400',sz:'10',time:T0+20*60000,dir:'Open Long',closedPnl:'0',fee:'0.2'}];
const g=groupFills(fills,markets);
assert.equal(g.length,3,'two NVDA fills within 10 min → one order; index and coin fills dropped');
assert.equal(g[0].action,'close');assert.equal(g[0].closed_pnl_usd,125);assert.equal(g[2].price,151);assert.equal(g[2].size,200);assert.equal(g[2].value_usd,30200);assert.equal(g[2].side,'short');assert.equal(g[2].fills,2);
const state={marginSummary:{accountValue:'1000000',totalMarginUsed:'200000'},assetPositions:[
  {position:{coin:'xyz:NVDA',szi:'-1000',entryPx:'150',positionValue:'140000',unrealizedPnl:'10000',returnOnEquity:'0.357',liquidationPx:'500',marginUsed:'28000',leverage:{value:5},cumFunding:{sinceOpen:'-300'}}},
  {position:{coin:'xyz:XYZ100',szi:'-1',entryPx:'26000',positionValue:'26000',unrealizedPnl:'0'}}]};
const dp=detailPositions(state,markets);
assert.equal(dp.length,1);assert.equal(dp[0].mark_price,140);assert.equal(dp[0].move_pct,6.67,'short gains when price falls');assert.equal(dp[0].roe_pct,35.7);assert.equal(dp[0].funding_since_open_usd,300,'funding received shown as +');
put('stock-hub/v1/whales/markets.json',{markets});put('stock-hub/v1/whales/state.json',{positions:{'0x46921f6961bdb411b756c9712f6bdb58fbd9164f':{rows:[]}},candidates:{},events:[{address:'0x46921f6961bdb411b756c9712f6bdb58fbd9164f',ticker:'NVDA',side:'short',kind:'new',value_usd:3e7,detected_ms:T0,r1h:false}]});
const hl=async(url,o)=>{const b=JSON.parse(o.body);return {ok:true,status:200,text:async()=>JSON.stringify(b.type==='clearinghouseState'?state:fills)};};
let w=await whaleDetail(env,'0x46921F6961bdb411b756c9712f6bdb58fbd9164f',{now:T0+7200000,fetchImpl:hl});
assert.equal(w.status,200);assert.equal(w.body.address,'0x46921f6961bdb411b756c9712f6bdb58fbd9164f');assert.equal(w.body.positions.length,1);assert.equal(w.body.fills.length,3);assert.equal(w.body.events[0].r1h,null);
assert.equal(w.body.stock_value_usd,140000);assert.equal(w.body.account_value_usd,1000000);
let n=0;const count=async(u,o)=>{n++;return hl(u,o);};w=await whaleDetail(env,'0x46921f6961bdb411b756c9712f6bdb58fbd9164f',{now:T0+7230000,fetchImpl:count});assert.equal(n,0,'kept 60 s');
assert.equal((await whaleDetail(env,'0x0000000000000000000000000000000000000001',{now:T0,fetchImpl:hl})).status,404,'untracked address not looked up');
assert.equal((await whaleDetail(env,'0xzz',{now:T0,fetchImpl:hl})).status,400);
const down=async()=>{throw Error('down');};w=await whaleDetail(env,'0x46921f6961bdb411b756c9712f6bdb58fbd9164f',{now:T0+7300000,fetchImpl:down});assert.equal(w.body.stale,true,'source down → last copy marked stale');
console.log('stock bots + whale detail 20261128: all checks passed');
