/** LUMEX PRO advanced paper-league strategies (2026-11-22 v2).
 * All decisions use CLOSED bars only. The machine-learning model is trained on each decision
 * with walk-forward discipline: labels exist only for bars whose outcome is already closed,
 * the most recent window is held out to measure its own accuracy, and it refuses to open new
 * positions when that out-of-sample accuracy is not better than chance.
 * Every strategy also runs the account-level risk overlay in paper-league.mjs (drawdown brake,
 * cool-down, gross cap). No backtest performance is claimed for any of them.
 */
import {emaSeries,rsiSeries,atrSeries,regimeAt} from './paper-league-strategies.mjs';
const H=3600000,D=86400000;
const fin=x=>typeof x==='number'&&Number.isFinite(x);
const mean=a=>a.reduce((x,y)=>x+y,0)/a.length;
const std=a=>{const m=mean(a);return Math.sqrt(a.reduce((x,y)=>x+(y-m)**2,0)/Math.max(1,a.length-1));};
const clamp=(x,lo,hi)=>Math.max(lo,Math.min(hi,x));
const DEFAULT10=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','BNBUSDT','ADAUSDT','LINKUSDT','AVAXUSDT','SUIUSDT'];
const topN=(ctx,n)=>ctx.scanner?.items?.filter(x=>x.rank<=n).map(x=>x.symbol)||DEFAULT10.slice(0,Math.min(n,10));
const RISK={ddHalf:0.08,ddFlat:0.15,cooldownH:48,maxGross:1.5};

// ------------------------------------------------------------ ML: NEXUS ---
export const HORIZON=6,COST=0.003;
/** 12 features per closed 4H bar; every value uses bars ≤ i only. */
export function features(bars,btcByT){
  const c=bars.map(b=>b.c),e20=emaSeries(c,20),e50=emaSeries(c,50),r=rsiSeries(c),a=atrSeries(bars);
  const lv=bars.map(b=>Math.log(1+b.v));const out=[];
  for(let i=0;i<bars.length;i++){
    if(i<60||!fin(a[i])||!fin(r[i])){out.push(null);continue;}
    const ap=a[i]/c[i],past=a.slice(i-60,i).map((x,k)=>x/c[i-60+k]).filter(fin).sort((x,y)=>x-y),med=past[past.length>>1];
    const v60=lv.slice(i-60,i),vm=mean(v60),vs=std(v60)||1;
    const w=bars.slice(i-23,i+1),hh=Math.max(...w.map(b=>b.h)),ll=Math.min(...w.map(b=>b.l));
    const bt=btcByT?.get(bars[i].t),bt6=btcByT?.get(bars[i].t-6*4*H);
    out.push([c[i]/c[i-1]-1,c[i]/c[i-6]-1,c[i]/c[i-24]-1,c[i]/c[i-42]-1,(c[i]-e20[i])/a[i],(e20[i]/e50[i]-1)*100,r[i]/100-0.5,ap*100,
      med?ap/med-1:0,(lv[i]-vm)/vs,hh>ll?(c[i]-ll)/(hh-ll)-0.5:0,bt&&bt6?bt/bt6-1:0]);
  }
  return out;
}
export function labelAt(c,i){if(i+HORIZON>=c.length)return null;const fwd=c[i+HORIZON]/c[i]-1;return fwd>COST?1:fwd<-COST?0:null;}
export function trainLogistic(X,y,{lambda=0.01,iters=300,lr=0.5}={}){
  const n=X.length,k=X[0].length,mu=Array(k).fill(0),sd=Array(k).fill(0);
  for(const x of X)x.forEach((v,j)=>mu[j]+=v/n);for(const x of X)x.forEach((v,j)=>sd[j]+=(v-mu[j])**2/n);
  for(let j=0;j<k;j++)sd[j]=Math.sqrt(sd[j])||1;
  const Z=X.map(x=>x.map((v,j)=>clamp((v-mu[j])/sd[j],-5,5)));let w=Array(k).fill(0),b=0;
  for(let it=0;it<iters;it++){const gw=Array(k).fill(0);let gb=0;
    for(let i=0;i<n;i++){let s=b;for(let j=0;j<k;j++)s+=w[j]*Z[i][j];const p=1/(1+Math.exp(-s)),e=p-y[i];gb+=e;for(let j=0;j<k;j++)gw[j]+=e*Z[i][j];}
    b-=lr*gb/n;for(let j=0;j<k;j++)w[j]-=lr*(gw[j]/n+lambda*w[j]);}
  return {predict:x=>{let s=b;for(let j=0;j<k;j++)s+=w[j]*clamp((x[j]-mu[j])/sd[j],-5,5);return 1/(1+Math.exp(-s));},w,b};
}
const nexus={id:'nexus-ml-ensemble',origin:'new',tier:'advanced',ai:true,name:'NEXUS · AI 적응형 예측 모델',family:'머신러닝(로지스틱 회귀)',risk:'균형형',kind:'ml',
  interval:'240',interval_label:'4H',symbols_label:'상위 10종목',risk_overlay:RISK,
  summary:'상위 10종목의 4시간봉 12개 특징(모멘텀·추세·RSI·변동성·거래량·BTC 흐름)으로 다음 24시간 방향 확률을 학습합니다. 매 판단마다 과거로만 다시 학습하고, 최근 구간으로 스스로 검증해 적중률이 낮으면 진입하지 않습니다.',
  rules:['학습: 4시간봉마다 최근 약 160일, 결과가 확정된 봉만 라벨(24시간 뒤 ±0.3% 초과 움직임)','자기 검증: 가장 최근 20일은 학습에서 빼고 적중률 측정 → 52% 미만이거나 "항상 많은 쪽만 찍는" 기준선보다 2%p 이상 높지 않으면 신규 진입 중단','진입: 상승 확률 ≥ 60% 롱, ≤ 40% 숏, 확신도·변동성으로 비중(종목당 최대 25%, 최대 4종목)','청산: 확률이 반대로 넘어가면, 손절 ATR×2.5, 익절 ATR×4, 최대 24시간','계좌 위험 관리: 낙폭 8% 비중 절반, 15% 전량 청산 후 48시간 휴식'],
  async decide({market,acc,ctx}){
    const syms=topN(ctx,10);const btc=await market.bars('BTCUSDT','240',1000);if(!btc||btc.length<700)return {error:'BTC 4시간봉 부족'};
    const btcByT=new Map(btc.map(b=>[b.t,b.c]));const data=[];
    for(const s of syms){const bars=s==='BTCUSDT'?btc:await market.bars(s,'240',1000);if(!bars||bars.length<700)continue;data.push({s,bars,f:features(bars,btcByT),c:bars.map(b=>b.c)});}
    if(data.length<5)return {error:'학습 가능한 종목 부족'};
    const HOLD=120;const Xtr=[],ytr=[],Xva=[],yva=[];
    for(const d of data){const n=d.bars.length;for(let i=60;i<n;i++){const x=d.f[i],y=labelAt(d.c,i);if(!x||y===null)continue;if(i>=n-HOLD-HORIZON){Xva.push(x);yva.push(y);}else{Xtr.push(x);ytr.push(y);}}}
    if(Xtr.length<800||Xva.length<100)return {error:'라벨 표본 부족'};
    const m1=trainLogistic(Xtr,ytr);let hit=0;for(let i=0;i<Xva.length;i++)hit+=((m1.predict(Xva[i])>=0.5?1:0)===yva[i])?1:0;
    const acc_va=hit/Xva.length,base=Math.max(mean(yva),1-mean(yva));
    const model=trainLogistic(Xtr.concat(Xva),ytr.concat(yva));
    const preds=data.map(d=>{const i=d.bars.length-1;const p=d.f[i]?model.predict(d.f[i]):null;const a=atrSeries(d.bars).at(-1);return {s:d.s,p,atr:a,px:d.c.at(-1),atrPct:a/d.c.at(-1)};}).filter(x=>fin(x.p));
    // must beat 'always guess the majority side' by 2pp, not just 50%
    const trusted=acc_va>=Math.max(0.52,base+0.02);const target=[];
    for(const pos of Object.values(acc.positions)){const q=preds.find(x=>x.s===pos.symbol);if(!q)continue;if((pos.side==='long'&&q.p>=0.5)||(pos.side==='short'&&q.p<0.5))target.push({symbol:pos.symbol,side:pos.side,weight:0.2});}
    if(trusted){
      for(const q of preds.filter(x=>!acc.positions[x.s]&&(x.p>=0.6||x.p<=0.4)).sort((a,b)=>Math.abs(b.p-0.5)-Math.abs(a.p-0.5))){
        if(target.length>=4)break;const side=q.p>=0.5?'long':'short';const w=Number((0.25*Math.min(1,Math.abs(q.p-0.5)/0.15)*Math.min(1,0.015/Math.max(q.atrPct,1e-4))).toFixed(3));
        if(w<0.03)continue;
        target.push({symbol:q.s,side,weight:w,stop_price:side==='long'?q.px-2.5*q.atr:q.px+2.5*q.atr,take_price:side==='long'?q.px+4*q.atr:q.px-4*q.atr,hold_ms:24*H,reason:`AI 상승 확률 ${(q.p*100).toFixed(0)}%`});
      }
    }
    const top=preds.slice().sort((a,b)=>Math.abs(b.p-0.5)-Math.abs(a.p-0.5)).slice(0,5);
    return {target,note:trusted?`검증 적중률 ${(acc_va*100).toFixed(1)}% (기준선 ${(base*100).toFixed(1)}%) · `+top.map(x=>`${x.s.replace('USDT','')} ${(x.p*100).toFixed(0)}%`).join(' '):`검증 적중률 ${(acc_va*100).toFixed(1)}% · 기준선 ${(base*100).toFixed(1)}% 대비 우위 부족 · 신규 진입 중단`,
      exit_reason:'AI 확률 반전',diag:{type:'ml',train_samples:Xtr.length+Xva.length,validation_samples:Xva.length,validation_accuracy_pct:Number((acc_va*100).toFixed(2)),
        validation_base_rate_pct:Number((base*100).toFixed(2)),trusted,symbols:data.length,features:12,horizon_hours:24,
        top_probabilities:top.map(x=>({symbol:x.s,p_up:Number(x.p.toFixed(3))}))}};
  }};

// ------------------------------------------------- REGIME: meta strategy ---
const regime={id:'regime-switch-meta',origin:'new',tier:'advanced',ai:false,name:'REGIME · 국면 전환 메타 엔진',family:'국면 인식 + 전략 전환',risk:'균형형',kind:'meta',
  interval:'240',interval_label:'4H',symbols_label:'BTC·ETH + 상위 20',risk_overlay:RISK,trailAtr:true,
  summary:'BTC 다중 시간대 국면과 50종목 시장 폭(상승·하락 국면 비율)으로 시장 상태를 상승 추세·하락 추세·횡보·고변동 네 가지로 판별하고, 상태마다 다른 하위 전략으로 바꿔 운용합니다.',
  rules:['상승 추세: 상위 20 중 4H 상승 국면·14일 모멘텀 상위 3종목 롱(각 25%, ATR×3 추적 손절)','하락 추세: 4H 하락 국면 중 가장 약한 2종목 숏(각 20%, ATR×3 추적 손절)','횡보: BTC·ETH 4H 볼린저 z ≤ −2 롱 / ≥ +2 숏, |z|<0.3 청산, 최대 48시간','고변동: 신규 진입 없이 보유분만 관리','상태가 바뀌면 이전 상태의 포지션 정리 · 계좌 낙폭 브레이크 적용'],
  async decide({market,acc,ctx}){
    const b4=await market.bars('BTCUSDT','240',300),bd=await market.bars('BTCUSDT','D',120);if(!b4||!bd||bd.length<60)return {error:'BTC 자료 부족'};
    const r4=regimeAt(b4),dc=bd.map(x=>x.c),dUp=dc.at(-1)>emaSeries(dc,50).at(-1);
    const items=ctx.scanner?.items||[];const ok=items.filter(x=>x.regimes?.['4h']?.status==='ok');
    const breadth=ok.length>=20?(ok.filter(x=>x.regimes['4h'].state==='up').length-ok.filter(x=>x.regimes['4h'].state==='down').length)/ok.length:0;
    const state=r4==='volatile'?'volatile':(r4==='up'||(dUp&&breadth>0.2))?'bull':(r4==='down'&&!dUp&&breadth<-0.2)?'bear':'range';
    const prev=acc.memo.regime_state;acc.memo.regime_state=state;
    const keep=Object.values(acc.positions).filter(p=>p.regime_tag===state||state==='volatile').map(p=>({symbol:p.symbol,side:p.side,weight:0.2}));
    const target=[...keep];
    if(state==='bull'){
      const cands=[];for(const it of items.filter(x=>x.rank<=20&&x.regimes?.['4h']?.state==='up')){const d=await market.bars(it.symbol,'D',30);if(d&&d.length>=15)cands.push({s:it.symbol,m:d.at(-1).c/d.at(-15).c-1});}
      for(const c of cands.sort((a,b)=>b.m-a.m)){if(target.length>=3)break;if(target.some(t=>t.symbol===c.s))continue;const b=await market.bars(c.s,'240',120);if(!b)continue;const a=atrSeries(b).at(-1),px=b.at(-1).c;
        target.push({symbol:c.s,side:'long',weight:0.25,stop_price:px-3*a,trail_atr:3*a,regime_tag:'bull',reason:`상승 추세 · 14일 ${(c.m*100).toFixed(1)}%`});}
    }else if(state==='bear'){
      const cands=[];for(const it of items.filter(x=>x.rank<=20&&x.regimes?.['4h']?.state==='down')){const d=await market.bars(it.symbol,'D',30);if(d&&d.length>=15)cands.push({s:it.symbol,m:d.at(-1).c/d.at(-15).c-1});}
      for(const c of cands.sort((a,b)=>a.m-b.m)){if(target.length>=2)break;if(target.some(t=>t.symbol===c.s))continue;const b=await market.bars(c.s,'240',120);if(!b)continue;const a=atrSeries(b).at(-1),px=b.at(-1).c;
        target.push({symbol:c.s,side:'short',weight:0.2,stop_price:px+3*a,trail_atr:3*a,regime_tag:'bear',reason:`하락 추세 · 14일 ${(c.m*100).toFixed(1)}%`});}
    }else if(state==='range'){
      for(const s of ['BTCUSDT','ETHUSDT']){const b=s==='BTCUSDT'?b4:await market.bars(s,'240',120);if(!b)continue;const c=b.map(x=>x.c).slice(-20),m=mean(c),sd=std(c),z=(c.at(-1)-m)/(sd||1),a=atrSeries(b).at(-1),px=c.at(-1);
        const held=acc.positions[s];
        if(held&&held.regime_tag==='range'){const i=target.findIndex(t=>t.symbol===s);if(Math.abs(z)<0.3&&i>=0)target.splice(i,1);continue;}
        if(z<=-2)target.push({symbol:s,side:'long',weight:0.25,stop_price:px-2.5*a,hold_ms:48*H,regime_tag:'range',reason:`횡보 · z ${z.toFixed(2)}`});
        else if(z>=2)target.push({symbol:s,side:'short',weight:0.25,stop_price:px+2.5*a,hold_ms:48*H,regime_tag:'range',reason:`횡보 · z ${z.toFixed(2)}`});}
    }
    const label={bull:'상승 추세',bear:'하락 추세',range:'횡보',volatile:'고변동'}[state];
    return {target,note:`시장 상태 ${label}${prev&&prev!==state?` (직전 ${({bull:'상승 추세',bear:'하락 추세',range:'횡보',volatile:'고변동'})[prev]})`:''} · 시장 폭 ${(breadth*100).toFixed(0)}%`,exit_reason:prev&&prev!==state?'시장 상태 전환':'하위 전략 청산',
      diag:{type:'regime',state,previous_state:prev||null,btc_4h:r4,btc_daily_above_ema50:dUp,breadth_pct:Number((breadth*100).toFixed(1)),breadth_symbols:ok.length}};
  }};

// ---------------------------------------- FLOW: derivatives composite ---
const flow={id:'flow-derivatives-composite',origin:'new',tier:'advanced',ai:false,name:'FLOW · 파생 수급 복합 신호',family:'파생 수급(OI·펀딩·거래대금)',risk:'적극형',kind:'flow',
  interval:'60',interval_label:'1H',symbols_label:'상위 30종목',risk_overlay:RISK,
  summary:'미결제약정 증가 방향, 펀딩비 위치, 거래대금 급증, 1시간 추세 정렬을 하나의 점수로 묶어 새로 유입되는 추세에 올라타고, 가격이 빠지는데 롱이 쌓이는 종목은 반대로 공략합니다.',
  rules:['롱 후보: 가격↑·OI↑(+3% 이상), 펀딩 30일 위치 80% 미만, 1H 종가 > EMA20 > EMA50','숏 후보: 가격↓·OI↑, 펀딩 양수(롱이 비용을 내며 버팀), 1H 종가 < EMA20 < EMA50','점수 = OI 변화 + 24h 가격 변화 + 거래대금 배수 가산, 롱·숏 각 상위 2개(각 15%)','손절 ATR×2, 익절 ATR×3.5, 최대 36시간 · 계좌 낙폭 브레이크'],
  async decide({market,acc,ctx}){
    const sc=ctx.scanner;if(!sc)return {target:null,note:'스캐너 자료 대기'};
    const target=Object.values(acc.positions).map(p=>({symbol:p.symbol,side:p.side,weight:0.15}));
    const longs=[],shorts=[];
    for(const it of sc.items.filter(x=>x.rank<=30)){
      if(acc.positions[it.symbol]||!fin(it.oi_change_24h_pct)||!fin(it.change_24h_pct))continue;
      const tv=fin(it.turnover_vs_7d)?Math.max(0,it.turnover_vs_7d-1):0;
      if(it.flow_quadrant==='price_up_oi_up'&&it.oi_change_24h_pct>=3&&(!fin(it.funding_percentile_30d)||it.funding_percentile_30d<80))longs.push({it,score:it.oi_change_24h_pct/5+it.change_24h_pct/5+tv});
      if(it.flow_quadrant==='price_down_oi_up'&&it.oi_change_24h_pct>=3&&fin(it.funding_pct)&&it.funding_pct>0)shorts.push({it,score:it.oi_change_24h_pct/5-it.change_24h_pct/5+tv});
    }
    let added=0;
    for(const [list,side,max] of [[longs.sort((a,b)=>b.score-a.score),'long',2],[shorts.sort((a,b)=>b.score-a.score),'short',2]]){
      let n=target.filter(t=>t.side===side).length;
      for(const {it,score} of list){if(n>=max)break;const b=await market.bars(it.symbol,'60',120);if(!b||b.length<60)continue;
        const c=b.map(x=>x.c),e20=emaSeries(c,20).at(-1),e50=emaSeries(c,50).at(-1),px=c.at(-1),a=atrSeries(b).at(-1);
        const aligned=side==='long'?px>e20&&e20>e50:px<e20&&e20<e50;if(!aligned||!fin(a))continue;
        target.push({symbol:it.symbol,side,weight:0.15,stop_price:side==='long'?px-2*a:px+2*a,take_price:side==='long'?px+3.5*a:px-3.5*a,hold_ms:36*H,reason:`수급 점수 ${score.toFixed(2)} · OI ${it.oi_change_24h_pct.toFixed(1)}%`});n++;added++;}
    }
    return {target,note:`후보 롱 ${longs.length} · 숏 ${shorts.length} · 신규 ${added}`,diag:{type:'flow',long_candidates:longs.length,short_candidates:shorts.length}};
  }};

// ------------------------------------- NEUTRAL: residual momentum L/S ---
export function residualScores(series,btc){
  // series: {symbol: daily closes (≥ 40)}; 14-day residual return skipping the latest day.
  const rb=[];for(let i=btc.length-30;i<btc.length;i++)rb.push(btc[i]/btc[i-1]-1);const mb=mean(rb),vb=rb.reduce((x,y)=>x+(y-mb)**2,0);
  const out=[];
  for(const [s,c] of Object.entries(series)){
    if(c.length<40||vb<1e-12)continue;const r=[];for(let i=c.length-30;i<c.length;i++)r.push(c[i]/c[i-1]-1);const m=mean(r);let cov=0;r.forEach((v,k)=>cov+=(v-m)*(rb[k]-mb));
    const beta=cov/vb;if(!fin(beta)||Math.abs(beta)>5)continue;
    const ret=c.at(-2)/c.at(-16)-1,bret=btc.at(-2)/btc.at(-16)-1;out.push({s,res:ret-beta*bret,vol:std(r)*Math.sqrt(365),beta});
  }
  const xs=out.map(x=>x.res),m=mean(xs),sd=std(xs)||1;out.forEach(x=>x.z=(x.res-m)/sd);return out;
}
const neutral={id:'neutral-residual-ls',origin:'new',tier:'advanced',ai:false,name:'VERTEX · 시장중립 잔차 모멘텀',family:'시장중립 롱숏(통계적)',risk:'보수형',kind:'market_neutral',
  interval:'D',interval_label:'1D',symbols_label:'상위 20종목',risk_overlay:RISK,
  summary:'BTC 영향(베타)을 뺀 14일 잔차 수익률로 상위 20종목을 줄 세워 강한 3종목 롱·약한 3종목 숏을 같은 금액으로 보유합니다. 시장 전체가 오르내려도 영향을 덜 받도록 설계했습니다.',
  rules:['잔차 = 14일 수익률(최근 1일 제외) − β×BTC 수익률, β는 30일 일간 수익률로 추정','잔차 z점수 상위 3 롱 / 하위 3 숏, 변동성 역가중, 롱·숏 금액 동일(총 노출 120%)','매일 UTC 0시 교체, 다리별 손절 10%','계좌 낙폭 브레이크 적용'],
  async decide({market,ctx}){
    const btc=await market.bars('BTCUSDT','D',60);if(!btc||btc.length<40)return {error:'BTC 일봉 부족'};
    const series={};for(const s of topN(ctx,20)){if(s==='BTCUSDT')continue;const d=await market.bars(s,'D',60);if(d&&d.length>=40&&d.at(-1).t===btc.at(-1).t)series[s]=d.map(x=>x.c);}
    const sc=residualScores(series,btc.map(x=>x.c)).sort((a,b)=>b.z-a.z);if(sc.length<8)return {error:'잔차 계산 종목 부족'};
    const longs=sc.slice(0,3),shorts=sc.slice(-3);
    const leg=(arr,side)=>{const inv=arr.map(x=>1/Math.max(x.vol,0.2)),tot=inv.reduce((a,b)=>a+b,0);return arr.map((x,i)=>({symbol:x.s,side,weight:Number((0.6*inv[i]/tot).toFixed(3)),stop_pct:0.10,reason:`잔차 z ${x.z.toFixed(2)}`}));};
    return {target:[...leg(longs,'long'),...leg(shorts,'short')],note:`롱 ${longs.map(x=>x.s.replace('USDT','')).join('·')} / 숏 ${shorts.map(x=>x.s.replace('USDT','')).join('·')}`,exit_reason:'일간 교체',
      diag:{type:'neutral',universe:sc.length,long:longs.map(x=>({symbol:x.s,z:Number(x.z.toFixed(2)),beta:Number(x.beta.toFixed(2))})),short:shorts.map(x=>({symbol:x.s,z:Number(x.z.toFixed(2)),beta:Number(x.beta.toFixed(2))}))}};
  }};

// ------------------------------------- SENTINEL: risk-parity TSMOM ---
export function tsmomWeights(closes,targetVol=0.2){
  const out={};const n=Object.keys(closes).length;
  for(const [s,c] of Object.entries(closes)){
    if(c.length<125)continue;const sig=[20,60,120].map(l=>Math.sign(c.at(-1)/c.at(-1-l)-1)).reduce((a,b)=>a+b,0)/3;
    const r=[];for(let i=c.length-60;i<c.length;i++)r.push(Math.log(c[i]/c[i-1]));const vol=std(r)*Math.sqrt(365);
    out[s]={signal:sig,vol,weight:clamp(sig*(targetVol/Math.sqrt(n))/Math.max(vol,0.05),-0.6,0.6)};
  }
  const gross=Object.values(out).reduce((a,x)=>a+Math.abs(x.weight),0);if(gross>1.5)for(const x of Object.values(out))x.weight*=1.5/gross;
  return out;
}
const sentinel={id:'sentinel-risk-parity-trend',origin:'new',tier:'advanced',ai:false,name:'SENTINEL · 리스크 패리티 추세',family:'다중 기간 추세 + 위험 균등',risk:'보수형',kind:'risk_parity',
  interval:'D',interval_label:'1D',symbols_label:'BTC·ETH·SOL',risk_overlay:RISK,resize:true,
  summary:'20·60·120일 세 기간의 추세 방향을 합쳐 BTC·ETH·SOL의 롱/숏 강도를 정하고, 각 코인이 포트폴리오 위험에 같은 몫을 갖도록 변동성으로 비중을 나눕니다(연 20% 변동성 목표).',
  rules:['신호 = 20·60·120일 수익률 부호의 평균(−1 ~ +1)','비중 = 신호 × (20% ÷ √3) ÷ 60일 변동성, 종목당 최대 60%, 총 150% 한도','매일 확인, 비중 차이 20% 넘을 때만 조정, 방향 바뀌면 교체','계좌 낙폭 브레이크 적용'],
  async decide({market}){
    const closes={};for(const s of ['BTCUSDT','ETHUSDT','SOLUSDT']){const d=await market.bars(s,'D',160);if(!d||d.length<125)return {error:s+' 일봉 부족'};closes[s]=d.map(x=>x.c);}
    const w=tsmomWeights(closes);
    const target=Object.entries(w).filter(([,x])=>Math.abs(x.weight)>=0.03).map(([s,x])=>({symbol:s,side:x.weight>0?'long':'short',weight:Number(Math.abs(x.weight).toFixed(3)),reason:`추세 ${x.signal.toFixed(2)} · 변동성 ${(x.vol*100).toFixed(0)}%`}));
    return {target,note:Object.entries(w).map(([s,x])=>`${s.replace('USDT','')} ${(x.weight*100).toFixed(0)}%`).join(' · '),exit_reason:'추세 방향 전환',
      diag:{type:'risk_parity',weights:Object.fromEntries(Object.entries(w).map(([s,x])=>[s,{signal:Number(x.signal.toFixed(2)),vol_pct:Number((x.vol*100).toFixed(1)),weight_pct:Number((x.weight*100).toFixed(1))}]))}};
  }};

export const ADVANCED=[nexus,regime,flow,neutral,sentinel];
