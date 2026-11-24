/** LUMEX 차트 신호 4H (2026-11-24) — the LUMEX chart's reference signals, traded as written.
 *
 * Same rule as the chart (Theme pro-indicators.js computeSignals, 0.5.07.09), on CLOSED 4H bars:
 *   entry   EMA20 crosses EMA50 on a closed bar and RSI14 agrees (≥50 long, ≤50 short) → enter at the next open
 *   risk    R = ATR14 (Wilder) of the signal bar; stop 1R from entry
 *   take 1  at 1R: close 50 %, move the stop to the entry price (break-even)
 *   rest    closes on the opposite EMA cross (at the next open); if RSI agrees with that cross it reverses
 *   same bar touching stop and target → stop first (conservative)
 * Sizing: each of 10 coins keeps 1/10 of the account at 1x (gross ≤ 1x). Long and short.
 *
 * Research (offline, 3 years of OKX USDT-perp 4H candles 2023-11 → 2026-11, 0.075 % per side + Gate funding):
 * +23.5 %, max drawdown −20.5 %, 1,190 trades, yearly +26 % / −3 % / +1 %. The 1H version lost money
 * (−38 % ~ −47 %) and is not used. Backtest only — this account starts forward at 10,000 USDT and
 * shows no backtest number on screen. Customers cannot follow it until the operator adds it (Core).
 *
 * The engine holds the position; the rule is replayed over the last 1,000 closed bars every 4H to know
 * the chart's current state, and only a signal on the newest closed bar opens a new trade (no late entries).
 * The partial take and the break-even stop run on 1-minute bars inside the engine (take_frac, be_after_take).
 */
export const CHART_SYMBOLS=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','BNBUSDT','ADAUSDT','LINKUSDT','AVAXUSDT','SUIUSDT'];
export const TP1_R=1,TP1_FRAC=0.5,SL_R=1,MIN_BARS=120;
const fin=x=>typeof x==='number'&&Number.isFinite(x);

/* Indicators exactly as the chart computes them (SMA-seeded EMA, Wilder RSI/ATR). */
export function ema(nums,p){const o=Array(nums.length).fill(null);let s=0,cur=0;
  for(let i=0;i<nums.length;i++){const v=nums[i];s+=v;if(i===p-1){cur=s/p;o[i]=cur;}else if(i>=p){cur+=2*(v-cur)/(p+1);o[i]=cur;}}return o;}
export function rsi(c,p=14){const o=Array(c.length).fill(null);if(c.length<=p)return o;let up=0,dn=0;
  for(let i=1;i<=p;i++){const d=c[i]-c[i-1];up+=Math.max(d,0);dn+=Math.max(-d,0);}up/=p;dn/=p;
  const sc=()=>dn===0?(up===0?50:100):100-100/(1+up/dn);o[p]=sc();
  for(let i=p+1;i<c.length;i++){const d=c[i]-c[i-1];up=(up*(p-1)+Math.max(d,0))/p;dn=(dn*(p-1)+Math.max(-d,0))/p;o[i]=sc();}return o;}
export function atr(bars,p=14){const tr=bars.map((b,i)=>i===0?b.h-b.l:Math.max(b.h-b.l,Math.abs(b.h-bars[i-1].c),Math.abs(b.l-bars[i-1].c)));
  const o=Array(bars.length).fill(null);if(bars.length<p)return o;let a=tr.slice(0,p).reduce((x,y)=>x+y,0)/p;o[p-1]=a;
  for(let i=p;i<bars.length;i++){a=(a*(p-1)+tr[i])/p;o[i]=a;}return o;}

/** Replay the chart rule. bars: [{t,o,h,l,c}] closed, ascending.
 * Returns {events, open, next}: events as the chart draws them; open = position still held after the last bar;
 * next = what to do at the next open ({action:'enter'|'exit'|'reverse', side, unit}) when the newest bar fired. */
export function replay(bars){
  const out={events:[],open:null,next:null};
  if(!Array.isArray(bars)||bars.length<MIN_BARS)return out;
  const c=bars.map(b=>b.c),fa=ema(c,20),sa=ema(c,50),r=rsi(c),a=atr(bars);
  let pos=null,pending=null;const last=bars.length-1;
  const cross=i=>fin(fa[i-1])&&fin(sa[i-1])&&fin(fa[i])&&fin(sa[i])?(fa[i-1]<=sa[i-1]&&fa[i]>sa[i]?1:fa[i-1]>=sa[i-1]&&fa[i]<sa[i]?-1:0):0;
  const open=(i,d,unit)=>{const e=bars[i].o;pos={d,e,unit,sl:e-d*SL_R*unit,tp1:e+d*TP1_R*unit,t1:false,rem:1,entry_t:bars[i].t,acc:0};
    out.events.push({t:bars[i].t,type:'entry',side:d>0?'long':'short',price:e,frac:1,sl:pos.sl,tp1:pos.tp1});};
  const close=(t,px,why)=>{const pnl=pos.d*(px/pos.e-1)*pos.rem;pos.acc+=pnl;
    out.events.push({t,type:why,side:pos.d>0?'long':'short',price:px,frac:pos.rem,result_pct:pos.acc*100});pos=null;};
  for(let i=51;i<=last;i++){
    const b=bars[i];let closedNow=false;
    if(pending){ // fill at this bar's open
      const p=pending;pending=null;
      if(p.exit&&pos)close(b.t,b.o,'exit');
      if(p.enter)open(i,p.enter,p.unit);
    }
    if(pos){
      const d=pos.d,slHit=d>0?b.l<=pos.sl:b.h>=pos.sl;
      if(slHit){close(b.t,pos.sl,pos.t1?'breakeven':'stop');closedNow=true;}
      else if(!pos.t1&&(d>0?b.h>=pos.tp1:b.l<=pos.tp1)){
        const pnl=d*(pos.tp1/pos.e-1)*TP1_FRAC;pos.acc+=pnl;pos.rem-=TP1_FRAC;pos.t1=true;pos.sl=pos.e;
        out.events.push({t:b.t,type:'tp1',side:d>0?'long':'short',price:pos.tp1,frac:TP1_FRAC,result_pct:pos.acc*100});
      }
    }
    const x=cross(i);if(!x||closedNow)continue; // a bar that stopped the trade opens nothing (as researched)
    const agree=x>0?fin(r[i])&&r[i]>=50:fin(r[i])&&r[i]<=50,unit=a[i];
    if(pos&&x===-pos.d){ // opposite cross: exit the rest at the next open, reverse when RSI agrees
      const enter=agree&&fin(unit)&&unit>0?x:0;
      if(i===last)out.next={action:enter?'reverse':'exit',side:enter?(x>0?'long':'short'):null,unit:enter?unit:null,signal_t:b.t};
      else pending={exit:true,enter,unit};
      continue;
    }
    if(!pos&&agree&&fin(unit)&&unit>0){
      out.events.push({t:b.t,type:'signal',side:x>0?'long':'short',price:b.c});
      if(i===last)out.next={action:'enter',side:x>0?'long':'short',unit,signal_t:b.t};
      else pending={exit:false,enter:x,unit};
    }
  }
  if(pos)out.open={side:pos.d>0?'long':'short',entry:pos.e,unit:pos.unit,stop:pos.sl,tp1:pos.tp1,tp1_done:pos.t1,remaining:pos.rem,entry_t:pos.entry_t};
  return out;
}

/** What the account should hold for one coin after the newest closed bar. held = engine position side or null. */
export function decideCoin(bars,held){
  const rp=replay(bars);
  if(bars.length<MIN_BARS)return {error:'bars'};
  const close=bars.at(-1).c,n=rp.next;
  if(n&&(n.action==='enter'||n.action==='reverse'))
    return {want:n.side,fresh:true,stop_pct:SL_R*n.unit/close,take_pct:TP1_R*n.unit/close,why:n.action==='reverse'?'반대 신호 · 방향 전환':'차트 신호 진입'};
  if(n&&n.action==='exit')return {want:null,why:'반대 신호 · 나머지 청산'};
  if(rp.open&&held===rp.open.side)return {want:rp.open.side,fresh:false};
  return {want:null,why:rp.open?null:'차트 기준 포지션 없음'};
}

export const chartsig={id:'chart-signal-4h',origin:'new',tier:'advanced',ai:false,name:'SIGNAL · 차트 신호 4H',family:'차트 매수·매도 신호 추종(롱·숏)',risk:'균형형',kind:'trend',
  interval:'240',interval_label:'4H',symbols_label:'BTC 등 10종목',resize:false,
  summary:'LUMEX 차트에 표시되는 4시간봉 매수·매도 신호를 그대로 따라갑니다. 1차 익절에서 절반을 정리하고 손절을 진입가로 올린 뒤, 나머지는 반대 신호가 나올 때까지 들고 갑니다.',
  rules:['진입: 4시간봉 마감 때 EMA20이 EMA50을 위로(아래로) 넘고 RSI14가 50 이상(이하)이면 다음 봉 시가에 롱(숏) 100%','손절: 진입가에서 ATR14 1배','1차 익절: ATR14 1배 도달 시 50% 익절, 손절을 진입가로 이동','나머지 50%: 반대 신호에 청산, RSI가 맞으면 반대 방향 진입','코인별 자금 10%, 10종목 합계 1배 이하'],
  async decide({market,acc}){
    const target=[],diag={},missing=[];let ok=0,exitWhy=null;
    for(const s of CHART_SYMBOLS){
      const bars=await market.bars(s,'240',1000);
      if(!bars||bars.length<MIN_BARS){diag[s]={error:'bars'};missing.push(s);continue;}
      const held=acc?.positions?.[s]?.side||null,d=decideCoin(bars.map(b=>({t:b.t,o:b.o,h:b.h,l:b.l,c:b.c})),held);
      if(d.error){diag[s]={error:d.error};missing.push(s);continue;}
      ok++;diag[s]={want:d.want,fresh:!!d.fresh};
      if(d.why&&held&&!d.want)exitWhy=d.why;
      if(!d.want)continue;
      if(d.fresh)target.push({symbol:s,side:d.want,weight:0.1,stop_pct:d.stop_pct,take_pct:d.take_pct,take_frac:TP1_FRAC,be_after_take:true,reason:d.why});
      else if(held===d.want)target.push({symbol:s,side:d.want,weight:0.1,reason:'보유 유지'});
    }
    if(ok<CHART_SYMBOLS.length/2)return {error:'4시간봉 자료 부족'};
    const longs=target.filter(l=>l.side==='long').length;
    return {target,note:`롱 ${longs} · 숏 ${target.length-longs}`,diag,keep_missing:missing,exit_reason:exitWhy||'차트 신호 청산'};
  }};
