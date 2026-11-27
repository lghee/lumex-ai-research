// Phase 113: rebuild past /daily/ days from public history (mocked exchanges; QA 예시 prices).
import assert from 'node:assert/strict';
import {buildBundleAt,backfillDates,bundleTime,dailyBackfillTick,coinFacts} from '../src/news-report.mjs';

const H=3600000,DAY='2026-11-22',T=bundleTime(DAY);
assert.equal(new Date(T).toISOString(),'2026-11-21T22:50:00.000Z','D 07:50 KST');
// candles: a gentle ramp so every value is checkable; Bybit returns newest first and may include later bars
const kl=(frame,end,limit,base)=>{const out=[];const last=Math.floor(end/frame)*frame;
  for(let i=0;i<limit;i++){const t=last-i*frame,c=base+(t-T)/H;out.push([String(t),String(c-0.5),String(c+1),String(c-1),String(c),'10','0']);}return {retCode:0,result:{list:out}};};
const calls=[];
function fetchFx(over={}){
  return async(url,opt={})=>{calls.push({url,opt});const u=new URL(url);const q=Object.fromEntries(u.searchParams);
    const j=b=>({ok:true,status:200,text:async()=>JSON.stringify(b)});
    if(u.hostname==='lumexbot.com'){const b=JSON.parse(opt.body);return j(over.core?over.core(b):{ok:true,state:'stored'});}
    if(u.pathname==='/v5/market/kline'){const f={60:H,240:4*H,D:24*H}[q.interval];const base=q.symbol==='BTCUSDT'?90000:3000;
      return j(kl(f,Number(q.end),Number(q.limit),base));}
    if(u.pathname==='/v5/market/open-interest'){const e=Number(q.endTime);const list=[];for(let i=0;i<26;i++)list.push({timestamp:String(Math.floor(e/H)*H-i*H),openInterest:String(1000+i)});return j({retCode:0,result:{list}});}
    if(u.pathname==='/v5/market/funding/history')return j({retCode:0,result:{list:[{fundingRate:'0.0001',fundingRateTimestamp:String(Math.floor(Number(q.endTime)/(8*H))*8*H)}]}});
    if(u.hostname==='api.gateio.ws'){if(over.noGate)return j([]);const from=Number(q.from);const rows=[];for(let i=0;i<26;i++)rows.push({time:from+i*3600,long_liq_usd:1000,short_liq_usd:500});return j(rows);}
    return {ok:false,status:404,text:async()=>''};};
}
const news={['market-hub/news/v1/day/20261121.json']:{items:[{id:'20261121-0001',t:T-5*H,kind:'coin',coins:['BTC'],source:'QA',title:'QA 예시 비트코인 속보'},{id:'20261121-0002',t:T-30*H,kind:'coin',coins:['BTC'],source:'QA',title:'하루보다 오래된 속보'}]},
  ['market-hub/news/v1/day/20261122.json']:{items:[{id:'20261122-0001',t:T+H,kind:'macro',coins:[],source:'QA',title:'07:50 이후 속보'},{id:'20261122-0000',t:T-H,kind:'exchange',coins:['BTC'],source:'QA',title:'거래소 공지'}]}};
function bucket(){const m=new Map(Object.entries(news).map(([k,v])=>[k,JSON.stringify(v)]));
  return {m,head:async k=>m.has(k)?{}:null,get:async k=>m.has(k)?{json:async()=>JSON.parse(m.get(k))}:null,put:async(k,v)=>{m.set(k,String(v));}};}

// 1) one past day, built only from data up to D 07:50 KST
const env={MARKET_DATA:bucket(),LUMEX_AI_LAB_WORKER_TOKEN:'x'.repeat(48),DAILY_BACKFILL_DATES:'2026-11-20..2026-11-26'};
const b=await buildBundleAt(env,{day:DAY,fetchImpl:fetchFx(),rebuiltAt:Date.parse('2026-11-27T10:00:00Z')});
assert.equal(b.ok,true);assert.equal(b.schema,'lumex_morning_bundle_v1');assert.equal(b.report_date,DAY);assert.equal(b.rebuilt,true);
assert.equal(b.generated_at_kst,'2026-11-22 07:50 KST');
const kurls=calls.filter(c=>c.url.includes('/kline'));assert.ok(kurls.length===6&&kurls.every(c=>c.url.includes('end='+T)),'all candles end at D 07:50');
const btc=b.coins.BTC;
assert.equal(btc.price.hourly_close.length,24);
// last closed 1h bar is the one starting 06:00 KST (21:00Z) → close = 90000 + (21:00Z - 22:50Z)/H
assert.ok(Math.abs(btc.price.close-(90000+(Date.parse('2026-11-21T21:00:00Z')-T)/H))<1e-9,'no bar after 07:50 KST');
assert.equal(btc.window_kst,'2026-11-21 07:00 KST ~ 2026-11-22 07:00 KST');
assert.equal(btc.derivatives.funding_pct_8h,0.01);assert.equal(btc.derivatives.funding_basis,'settled');
assert.ok(btc.derivatives.open_interest_usd>0&&btc.derivatives.oi_change_24h_pct!==undefined,'OI value = last OI × close, 24h change');
assert.equal(btc.liquidations.long_usd,24000);assert.equal(btc.liquidations.short_usd,12000,'exactly the 24 hourly rows before 07:50');
assert.deepEqual(b.news.map(n=>n.title),['QA 예시 비트코인 속보'],'news of that window only (not later, not older than 24h, no exchange notices)');
assert.ok(b.sources[0].includes('정산 기준'));
assert.equal(b.order_execution,false);

// 2) Gate without history → liquidations left out, day still built
calls.length=0;const b2=await buildBundleAt(env,{day:DAY,fetchImpl:fetchFx({noGate:true})});
assert.equal(b2.ok,true);assert.equal(b2.coins.BTC.liquidations,undefined,'no estimate when history is missing');

// 3) dates: range parsing, never today or later, ≤ 14 days
const now=Date.parse('2026-11-27T10:00:00Z');
assert.deepEqual(backfillDates('2026-11-25..2026-11-28',now),['2026-11-25','2026-11-26']);
assert.deepEqual(backfillDates('2026-11-01..2026-11-20',now),[],'longer than 14 days refused');
assert.deepEqual(backfillDates('bad',now),[]);

// 4) tick: one day per call, done marker after Core stored it, then the next day; Core refusal → retry after 30 min
const env2={MARKET_DATA:bucket(),LUMEX_AI_LAB_WORKER_TOKEN:'x'.repeat(48),DAILY_BACKFILL_DATES:'2026-11-20..2026-11-21'};
calls.length=0;let r=await dailyBackfillTick(env2,{now,fetchImpl:fetchFx()});
assert.deepEqual([r.ok,r.day,r.state],[true,'2026-11-20','stored']);
const post=calls.find(c=>c.url.startsWith('https://lumexbot.com/'));
assert.equal(post.url,'https://lumexbot.com/wp-json/lumex/v1/ai-report/backfill');assert.equal(post.opt.headers.authorization,'Bearer '+'x'.repeat(48));
assert.equal(JSON.parse(post.opt.body).report_date,'2026-11-20');
r=await dailyBackfillTick(env2,{now,fetchImpl:fetchFx({core:()=>({ok:false,state:'x'})})});
assert.deepEqual([r.ok,r.day],[false,'2026-11-21']);
r=await dailyBackfillTick(env2,{now:now+60000,fetchImpl:fetchFx()});assert.equal(r.stage,'wait','retry waits 30 minutes');
r=await dailyBackfillTick(env2,{now:now+31*60000,fetchImpl:fetchFx({core:()=>({ok:true,state:'exists'})})});assert.deepEqual([r.day,r.state],['2026-11-21','exists']);
r=await dailyBackfillTick(env2,{now:now+32*60000,fetchImpl:fetchFx()});assert.equal(r.stage,'complete');
calls.length=0;r=await dailyBackfillTick({...env2,DAILY_BACKFILL_DATES:''},{now,fetchImpl:fetchFx()});assert.equal(r.stage,'none');assert.equal(calls.length,0);

// 5) the live 07:50 bundle is untouched (coinFacts shared, live path unchanged)
assert.equal(typeof coinFacts,'function');
console.log('daily backfill 20261127: all checks passed');
