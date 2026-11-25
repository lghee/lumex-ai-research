// DAILY 3x: same signals as DAILY, 30 % per coin; summary carries wins / losses / leverage.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dailyEma,dailyEma3x,DAILY_SYMBOLS,DAILY_3X_WEIGHT} from '../src/paper-league-daily.mjs';
import {STRATEGIES,newAccount,fill,summarize} from '../src/paper-league.mjs';

const fx=JSON.parse(readFileSync(new URL('./fixtures_daily_btc_eth_1d.json',import.meta.url)));
const coin=Object.values(fx.coins)[0].bars.map(([t,o,h,l,c])=>({t:t*1000,o,h,l,c,v:1}));
let checked=0,cuts=0;
for(let end=coin.length-1;end>=200&&cuts<6;end-=3){
  const bars=coin.slice(0,end+1);const market={async bars(s){return DAILY_SYMBOLS.includes(s)?bars:null;}};
  for(const side of [null,'long','short']){
    const acc={positions:side?Object.fromEntries(DAILY_SYMBOLS.map(s=>[s,{side}])):{}};
    const a=await dailyEma.decide({market,acc}),b=await dailyEma3x.decide({market,acc});
    assert.deepEqual(b.target.map(l=>[l.symbol,l.side,l.stop_pct,l.trail_stop]),a.target.map(l=>[l.symbol,l.side,l.stop_pct,l.trail_stop]),'same signals');
    assert.ok(a.target.every(l=>l.weight===0.1)&&b.target.every(l=>l.weight===DAILY_3X_WEIGHT),'weights 10 % vs 30 %');
    if(a.target.length){checked+=a.target.length;cuts++;}
  }
}
assert.ok(cuts>=6&&checked>=30,'enough non-empty decisions compared');
const d=STRATEGIES.find(x=>x.id==='daily-ema-trail-3x');assert.ok(d&&d.leverage===3&&d.interval==='D'&&d.resize===false&&d.rules.length>=3);
assert.equal(STRATEGIES.at(-1).id,'daily-ema-trail-3x','appended last: earlier ids keep their order');

const now=Date.UTC(2026,10,26),acc=newAccount(dailyEma3x,now-86400000*3);
fill(acc,{symbol:'BTCUSDT',side:'long',qty:0.01,ref:90000,kind:'open',reason:'t',now:now-86400000*2});
fill(acc,{symbol:'BTCUSDT',side:'long',qty:0.01,ref:91000,kind:'close',reason:'t',now:now-86400000});
fill(acc,{symbol:'ETHUSDT',side:'long',qty:1,ref:3000,kind:'open',reason:'t',now:now-86400000});
fill(acc,{symbol:'ETHUSDT',side:'long',qty:1,ref:2900,kind:'close',reason:'t',now});
const s=summarize(acc,dailyEma3x,[],now);
assert.equal(s.wins,1);assert.equal(s.losses,1);assert.equal(s.trades,2);assert.equal(s.leverage,3);
assert.equal(summarize(newAccount(dailyEma,now),dailyEma,[],now).leverage,1);
console.log(`PASS paper-league DAILY 3x: same signals as DAILY on ${cuts} cut-offs (${checked} legs), 30 % per coin, leverage 3 in summary, wins/losses counted`);
