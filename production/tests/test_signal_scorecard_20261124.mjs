// Signal scorecard: forward-only, signed outcomes, baseline/edge, missing data never estimated, sample floor, cap.
import assert from 'node:assert/strict';
import {emptyScorecard,detectEvents,updateScorecard,summarize,priceNear,scorecardTick,serveScorecard,SC_KEY,MIN_SAMPLE} from '../src/signature-scorecard.mjs';
const H=3600000,T0=Date.UTC(2026,10,24,0,0);
const item=(sym,sig4)=>({symbol:sym,coin:sym.slice(0,-4),regimes:{'1h':{status:'ok',signature:{coil:{breakout:null},divergence:null}},'4h':{status:'ok',signature:sig4}}});
// a 4H breakout up whose bar opened at T0 (closes T0+4h); an older one (before start) must be ignored
const scan={items:[item('SOLUSDT',{coil:{breakout:{direction:'up',bars_ago:0,time_ms:T0}},divergence:{direction:'bearish',bars_ago:0,time_ms:T0-8*H}}),
  item('BTCUSDT',{coil:{breakout:null},divergence:null})]};
const sc=emptyScorecard(T0);
let ev=detectEvents(scan,sc.started_ms);
assert.equal(ev.length,1,'only signals whose bar closed after start');assert.equal(ev[0].signal_ms,T0+4*H);assert.equal(ev[0].kind,'coil');
// hourly archive: SOL rises 10% after 24h, 5% after 72h; BTC (baseline member) rises 2% / 1%; 8 flat filler symbols
const pts=(p0,p24,p72)=>[[T0+4*H,p0],[T0+28*H,p24],[T0+76*H,p72]];
const roll={points:{SOLUSDT:pts(100,110,105),BTCUSDT:pts(50000,51000,50500)}};
for(let i=0;i<8;i++)roll.points['X'+i+'USDT']=pts(10,10,10);
updateScorecard(sc,scan,roll,T0+4*H+30*60000);
assert.equal(sc.events.length,1);assert.equal(sc.events[0].entry,undefined,'entry waits one hour after the close');
updateScorecard(sc,scan,roll,T0+5*H);assert.equal(sc.events[0].entry,100);
updateScorecard(sc,scan,roll,T0+29*H);
const o24=sc.events[0].outcomes[24];assert.equal(o24.ret,10);
// baseline over 10 symbols: (10 + 2 + 0*8)/10 = 1.2
assert.equal(o24.base,1.2);assert.equal(sc.events[0].outcomes[72],undefined,'72h not due yet');
updateScorecard(sc,scan,roll,T0+77*H);assert.equal(sc.events[0].outcomes[72].ret,5);
// re-detecting the same signal does not duplicate
updateScorecard(sc,scan,roll,T0+78*H);assert.equal(sc.events.length,1);
// a short (down) signal is signed: price falls 4% → +4
const s2=emptyScorecard(T0);const scan2={items:[item('ETHUSDT',{coil:{breakout:{direction:'down',time_ms:T0}},divergence:null})]};
const roll2={points:{ETHUSDT:pts(3000,2880,2900)}};for(let i=0;i<9;i++)roll2.points['Y'+i+'USDT']=pts(1,1,1);
updateScorecard(s2,scan2,roll2,T0+5*H);updateScorecard(s2,scan2,roll2,T0+77*H);
assert.equal(s2.events[0].outcomes[24].ret,4);
// missing price → marked missing (null), never estimated
const s3=emptyScorecard(T0);const roll3={points:{SOLUSDT:[[T0+4*H,100]]}};
updateScorecard(s3,scan,roll3,T0+5*H);updateScorecard(s3,scan,roll3,T0+40*H);
assert.equal(s3.events[0].outcomes[24],null);
// priceNear tolerance ±1h
assert.equal(priceNear([[T0,5]],T0+H),5);assert.equal(priceNear([[T0,5]],T0+H+1),null);
// summary: rates hidden below the sample floor, shown at/above it
let sum=summarize(sc,T0+80*H);const g=sum.groups.find(x=>x.tf==='4h'&&x.kind==='coil'&&x.dir==='up');
assert.equal(g.horizons[0].n,1);assert.equal(g.horizons[0].hit_rate_pct,null,'not enough samples');assert.equal(sum.backfilled,false);
for(let k=1;k<MIN_SAMPLE;k++){const e=JSON.parse(JSON.stringify(sc.events[0]));e.id+='#'+k;e.outcomes[24]={ret:k%4===0?-2:3,base:1};sc.events.push(e);}
sum=summarize(sc,T0+80*H);const h24=sum.groups.find(x=>x.tf==='4h'&&x.kind==='coil'&&x.dir==='up').horizons[0];
assert.equal(h24.n,MIN_SAMPLE);assert.ok(h24.enough&&h24.hit_rate_pct>70&&h24.edge_pct!==null);
assert.equal(sum.recent[0].outcomes[24],10);
// cron + serve with a fake R2
const store=new Map();const env={MARKET_DATA:{async get(k){const v=store.get(k);return v?{size:v.length,json:async()=>JSON.parse(v)}:null;},async put(k,v){store.set(k,v);}}};
let res=await serveScorecard(env,T0);assert.equal(res.status,503);
const t=await scorecardTick(env,scan,roll,T0+5*H);assert.ok(t.ok&&t.added===0,'fresh scorecard starts now → older bar not recorded');
res=await serveScorecard(env,T0+6*H);const body=await res.json();assert.ok(body.ok&&body.schema==='lumex_signature_scorecard_summary_v1'&&store.has(SC_KEY));
console.log('PASS signal scorecard: forward-only, signed outcomes, baseline edge, missing never estimated, sample floor, cron/serve');
