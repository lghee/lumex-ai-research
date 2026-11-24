// TREND+ · 쏠림 브레이크: percentile parity with the research rule, brake only on the crowded side, TREND otherwise,
// no brake without history; ledger carries take_frac for SIGNAL partial targets.
import assert from 'node:assert/strict';
import {fundingPercentile,crowded,trendcrowd,CROWD_MIN} from '../src/paper-league-trendcrowd.mjs';
import {trend,TREND_SYMBOLS} from '../src/paper-league-trend.mjs';
import {STRATEGIES} from '../src/paper-league.mjs';
import {legsOf} from '../src/paper-league-signals.mjs';
const H8=8*3600000,now=Date.UTC(2026,10,24,9,5);
// 1) percentile: ties half, window = prior 30 days only, < 20 rows → null
const rows=Array.from({length:120},(_,i)=>({t:now-(120-i)*H8,rate:0.0001*((i+5)%10)}));
const last=rows.at(-1),win=rows.filter(x=>x.t>=last.t-30*86400000&&x.t<last.t);
const below=win.filter(x=>x.rate<last.rate).length,eq=win.filter(x=>x.rate===last.rate).length;
assert.equal(fundingPercentile(rows,now),(below+eq/2)/win.length*100);
assert.equal(fundingPercentile(rows.slice(-CROWD_MIN),now),null,'too little history');
assert.equal(fundingPercentile([...rows,{t:now+H8,rate:1}],now),fundingPercentile(rows,now),'future rows ignored');
const hot=[...rows.slice(0,-1),{t:last.t,rate:0.01}];assert.ok(fundingPercentile(hot,now)>=95);
// 2) brake side: long braked at the top, short at the bottom, never the other way
assert.ok(crowded('long',96)&&!crowded('short',96)&&crowded('short',4)&&!crowded('long',4)&&!crowded('long',null));
// 3) decide(): same as TREND, minus crowded legs; held flat with a reason; same rules + brake line
const up=Array.from({length:400},(_,i)=>100*Math.exp(i*0.002+Math.sin(i)*0.003)),H4=4*3600000;
const mk=k=>Array.from({length:600},(_,i)=>{const c=(k%2?1e4/up[i%400]:up[i%400])*(1+k);return {t:now-(600-i+1)*H4,o:c,h:c*1.002,l:c*0.998,c,v:1};});
const base={now,async bars(s){return mk(TREND_SYMBOLS.indexOf(s));}};
const t0=await trend.decide({market:{...base}});
const market={...base,async funding(s){if(s==='ETHUSDT')return null;const leg=t0.target.find(l=>l.symbol===s);
  if(s==='BTCUSDT'||s==='SOLUSDT'){const v=leg?.side==='long'?0.01:-0.01;return [...rows.slice(0,-1),{t:last.t,rate:v}];}return rows;}};
const out=await trendcrowd.decide({market});
const braked=t0.target.filter(l=>['BTCUSDT','SOLUSDT'].includes(l.symbol)).map(l=>l.symbol);
assert.ok(braked.length>=1,'fixture has a crowded leg');
assert.deepEqual(out.target.map(l=>l.symbol).sort(),t0.target.filter(l=>!braked.includes(l.symbol)).map(l=>l.symbol).sort());
assert.ok(out.target.every(l=>{const b=t0.target.find(x=>x.symbol===l.symbol);return b.weight===l.weight&&b.side===l.side&&b.stop_pct===l.stop_pct;}));
assert.ok(out.diag.crowd.braked.length===braked.length&&out.diag.crowd.no_funding_history.includes('ETHUSDT')&&out.exit_reason==='펀딩 쏠림 · 쉬기');
assert.ok(trendcrowd.rules.length===trend.rules.length+1&&trendcrowd.interval==='60'&&trendcrowd.id==='trend-crowd-4h');
assert.ok(STRATEGIES.some(d=>d.id==='trend-crowd-4h'));
// 4) ledger: SIGNAL partial target carries take_frac; plain take does not
const acc={equity:10000,positions:{BTCUSDT:{symbol:'BTCUSDT',side:'long',qty:0.01,entry:100000,last_mark:100000,stop:99000,take:101000,take_frac:0.5},
  ETHUSDT:{symbol:'ETHUSDT',side:'short',qty:0.3,entry:3000,last_mark:3000,stop:3300,take:2800}}};
const legs=legsOf(acc);assert.equal(legs.find(l=>l.symbol==='BTCUSDT').take_frac,0.5);assert.equal(legs.find(l=>l.symbol==='ETHUSDT').take_frac,undefined);
console.log('PASS paper-league TREND+ crowding brake: percentile parity, crowded side only, TREND otherwise, no history → no brake; ledger take_frac');
