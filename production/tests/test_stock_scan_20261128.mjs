// 주식 신호 스캐너 (2026-11-28). QA 예시 prices only.
import assert from 'node:assert/strict';
import {analyse,stockScanTick,scanPayload,bearerOk,BATCH} from '../src/stock-scan.mjs';
import {stockHubRoute} from '../src/stock-hub.mjs';
import {replay} from '../src/paper-league-chartsig.mjs';
const H=3600000;
// a fall, a rise (long signal + 50% take), then a fall (opposite cross → exit) and a fresh short at the end
const mk=closes=>closes.map((x,i)=>({t:i*4*H,o:i?closes[i-1]:x,h:Math.max(x,i?closes[i-1]:x)+0.3,l:Math.min(x,i?closes[i-1]:x)-0.3,c:x,v:i===closes.length-1?5000:1000}));
const C=[];for(let i=0;i<150;i++)C.push(100-i*0.05);for(let i=0;i<60;i++)C.push(C.at(-1)+0.4);for(let i=0;i<90;i++)C.push(C.at(-1)-0.45);
const bars=mk(C);const a=analyse(bars);
assert.ok(a&&a.bar_t===bars.at(-1).t,'newest closed bar');
assert.equal(a.trend,'down');assert.ok(a.rsi<50&&a.vol_ratio===5&&a.atr_pct>0,'rsi / volume ratio / atr');
assert.ok(a.recent.length>=1,'closed trades listed');const t=a.recent.find(x=>x.side==='long');
assert.ok(t&&t.entry>0&&t.stop<t.entry&&t.target>t.entry&&t.exit&&t.exit.price>0,'long trade with entry, stop, target, exit price');
const rp=replay(bars);const lastExit=rp.events.filter(e=>['exit','stop','breakeven'].includes(e.type)).at(-1);
assert.equal(a.recent[0].result_pct,Number(lastExit.result_pct.toFixed(2)),'same result as the chart rule');
assert.ok(['take','cut','stop','breakeven'].includes(t.exit.type),'exit named in trading words');
if(t.exit.type==='take')assert.ok(t.result_pct>0);if(t.exit.type==='cut')assert.ok(t.result_pct<=0);
assert.equal(analyse(bars.slice(0,50)),null,'too few bars → nothing');
assert.ok(a.stats.trades===a.recent.length||a.stats.trades>=a.recent.length);
// tick: batches over the ranked list, cursor moves, failures keep nothing made up
const store=new Map();const bucket={get:async k=>store.has(k)?{json:async()=>JSON.parse(store.get(k))}:null,put:async(k,v)=>{store.set(k,String(v));}};
const env={MARKET_DATA:bucket,LUMEX_AI_LAB_WORKER_TOKEN:'k'.repeat(48)};
const items=[];for(let i=0;i<40;i++)items.push({symbol:'S'+i+'USDT',ticker:'S'+i,slug:'s'+i,name:'QA 예시 '+i,ranked:i!==5,turnover_24h_usd:1e9-i*1e6});
store.set('stock-hub/v1/radar.json',JSON.stringify({ok:true,items}));
const NOW=bars.at(-1).t+4*H+60000;let calls=0;
const fx=async url=>{calls++;const U=new URL(url),sym=U.searchParams.get('symbol'),iv=U.searchParams.get('interval');
  if(sym==='S3USDT')return {ok:false,status:403,text:async()=>''};
  const f=iv==='240'?4*H:H;const list=bars.map((b,i)=>[NOW-(bars.length-i)*f-f+60000,b.o,b.h,b.l,b.c,b.v].map(String)).reverse();
  return {ok:true,status:200,text:async()=>JSON.stringify({retCode:0,result:{list}})};};
let r=await stockScanTick(env,{now:NOW,fetchImpl:fx});assert.equal(r.done+r.failed,BATCH);assert.equal(r.failed,1,'S3 failed (403)');assert.equal(r.cursor,BATCH);assert.equal(r.total,39);
assert.equal(calls,BATCH*2,'two intervals per symbol');
let p=await scanPayload(env,NOW);assert.equal(p.status,200);assert.equal(p.body.count,BATCH-1,'failed symbol not listed');
assert.ok(p.body.items[0].symbol==='S0USDT'&&p.body.items[0].h4&&p.body.items[0].h1,'turnover order, both intervals');
assert.ok(!p.body.items.some(x=>x.symbol==='S5USDT'),'unranked never scanned');
r=await stockScanTick(env,{now:NOW+60000,fetchImpl:fx});assert.equal(r.cursor,BATCH*2);
r=await stockScanTick(env,{now:NOW+120000,fetchImpl:fx});assert.equal(r.cursor,(BATCH*3)%39,'wraps around');
p=await scanPayload(env,NOW+7*H);assert.equal(p.body.count,0,'older than 6 hours → dropped');
// route: bearer only
const req=(h)=>new Request('https://w.dev/stock-hub/v1/scan',{headers:h});
let res=await stockHubRoute(req({}),env,{now:NOW});assert.equal(res.status,401);
res=await stockHubRoute(req({authorization:'Bearer '+'k'.repeat(47)+'x'}),env,{now:NOW});assert.equal(res.status,401);
res=await stockHubRoute(req({authorization:'Bearer '+'k'.repeat(48)}),env,{now:NOW+180000});assert.equal(res.status,200);assert.equal(res.headers.get('access-control-allow-origin'),null,'not readable from browsers');
assert.equal(bearerOk(req({authorization:'Bearer x'}),{LUMEX_AI_LAB_WORKER_TOKEN:'short'}),false,'short token never accepted');
res=await stockHubRoute(new Request('https://w.dev/stock-hub/v1/scan-status'),env,{now:NOW+180000});const ss=await res.json();
assert.equal(res.status,200);assert.ok(ss.count>0&&ss.h4>0&&!('items' in ss),'status: counts only, public');
console.log('stock scan 20261128: all checks passed');
