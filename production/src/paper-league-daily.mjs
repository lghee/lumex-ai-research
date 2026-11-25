/** LUMEX 일봉 전략 3종 (2026-11-26) — DAILY · 일봉 추세 추적 / BREAKOUT · 20일 돌파 / ROTATION · 강약 교체.
 *
 * Why: the 1H–4H single-coin rules (trend, breakout, pull-back, mean reversion, squeeze — 378 settings) did not stay
 * profitable after fees and slippage over 3 years. The three rules below did, in every half-year window, and together they
 * trade about 6 times a week on 10 coins. Research (offline, OKX USDT-perp 4H candles grouped into UTC days,
 * 2023-11-25 → 2026-11-24, taker 0.055 % + slippage 0.02 % per market fill, account split equally, 1x, not compounded):
 *   DAILY      +68 %  max DD −9 %   ~1.2 trades/week   6 of 6 half-years positive, 9 of 10 coins positive
 *   BREAKOUT   +47 %  max DD −30 %  ~2.1 trades/week
 *   ROTATION   +132 % max DD −29 %  ~2.8 trades/week   (with the 25 % protective stop below; +142 % without)
 *   one third each: +86 %, max DD −17 %, all 6 half-years positive; the current 4H chart rule on the same data: +25 %.
 *   The last 6 months (2026-05-25 →) were not used to choose the rules; all three were positive there.
 * Backtest only — like every league account these start forward-only at 10,000 USDT and show no backtest number.
 * Customers cannot follow them until the operator adds them (Core follow list).
 *
 * Execution follows the research engine: decisions on CLOSED daily bars (UTC), fill at the next open (first tick after
 * 00:00 UTC), protective stop checked by the league engine on 1-minute bars, trailing stop moved once per day from the
 * closed bar's extreme (trail_stop, only ever tightened).
 */
import {ema,rsi,atr} from './paper-league-chartsig.mjs';
export const DAILY_SYMBOLS=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','BNBUSDT','ADAUSDT','LINKUSDT','AVAXUSDT','SUIUSDT'];
export const MIN_BARS=120,START_I=60,DAILY_LIMIT=400,COIN_WEIGHT=0.1;
const fin=x=>typeof x==='number'&&Number.isFinite(x);
const prevMax=(a,n)=>a.map((_,i)=>{if(i<n)return null;let m=-Infinity;for(let k=i-n;k<i;k++)m=Math.max(m,a[k]);return m;});
const prevMin=(a,n)=>a.map((_,i)=>{if(i<n)return null;let m=Infinity;for(let k=i-n;k<i;k++)m=Math.min(m,a[k]);return m;});
const crossAt=(I,i)=>fin(I.fa[i-1])&&fin(I.sa[i-1])&&fin(I.fa[i])&&fin(I.sa[i])?(I.fa[i-1]<=I.sa[i-1]&&I.fa[i]>I.sa[i]?1:I.fa[i-1]>=I.sa[i-1]&&I.fa[i]<I.sa[i]?-1:0):0;

/** DAILY: EMA20/50 cross + RSI14 agreement (the chart's entry), stop 1.5R, trail 2R from the best price, exit on the opposite cross. */
export const EMA_RULE={stopR:1.5,trailR:2,
  prepare(bars){const c=bars.map(b=>b.c);return {fa:ema(c,20),sa:ema(c,50),r:rsi(c)};},
  entry(I,i){const x=crossAt(I,i);if(!x)return 0;return fin(I.r[i])&&(x>0?I.r[i]>=50:I.r[i]<=50)?x:0;},
  exit(I,i,p){return crossAt(I,i)===-p.d;}};
/** BREAKOUT: close above the previous 20 days' high → long, below the previous 20 days' low → short; stop 2R, trail 3R. */
export const BREAKOUT_RULE={stopR:2,trailR:3,
  prepare(bars){return {c:bars.map(b=>b.c),hh:prevMax(bars.map(b=>b.h),20),ll:prevMin(bars.map(b=>b.l),20)};},
  entry(I,i){const c=I.c[i];return fin(I.hh[i])&&c>I.hh[i]?1:fin(I.ll[i])&&c<I.ll[i]?-1:0;},
  exit(){return false;}};

/** Replay one coin's rule over closed daily bars [{t,o,h,l,c}] exactly as the research engine does.
 * Returns {trades, open, next}: trades closed so far; open = position after the newest bar (with its trailing stop);
 * next = what to do at the next open when the newest bar fired ({action:'enter'|'exit'|'reverse', side, unit}). */
export function replayRule(bars,rule){
  const out={trades:[],open:null,next:null};
  if(!Array.isArray(bars)||bars.length<MIN_BARS)return out;
  const I=rule.prepare(bars),a=atr(bars),last=bars.length-1;let pos=null,pend=null;
  const close=(px,type,i)=>{const gross=pos.d*(px/pos.e-1)*100;out.trades.push({t:pos.t,side:pos.d>0?'long':'short',exit_t:bars[i].t,entry:pos.e,exit:px,gross,type});pos=null;};
  for(let i=START_I;i<=last;i++){
    const b=bars[i];let done=false;
    if(pend){const p=pend;pend=null;
      if(p.exit&&pos)close(b.o,'exit',i);
      if(p.enter&&!pos){const u=a[i-1];pos={d:p.enter,e:b.o,u,sl:b.o-p.enter*u*rule.stopR,ext:b.o,t:b.t};}}
    if(pos){const d=pos.d;
      if(d>0?b.o<=pos.sl:b.o>=pos.sl){close(b.o,'stop',i);done=true;}            // gap through the stop: the open
      else if(d>0?b.l<=pos.sl:b.h>=pos.sl){close(pos.sl,'stop',i);done=true;}
      else{pos.ext=d>0?Math.max(pos.ext,b.h):Math.min(pos.ext,b.l);const t=pos.ext-d*rule.trailR*pos.u;pos.sl=d>0?Math.max(pos.sl,t):Math.min(pos.sl,t);}}
    const x=rule.entry(I,i);
    if(i===last){ // live decision for the next open
      if(pos&&!done&&(rule.exit(I,i,pos)||(x&&x===-pos.d)))out.next={action:x===-pos.d?'reverse':'exit',side:x===-pos.d?(x>0?'long':'short'):null,unit:x===-pos.d?a[i]:null};
      else if(!pos&&x&&fin(a[i])&&a[i]>0)out.next={action:'enter',side:x>0?'long':'short',unit:a[i]};
      break;}
    if(pos&&!done&&(rule.exit(I,i,pos)||(x&&x===-pos.d))){pend={exit:true,enter:x===-pos.d?x:0};continue;}
    if(!pos&&x&&fin(a[i])&&a[i]>0)pend={exit:false,enter:x};
  }
  if(pos)out.open={side:pos.d>0?'long':'short',entry:pos.e,unit:pos.u,stop:pos.sl,best:pos.ext,entry_t:pos.t};
  return out;
}
/** What the account should hold for one coin after the newest closed daily bar. held = league position side or null. */
export function decideDaily(bars,held,rule){
  if(!Array.isArray(bars)||bars.length<MIN_BARS)return {error:'bars'};
  const rp=replayRule(bars,rule),close=bars.at(-1).c,n=rp.next;
  if(n&&(n.action==='enter'||n.action==='reverse'))
    return {want:n.side,fresh:true,stop_pct:rule.stopR*n.unit/close,why:n.action==='reverse'?'반대 신호 · 방향 전환':'일봉 신호 진입'};
  if(n&&n.action==='exit')return {want:null,why:'반대 신호 · 청산'};
  if(held&&rp.open&&rp.open.side===held)return {want:held,fresh:false,trail_stop:rp.open.stop};
  return {want:null,why:held?'추세 종료 · 청산':null};
}
function dailyStrategy(meta,rule){
  return {...meta,origin:'new',tier:'advanced',ai:false,kind:'trend',interval:'D',interval_label:'1D',symbols_label:'BTC 등 10종목',resize:false,
    async decide({market,acc}){
      const target=[],diag={},missing=[];let ok=0,exitWhy=null;
      for(const s of DAILY_SYMBOLS){
        const bars=await market.bars(s,'D',DAILY_LIMIT);
        if(!bars||bars.length<MIN_BARS){diag[s]={error:'bars'};missing.push(s);continue;}
        const held=acc?.positions?.[s]?.side||null,d=decideDaily(bars.map(b=>({t:b.t,o:b.o,h:b.h,l:b.l,c:b.c})),held,rule);
        if(d.error){diag[s]={error:d.error};missing.push(s);continue;}
        ok++;diag[s]={want:d.want,fresh:!!d.fresh};
        if(d.why&&held&&!d.want)exitWhy=d.why;
        if(!d.want)continue;
        if(d.fresh)target.push({symbol:s,side:d.want,weight:COIN_WEIGHT,stop_pct:d.stop_pct,reason:d.why});
        else target.push({symbol:s,side:d.want,weight:COIN_WEIGHT,trail_stop:d.trail_stop,reason:'보유 유지'});
      }
      if(ok<DAILY_SYMBOLS.length/2)return {error:'일봉 자료 부족'};
      const longs=target.filter(l=>l.side==='long').length;
      return {target,note:`롱 ${longs} · 숏 ${target.length-longs}`,diag,keep_missing:missing,exit_reason:exitWhy||'일봉 신호 청산'};
    }};
}
export const dailyEma=dailyStrategy({id:'daily-ema-trail',name:'DAILY · 일봉 추세 추적',family:'일봉 추세추종 + 추적 손절(롱·숏)',risk:'균형형',
  summary:'일봉에서 20일·50일 평균선이 교차하고 RSI가 같은 방향이면 진입합니다. 고정 익절 없이 들고 가다가, 가장 유리했던 가격에서 변동폭의 2배만큼 되돌아오면 정리합니다.',
  rules:['진입: 일봉 마감 때 EMA20이 EMA50을 위로(아래로) 넘고 RSI14가 50 이상(이하)이면 다음 날 시가에 롱(숏)','손절: 진입가에서 ATR14 1.5배','추적 손절: 보유 중 가장 높은(낮은) 가격에서 ATR14 2배, 하루에 한 번 올림(내림)','청산: 반대 교차 때, RSI가 맞으면 반대 방향 진입','코인별 자금 10%, 10종목 합계 1배 이하']},EMA_RULE);
export const dailyBreakout=dailyStrategy({id:'daily-breakout-20',name:'BREAKOUT · 20일 돌파',family:'20일 신고가·신저가 돌파 + 추적 손절(롱·숏)',risk:'적극형',
  summary:'일봉 종가가 지난 20일 최고가를 넘으면 롱, 최저가를 깨면 숏을 잡습니다. 가장 유리했던 가격에서 변동폭의 3배만큼 되돌아오거나 반대쪽 돌파가 나오면 정리합니다.',
  rules:['진입: 일봉 종가가 직전 20일 최고가 위(최저가 아래)면 다음 날 시가에 롱(숏)','손절: 진입가에서 ATR14 2배','추적 손절: 보유 중 가장 높은(낮은) 가격에서 ATR14 3배, 하루에 한 번 올림(내림)','청산: 반대쪽 20일 돌파 때 방향 전환','코인별 자금 10%, 10종목 합계 1배 이하']},BREAKOUT_RULE);

/** ROTATION: once a week (the first tick after the Sunday daily close, UTC) rank the 10 coins by 14-day return; long the
 * best 2 that are above their EMA50, short the worst 2 that are below it; 25 % of the account each; hold to the next
 * rebalance; protective stop 25 % from entry (rare: 9 stops in 3 years in research). */
export const ROT={lookback:14,top:2,weight:0.25,stop_pct:0.25,ema:50,min_coins:8};
export function rotationPicks(closesBy){
  const rows=[];
  for(const [s,c] of Object.entries(closesBy)){
    if(!Array.isArray(c)||c.length<Math.max(ROT.ema,ROT.lookback)+1)continue;
    const last=c.at(-1),past=c.at(-1-ROT.lookback),e=ema(c,ROT.ema).at(-1);
    if(!fin(last)||!fin(past)||past<=0||!fin(e))continue;
    rows.push({symbol:s,ret:last/past-1,above:last>e,below:last<e});
  }
  if(rows.length<ROT.min_coins)return null;
  rows.sort((a,b)=>b.ret-a.ret||a.symbol.localeCompare(b.symbol));
  const picks=[];
  for(const r of rows.slice(0,ROT.top))if(r.above)picks.push({symbol:r.symbol,side:'long',ret:r.ret});
  for(const r of rows.slice(-ROT.top))if(r.below)picks.push({symbol:r.symbol,side:'short',ret:r.ret});
  return {picks,ranked:rows.map(r=>({symbol:r.symbol,ret_pct:Number((r.ret*100).toFixed(2))}))};
}
export const isRebalanceBar=bar_ms=>new Date(bar_ms).getUTCDay()===0; // the newest closed daily bar is Sunday (UTC)
export const rotation={id:'rotation-14d',origin:'new',tier:'advanced',ai:false,kind:'rotation',name:'ROTATION · 강약 교체',family:'코인 간 강약 교체(롱·숏)',risk:'적극형',
  interval:'D',interval_label:'1D · 주 1회',symbols_label:'BTC 등 10종목',resize:false,
  summary:'매주 한 번 10개 코인의 최근 14일 수익률을 비교해, 가장 강한 2개는 롱(50일 평균선 위일 때), 가장 약한 2개는 숏(50일 평균선 아래일 때)으로 들고 갑니다.',
  rules:['교체: 매주 월요일 09시(KST) 직후, 일요일 일봉 마감 기준','순위: 최근 14일 수익률','롱: 상위 2개 중 50일 평균선 위인 코인','숏: 하위 2개 중 50일 평균선 아래인 코인','비중: 한 자리당 25%, 합계 1배 이하 · 보호 손절 25%'],
  async decide({market,acc,bar_ms}){
    const first=!fin(acc?.memo?.rot_last_ms);
    if(!first&&!isRebalanceBar(bar_ms))return {target:null,note:acc.last_signal||'다음 교체: 월요일 09시'};
    const closesBy={},missing=[];
    for(const s of DAILY_SYMBOLS){const bars=await market.bars(s,'D',DAILY_LIMIT);
      if(!bars||bars.length<MIN_BARS||bars.at(-1).t!==bar_ms){missing.push(s);continue;}
      closesBy[s]=bars.map(b=>b.c);}
    const r=rotationPicks(closesBy);
    if(!r)return {error:'일봉 자료 부족'};
    acc.memo.rot_last_ms=bar_ms;
    const target=r.picks.map(p=>({symbol:p.symbol,side:p.side,weight:ROT.weight,stop_pct:ROT.stop_pct,reason:`14일 ${p.ret>=0?'+':''}${(p.ret*100).toFixed(1)}% · ${p.side==='long'?'강세 상위':'약세 하위'}`}));
    const longs=target.filter(l=>l.side==='long').length;
    return {target,note:`주간 교체 · 롱 ${longs} · 숏 ${target.length-longs}`,diag:{ranked:r.ranked},keep_missing:missing,exit_reason:'주간 교체'};
  }};
