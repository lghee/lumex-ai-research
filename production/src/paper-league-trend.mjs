/** LUMEX TREND · 4시간봉 EMA 앙상블 추세추종 (2026-11-23).
 *
 * Research basis (offline, 1 year of OKX USDT-perp candles, 2025-12-23 → 2026-11-23, costs + funding where
 * available): 10 coins, 6 EMA pairs averaged into a −1…+1 signal, sized to a 30 % annualised volatility
 * target per coin, gross ≤ 1x. Result +34.5 %, max drawdown −16.6 %, 9 of 12 months positive; every coin
 * positive on its own; all 19 neighbouring EMA settings positive. That is a backtest, so — like every
 * league account — this one starts forward-only at 10,000 USDT and claims no backtest number on screen.
 *
 * Decisions on CLOSED 4H bars only. Long and short. Each coin keeps 1/10 of the account:
 *   weight = 0.1 × |signal| × min(1, 30 % ÷ annualised 14-day volatility)
 * A held position is resized only when it is 20 % off target (engine `resize`), so orders stay rare.
 * Exchange-side protective stop 12 % from entry (rarely hit at this sizing; kept for customer accounts).
 */
import {emaSeries} from './paper-league-strategies.mjs';
const fin=x=>typeof x==='number'&&Number.isFinite(x);
export const TREND_SYMBOLS=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','BNBUSDT','ADAUSDT','LINKUSDT','AVAXUSDT','SUIUSDT'];
export const PAIRS=[[10,100],[20,100],[30,60],[20,150],[30,100],[10,200]];
export const VOL_TARGET=0.30,VOL_BARS=84,BARS_PER_YEAR=6*365,STOP_PCT=0.12,MIN_BARS=260;

/** Ensemble signal on the last closed bar: mean of sign(EMA fast − EMA slow) over the six pairs. */
export function ensembleSignal(closes){
  if(!Array.isArray(closes)||closes.length<MIN_BARS)return null;
  let s=0;for(const [a,b] of PAIRS){const f=emaSeries(closes,a).at(-1),l=emaSeries(closes,b).at(-1);if(!fin(f)||!fin(l))return null;s+=f>l?1:f<l?-1:0;}
  return s/PAIRS.length;
}
/** Annualised volatility of simple 4H returns over the last VOL_BARS bars. */
export function annualVol(closes){
  if(!Array.isArray(closes)||closes.length<VOL_BARS+1)return null;
  const r=[];for(let i=closes.length-VOL_BARS;i<closes.length;i++)r.push(closes[i]/closes[i-1]-1);
  const m=r.reduce((a,b)=>a+b,0)/r.length,sd=Math.sqrt(r.reduce((a,b)=>a+(b-m)**2,0)/(r.length-1));
  return fin(sd)&&sd>0?sd*Math.sqrt(BARS_PER_YEAR):null;
}
export function targetWeight(closes,n=TREND_SYMBOLS.length){
  const sig=ensembleSignal(closes),vol=annualVol(closes);
  if(sig===null||vol===null)return null;
  const w=(1/n)*Math.abs(sig)*Math.min(1,VOL_TARGET/vol);
  return {signal:Number(sig.toFixed(4)),vol_pct:Number((vol*100).toFixed(1)),side:sig>0?'long':sig<0?'short':null,weight:Number(w.toFixed(4))};
}

export const trend={id:'trend-ensemble-4h',origin:'new',tier:'advanced',ai:false,name:'TREND · 4시간 추세 앙상블',family:'다중 기간 추세추종(롱·숏)',risk:'균형형',kind:'trend',
  interval:'240',interval_label:'4H',symbols_label:'BTC 등 10종목',resize:true,
  summary:'10개 코인의 4시간봉 추세를 6가지 기간으로 동시에 보고, 오르면 롱·내리면 숏을 잡습니다. 변동성이 커지면 포지션을 줄이고, 코인마다 자금의 10%까지만 씁니다.',
  rules:['신호: 4시간봉 마감 때 EMA 6쌍(10/100·20/100·30/60·20/150·30/100·10/200) 비교의 평균(−1~+1)','방향: 평균이 양수면 롱, 음수면 숏, 0이면 보유 안 함','크기: 코인별 자금 10% × 신호 강도 × min(1, 30% ÷ 최근 14일 연환산 변동성)','조정: 목표와 20% 넘게 차이 날 때만 비중 조절(주문 최소화)','보호: 진입가 대비 12% 손절 주문'],
  async decide({market}){
    const target=[],diag={};let ok=0;
    for(const s of TREND_SYMBOLS){
      const bars=await market.bars(s,'240',1000);
      if(!bars||bars.length<MIN_BARS){diag[s]={error:'bars'};continue;}
      const t=targetWeight(bars.map(b=>b.c));if(!t){diag[s]={error:'signal'};continue;}
      ok++;diag[s]={signal:t.signal,vol_pct:t.vol_pct,weight:t.weight};
      if(t.side&&t.weight>0)target.push({symbol:s,side:t.side,weight:t.weight,stop_pct:STOP_PCT,reason:`추세 ${t.signal>0?'+':''}${t.signal} · 변동성 ${t.vol_pct}%`});
    }
    if(ok<TREND_SYMBOLS.length/2)return {error:'4시간봉 자료 부족'};
    // Coins whose candles failed this time keep their current position (no forced exit on missing data).
    const longs=target.filter(l=>l.side==='long').length,shorts=target.length-longs;
    return {target,note:`롱 ${longs} · 숏 ${shorts} · 총 비중 ${(target.reduce((a,l)=>a+l.weight,0)*100).toFixed(0)}%`,diag,keep_missing:Object.keys(diag).filter(k=>diag[k].error)};
  }};
