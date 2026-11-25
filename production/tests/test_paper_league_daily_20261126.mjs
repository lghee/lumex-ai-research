// DAILY · 일봉 추세 추적 / BREAKOUT · 20일 돌파 / ROTATION · 강약 교체: research parity, live decisions, rotation picks,
// engine trailing stop (tightened only), registration.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {replayRule,decideDaily,EMA_RULE,BREAKOUT_RULE,rotationPicks,isRebalanceBar,rotation,dailyEma,dailyBreakout,DAILY_SYMBOLS,ROT,MIN_BARS} from '../src/paper-league-daily.mjs';
import {STRATEGIES,runStrategy,newAccount,fill} from '../src/paper-league.mjs';

// 1) parity with the offline research engine, trade by trade, on 3 years of real BTC/ETH daily bars
const fx=JSON.parse(readFileSync(new URL('./fixtures_daily_btc_eth_1d.json',import.meta.url)));
let n=0;
for(const [coin,d] of Object.entries(fx.coins)){
  const bars=d.bars.map(([t,o,h,l,c])=>({t:t*1000,o,h,l,c}));
  for(const [rule,exp] of [[EMA_RULE,d.ema_trail],[BREAKOUT_RULE,d.breakout_20]]){
    const got=replayRule(bars,rule).trades;
    assert.equal(got.length,exp.length,coin+' trade count');
    got.forEach((g,i)=>{const [t,dir,xt,gross,type]=exp[i];n++;
      assert.equal(g.t,t*1000,coin+' entry time '+i);assert.equal(g.side,dir>0?'long':'short',coin+' side '+i);assert.equal(g.exit_t,xt*1000,coin+' exit time '+i);
      assert.ok(Math.abs(g.gross-gross)<1e-6,coin+' result '+i);assert.equal(g.type==='stop'?'sl':g.type,type,coin+' exit type '+i);});
  }
}
assert.ok(n>=90,'enough trades compared');

// 2) live decision: a signal only on the newest bar opens; a held trade gets the replay's trailing stop; flat replay → exit
const btc=fx.coins.BTC.bars.map(([t,o,h,l,c])=>({t:t*1000,o,h,l,c}));
let k=-1;for(let m=MIN_BARS;m<=btc.length;m++){const r=replayRule(btc.slice(0,m),EMA_RULE);if(r.next&&r.next.action==='enter'){k=m;break;}}
assert.ok(k>0,'a fresh daily signal exists');
const fresh=decideDaily(btc.slice(0,k),null,EMA_RULE);assert.equal(fresh.fresh,true);assert.ok(fresh.stop_pct>0&&fresh.stop_pct<0.5);
assert.ok(!decideDaily(btc.slice(0,k+1),null,EMA_RULE).fresh,'never enters late');
const held=decideDaily(btc.slice(0,k+3),fresh.want,EMA_RULE);
const rp=replayRule(btc.slice(0,k+3),EMA_RULE);
if(rp.open){assert.equal(held.want,fresh.want);assert.equal(held.trail_stop,rp.open.stop);
  if(rp.open.side==='long')assert.ok(rp.open.stop>=rp.open.entry-1.5*rp.open.unit-1e-9);}
assert.equal(decideDaily(btc.slice(0,50),null,EMA_RULE).error,'bars');
const flat=decideDaily(btc.slice(0,k),fresh.want==='long'?'short':'long',EMA_RULE); // held opposite side of the rule
assert.ok(flat.want!==(fresh.want==='long'?'short':'long'));

// 3) rotation: 14-day return ranking, EMA50 side filter, needs 8 coins
const mk=(drift,last)=>{const c=[];let p=100;for(let i=0;i<80;i++){p*=1+drift;c.push(p);}if(last)c[c.length-1]*=last;return c;};
const closes={AUSDT:mk(0.010),BUSDT:mk(0.008),CUSDT:mk(0.004),DUSDT:mk(0.001),EUSDT:mk(0),FUSDT:mk(-0.001),GUSDT:mk(-0.004),HUSDT:mk(-0.008),IUSDT:mk(-0.010),JUSDT:mk(0.002)};
const r=rotationPicks(closes);
assert.deepEqual(r.picks.map(p=>p.symbol+':'+p.side),['AUSDT:long','BUSDT:long','HUSDT:short','IUSDT:short']);
assert.ok(!rotationPicks({...closes,AUSDT:mk(-0.02).map((x,i,a)=>i===a.length-1?a[a.length-15]*1.5:x)}).picks.some(p=>p.symbol==='AUSDT'&&p.side==='short'));
assert.equal(rotationPicks(Object.fromEntries(Object.entries(closes).slice(0,7))),null,'fewer than 8 coins → no decision');
assert.ok(isRebalanceBar(Date.UTC(2026,10,22))&&!isRebalanceBar(Date.UTC(2026,10,23)),'Sunday bar = rebalance');

// 4) rotation decide(): first run rebalances, then only on Sunday bars; targets 25 % each with a 25 % protective stop
const sun=Date.UTC(2026,10,22),D=86400000;
const series=(c,end)=>c.map((x,i)=>({t:end-(c.length-1-i)*D,o:x,h:x*1.01,l:x*0.99,c:x,v:1}));
const sym=Object.keys(closes);const marketFor=end=>({async bars(s){const i=DAILY_SYMBOLS.indexOf(s);const c=closes[sym[i]];return series(Array.from({length:150},(_,j)=>c[Math.min(c.length-1,Math.max(0,j-70))]),end);}});
const acc=newAccount(rotation,Date.UTC(2026,10,20));
const o1=await rotation.decide({market:marketFor(sun-D),acc,bar_ms:sun-D});
assert.ok(Array.isArray(o1.target)&&o1.target.every(l=>l.weight===ROT.weight&&l.stop_pct===ROT.stop_pct),'first run rebalances');
const o2=await rotation.decide({market:marketFor(sun+D),acc,bar_ms:sun+D});assert.equal(o2.target,null,'mid-week: hold');
const o3=await rotation.decide({market:marketFor(sun),acc,bar_ms:sun});assert.ok(Array.isArray(o3.target),'Sunday bar: rebalance');

// 5) engine: trail_stop only tightens a held position's stop
const now=Date.UTC(2026,10,26,0,5),a=newAccount(dailyEma,now-5*D);
fill(a,{symbol:'BTCUSDT',side:'long',qty:0.01,ref:90000,kind:'open',reason:'t',now:now-5*D});a.positions.BTCUSDT.stop=85000;
let trail=88000;const def={...dailyEma,async decide(){return {target:[{symbol:'BTCUSDT',side:'long',weight:0.1,trail_stop:trail}],note:'t'};}};
const mkt={now,async minutes(){return [];},async funding(){return [];},async price(){return {last:91000,mark:91000};},async bars(){return null;}};
a.last_tick=now-60000;a.last_funding_check=now;a.last_bar=0;
await runStrategy(def,a,mkt,{prices:{BTCUSDT:91000}});assert.equal(a.positions.BTCUSDT.stop,88000,'tightened');
trail=86000;a.last_bar=0;await runStrategy(def,a,mkt,{prices:{BTCUSDT:91000}});assert.equal(a.positions.BTCUSDT.stop,88000,'never loosened');

// 6) registered, daily, no resize
for(const id of ['daily-ema-trail','daily-breakout-20','rotation-14d']){const d=STRATEGIES.find(x=>x.id===id);assert.ok(d&&d.interval==='D'&&d.resize===false&&d.rules.length>=5,id);}
console.log(`PASS paper-league daily: research parity (${n} BTC/ETH daily trades), next-open entries only, trailing stop tightened once a day, weekly 14-day rotation (top 2 long above EMA50 / bottom 2 short below), registered`);
