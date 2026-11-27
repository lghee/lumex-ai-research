// TREND · 변동성 조절: parity with the Python research (book multiplier + per-coin weights on real 10-coin 4H closes),
// same signals as TREND, 2x cap, stateless decide, registered last in the league.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {trendvt,weightSeries,bookScale,BOOK_CAP} from '../src/paper-league-trendvt.mjs';
import {trend,targetWeight,TREND_SYMBOLS} from '../src/paper-league-trend.mjs';
import {STRATEGIES} from '../src/paper-league.mjs';
const fx=JSON.parse(readFileSync(new URL('./fixtures_trendvt_10c_4h.json',import.meta.url)));
const COINS=['BTC','ETH','SOL','XRP','DOGE','BNB','ADA','LINK','AVAX','SUI'];
for(const cut of fx.cuts){
  const series=COINS.map(c=>cut.closes[c]);
  const b=bookScale(series);
  assert.ok(Math.abs(b.k-cut.k)<1e-3,`book k ${b.k} vs ${cut.k}`);
  assert.ok(Math.abs(b.vol_pct/100-cut.vol)<1e-3,'book vol');
  COINS.forEach((c,j)=>{const w=weightSeries(series[j]).at(-1);assert.ok(Math.abs(w-cut.w_last[j])<1e-6,`weight ${c}`);
    const t=targetWeight(series[j]);assert.ok(Math.abs(Math.abs(w)-t.weight)<1e-4&&(w>0?'long':w<0?'short':null)===t.side,'same as TREND targetWeight');});
  // decide(): weights = TREND weight × k, same sides as TREND
  const by=Object.fromEntries(TREND_SYMBOLS.map((s,j)=>[s,series[j].map((c,i)=>({t:i*14400000,o:c,h:c,l:c,c}))]));
  const market={async bars(s){return by[s]||null;}};
  const a=await trendvt.decide({market}),t=await trend.decide({market});
  assert.equal(a.target.length,t.target.length);
  for(const l of a.target){const m=t.target.find(x=>x.symbol===l.symbol);assert.equal(l.side,m.side);assert.ok(Math.abs(l.weight-m.weight*b.k)<2e-4,'scaled by k');assert.equal(l.stop_pct,0.12);}
  assert.ok(a.target.reduce((s,l)=>s+l.weight,0)<=BOOK_CAP+1e-9);
}
// cap: a calm book is never scaled past 2x
const calm=COINS.map((_,j)=>Array.from({length:1000},(_,i)=>100*(1+0.0004*i+0.0003*Math.sin(i/3+j))));
assert.ok(bookScale(calm).k<=BOOK_CAP);
// missing coins keep positions; too few coins → error
const few={async bars(s){return s==='BTCUSDT'?fx.cuts[0].closes.BTC.map(c=>({c})):null;}};
assert.equal((await trendvt.decide({market:few})).error,'4시간봉 자료 부족');
const d=STRATEGIES.find(x=>x.id==='trend-voltarget-4h');assert.ok(d&&d.leverage===2&&d.resize===true&&d.interval==='240'&&d.rules.length>=3);
assert.equal(STRATEGIES.at(-1).id,'trend-voltarget-4h','appended last');
console.log(`PASS paper-league TREND · 변동성 조절: Python parity on ${fx.cuts.length} cuts (book k, vol, 10 weights), same sides as TREND, ×k sizing, 2x cap`);
