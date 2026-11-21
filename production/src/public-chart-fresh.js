/** Phase46 public-market chart-only collector, separate from 90-day research.
 * Never writes research market/{symbol}_15.csv, membership, wallets, or orders.
 */
const COINS=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT'];
const BASE='market-hub/public-chart/v1/';
const SCHEMA='lumex_verified_public_15m_chart_v1';
const expectedOpen=atMs=>(Math.floor((atMs-5000)/900000)-1)*900000;
function gateBars(raw,now){
  if(!Array.isArray(raw)||raw.length<60||raw.length>2000)throw Error('gate_chart_schema');
  const sorted=[];
  for(const p of raw){
    const t=Number(p?.t)*1000,o=Number(p?.o),h=Number(p?.h),
      l=Number(p?.l),c=Number(p?.c),v=Number(p?.v);
    if(!Number.isSafeInteger(t)||t<1500000000000||t%900000!==0||t+900000>now||
      ![o,h,l,c,v].every(Number.isFinite)||l<=0||o<l||c<l||o>h||c>h||h<l||v<0)continue;
    if(v===0&&o===h&&h===l&&l===c)continue;
    sorted.push({t,o,h,l,c});
  }
  sorted.sort((a,b)=>a.t-b.t);
  const run=[];
  for(const p of sorted){
    if(run.length&&p.t===run.at(-1).t)continue;
    if(run.length&&p.t-run.at(-1).t!==900000)run.length=0;
    run.push(p);
  }
  if(run.length<60)throw Error('gate_chart_continuity');
  return run.slice(-100).map(p=>({t:p.t/1000,o:p.o,h:p.h,l:p.l,c:p.c}));
}
async function gateFetch(symbol,now){
  let failure='unavailable';
  for(const host of ['https://api.gateio.ws','https://fx-api.gateio.ws']){
    try{
      const u=host+'/api/v4/futures/usdt/candlesticks?contract='+
        symbol.replace('USDT','_USDT')+'&interval=15m&limit=130';
      const r=await fetch(u,{headers:{accept:'application/json'},signal:AbortSignal.timeout(6000)});
      if(!r.ok){failure='http_'+r.status;continue;}
      const raw=await r.text();
      if(raw.length<100||raw.length>85000){failure='size';continue;}
      const bars=gateBars(JSON.parse(raw),now);
      if(bars.at(-1).t*1000<expectedOpen(now))throw Error('provider_late_bar');
      return bars;
    }catch(error){failure=String(error?.message||'network').replace(/[^a-z0-9_-]/gi,'_').slice(0,60);}
  }
  throw Error('gate_chart_'+failure);
}
export async function collectFreshPublicCharts(env,atMs=Date.now()){
  if(!env.MARKET_DATA)throw Error('chart_r2_binding_missing');
  const expected=expectedOpen(atMs);
  const results=await Promise.allSettled(COINS.map(async symbol=>{
    const key=BASE+symbol+'.json',head=await env.MARKET_DATA.head(key);
    if(head?.customMetadata?.schema===SCHEMA&&Number(head.customMetadata.lastOpenMs)>=expected)
      return {symbol,status:'current'};
    const bars=await gateFetch(symbol,Date.now()),last=bars.at(-1).t*1000;
    if(last<expected)throw Error('source_missed_close');
    const payload={ok:true,schema:SCHEMA,symbol,source:'gate_public_futures_15m',
      data_quality:'verified',interval_minutes:15,order_execution:false,
      observed_at_utc:new Date().toISOString(),last_candle_utc:new Date(last).toISOString(),candles:bars};
    await env.MARKET_DATA.put(key,JSON.stringify(payload),{httpMetadata:{contentType:'application/json'},
      customMetadata:{schema:SCHEMA,lastOpenMs:String(last),source:'gate_public_futures_15m'}});
    return {symbol,status:'updated',lastOpenMs:last};
  }));
  for(let i=0;i<results.length;i++)if(results[i].status==='rejected')
    console.error('public_chart_freshness_failed',COINS[i],
      String(results[i].reason?.message||'source_error').slice(0,85));
  return results;
}
export async function readFreshPublicChart(env,symbol){
  if(!COINS.includes(symbol))throw Error('invalid_chart_symbol');
  if(!env.MARKET_DATA)throw Error('chart_r2_binding_missing');
  const stored=await env.MARKET_DATA.get(BASE+symbol+'.json');
  if(!stored||stored.size>85000)throw Error('chart_snapshot_missing');
  const item=await stored.json();
  if(item?.schema!==SCHEMA||item?.symbol!==symbol||item?.source!=='gate_public_futures_15m'||
    item?.data_quality!=='verified'||item?.order_execution!==false||
    !Array.isArray(item?.candles)||item.candles.length<60)throw Error('chart_snapshot_invalid');
  const last=Number(item.candles.at(-1)?.t);
  if(!Number.isSafeInteger(last)||last>Math.floor(Date.now()/1000)||
     last<Math.floor(Date.now()/1000)-7200)throw Error('chart_snapshot_stale');
  return {...item,served_at_utc:new Date().toISOString(),
    delayed:last*1000<expectedOpen(Date.now())};
}

/** Public read-only freshness receipt. Only source timestamps and status;
 * never exposes credentials, private orders, account data, or candles.
 */
export async function readPublicChartHealth(env,atMs=Date.now()){
  const expected=expectedOpen(atMs);
  if(!env.MARKET_DATA)return {ok:false,schema:'lumex_public_chart_freshness_proof_v1',error:'r2_unavailable'};
  const symbols=await Promise.all(COINS.map(async symbol=>{
    try{
      const head=await env.MARKET_DATA.head(BASE+symbol+'.json');
      const meta=head?.customMetadata||{},last=Number(meta.lastOpenMs||0);
      const valid=meta.schema===SCHEMA&&meta.source==='gate_public_futures_15m'&&
        Number.isSafeInteger(last)&&last>1500000000000&&last<=atMs;
      return {coin:symbol.replace('USDT',''),ready:valid&&last>=expected,
        last_candle_utc:valid?new Date(last).toISOString():null,
        lag_seconds:valid?Math.max(0,Math.floor((expected-last)/1000)):null,
        seconds_since_last_close:valid?Math.max(0,Math.floor((atMs-last-900000)/1000)):null,
        reason:!head?'snapshot_missing':!valid?'invalid_metadata':last<expected?'closed_bar_missing':'ok'};
    }catch{
      return {coin:symbol.replace('USDT',''),ready:false,last_candle_utc:null,
        lag_seconds:null,reason:'r2_read_failed'};
    }
  }));
  return {ok:true,schema:'lumex_public_chart_freshness_proof_v1',
    checked_at_utc:new Date(atMs).toISOString(),interval_minutes:15,
    expected_last_candle_utc:new Date(expected).toISOString(),
    all_ready:symbols.every(x=>x.ready),symbols,
    chart_type:'verified_closed_15m',prices_exposed:false,order_execution:false};
}
