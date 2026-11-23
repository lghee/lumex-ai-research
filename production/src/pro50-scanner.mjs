/** LUMEX PRO 50-symbol scanner (read-only, public exchange data, no orders).
 *
 * Three R2 documents, all derived from official public endpoints that the existing
 * 5-minute top50 cron already trusts:
 *  - rolling-v1   : one point per UTC hour per symbol (Bybit price/OI/funding/turnover,
 *                   Binance funding). Seeded only from the existing hourly venue archive;
 *                   missing hours stay missing (never interpolated).
 *  - regimes-v1   : 1H / 4H / 1D rule-based regime (+ LUMEX signature tags: purity, coil, divergence, profile)
 *                   (same EMA20/50 + RSI14 + ATR14-vs-60-bar
 *                   rules as Core Lumex_Pro_Regime), refreshed in batches from Bybit klines.
 *  - scanner-v1   : the served snapshot (current values + facts derived from the two above).
 * Every derived figure carries its sample count; below the minimum it is null, not a guess.
 */
import {signatureTag} from './signature-math.mjs';
const UNI='market-hub/universe/bybit-linear-top50-v1.json';
const VENUE='market-hub/universe/top50-five-venues-v1.json';
const VENUE_HIST='market-hub/universe/venue-history/v1/';
const ROLL='market-hub/pro50/rolling-v1.json';
const REG='market-hub/pro50/regimes-v1.json';
const SCAN='market-hub/pro50/scanner-v1.json';
const HOUR=3600000,KEEP_HOURS=720,BACKFILL_PER_RUN=24,REGIME_BATCH=8;
const FRAMES={'1h':['60',HOUR],'4h':['240',4*HOUR],'1d':['D',24*HOUR]};
const MIN_PCTL_SAMPLES=72,MIN_TURNOVER_SAMPLES=72;
const fin=(x,lo=-Infinity,hi=Infinity)=>{if(x===null||x===undefined||x===''||typeof x==='boolean')return null;const n=Number(x);return Number.isFinite(n)&&n>=lo&&n<=hi?n:null;};
const r=(x,d)=>x===null?null:Number(x.toFixed(d));

async function readJson(env,key,maxBytes=4000000){
  const o=await env.MARKET_DATA.get(key);if(!o)return null;
  if(Number.isFinite(o.size)&&o.size>maxBytes)return null;
  try{return await o.json()}catch{return null}
}
async function writeJson(env,key,doc){
  const body=JSON.stringify(doc);
  if(body.length>4000000)return false;
  await env.MARKET_DATA.put(key,body,{httpMetadata:{contentType:'application/json'}});
  return true;
}
function freshUniverse(u,now){
  return u?.schema==='lumex_uid_top50_v1'&&u.order_execution===false&&Array.isArray(u.items)&&u.items.length>0&&
    u.items.length<=50&&Number.isSafeInteger(u.generated_at_ms)&&u.generated_at_ms<=now+120000&&now-u.generated_at_ms<=15*60000;
}
function freshVenue(v,now){
  return v?.schema==='lumex_uid_top50_venue_matrix_v1'&&v.ok===true&&v.order_execution===false&&
    Number.isSafeInteger(v.generated_at_ms)&&v.generated_at_ms<=now+120000&&now-v.generated_at_ms<=15*60000&&v.markets&&typeof v.markets==='object';
}
const venueRow=(doc,symbol,exchange)=>Array.isArray(doc?.markets?.[symbol])?doc.markets[symbol].find(x=>x?.exchange===exchange&&x?.status==='observed')||null:null;

// ---------------------------------------------------------------- rolling ---
/** point = [hour_ms, price, oi_usd, bybit_funding_pct, binance_funding_pct, turnover_24h_usdt|null] */
export function pointFromCurrent(u,venue,symbol,hour){
  const it=u.items.find(x=>x.symbol===symbol);if(!it)return null;
  const bn=venueRow(venue,symbol,'Binance');
  const p=[hour,fin(it.last_price,1e-12,1e10),fin(it.oi_usd,1e-5,1e20),fin(it.funding_pct,-20,20),fin(bn?.funding_pct,-20,20),fin(it.turnover_24h_usdt,1,1e20)];
  return p.slice(1,5).some(v=>v!==null)?p:null;
}
export function pointFromArchive(doc,symbol,hour){
  if(doc?.schema!=='lumex_uid_top50_venue_matrix_v1'||doc.order_execution!==false||doc.snapshot_hour_ms!==hour)return null;
  const by=venueRow(doc,symbol,'Bybit'),bn=venueRow(doc,symbol,'Binance');
  const p=[hour,fin(by?.mark_price,1e-12,1e10),fin(by?.oi_usd,1e-5,1e20),fin(by?.funding_pct,-20,20),fin(bn?.funding_pct,-20,20),null];
  return p.slice(1,5).some(v=>v!==null)?p:null;
}
export function emptyRolling(){return {schema:'lumex_pro50_rolling_v1',order_execution:false,keep_hours:KEEP_HOURS,
  fields:['hour_ms','price','oi_usd','bybit_funding_pct','binance_funding_pct','turnover_24h_usdt'],
  backfill_checked_to_ms:null,updated_ms:0,points:{}};}
export function validRolling(d){
  if(d?.schema!=='lumex_pro50_rolling_v1'||d.order_execution!==false||!d.points||typeof d.points!=='object')return false;
  for(const [s,arr] of Object.entries(d.points)){
    if(!/^[A-Z0-9]{2,20}USDT$/.test(s)||!Array.isArray(arr)||arr.length>KEEP_HOURS+2)return false;
    let prev=-1;for(const p of arr){if(!Array.isArray(p)||p.length!==6||!Number.isSafeInteger(p[0])||p[0]%HOUR!==0||p[0]<=prev)return false;prev=p[0];}
  }
  return true;
}
export function mergePoint(roll,symbol,point){
  const arr=roll.points[symbol]||(roll.points[symbol]=[]);
  const i=arr.findIndex(p=>p[0]===point[0]);
  if(i>=0){ // current-hour values win over archive values only for fields the archive lacks
    arr[i]=arr[i].map((v,k)=>k===0?v:(v===null?point[k]:v));return;
  }
  arr.push(point);if(arr.length>1&&arr[arr.length-2][0]>point[0])arr.sort((a,b)=>a[0]-b[0]);
}
export function pruneRolling(roll,now,keepSymbols){
  const floor=Math.floor(now/HOUR)*HOUR-(KEEP_HOURS-1)*HOUR;
  for(const s of Object.keys(roll.points)){
    roll.points[s]=roll.points[s].filter(p=>p[0]>=floor);
    if(!roll.points[s].length||(!keepSymbols.has(s)&&roll.points[s].at(-1)[0]<now-72*HOUR))delete roll.points[s];
  }
}

// ---------------------------------------------------------------- regimes ---
export function parseKlines(raw,frameMs,now){
  if(raw?.retCode!==0||!Array.isArray(raw?.result?.list)||raw.result.list.length>1000)return null;
  const rows=[];
  for(const x of raw.result.list){
    if(!Array.isArray(x)||x.length<6)return null;
    const [t,o,h,l,c,v]=x.slice(0,6).map(Number);
    if(![t,o,h,l,c,v].every(Number.isFinite)||!Number.isSafeInteger(t)||o<=0||l<=0||c<=0||v<0||h<Math.max(o,c,l)||l>Math.min(o,c,h))return null;
    if(t+frameMs>now)continue; // forming bar is never used
    rows.push({t,o,h,l,c,v});
  }
  rows.sort((a,b)=>a.t-b.t);
  for(let i=1;i<rows.length;i++)if(rows[i].t-rows[i-1].t!==frameMs)return null; // gaps are rejected, not filled
  return rows;
}
/** Same rule set as Core Lumex_Pro_Regime::compute (EMA20/50, RSI14, ATR14 vs 60-bar median). */
export function classify(rows,frameMs,now){
  if(!Array.isArray(rows)||rows.length<120)return {status:'insufficient',bars:Array.isArray(rows)?rows.length:0};
  const closed=rows.at(-1).t+frameMs;
  if(now-closed>frameMs*1.75+10*60000)return {status:'stale',bars:rows.length};
  const ema20=[],ema50=[],rsi=[],atrPct=[];let g=0,lo=0,a=0;
  rows.forEach((b,i)=>{
    ema20[i]=i?b.c*2/21+ema20[i-1]*19/21:b.c;ema50[i]=i?b.c*2/51+ema50[i-1]*49/51:b.c;
    if(!i){rsi[i]=null;atrPct[i]=null;return;}
    const d=b.c-rows[i-1].c,gain=Math.max(0,d),loss=Math.max(0,-d),tr=Math.max(b.h-b.l,Math.abs(b.h-rows[i-1].c),Math.abs(b.l-rows[i-1].c));
    if(i<=14){g+=gain;lo+=loss;a+=tr;}if(i===14){g/=14;lo/=14;a/=14;}
    if(i>14){g=(g*13+gain)/14;lo=(lo*13+loss)/14;a=(a*13+tr)/14;}
    rsi[i]=i>=14?(lo<1e-12?(g<1e-12?50:100):100-100/(1+g/lo)):null;atrPct[i]=i>=14?a/b.c*100:null;
  });
  const states=[];
  for(let i=rows.length-24;i<rows.length;i++){
    const past=atrPct.slice(Math.max(14,i-60),i).filter(Number.isFinite);
    if(past.length<30)return {status:'insufficient',bars:rows.length};
    past.sort((x,y)=>x-y);const h=past.length>>1,med=past.length%2?past[h]:(past[h-1]+past[h])/2;
    const volHigh=atrPct[i]>Math.max(0.8,med*1.42);
    const up=ema20[i]>ema50[i]*1.0015&&rows[i].c>ema20[i]&&rsi[i]>=54;
    const down=ema20[i]<ema50[i]*0.9985&&rows[i].c<ema20[i]&&rsi[i]<=46;
    const direction=up?'up':down?'down':'range';states.push({state:volHigh?'volatile':direction,direction});
  }
  const cur=states.at(-1);let since=1;
  for(let k=states.length-2;k>=0&&states[k].state===cur.state;k--)since++;
  const L=rows.length-1;
  return {status:'ok',state:cur.state,direction:cur.direction,rsi:r(rsi[L],2),atr_pct:r(atrPct[L],3),
    ema_gap_pct:r((ema20[L]/ema50[L]-1)*100,3),bars_in_state:since,bars_in_state_capped:since===24,
    previous_state:since<24?states[states.length-1-since].state:null,closed_ms:closed,bars:rows.length};
}
export function emptyRegimes(){return {schema:'lumex_pro50_regimes_v1',order_execution:false,
  method:'EMA20/50 + RSI14 + ATR14 vs 60-bar baseline (rule-based, not AI)',source:'Bybit official linear klines',cursor:0,items:{}};}
export async function refreshRegimeBatch(env,u,reg,now,fetchImpl=fetch){
  const symbols=u.items.map(x=>x.symbol);
  const start=(Number.isSafeInteger(reg.cursor)?reg.cursor:0)%symbols.length;
  const batch=Array.from({length:Math.min(REGIME_BATCH,symbols.length)},(_,i)=>symbols[(start+i)%symbols.length]);
  let ok=0;
  await Promise.all(batch.map(async symbol=>{
    const entry={updated_ms:now};
    await Promise.all(Object.entries(FRAMES).map(async ([tf,[interval,ms]])=>{
      try{
        const res=await fetchImpl(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=200`,
          {method:'GET',headers:{accept:'application/json'},signal:AbortSignal.timeout(5000)});
        if(!res.ok){entry[tf]={status:'unavailable'};return;}
        const txt=await res.text();if(txt.length<20||txt.length>400000){entry[tf]={status:'unavailable'};return;}
        const rows=parseKlines(JSON.parse(txt),ms,now);
        entry[tf]=rows?classify(rows,ms,now):{status:'unavailable'};
        // 2026-11-23: LUMEX signature tags from the same closed bars (no extra requests)
        if(rows&&entry[tf].status==='ok'){try{const sig=signatureTag(rows,ms);if(sig)entry[tf].signature=sig;}catch{}}
      }catch{entry[tf]={status:'unavailable'};}
    }));
    if(Object.keys(FRAMES).some(tf=>entry[tf]?.status==='ok'))ok++;
    // Keep the last good frame result rather than replacing it with an outage marker.
    const prev=reg.items[symbol]||{};
    for(const tf of Object.keys(FRAMES))if(entry[tf]?.status==='unavailable'&&prev[tf]?.status==='ok')entry[tf]=prev[tf];
    reg.items[symbol]=entry;
  }));
  const keep=new Set(symbols);for(const s of Object.keys(reg.items))if(!keep.has(s))delete reg.items[s];
  reg.cursor=(start+batch.length)%symbols.length;reg.updated_ms=now;
  return {batch:batch.length,ok};
}

// ---------------------------------------------------------------- derived ---
export function percentileRank(values,current){
  const xs=values.filter(Number.isFinite);if(xs.length<MIN_PCTL_SAMPLES||!Number.isFinite(current))return null;
  let below=0,equal=0;for(const v of xs){if(v<current)below++;else if(v===current)equal++;}
  return r((below+equal*0.5)/xs.length*100,1);
}
const near=(arr,target,tol)=>{let best=null;for(const p of arr){const d=Math.abs(p[0]-target);if(d<=tol&&(!best||d<Math.abs(best[0]-target)))best=p;}return best;};
export function quadrant(priceChg,oiChg){
  if(!Number.isFinite(priceChg)||!Number.isFinite(oiChg))return null;
  if(Math.abs(oiChg)<1)return 'oi_flat';
  if(priceChg>=0&&oiChg>0)return 'price_up_oi_up';
  if(priceChg<0&&oiChg>0)return 'price_down_oi_up';
  if(priceChg>=0&&oiChg<0)return 'price_up_oi_down';
  return 'price_down_oi_down';
}
export function buildScanner(u,venue,roll,reg,now){
  const hourNow=Math.floor(now/HOUR)*HOUR;
  const items=u.items.map(it=>{
    const s=it.symbol,pts=(roll.points[s]||[]).filter(p=>p[0]<=hourNow);
    const fundingHist=pts.map(p=>p[3]),turnHist=pts.filter(p=>p[0]>=hourNow-7*24*HOUR&&p[0]<hourNow).map(p=>p[5]).filter(Number.isFinite);
    const p24=near(pts,hourNow-24*HOUR,HOUR);
    const oiNow=fin(it.oi_usd,1e-5,1e20),oi24=p24?fin(p24[2],1e-5,1e20):null;
    const oiChg=oiNow!==null&&oi24!==null?r((oiNow/oi24-1)*100,2):null;
    const price24=p24?fin(p24[1],1e-12,1e10):null;
    const priceChgArchive=price24!==null?r((fin(it.last_price,1e-12,1e10)/price24-1)*100,2):null;
    const turnAvg=turnHist.length>=MIN_TURNOVER_SAMPLES?turnHist.reduce((x,y)=>x+y,0)/turnHist.length:null;
    const venues=Object.fromEntries(['Binance','Bybit','OKX','Bitget','Gate'].map(ex=>{const v=venueRow(venue,s,ex);return [ex,v?{funding_pct:fin(v.funding_pct,-20,20),oi_usd:fin(v.oi_usd,1e-5,1e20)}:null];}));
    const fundingNow=fin(it.funding_pct,-20,20);
    const fundingVals=Object.values(venues).map(v=>v?.funding_pct).filter(Number.isFinite);
    const rg=reg.items[s]||{};
    const regimes=Object.fromEntries(Object.keys(FRAMES).map(tf=>[tf,rg[tf]?.status==='ok'?{...rg[tf],age_seconds:Math.max(0,Math.round((now-rg[tf].closed_ms)/1000))}:{status:rg[tf]?.status||'pending'}]));
    return {symbol:s,coin:it.coin,rank:it.rank,last_price:it.last_price,change_24h_pct:it.change_24h_pct,
      turnover_24h_usdt:it.turnover_24h_usdt,high_24h:it.high_24h??null,low_24h:it.low_24h??null,
      oi_usd:oiNow,oi_change_24h_pct:oiChg,price_change_vs_archive_24h_pct:priceChgArchive,
      flow_quadrant:quadrant(fin(it.change_24h_pct,-100,100000),oiChg),
      funding_pct:fundingNow,funding_percentile_30d:percentileRank(fundingHist,fundingNow),
      funding_samples:fundingHist.filter(Number.isFinite).length,
      funding_venue_spread_pct:fundingVals.length>=2?r(Math.max(...fundingVals)-Math.min(...fundingVals),6):null,
      turnover_vs_7d:turnAvg?r(it.turnover_24h_usdt/turnAvg,2):null,turnover_samples:turnHist.length,
      venues,regimes,history_hours:pts.length};
  });
  return {ok:true,schema:'lumex_pro50_scanner_v1',generated_at_ms:now,universe_generated_ms:u.generated_at_ms,
    venue_generated_ms:freshVenue(venue,now)?venue.generated_at_ms:null,order_execution:false,
    source:'bybit_linear_public + five_venue_public_matrix + bybit_klines',aggregation:'none',
    method:{regime:'EMA20/50 + RSI14 + ATR14 vs 60-bar baseline, closed bars only',
      funding_percentile:`rank of current Bybit funding among own hourly samples (≤30d, min ${MIN_PCTL_SAMPLES})`,
      oi_change:'Bybit OI now vs archived hourly point 24h ago (±1h)',turnover_vs_7d:`Bybit 24h turnover / mean of hourly samples over prior 7d (min ${MIN_TURNOVER_SAMPLES})`,
      flow_quadrant:'sign of 24h price change × 24h OI change (|OI change| < 1% = flat); descriptive only',
      signature:'LUMEX signature math on the same closed 1H/4H/1D bars: purity (signed ER 20), coil (BB width ≤ 10th pct of 120 bars, 2-close breakout ≤ 12 bars ago), pressure divergence (CLV×volume vs pivots, ≤ 24 bars ago), volume profile position (200 bars)'},
    rolling:{symbols:Object.keys(roll.points).length,backfill_checked_to_ms:roll.backfill_checked_to_ms??null,
      oldest_hour_ms:(()=>{const m=Math.min(...Object.values(roll.points).map(a=>a[0]?.[0]??Infinity));return Number.isFinite(m)?m:null;})()},
    count:items.length,items};
}
export function validScanner(d,now){
  return d?.ok===true&&d.schema==='lumex_pro50_scanner_v1'&&d.order_execution===false&&Array.isArray(d.items)&&
    d.items.length>0&&d.items.length<=50&&d.count===d.items.length&&Number.isSafeInteger(d.generated_at_ms)&&
    d.generated_at_ms<=now+120000&&now-d.generated_at_ms<=15*60000;
}

// ---------------------------------------------------------------- cron entry ---
export async function updatePro50(env,{now=Date.now(),fetchImpl=fetch}={}){
  if(!env?.MARKET_DATA)return {ok:false,reason:'r2_missing'};
  const u=await readJson(env,UNI,800000);if(!freshUniverse(u,now))return {ok:false,reason:'universe_stale'};
  const venue=await readJson(env,VENUE,2000000);
  let roll=await readJson(env,ROLL);if(!validRolling(roll))roll=emptyRolling();
  const hour=Math.floor(now/HOUR)*HOUR,symbols=u.items.map(x=>x.symbol);
  for(const s of symbols){const p=pointFromCurrent(u,freshVenue(venue,now)?venue:null,s,hour);if(p)mergePoint(roll,s,p);}
  // Seed from the existing hourly archive, newest-first, a bounded number of hours per run.
  const floor=hour-(KEEP_HOURS-1)*HOUR;let checked=Number.isSafeInteger(roll.backfill_checked_to_ms)?roll.backfill_checked_to_ms:hour;
  let seeded=0;
  if(checked>floor){
    const hours=[];for(let h=checked-HOUR;h>=floor&&hours.length<BACKFILL_PER_RUN;h-=HOUR)hours.push(h);
    for(const h of hours){
      const doc=await readJson(env,VENUE_HIST+h+'.json',450000).catch(()=>null);
      if(doc)for(const s of symbols){const p=pointFromArchive(doc,s,h);if(p){mergePoint(roll,s,p);seeded++;}}
    }
    if(hours.length)checked=hours.at(-1);
  }
  roll.backfill_checked_to_ms=Math.max(checked,floor);roll.updated_ms=now;
  pruneRolling(roll,now,new Set(symbols));
  await writeJson(env,ROLL,roll);
  let reg=await readJson(env,REG,1500000);if(reg?.schema!=='lumex_pro50_regimes_v1'||!reg.items)reg=emptyRegimes();
  const rb=await refreshRegimeBatch(env,u,reg,now,fetchImpl);
  await writeJson(env,REG,reg);
  const scan=buildScanner(u,venue,roll,reg,now);
  if(!validScanner(scan,now))return {ok:false,reason:'scanner_invalid'};
  await writeJson(env,SCAN,scan);
  const check=await readJson(env,SCAN,2000000);
  if(!validScanner(check,now)||check.generated_at_ms!==now)return {ok:false,reason:'scanner_readback_failed'};
  return {ok:true,symbols:scan.count,seeded_points:seeded,regime_batch:rb.batch,regime_ok:rb.ok,backfill_checked_to_ms:roll.backfill_checked_to_ms};
}

const reply=(doc,status=200)=>new Response(JSON.stringify(doc),{status,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}});
export async function serveScanner(env,now=Date.now()){
  try{const d=await readJson(env,SCAN,2000000);return validScanner(d,now)?reply(d):reply({ok:false,error:'pro50_scanner_unavailable_or_stale'},503);}
  catch{return reply({ok:false,error:'pro50_scanner_read_failed'},503);}
}
/** One symbol's hourly series (≤30d) for charts. Points are archived observations only. */
export async function serveSeries(request,env,now=Date.now()){
  const symbol=String(new URL(request.url).searchParams.get('symbol')||'');
  if(!/^[A-Z0-9]{2,20}USDT$/.test(symbol))return reply({ok:false,error:'invalid_symbol'},400);
  try{
    const u=await readJson(env,UNI,800000);
    if(!freshUniverse(u,now)||!u.items.some(x=>x.symbol===symbol))return reply({ok:false,error:'symbol_not_in_current_universe'},400);
    const roll=await readJson(env,ROLL);
    if(!validRolling(roll)||now-Number(roll.updated_ms)>2*HOUR)return reply({ok:false,error:'series_unavailable'},503);
    return reply({ok:true,schema:'lumex_pro50_series_v1',symbol,generated_at_ms:now,rolling_updated_ms:roll.updated_ms,
      fields:roll.fields,points:roll.points[symbol]||[],missing_is_null:true,interpolated:false,order_execution:false});
  }catch{return reply({ok:false,error:'series_read_failed'},503);}
}
