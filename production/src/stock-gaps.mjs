/** LUMEX 장외 갭 기록 (Phase 116, 2026-11-27) — stock section only.
 *
 * For each US trading day the 5-minute stock collector stores, once each, the Bybit stock/ETF perpetual prices at:
 *   pre    09:20–09:30 ET   (last futures price before the bell = the gap the market priced while the stock was shut)
 *   open   09:30–09:40 ET   (first run after the bell; "개장 직후" — within the first ten minutes, not the official open print)
 *   h1     10:30–10:40 ET   (about an hour after the bell)
 *   close  the existing close capture (first run within 30 minutes after the close)
 * against the previous session's stored close. Nothing is filled in afterwards: a missed window stays null.
 * The board shows these records as they are; it does not predict the next open.
 */
import {etParts,tradingDay,calendarKnown,lastClosedSession,usSession} from './stock-hub.mjs';

const ROOT='stock-hub/v1/';
const WINDOWS={pre:[560,570],open:[570,580],h1:[630,640]};          // ET minutes [from, to)
const KEEP_DATES=90,TOP_PER_DAY=40;
const fin=Number.isFinite;
const num=v=>{const x=Number(v);return v!==null&&v!==undefined&&v!==''&&fin(x)?x:null;};
async function rget(bucket,key){try{const o=await bucket.get(ROOT+key);return o?await o.json():null;}catch{return null;}}
const rput=(bucket,key,v)=>bucket.put(ROOT+key,JSON.stringify(v),{httpMetadata:{contentType:'application/json'}});
const addDays=(date,k)=>{const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+k);return d.toISOString().slice(0,10);};
export function prevTradingDay(date){let d=addDays(date,-1);for(let i=0;i<10;i++){if(!calendarKnown(d))return null;if(tradingDay(d))return d;d=addDays(d,-1);}return null;}

/** Which capture (if any) the run at `now` belongs to. Pure. */
export function gapPhase(now){
  const {date,minute}=etParts(now);
  if(!tradingDay(date))return null;
  for(const [kind,[a,z]] of Object.entries(WINDOWS))if(minute>=a&&minute<z)return {date,kind};
  return null;
}
const pct=(a,b)=>a!==null&&b>0?Number(((a/b-1)*100).toFixed(3)):null;

/** Called by the stock collector every 5 minutes with the universe, the Bybit tickers and the close it just stored. */
export async function recordGaps(bucket,{universe,tickers,radar,now,closeStored=null}){
  const out={phase:null,written:false};
  const prices=new Map((tickers||[]).map(t=>[String(t?.symbol||''),num(t?.lastPrice)]));
  // close of the day finishes that day's record
  if(closeStored?.date){
    const rec=await rget(bucket,'gaps/'+closeStored.date+'.json');
    if(rec&&!rec.close_ms){
      for(const [sym,it] of Object.entries(rec.items))it.close=num(closeStored.prices?.[sym]?.last);
      rec.close_ms=closeStored.captured_ms;await rput(bucket,'gaps/'+rec.date+'.json',rec);out.written=true;out.phase='close';
    }
  }
  const ph=gapPhase(now);if(!ph)return out;
  out.phase=ph.kind;
  let rec=await rget(bucket,'gaps/'+ph.date+'.json');
  if(ph.kind==='pre'){
    if(rec?.pre_ms)return out;
    const prev=prevTradingDay(ph.date);if(!prev)return {...out,reason:'calendar'};
    const close=await rget(bucket,'closes/'+prev+'.json');
    if(!close?.prices)return {...out,reason:'no_close_'+prev};               // no stored close → no record (never estimated)
    const ranked=new Set((radar?.items||[]).filter(x=>x.ranked).map(x=>x.symbol));
    const meta=new Map((universe?.stocks||[]).map(s=>[s.symbol,s]));
    const items={};
    for(const [sym,c] of Object.entries(close.prices)){
      const s=meta.get(sym),pc=num(c?.last),pre=prices.get(sym)??null;
      if(!s||!ranked.has(sym)||!(pc>0)||!(pre>0))continue;
      items[sym]={ticker:s.ticker,slug:s.slug,name:s.name,type:s.type,prev_close:pc,pre,open:null,h1:null,close:null};
    }
    rec={schema:'lumex_stock_gap_day_v1',date:ph.date,prev_date:prev,prev_close_captured_ms:close.captured_ms,pre_ms:now,open_ms:null,h1_ms:null,close_ms:null,items};
    await rput(bucket,'gaps/'+ph.date+'.json',rec);
    const idx=(await rget(bucket,'gaps/index.json'))||{dates:[]};
    idx.dates=[...new Set([ph.date,...idx.dates])].sort().reverse().slice(0,KEEP_DATES);
    await rput(bucket,'gaps/index.json',idx);out.written=true;return out;
  }
  if(!rec?.pre_ms||rec[ph.kind+'_ms'])return out;
  for(const [sym,it] of Object.entries(rec.items))it[ph.kind]=prices.get(sym)??null;
  rec[ph.kind+'_ms']=now;await rput(bucket,'gaps/'+ph.date+'.json',rec);out.written=true;return out;
}

/** One day's record as shown: percentages against the previous close, biggest gaps first. */
export function summarizeDay(rec,top=TOP_PER_DAY){
  const rows=Object.entries(rec?.items||{}).map(([symbol,it])=>{
    const gap=pct(it.pre,it.prev_close),open=pct(it.open,it.prev_close),h1=pct(it.h1,it.prev_close),close=pct(it.close,it.prev_close);
    return {symbol,ticker:it.ticker,slug:it.slug,name:it.name,type:it.type,prev_close:it.prev_close,pre:it.pre,gap_pct:gap,open_pct:open,h1_pct:h1,close_pct:close,
      // same direction as the pre-open gap? null while that capture is missing or the gap is flat
      open_same:gap&&open!==null?Math.sign(open)===Math.sign(gap):null,close_same:gap&&close!==null?Math.sign(close)===Math.sign(gap):null};
  }).filter(r=>r.gap_pct!==null).sort((a,b)=>Math.abs(b.gap_pct)-Math.abs(a.gap_pct)||a.ticker.localeCompare(b.ticker));
  return {date:rec.date,prev_date:rec.prev_date,pre_ms:rec.pre_ms,open_ms:rec.open_ms,h1_ms:rec.h1_ms,close_ms:rec.close_ms,count:rows.length,rows:rows.slice(0,top)};
}
/** Counts over recorded days: how often a gap of at least `min` % kept its direction at open / at close. */
export function gapStats(days,min=1){
  const s={days:days.length,gaps:0,open_known:0,open_same:0,close_known:0,close_same:0,min_gap_pct:min};
  for(const d of days)for(const r of d.rows){if(Math.abs(r.gap_pct)<min)continue;s.gaps++;
    if(r.open_same!==null){s.open_known++;if(r.open_same)s.open_same++;}
    if(r.close_same!==null){s.close_known++;if(r.close_same)s.close_same++;}}
  return s;
}
/** Live board: since the last stored close, biggest moves first (only while the regular session is shut). */
export function liveBoard(radar){
  const items=(radar?.items||[]).filter(x=>x.ranked&&x.since_close_pct!==null)
    .sort((a,b)=>Math.abs(b.since_close_pct)-Math.abs(a.since_close_pct)||a.ticker.localeCompare(b.ticker))
    .map(x=>({symbol:x.symbol,ticker:x.ticker,slug:x.slug,name:x.name,type:x.type,last:x.last,since_close_pct:x.since_close_pct,turnover_24h_usd:x.turnover_24h_usd,funding_pct:x.funding_pct}));
  return {session:radar?.session||null,close_ref:radar?.close_ref||null,updated_ms:radar?.updated_ms||null,count:items.length,items};
}
export async function gapsPayload(env,{now=Date.now(),days=20}={}){
  const bucket=env.MARKET_DATA;
  const [radar,idx]=await Promise.all([rget(bucket,'radar.json'),rget(bucket,'gaps/index.json')]);
  const dates=(idx?.dates||[]).slice(0,Math.max(1,Math.min(60,days|0||20)));
  const recs=(await Promise.all(dates.map(d=>rget(bucket,'gaps/'+d+'.json')))).filter(Boolean).map(r=>summarizeDay(r));
  return {ok:true,schema:'lumex_stock_gaps_v1',source:'Bybit 주식·ETF USDT 무기한 공개 시세 (LUMEX 5분 수집)',updated_ms:now,
    session:usSession(now),last_closed_session:lastClosedSession(now),
    windows_et:{pre:'09:20–09:30',open:'09:30–09:40',h1:'10:30–10:40',close:'마감 후 30분 안 첫 수집'},
    live:liveBoard(radar),days:recs,stats:gapStats(recs),recorded_days:(idx?.dates||[]).length};
}
