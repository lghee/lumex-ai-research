// Phase 111 public records: LUMEX 4H signal record (losses included, fees, open trade hidden) and whale cases.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {replay} from '../src/paper-league-chartsig.mjs';
import {tradesFromBars,recordStats,buildRecord,tradeId,tradeWindow,collectSignalRecord,casesFromProfile,applyCheck,caseStats,
  bybitSymbol,priceAt,collectWhaleCases,growthRoute,FEE_ROUND_PCT,WHALE_MIN_USD,ROOT} from '../src/growth-records.mjs';

const fx=JSON.parse(readFileSync(new URL('./fixtures_chartsig_btc_4h.json',import.meta.url)));
const bars=fx.bars.map(([t,o,h,l,c])=>({t:t*1000,o,h,l,c}));

// 1) trades = the replay's closed trades, one by one, fee deducted, ids in KST
const {trades,open}=tradesFromBars('BTC',bars);
const closed=replay(bars).events.filter(e=>['stop','breakeven','exit'].includes(e.type));
assert.equal(trades.length,closed.length,'every finished trade is listed (losses included)');
assert.equal(trades.length,fx.py_trade_results.length,'same count as the research engine');
trades.forEach((t,i)=>{
  assert.ok(Math.abs(t.gross_pct-fx.py_trade_results[i]*100)<1e-3,'gross parity '+i);
  assert.ok(Math.abs(t.net_pct-(t.gross_pct-FEE_ROUND_PCT))<1e-3,'fee 0.11% round trip');
  assert.equal(t.result,t.net_pct>0?'win':'loss');
  assert.ok(t.entry_t>t.signal_t&&t.exit_t>=t.entry_t&&t.entry>0&&t.exit>0);
  assert.match(t.id,/^btc-\d{8}-\d{2}$/);
});
assert.ok(trades.some(t=>t.result==='loss')&&trades.some(t=>t.result==='win'),'wins and losses both present');
assert.ok(trades.some(t=>t.reversal)||trades.every(t=>!t.reversal),'reversal flag computed');
assert.equal(tradeId('BTC',Date.UTC(2026,10,25,8)),'btc-20261125-17','KST id');
if(open){assert.deepEqual(Object.keys(open).sort(),['coin','since_t'],'open trade exposes no side or price');}

// 2) stats
const s=recordStats(trades);
assert.equal(s.trades,trades.length);assert.equal(s.wins+s.losses,s.trades);
assert.ok(Math.abs(s.win_rate_pct-s.wins/s.trades*100)<0.01);
assert.ok(s.avg_win_pct>0&&s.avg_loss_pct<=0&&s.worst_pct<=s.best_pct);
assert.deepEqual(recordStats([]).trades,0);assert.equal(recordStats([]).win_rate_pct,null);

// 3) buildRecord needs all four coins; period stats nest
const by={BTC:bars,ETH:bars,SOL:bars,XRP:bars},now=bars.at(-1).t+4*3600000+300000;
const rec=buildRecord(by,now);
assert.equal(rec.ok,true);assert.equal(rec.trades.length,trades.length*4);
assert.ok(rec.stats.d30.trades<=rec.stats.d90.trades&&rec.stats.d90.trades<=rec.stats.all.trades);
assert.ok(rec.trades.every((t,i)=>i===0||rec.trades[i-1].exit_t>=t.exit_t),'newest first');
assert.equal(buildRecord({BTC:bars},now).ok,false,'incomplete coins → not ok');
const w=tradeWindow(trades[5],fx.bars.map(([t,o,h,l,c])=>[t*1000,o,h,l,c]));
assert.ok(w&&w.length<=110&&w.some(b=>b[0]===trades[5].entry_t)&&w.some(b=>b[0]===trades[5].exit_t));

// 4) cron: recompute only once per closed 4H bar; R2 mock
function bucket(){const m=new Map();return {m,async get(k){const v=m.get(k);return v?{json:async()=>JSON.parse(v)}:null;},async put(k,v){m.set(k,v);},async head(k){return m.has(k)?{}:null;}};}
const B=bucket();let calls=0;
const kl=n=>({retCode:0,result:{list:bars.slice(-n).map(b=>[String(b.t),String(b.o),String(b.h),String(b.l),String(b.c),'1']).reverse()}});
const fetchK=async u=>{calls++;return {ok:true,text:async()=>JSON.stringify(kl(1000))};};
let r=await collectSignalRecord({MARKET_DATA:B},{now,fetchImpl:fetchK});
assert.equal(r.stage,'computed');assert.equal(calls,4);
r=await collectSignalRecord({MARKET_DATA:B},{now:now+3600000,fetchImpl:fetchK});
assert.equal(r.stage,'fresh');assert.equal(calls,4,'no upstream call before the next bar closes');
// routes
let res=await growthRoute(new Request('https://w/market-hub/v1/chart-signals/record'),{MARKET_DATA:B});
let j=await res.json();assert.equal(j.ok,true);assert.equal(j.trades.length,trades.length*4);
res=await growthRoute(new Request('https://w/market-hub/v1/chart-signals/trade?id='+trades[3].id),{MARKET_DATA:B});
j=await res.json();assert.equal(j.ok,true);assert.equal(j.trade.id,trades[3].id);assert.ok(j.bars.length>10&&j.same_coin.length<=6);
res=await growthRoute(new Request('https://w/market-hub/v1/chart-signals/trade?id=../x'),{MARKET_DATA:B});assert.equal(res.status,400);
res=await growthRoute(new Request('https://w/market-hub/v1/chart-signals/trade?id=btc-20000101-01'),{MARKET_DATA:B});assert.equal(res.status,404);

// 5) whale cases: only US$1M+ openings of supported coins, every outcome kept
assert.equal(bybitSymbol('BTC'),'BTCUSDT');assert.equal(bybitSymbol('kPEPE'),'1000PEPEUSDT');assert.equal(bybitSymbol('xyz:TSLA'),null);assert.equal(bybitSymbol('@107'),null);
const T=Date.UTC(2026,10,26,3,7,20),N=T+30*3600000;
const prof={address:'0x'+'a'.repeat(40),fills:[
  {id:'1',coin:'BTC',ts:T,price:90000,size:20,direction:'Open Long',value_usd:1800000},
  {id:'2',coin:'ETH',ts:T,price:3000,size:100,direction:'Open Short',value_usd:300000},           // too small
  {id:'3',coin:'SOL',ts:T,price:200,size:9000,direction:'Close Long',value_usd:1800000},          // a close, not an opening
  {id:'4',coin:'ETH',ts:T+60000,price:3000,size:500,direction:'Long > Short',value_usd:1500000},  // flip → short
  {id:'5',coin:'xyz:TSLA',ts:T,price:300,size:9000,direction:'Open Long',value_usd:2700000}]};
const row={address:prof.address,equity_usd:25000000,windows:{month:{pnl_usd:1200000}}};
const cs=casesFromProfile(prof,row,N,new Set());
assert.deepEqual(cs.map(c=>[c.id,c.side]),[['1','long'],['4','short']]);
assert.equal(cs[0].value_usd,1800000);assert.equal(cs[0].equity_usd,25000000);assert.ok(WHALE_MIN_USD===1e6);
const c1=applyCheck({...cs[1],base:3000},'h24',2900);assert.equal(c1.after.h24.with_whale_pct,3.33,'short wins when price falls');
const c0=applyCheck({...cs[0],base:90000},'h24',89100);assert.equal(c0.after.h24.with_whale_pct,-1,'loss kept as negative');
const st=caseStats([c0,c1]);assert.equal(st.checked_24h,2);assert.equal(st.with_whale_24h,1);assert.equal(st.with_whale_24h_pct,50);
// priceAt reads the exact minute; 10001 = no such market
const pf=async u=>({ok:true,json:async()=>{const t=Number(new URL(u).searchParams.get('start'));return {retCode:0,result:{list:[[String(t),'100.5','101','100','100.7','9']]}};}});
assert.equal(await priceAt(pf,'BTCUSDT',T),100.5);
assert.equal(await priceAt(async()=>({ok:true,json:async()=>({retCode:10001})}),'NOPEUSDT',T),false);
// collect: board + profile in R2, all checkpoints due
const W=bucket();
await W.put('market-hub/hyperliquid-whales/v1/latest.json',JSON.stringify({rows:[row]}));
await W.put('market-hub/hyperliquid-whales/v1/profiles/'+prof.address+'.json',JSON.stringify(prof));
let wr=await collectWhaleCases({MARKET_DATA:W},{now:N,fetchImpl:pf});
assert.equal(wr.added,2);
wr=await collectWhaleCases({MARKET_DATA:W},{now:N+60000,fetchImpl:pf});assert.equal(wr.added,0,'no duplicates');
const saved=JSON.parse(W.m.get(ROOT+'whale-cases.json'));
assert.ok(saved.items.every(c=>c.status==='done'&&c.after.h1&&c.after.h4&&c.after.h24));
res=await growthRoute(new Request('https://w/market-hub/v1/whale-cases'),{MARKET_DATA:W});j=await res.json();
assert.equal(j.ok,true);assert.equal(j.items.length,2);assert.equal(j.stats.checked_24h,2);assert.ok(!('tries' in j.items[0]));
console.log('PASS growth records: signal record parity + fees + open hidden + once per bar; whale cases US$1M+ openings, 1h/4h/24h, every outcome kept');
