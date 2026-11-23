/** LUMEX signature indicators — Worker copy of the chart's math (theme assets/lumex-signature-0700.js, 0.5.07.00).
 * Byte-for-byte the same functions; tests/test_signature_scanner_20261123.mjs checks parity on a fixture produced
 * by the chart file. Completed candles only. Used by the PRO-50 scanner to tag each symbol / frame.
 */
const fin=Number.isFinite;
function sma(a,n){const o=Array(a.length).fill(null);let s=0;for(let i=0;i<a.length;i++){s+=a[i];if(i>=n)s-=a[i-n];if(i>=n-1)o[i]=s/n;}return o;}
function stdev(a,n,m){const o=Array(a.length).fill(null);for(let i=n-1;i<a.length;i++){let v=0;for(let j=i-n+1;j<=i;j++)v+=(a[j]-m[i])**2;o[i]=Math.sqrt(v/n);}return o;}
const valid=b=>b&&fin(b.time)&&fin(b.open)&&fin(b.high)&&fin(b.low)&&fin(b.close)&&b.high>=b.low&&b.low>0;

/** 1. Volume profile. Each bar's volume is spread uniformly over its own high–low range. */
function profile(bars,{lookback=240,bins=48,valueArea=.7}={}){
  const b=bars.filter(valid).slice(-lookback);if(b.length<30)return null;
  let lo=Infinity,hi=-Infinity;for(const x of b){lo=Math.min(lo,x.low);hi=Math.max(hi,x.high);}
  if(!(hi>lo))return null;const step=(hi-lo)/bins,vol=Array(bins).fill(0);let total=0;
  for(const x of b){const v=fin(x.volume)&&x.volume>0?x.volume:0;if(!v)continue;total+=v;
    const a=Math.min(bins-1,Math.floor((x.low-lo)/step)),z=Math.min(bins-1,Math.floor((x.high-lo)/step));
    if(a===z){vol[a]+=v;continue;}const span=x.high-x.low;
    for(let k=a;k<=z;k++){const bl=lo+k*step,bh=bl+step;const part=(Math.min(bh,x.high)-Math.max(bl,x.low))/span;if(part>0)vol[k]+=v*part;}}
  if(!(total>0))return null;
  let poc=0;for(let k=1;k<bins;k++)if(vol[k]>vol[poc])poc=k;
  let inArea=vol[poc],L=poc,H=poc;
  while(inArea<total*valueArea&&(L>0||H<bins-1)){const down=L>0?vol[L-1]:-1,up=H<bins-1?vol[H+1]:-1;if(up>=down){H++;inArea+=vol[H];}else{L--;inArea+=vol[L];}}
  const mid=k=>lo+(k+.5)*step,max=Math.max(...vol);
  return {from:b[0].time,to:b.at(-1).time,low:lo,high:hi,step,bins:vol.map((v,k)=>({price:mid(k),low:lo+k*step,high:lo+(k+1)*step,volume:v,share:v/total,rel:max?v/max:0,inValue:k>=L&&k<=H})),
    poc:mid(poc),vah:lo+(H+1)*step,val:lo+L*step,last:b.at(-1).close,
    position:(()=>{const c=b.at(-1).close;return c>lo+(H+1)*step?'above':c<lo+L*step?'below':'inside';})()};
}
/** 2. Signed efficiency ratio: net move / sum of absolute moves, in [-1,1]. */
function purity(bars,n=20){
  const c=bars.map(x=>x.close),o=Array(c.length).fill(null);
  for(let i=n;i<c.length;i++){let path=0;for(let j=i-n+1;j<=i;j++)path+=Math.abs(c[j]-c[j-1]);const net=c[i]-c[i-n];o[i]=path>0?net/path:0;}
  return o;
}
const purityLabel=v=>!fin(v)?'자료 부족':Math.abs(v)>=.6?(v>0?'곧은 상승':'곧은 하락'):Math.abs(v)>=.3?(v>0?'상승 우세':'하락 우세'):'방향 없는 흔들림';
/** 3. Compression coil. width = (upper-lower)/middle; coil = width ≤ 10th percentile of the prior 120 widths. */
function coil(bars,{period=20,dev=2,history=120,pct=.1,minBars=3}={}){
  const c=bars.map(x=>x.close),m=sma(c,period),s=stdev(c,period,m),w=c.map((_,i)=>m[i]&&s[i]!==null?(2*dev*s[i])/m[i]:null);
  const events=[],zones=[];let run=null,gap=0;
  const close=(i)=>{const len=run.end-run.start+1;
    if(len>=minBars){zones.push({from:bars[run.start].time,to:bars[run.end].time,high:run.hi,low:run.lo,bars:len});
      events.push({time:bars[run.start].time,type:'coil',direction:'neutral',reason:`변동 폭이 최근 ${history}봉 중 하위 ${Math.round(pct*100)}%로 좁아짐`});
      // breakout = two consecutive closes outside the coil range on the same side, within the next 12 bars
      for(let k=run.end+1;k<Math.min(bars.length-1,run.end+13);k++){
        if(bars[k].close>run.hi&&bars[k+1].close>run.hi){events.push({time:bars[k+1].time,type:'coil-break',direction:'buy',reason:`압축 ${len}봉 뒤 위로 돌파 (2봉 확인)`});break;}
        if(bars[k].close<run.lo&&bars[k+1].close<run.lo){events.push({time:bars[k+1].time,type:'coil-break',direction:'sell',reason:`압축 ${len}봉 뒤 아래로 이탈 (2봉 확인)`});break;}}}
    run=null;gap=0;};
  for(let i=period+history;i<bars.length;i++){
    const prior=w.slice(i-history,i).filter(fin).sort((a,b)=>a-b);if(prior.length<history*.8||!fin(w[i]))continue;
    const thr=prior[Math.floor(prior.length*pct)],tight=w[i]<=thr;
    if(tight){if(!run)run={start:i,end:i,hi:bars[i].high,lo:bars[i].low};else{run.end=i;run.hi=Math.max(run.hi,bars[i].high);run.lo=Math.min(run.lo,bars[i].low);}gap=0;continue;}
    // a 1–2 bar loosening inside a coil does not end it (avoids split markers)
    if(run){gap++;if(gap>2||bars[i].close>run.hi||bars[i].close<run.lo)close(i);}
  }
  if(run&&run.end<bars.length-3)close(bars.length-1);
  const live=run&&run.end>=bars.length-3&&run.end-run.start+1>=minBars?{from:bars[run.start].time,high:run.hi,low:run.lo,bars:run.end-run.start+1}:null;
  if(live)events.push({time:bars[run.start].time,type:'coil',direction:'neutral',reason:`지금 압축 중 · ${live.bars}봉째`});
  return {width:w,events,zones,live};
}
/** 4. Pressure: cumulative CLV×volume; divergences at confirmed swing pivots (k bars each side). */
function pressure(bars,{k=4,maxGap=60}={}){
  const n=bars.length,cum=Array(n).fill(null);let acc=0;
  for(let i=0;i<n;i++){const x=bars[i];if(!valid(x)){cum[i]=i?cum[i-1]:0;continue;}const span=x.high-x.low;const clv=span>0?((x.close-x.low)-(x.high-x.close))/span:0;acc+=clv*(fin(x.volume)?x.volume:0);cum[i]=acc;}
  const pivots={hi:[],lo:[]};
  for(let i=k;i<n-k;i++){let isHi=true,isLo=true;for(let j=i-k;j<=i+k;j++){if(j===i)continue;if(bars[j].high>=bars[i].high)isHi=false;if(bars[j].low<=bars[i].low)isLo=false;}
    if(isHi)pivots.hi.push(i);if(isLo)pivots.lo.push(i);}
  const events=[];
  const scan=(list,side)=>{for(let p=1;p<list.length;p++){const a=list[p-1],b=list[p];if(b-a>maxGap||b-a<k)continue;
    if(side==='hi'&&bars[b].high>bars[a].high&&cum[b]<cum[a])events.push({time:bars[b+k].time,pivotTime:bars[b].time,type:'pressure',direction:'sell',reason:'가격은 고점을 높였지만 종가 압력은 낮아짐 (약세 다이버전스)'});
    if(side==='lo'&&bars[b].low<bars[a].low&&cum[b]>cum[a])events.push({time:bars[b+k].time,pivotTime:bars[b].time,type:'pressure',direction:'buy',reason:'가격은 저점을 낮췄지만 종가 압력은 높아짐 (강세 다이버전스)'});}};
  scan(pivots.hi,'hi');scan(pivots.lo,'lo');events.sort((a,b)=>a.time-b.time);
  return {cum,events,confirmLag:k};
}
export {profile,purity,purityLabel,coil,pressure};

/** Scanner tag for one frame. bars: [{t(ms),o,h,l,c,v}] closed, ascending. frameMs: bar length. */
export function signatureTag(rows,frameMs){
  if(!Array.isArray(rows)||rows.length<150)return null;
  const bars=rows.map(b=>({time:Math.round(b.t/1000),open:b.o,high:b.h,low:b.l,close:b.c,volume:b.v}));
  const n=bars.length,lastT=bars[n-1].time,ago=t=>Math.round((lastT-t)*1000/frameMs);
  const pu=purity(bars,20).at(-1),pr=profile(bars,{lookback:200}),co=coil(bars),ps=pressure(bars);
  const brk=co.events.filter(e=>e.type==='coil-break').at(-1),div=ps.events.at(-1);
  return {
    purity:Number.isFinite(pu)?Number(pu.toFixed(3)):null,
    coil:{live:!!co.live,bars:co.live?co.live.bars:0,high:co.live?co.live.high:null,low:co.live?co.live.low:null,
      breakout:brk&&ago(brk.time)<=12?{direction:brk.direction==='buy'?'up':'down',bars_ago:ago(brk.time),time_ms:brk.time*1000}:null},
    divergence:div&&ago(div.time)<=24?{direction:div.direction==='buy'?'bullish':'bearish',bars_ago:ago(div.time),time_ms:div.time*1000,pivot_ms:div.pivotTime*1000}:null,
    profile:pr?{position:pr.position,poc:pr.poc,vah:pr.vah,val:pr.val}:null,
    bars:n
  };
}
