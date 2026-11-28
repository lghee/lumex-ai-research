/** LUMEX 주식 선물 (Phase 113, 2026-11-27) — stock section data, kept apart from every coin feature.
 *
 * Source: Bybit v5 public market data only (no keys, no orders).
 *   - instruments-info (category=linear): `symbolType` separates TradFi contracts (stock, ETF, commodity, forex,
 *     xstocks) from crypto (empty). Stock section = symbolType stock|ETF, marketRegion US, USDT perpetual, Trading.
 *     The full TradFi set is also published so coin rankings can drop those contracts.
 *   - instrument-summary: company full names.
 *   - tickers (category=linear): price, 24h change, turnover, funding, open interest, index price.
 *   - kline: candles for the stock chart (kept in R2 by the collector; see the candles section).
 * US market sessions follow the NYSE published 2026–2028 calendar (checked against nyse.com 2026-11-27);
 * years outside it answer 'unknown' instead of guessing.
 * Nothing is estimated: a missing value stays null.
 */
const ROOT='stock-hub/v1/';
const BYBIT='https://api.bybit.com';
export const TRADFI_TYPES=Object.freeze(['stock','etf','commodity','forex','xstocks']);
export const SECTION_TYPES=Object.freeze(['stock','etf']);
export const INTERVALS=Object.freeze({'5':5*60000,'15':15*60000,'60':3600000,'240':4*3600000,'D':86400000});
export const MIN_TURNOVER_USD=100000; // thinner contracts are listed but never ranked
const fin=Number.isFinite;
const n=(v,lo=-Infinity,hi=Infinity)=>{if(v===null||v===undefined||v==='')return null;const x=Number(v);return fin(x)&&x>=lo&&x<=hi?x:null;};
const CORS={'access-control-allow-origin':'*','access-control-allow-methods':'GET, HEAD, OPTIONS','access-control-allow-headers':'content-type','x-content-type-options':'nosniff'};
const json=(v,status=200,age=0)=>new Response(JSON.stringify(v),{status,headers:{...CORS,'content-type':'application/json; charset=utf-8','cache-control':age?'public, max-age='+age:'no-store'}});

/* ───────── US market calendar (NYSE, verified 2026-11-27) ───────── */
const HOLIDAYS=new Set(('2026-01-01 2026-01-19 2026-02-16 2026-04-03 2026-05-25 2026-06-19 2026-07-03 2026-09-07 2026-11-26 2026-12-25 '+
 '2027-01-01 2027-01-18 2027-02-15 2027-03-26 2027-05-31 2027-06-18 2027-07-05 2027-09-06 2027-11-25 2027-12-24 '+
 '2028-01-17 2028-02-21 2028-04-14 2028-05-29 2028-06-19 2028-07-04 2028-09-04 2028-11-23 2028-12-25').split(' '));
const EARLY=new Set('2026-11-27 2026-12-24 2027-11-26 2028-07-03 2028-11-24'.split(' '));
const CAL_FROM='2026-01-01',CAL_TO='2028-12-31';
const ET=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
export function etParts(ms){const p=Object.fromEntries(ET.formatToParts(new Date(ms)).map(x=>[x.type,x.value]));return {date:`${p.year}-${p.month}-${p.day}`,minute:+p.hour*60+ +p.minute};}
const addDays=(date,k)=>{const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+k);return d.toISOString().slice(0,10);};
export function calendarKnown(date){return date>=CAL_FROM&&date<=CAL_TO;}
export function tradingDay(date){const w=new Date(date+'T12:00:00Z').getUTCDay();return calendarKnown(date)&&w!==0&&w!==6&&!HOLIDAYS.has(date);}
export const closeMinute=date=>EARLY.has(date)?780:960;      // 13:00 / 16:00 ET
const postEnd=date=>EARLY.has(date)?1020:1200;                // 17:00 / 20:00 ET
/** UTC ms of an ET wall-clock time on a date (DST-safe: offset read back from the formatter). */
export function etToMs(date,minute){
  let guess=Date.parse(date+'T00:00:00Z')+minute*60000+5*3600000;
  for(let i=0;i<3;i++){const p=etParts(guess),dd=(Date.parse(p.date+'T00:00:00Z')-Date.parse(date+'T00:00:00Z'))/60000;guess-=(dd+p.minute-minute)*60000;}
  return guess;
}
export const SESSION_LABEL=Object.freeze({regular:'정규장',pre:'프리마켓',post:'애프터마켓',overnight:'야간',closed:'휴장',unknown:'확인 불가'});
/** Current US session. overnight = 20:00 ET the evening before a trading day → 04:00 ET of that day. */
export function usSession(ms){
  const {date,minute}=etParts(ms);
  if(!calendarKnown(date))return {state:'unknown',label:SESSION_LABEL.unknown,date};
  const today=tradingDay(date),next=tradingDay(addDays(date,1));
  let state='closed';
  if(today){
    if(minute<240)state='overnight'; // the night session before a trading day
    else if(minute<570)state='pre';
    else if(minute<closeMinute(date))state='regular';
    else if(minute<postEnd(date))state='post';
    else state=next?'overnight':'closed';
  }else if(minute>=1200&&next)state='overnight';
  return {state,label:SESSION_LABEL[state],date,early_close:EARLY.has(date)};
}
/** Most recent trading date whose regular session has ended at `ms` (null outside the calendar). */
export function lastClosedSession(ms){
  let {date,minute}=etParts(ms);
  if(!(tradingDay(date)&&minute>=closeMinute(date)))date=addDays(date,-1);
  for(let i=0;i<10;i++){if(!calendarKnown(date))return null;if(tradingDay(date))return date;date=addDays(date,-1);}
  return null;
}
/** Regular-session windows [startMs, endMs] for trading days between two times (chart shading). */
export function regularSessions(fromMs,toMs){
  const out=[];let date=etParts(fromMs).date;const last=etParts(toMs).date;
  for(let i=0;i<400&&date<=last;i++,date=addDays(date,1))if(tradingDay(date))out.push([etToMs(date,570),etToMs(date,closeMinute(date))]);
  return out;
}

/* ───────── universe ───────── */
const typeOf=v=>String(v||'').trim().toLowerCase();
export function isTradfi(row){return TRADFI_TYPES.includes(typeOf(row?.symbolType));}
/** instruments-info pages + summary names → {tradfi:[symbols], stocks:[{symbol,ticker,name,type,region,...}]}. Pure. */
export function buildUniverse(instrumentRows,summaryRows,now){
  const names=new Map();
  for(const s of summaryRows||[])if(s?.symbol)names.set(String(s.symbol),{full:String(s.fullName||'').slice(0,80),ticker:String(s.underlyingTicker||'').slice(0,16)});
  const tradfi=new Set(),stocks=[];
  for(const r of instrumentRows||[]){
    const symbol=String(r?.symbol||'');if(!/^[A-Z0-9]{1,24}USDT$/.test(symbol))continue;
    if(!isTradfi(r))continue;
    tradfi.add(symbol);
    const type=typeOf(r.symbolType);
    if(!SECTION_TYPES.includes(type)||String(r.marketRegion||'').toUpperCase()!=='US')continue;
    if(r.status!=='Trading'||r.contractType!=='LinearPerpetual'||r.quoteCoin!=='USDT'||r.settleCoin!=='USDT')continue;
    const nm=names.get(symbol)||{};
    const ticker=(String(r.underlyingTicker||'')||nm.ticker||String(r.baseCoin||'')).toUpperCase().replace(/[^A-Z0-9.]/g,'').slice(0,12);
    if(!ticker)continue;
    stocks.push({symbol,ticker,slug:ticker.toLowerCase().replace(/\./g,'-'),name:nm.full||String(r.displayName||ticker).slice(0,80),
      type:type==='etf'?'ETF':'주식',region:'US',tick:String(r.priceFilter?.tickSize||''),qty_step:String(r.lotSizeFilter?.qtyStep||''),
      max_leverage:n(r.leverageFilter?.maxLeverage,1,1000),launch_ms:n(r.launchTime,1e12,4e12)});
  }
  const slugs=new Map();for(const s of stocks){if(slugs.has(s.slug))s.slug=s.symbol.toLowerCase();slugs.set(s.slug,1);} // a duplicate ticker keeps its full symbol
  stocks.sort((a,b)=>a.ticker.localeCompare(b.ticker));
  return {ok:stocks.length>0,schema:'lumex_stock_universe_v1',source:'Bybit v5 instruments-info · instrument-summary (category=linear)',
    updated_ms:now,tradfi:[...tradfi].sort(),stocks,count:stocks.length};
}
async function getJson(fetchImpl,url,max=3000000){
  const r=await fetchImpl(url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(8000)});
  if(!r.ok)throw Error('http_'+r.status);const t=await r.text();if(t.length<10||t.length>max)throw Error('size');return JSON.parse(t);
}
async function bybitPages(fetchImpl,path){
  const rows=[];let cursor='';
  for(let i=0;i<6;i++){
    const j=await getJson(fetchImpl,`${BYBIT}${path}${path.includes('?')?'&':'?'}limit=1000${cursor?'&cursor='+encodeURIComponent(cursor):''}`);
    if(j?.retCode!==0||!Array.isArray(j?.result?.list))throw Error('bybit_schema');
    rows.push(...j.result.list);cursor=String(j.result.nextPageCursor||'');if(!cursor)return rows;
  }
  throw Error('bybit_pages_incomplete');
}
async function rget(bucket,key){try{const o=await bucket.get(ROOT+key);return o?await o.json():null;}catch{return null;}}
const rput=(bucket,key,v)=>bucket.put(ROOT+key,JSON.stringify(v),{httpMetadata:{contentType:'application/json'}});
export async function readUniverse(env){return env?.MARKET_DATA?rget(env.MARKET_DATA,'universe.json'):null;}
/** For coin features: the TradFi symbol set (empty when not collected yet). */
export async function tradfiSet(env){const u=await readUniverse(env);return new Set(Array.isArray(u?.tradfi)?u.tradfi:[]);}

/* ───────── radar ───────── */
/** Tickers + universe + session + last close → ranked snapshot. Pure. */
export function buildRadar(universe,tickerRows,session,close,now){
  const by=new Map((tickerRows||[]).map(t=>[String(t?.symbol||''),t]));
  const items=[];
  for(const s of universe?.stocks||[]){
    const t=by.get(s.symbol);if(!t)continue;
    const last=n(t.lastPrice,1e-9,1e9);if(last===null)continue;
    const chg=n(t.price24hPcnt,-1,100),index=n(t.indexPrice,1e-9,1e9),turnover=n(t.turnover24h,0,1e15);
    const c=close?.prices?.[s.symbol];
    const item={symbol:s.symbol,ticker:s.ticker,slug:s.slug,name:s.name,type:s.type,last,
      change_24h_pct:chg===null?null:Number((chg*100).toFixed(3)),high_24h:n(t.highPrice24h,1e-9,1e9),low_24h:n(t.lowPrice24h,1e-9,1e9),
      turnover_24h_usd:turnover,oi_usd:n(t.openInterestValue,0,1e15),
      funding_pct:n(t.fundingRate,-1,1)===null?null:Number((Number(t.fundingRate)*100).toFixed(5)),next_funding_ms:n(t.nextFundingTime,1e12,4e12),
      index_price:index,mark_price:n(t.markPrice,1e-9,1e9),
      // premium only while the underlying trades (the index follows the real share price then)
      premium_pct:session.state==='regular'&&index?Number(((last/index-1)*100).toFixed(3)):null,
      since_close_pct:session.state!=='regular'&&c&&n(c.last,1e-9,1e9)?Number(((last/c.last-1)*100).toFixed(3)):null,
      ranked:turnover!==null&&turnover>=MIN_TURNOVER_USD};
    items.push(item);
  }
  items.sort((a,b)=>(b.turnover_24h_usd??-1)-(a.turnover_24h_usd??-1)||a.ticker.localeCompare(b.ticker));
  const ranked=items.filter(x=>x.ranked);
  const up=ranked.filter(x=>x.change_24h_pct>0).length,down=ranked.filter(x=>x.change_24h_pct<0).length;
  return {ok:items.length>0,schema:'lumex_stock_radar_v1',source:'Bybit 주식·ETF USDT 무기한 공개 시세',updated_ms:now,
    session,close_ref:close?{date:close.date,captured_ms:close.captured_ms,basis:'정규장 마감 직후 첫 수집 시각의 선물 가격'}:null,
    min_turnover_usd:MIN_TURNOVER_USD,breadth:{up,down,flat:ranked.length-up-down,total:ranked.length},count:items.length,items,order_execution:false};
}
/** Close capture: first run within 30 minutes after a regular close stores that day's prices (once). Pure decision. */
export function closeDue(now,existingDate){
  const {date,minute}=etParts(now);
  if(!tradingDay(date)||existingDate===date)return null;
  const m=closeMinute(date);return minute>=m&&minute<m+30?date:null;
}

/* ───────── collectors (cron every 5 minutes) ───────── */
export async function collectStockHub(env,{now=Date.now(),fetchImpl=fetch}={}){
  const bucket=env?.MARKET_DATA;if(!bucket)return {ok:false,reason:'r2_missing'};
  let universe=await rget(bucket,'universe.json');
  if(!universe?.ok||now-universe.updated_ms>3600000){
    try{
      const inst=await bybitPages(fetchImpl,'/v5/market/instruments-info?category=linear');
      let summary=[];
      for(const t of ['stock','ETF']){try{summary.push(...await bybitPages(fetchImpl,`/v5/market/instrument-summary?category=linear&symbolType=${t}`));}catch{}}
      const u=buildUniverse(inst,summary,now);
      if(u.ok){universe=u;await rput(bucket,'universe.json',u);}
    }catch(e){if(!universe?.ok)return {ok:false,reason:'universe_'+String(e?.message||e).slice(0,30)};}
  }
  let tickers;try{const j=await getJson(fetchImpl,`${BYBIT}/v5/market/tickers?category=linear`);if(j?.retCode!==0||!Array.isArray(j?.result?.list))throw Error('schema');tickers=j.result.list;}
  catch(e){return {ok:false,reason:'tickers_'+String(e?.message||e).slice(0,30)};}
  const latest=await rget(bucket,'close-latest.json');
  const due=closeDue(now,latest?.date);
  let close=latest;
  if(due){
    const set=new Set(universe.stocks.map(s=>s.symbol)),prices={};
    // 2026-11-28: the close also keeps 24h turnover, funding and open interest (for the daily record)
    for(const t of tickers)if(set.has(t.symbol)){const last=n(t.lastPrice,1e-9,1e9);if(last!==null)prices[t.symbol]={last,index:n(t.indexPrice,1e-9,1e9),turnover:n(t.turnover24h,0,1e15),
      funding_pct:n(t.fundingRate,-1,1)===null?null:Number((Number(t.fundingRate)*100).toFixed(5)),oi:n(t.openInterestValue,0,1e15)};}
    if(Object.keys(prices).length){close={date:due,captured_ms:now,prices};await rput(bucket,'closes/'+due+'.json',close);await rput(bucket,'close-latest.json',close);}
  }
  const session=usSession(now);
  // the stored close is used only if it belongs to the last finished regular session
  const ref=close&&close.date===lastClosedSession(now)?close:null;
  const radar=buildRadar(universe,tickers,session,ref,now);
  if(radar.ok)await rput(bucket,'radar.json',radar);
  let gaps=null;try{gaps=await (await import('./stock-gaps.mjs')).recordGaps(bucket,{universe,tickers,radar,now,closeStored:due?close:null});}catch(e){gaps={error:String(e?.message||e).slice(0,40)};}
  let daily=null;try{daily=await (await import('./stock-daily.mjs')).maybeBuildDaily(bucket,{close,universe,now});}catch(e){daily={error:String(e?.message||e).slice(0,40)};}
  let candles=null;try{candles=await collectCandles(env,radar,{now,fetchImpl});}catch(e){candles={ok:false,reason:String(e?.message||e).slice(0,40)};}
  await rput(bucket,'status.json',{updated_ms:now,radar:{ok:radar.ok,count:radar.count??0},gaps,daily,candles}).catch(()=>{});
  return {ok:radar.ok,count:radar.count,close_captured:Boolean(due),gaps,daily,candles};
}

/* ───────── candles (stock chart) ─────────
 * Bybit answers 403 to requests leaving some Cloudflare locations (seen 2026-11-27: every visitor request from the
 * US edge failed while the 5-minute collector kept working). So candles are kept in R2:
 *   - the collector refreshes the 1-hour bars of the most traded stocks, plus every symbol·interval a visitor asked
 *     for in the last 2 hours ("wanted");
 *   - a visitor request serves the stored copy while it is fresh, otherwise tries Bybit live (two official hosts),
 *     then falls back to the stored copy with its own time (as_of_ms). Nothing is invented when both are missing:
 *     the answer is 503 'warming' and the symbol is queued for the next collector run. */
const BYBIT_HOSTS=[BYBIT,'https://api.bytick.com'];
const CANDLE_LIMIT=500;
const FRESH_MS={'5':120000,'15':180000,'60':480000,'240':900000,'D':1800000};      // serve the stored copy without asking Bybit
const MAX_AGE_MS={'5':1800000,'15':3600000,'60':10800000,'240':28800000,'D':259200000}; // older than this is not shown
const WANTED_TTL=2*3600000,WANTED_TOUCH=10*60000,ROTATE_TOP=40,ROTATE_PER_RUN=20,CANDLE_TASKS_PER_RUN=45;
const candleKey=(symbol,interval)=>`candles/${symbol}/${interval}.json`;
export function parseKlineBars(list,frame,asOf){
  const bars=[];
  for(const r of list||[]){
    if(!Array.isArray(r)||r.length<6)continue;const [t,o,h,l,c,v]=r.slice(0,6).map(Number);
    if(![t,o,h,l,c,v].every(fin)||o<=0||l<=0||c<=0||h<Math.max(o,c,l)||l>Math.min(o,c,h)||v<0)continue;
    bars.push({t,o,h,l,c,v,closed:t+frame<=asOf});
  }
  bars.sort((a,b)=>a.t-b.t);
  return bars.filter((b,i,a)=>!i||b.t!==a[i-1].t);
}
export async function fetchKline(fetchImpl,symbol,interval,now){
  const frame=INTERVALS[interval];let error='source_unavailable';
  for(const host of BYBIT_HOSTS){
    try{
      const j=await getJson(fetchImpl,`${host}/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${CANDLE_LIMIT}`);
      if(j?.retCode!==0||!Array.isArray(j?.result?.list)){error='source_schema';continue;}
      const bars=parseKlineBars(j.result.list,frame,now);
      if(bars.length<2){error='too_few_bars';continue;}
      return {ok:true,bars,host:host.replace('https://','')};
    }catch(e){error=String(e?.message||e).slice(0,40);}
  }
  return {ok:false,error};
}
async function storeCandles(bucket,symbol,interval,got,now){
  await rput(bucket,candleKey(symbol,interval),{symbol,interval,fetched_ms:now,host:got.host,bars:got.bars});
}
async function markWanted(bucket,symbol,interval,now){
  const w=(await rget(bucket,'candles/wanted.json'))||{};const k=symbol+'|'+interval;
  if(now-(w[k]||0)<WANTED_TOUCH)return;
  w[k]=now;for(const [x,t] of Object.entries(w))if(now-t>WANTED_TTL)delete w[x];
  await rput(bucket,'candles/wanted.json',w);
}
/** Collector part: called from collectStockHub every 5 minutes. */
export async function collectCandles(env,radar,{now=Date.now(),fetchImpl=fetch}={}){
  const bucket=env?.MARKET_DATA;if(!bucket)return {ok:false,reason:'r2_missing'};
  const wanted=(await rget(bucket,'candles/wanted.json'))||{};
  const tasks=[],seen=new Set(),add=(s,iv)=>{const k=s+'|'+iv;if(!seen.has(k)&&INTERVALS[iv]&&/^[A-Z0-9]{1,24}USDT$/.test(s)){seen.add(k);tasks.push([s,iv]);}};
  for(const [k] of Object.entries(wanted).filter(([,t])=>now-t<=WANTED_TTL).sort((a,b)=>b[1]-a[1])){const [s,iv]=k.split('|');add(s,iv);}
  const top=(radar?.items||[]).filter(x=>x.ranked).slice(0,ROTATE_TOP);
  const half=Math.floor(now/300000)%2;
  top.forEach((x,i)=>{if(i<10||i%2===half)add(x.symbol,'60');});                       // top 10 every run, the rest every other run
  let ok=0,fail=0;const errors={};
  const run=tasks.slice(0,CANDLE_TASKS_PER_RUN);
  for(let i=0;i<run.length;i+=5){
    await Promise.all(run.slice(i,i+5).map(async([s,iv])=>{
      const got=await fetchKline(fetchImpl,s,iv,now);
      if(got.ok){await storeCandles(bucket,s,iv,got,now);ok++;}else{fail++;errors[got.error]=(errors[got.error]||0)+1;}
    }));
  }
  const pruned=Object.fromEntries(Object.entries(wanted).filter(([,t])=>now-t<=WANTED_TTL));
  if(Object.keys(pruned).length!==Object.keys(wanted).length)await rput(bucket,'candles/wanted.json',pruned);
  return {ok:fail===0,tasks:run.length,stored:ok,failed:fail,errors};
}

/* ───────── public routes /stock-hub/v1/* ───────── */
export async function candlesFor(env,symbol,interval,{fetchImpl=fetch,now=Date.now()}={}){
  const u=await readUniverse(env);const s=u?.stocks?.find(x=>x.symbol===symbol);
  if(!s)return {status:404,body:{ok:false,error:'unknown_symbol'}};
  const frame=INTERVALS[interval];if(!frame)return {status:400,body:{ok:false,error:'interval'}};
  const bucket=env.MARKET_DATA;
  const stored=await rget(bucket,candleKey(symbol,interval));
  const age=stored?now-Number(stored.fetched_ms||0):Infinity;
  let bars=null,asOf=0,origin='';
  if(Array.isArray(stored?.bars)&&stored.bars.length>=2&&age>=0&&age<=FRESH_MS[interval]){bars=stored.bars;asOf=stored.fetched_ms;origin='store';}
  let error=null;
  if(!bars){
    const got=await fetchKline(fetchImpl,symbol,interval,now);
    if(got.ok){bars=got.bars;asOf=now;origin='live';await storeCandles(bucket,symbol,interval,got,now).catch(()=>{});}
    else{
      error=got.error;
      if(Array.isArray(stored?.bars)&&stored.bars.length>=2&&age>=0&&age<=MAX_AGE_MS[interval]){bars=stored.bars;asOf=stored.fetched_ms;origin='store';}
    }
  }
  await markWanted(bucket,symbol,interval,now).catch(()=>{});
  if(!bars)return {status:503,body:{ok:false,error:'warming',source_error:error,retry_after_s:60}};
  bars=bars.map(b=>({...b,closed:b.t+frame<=asOf}));
  return {status:200,body:{ok:true,schema:'lumex_stock_candles_v1',symbol,ticker:s.ticker,name:s.name,interval,source:'Bybit',
    retrieved_ms:now,as_of_ms:asOf,origin,bars,regular_sessions:regularSessions(bars[0].t,bars.at(-1).t+frame),session:usSession(now)}};
}
export async function stockHubRoute(request,env,{fetchImpl=fetch,now=Date.now()}={}){
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:CORS});
  if(request.method!=='GET'&&request.method!=='HEAD')return json({ok:false,error:'method_not_allowed'},405);
  const url=new URL(request.url),p=url.pathname.slice('/stock-hub/v1/'.length),bucket=env?.MARKET_DATA;
  if(!bucket)return json({ok:false,error:'storage_unavailable'},503);
  if(p==='session')return json({ok:true,session:usSession(now),last_closed_session:lastClosedSession(now)},200,30);
  // 2026-11-28: regular-session windows for a time range (the browser shades bars it got from Bybit itself)
  if(p==='sessions'){
    const from=Number(url.searchParams.get('from')),to=Number(url.searchParams.get('to'));
    if(!Number.isFinite(from)||!Number.isFinite(to)||from>to||to-from>400*86400000)return json({ok:false,error:'range'},400);
    return json({ok:true,from,to,regular_sessions:regularSessions(from,to),session:usSession(now)},200,300);
  }
  if(p==='universe'){const u=await readUniverse(env);if(!u?.ok)return json({ok:false,error:'not_collected'},503);
    return json({ok:true,schema:u.schema,source:u.source,updated_ms:u.updated_ms,count:u.count,stocks:u.stocks},200,600);}
  if(p==='tradfi-symbols'){const u=await readUniverse(env);if(!u?.ok)return json({ok:false,error:'not_collected'},503);
    return json({ok:true,updated_ms:u.updated_ms,types:TRADFI_TYPES,symbols:u.tradfi},200,600);}
  // 2026-11-28 주식 신호 스캐너 — PRO content: only Core (Worker bearer) reads it
  if(p==='scan'){const m=await import('./stock-scan.mjs');if(!m.bearerOk(request,env))return json({ok:false,error:'unauthorized'},401);
    const r=await m.scanPayload(env,now);return new Response(JSON.stringify(r.body),{status:r.status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});}
  // 2026-11-28 AI 봇 주식 계좌 (simulated, no orders) and stock whale detail
  if(p==='bots'){const r=await (await import('./stock-league.mjs')).leaguePayload(env,now);return json(r.body,r.status,60);}
  if(p==='bots-detail'){const r=await (await import('./stock-league.mjs')).leagueDetail(env,url.searchParams.get('id')||'');return json(r.body,r.status,60);}
  if(p==='bots-trades'){const r=await (await import('./stock-league.mjs')).leagueTrades(env,(url.searchParams.get('symbol')||'').toUpperCase());return json(r.body,r.status,60);}
  if(p==='whale'){const r=await (await import('./stock-whales.mjs')).whaleDetail(env,url.searchParams.get('address')||'',{now,fetchImpl});return json(r.body,r.status,r.status===200?30:10);}
  // 2026-11-28 주식 데일리 기록
  if(p==='daily-index'){const d=await (await import('./stock-daily.mjs')).dailyIndex(env);return json(d,200,300);}
  if(p==='daily'){const d=await (await import('./stock-daily.mjs')).dailyPayload(env,url.searchParams.get('date')||'');return d?json(d,200,600):json({ok:false,error:'not_found'},404,60);}
  if(p==='gaps'){const g=await (await import('./stock-gaps.mjs')).gapsPayload(env,{now,days:Number(url.searchParams.get('days')||20)});return json(g,200,60);}
  if(p==='whales'){const w=await (await import('./stock-whales.mjs')).whalesPayload(env,{now});return json(w,w.ok?200:503,30);}
  if(p==='status'){const st=await rget(bucket,'status.json');return json({ok:Boolean(st),...(st||{})},200,30);}
  if(p==='radar'){const r=await rget(bucket,'radar.json');if(!r?.ok)return json({ok:false,error:'not_collected'},503);
    return json({...r,stale:now-r.updated_ms>20*60000},200,60);}
  if(p==='candles'){
    const symbol=String(url.searchParams.get('symbol')||'').toUpperCase(),interval=String(url.searchParams.get('interval')||'60');
    if(!/^[A-Z0-9]{1,24}USDT$/.test(symbol))return json({ok:false,error:'symbol'},400);
    const cache=typeof caches!=='undefined'?caches.default:null,key=new Request(`https://stock-hub.cache/${symbol}/${interval}`);
    if(cache){const hit=await cache.match(key);if(hit)return hit;}
    const r=await candlesFor(env,symbol,interval,{fetchImpl,now});
    const res=json(r.body,r.status,r.status===200?(interval==='D'?300:30):0);
    if(cache&&r.status===200)await cache.put(key,res.clone());
    return res;
  }
  return json({ok:false,error:'not_found'},404);
}
