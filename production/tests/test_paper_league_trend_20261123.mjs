// TREND · 4H EMA ensemble: math parity with the research backtest, sizing bounds, ledger limits, e2e decide.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ensembleSignal,annualVol,targetWeight,trend,TREND_SYMBOLS,STOP_PCT} from '../src/paper-league-trend.mjs';
import {STRATEGIES,runStrategy,newAccount} from '../src/paper-league.mjs';

// 1) parity with the Python research engine on real BTC 4H closes (fixture = last 1000 OKX bars, 2026-11-22)
const fx=JSON.parse(readFileSync(new URL('./fixtures_trend_btc_4h.json',import.meta.url)));
assert.equal(ensembleSignal(fx.closes),fx.sig,'signal parity');
assert.ok(Math.abs(annualVol(fx.closes)-fx.vol)<1e-9,'volatility parity');
assert.ok(Math.abs(targetWeight(fx.closes).weight-Number(fx.w.toFixed(4)))<1e-4,'weight parity');

// 2) shape: rising series → long, falling → short, too short → null
const up=Array.from({length:400},(_,i)=>100*Math.exp(i*0.002+Math.sin(i)*0.003));
const dn=up.map(x=>1e4/x);
assert.equal(targetWeight(up).side,'long');assert.equal(targetWeight(dn).side,'short');
assert.equal(targetWeight(up.slice(0,100)),null);
// 3) sizing: never above 1/10 per coin; high volatility shrinks it
const wild=up.map((x,i)=>x*(1+(i%2?0.06:-0.06)));
assert.ok(targetWeight(up).weight<=0.1+1e-12);assert.ok(targetWeight(wild).weight<targetWeight(up).weight);

// 4) decide(): 10 legs max, Core ledger limits (weight ≤ 0.6, gross ≤ 1.6), stop attached, missing data kept
const H4=4*3600000,now=Date.UTC(2026,10,23,9,3);
const mk=(f)=>Array.from({length:600},(_,i)=>{const c=f(i);return {t:now-(600-i+1)*H4,o:c,h:c*1.002,l:c*0.998,c,v:1};});
const market={now,async bars(s){if(s==='SUIUSDT')return null;const k=TREND_SYMBOLS.indexOf(s);return mk(i=>(k%2?1e4/up[i%400+0]:up[i%400])*(1+k));}};
const out=await trend.decide({market});
assert.ok(out.target.length<=10&&out.target.length>=8);
const gross=out.target.reduce((a,l)=>a+l.weight,0);assert.ok(gross<=1.0+1e-9&&out.target.every(l=>l.weight>0&&l.weight<=0.6&&l.stop_pct===STOP_PCT));
assert.deepEqual(out.keep_missing,['SUIUSDT']);
assert.ok(out.target.some(l=>l.side==='long')&&out.target.some(l=>l.side==='short'),'both directions');
// too much missing data → no decision (hold everything)
const bad=await trend.decide({market:{now,async bars(){return null;}}});assert.ok(bad.error);

// 5) registered in the league; a data gap never force-closes a held coin
assert.ok(STRATEGIES.some(d=>d.id==='trend-ensemble-4h'));
const acc=newAccount(trend,now-H4*3);acc.last_bar=now-H4*3;acc.positions.SUIUSDT={symbol:'SUIUSDT',side:'long',qty:10,entry:3,opened_ms:now-H4*5,fees:0,funding:0};
const mkt={...market,async minutes(){return [];},async funding(){return [];},async price(s){return {last:3,mark:3};}};
const ctx={prices:{SUIUSDT:3}};acc.last_funding_check=now;
const r=await runStrategy(trend,acc,mkt,ctx);
assert.ok(acc.positions.SUIUSDT,'held coin with missing candles is kept');
assert.ok(r.trades.filter(t=>t.type==='open').length>=8);
console.log('PASS paper-league TREND: backtest parity (BTC), long/short, vol sizing ≤10%/coin, ledger limits, 12% stop, data-gap hold');
