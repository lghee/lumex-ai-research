/** LUMEX 아침 리포트 데이터 묶음 (Phase 107).
 * 07:50 KST: BTC·ETH 24h market facts → POST to Core (Bearer worker token). Core owns the OpenAI key
 * (registered in 운영센터), writes, checks and publishes the report at 08:00 KST.
 * 08:00 KST: publish ping → Core publishes (or writes then publishes if the 07:50 run was missed).
 * Every number here comes from public market data; nothing is estimated.
 */
import {makeMarket} from './paper-league.mjs';
import {ema,rsi,replay as chartReplay} from './paper-league-chartsig.mjs';
import {ROOT as NEWS_ROOT,kstDay} from './news-feed.mjs';

const HOUR=3600000,KST=9*HOUR,fin=Number.isFinite;
const r2=n=>fin(n)?Math.round(n*100)/100:null,r4=n=>fin(n)?Math.round(n*1e4)/1e4:null;
const iso=t=>new Date(t+KST).toISOString().slice(0,16).replace('T',' ')+' KST';

/** Pure: one coin's facts from Bybit 1h / 4h / D bars, ticker, OI history and Gate 1h liquidation rows. */
export function coinFacts(sym,{h1,h4,d1,ticker,oi1h,liq}){
  if(!Array.isArray(h1)||h1.length<24)return null;
  const day=h1.slice(-24),open=day[0].o,close=day.at(-1).c;
  let hi=day[0],lo=day[0];for(const b of day){if(b.h>hi.h)hi=b;if(b.l<lo.l)lo=b;}
  const moves=day.map(b=>({t:b.t,chg:(b.c/b.o-1)*100})).sort((a,b)=>Math.abs(b.chg)-Math.abs(a.chg)).slice(0,3)
    .map(x=>({hour_kst:iso(x.t),change_pct:r2(x.chg)}));
  const out={symbol:sym,window_kst:iso(day[0].t)+' ~ '+iso(day.at(-1).t+HOUR),
    price:{open:open,high:hi.h,low:lo.l,close,change_24h_pct:r2((close/open-1)*100),high_at_kst:iso(hi.t),low_at_kst:iso(lo.t),
      biggest_hours:moves,hourly_close:day.map(b=>b.c)}};
  if(Array.isArray(d1)&&d1.length>=31){
    const c=d1.map(b=>b.c),last=c.at(-1);
    out.price.change_7d_pct=r2((last/c.at(-8)-1)*100);out.price.change_30d_pct=r2((last/c.at(-31)-1)*100);
    const w=d1.slice(-7);out.price.high_7d=Math.max(...w.map(b=>b.h));out.price.low_7d=Math.min(...w.map(b=>b.l));
    const e20=ema(c,20).at(-1),e50=ema(c,50).at(-1),rs=rsi(c).at(-1);
    out.daily={ema20:r2(e20),ema50:r2(e50),trend:fin(e20)&&fin(e50)?(e20>e50?'상승 추세(EMA20 > EMA50)':'하락 추세(EMA20 < EMA50)'):null,rsi14:r2(rs)};
  }
  if(Array.isArray(h4)&&h4.length>=120){
    const c=h4.map(b=>b.c),e20=ema(c,20).at(-1),e50=ema(c,50).at(-1),rp=chartReplay(h4);
    const last=rp.events.filter(e=>e.type==='signal'||e.type==='entry').at(-1);
    out.h4={ema20:r2(e20),ema50:r2(e50),trend:fin(e20)&&fin(e50)?(e20>e50?'상승(EMA20 > EMA50)':'하락(EMA20 < EMA50)'):null,
      lumex_signal_last:last?{side:last.side==='long'?'롱':'숏',at_kst:iso(last.t),price:last.price}:null,
      lumex_position:rp.open?{side:rp.open.side==='long'?'롱':'숏',entry:r2(rp.open.entry),stop:r2(rp.open.stop),since_kst:iso(rp.open.entry_t)}:null};
  }
  if(ticker){
    const f=Number(ticker.fundingRate)*100,oiv=Number(ticker.openInterestValue);
    out.derivatives={funding_pct_8h:r4(f),open_interest_usd:fin(oiv)?Math.round(oiv):null,source:'Bybit'};
    if(Array.isArray(oi1h)&&oi1h.length>=25){const a=oi1h.at(-25).oi,b=oi1h.at(-1).oi;if(a>0&&b>0)out.derivatives.oi_change_24h_pct=r2((b/a-1)*100);}
  }
  if(Array.isArray(liq)&&liq.length>=20){
    const L=liq.slice(-24),long=L.reduce((s,r)=>s+r.long,0),short=L.reduce((s,r)=>s+r.short,0);
    let top=L[0];for(const r of L)if(r.long+r.short>top.long+top.short)top=r;
    out.liquidations={long_usd:Math.round(long),short_usd:Math.round(short),biggest_hour_kst:iso(top.t),biggest_hour_usd:Math.round(top.long+top.short),source:'Gate 1시간 집계'};
  }
  return out;
}
/** Pure: the last 24h of news titles that matter for BTC/ETH (plus macro and exchange notices). */
export function newsForReport(feed,now){
  return (feed?.items||[]).filter(i=>i.t>=now-24*HOUR&&(i.kind==='macro'||i.kind==='exchange'&&i.importance>=2||i.coins?.some(c=>c==='BTC'||c==='ETH')))
    .slice(0,25).map(i=>({at_kst:iso(i.t),source:i.source,title:i.title,coins:i.coins}));
}
async function getJson(fetchImpl,url,maxLen=600000){
  const r=await fetchImpl(url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(8000)});
  if(!r.ok)throw Error('http_'+r.status);const t=await r.text();if(t.length>maxLen)throw Error('size');return JSON.parse(t);
}
export async function buildBundle(env,{now=Date.now(),fetchImpl=fetch}={}){
  const m=makeMarket(fetchImpl,now),coins={};
  for(const sym of ['BTCUSDT','ETHUSDT']){
    const coin=sym.replace('USDT','');
    const [h1,h4,d1]=await Promise.all([m.bars(sym,'60',30),m.bars(sym,'240',200),m.bars(sym,'D',60)]);
    let ticker=null,oi1h=null,liq=null;
    try{const raw=await getJson(fetchImpl,`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${sym}`,20000);ticker=raw?.retCode===0?raw.result?.list?.[0]:null;}catch{}
    try{const raw=await getJson(fetchImpl,`https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${sym}&intervalTime=1h&limit=26`,60000);
      oi1h=raw?.retCode===0?raw.result.list.map(x=>({t:Number(x.timestamp),oi:Number(x.openInterest)})).filter(x=>fin(x.t)&&x.oi>0).sort((a,b)=>a.t-b.t):null;}catch{}
    try{const raw=await getJson(fetchImpl,`https://api.gateio.ws/api/v4/futures/usdt/contract_stats?contract=${coin}_USDT&interval=1h&limit=26`,200000);
      liq=(Array.isArray(raw)?raw:[]).map(r=>({t:Number(r.time)*1000,long:Number(r.long_liq_usd),short:Number(r.short_liq_usd)})).filter(r=>fin(r.t)&&r.long>=0&&r.short>=0&&r.t+HOUR<=now).sort((a,b)=>a.t-b.t);}catch{}
    const f=coinFacts(sym,{h1,h4,d1,ticker,oi1h,liq});
    if(f)coins[coin]=f;
  }
  let feed=null;try{const o=await env.MARKET_DATA?.get(NEWS_ROOT+'feed.json');feed=o?await o.json():null;}catch{}
  return {ok:Boolean(coins.BTC&&coins.ETH),schema:'lumex_morning_bundle_v1',report_date:kstDay(now),generated_at_kst:iso(now),
    coins,news:newsForReport(feed,now),sources:['Bybit 공개 시세·미결제약정·펀딩비','Gate 1시간 청산 집계','LUMEX 속보'],order_execution:false};
}
async function callCore(env,path,body,fetchImpl){
  const token=env?.LUMEX_AI_LAB_WORKER_TOKEN||'';
  if(token.length<48)throw Error('worker_token_missing');
  const base=env.LUMEX_SITE_URL||'https://lumexbot.com';
  if(base!=='https://lumexbot.com')throw Error('origin_not_allowlisted');
  const r=await fetchImpl(base+'/wp-json/lumex/v1/ai-report/'+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',accept:'application/json'},
    body:JSON.stringify(body),signal:AbortSignal.timeout(170000)});
  const t=await r.text();let j=null;try{j=JSON.parse(t);}catch{}
  return {status:r.status,body:j};
}
/** Called from the 1-minute cron. Idempotent per KST date via R2 markers. */
export async function morningReportTick(env,{now=Date.now(),fetchImpl=fetch}={}){
  const k=new Date(now+KST),hh=k.getUTCHours(),mm=k.getUTCMinutes(),day=kstDay(now),bucket=env?.MARKET_DATA;
  if(!bucket)return {ok:false,reason:'r2_missing'};
  const mark=async n=>{const o=await bucket.head(NEWS_ROOT+'report/'+day+'-'+n);return Boolean(o);};
  const set=(n,x)=>bucket.put(NEWS_ROOT+'report/'+day+'-'+n,JSON.stringify(x),{httpMetadata:{contentType:'application/json'}});
  if(hh===7&&mm>=50&&mm<58&&!(await mark('bundle'))){
    const b=await buildBundle(env,{now,fetchImpl});
    if(!b.ok){await set('bundle-failed',{at:now});return {ok:false,reason:'bundle_incomplete'};}
    await set('bundle',{at:now});
    const r=await callCore(env,'bundle',b,fetchImpl);
    await set('bundle-sent',{at:now,status:r.status,result:r.body?.state||null});
    return {ok:r.status<300,stage:'bundle',status:r.status};
  }
  if(hh===8&&mm<20&&!(await mark('publish'))){
    const r=await callCore(env,'publish',{report_date:day},fetchImpl);
    if(r.status<300&&r.body?.ok){await set('publish',{at:now,state:r.body.state||null});}
    return {ok:r.status<300,stage:'publish',status:r.status,state:r.body?.state||null};
  }
  return {ok:true,stage:'idle'};
}
