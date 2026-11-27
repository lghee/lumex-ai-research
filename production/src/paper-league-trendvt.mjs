/** LUMEX TREND · 변동성 조절 (2026-11-27) — TREND 4H with an account-level volatility target.
 *
 * Same signals, coins and per-coin sizing as TREND (paper-league-trend.mjs). On top, the whole book is scaled by
 *   k = min(2, 20 % ÷ annualised volatility of TREND's own 4H book return over the last 360 closed bars (60 days))
 * so the account trades smaller when the strategy's recent swings are large and larger when they are small.
 * The book return is rebuilt from the candles every decision (stateless): weight decided at bar i × return of bar i+1.
 *
 * Research (offline, 3 years of OKX USDT-perp candles 2023-11 → 2026-11, 0.075 % per side + funding, decisions on
 * closed bars, next-hour fills; parameters chosen on 2023-11 → 2025-05, checked on 2025-06 → 2026-11):
 *   TREND            +60.8 %  MDD −16.5 %  Sharpe 0.84 (first half 0.47 / second half 1.15)
 *   TREND · 변동성 조절 +83.8 %  MDD −13.4 %  Sharpe 1.08 (first half 0.80 / second half 1.34)
 * All 27 neighbouring settings (target 15–25 %, 14–60 days, cap 1.5–3x) beat TREND; cost ×2 still +61.6 %.
 * Average exposure ≈ 0.4x of the account, peak ≈ 1.25x (leverage 2 needed on the exchange).
 * Backtest only — like every league account it starts forward at 10,000 USDT and shows no backtest number on screen.
 */
import {emaSeries} from './paper-league-strategies.mjs';
import {TREND_SYMBOLS,PAIRS,VOL_TARGET,VOL_BARS,BARS_PER_YEAR,STOP_PCT,MIN_BARS} from './paper-league-trend.mjs';
export const BOOK_TARGET=0.20,BOOK_BARS=360,BOOK_CAP=2,BOOK_MIN=60;
const fin=x=>typeof x==='number'&&Number.isFinite(x);

/** Signed TREND weight per closed bar (same formula as targetWeight, evaluated at every bar). */
export function weightSeries(closes,n=TREND_SYMBOLS.length){
  const out=new Array(closes.length).fill(0);if(closes.length<MIN_BARS)return out;
  const emas=PAIRS.map(([a,b])=>[emaSeries(closes,a),emaSeries(closes,b)]);
  const r=closes.map((c,i)=>i?c/closes[i-1]-1:0);
  for(let i=MIN_BARS-1;i<closes.length;i++){
    let s=0;for(const [f,l] of emas)s+=f[i]>l[i]?1:f[i]<l[i]?-1:0;s/=PAIRS.length;
    let m=0;for(let k=i-VOL_BARS+1;k<=i;k++)m+=r[k];m/=VOL_BARS;
    let v=0;for(let k=i-VOL_BARS+1;k<=i;k++)v+=(r[k]-m)**2;const vol=Math.sqrt(v/(VOL_BARS-1))*Math.sqrt(BARS_PER_YEAR);
    out[i]=fin(vol)&&vol>0?(1/n)*s*Math.min(1,VOL_TARGET/vol):0;
  }
  return out;
}
/** Book multiplier from per-coin closes aligned on the same bar times (only coins with full data take part). */
export function bookScale(series){
  const cs=series.filter(c=>Array.isArray(c)&&c.length>=MIN_BARS+BOOK_MIN+1);if(!cs.length)return {k:1,vol_pct:null,bars:0};
  const len=Math.min(...cs.map(c=>c.length));const al=cs.map(c=>c.slice(-len));
  const ws=al.map(c=>weightSeries(c));const pr=[];
  for(let i=1;i<len;i++){let s=0;for(let j=0;j<al.length;j++)s+=ws[j][i-1]*(al[j][i]/al[j][i-1]-1);pr.push(s);}
  // returns of bars whose previous weight was live
  const tail=pr.slice(MIN_BARS-1).slice(-BOOK_BARS);const x=tail.length>=BOOK_MIN?tail:null;
  if(!x)return {k:1,vol_pct:null,bars:tail.length};
  const m=x.reduce((a,b)=>a+b,0)/x.length,sd=Math.sqrt(x.reduce((a,b)=>a+(b-m)**2,0)/(x.length-1)),vol=sd*Math.sqrt(BARS_PER_YEAR);
  const k=fin(vol)&&vol>0?Math.min(BOOK_CAP,BOOK_TARGET/vol):1;
  return {k:Number(k.toFixed(4)),vol_pct:Number((vol*100).toFixed(1)),bars:x.length};
}

export const trendvt={id:'trend-voltarget-4h',origin:'new',tier:'advanced',ai:false,name:'TREND · 변동성 조절',family:'다중 기간 추세추종 + 계좌 변동성 조절(롱·숏)',risk:'균형형',kind:'trend',
  interval:'240',interval_label:'4H',symbols_label:'BTC 등 10종목',resize:true,leverage:2,
  summary:'TREND와 같은 4시간봉 추세 신호로 같은 코인을 거래합니다. 최근 60일 동안 전략 손익의 흔들림이 크면 전체 포지션을 줄이고, 작으면 최대 2배까지 키웁니다.',
  rules:['신호·코인·코인별 크기: TREND와 같음(EMA 6쌍 평균, 코인별 자금 10% × 신호 강도 × min(1, 30% ÷ 14일 변동성))','계좌 배율: min(2, 20% ÷ 최근 360개 4시간봉의 TREND 손익 변동성)','배율이 바뀌어도 목표와 20% 이상 차이 날 때만 크기 조정','진입가에서 12% 반대로 가면 거래소 손절'],
  async decide({market}){
    const closes={},target=[],diag={};let ok=0;
    for(const s of TREND_SYMBOLS){
      const bars=await market.bars(s,'240',1000);
      if(!bars||bars.length<MIN_BARS){diag[s]={error:'bars'};continue;}
      closes[s]=bars.map(b=>b.c);ok++;
    }
    if(ok<TREND_SYMBOLS.length/2)return {error:'4시간봉 자료 부족'};
    const book=bookScale(Object.values(closes));
    for(const [s,c] of Object.entries(closes)){
      const w=weightSeries(c).at(-1);diag[s]={weight:Number(w.toFixed(4))};
      const size=Math.abs(w)*book.k;
      if(w!==0&&size>0)target.push({symbol:s,side:w>0?'long':'short',weight:Number(size.toFixed(4)),stop_pct:STOP_PCT,reason:`추세 ${w>0?'롱':'숏'} · 계좌 배율 ${book.k}`});
    }
    const longs=target.filter(l=>l.side==='long').length;
    return {target,note:`롱 ${longs} · 숏 ${target.length-longs} · 배율 ${book.k} · 총 비중 ${(target.reduce((a,l)=>a+l.weight,0)*100).toFixed(0)}%`,diag:{...diag,book},keep_missing:Object.keys(diag).filter(k=>diag[k].error)};
  }};
