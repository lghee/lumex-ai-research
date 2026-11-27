/** LUMEX 주식 데일리 기록 (Phase 119, 2026-11-28) — stock section only, numbers only (no AI text).
 *
 * One record per US trading day, built from what the 5-minute stock collector already stored — never re-fetched
 * or estimated afterwards:
 *   - closes/{date}.json and the previous trading day's close  → day change of every stock/ETF perpetual
 *     (Bybit last price captured within 30 minutes after the bell; from 2026-11-28 the capture also keeps
 *     24h turnover, funding and open interest)
 *   - gaps/{date}.json                                            → that morning's pre-open gap and what followed
 *   - whales/day/{date}.json                                      → Hyperliquid xyz whale moves found that ET day
 * A day without its own close and the previous close is not built (no half records). Built once, right after the
 * close is stored; the page reads it as it is.
 */
import {prevTradingDay,summarizeDay} from './stock-gaps.mjs';

const ROOT='stock-hub/v1/';
const KEEP_DATES=180,TOP_ROWS=30,MOVERS=5,MIN_TURNOVER=100000;
const fin=Number.isFinite;
const num=v=>{const x=Number(v);return v!==null&&v!==undefined&&v!==''&&fin(x)?x:null;};
async function rget(bucket,key){try{const o=await bucket.get(ROOT+key);return o?await o.json():null;}catch{return null;}}
const rput=(bucket,key,v)=>bucket.put(ROOT+key,JSON.stringify(v),{httpMetadata:{contentType:'application/json'}});
const pct=(a,b)=>a!==null&&b>0?Number(((a/b-1)*100).toFixed(3)):null;
export const isDate=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d);

/** Pure: the day record from two closes, the gap record, the whale day summary and the stock list. */
export function composeDaily({date,close,prevClose,gapRec,whaleDay,universe,now}){
  const meta=new Map((universe?.stocks||[]).map(s=>[s.symbol,s]));
  const all=[];
  for(const [sym,c] of Object.entries(close?.prices||{})){
    const s=meta.get(sym);if(!s)continue;
    const last=num(c?.last),prev=num(prevClose?.prices?.[sym]?.last);
    all.push({symbol:sym,ticker:s.ticker,slug:s.slug,name:s.name,type:s.type,close:last,prev_close:prev,day_pct:pct(last,prev),
      turnover_24h_usd:num(c?.turnover),funding_pct:num(c?.funding_pct),oi_usd:num(c?.oi)});
  }
  const known=all.filter(r=>r.day_pct!==null);
  const hasTurnover=all.some(r=>r.turnover_24h_usd!==null);
  // liquid rows only when turnover was captured; older closes (before 2026-11-28) have none, so every row counts
  const liquid=hasTurnover?known.filter(r=>(r.turnover_24h_usd??0)>=MIN_TURNOVER):known;
  const rows=[...liquid].sort((a,b)=>hasTurnover?(b.turnover_24h_usd??0)-(a.turnover_24h_usd??0)||a.ticker.localeCompare(b.ticker):a.ticker.localeCompare(b.ticker)).slice(0,TOP_ROWS);
  const byPct=[...liquid].sort((a,b)=>b.day_pct-a.day_pct||a.ticker.localeCompare(b.ticker));
  const up=byPct.filter(r=>r.day_pct>0).slice(0,MOVERS),down=byPct.filter(r=>r.day_pct<0).reverse().slice(0,MOVERS);
  const breadth={total:known.length,up:known.filter(r=>r.day_pct>0).length,down:known.filter(r=>r.day_pct<0).length,flat:known.filter(r=>r.day_pct===0).length};
  let gap=null;
  if(gapRec?.items){const g=summarizeDay(gapRec,10);
    const full=summarizeDay(gapRec,1000).rows.filter(r=>Math.abs(r.gap_pct)>=1);
    gap={...g,big:full.length,open_known:full.filter(r=>r.open_same!==null).length,open_same:full.filter(r=>r.open_same).length,
      close_known:full.filter(r=>r.close_same!==null).length,close_same:full.filter(r=>r.close_same).length};}
  const whales=whaleDay&&whaleDay.date===date?{count:whaleDay.count||0,kinds:whaleDay.kinds||{},top:(whaleDay.top||[]).slice(0,8),last_ms:whaleDay.last_ms||null}:null;
  return {ok:true,schema:'lumex_stock_daily_v1',date,prev_date:prevClose?.date||null,close_captured_ms:close?.captured_ms||null,
    prev_close_captured_ms:prevClose?.captured_ms||null,turnover_known:hasTurnover,built_ms:now,breadth,rows,movers:{up,down},gap,whales,source:'Bybit · Hyperliquid xyz'};
}

/** Called by the stock collector every run with the newest stored close: builds that day once. */
export async function maybeBuildDaily(bucket,{close,universe,now}){
  const date=close?.date;if(!isDate(date)||!close?.prices)return {built:false};
  if(await rget(bucket,'daily/'+date+'.json'))return {built:false};
  const prev=prevTradingDay(date);if(!prev)return {built:false,reason:'calendar'};
  const prevClose=await rget(bucket,'closes/'+prev+'.json');
  if(!prevClose?.prices)return {built:false,reason:'no_prev_close_'+prev};      // not built: no day change without the previous close
  const [gapRec,whaleDay]=await Promise.all([rget(bucket,'gaps/'+date+'.json'),rget(bucket,'whales/day/'+date+'.json')]);
  const rec=composeDaily({date,close,prevClose,gapRec,whaleDay,universe,now});
  await rput(bucket,'daily/'+date+'.json',rec);
  const idx=(await rget(bucket,'daily/index.json'))||{dates:[]};
  idx.dates=[...new Set([date,...idx.dates])].sort().reverse().slice(0,KEEP_DATES);idx.updated_ms=now;
  await rput(bucket,'daily/index.json',idx);
  return {built:true,date};
}

/** Whale moves of one ET day, kept as counts plus the largest (events themselves roll over within hours). */
export function addWhaleDay(day,date,events){
  const d=day&&day.date===date?day:{date,count:0,kinds:{},top:[],last_ms:null};
  for(const e of events){
    d.count++;d.kinds[e.kind]=(d.kinds[e.kind]||0)+1;d.last_ms=Math.max(d.last_ms||0,e.detected_ms||0);
    if(['new','add','flip'].includes(e.kind))d.top.push({ticker:e.ticker,slug:e.slug,side:e.side,kind:e.kind,value_usd:e.value_usd,entry_price:e.entry_price??null,
      address_short:e.address?e.address.slice(0,6)+'…'+e.address.slice(-4):'',detected_ms:e.detected_ms});
  }
  d.top=d.top.sort((a,b)=>b.value_usd-a.value_usd).slice(0,20);
  return d;
}

export async function dailyPayload(env,date){
  if(!isDate(date))return null;
  return await rget(env.MARKET_DATA,'daily/'+date+'.json');
}
export async function dailyIndex(env){
  const idx=await rget(env.MARKET_DATA,'daily/index.json');
  const dates=idx?.dates||[];
  // a short line per day for the list page (latest 30)
  const recs=(await Promise.all(dates.slice(0,30).map(d=>rget(env.MARKET_DATA,'daily/'+d+'.json')))).filter(Boolean);
  return {ok:true,schema:'lumex_stock_daily_index_v1',dates,updated_ms:idx?.updated_ms||null,
    days:recs.map(r=>({date:r.date,breadth:r.breadth,top_up:r.movers?.up?.[0]||null,top_down:r.movers?.down?.[0]||null,
      lead:(r.rows||[]).slice(0,3).map(x=>({ticker:x.ticker,day_pct:x.day_pct})),gap_big:r.gap?.big??null,whales:r.whales?.count??null}))};
}
