/** LUMEX paper league strategy rules (pure decisions; no I/O except market reads passed in).
 * decide() returns {target:null|[], note}:  null = keep current positions, [] = go flat,
 * [{symbol, side:'long'|'short', weight (fraction of equity, notional), stop_pct/take_pct/hold_ms/trail_atr}].
 *
 * The seven "existing" strategies reproduce the rules already registered in Core
 * (Lumex_Demo_Autotrade::evaluate and Lumex_Cross_Asset_Signals) — same indicators, thresholds,
 * sizes, stops and rebalance calendar. Only the fill model differs (real-time fills, 1m stops).
 * The six "new" strategies were written for this league on 2026-11-22 and have no backtest claim.
 */
const H=3600000,D=86400000;
const fin=x=>typeof x==='number'&&Number.isFinite(x);
// PHP-identical EMA (SMA seed) used by the registered strategies
export function emaSeeded(closes,period){if(closes.length<period)return null;let v=closes.slice(0,period).reduce((a,b)=>a+b,0)/period;const a=2/(period+1);
  for(let i=period;i<closes.length;i++)v=(closes[i]-v)*a+v;return v;}
export function emaSeries(closes,period){const out=[];let v=closes[0];const a=2/(period+1);closes.forEach((c,i)=>{v=i?c*a+v*(1-a):c;out.push(v);});return out;}
export function rsiSeries(closes,n=14){const out=[null];let g=0,l=0;for(let i=1;i<closes.length;i++){const d=closes[i]-closes[i-1],up=Math.max(0,d),dn=Math.max(0,-d);
  if(i<=n){g+=up;l+=dn;if(i===n){g/=n;l/=n;}}else{g=(g*(n-1)+up)/n;l=(l*(n-1)+dn)/n;}
  out.push(i>=n?(l<1e-12?(g<1e-12?50:100):100-100/(1+g/l)):null);}return out;}
export function atrSeries(bars,n=14){const out=[null];let a=0;for(let i=1;i<bars.length;i++){const b=bars[i],p=bars[i-1].c;const tr=Math.max(b.h-b.l,Math.abs(b.h-p),Math.abs(b.l-p));
  if(i<=n){a+=tr;if(i===n)a/=n;}else a=(a*(n-1)+tr)/n;out.push(i>=n?a:null);}return out;}
/** Same regime rule as Core/Worker scanner (EMA20/50 + RSI14 + ATR14 vs 60-bar median). */
export function regimeAt(bars){
  if(!bars||bars.length<120)return null;const c=bars.map(b=>b.c),e20=emaSeries(c,20),e50=emaSeries(c,50),r=rsiSeries(c),a=atrSeries(bars);
  const i=bars.length-1,pct=a.map((x,k)=>x===null?null:x/c[k]*100);const past=pct.slice(Math.max(14,i-60),i).filter(fin).sort((x,y)=>x-y);
  if(past.length<30)return null;const h=past.length>>1,med=past.length%2?past[h]:(past[h-1]+past[h])/2;
  const up=e20[i]>e50[i]*1.0015&&c[i]>e20[i]&&r[i]>=54,down=e20[i]<e50[i]*0.9985&&c[i]<e20[i]&&r[i]<=46;
  return pct[i]>Math.max(0.8,med*1.42)?'volatile':up?'up':down?'down':'range';
}
const prior=(bars,len)=>bars.slice(bars.length-1-len,bars.length-1);
const hi=a=>Math.max(...a.map(b=>b.h)),lo=a=>Math.min(...a.map(b=>b.l));

// ---------------------------------------------------- registered (existing) ---
export function evaluateSingle(kind,bars){
  const n=bars.length;if(n<230)return null;const closes=bars.map(b=>b.c),price=closes[n-1];
  const e50=emaSeeded(closes,50),e200=emaSeeded(closes,200);let signal='FLAT';
  if(kind==='btc'){if(price>hi(prior(bars,120))&&e50>e200)signal='LONG';else if(price<lo(prior(bars,120))&&e50<e200)signal='SHORT';}
  else{if(price>hi(prior(bars,60))&&price>closes[n-31])signal='LONG';else if(price<lo(prior(bars,120))&&price<closes[n-61])signal='SHORT';}
  return {signal,exit_long:price<lo(prior(bars,40)),exit_short:price>hi(prior(bars,40))};
}
function single(id,name,symbol,kind,stop,take,meta){
  return {id,origin:'existing',...meta,interval:'240',interval_label:'4H',symbols_label:symbol.replace('USDT',''),
    async decide({market,acc}){
      const bars=await market.bars(symbol,'240',300);if(!bars||bars.length<230)return {error:'4시간봉 부족'};
      const e=evaluateSingle(kind,bars);const pos=acc.positions[symbol];
      if(pos){if((pos.side==='long'&&e.exit_long)||(pos.side==='short'&&e.exit_short))return {target:[],note:'40봉 이탈 청산',exit_reason:'40봉 반대 이탈'};return {target:null,note:'보유 유지'};}
      if(e.signal==='LONG'||e.signal==='SHORT')return {target:[{symbol,side:e.signal==='LONG'?'long':'short',weight:0.24,stop_pct:stop,take_pct:take,reason:e.signal==='LONG'?'상단 돌파':'하단 이탈'}],note:e.signal};
      return {target:null,note:'돌파 없음'};
    }};
}
const CROSS=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT'];
const RULES={'rs28-core':{lb:28,reb:3,gross:0.85,th:0.05,kind:'relative'},'rs28-alt':{lb:28,reb:7,gross:1.5,th:0.12,kind:'relative'},
  'beta-residual':{lb:28,reb:3,gross:0.75,th:0.06,kind:'beta'},'vol-normal':{lb:28,reb:7,gross:0.5,th:0.9,kind:'vol'},
  'funding-contrarian':{lb:7,reb:14,gross:0.5,th:0.001,kind:'funding'}};
export function rebalanceDue(prevBar,bar,days){if(!prevBar)return false;const period=days*24;
  for(let t=prevBar+H;t<=bar;t+=H){const slot=(t+H)/H;if(slot%period===0)return true;}return false;}
export function crossScores(key,close,fundingSums){
  const r=RULES[key],lb=r.lb*24,ret={},score={};
  for(const s of CROSS){const p=close[s],n=p.length;if(n<=lb)return null;ret[s]=p[n-1]/p[n-1-lb]-1;}
  if(r.kind==='relative')Object.assign(score,ret);
  else if(r.kind==='beta'){const b=close.BTCUSDT,off=b.length-1-lb,x=[];for(let i=off+1;i<b.length;i++)x.push(b[i]/b[i-1]-1);
    const mx=x.reduce((a,v)=>a+v,0)/x.length;let den=0;for(const v of x)den+=(v-mx)**2;if(den<1e-15)return null;
    for(const s of CROSS){if(s==='BTCUSDT'){score[s]=0;continue;}const p=close[s],y=[];for(let i=off+1;i<p.length;i++)y.push(p[i]/p[i-1]-1);
      const my=y.reduce((a,v)=>a+v,0)/y.length;let cov=0;x.forEach((v,j)=>cov+=(v-mx)*(y[j]-my));const beta=cov/den;if(!fin(beta)||Math.abs(beta)>20)return null;score[s]=ret[s]-beta*ret.BTCUSDT;}}
  else if(r.kind==='vol'){for(const s of CROSS){const p=close[s],off=p.length-1-lb,y=[];for(let i=off+1;i<p.length;i++)y.push(p[i]/p[i-1]-1);
    const m=y.reduce((a,v)=>a+v,0)/y.length;let v=0;for(const q of y)v+=(q-m)**2;const sig=Math.sqrt(v/Math.max(1,y.length-1));if(sig<1e-10)return null;score[s]=ret[s]/(sig*Math.sqrt(lb));}}
  else{if(!fundingSums)return null;Object.assign(score,fundingSums);}
  const order=CROSS.slice().sort((a,b)=>score[a]-score[b]),weak=order[0],strong=order[3],gap=score[strong]-score[weak];
  return {gap,weak,strong,signal:gap>=r.th};
}
function cross(id,meta){
  const r=RULES[id];
  return {id,origin:'existing',groupExit:true,...meta,interval:'60',interval_label:'1H',symbols_label:'BTC·ETH·SOL·XRP',
    async decide({market,acc,bar_ms,prev_bar_ms,now}){
      if(!rebalanceDue(prev_bar_ms,bar_ms,r.reb))return {target:null,note:prev_bar_ms?'다음 리밸런싱 대기':'시작 · 다음 리밸런싱 대기'};
      const close={};
      for(const s of CROSS){const b=await market.bars(s,'60',800);if(!b||b.length<673)return {error:s+' 1시간봉 부족'};
        if(b.at(-1).t!==bar_ms)return {error:s+' 최신 봉 불일치'};close[s]=b.slice(-673).map(x=>x.c);}
      let sums=null;
      if(r.kind==='funding'){sums={};const cutoff=bar_ms+H-7*D;
        for(const s of CROSS){const f=await market.funding(s);if(!f)return {error:s+' 펀딩 기록 없음'};const rows=f.filter(x=>x.t>=cutoff&&x.t<=bar_ms+H);
          if(rows.length<7)return {error:s+' 펀딩 7일 기록 부족'};sums[s]=rows.reduce((a,x)=>a+x.rate,0);}}
      const sc=crossScores(id,close,sums);if(!sc)return {error:'점수 계산 불가'};
      if(!sc.signal)return {target:[],note:`격차 ${(sc.gap*100).toFixed(2)}% · 기준 미달`,exit_reason:'리밸런싱(무신호)'};
      const w=r.gross/2;
      return {target:[{symbol:sc.weak,side:'long',weight:w,stop_pct:0.05,take_pct:0.12,reason:'약세 종목 매수'},{symbol:sc.strong,side:'short',weight:w,stop_pct:0.05,take_pct:0.12,reason:'강세 종목 매도'}],
        note:`${sc.weak.replace('USDT','')} 매수 · ${sc.strong.replace('USDT','')} 매도`,exit_reason:'리밸런싱'};
    }};
}

// --------------------------------------------------------- new strategies ---
const MAJORS=['BTCUSDT','ETHUSDT','SOLUSDT'];
const pulse={id:'pulse-mtf-trend',origin:'new',name:'PULSE · 다중 시간대 추세',family:'추세 추종',risk:'균형형',kind:'trend',interval:'240',interval_label:'4H',symbols_label:'BTC·ETH·SOL',
  summary:'일봉 방향과 4시간 국면이 같을 때만 진입하고, ATR 추적 손절로 추세를 따라갑니다.',
  rules:['일봉 EMA50 위·4H 상승 국면 → 롱, 일봉 EMA50 아래·4H 하락 국면 → 숏','종목당 자산의 30%, 최대 3종목','손절: 진입 후 4H ATR×3 추적','4H 국면이 반대로 바뀌면 청산'],
  trailAtr:true,
  async decide({market,acc}){
    const target=[];let notes=[];
    for(const s of MAJORS){
      const b4=await market.bars(s,'240',300),bd=await market.bars(s,'D',120);if(!b4||!bd||bd.length<60)return {error:s+' 봉 부족'};
      const reg=regimeAt(b4),dc=bd.map(x=>x.c),e50=emaSeries(dc,50).at(-1),atr=atrSeries(b4).at(-1),px=b4.at(-1).c;
      const pos=acc.positions[s];const want=dc.at(-1)>e50&&reg==='up'?'long':dc.at(-1)<e50&&reg==='down'?'short':null;
      notes.push(s.replace('USDT','')+' '+(reg||'—'));
      if(pos){const flip=(pos.side==='long'&&reg==='down')||(pos.side==='short'&&reg==='up');if(!flip)target.push({symbol:s,side:pos.side,weight:0.3});continue;}
      if(want&&fin(atr))target.push({symbol:s,side:want,weight:0.3,stop_price:want==='long'?px-3*atr:px+3*atr,trail_atr:3*atr,reason:'일봉·4H 방향 일치'});
    }
    return {target,note:notes.join(' · '),exit_reason:'4H 국면 반전'};
  }};
const squeezeSyms=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','DOGEUSDT'];
const tide={id:'tide-squeeze-breakout',origin:'new',name:'TIDE · 변동성 수축 돌파',family:'변동성 돌파',risk:'적극형',kind:'breakout',interval:'60',interval_label:'1H',symbols_label:'BTC·ETH·SOL·XRP·DOGE',
  summary:'1시간봉 볼린저 폭이 최근 5일 중 하위 20%로 좁아진 뒤 24시간 고점·저점을 돌파하면 따라갑니다.',
  rules:['조건: 볼린저(20,2) 폭이 직전 120봉 중 하위 20%','종가가 직전 24봉 고점 돌파 → 롱 / 저점 이탈 → 숏','손절 ATR×2, 익절 ATR×4, 최대 48시간 보유','종목당 자산의 20%, 최대 3종목'],
  async decide({market,acc}){
    const target=Object.values(acc.positions).map(p=>({symbol:p.symbol,side:p.side,weight:0.2}));let hits=0;
    for(const s of squeezeSyms){if(acc.positions[s]||target.length>=3)continue;
      const b=await market.bars(s,'60',200);if(!b||b.length<150)continue;
      const c=b.map(x=>x.c),width=[];for(let i=19;i<c.length;i++){const w=c.slice(i-19,i+1),m=w.reduce((a,v)=>a+v,0)/20,sd=Math.sqrt(w.reduce((a,v)=>a+(v-m)**2,0)/20);width.push(4*sd/m);}
      const last=width.at(-2),hist=width.slice(-122,-2).sort((x,y)=>x-y);if(hist.length<100)continue;
      const squeezed=last<=hist[Math.floor(hist.length*0.2)];const atr=atrSeries(b).at(-1),px=c.at(-1),h24=hi(prior(b,24)),l24=lo(prior(b,24));
      if(!squeezed||!fin(atr))continue;
      if(px>h24){target.push({symbol:s,side:'long',weight:0.2,stop_price:px-2*atr,take_price:px+4*atr,hold_ms:48*H,reason:'수축 후 상단 돌파'});hits++;}
      else if(px<l24){target.push({symbol:s,side:'short',weight:0.2,stop_price:px+2*atr,take_price:px-4*atr,hold_ms:48*H,reason:'수축 후 하단 이탈'});hits++;}
    }
    return {target,note:hits?`신규 돌파 ${hits}건`:'돌파 대기'};
  }};
const harbor={id:'harbor-range-revert',origin:'new',name:'HARBOR · 횡보장 평균회귀',family:'평균 회귀',risk:'보수형',kind:'mean_reversion',interval:'60',interval_label:'1H',symbols_label:'BTC·ETH',
  summary:'4시간 국면이 횡보일 때만, 1시간 RSI가 극단으로 밀리면 반대로 진입해 중간값 복귀를 노립니다.',
  rules:['4H 국면 = 횡보(추세·고변동 구간 제외)','1H RSI14 ≤ 28 → 롱, ≥ 72 → 숏','RSI 50 복귀 시 청산, 손절 1H ATR×2.5, 최대 24시간','종목당 자산의 25%'],
  async decide({market,acc}){
    const target=[];const notes=[];
    for(const s of ['BTCUSDT','ETHUSDT']){
      const b1=await market.bars(s,'60',200),b4=await market.bars(s,'240',200);if(!b1||!b4)return {error:s+' 봉 부족'};
      const reg=regimeAt(b4),rsi=rsiSeries(b1.map(x=>x.c)).at(-1),atr=atrSeries(b1).at(-1),px=b1.at(-1).c,pos=acc.positions[s];
      notes.push(`${s.replace('USDT','')} RSI ${fin(rsi)?rsi.toFixed(0):'—'}`);
      if(pos){const done=(pos.side==='long'&&rsi>=50)||(pos.side==='short'&&rsi<=50)||reg!=='range';if(!done)target.push({symbol:s,side:pos.side,weight:0.25});continue;}
      if(reg!=='range'||!fin(rsi)||!fin(atr))continue;
      if(rsi<=28)target.push({symbol:s,side:'long',weight:0.25,stop_price:px-2.5*atr,hold_ms:24*H,reason:'횡보장 과매도'});
      else if(rsi>=72)target.push({symbol:s,side:'short',weight:0.25,stop_price:px+2.5*atr,hold_ms:24*H,reason:'횡보장 과매수'});
    }
    return {target,note:notes.join(' · '),exit_reason:'RSI 중립 복귀/국면 변화'};
  }};
const carry={id:'carry-funding-fade',origin:'new',name:'CARRY · 펀딩 쏠림 역추세',family:'펀딩 역추세',risk:'적극형',kind:'funding',interval:'60',interval_label:'1H',symbols_label:'상위 20종목',
  summary:'한쪽으로 쏠린 펀딩비(30일 기록 중 상위·하위 5%)에서 가격 모멘텀이 꺾이는 순간 반대로 진입합니다.',
  rules:['대상: 거래대금 상위 20종목(PRO 스캐너)','펀딩 30일 상위 5% & 0.03% 이상 & 종가 < 1H EMA20 → 숏','펀딩 하위 5% & −0.01% 이하 & 종가 > 1H EMA20 → 롱','손절 4%, 익절 6%, 최대 72시간, 종목당 20%, 최대 3종목'],
  async decide({market,acc,ctx}){
    const sc=ctx.scanner;const target=Object.values(acc.positions).map(p=>({symbol:p.symbol,side:p.side,weight:0.2}));
    if(!sc)return {target:null,note:'스캐너 자료 대기'};let hits=0;
    for(const it of sc.items.filter(x=>x.rank<=20)){
      if(target.length>=3)break;if(acc.positions[it.symbol]||!fin(it.funding_percentile_30d)||!fin(it.funding_pct))continue;
      const longCrowd=it.funding_percentile_30d>=95&&it.funding_pct>=0.03,shortCrowd=it.funding_percentile_30d<=5&&it.funding_pct<=-0.01;
      if(!longCrowd&&!shortCrowd)continue;
      const b=await market.bars(it.symbol,'60',120);if(!b||b.length<60)continue;const e20=emaSeries(b.map(x=>x.c),20).at(-1),px=b.at(-1).c;
      if(longCrowd&&px<e20){target.push({symbol:it.symbol,side:'short',weight:0.2,stop_pct:0.04,take_pct:0.06,hold_ms:72*H,reason:'롱 쏠림 펀딩 + 모멘텀 약화'});hits++;}
      if(shortCrowd&&px>e20){target.push({symbol:it.symbol,side:'long',weight:0.2,stop_pct:0.04,take_pct:0.06,hold_ms:72*H,reason:'숏 쏠림 펀딩 + 모멘텀 회복'});hits++;}
    }
    return {target,note:hits?`신규 ${hits}건`:'극단 펀딩 대기'};
  }};
const momentum={id:'momentum-rotation-top20',origin:'new',name:'ROTOR · 상위 종목 모멘텀 로테이션',family:'모멘텀 로테이션',risk:'적극형',kind:'rotation',interval:'D',interval_label:'1D',symbols_label:'상위 20종목',
  summary:'매일 UTC 0시, 거래대금 상위 20종목 중 7일 수익률 상위 3종목(4H 상승 국면)을 롱으로 보유합니다. BTC가 일봉 EMA50 아래면 쉬어 갑니다.',
  rules:['시장 필터: BTC 일봉 종가 > EMA50','후보: 상위 20종목 중 4H 국면 상승','7일 수익률 상위 3종목, 각 자산의 25%','매일 교체, 종목별 손절 8%'],
  async decide({market,ctx}){
    const sc=ctx.scanner;if(!sc)return {error:'스캐너 자료 없음'};
    const btc=await market.bars('BTCUSDT','D',120);if(!btc||btc.length<60)return {error:'BTC 일봉 부족'};
    const bc=btc.map(x=>x.c);if(bc.at(-1)<emaSeries(bc,50).at(-1))return {target:[],note:'BTC 일봉 EMA50 아래 · 현금 보유',exit_reason:'시장 필터'};
    const cands=[];
    for(const it of sc.items.filter(x=>x.rank<=20&&x.regimes?.['4h']?.state==='up')){
      const d=await market.bars(it.symbol,'D',30);if(!d||d.length<9)continue;cands.push({s:it.symbol,r:d.at(-1).c/d.at(-8).c-1});}
    const pick=cands.sort((a,b)=>b.r-a.r).slice(0,3);
    return {target:pick.map(p=>({symbol:p.s,side:'long',weight:0.25,stop_pct:0.08,reason:`7일 ${(p.r*100).toFixed(1)}%`})),note:pick.map(p=>p.s.replace('USDT','')).join('·')||'후보 없음',exit_reason:'로테이션 교체'};
  }};
const shield={id:'shield-btc-voltarget',origin:'new',name:'SHIELD · BTC 변동성 타깃',family:'변동성 관리',risk:'보수형',kind:'vol_target',interval:'D',interval_label:'1D',symbols_label:'BTC',resize:true,
  summary:'BTC가 일봉 EMA100 위일 때만 롱을 보유하고, 최근 30일 변동성에 맞춰 비중을 줄이거나 늘립니다(연 30% 변동성 목표, 최대 100%).',
  rules:['조건: BTC 일봉 종가 > EMA100','비중 = 30% ÷ 30일 실현 변동성(연환산), 최대 100%','비중 차이가 20% 넘을 때만 조정','EMA100 아래로 내려가면 전량 청산'],
  async decide({market}){
    const d=await market.bars('BTCUSDT','D',160);if(!d||d.length<110)return {error:'BTC 일봉 부족'};
    const c=d.map(x=>x.c),e=emaSeries(c,100).at(-1);if(c.at(-1)<e)return {target:[],note:'EMA100 아래 · 현금',exit_reason:'추세 필터 이탈'};
    const r=[];for(let i=c.length-30;i<c.length;i++)r.push(Math.log(c[i]/c[i-1]));const m=r.reduce((a,v)=>a+v,0)/r.length;
    const vol=Math.sqrt(r.reduce((a,v)=>a+(v-m)**2,0)/(r.length-1))*Math.sqrt(365);const w=Math.min(1,0.3/Math.max(vol,0.05));
    return {target:[{symbol:'BTCUSDT',side:'long',weight:Number(w.toFixed(3)),reason:'EMA100 위 · 변동성 조절'}],note:`연 변동성 ${(vol*100).toFixed(0)}% · 비중 ${(w*100).toFixed(0)}%`};
  }};

export const STRATEGIES=[
  single('btc-trend','NOVA · BTC 트렌드','BTCUSDT','btc',0.055,0.14,{name:'NOVA · BTC 트렌드',family:'추세 추종',risk:'균형형',kind:'trend',
    summary:'BTC 4시간봉 120봉 돌파 + EMA50/200 방향이 같을 때 진입하는 등록 전략입니다.',rules:['120봉 고점 돌파 & EMA50>EMA200 → 롱 (반대는 숏)','자산의 24%, 손절 5.5%, 익절 14%','40봉 반대 이탈 시 청산']}),
  single('eth-asym','VOLT · ETH 브레이크','ETHUSDT','eth',0.075,0.20,{name:'VOLT · ETH 브레이크',family:'비대칭 돌파',risk:'적극형',kind:'breakout',
    summary:'ETH 상승은 60봉, 하락은 120봉 돌파로 방향별 다른 조건을 쓰는 등록 전략입니다.',rules:['60봉 고점 돌파 & 30봉 모멘텀 → 롱','120봉 저점 이탈 & 60봉 모멘텀 → 숏','자산의 24%, 손절 7.5%, 익절 20%, 40봉 반대 이탈 청산']}),
  cross('rs28-core',{name:'ATLAS · 멀티강도',family:'상대강도',risk:'균형형',kind:'relative',summary:'4개 코인 28일 수익률 격차가 5% 이상이면 약한 코인 매수·강한 코인 매도(3일마다).',rules:['28일 수익률 최약 롱 / 최강 숏','격차 ≥ 5%일 때, 총 노출 85%','3일 리밸런싱, 다리별 손절 5%·익절 12%']}),
  cross('rs28-alt',{name:'ORBIT · 로테이션',family:'상대강도',risk:'적극형',kind:'relative',summary:'28일 수익률 격차 12% 이상에서 약세 매수·강세 매도(7일마다, 총 노출 150%).',rules:['격차 ≥ 12%','총 노출 150%','7일 리밸런싱, 손절 5%·익절 12%']}),
  cross('beta-residual',{name:'VECTOR · 상대가치',family:'상대가치',risk:'균형형',kind:'beta',summary:'BTC 영향을 뺀 잔차 수익률로 약세 매수·강세 매도(3일마다).',rules:['잔차 = 수익률 − β×BTC 수익률','격차 ≥ 6%, 총 노출 75%','3일 리밸런싱, 손절 5%·익절 12%']}),
  cross('vol-normal',{name:'AURA · 변동성 방어',family:'변동성 관리',risk:'보수형',kind:'vol',summary:'변동성으로 나눈 수익률 기준 약세 매수·강세 매도(7일마다, 총 노출 50%).',rules:['점수 = 28일 수익률 ÷ (변동성×√기간)','격차 ≥ 0.9, 총 노출 50%','7일 리밸런싱, 손절 5%·익절 12%']}),
  cross('funding-contrarian',{name:'ECHO · 펀딩 반전',family:'펀딩 역추세',risk:'적극형',kind:'funding',summary:'7일 누적 펀딩이 가장 낮은 코인 매수·가장 높은 코인 매도(14일마다).',rules:['7일 펀딩 합계 격차 ≥ 0.1%','총 노출 50%','14일 리밸런싱, 손절 5%·익절 12%']}),
  pulse,tide,harbor,carry,momentum,shield,
];
