// SIGNAL · 차트 신호 4H: parity with the research backtest, replay rules, decide() (no late entries), engine partial take + break-even.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {replay,decideCoin,chartsig,CHART_SYMBOLS,TP1_FRAC} from '../src/paper-league-chartsig.mjs';
import {STRATEGIES,runStrategy,newAccount,partialClose,fill} from '../src/paper-league.mjs';

// 1) parity: same trade results as the Python research engine on 1000 real BTC 4H bars
const fx=JSON.parse(readFileSync(new URL('./fixtures_chartsig_btc_4h.json',import.meta.url)));
const bars=fx.bars.map(([t,o,h,l,c])=>({t,o,h,l,c}));
const closed=replay(bars).events.filter(e=>['stop','breakeven','exit'].includes(e.type)).map(e=>e.result_pct/100);
assert.equal(closed.length,fx.py_trade_results.length,'trade count parity');
closed.forEach((x,i)=>assert.ok(Math.abs(x-fx.py_trade_results[i])<1e-9,'trade '+i+' parity'));

// 2) replay rules on a synthetic path: entry at next open, TP1 50% → stop to entry, opposite cross exits
const H4=4*3600000,T0=Date.UTC(2026,0,1);
const path=[];for(let i=0;i<300;i++){const base=i<150?100-i*0.05+Math.sin(i/3)*0.4:92.5+(i-150)*0.4+Math.sin(i/3)*0.4;path.push(base);}
const synth=path.map((c,i)=>({t:T0+i*H4,o:i?path[i-1]:c,h:Math.max(c,i?path[i-1]:c)*1.003,l:Math.min(c,i?path[i-1]:c)*0.997,c}));
const ev=replay(synth).events;
const entry=ev.find(e=>e.type==='entry'&&e.side==='long');assert.ok(entry,'long entry after the up-turn');
const sig=ev.filter(e=>e.type==='signal'&&e.side==='long').at(-1);
assert.ok(ev.filter(e=>e.type==='entry'&&e.side==='long').some(e=>e.t===sig.t+H4),'entry is the bar after the signal');
const e2=ev.filter(e=>e.type==='entry').at(-1);assert.ok(Math.abs(e2.sl-(e2.price-(e2.tp1-e2.price)))<1e-9,'stop and TP1 are both 1R');
const tp=ev.find(e=>e.type==='tp1');assert.ok(tp&&tp.frac===TP1_FRAC,'partial take 50%');
assert.ok(ev.every(e=>!['entry','tp1','stop','breakeven','exit'].includes(e.type)||e.price>0));

// 3) decideCoin: only a signal on the newest bar opens; a held trade is kept; no chart position → none
let lastSig=-1;for(let n=120;n<=synth.length;n++){const r=replay(synth.slice(0,n));if(r.next&&r.next.action==='enter'){lastSig=n;break;}}
assert.ok(lastSig>0,'a fresh signal exists on some newest bar');
const fresh=decideCoin(synth.slice(0,lastSig),null);
assert.equal(fresh.fresh,true);assert.ok(fresh.stop_pct>0&&fresh.take_pct>0&&Math.abs(fresh.stop_pct-fresh.take_pct)<1e-12);
const late=decideCoin(synth.slice(0,lastSig+2),null);assert.ok(!late.fresh,'never enters late');
assert.equal(decideCoin(synth.slice(0,50),null).error,'bars');

// 4) engine: partial take closes 50%, moves stop to entry, then the rest stops at break-even
const now=Date.UTC(2026,10,24,8,3),acc=newAccount(chartsig,now-3600000);
fill(acc,{symbol:'BTCUSDT',side:'long',qty:0.1,ref:100000,kind:'open',reason:'t',now:now-3600000});
const p=acc.positions.BTCUSDT;Object.assign(p,{stop:99000,take:101000,take_frac:0.5,be_after_take:true});
const mins=[{t:now-50*60000,o:100100,h:101200,l:100050,c:101100},{t:now-49*60000,o:101000,h:101050,l:p.entry-1,c:p.entry}];
const mkt={now,async minutes(){return mins;},async funding(){return [];},async price(){return {last:100000,mark:100000};},async bars(){return null;}};
acc.last_bar=Math.floor(now/H4)*H4-H4;acc.last_tick=now-60*60000;acc.last_funding_check=now;
const r=await runStrategy(chartsig,acc,mkt,{prices:{BTCUSDT:100000}});
const closes=r.trades.filter(t=>t.type==='close');
assert.equal(closes.length,2,'partial + break-even');
assert.ok(closes[0].partial&&Math.abs(closes[0].qty-0.05)<1e-12&&/분할 익절 50%/.test(closes[0].reason));
assert.equal(closes[1].reason,'본절 청산');assert.ok(!acc.positions.BTCUSDT);
// partial close keeps fee/funding shares consistent
const a2=newAccount(chartsig,now);fill(a2,{symbol:'ETHUSDT',side:'short',qty:2,ref:3000,kind:'open',reason:'t',now});
a2.positions.ETHUSDT.funding=4;const t=partialClose(a2,a2.positions.ETHUSDT,0.5,2900,'x',now);
assert.ok(Math.abs(a2.positions.ETHUSDT.qty-1.5)<1e-12&&Math.abs(a2.positions.ETHUSDT.funding-3)<1e-12&&Math.abs(t.funding-1)<1e-4);

// 5) decide(): 10 coins × 0.1 max, missing data kept, registered in the league, not resized
const market={now,async bars(s){if(s==='SUIUSDT')return null;return synth.slice(0,lastSig).map(b=>({...b,v:1}));}};
const out=await chartsig.decide({market,acc:{positions:{}}});
assert.equal(out.target.length,CHART_SYMBOLS.length-1);assert.ok(out.target.every(l=>l.weight===0.1&&l.take_frac===0.5&&l.be_after_take===true&&l.stop_pct>0));
assert.deepEqual(out.keep_missing,['SUIUSDT']);
assert.ok(STRATEGIES.some(d=>d.id==='chart-signal-4h')&&chartsig.resize===false);
console.log('PASS paper-league SIGNAL chart 4H: Python parity (BTC 1000 bars), 1R stop/TP1 50% + break-even, opposite-cross exit, no late entry, engine partial take');
