import assert from 'node:assert/strict';
import {ADVANCED,features,labelAt,trainLogistic,residualScores,tsmomWeights,HORIZON} from '../src/paper-league-advanced.mjs';
import {makeMarket,newAccount} from '../src/paper-league.mjs';
const H=3600000,D=86400000;
const mk=(n,frame,start,seed,drift=0,end=Date.UTC(2026,10,22))=>{let x=seed,c=start;const out=[];
  for(let i=0;i<n;i++){x=(x*16807)%2147483647;const r=(x/2147483647-0.5)*0.02+drift;const o=c;c=Math.max(0.01,c*(1+r));
    out.push({t:end-(n-i)*frame,o,h:Math.max(o,c)*1.003,l:Math.min(o,c)*0.997,c,v:100+(x%50)});}return out;};
// ---- no look-ahead: features at i are identical whether or not later bars exist; labels need closed future
{const bars=mk(400,4*H,100,7);const full=features(bars,null);
 for(const i of [80,200,399]){const part=features(bars.slice(0,i+1),null);assert.deepEqual(part[i],full[i],'feature at '+i+' uses only bars ≤ i');}
 const c=bars.map(b=>b.c);assert.equal(labelAt(c,c.length-HORIZON),null,'no label without a closed outcome');assert.notEqual(labelAt(c,100),undefined);}
// ---- logistic regression learns a real pattern, and is ~chance on noise
{let s=3;const rnd=()=>{s=(s*16807)%2147483647;return s/2147483647-0.5;};
 const X=[],y=[];for(let i=0;i<2000;i++){const a=rnd(),b=rnd();X.push([a,b,rnd()]);y.push(a+0.5*b>0?1:0);}
 const m=trainLogistic(X.slice(0,1500),y.slice(0,1500));let hit=0;for(let i=1500;i<2000;i++)hit+=((m.predict(X[i])>=0.5?1:0)===y[i])?1:0;assert.ok(hit/500>0.9,'learns separable signal: '+hit/500);
 const yn=X.map(()=>rnd()>0?1:0);const m2=trainLogistic(X.slice(0,1500),yn.slice(0,1500));let h2=0;for(let i=1500;i<2000;i++)h2+=((m2.predict(X[i])>=0.5?1:0)===yn[i])?1:0;
 assert.ok(h2/500<0.58,'no fake edge on noise: '+h2/500);}
// ---- residual momentum ranks a coin that outperformed beyond its beta
{const btc=mk(60,D,90000,5).map(b=>b.c);const series={};
 for(let k=0;k<12;k++)series['C'+k+'USDT']=btc.map((v,i)=>v/1000*(1+0.0005*k*Math.sin(i))*(k===11?Math.exp(i*0.01):1));
 const sc=residualScores(series,btc).sort((a,b)=>b.z-a.z);assert.equal(sc[0].s,'C11USDT');assert.ok(Math.abs(sc[0].beta-1)<0.6);}
// ---- risk parity trend: sign follows trend, gross capped at 150%
{const up=mk(170,D,100,9,0.006).map(b=>b.c),down=mk(170,D,100,11,-0.006).map(b=>b.c),flat=mk(170,D,100,13,0).map(b=>b.c);
 const w=tsmomWeights({BTCUSDT:up,ETHUSDT:down,SOLUSDT:flat});assert.ok(w.BTCUSDT.weight>0&&w.ETHUSDT.weight<0);
 assert.ok(Object.values(w).reduce((a,x)=>a+Math.abs(x.weight),0)<=1.5+1e-9);assert.ok(Object.values(w).every(x=>Math.abs(x.weight)<=0.6+1e-9));}
// ---- strategies run end-to-end on a mocked market and report diagnostics honestly
{const now=Date.UTC(2026,10,22,12,2);const frames={'60':H,'240':4*H,'D':D};const syms=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','BNBUSDT','ADAUSDT','LINKUSDT','AVAXUSDT','SUIUSDT'];
 const fetchImpl=async url=>{const u=new URL(url),s=u.searchParams.get('symbol');
   if(u.pathname.endsWith('/tickers'))return new Response(JSON.stringify({retCode:0,result:{list:[{symbol:s,lastPrice:'100',markPrice:'100'}]}}));
   const f=frames[u.searchParams.get('interval')],lim=Number(u.searchParams.get('limit')),end=Math.floor(now/f)*f-f;
   const seed=syms.indexOf(s)+3;const bars=mk(lim,f,100,seed,0.0004,end+f);return new Response(JSON.stringify({retCode:0,result:{list:bars.map(b=>[b.t,b.o,b.h,b.l,b.c,b.v].map(String)).reverse()}}));};
 const market=makeMarket(fetchImpl,now);
 const scanner={items:syms.map((s,i)=>({symbol:s,rank:i+1,regimes:{'4h':{status:'ok',state:i%2?'up':'range'}},oi_change_24h_pct:5,change_24h_pct:2,flow_quadrant:'price_up_oi_up',funding_percentile_30d:40,funding_pct:0.01,turnover_vs_7d:1.4}))};
 for(const def of ADVANCED){
   const acc=newAccount(def,now);acc.memo={};const out=await def.decide({market,acc,now,bar_ms:0,prev_bar_ms:0,ctx:{scanner,prices:{}}});
   assert.ok(out&&!out.error,def.id+': '+(out?.error||''));assert.ok(Array.isArray(out.target),def.id+' returns a target');
   for(const l of out.target){assert.ok(/USDT$/.test(l.symbol)&&['long','short'].includes(l.side)&&l.weight>0&&l.weight<=0.6,def.id+' sane leg');}
   assert.ok(out.diag&&out.diag.type,def.id+' diagnostics');
   assert.ok(def.rules.length>=4&&def.summary.length>40&&def.risk_overlay);
   if(def.id==='nexus-ml-ensemble'){const d=out.diag;assert.ok(d.train_samples>800&&d.validation_samples>=100);assert.equal(typeof d.trusted,'boolean');
     if(!d.trusted)assert.equal(out.target.length,0,'untrusted model opens nothing');}
   if(def.id==='neutral-residual-ls'){const l=out.target.filter(x=>x.side==='long').reduce((a,x)=>a+x.weight,0),s=out.target.filter(x=>x.side==='short').reduce((a,x)=>a+x.weight,0);assert.ok(Math.abs(l-s)<0.01,'dollar neutral');}
 }
 assert.equal(ADVANCED.filter(d=>d.ai).length,1,'only the trained model is labelled AI');}
console.log('PASS advanced strategies: no look-ahead, model learns signal not noise, residual/risk-parity math, e2e diagnostics');
