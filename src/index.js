/** LUMEX AI Research 1.3.1 — autonomous research-only scheduler.
 * The ONLY external side effects are public market reads, private R2 writes,
 * bounded OpenAI hypothesis calls and authenticated research-lab REST calls.
 * No exchange credentials, trading endpoints or customer portfolios.
 */
import { DurableObject } from 'cloudflare:workers';



/** Market Hub 1.3.1: independent, public-only Bybit/Binance/FNG collector.
 * R2 is authoritative in CF mode. Historical MySQL and live liquidation ledgers
 * are not read or combined here; no user/order/credentials are accessed.
 */
const PUBLIC_PULSE_KEY='market-hub/public-pulse/v1/latest.json';
const PUBLIC_PULSE_HEALTH='market-hub/public-pulse/v1/health.json';
const PUBLIC_PULSE_COINS=['BTC','ETH','SOL','XRP'];
const pulseN=(v,min,max)=>{const n=Number(v);return v!==null&&v!==undefined&&v!==''&&
  typeof v!=='boolean'&&Number.isFinite(n)&&n>=min&&n<=max?n:null;};
async function pulseJson(url,max=2500000){
  const resp=await fetch(url,{headers:{accept:'application/json'},
    signal:AbortSignal.timeout(8000)});
  if(!resp.ok)throw Error('provider_http_'+resp.status);
  const txt=await resp.text();if(txt.length<2||txt.length>max)throw Error('provider_size');
  try{return JSON.parse(txt)}catch{throw Error('provider_json')}
}
function pulseTickers(src){
  if(src?.retCode!==0||src?.result?.category!=='linear'||!Array.isArray(src?.result?.list))throw Error('ticker_schema');
  const quotes={};for(const q of src.result.list){
    const sym=q?.symbol;
    if(!PUBLIC_PULSE_COINS.some(c=>sym===c+'USDT'))continue;
    const price=pulseN(q.lastPrice,0.00000001,1e9),change=pulseN(q.price24hPcnt,-1,100);
    if(price===null||change===null)continue;
    const f=pulseN(q.fundingRate,-1,1);
    quotes[sym]={last:price,change_24h_pct:Number((change*100).toFixed(3)),
      funding_rate_pct:f===null?null:Number((f*100).toFixed(6)),
      open_interest_usdt:pulseN(q.openInterestValue,0,1e15),
      turnover_24h_usdt:pulseN(q.turnover24h,0,1e15)};
  }
  if(PUBLIC_PULSE_COINS.some(c=>!quotes[c+'USDT']))throw Error('ticker_missing');
  let up=0,down=0,flat=0;
  for(const q of Object.values(quotes))q.change_24h_pct>0?up++:q.change_24h_pct<0?down++:flat++;
  return {quotes,breadth:{up,down,flat,total:4},scope:'지원 중인 최대 4개 USDT 선형계약, 24h 등락률 기준'};
}
function pulseRatio(src,coin,now){
  if(src?.retCode!==0||!Array.isArray(src?.result?.list))throw Error('ratio_schema');
  for(const row of src.result.list){
    if(row?.symbol!==coin+'USDT')continue;
    const long=pulseN(row.buyRatio,0,1),short=pulseN(row.sellRatio,0,1),
      ts=pulseN(row.timestamp,1500000000000,4102444800000);
    if(long===null||short===null||ts===null||Math.abs(long+short-1)>.035)continue;
    const sampled=Math.floor(ts/1000);
    if(sampled<now-2400||sampled>now+120)continue;
    return {long_pct:Number((long*100).toFixed(2)),short_pct:Number((short*100).toFixed(2)),
      sample_unix:sampled,collected_unix:now,
      scope:coin+'USDT Bybit · 5분 계정 보유자 비율'};
  }
  throw Error('ratio_unavailable');
}
function pulseTaker(src,coin,now){
  if(!Array.isArray(src))throw Error('taker_schema');
  const recent=new Map();
  for(const row of src){
    const ts=pulseN(row?.timestamp,1500000000000,4102444800000),
      buy=pulseN(row?.buyVol,0,1e18),sell=pulseN(row?.sellVol,0,1e18);
    if(ts===null||buy===null||sell===null)continue;
    const t=Math.floor(ts/1000);
    if(t<=now-2400||t+300>now-10||t>now)continue;
    recent.set(t,{buy,sell});
  }
  const bars=[...recent].sort((a,b)=>a[0]-b[0]).slice(-6);
  if(bars.length<3||bars.at(-1)[0]+300<now-1000)throw Error('taker_unavailable');
  const buy=bars.reduce((n,x)=>n+x[1].buy,0),sell=bars.reduce((n,x)=>n+x[1].sell,0);
  if(!(buy+sell>0))throw Error('taker_zero');
  const pct=Number((100*buy/(buy+sell)).toFixed(2));
  return {status:'ok',buy_pct:pct,sell_pct:Number((100-pct).toFixed(2)),
    sample_unix:bars.at(-1)[0]+300,period_minutes:5,bars:bars.length,collected_unix:now};
}

/** Explicit Gate futures taker-volume alternative for Binance 403.
 * Gate's long_taker_size and short_taker_size are independent Gate contract
 * statistics, NEVER Binance order flow. Prefer only closed 5-minute intervals.
 */
export function pulseGateTaker(rows,coin,now){
  if(!Array.isArray(rows)||rows.length<1||rows.length>100)throw Error('gate_taker_schema');
  const unique=new Map();
  for(const r of rows){
    const ts=pulseN(r?.time,1500000000,4102444800),
      buy=pulseN(r?.long_taker_size,0,1e18),
      sell=pulseN(r?.short_taker_size,0,1e18);
    if(ts===null||buy===null||sell===null||!Number.isSafeInteger(ts)||
       ts%300!==0||ts+300>now-5||ts+300<now-1800||buy+sell<=0)continue;
    unique.set(ts,{buy,sell,
      long_liq_usdt:pulseN(r?.long_liq_usd_new??r?.long_liq_usd,0,1e18),
      short_liq_usdt:pulseN(r?.short_liq_usd_new??r?.short_liq_usd,0,1e18)});
  }
  const bars=[...unique].sort((a,b)=>a[0]-b[0]).slice(-3);
  if(!bars.length||now-(bars.at(-1)[0]+300)>900)throw Error('gate_taker_stale');
  const buy=bars.reduce((n,b)=>n+b[1].buy,0),
    sell=bars.reduce((n,b)=>n+b[1].sell,0);
  if(!Number.isFinite(buy+sell)||buy+sell<=0)throw Error('gate_taker_invalid');
  const buyPct=Number((100*buy/(buy+sell)).toFixed(2));
  const liqReady=bars.every(([,b])=>b.long_liq_usdt!==null&&b.short_liq_usdt!==null);
  const liquidation=liqReady?{
    long_usdt:Number(bars.reduce((t,[,b])=>t+b.long_liq_usdt,0).toFixed(4)),
    short_usdt:Number(bars.reduce((t,[,b])=>t+b.short_liq_usdt,0).toFixed(4)),
    period_minutes:bars.length*5,exchange:'Gate',
    source:'gateio_public_contract_stats_liquidation_aggregates',
    scope:'observed_5min_contract_statistics_not_individual_liquidation_trades'
  }:null;
  return {status:'ok',buy_pct:buyPct,sell_pct:Number((100-buyPct).toFixed(2)),
    sample_unix:bars.at(-1)[0]+300,period_minutes:bars.length*5,
    bars:bars.length,collected_unix:now,contract:coin+'_USDT',
    scope:'gateio_futures_contract_stats_closed_5m',
    volume_unit:'gate_futures_contracts',exchange:'Gate',
    liquidation};
}
async function pulseGateTakerFetch(coin,now){
  const path='/api/v4/futures/usdt/contract_stats?contract='+coin+'_USDT&interval=5m&limit=6';
  const errors=[];
  for(const origin of ['https://api.gateio.ws','https://fx-api.gateio.ws']){
    try{return pulseGateTaker(await pulseJson(origin+path,180000),coin,now)}
    catch(e){errors.push(String(e?.message||e).replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,48))}
  }
  throw Error('gate_taker_unavailable_'+errors.join('_').slice(0,110));
}
async function pulseTakerByAllowedSource(coin,now,env){
  let binance_error=null;
  // Binance 403 from current Cloudflare region: OFF by default until lawful
  // access is restored. An explicit setting can re-enable probing later.
  if(env.AUTO_BINANCE_TAKER_FETCH==='true'){
    try{
      const raw=await pulseJson('https://fapi.binance.com/futures/data/takerlongshortRatio?symbol='+
        coin+'USDT&period=5m&limit=9',10000);
      return {data:pulseTaker(raw,coin,now),source:'binance_futures_taker_volume',
        fallback_reason:null};
    }catch(e){
      binance_error=String(e?.message||e).replace(/[^A-Za-z0-9_-]/g,'_').slice(0,60);
    }
  }
  const gate=await pulseGateTakerFetch(coin,now);
  return {data:gate,source:'gateio_futures_contract_stats_taker_size',
    fallback_reason:binance_error||'binance_disabled_due_to_http_403'};
}

function pulseSentiment(src,now){
  const x=src?.data?.[0],v=pulseN(x?.value,0,100),ts=pulseN(x?.timestamp,1500000000,4102444800);
  if(!x||v===null||ts===null||!Number.isInteger(v)||!Number.isInteger(ts)||
    ts<now-90000||ts>now+120||
    !['Extreme Fear','Fear','Neutral','Greed','Extreme Greed'].includes(x.value_classification))throw Error('fng_invalid');
  return {value:v,classification:x.value_classification,sample_unix:ts,
    attribution:'Alternative.me',source_url:'https://alternative.me/crypto/fear-and-greed-index/'};
}
async function collectPublicPulse(env){
  if(env.AUTO_PUBLIC_PULSE_FETCH!=='true'||!env.MARKET_DATA)return {ok:false,disabled:true};
  const now=Math.floor(Date.now()/1000);
  let previous=null;
  try{const x=await env.MARKET_DATA.get(PUBLIC_PULSE_KEY);previous=x?await x.json():null}catch{}
  const feeds=previous?.schema==='lumex_public_pulse_v1'&&previous?.feeds&&typeof previous.feeds==='object'
    ?previous.feeds:{};
  const reports={};let updated=0;
  const jobs=[
    ['tickers','bybit_v5_linear','https://api.bybit.com/v5/market/tickers?category=linear',
       x=>pulseTickers(x),2500000],
    ...PUBLIC_PULSE_COINS.map(c=>['ratio_'+c,'bybit_v5_account_ratio',
      'https://api.bybit.com/v5/market/account-ratio?category=linear&symbol='+c+'USDT&period=5min&limit=2',
      x=>pulseRatio(x,c,now),70000]),
    ...PUBLIC_PULSE_COINS.map(c=>['taker_'+c,'source_separated_taker_volume',
      null,()=>pulseTakerByAllowedSource(c,now,env),0]),
    ['sentiment','alternative_me_fng','https://api.alternative.me/fng/?limit=1',
      x=>pulseSentiment(x,now),50000]
  ];
  const results=await Promise.allSettled(jobs.map(async j=>j[0].startsWith('taker_')?j[3]():j[3](await pulseJson(j[2],j[4]))));
  for(let i=0;i<jobs.length;i++){
    const [key,source]=jobs[i],r=results[i];
    if(r.status==='rejected'){
      const error=String(r.reason?.message||'provider_error').replace(/[^A-Za-z0-9_-]/g,'_').slice(0,60);
      reports[key]={ok:false,error};continue;
    }
    const resolvedSource=key.startsWith('taker_')?r.value.source:source;
    const data=key.startsWith('taker_')?r.value.data:r.value;
    const sampled_unix=key==='sentiment'||key.startsWith('ratio_')||key.startsWith('taker_')
      ?data.sample_unix:now;
    const record={source:resolvedSource,sampled_unix,data};
    if(key.startsWith('ratio_')||key.startsWith('taker_'))
      record.symbol=key.slice(key.indexOf('_')+1)+'USDT';
    if(key==='ratio_BTC')feeds.ratio=record;
    if(key==='tickers'||key==='sentiment')feeds[key]=record;
    else if(key.startsWith('ratio_'))(feeds.ratios??={})[key.slice(6)]=record;
    else if(key.startsWith('taker_'))(feeds.takers??={})[key.slice(6)]=record;
    updated++;reports[key]={ok:true,sampled_unix,source:resolvedSource,
      ...(key.startsWith('taker_')?{fallback_reason:r.value.fallback_reason}: {})};
  }
  const summary={ok:updated>0,enabled:true,checked_unix:now,updated,total:jobs.length,
    sources:reports,scope:'source-attributed public market observations',order_execution:false};
  if(updated>0){
    const payload={ok:true,schema:'lumex_public_pulse_v1',order_execution:false,
      collected_at_unix:now,feeds};
    const doc=JSON.stringify(payload);
    if(doc.length>100000)throw Error('pulse_snapshot_size');
    const utc=new Date(now*1000);
    const y=utc.toISOString().slice(0,10).replace(/-/g,'');
    const period=utc.toISOString().slice(11,16).replace(':','');
    // Once-per-5m archive: gaps stay gaps and do not become inferred zero readings.
    const archive='market-hub/public-pulse/v1/observations/'+y+'/'+period+'.json';
    if(!(await env.MARKET_DATA.head(archive)))
      await env.MARKET_DATA.put(archive,doc,{httpMetadata:{contentType:'application/json'}});
    await env.MARKET_DATA.put(PUBLIC_PULSE_KEY,doc,{httpMetadata:{contentType:'application/json'}});
  }
  await env.MARKET_DATA.put(PUBLIC_PULSE_HEALTH,JSON.stringify(summary),
    {httpMetadata:{contentType:'application/json'}});
  return summary;
}


/** 1.3.1: source-matched Bybit/Binance public OI and price history.
 * Never substitute Gate OI for Bybit/Binance, never merge two exchanges.
 */
const OI_PREFIX='market-hub/oi/v1/';
const OI_COINS=['BTC','ETH','SOL','XRP'];
const OI_INTERVALS=[7,30];
const oiFinite=(x,min,max)=>{if(x===null||x===undefined||x===''||typeof x==='boolean')return null;
  const n=Number(x);return Number.isFinite(n)&&n>=min&&n<=max?n:null;};
async function oiGet(url){
  const r=await fetch(url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(9000)});
  if(!r.ok)throw Error('oi_provider_http_'+r.status);
  const text=await r.text();if(text.length<3||text.length>1600000)throw Error('oi_provider_size');
  try{return JSON.parse(text)}catch{throw Error('oi_provider_json')}
}
function oiHistory(oi,candles,exchange,days,now){
  const frameMs=(days===30?14400:3600)*1000,prices=new Map();
  if(!Array.isArray(oi)||!Array.isArray(candles))throw Error('oi_history_schema');
  for(const row of candles){
    const t=oiFinite(row?.[0],1500000000000,now+120000),
      p=oiFinite(row?.[4],0.00000001,1e10);
    if(t!==null&&p!==null&&t%frameMs===0)prices.set(t,p);
  }
  const result=new Map();
  for(const row of oi){
    const t=oiFinite(row?.timestamp,1500000000000,now+120000);
    const volume=oiFinite(exchange==='Bybit'?row?.openInterest:row?.sumOpenInterestValue,0.00000000001,1e18);
    if(t===null||volume===null||!Number.isSafeInteger(t)||t>now+120000||
      t<now-38*86400000)continue;
    // Exchange OI timestamps are interval end; candle timestamps interval open.
    const candleStart=Math.floor((t-1)/frameMs)*frameMs,price=prices.get(candleStart);
    if(price===undefined)continue;
    const notional=exchange==='Bybit'?volume*price:volume;
    if(!Number.isFinite(notional)||notional<=0||notional>1e18)continue;
    result.set(t,{ts:t,price:Number(price.toFixed(8)),oi_usd:Number(notional.toFixed(4))});
  }
  const rows=[...result.values()].sort((a,b)=>a.ts-b.ts).slice(-200);
  const needed=days===30?90:48,minSpan=(days===30?25:5)*86400000;
  if(rows.length<needed||rows.at(-1).ts-rows[0].ts<minSpan||
     now-rows.at(-1).ts>(days===30?9*3600000:3*3600000))throw Error('oi_history_insufficient');
  return rows;
}
async function oiFromBybit(coin,days,now){
  const symbol=coin+'USDT',frame=days===30?'4h':'1h',interval=days===30?'240':'60';
  const params='category=linear&symbol='+symbol;
  const prefix='https://api.bybit.com/v5/market/';
  const [ticker,oi,candles]=await Promise.all([
    oiGet(prefix+'tickers?'+params),
    oiGet(prefix+'open-interest?'+params+'&intervalTime='+frame+'&limit=200'),
    oiGet(prefix+'kline?'+params+'&interval='+interval+'&limit=200')]);
  if(ticker?.retCode!==0||oi?.retCode!==0||candles?.retCode!==0 ||
      !Array.isArray(ticker?.result?.list)||!Array.isArray(oi?.result?.list)||!Array.isArray(candles?.result?.list))
    throw Error('bybit_oi_schema');
  const t=ticker.result.list.find(x=>x?.symbol===symbol);
  const price=oiFinite(t?.markPrice,0.00000001,1e10),notional=oiFinite(t?.openInterestValue,0.00000001,1e18);
  if(price===null||notional===null)throw Error('bybit_oi_quote_missing');
  const rows=oiHistory(oi.result.list,candles.result.list,'Bybit',days,now);
  return {exchange:'Bybit',price,oi_usd:notional,history:rows,
    sources:['Bybit V5 public tickers','Bybit V5 public open-interest','Bybit V5 public kline']};
}
async function oiFromBinance(coin,days,now){
  const symbol=coin+'USDT',frame=days===30?'4h':'1h';
  const [ticker,oi,candles]=await Promise.all([
    oiGet('https://fapi.binance.com/fapi/v1/premiumIndex?symbol='+symbol),
    oiGet('https://fapi.binance.com/futures/data/openInterestHist?symbol='+symbol+'&period='+frame+'&limit=200'),
    oiGet('https://fapi.binance.com/fapi/v1/klines?symbol='+symbol+'&interval='+frame+'&limit=200')]);
  const price=oiFinite(ticker?.markPrice,0.00000001,1e10);
  if(price===null)throw Error('binance_oi_quote_missing');
  const rows=oiHistory(oi,candles,'Binance',days,now);
  return {exchange:'Binance',price,oi_usd:rows.at(-1).oi_usd,history:rows,
    sources:['Binance public premiumIndex','Binance public openInterestHist','Binance public klines']};
}

/** Source-isolated Gate public futures contract stats OI rescue.
 * A Gate fallback is stored and labelled as Gate, never misrepresented as
 * Bybit/Binance OI, never combined with position/trading/order streams.
 */
export function oiGateHistory(rows,coin,days,now=Date.now()){
  const span=days===30?14400000:3600000,required=days===30?90:48;
  if(!OI_COINS.includes(coin)||![7,30].includes(days)||!Array.isArray(rows)||
     rows.length<required||rows.length>500)throw Error('gate_oi_shape');
  const unique=new Map();
  for(const x of rows){
    const t=oiFinite(x?.time,1500000000,4102444800),
      p=oiFinite(x?.mark_price,0.00000001,1e10),
      notional=oiFinite(x?.open_interest_usd,0.00000001,1e18);
    if(t===null||!Number.isSafeInteger(t)||p===null||notional===null)continue;
    const ts=t*1000+span; // closed interval, gate time is interval open
    if(t*1000%span!==0||ts>now-5000||ts<now-38*86400000)continue;
    unique.set(ts,{ts,price:Number(p.toFixed(8)),oi_usd:Number(notional.toFixed(4))});
  }
  const history=[...unique.values()].sort((a,b)=>a.ts-b.ts).slice(-200);
  if(history.length<required||history.at(-1).ts-history[0].ts<
      (days===30?25:5)*86400000||
     now-history.at(-1).ts>(days===30?9:3)*3600000)
    throw Error('gate_oi_insufficient_or_stale');
  if(history.some((x,i)=>i>0&&x.ts-history[i-1].ts!==span))
    throw Error('gate_oi_missing_interval');
  const last=history.at(-1);
  return {exchange:'Gate',price:last.price,oi_usd:last.oi_usd,history,
    sources:['Gate futures contract_stats public '+(days===30?'4h':'1h')],
    fallback_kind:'complete_single_exchange_oi_usd_series'};
}
async function oiFromGate(coin,days,now){
  const interval=days===30?'4h':'1h',
    path='/api/v4/futures/usdt/contract_stats?contract='+coin+'_USDT&interval='+interval+'&limit=200';
  let error='';
  for(const host of ['https://api.gateio.ws','https://fx-api.gateio.ws']){
    try{
      const data=await oiGet(host+path);
      return oiGateHistory(data,coin,days,now);
    }catch(e){error=String(e?.message||e).replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,56)}
  }
  throw Error('gate_oi_provider_unavailable_'+error);
}

async function collectOiMirror(env){
  if(env.AUTO_OI_MIRROR_FETCH!=='true'||!env.MARKET_DATA)return {ok:false,disabled:true};
  const now=Date.now(),slot=Math.floor(now/300000)%8;
  let coin=OI_COINS[slot%4],days=OI_INTERVALS[Math.floor(slot/4)],priorityRecovery=false;
  // Repair previously failed slots ahead of normal rotation, at most one per
  // 5-minute Cron. 10-minute retry cooldown prevents a blocked provider from
  // starving healthy combinations; Gate is always kept source-separated.
  try{
    const health=await env.MARKET_DATA.get(OI_PREFIX+'health.json');
    const doc=health?await health.json():null;
    const entries=doc?.sources&&typeof doc.sources==='object'?Object.entries(doc.sources):[];
    const failures=entries.filter(([id,item])=>
      /^(BTC|ETH|SOL|XRP)-(7|30)$/.test(id)&&item?.ok===false&&
      Number.isSafeInteger(item?.checked_unix)&&
      Math.floor(now/1000)-item.checked_unix>=600)
      .sort((a,b)=>a[1].checked_unix-b[1].checked_unix);
    if(failures.length){const match=/^(BTC|ETH|SOL|XRP)-(7|30)$/.exec(failures[0][0]);
      coin=match[1];days=Number(match[2]);priorityRecovery=true;}
  }catch{}
  const id=coin+'-'+days;
  let report={symbol:coin+'USDT',days,priority_recovery:priorityRecovery,checked_unix:Math.floor(now/1000),
    ok:false,source:null,error:null,order_execution:false};
  try{
    let market;
    const previousErrors=[];
    try{market=await oiFromBybit(coin,days,now)}
    catch(e){
      previousErrors.push('bybit_'+String(e?.message||'unavailable').replace(/[^A-Za-z0-9_-]/g,'_').slice(0,40));
      try{market=await oiFromBinance(coin,days,now)}
      catch(e2){
        previousErrors.push('binance_'+String(e2?.message||'unavailable').replace(/[^A-Za-z0-9_-]/g,'_').slice(0,40));
        market=await oiFromGate(coin,days,now);
      }
    }
    const record={ok:true,schema:'lumex_oi_mirror_v1',coin,pair:coin+'USDT',days,
      exchange:market.exchange,price:market.price,oi_usd:market.oi_usd,
      history:market.history,sources:market.sources,
      fallback_used:market.exchange==='Gate',
      sample_unix:Math.floor(now/1000),source_scope:'single_exchange_public_oi_only',
      order_execution:false,merged_with_gate:false};
    const body=JSON.stringify(record);
    if(body.length>120000)throw Error('oi_snapshot_oversize');
    const latestKey=OI_PREFIX+'latest/'+id+'.json';
    const time=new Date(now).toISOString();
    const archive=OI_PREFIX+'observations/'+coin+'/'+days+'/'+time.slice(0,10).replaceAll('-','')+'/'+time.slice(11,16).replace(':','')+'.json';
    const archived=await env.MARKET_DATA.get(archive);
    const safeBody=archived?await archived.text():body;
    if(!archived)await env.MARKET_DATA.put(archive,body,{httpMetadata:{contentType:'application/json'}});
    await env.MARKET_DATA.put(latestKey,safeBody,{httpMetadata:{contentType:'application/json'}});
    const persisted=JSON.parse(safeBody);
    report={...report,ok:true,source:persisted.exchange,observations:persisted.history.length,
      fallback_used:persisted.exchange==='Gate',age_seconds:0};
  }catch(e){report.error=String(e?.message||'oi_collect_failed').replace(/[^A-Za-z0-9_-]/g,'_').slice(0,72)}
  const statusKey=OI_PREFIX+'health.json';
  let status={ok:true,enabled:true,scope:'independent_bybit_or_binance_public_oi',
    not_gate_substitution:true,order_execution:false,sources:{}};
  try{
    const prior=await env.MARKET_DATA.get(statusKey);
    if(prior){const p=await prior.json();
      if(p?.sources&&typeof p.sources==='object')status.sources=p.sources;
    }
  }catch{}
  status.sources[id]=report;status.checked_unix=Math.floor(now/1000);
  await env.MARKET_DATA.put(statusKey,JSON.stringify(status),{httpMetadata:{contentType:'application/json'}});
  return report;
}

const PORT = 8080;
const SYMBOLS = Object.freeze(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT']);
const INTERVALS = Object.freeze([5, 15, 60]);
const MARKETS = SYMBOLS.flatMap(symbol => INTERVALS.map(interval_min => ({symbol, interval_min})));
const HEADERS = {'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', 'x-content-type-options':'nosniff'};
const CONTROL_KEY = 'control/research-scheduler-v1.json';
const FETCH_DIAGNOSTIC_KEY = 'control/last-market-fetch.json';
const MAX_CSV_BYTES = 12_000_000;
const QUALITY_SCHEMA = 'ohlcv_v2';
const MIN_CANDLES = interval => Math.ceil(90*1440/interval)+250;
const MIN_INGEST_CANDLES = interval => Math.ceil((interval===5?14:90)*1440/interval)+250;
// Worker-side independent validation. Container output is untrusted input;
// R2 v1 data is not eligible for research until revalidated/replaced.
function inspectCsv(text, interval, now=Date.now()){
  const lines=text.trimEnd().split(/\r?\n/);
  if(lines[0]!=='timestamp,open,high,low,close,volume')throw Error('market_csv_header_invalid');
  if(lines.length-1<MIN_INGEST_CANDLES(interval))throw Error('market_insufficient_history');
  const step=interval*60000;const currentOpen=Math.floor(now/step)*step;
  let prior=-1,first=0,last=0;
  for(let i=1;i<lines.length;i++){
    const fields=lines[i].split(',');
    if(fields.length!==6)throw Error('market_csv_row_invalid');
    const v=fields.map(Number);
    const [ts,o,h,l,c,vol]=v;
    if(!v.every(Number.isFinite)||!Number.isSafeInteger(ts)||ts<=0||ts%step||
       o<=0||l<=0||c<=0||vol<0||h<Math.max(o,l,c)||l>Math.min(o,c))throw Error('market_ohlcv_invalid');
    if(vol===0&&o===h&&h===l&&l===c)throw Error('market_unverified_zero_flat_candle');
    if(prior>=0&&ts-prior!==step)throw Error('market_gap_or_duplicate');
    if(ts>=currentOpen)throw Error('market_unfinished_candle');
    if(i===1)first=ts;
    last=ts;prior=ts;
  }
  if(last>now||now-last>Math.max(3600000,interval*180000))throw Error('market_stale');
  return {rows:lines.length-1,firstCandleMs:first,lastCandleMs:last,quality:(lines.length-1>=MIN_CANDLES(interval)?'verified':'collecting')};
}
function auditCrossFrame(newCsv,otherCsv,newInterval,otherInterval){
  // Only compare Gate/Binance/Bybit candles WITHIN the SAME named provider.
  // A full hour needs four 15m bars. Small rounding differences are tolerated;
  // material price/volume disagreements quarantine the new candidate.
  const csv15=newInterval===15?newCsv:otherCsv;
  const csv60=newInterval===60?newCsv:otherCsv;
  const quarter=new Map();
  for(const line of csv15.trimEnd().split(/\r?\n/).slice(1)){
    const [ts,o,h,l,c,v]=line.split(',').map(Number);
    const hour=Math.floor(ts/3600000)*3600000;
    if(!quarter.has(hour))quarter.set(hour,[]);
    quarter.get(hour).push([ts,o,h,l,c,v]);
  }
  let matched=0;
  for(const line of csv60.trimEnd().split(/\r?\n/).slice(1)){
    const [ts,o,h,l,c,v]=line.split(',').map(Number);
    const bars=quarter.get(ts);
    if(!bars||bars.length!==4||bars[0][0]!==ts||bars[3][0]!==ts+2700000)continue;
    matched++;
    const aggregated=[bars[0][1],Math.max(...bars.map(a=>a[2])),Math.min(...bars.map(a=>a[3])),bars[3][4],bars.reduce((s,a)=>s+a[5],0)];
    const expected=[o,h,l,c,v];
    if(aggregated.some((x,j)=>Math.abs(x-expected[j])>(j===4?Math.max(1,expected[j]*0.03):Math.max(0.5,expected[j]*0.0005)))){
      throw Error('cross_frame_15m_60m_mismatch_'+ts);
    }
  }
  // Only enforce if sufficient overlap exists to be meaningful.
  if(matched<24*7)throw Error('cross_frame_insufficient_overlap');
  return matched;
}
const respond = (value,status=200) => new Response(JSON.stringify(value),{status,headers:HEADERS});
const enabled = (env,key) => env[key] === 'true';
const WORKER_VERSION = '1.1.10';
// Only old Container AI transport failures qualify for one upgrade recovery.
// Other failures and successful AI requests retain their original cooldown.
const legacyContainerAiError = state => {
  const errors=[state?.aiLastExecution?.error,state?.aiLastResult?.lastAttempt?.error,state?.aiLastResult?.error];
  return errors.some(error=>/^(?:ai_)?container_ai_(?:\d{3}_)?/.test(String(error||'')));
};
const marketId = (sym,interval) => `${sym}:${interval}`;
const marketKey = (sym,interval) => `market/${sym}_${interval}.csv`;
const validMarket = (sym,interval) => SYMBOLS.includes(sym) && INTERVALS.includes(Number(interval));
const safeError = error => String(error?.message || error || 'unknown_error').replace(/[^a-z0-9_\-]/gi,'_').slice(0,160);
const auth = (request,secret) => Boolean(secret && secret.length >= 32 && request.headers.get('authorization') === `Bearer ${secret}`);
const fetchLimit = env => Math.min(2,Math.max(1,Number(env.MAX_FETCH_PER_TICK)||1));
const jobLimit = env => Math.min(24,Math.max(1,Number(env.RESEARCH_BATCH_SIZE)||12));
const isFresh = (head,interval,now) => {
  const last = Number(head?.customMetadata?.lastCandleMs || 0);
  return Boolean(head && head.customMetadata?.schema===QUALITY_SCHEMA && head.customMetadata?.quality==='verified' &&
    Number(head.customMetadata?.rows||0)>=MIN_CANDLES(interval) &&
    head.size>=20000 && last>0 && last<=now && now-last<=Math.max(3600000,interval*180000));
};
const dueForFetch = (head,interval,now) => {
  if (!head) return true;
  const fetched = Number(head.customMetadata?.fetchedAtMs || 0);
  // A 5m collecting-only cache is refreshed once a closed candle can exist;
  // never mark it research-ready until the full 90d plus warm-up is available.
  if (interval===5 && head.customMetadata?.quality==='collecting')
    return !fetched || now-fetched >= 5*60000;
  if (!isFresh(head,interval,now)) return !fetched || now-fetched >= 5*60000;
  return !fetched || now-fetched >= interval*60000;
};

async function callWP(env,endpoint,method='GET',body){
  if (!env.LUMEX_AI_LAB_WORKER_TOKEN || env.LUMEX_AI_LAB_WORKER_TOKEN.length<48) throw Error('research_token_not_configured');
  const base = env.LUMEX_SITE_URL || 'https://lumexbot.com';
  if (base !== 'https://lumexbot.com') throw Error('wordpress_origin_not_allowlisted');
  const url = `${base}/wp-json/lumex/v1/research-lab/${endpoint}`;
  const r = await fetch(url,{method,headers:{'authorization':`Bearer ${env.LUMEX_AI_LAB_WORKER_TOKEN}`,'content-type':'application/json','accept':'application/json'},body:method==='POST'?JSON.stringify(body||{}):undefined,signal:AbortSignal.timeout(20000)});
  if(!r.ok) throw Error(`wordpress_${endpoint.split('?')[0]}_${r.status}`);
  const value=await r.json();
  if(value?.ok===false) throw Error(`wordpress_${endpoint.split('?')[0]}_${safeError(value.state||value.error)}`);
  return value;
}
/** AI inference runs in the Worker network, not inside the market-data Container.
 * The Container can read Gate candles but its origin has seen HTTP 403 to WP or
 * OpenAI; WordPress telemetry already succeeds from the Worker. The WP reserve
 * and commit endpoints remain the ONLY usage-budget authority.
 * No customer signal or exchange order endpoint is accessible here.
 */
// AI hypotheses use the same verified 15m R2 candles as the backtest engine.
// WordPress chart/indicator snapshots can be stale independently of R2.
// Never call stale WordPress data live data; unverified R2 still blocks AI.
async function loadVerifiedAiMarket(env,symbol){
  const key=marketKey(symbol,15);
  const head=await env.MARKET_DATA.head(key);
  if(!isFresh(head,15,Date.now()))throw Error('ai_r2_market_not_verified_or_stale');
  if(Number(head.size)>MAX_CSV_BYTES)throw Error('ai_r2_market_too_large');
  const file=await env.MARKET_DATA.get(key);
  if(!file)throw Error('ai_r2_market_missing');
  const raw=await file.text();
  if(typeof raw!=='string'||raw.length>MAX_CSV_BYTES)throw Error('ai_r2_market_invalid');
  const lines=raw.trimEnd().split(/\r?\n/);
  if(lines[0]!=='timestamp,open,high,low,close,volume'||
    lines.length-1<MIN_CANDLES(15)||lines.length-1!==Number(head.customMetadata.rows))
    throw Error('ai_r2_market_rows_mismatch');
  const recent=lines.slice(-97).map(line=>line.split(',').map(Number));
  const step=15*60000;
  for(let i=0;i<recent.length;i++){
    const bar=recent[i];const [ts,o,h,l,c,v]=bar;
    if(bar.length!==6||!bar.every(Number.isFinite)||!Number.isSafeInteger(ts)||ts%step||
       o<=0||c<=0||l<=0||v<0||h<Math.max(o,c,l)||l>Math.min(o,c)||
       (i&&ts-recent[i-1][0]!==step))throw Error('ai_r2_market_recent_candle_invalid');
  }
  const latest=recent.at(-1);
  if(latest[0]!==Number(head.customMetadata.lastCandleMs))throw Error('ai_r2_market_last_candle_mismatch');
  if(latest[0]+step>Date.now())throw Error('ai_r2_market_unfinished_candle');
  const avg=bars=>bars.reduce((total,r)=>total+r[5],0)/Math.max(1,bars.length);
  const last24=recent.slice(-96);
  const first=last24[0][4],close=latest[4];
  const returns=last24.slice(1).map((r,i)=>Math.log(r[4]/last24[i][4]));
  const mean=returns.reduce((a,b)=>a+b,0)/Math.max(1,returns.length);
  const realizedVol=Math.sqrt(returns.reduce((a,b)=>a+(b-mean)**2,0)/Math.max(1,returns.length));
  return {
    source:String(head.customMetadata.source||'unknown'),quality:'verified',
    interval_min:15,rows:Number(head.customMetadata.rows),
    first_candle_ms:Number(head.customMetadata.firstCandleMs||0),
    last_closed_candle_ms:latest[0],last_close:close,
    return_24h_pct:Number(((close/first-1)*100).toFixed(4)),
    realized_volatility_15m_pct:Number((realizedVol*100).toFixed(4)),
    last_24h_volume_avg:Number(avg(last24).toFixed(5)),
    most_recent_closed_bars:recent.slice(-12).map(([t,o,h,l,c,v])=>({t,o,h,l,c,v}))
  };
}
async function runAiFromWorker(env,symbol,interval=15){
  if(!SYMBOLS.includes(symbol)||interval!==15)throw Error('ai_market_invalid');
  if(!env.OPENAI_API_KEY)throw Error('openai_key_missing');
  // Never reserve API budget for stale/missing WordPress market context.
  let context;
  try{context=await callWP(env,'context?symbol='+encodeURIComponent(symbol));}
  catch(error){throw Error('ai_context_'+safeError(error));}
  // WP is authenticated historical research context; freshness comes from R2.
  const marketEvidence=await loadVerifiedAiMarket(env,symbol);
  const wpContextFresh=context?.market?.fresh===true &&
    ['scored','partial'].includes(context?.technical?.data_quality);

  let reservation;
  try{reservation=await callWP(env,'reserve','POST',{});}
  catch(error){throw Error('ai_reserve_'+safeError(error));}
  const id=String(reservation?.reservation_id||'');
  if(!/^[a-f0-9]{24}$/.test(id))throw Error('ai_reserve_invalid_id');
  const maxOutput=Math.min(1200,Math.max(200,Number(reservation.max_output_tokens)||1200));
  const allowed=/^(breakout|pullback|mean_revert|momentum)$/;
  const fields={
    family:{type:'string',enum:['breakout','pullback','mean_revert','momentum']},
    lookback:{type:'integer'},fast:{type:'integer'},slow:{type:'integer'},
    rsi:{type:'integer'},max_hold:{type:'integer'},volume_mult:{type:'number'},
    stop_atr:{type:'number'},take_atr:{type:'number'},trend_filter:{type:'boolean'}
  };
  let inputTokens=0,outputTokens=0,usageConfirmed=false;
  let committed=false;
  try{
    const contextEvidence={symbol,interval_min:interval,
      research_history:(Array.isArray(context.research_history)?context.research_history:[]).slice(0,6),
      market:marketEvidence,wordpress_market_context:{fresh:wpContextFresh},
      technical:wpContextFresh?(context.technical||{}):{data_quality:'stale_wp_not_used'},
      chart_timeframes:context.chart_timeframes||{},
      signals:context.signal_observations||{},indicator_observations:context.indicator_observations||{},
      whales:context.whales||{},liquidations:context.liquidations||{}};
    const request={
      model:String(reservation.model||''),
      instructions:'Research-only strategy hypothesis generation. Never place orders or claim profit guarantees. Examine previous failed out-of-sample tests and avoid duplicates. Propose 1 to 3 distinct testable hypotheses. Families: breakout, pullback, mean_revert, momentum. Requirements: lookback 8..80; fast 5..40; slow 25..240 and greater than fast; rsi 20..80; volume_mult 0.5..3; stop_atr 0.6..4; take_atr 0.7..7; max_hold 3..48; trend_filter boolean. Use output schema exactly.',
      input:JSON.stringify(contextEvidence).slice(0,9500),
      reasoning:{effort:'none'},max_output_tokens:maxOutput,
      text:{format:{type:'json_schema',name:'lumex_research_ideas',strict:true,
        schema:{type:'object',properties:{ideas:{type:'array',items:{type:'object',properties:fields,
          required:Object.keys(fields),additionalProperties:false}}},required:['ideas'],additionalProperties:false}}},
      store:false
    };
    let result;
    try{
      const r=await fetch('https://api.openai.com/v1/responses',{
        method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+env.OPENAI_API_KEY},
        body:JSON.stringify(request),signal:AbortSignal.timeout(45000)});
      if(!r.ok){
        let code='';try{
          const reply=await r.json();const raw=String(reply?.error?.code||reply?.error?.type||'');
          if(/^[a-zA-Z0-9_-]{1,80}$/.test(raw))code='_'+raw;
        }catch{}
        throw Error('ai_openai_http_'+r.status+code);
      }
      result=await r.json();
    }catch(error){if(safeError(error).startsWith('ai_openai_http_'))throw error;
      throw Error('ai_openai_transport_'+safeError(error));}
    if(result?.status!=='completed')throw Error('ai_openai_incomplete');
    inputTokens=Math.max(0,Number(result.usage?.input_tokens||0));
    outputTokens=Math.max(0,Number(result.usage?.output_tokens||0));
    usageConfirmed=Boolean(result.usage);
    const message=(Array.isArray(result.output)?result.output:[])
      .filter(x=>x?.type==='message').flatMap(x=>Array.isArray(x.content)?x.content:[])
      .filter(x=>x?.type==='output_text').map(x=>String(x.text||'')).join('');
    if(!message)throw Error('ai_openai_empty_output');
    let ideas;
    try{ideas=JSON.parse(message).ideas;}catch{throw Error('ai_openai_invalid_json');}
    if(!Array.isArray(ideas)||ideas.length<1||ideas.length>12)throw Error('ai_openai_invalid_ideas');
    // Server-side WP DSL validator makes the final acceptance decision.
    const safeIdeas=ideas.slice(0,6).filter(spec=>spec&&typeof spec==='object'&&allowed.test(String(spec.family||'')));
    if(!safeIdeas.length)throw Error('ai_openai_zero_valid_ideas');
    let saved;
    try{saved=await callWP(env,'suggestions','POST',{symbol,interval_min:interval,ideas:safeIdeas});}
    catch(error){throw Error('ai_suggestions_'+safeError(error));}
    const accepted=Number(saved?.accepted||0);
    if(!Number.isInteger(accepted)||accepted<1)throw Error('ai_zero_candidates_accepted');
    return {ok:true,accepted,symbol,stage:'wordpress_suggestions',transport:'worker_direct'};
  }finally{
    // Even failed/unknown outcomes settle the reservation conservatively.
    try{await callWP(env,'commit','POST',{reservation_id:id,
      input_tokens:inputTokens,output_tokens:outputTokens,usage_confirmed:usageConfirmed});committed=true;}
    catch(error){console.error('ai_commit_failed',safeError(error));}
  }
}
async function invokeContainer(env,path,payload){
  if(!env.LUMEX_CONTAINER_KEY || env.LUMEX_CONTAINER_KEY.length<32)throw Error('container_key_not_configured');
  const stub=env.RESEARCH_CONTAINER.getByName('primary-research');
  const res=await stub.fetch('https://internal.lumex'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
  if(!res.ok){
    let code='';try{const v=await res.json();code=safeError(v.detail||v.error_code||'');}catch{}
    throw Error(`container_${path.slice(1)}_${res.status}_${code}`);
  }
  return res;
}
async function writeFetchDiagnostic(env,sym,interval,detail){
  const info={market:marketId(sym,interval),timestamp:new Date().toISOString(),...detail};
  // Private R2 control file. No keys, tokens or raw provider payloads.
  try{
    const body=JSON.stringify(info);
    const options={httpMetadata:{contentType:'application/json'}};
    await env.MARKET_DATA.put(FETCH_DIAGNOSTIC_KEY,body,options);
    await env.MARKET_DATA.put(`control/fetch-${sym}-${interval}.json`,body,options);
  }catch(e){console.error('fetch_diagnostic_write_failed',safeError(e));}
}
async function fetchPair(env,sym,interval){
  if(!validMarket(sym,interval))throw Error('selection_not_supported');
  try{
  const key=marketKey(sym,interval);
  const old=await env.MARKET_DATA.get(key);
  const prior=old && old.size<MAX_CSV_BYTES ? await old.text() : '';
  const existingSource=old?.customMetadata?.source || (old?'bybit_public_linear':'');
  const response=await invokeContainer(env,'/fetch',{symbol:sym,interval_min:interval,existing_csv:prior,existing_source:existingSource});
  const source=response.headers.get('X-Lumex-Market-Source');
  if(!['bybit_public_linear','binance_usdm_perpetual','gateio_usdt_perpetual'].includes(source))throw Error('market_source_unverified');
  const bytes=await response.arrayBuffer();
  if(bytes.byteLength<20000 || bytes.byteLength>MAX_CSV_BYTES)throw Error('market_data_size_invalid');
  const csv=new TextDecoder().decode(bytes);
  const now=Date.now();
  const audit=inspectCsv(csv,interval,now);
  // 15m and 1h same-provider series must not have material disagreement.
  if(interval===15||interval===60){
    const other=interval===15?60:15;
    const sibling=await env.MARKET_DATA.get(marketKey(sym,other));
    if(sibling && sibling.size<=MAX_CSV_BYTES && sibling.customMetadata?.source===source &&
       sibling.customMetadata?.schema===QUALITY_SCHEMA && sibling.customMetadata?.quality==='verified'){
      auditCrossFrame(csv,await sibling.text(),interval,other);
    }
  }
  // Only validated and (when possible) cross-checked data may replace R2.
  await env.MARKET_DATA.put(key,bytes,{httpMetadata:{contentType:'text/csv'},customMetadata:{source,
    lastCandleMs:String(audit.lastCandleMs),firstCandleMs:String(audit.firstCandleMs),
    rows:String(audit.rows),quality:audit.quality,fetchedAtMs:String(now),schema:QUALITY_SCHEMA}});
  await writeFetchDiagnostic(env,sym,interval,{ok:true,source,bytes:bytes.byteLength,
    lastCandleMs:audit.lastCandleMs,firstCandleMs:audit.firstCandleMs,rows:audit.rows,quality:audit.quality});
  return {market:marketId(sym,interval),source,bytes:bytes.byteLength,lastCandleMs:audit.lastCandleMs,rows:audit.rows,quality:audit.quality};
  }catch(error){
    await writeFetchDiagnostic(env,sym,interval,{ok:false,error:safeError(error)});
    throw error;
  }
}
async function getMarketInventory(env,now){
  const result=[];
  for(const p of MARKETS){
    const head=await env.MARKET_DATA.head(marketKey(p.symbol,p.interval_min));
    result.push({...p,head,ready:isFresh(head,p.interval_min,now),due:dueForFetch(head,p.interval_min,now)});
  }
  return result;
}
async function readScheduler(env){
  const stored=await env.MARKET_DATA.get(CONTROL_KEY);
  if(!stored)return {lastRun:0,fetchAttempts:{},aiAttempts:0,aiCursor:0,successes:0,failures:0,errors:[]};
  const parsed=await stored.json();
  return {...{lastRun:0,fetchAttempts:{},aiAttempts:0,aiCursor:0,successes:0,failures:0,errors:[]},...parsed};
}
async function writeScheduler(env,state){
  state.errors=(state.errors||[]).slice(-10);
  await env.MARKET_DATA.put(CONTROL_KEY,JSON.stringify(state),{httpMetadata:{contentType:'application/json'}});
}
async function releaseJobs(env,jobs,reason){
  for(const job of jobs){
    // Release a failed lease for retry instead of publishing an invalid backtest as 'insufficient'.
    try{await callWP(env,'release','POST',{id:job.id,job_hash:job.job_hash,claim_token:job.claim_token,error_code:safeError(reason)});}
    catch(e){console.error('release_failed',job.id,safeError(e));throw e;}
  }
}
async function runJobs(env,readyMarkets){
  if(!readyMarkets.length)return {processed:0,reason:'no_fresh_market_data'};
  const allowed=new Set(readyMarkets.map(p=>marketId(p.symbol,p.interval_min)));
  const markets=readyMarkets.map(p=>marketId(p.symbol,p.interval_min)).join(',');
  let processed=0,released=0;
  const maxBatches=Math.min(2,Math.max(1,Number(env.RESEARCH_BATCHES_PER_TICK)||2));
  for(let batch=0;batch<maxBatches;batch++){
    const received=await callWP(env,`jobs?limit=${jobLimit(env)}&markets=${encodeURIComponent(markets)}`);
    const jobs=Array.isArray(received.jobs)?received.jobs:[];
    if(!jobs.length)break;
    const groups=new Map();
    for(const j of jobs){
      const k=marketId(j.symbol,Number(j.interval_min));
      if(!allowed.has(k)){await releaseJobs(env,[j],'market_not_ready');released++;continue;}
      if(!groups.has(k))groups.set(k,[]);
      groups.get(k).push(j);
    }
    for(const [market,group] of groups){
      try{
        const [sym,intervalText]=market.split(':');const interval=Number(intervalText);
        const obj=await env.MARKET_DATA.get(marketKey(sym,interval));
        if(!obj || obj.size>MAX_CSV_BYTES)throw Error('r2_market_missing_or_large');
        const rr=await invokeContainer(env,'/evaluate',{csv:await obj.text(),jobs:group,interval_min:interval,market_source:obj.customMetadata?.source||'bybit_public_linear'});
        const data=await rr.json();
        if(!Array.isArray(data.reports) || data.reports.length!==group.length)throw Error('invalid_container_result');
        const byId=new Map(data.reports.map(x=>[Number(x.id),x]));
        for(const job of group){
          const report=byId.get(Number(job.id));
          if(!report || report.error || report.claim_token!==job.claim_token || report.job_hash!==job.job_hash){
            await releaseJobs(env,[job],safeError(report?.error_code||'invalid_evaluation'));
            released++;continue;
          }
          const result=await callWP(env,'results','POST',report);
          if(result.state==='already_recorded' || result.ok===true)processed++;
          else throw Error('wordpress_result_not_accepted');
        }
      }catch(error){
        // Avoid converting temporary data/container/network errors into false research results.
        const reason=safeError(error);console.error('research_market_error',market,reason);
        // releaseJobs is idempotent for already recorded jobs. Site checks lease token.
        for(const j of group){
          try{await releaseJobs(env,[j],reason);released++;}catch(e){console.error('research_release_error',j.id,safeError(e));}
        }
        if(reason.startsWith('wordpress_'))throw error;
      }
    }
    if(jobs.length<jobLimit(env))break;
  }
  return {processed,released};
}
// Safe paper-forward bridge: only candidate_review strategies, verified closed bars,
// authenticated WP observation journal. Never writes the public signal ledger.
async function runForward(env,readyMarkets){
  const eligible=readyMarkets.filter(p=>p.interval_min===15||p.interval_min===60);
  if(!eligible.length)return {candidates:0,recorded:0,reason:'no_verified_forward_market'};
  const pairs=eligible.map(p=>marketId(p.symbol,p.interval_min)).join(',');
  const response=await callWP(env,`forward/jobs?markets=${encodeURIComponent(pairs)}`);
  const jobs=Array.isArray(response.jobs)?response.jobs.slice(0,8):[];
  if(!jobs.length)return {candidates:0,recorded:0,reason:'no_candidate_review_strategy'};
  let recorded=0,seen=0;
  const groups=new Map();
  const allowed=new Set(eligible.map(p=>marketId(p.symbol,p.interval_min)));
  for(const job of jobs){
    const key=marketId(job.symbol,Number(job.interval_min));
    if(!allowed.has(key))continue;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(job);
  }
  for(const [market,group] of groups){
    const [symbol,frame]=market.split(':');const interval=Number(frame);
    const csv=await env.MARKET_DATA.get(marketKey(symbol,interval));
    if(!csv||csv.size>MAX_CSV_BYTES)continue;
    const rr=await invokeContainer(env,'/observe',{csv:await csv.text(),jobs:group,interval_min:interval,
      market_source:csv.customMetadata?.source||''});
    const data=await rr.json();
    if(!Array.isArray(data.reports))throw Error('invalid_paper_observation_result');
    const mapped=new Map(data.reports.map(r=>[Number(r.id),r]));
    for(const job of group){
      const evidence=mapped.get(Number(job.id));
      if(!evidence || evidence.error || evidence.job_hash!==job.job_hash)continue;
      seen++;
      const result=await callWP(env,'forward/records','POST',evidence);
      if(result.ok===true && result.state==='paper_observation_recorded')recorded++;
    }
  }
  return {candidates:jobs.length,seen,recorded,mode:'paper_only'};
}

async function orchestrate(env,fetchOnly=false,aiOnly=false){
  const now=Date.now();const state=await readScheduler(env);
  const summary={kind:'orchestrate',market_fetches:[],research:null,forward:null,ai:null,errors:[],timestamp:new Date(now).toISOString()};
  const active=enabled(env,'AUTO_FETCH')||(!fetchOnly&&(enabled(env,'AUTO_RESEARCH')||enabled(env,'AUTO_AI')));
  if(!active)return {...summary,skipped:'all_automation_disabled'};
  try{
    const inventory=await getMarketInventory(env,now);
    if(!aiOnly && enabled(env,'AUTO_FETCH')){
      // Oldest attempt first: repeated API 403 on one pair never starves all other pairs.
      const due=inventory.filter(p=>p.due).sort((a,b)=>(Number(state.fetchAttempts?.[marketId(a.symbol,a.interval_min)]||0)-Number(state.fetchAttempts?.[marketId(b.symbol,b.interval_min)]||0)));
      for(const p of due.slice(0,fetchLimit(env))){
        const id=marketId(p.symbol,p.interval_min);
        state.fetchAttempts[id]=now;
        try{
          const result=await fetchPair(env,p.symbol,p.interval_min);
          summary.market_fetches.push({...result,ok:true});
          state.successes=(state.successes||0)+1;
        }catch(error){
          const reason=safeError(error);summary.market_fetches.push({market:id,ok:false,error:reason});
          summary.errors.push(`fetch_${id}_${reason}`);state.failures=(state.failures||0)+1;
          console.error('market_fetch_failure',id,reason);
        }
      }
    }
    const fresh=await getMarketInventory(env,Date.now());
    const ready=fresh.filter(x=>x.ready);
    summary.ready_markets=ready.length;
    if(!fetchOnly)summary.markets=fresh.map(x=>({symbol:x.symbol,interval_min:x.interval_min,
      quality:x.head?.customMetadata?.quality||'absent',source:x.head?.customMetadata?.source||'',
      rows:Number(x.head?.customMetadata?.rows||0),
      firstCandleMs:Number(x.head?.customMetadata?.firstCandleMs||0),
      lastCandleMs:Number(x.head?.customMetadata?.lastCandleMs||0),
      fetchedAtMs:Number(x.head?.customMetadata?.fetchedAtMs||0),ready:x.ready}));
    if(!fetchOnly && !aiOnly && enabled(env,'AUTO_RESEARCH')){
      if(ready.length){
        try{
          const tick=await callWP(env,'tick','POST',{});
          summary.tick={state:tick.state,enqueued:tick.enqueued||0,cursor:tick.cursor||0};
          if(tick.state!=='disabled')summary.research=await runJobs(env,ready);
        }catch(error){summary.errors.push(`research_${safeError(error)}`);console.error('research_orchestration_error',safeError(error));}
      }else summary.research={processed:0,reason:'no_fresh_market_data'};
    }
    if(!fetchOnly && !aiOnly && enabled(env,'AUTO_RESEARCH') && ready.length){
      try{summary.forward=await runForward(env,ready);}
      catch(error){summary.forward={recorded:0,error:safeError(error)};
        summary.errors.push(`forward_${safeError(error)}`);console.error('forward_observation_error',safeError(error));}
    }
    // Never let an AI skip silently. Record explicit, non-secret, bounded states.
    // Only a verified, recently updated 15-minute R2 market is eligible for AI
    // research, and AI results are ALWAYS unapproved DSL hypotheses.
    if(!fetchOnly){
      if(!enabled(env,'AUTO_AI'))summary.ai={state:'disabled_in_cloudflare',ok:false};
      else if(!env.OPENAI_API_KEY)summary.ai={state:'openai_key_missing',ok:false};
      else {
        const ready15=ready.filter(p=>p.interval_min===15);
        if(!ready15.length)summary.ai={state:'no_verified_15m_market',ok:false};
        else {
          const legacyRecovery=!state.aiLastOk && Number(state.aiAttempts||0)>0 &&
            state.aiLegacyRecoveryVersion!==WORKER_VERSION && legacyContainerAiError(state);
          if(!legacyRecovery && now-Number(state.aiAttempts||0)<(state.aiLastOk?6*3600000:30*60000)){
            summary.ai={state:'cooldown',ok:false,
              nextAttemptAt:Number(state.aiAttempts||0)+(state.aiLastOk?6*3600000:30*60000),
              lastAttempt:state.aiLastExecution||null};
            if(state.aiLastExecution?.error)summary.ai.error=state.aiLastExecution.error;
          }else{
          // Recovery is one-shot and is marked BEFORE the call, even if it fails.
          // This never skips the WP reservation/budget checks in runAiFromWorker.
          if(legacyRecovery)state.aiLegacyRecoveryVersion=WORKER_VERSION;
          const p=ready15[(Number(state.aiCursor)||0)%ready15.length];
          const symbol=p.symbol;
          state.aiAttempts=now;state.aiCursor=(Number(state.aiCursor)||0)+1;
          try{
            const data=await runAiFromWorker(env,symbol,15);
            const accepted=Number(data.accepted||0);
            if(!Number.isSafeInteger(accepted)||accepted<1)throw Error('ai_zero_candidates_accepted');
            summary.ai={symbol,accepted,state:'completed',ok:true};state.aiLastOk=true;
          }catch(error){summary.ai={symbol,state:'failed',ok:false,error:safeError(error)};
            summary.errors.push(`ai_${safeError(error)}`);state.aiLastOk=false;}
          state.aiLastExecution={...summary.ai,attemptedAt:now,workerVersion:WORKER_VERSION,
            route:'worker_direct',recoveredLegacyError:legacyRecovery};
          console.info('lumex_ai_attempt',JSON.stringify(state.aiLastExecution));
          }
        }
      }
      state.aiLastResult=summary.ai;
    }

  }catch(error){summary.errors.push(`orchestrator_${safeError(error)}`);console.error('orchestrator_error',safeError(error));}
  state.lastRun=now;state.lastSummary=summary;state.errors.push(...summary.errors);
  await writeScheduler(env,state);
  // Optional site-side observability; a failing telemetry request must not lose completed research.
  if(!fetchOnly && env.LUMEX_AI_LAB_WORKER_TOKEN){
    try{await callWP(env,'telemetry','POST',{timestamp:Math.floor(now/1000),ready_markets:summary.ready_markets||0,summary:summary.research||{},fetches:summary.market_fetches,markets:summary.markets||[],forward:summary.forward,ai:summary.ai,errors:summary.errors});}
    catch(error){console.error('telemetry_failed',safeError(error));}
  }
  console.info('lumex_scheduler',JSON.stringify(summary));
  return summary;
}
async function processJob(env,job){
  if(!job || typeof job!=='object')throw Error('invalid_queue_message');
  if(job.kind==='orchestrate')return orchestrate(env);
  if(job.kind==='market_tick')return enabled(env,'AUTO_FETCH')?orchestrate(env,true):{skipped:'auto_fetch_off'};
  if(job.kind==='fetch'){
    if(!enabled(env,'AUTO_FETCH'))return {skipped:'auto_fetch_off'};
    return fetchPair(env,job.symbol,Number(job.interval_min));
  }
  if(job.kind==='research'){
    if(!enabled(env,'AUTO_RESEARCH'))return {skipped:'auto_research_off'};
    const ready=(await getMarketInventory(env,Date.now())).filter(x=>x.ready);
    if(!ready.length)return {processed:0,reason:'no_fresh_market_data'};
    const tick=await callWP(env,'tick','POST',{});
    return tick.state==='disabled'?{skipped:'wordpress_disabled'}:runJobs(env,ready);
  }
  if(job.kind==='ai'){
    if(!enabled(env,'AUTO_AI'))return {skipped:'auto_ai_off'};
    // Uses the same reservation and cooldown as scheduled AI; no paid bypass.
    return orchestrate(env,false,true);
  }
  throw Error('unknown_action');
}

// LUMEX Market Hub 1.2.0: authenticated, read-only verified R2 candles and
// append-only public observation journal. No private exchange accounts/orders.
const HUB_SYMBOLS=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT'];
const HUB_FRAMES=[5,15,60,240,1440];
const HUB_KINDS=['trade','liquidation','whale_transfer','ticker'];
const HUB_ORIGINS=['bybit','binance','gateio','blockstream','mempool','other_public'];
const hubReply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});
const hubAuthorized=(request,env)=> {
  const bearer=request.headers.get('authorization')||'';
  const valid=[env.LUMEX_AI_LAB_WORKER_TOKEN,env.LUMEX_ADMIN_API_TOKEN].filter(x=>typeof x==='string'&&x.length>=32);
  return valid.some(key=>bearer==='Bearer '+key);
};
const hubIngestAuthorized=(request,env)=>
  typeof env.LUMEX_CONTAINER_KEY==='string'&&env.LUMEX_CONTAINER_KEY.length>=32&&
  request.headers.get('authorization')==='Bearer '+env.LUMEX_CONTAINER_KEY;
function hubName(s){return HUB_SYMBOLS.includes(s)?s:null}
function hubFrame(s){const v=Number(s);return HUB_FRAMES.includes(v)?v:null}
function hubValidPrice(bar){
  const [t,o,h,l,c,v]=bar;
  return bar.length===6&&bar.every(Number.isFinite)&&Number.isSafeInteger(t)&&
    t>=1500000000000&&o>0&&h>=Math.max(o,c,l)&&l>0&&l<=Math.min(o,c)&&c>0&&v>=0;
}
const hubCache=new Map();
async function hubGetCandles(env,symbol,frame,limit=500){
  const srcFrame=frame===240||frame===1440?60:frame;
  const key='market/'+symbol+'_'+srcFrame+'.csv',now=Date.now();
  if(!env.MARKET_DATA)throw Error('r2_binding_unavailable');
  const head=await env.MARKET_DATA.head(key);
  const m=head?.customMetadata||{};
  if(!head||m.schema!=='ohlcv_v2'||m.quality!=='verified')throw Error('market_not_verified');
  if(!Number.isFinite(Number(m.lastCandleMs))||Number(m.lastCandleMs)>now ||
     Number(m.rows)<100||Number(head.size)>12_500_000)throw Error('market_metadata_invalid');
  const hit=hubCache.get(key),version=String(m.lastCandleMs)+':'+String(m.rows);
  let bars;
  if(hit&&hit.version===version&&hit.expires>now)bars=hit.bars;
  else{
    const obj=await env.MARKET_DATA.get(key);
    if(!obj)throw Error('market_missing');
    const raw=await obj.text();
    if(typeof raw!=='string'||raw.length>12_500_000)throw Error('market_too_large');
    const rows=raw.trimEnd().split(/\r?\n/);
    if(rows[0]!=='timestamp,open,high,low,close,volume'||
       rows.length-1!==Number(m.rows))throw Error('market_rows_mismatch');
    const tail=rows.slice(-Math.min(rows.length-1,2100));
    bars=tail.map(row=>row.split(',').map(Number));
    if(!bars.length||bars.some((bar,i)=>!hubValidPrice(bar)||(i>0&&bar[0]-bars[i-1][0]!==srcFrame*60000))||
       bars.at(-1)[0]!==Number(m.lastCandleMs))throw Error('market_candles_invalid');
    if(hubCache.size>24)hubCache.clear();
    hubCache.set(key,{version,expires:now+15000,bars});
  }
  let out=bars;
  if(frame!==srcFrame){
    const group=frame/srcFrame,step=frame*60000,complete=[];
    for(let i=0;i<bars.length;){
      const bucket=Math.floor(bars[i][0]/step)*step;let j=i;
      while(j<bars.length&&Math.floor(bars[j][0]/step)*step===bucket)j++;
      const slice=bars.slice(i,j);i=j;
      if(slice.length!==group||slice[0][0]!==bucket||slice.at(-1)[0]!==bucket+(group-1)*srcFrame*60000)continue;
      complete.push([bucket,slice[0][1],Math.max(...slice.map(r=>r[2])),Math.min(...slice.map(r=>r[3])),slice.at(-1)[4],slice.reduce((n,r)=>n+r[5],0)]);
    }
    out=complete;
  }
  const closed=out.filter(r=>r[0]+frame*60000<=now);
  if(closed.length<40)throw Error('market_insufficient_closed_candles');
  const ret=closed.slice(-Math.min(500,Math.max(40,limit)));
  const last=ret.at(-1)[0],age=Math.max(0,now-last-frame*60000);
  return {
    symbol,interval:frame===1440?'D':String(frame),source:String(m.source||'unknown')+' (R2 verified futures candles)',
    category:'linear',candles:ret.map(([t,o,h,l,c,v])=>({t,o,h,l,c,v})),
    last_candle_open_ms:last,retrieved_at:new Date(now).toISOString(),
    retrieved_at_unix:Math.floor(now/1000),as_of_utc:new Date(last+frame*60000).toISOString(),
    feed_mode:'cloudflare_r2_verified_closed_candles',orders_enabled:false,
    stale:age>frame*60000*2,age_seconds:Math.floor(age/1000),
    precision:'closed_candles_only',volume_unit:'exchange_native_contract_units',
    data_quality:'verified',provenance:'Cloudflare R2 OHLCV quality pipeline',
    notice:'확정 봉 데이터입니다. 체결 틱 실시간 스트림이나 고객 거래 신호가 아닙니다.'
  };
}
function hubTrend(bars){
  if(bars.length<51)return {status:'insufficient',trend:null,atr_pct:null};
  const last=bars.slice(-51),close=last.map(x=>x.c),sma=n=>close.slice(-n).reduce((a,b)=>a+b,0)/n;
  const a=sma(20),b=sma(50),c=close.at(-1);
  const trend=c>a&&a>b?'up':(c<a&&a<b?'down':'mixed');
  let atr=0;
  for(let i=last.length-14;i<last.length;i++)atr+=Math.max(last[i].h-last[i].l,Math.abs(last[i].h-last[i-1].c),Math.abs(last[i].l-last[i-1].c));
  return {status:'ok',trend,atr_pct:Number((atr/14/c*100).toFixed(3)),
    last_completed_open_ms:last.at(-1).t};
}

// Cloudflare derivatives snapshot collector. Gate public REST only; never
// customer exchange credentials, orders, or inferred market-wide numbers.
const DERIV_PREFIX='market-hub/derivatives/v1/';
const DERIV_SYMBOLS=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT'];
const DERIV_WINDOWS={'24h':86400000,'7d':604800000};
const derivNum=(value,min=-Infinity,max=Infinity)=>{
  if(value===null||value===undefined||value===''||typeof value==='boolean')return null;
  const n=Number(value);return Number.isFinite(n)&&n>=min&&n<=max?n:null;
};
const derivContract=s=>s.replace('USDT','_USDT');
const derivDay=t=>new Date(t).toISOString().slice(0,10).replaceAll('-','');
const derivLatestKey=s=>DERIV_PREFIX+'latest/'+s+'.json';
const derivDailyKey=(s,t)=>DERIV_PREFIX+'daily/'+s+'/'+derivDay(t)+'.json';
export function parseGateTicker(body,symbol){
  const item=(Array.isArray(body)?body:[body]).find(x=>x?.contract===derivContract(symbol));
  if(!item)return null;
  const last=derivNum(item.last,1e-9),mark=derivNum(item.mark_price,1e-9),
    index=derivNum(item.index_price,1e-9);
  if(last===null||mark===null||index===null)return null;
  const funding=derivNum(item.funding_rate,-1,1);
  return {last_price:last,mark_price:mark,index_price:index,
    funding_rate:funding,funding_rate_pct:funding===null?null:Number((funding*100).toFixed(8)),
    indicative_funding_rate:derivNum(item.funding_rate_indicative,-1,1),
    change_24h_pct:derivNum(item.change_percentage,-100,100000),
    turnover_24h_usdt:derivNum(item.volume_24h_quote,0),
    premium_pct:Number(((mark/index-1)*100).toFixed(6)),
    quote_currency:'USDT',price_source:'gate_usdt_futures_ticker'};
}
export function parseGateOpenInterest(body,now=Date.now()){
  if(!Array.isArray(body))return null;
  const sorted=body.filter(x=>x&&typeof x==='object').sort((a,b)=>Number(b.time||0)-Number(a.time||0));
  for(const item of sorted){
    const time=Number(item.time)*1000,oi=derivNum(item.open_interest_usd,0),
      contracts=derivNum(item.open_interest,0);
    if(!Number.isSafeInteger(time)||time<now-20*60000||time>now+120000||
      oi===null||contracts===null)continue;
    return {open_interest_usdt:oi,contracts,as_of_ms:time,source:'gate_contract_stats'};
  }
  return null;
}
function derivMeta(body,symbol,now=Date.now()){
  if(body?.name!==derivContract(symbol))return null;
  const interval=derivNum(body.funding_interval,60,86400),
    next=derivNum(body.funding_next_apply,0);
  return {interval_seconds:interval,next_funding_ms:next!==null&&next*1000>now&&next*1000<now+172800000?next*1000:null};
}
async function gateDerivativesGet(path){
  if(!/^\/futures\/usdt\/(tickers|contract_stats|contracts\/(BTC|ETH|SOL|XRP)_USDT)(\?|$)/.test(path))
    throw Error('gate_derivatives_path_denied');
  for(const host of ['https://api.gateio.ws/api/v4','https://fx-api.gateio.ws/api/v4']){
    try{
      const r=await fetch(host+path,{headers:{accept:'application/json'},signal:AbortSignal.timeout(9000)});
      if(!r.ok)throw Error('gate_http_'+r.status);
      const body=await r.text();
      if(body.length<2||body.length>200000)throw Error('gate_invalid_body');
      return JSON.parse(body);
    }catch(error){
      if(host.includes('fx-api.'))throw Error('gate_derivatives_unavailable');
    }
  }
  throw Error('gate_derivatives_unavailable');
}
async function derivDaily(env,symbol,ms){
  const obj=await env.MARKET_DATA.get(derivDailyKey(symbol,ms));
  if(!obj)return [];
  const rows=await obj.json();
  return Array.isArray(rows)&&rows.length<=300?
    rows.filter(x=>x?.symbol===symbol&&Number.isSafeInteger(x.snapshot_ms)):[];
}
async function saveDerivatives(env,record){
  const old=await derivDaily(env,record.symbol,record.snapshot_ms),bucket=Math.floor(record.snapshot_ms/300000);
  const records=[...old.filter(x=>Math.floor(x.snapshot_ms/300000)!==bucket),record]
    .sort((a,b)=>a.snapshot_ms-b.snapshot_ms).slice(-300);
  await env.MARKET_DATA.put(derivDailyKey(record.symbol,record.snapshot_ms),JSON.stringify(records),
    {httpMetadata:{contentType:'application/json'}});
  await env.MARKET_DATA.put(derivLatestKey(record.symbol),JSON.stringify(record),
    {httpMetadata:{contentType:'application/json'}});
}
async function collectGateDerivatives(env){
  if(env.AUTO_DERIVATIVES_FETCH!=='true')return {ok:false,disabled:true};
  const items=[];
  for(const symbol of DERIV_SYMBOLS){
    try{
      const now=Date.now(),contract=derivContract(symbol);
      const ticker=parseGateTicker(await gateDerivativesGet('/futures/usdt/tickers?contract='+contract),symbol);
      if(!ticker)throw Error('ticker_unusable');
      const [stat,meta]=await Promise.allSettled([
        gateDerivativesGet('/futures/usdt/contract_stats?contract='+contract+'&interval=5m&limit=3'),
        gateDerivativesGet('/futures/usdt/contracts/'+contract)
      ]);
      const oi=stat.status==='fulfilled'?parseGateOpenInterest(stat.value,now):null,
        schedule=meta.status==='fulfilled'?derivMeta(meta.value,symbol,now):null;
      const old=await derivDaily(env,symbol,now);
      const previous=old.filter(x=>x.snapshot_ms>=now-75*60000&&x.snapshot_ms<=now-55*60000&&
        x.open_interest?.open_interest_usdt>0).at(-1);
      const oiDelta=oi&&previous?
        Number(((oi.open_interest_usdt/previous.open_interest.open_interest_usdt-1)*100).toFixed(4)):null;
      const record={
        schema:'lumex_derivatives_v1',symbol,exchange:'gateio',market:'USDT perpetual',
        scope:'single_public_exchange_not_global',snapshot_ms:now,
        price:ticker,open_interest:oi,oi_change_1h_pct:oiDelta,funding_schedule:schedule,
        quality:'observed_public_snapshot',
        unavailable:[...(oi?[]:['open_interest']),...(schedule?[]:['funding_schedule'])],
        source_note:'Public Gate futures statistics, not customer positions or investment signals.',
        order_execution:false
      };
      await saveDerivatives(env,record);
      items.push({symbol,ok:true,open_interest_available:!!oi,funding_schedule_available:!!schedule});
    }catch(error){items.push({symbol,ok:false,error:String(error?.message||'error').slice(0,80)})}
  }
  const report={ok:items.some(x=>x.ok),collected_ms:Date.now(),items,cadence_seconds:300,
    scope:'gateio_usdt_perpetual_only'};
  await env.MARKET_DATA.put(DERIV_PREFIX+'status.json',JSON.stringify(report),{
    httpMetadata:{contentType:'application/json'}});
  return report;
}
async function readDerivatives(env,symbol){
  const obj=await env.MARKET_DATA.get(derivLatestKey(symbol));
  if(!obj)return null;
  const snap=await obj.json();
  if(snap?.schema!=='lumex_derivatives_v1'||snap?.symbol!==symbol)return null;
  const age=Math.max(0,Date.now()-snap.snapshot_ms);
  return {...snap,stale:age>15*60000,age_seconds:Math.round(age/1000),
    source_status:age>15*60000?'stale':'current'};
}
async function derivativesHistory(env,symbol,period){
  const span=DERIV_WINDOWS[period];
  if(!span)throw Error('invalid_window');
  const now=Date.now(),start=now-span,days=[];
  for(let day=Math.floor(start/86400000)*86400000;day<=now;day+=86400000)days.push(day);
  const chunks=await Promise.all(days.map(day=>derivDaily(env,symbol,day)));
  const all=chunks.flat().filter(x=>x.snapshot_ms>=start&&x.snapshot_ms<=now)
    .sort((a,b)=>a.snapshot_ms-b.snapshot_ms);
  const stride=Math.max(1,Math.ceil(all.length/168));
  return {ok:true,symbol,window:period,scope:'gateio_public_perpetual_observations',
    collected_points:all.length,source:'cloudflare_r2_daily_observations',
    points:all.filter((_,i)=>i%stride===0||i===all.length-1).map(x=>({
      t:x.snapshot_ms,mark:x.price?.mark_price??null,funding_rate_pct:x.price?.funding_rate_pct??null,
      open_interest_usdt:x.open_interest?.open_interest_usdt??null})),
    missing_intervals_not_filled:true,generated_at_ms:now,orders_enabled:false};
}

async function hubRadar(env){
  const items=await Promise.all(HUB_SYMBOLS.map(async symbol=>{
    const r={symbol,change_24h_pct:null,turnover_24h_usdt:null,
      '15m':{status:'unavailable',trend:null,atr_pct:null},
      '1h':{status:'unavailable',trend:null,atr_pct:null}};
    for(const [frame,name] of [[15,'15m'],[60,'1h']]){
      try{
        const v=await hubGetCandles(env,symbol,frame,160);r[name]=hubTrend(v.candles);
        r[name].age_seconds=v.age_seconds;r[name].stale=v.stale;
        if(frame===15&&v.candles.length>=97){
          const c=v.candles,rtn=(c.at(-1).c/c.at(-97).c-1)*100;
          r.change_24h_pct=Number(rtn.toFixed(3));
        }
      }catch(e){r[name]={status:'unavailable',trend:null,atr_pct:null,error:safeError(e)};}
    }
    return r;
  }));
  return {items,as_of_utc:new Date().toISOString(),ticker_status:'closed_candles_only',
    scope:'cloudflare_r2_verified_ohlcv',orders_enabled:false,
    notice:'변동률·SMA/ATR은 검증된 확정 선물 캔들만 계산합니다. 거래량 단위 불명확 시 USD 거래대금을 표시하지 않습니다.',
    market_realtime:false};
}
async function hubCheckTicket(request,env,symbol){
  const u=new URL(request.url),uid=u.searchParams.get('uid'),exp=u.searchParams.get('exp'),sig=u.searchParams.get('sig');
  if(!uid||!/^[1-9][0-9]{0,15}$/.test(uid)||!exp||!/^[0-9]{10}$/.test(exp)||
     !sig||!/^[a-f0-9]{64}$/.test(sig)||!env.LUMEX_AI_LAB_WORKER_TOKEN)return false;
  const now=Math.floor(Date.now()/1000),expires=Number(exp);
  if(expires<now||expires>now+120)return false;
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.LUMEX_AI_LAB_WORKER_TOKEN),
    {name:'HMAC',hash:'SHA-256'},false,['verify']);
  const bytes=Uint8Array.from(sig.match(/../g),x=>parseInt(x,16));
  return crypto.subtle.verify('HMAC',key,bytes,new TextEncoder().encode('mh1:'+uid+':'+symbol+':'+exp));
}
function hubValidateEvent(ev,symbol,now){
  if(!ev||typeof ev!=='object'||Array.isArray(ev))return null;
  const kind=String(ev.kind||''),source=String(ev.source||''),id=String(ev.id||'');
  const ts=Number(ev.ts),price=Number(ev.price||0),quantity=Number(ev.quantity||0);
  if(!HUB_KINDS.includes(kind)||!HUB_ORIGINS.includes(source)||!/^[A-Za-z0-9:_-]{8,128}$/.test(id)||
     !Number.isSafeInteger(ts)||ts<now-366*86400000||ts>now+120000||
     !Number.isFinite(price)||price<0||!Number.isFinite(quantity)||quantity<0)return null;
  if((kind==='trade'||kind==='liquidation'||kind==='ticker')&&(price<=0||quantity<=0&&kind!=='ticker'))return null;
  const side=['buy','sell','in','out','unknown'].includes(ev.side)?ev.side:'unknown';
  const txhash=typeof ev.txhash==='string'&&/^[a-fA-F0-9]{64}$/.test(ev.txhash)?ev.txhash:null;
  const capture=['public_stream','sampled_1s','sampled_2s','confirmed_chain_poll'].includes(ev.capture)?ev.capture:'public_observation';
  const price_type=['bankruptcy_price','trade_price','last_trade_price','avg_execution_price'].includes(ev.price_type)?ev.price_type:'unspecified';
  const position_side=['long','short'].includes(ev.position_side)?ev.position_side:null;
  const watched_address=kind==='whale_transfer'&&btcAddress(ev.watched_address)?ev.watched_address:null;
  const watch_label=watched_address?String(ev.watch_label||'watched reserve address').replace(/[^a-zA-Z0-9가-힣 _-]/g,'').slice(0,80):null;
  return {id,kind,source,symbol,ts,price,quantity,side,txhash,observed:true,capture,price_type,position_side,
    watched_address,watch_label,unit:kind==='whale_transfer'?'BTC':'exchange_native_contract_units'};
}
// Live public stream source adapters. These are observed exchange packets only:
// Bybit's liquidation "p" is BANKRUPTCY price, not an actual filled price.
// Gate trades are explicitly sampled to cap operational cost and must never
// be reported as a full tick/trade archive.
const LIVE_SYMBOLS=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT'];
const LIVE_GATE_CONTRACTS=LIVE_SYMBOLS.map(s=>s.replace('USDT','_USDT'));
const LIVE_ENABLED=env=>env?.AUTO_LIVE_STREAM==='true';
const BINANCE_LIQ_ENABLED=env=>LIVE_ENABLED(env)&&env?.AUTO_BINANCE_LIQUIDATIONS==='true';
const livePair=s=>LIVE_SYMBOLS.includes(s)?s:null;
const liveSymbolFromGate=s=>livePair(String(s||'').replace('_USDT','USDT'));
const liveFinite=n=>Number.isFinite(Number(n))?Number(n):NaN;
export function decodeBybitLiquidations(raw){
  if(!raw||typeof raw!=='object'||!/^allLiquidation\.(BTCUSDT|ETHUSDT|SOLUSDT|XRPUSDT)$/.test(String(raw.topic||'')))return [];
  const observations=[];
  for(const item of Array.isArray(raw.data)?raw.data:[]){
    const symbol=livePair(item?.s),ts=liveFinite(item?.T),price=liveFinite(item?.p),quantity=liveFinite(item?.v);
    if(!symbol||!Number.isSafeInteger(ts)||!Number.isFinite(price)||price<=0||
       !Number.isFinite(quantity)||quantity<=0||!['Buy','Sell'].includes(item.S))continue;
    observations.push({kind:'liquidation',symbol,source:'bybit',ts,price,quantity,
      side:item.S==='Buy'?'buy':'sell',position_side:item.S==='Buy'?'long':'short',
      price_type:'bankruptcy_price',capture:'public_stream'});
  }
  return observations.slice(0,200);
}
export function decodeGatePublic(raw){
  const channel=raw?.channel,kind=raw?.event;
  if(kind!=='update')return [];
  const output=[];
  if(channel==='futures.trades'){
    for(const item of Array.isArray(raw.result)?raw.result:[]){
      const symbol=liveSymbolFromGate(item?.contract),price=liveFinite(item?.price),
        amount=liveFinite(item?.size),ts=liveFinite(item?.create_time_ms||Number(item?.create_time)*1000);
      if(!symbol||item.is_internal===true||!Number.isSafeInteger(ts)||price<=0||!Number.isFinite(amount)||amount===0)continue;
      if(!/^\d+$/.test(String(item.id??'')))continue;
      output.push({id:'gateio:trade:'+symbol+':'+String(item.id),kind:'trade',symbol,source:'gateio',
        ts,price,quantity:Math.abs(amount),side:amount>0?'buy':'sell',capture:'sampled_1s',
        price_type:'trade_price'});
    }
  }else if(channel==='futures.tickers'){
    for(const item of Array.isArray(raw.result)?raw.result:[raw.result]){
      const symbol=liveSymbolFromGate(item?.contract),price=liveFinite(item?.last),
        ts=liveFinite(raw.time_ms||Number(raw.time)*1000);
      if(!symbol||!Number.isSafeInteger(ts)||price<=0)continue;
      output.push({id:'gateio:ticker:'+symbol+':'+Math.floor(ts/2000),
        kind:'ticker',symbol,source:'gateio',ts,price,quantity:0,side:'unknown',
        capture:'sampled_2s',price_type:'last_trade_price'});
    }
  }
  return output.slice(0,200);
}

const LIVE_CANDLE_INTERVALS=Object.freeze({'5m':5,'15m':15,'1h':60,'4h':240,'1d':1440});
export function decodeGateCandles(raw){
  if(raw?.channel!=='futures.candlesticks'||raw?.event!=='update')return [];
  const output=[],now=Date.now();
  for(const row of Array.isArray(raw.result)?raw.result:[]){
    const match=/^(5m|15m|1h|4h|1d)_(BTC|ETH|SOL|XRP)_USDT$/.exec(String(row?.n||''));
    if(!match)continue;
    const interval=LIVE_CANDLE_INTERVALS[match[1]],symbol=match[2]+'USDT';
    const t=Number(row.t)*1000,o=Number(row.o),h=Number(row.h),l=Number(row.l),
      c=Number(row.c),v=Number(row.v);
    if(!Number.isSafeInteger(t)||t<1500000000000||t>now+interval*60000||
       t%(interval*60000)!==0||![o,h,l,c,v].every(Number.isFinite)||
       o<=0||c<=0||l<=0||h<Math.max(o,c,l)||l>Math.min(o,c)||v<0)continue;
    output.push({kind:'provisional_kline',source:'gateio',symbol,interval_min:interval,
      open_ms:t,o,h,l,c,v,ts:Number(raw.time_ms)||now,confirmed:false,
      price_type:'gateio_futures_candle',capture:'public_stream_provisional'});
  }
  return output.slice(0,80);
}


/**
 * Binance USDⓈ-M public forceOrder (1-second per-symbol sampled snapshots).
 * No user/order endpoints. "ap" and "z" describe cumulative filled quantity
 * at sampled average price, not the full liquidation flow. There is NO native
 * stable order ID in the publicly documented forceOrder payload.
 */
export function decodeBinanceLiquidations(frame,now=Date.now()){
  const raw=frame?.data??frame;
  if(!raw||raw.e!=='forceOrder'||!raw.o||typeof raw.o!=='object')return [];
  if(raw.st!==undefined&&raw.st!==1)return []; // reject COIN-M after unified futures migration
  const o=raw.o,symbol=String(o.s||''),ts=Number(o.T),eventTs=Number(raw.E);
  if(!LIVE_SYMBOLS.includes(symbol)||!['BUY','SELL'].includes(o.S)||
     !['FILLED','PARTIALLY_FILLED'].includes(o.X)||
     !Number.isSafeInteger(ts)||!Number.isSafeInteger(eventTs)||
     ts<now-600000||ts>now+120000||Math.abs(eventTs-ts)>120000)return [];
  if(frame?.stream && frame.stream!=='!forceOrder@arr'&&
     frame.stream!==symbol.toLowerCase()+'@forceOrder')return [];
  const price=Number(o.ap),qty=Number(o.z);
  if(!Number.isFinite(price)||price<=0||price>1e9||
     !Number.isFinite(qty)||qty<=0||qty>1e12)return [];
  return [{kind:'liquidation',symbol,source:'binance',ts,price,quantity:qty,
    side:o.S==='SELL'?'sell':'buy',position_side:o.S==='SELL'?'long':'short',
    capture:'sampled_1s',price_type:'avg_execution_price'}];
}
async function binanceLiquidationId(e){
  const body=['binance_forceOrder_snapshot_v1',e.symbol,e.ts,e.side,
    Number(e.price).toFixed(8),Number(e.quantity).toFixed(8)].join('|');
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body));
  return 'binance:liq:'+e.symbol+':'+Array.from(new Uint8Array(digest).slice(0,16),
    byte=>byte.toString(16).padStart(2,'0')).join('');
}
async function watchlistDigest(items){
  const addresses=Array.from(new Set(items.map(x=>x.address))).sort();
  if(addresses.length<1||addresses.length>20||addresses.some(x=>!btcAddress(x)))
    throw Error('watchlist_invalid');
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(addresses.join('\n')));
  return {count:addresses.length,sha256:Array.from(new Uint8Array(digest),
    byte=>byte.toString(16).padStart(2,'0')).join('')};
}

async function liveLiquidationId(e){
  const text=[e.symbol,e.ts,e.side,e.quantity,e.price].join(':');
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
  return 'bybit:liq:'+e.symbol+':'+Array.from(new Uint8Array(bytes).slice(0,16),x=>x.toString(16).padStart(2,'0')).join('');
}

// BTC reserve-address observatory: confirmed address net changes only.
// Public Esplora amounts are satoshis; wallet flow does not prove a trade.
// Default seeds mirror the historical WordPress read-only watchlist while the
// signed WordPress watchlist endpoint is not installed.
const BTC_RESERVE_SEEDS=[
  {address:'34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo',label:'Binance legacy source label'},
  {address:'3M219KR5vEneNb47ewrPfWyb5jQ2DjxRP6',label:'Binance legacy source label'},
  {address:'3BMEX1cYYJt4jrtBdRJdD5A9deuxS6CCV3',label:'BitMEX legacy source label'},
  {address:'bc1qchctnvmdva5z9vrpxkkxck64v7nmzdtyxsrq64',label:'BitMEX legacy source label'}
];
const btcAddress=s=>typeof s==='string'&&
  (/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(s)||/^bc1[ac-hj-np-z02-9]{11,87}$/.test(s));
const sats=v=>Number.isSafeInteger(Number(v))&&Number(v)>=0?Number(v):null;
export function decodeBtcAddressFlow(tx,address,label='watched reserve address'){
  if(!btcAddress(address)||!tx||typeof tx!=='object'||!tx.status?.confirmed ||
     !/^[a-fA-F0-9]{64}$/.test(String(tx.txid||'')))return null;
  const ts=Number(tx.status.block_time)*1000;
  if(!Number.isSafeInteger(ts)||ts<1500000000000||ts>Date.now()+120000)return null;
  let incoming=0,outgoing=0;
  for(const v of Array.isArray(tx.vout)?tx.vout:[]){
    if(v?.scriptpubkey_address===address){const val=sats(v.value);if(val===null)return null;incoming+=val;}
  }
  for(const v of Array.isArray(tx.vin)?tx.vin:[]){
    if(v?.prevout?.scriptpubkey_address===address){const val=sats(v.prevout.value);if(val===null)return null;outgoing+=val;}
  }
  const net=incoming-outgoing;
  if(!Number.isSafeInteger(net)||net===0)return null;
  const quantity=Math.abs(net)/100000000;
  if(!(quantity>0))return null;
  return {kind:'whale_transfer',source:'blockstream',symbol:'BTCUSDT',
    id:'btc:addressflow:'+tx.txid+':'+address.slice(0,18),
    ts,price:0,quantity,side:net>0?'in':'out',txhash:tx.txid.toLowerCase(),
    capture:'confirmed_chain_poll',watched_address:address,
    watch_label:String(label).slice(0,80)};
}
/**
 * LUMEX public-market legacy archive importer.
 * Copies only the three explicitly allowlisted WordPress public-observation
 * tables to a SEPARATE immutable R2 archive. It deliberately does not ingest
 * these into the live event ledger (which would double-count old observations).
 * No user data, secrets, trading positions or exchange orders are accessed.
 */
export const LEGACY_SOURCES=Object.freeze(['liquidations','whales','market_snapshots']);
const PREFIX='market-hub/legacy/wp/';
const REQUIRED=Object.freeze({
  liquidations:['id','fingerprint','coin','exchange_name','position_side','price','quantity','notional_usd','event_ts'],
  whales:['id','fingerprint','provider','channel','asset','chain','transfer_direction','exchange_name','amount_usd','amount_coin','source_label','target_label','transaction_hash','event_ts'],
  market_snapshots:['id','coin','exchange_name','sample_ts','price','oi_usd','sample_kind']
});
const err=e=>String(e?.message||e||'unknown').replace(/[^A-Za-z0-9_-]/g,'_').slice(0,85);
const hex=bytes=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
export function validateLegacyPage(json,source,cursor,limit=100){
  if(json?.ok!==true||json?.schema!=='lumex_wp_public_market_export_v1'||
     json?.source!==source||Number(json?.cursor)!==cursor||
     !Array.isArray(json?.rows)||json.rows.length>limit||
     Number(json?.count)!==json.rows.length)return null;
  let last=cursor;
  const allowed=new Set(REQUIRED[source]);
  const out=[];
  for(const row of json.rows){
    if(!row||typeof row!=='object'||Array.isArray(row))return null;
    if(Object.keys(row).some(k=>!allowed.has(k)))return null;
    if(REQUIRED[source].some(k=>typeof row[k]!=='string'))return null;
    const id=Number(row.id);
    if(!Number.isSafeInteger(id)||id<=last)return null;
    const time=Number(row[source==='market_snapshots'?'sample_ts':'event_ts']);
    if(!Number.isSafeInteger(time)||time<1300000000||time>Date.now()/1000+120)return null;
    if(source==='liquidations'&&(!/^[a-fA-F0-9]{64}$/.test(row.fingerprint)||
       !['BTC','ETH','SOL','XRP'].includes(row.coin)||!['long','short'].includes(row.position_side.toLowerCase())))return null;
    if(source==='whales'&&(!/^[a-fA-F0-9]{64}$/.test(row.fingerprint)||
       !['in','out'].includes(row.transfer_direction)||!/^[A-Z0-9]{2,12}$/.test(row.asset)))return null;
    if(source==='market_snapshots'&&!['BTC','ETH','SOL','XRP'].includes(row.coin))return null;
    const values=source==='liquidations'?['price','quantity','notional_usd']:
      source==='whales'?['amount_usd','amount_coin']:['price','oi_usd'];
    if(values.some(k=>row[k]===''||!Number.isFinite(Number(row[k]))||Number(row[k])<0))return null;
    last=id;out.push(Object.fromEntries(REQUIRED[source].map(k=>[k,row[k]])));
  }
  if(Number(json.next_cursor)!==last)return null;
  return out;
}
export async function backfillOneLegacySource(env,storage,source){
  if(!LEGACY_SOURCES.includes(source))throw Error('unknown_source');
  if(!env.MARKET_DATA||typeof env.LUMEX_AI_LAB_WORKER_TOKEN!=='string'||
     env.LUMEX_AI_LAB_WORKER_TOKEN.length<48)throw Error('legacy_backfill_not_configured');
  const stateKey='legacy-backfill:'+source;
  const state=await storage.get(stateKey)||{
    source,cursor:0,records_archived:0,chunks_archived:0,
    first_import_ms:Date.now(),last_attempt_ms:0,last_success_ms:0,
    last_error:null,caught_up:false,source_retention_days:35,
    historical_live_ledger_merged:false
  };
  state.last_attempt_ms=Date.now();
  const cursor=Number(state.cursor)||0,limit=100;
  const url='https://lumexbot.com/wp-json/lumex/v1/market-hub/legacy-export?source='+
    encodeURIComponent(source)+'&cursor='+cursor+'&limit='+limit;
  try{
    const response=await fetch(url,{
      headers:{authorization:'Bearer '+env.LUMEX_AI_LAB_WORKER_TOKEN,accept:'application/json'},
      signal:AbortSignal.timeout(12000)});
    if(!response.ok)throw Error('wordpress_export_http_'+response.status);
    const body=await response.text();
    if(body.length>180000||body.length<2)throw Error('wordpress_export_size');
    let decoded;try{decoded=JSON.parse(body)}catch{throw Error('wordpress_export_json')}
    const rows=validateLegacyPage(decoded,source,cursor,limit);
    if(rows===null)throw Error('wordpress_export_schema_invalid');
    if(rows.length){
      const first=Number(rows[0].id),last=Number(rows.at(-1).id);
      // Source IDs and original provider fingerprints are preserved. This is a
      // lossless, source-attributed archive, not a normalized liquidation count.
      const payload={
        schema:'lumex_legacy_archive_v1',source,origin:'lumexbot_wordpress_public_market_mysql',
        source_cursor_from:cursor,source_cursor_to:last,record_count:rows.length,
        records:rows,integrity:'sha256_of_utf8_json_document',
        merged_with_live_observations:false
      };
      const json=JSON.stringify(payload);
      const digest=hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(json)));
      const key=PREFIX+source+'/'+first+'-'+last+'-'+digest.slice(0,24)+'.json';
      const previous=await env.MARKET_DATA.head(key);
      if(!previous)await env.MARKET_DATA.put(key,json,{
        httpMetadata:{contentType:'application/json'},
        customMetadata:{schema:'lumex_legacy_archive_v1',source,
          first_id:String(first),last_id:String(last),sha256:digest}
      });
      // Checkpoint only AFTER the object is safely present in R2.
      state.cursor=last;state.records_archived+=rows.length;state.chunks_archived++;
      state.last_archive_key=key;state.last_archive_sha256=digest;
      state.last_first_id=first;state.last_last_id=last;
      state.caught_up=!decoded.has_more_possible;
    }else state.caught_up=true;
    state.last_success_ms=Date.now();state.last_error=null;
  }catch(error){
    state.last_error=err(error);
    state.caught_up=false;state.failure_count=(state.failure_count||0)+1;
  }
  await storage.put(stateKey,state);
  return {source,cursor:state.cursor,records_archived:state.records_archived,
    chunks_archived:state.chunks_archived,last_error:state.last_error,
    caught_up:state.caught_up,success:state.last_error===null};
}
export async function runLegacyBackfill(env,storage){
  if(env.AUTO_LEGACY_BACKFILL!=='true')return {ok:true,enabled:false,archival_only:true};
  const results=[];
  // Three bounded indexed SQL reads / 5m, up to 300 rows total.
  for(const source of LEGACY_SOURCES)results.push(await backfillOneLegacySource(env,storage,source));
  return {ok:results.every(x=>x.success),enabled:true,archival_only:true,
    live_ledger_merge:false,source_rows_deleted:false,
    results,checked_at_ms:Date.now()};
}
export async function legacyBackfillHealth(env,storage){
  const sources=[];
  for(const source of LEGACY_SOURCES){
    const state=await storage.get('legacy-backfill:'+source);
    sources.push({source,cursor:state?.cursor||0,records_archived:state?.records_archived||0,
      chunks_archived:state?.chunks_archived||0,caught_up:Boolean(state?.caught_up),
      last_success_ms:state?.last_success_ms||0,
      last_attempt_ms:state?.last_attempt_ms||0,
      last_error:state?.last_error||null,
      failure_count:state?.failure_count||0});
  }
  return {ok:true,enabled:env.AUTO_LEGACY_BACKFILL==='true',
    schema:'lumex_legacy_archive_v1',source:'WordPress historical public-market tables',
    archive_prefix:PREFIX,immutable_source_records:true,live_ledger_merge:false,
    wordpress_data_deleted:false,source_rows_retention_days:35,
    disclaimer:'Original WordPress market observations are stored separately for audit. They are NOT added to live liquidation totals.',
    sources};
}

export class BtcReserveCollector extends DurableObject{
  constructor(ctx,env){super(ctx,env);this.ctx=ctx;this.env=env;this.legacyBackfillRun=null;}
  async state(){
    return await this.ctx.storage.get('state')||{
      nextIndex:0,watchlist_source:'uninitialized',last_run_ms:0,last_success_ms:0,
      accepted:0,requests:0,errors:0,addresses:{},error:null,
      coverage:'confirmed BTC address net changes only;not exchange-wide flows'};
  }
  async fetch(request){
    const path=new URL(request.url).pathname;
    if(path==='/status'){
      const state=await this.state(),watch=Object.entries(state.addresses||{})
        .map(([address,v])=>({address_suffix:address.slice(-8),label:v.label||'',
          last_checked_ms:v.checked_ms||0,backfill_complete:!!v.backfill_complete,
          observed_confirmed:v.observed||0,gap_possible:!!v.gap_possible,error:v.error||null}));
      return hubReply({ok:true,enabled:this.env.AUTO_WHALE_FETCH==='true',source:state.watchlist_source,
        last_run_ms:state.last_run_ms,last_success_ms:state.last_success_ms,
        accepted:state.accepted,requests:state.requests,errors:state.errors,
        last_error:state.error,watchlist:watch,coverage:state.coverage,orders_enabled:false});
    }
    if(path==='/watchlist-parity'){
      const state=await this.state(),ms=Number(state.watchlist_checked_ms)||0,now=Date.now();
      const count=Number(state.watchlist_count)||0,sha=String(state.watchlist_sha256||'');
      const configured=state.watchlist_source==='wordpress_configured';
      const fresh=ms>now-1200000&&ms<=now+120000;
      const enabled=this.env.AUTO_WHALE_FETCH==='true';
      return hubReply({ok:enabled&&configured&&fresh&&count>0&&/^[a-f0-9]{64}$/.test(sha),
        enabled,
        schema:'lumex_watchlist_parity_v1',source:state.watchlist_source||'unknown',
        address_count:count,address_set_sha256:/^[a-f0-9]{64}$/.test(sha)?sha:null,
        checked_unix:Math.floor(ms/1000),recent_worker_success_unix:Math.floor((state.last_success_ms||0)/1000),
        stale:!fresh,read_only:true,source_scope:'confirmed_btc_address_watchlist',
        safe_to_disable_wordpress_crons:false});
    }
    if(path==='/backfill-status')return hubReply(await legacyBackfillHealth(this.env,this.ctx.storage));
    if(path==='/backfill'){
      if(this.env.AUTO_LEGACY_BACKFILL!=='true')
        return hubReply({ok:true,enabled:false,archival_only:true});
      if(!this.legacyBackfillRun)
        this.legacyBackfillRun=runLegacyBackfill(this.env,this.ctx.storage)
          .finally(()=>{this.legacyBackfillRun=null;});
      return hubReply(await this.legacyBackfillRun);
    }
    if(path==='/poll'){
      if(this.env.AUTO_WHALE_FETCH!=='true')return hubReply({ok:true,enabled:false,skipped:true});
      return hubReply(await this.poll());
    }
    return hubReply({ok:false,error:'not_found'},404);
  }
  async watchlist(){
    const token=this.env.LUMEX_AI_LAB_WORKER_TOKEN;
    if(typeof token==='string'&&token.length>=48){
      try{
        const r=await fetch('https://lumexbot.com/wp-json/lumex/v1/market-hub/watchlist',{
          headers:{authorization:'Bearer '+token,accept:'application/json'},
          signal:AbortSignal.timeout(9000)});
        if(r.ok){
          const json=await r.json();
          const data=Array.isArray(json.watchlist)?json.watchlist:[];
          const valid=data.filter(v=>btcAddress(v?.address)).slice(0,20).map(v=>({
            address:v.address,label:String(v.exchange||'observed reserve address').slice(0,80)}));
          return {items:valid,mode:'wordpress_configured'};
        }
        if(r.status!==404)throw Error('wordpress_watchlist_http_'+r.status);
      }catch(e){if(!String(e?.message||'').includes('wordpress_watchlist_http_')){
          // WordPress may be an older Core release with no endpoint;
          // a timeout is NOT treated as an empty or trusted watchlist.
          throw Error('wordpress_watchlist_unreachable');
        }
        throw e;
      }
    }
    return {items:BTC_RESERVE_SEEDS,mode:'legacy_seed_fallback'};
  }
  async fetchPage(address,cursor=''){
    const base='https://blockstream.info/api/address/'+encodeURIComponent(address)+'/txs/chain';
    const url=cursor?base+'/'+encodeURIComponent(cursor):base;
    const response=await fetch(url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(12000)});
    if(!response.ok)throw Error('esplora_http_'+response.status);
    const text=await response.text();
    if(text.length>2400000)throw Error('esplora_response_oversize');
    const rows=JSON.parse(text);
    if(!Array.isArray(rows)||rows.length>25)throw Error('esplora_invalid_page');
    return rows;
  }
  async poll(){
    const state=await this.state(),now=Date.now();
    state.last_run_ms=now;state.addresses||={};
    try{
      const {items,mode}=await this.watchlist();
      state.watchlist_source=mode;
      if(!items.length)throw Error('watchlist_empty');
      const fingerprint=await watchlistDigest(items);
      state.watchlist_count=fingerprint.count;
      state.watchlist_sha256=fingerprint.sha256;
      state.watchlist_checked_ms=now;
      const a=items[Number(state.nextIndex||0)%items.length];
      state.nextIndex=(Number(state.nextIndex||0)+1)%items.length;
      const prior=state.addresses[a.address]||{label:a.label,backfill_complete:false,observed:0};
      const newest=await this.fetchPage(a.address);state.requests++;
      const pages=[newest];
      // One bounded historic page per poll to build a 35-day history.
      const cursor=prior.backfill_cursor||(!prior.backfill_complete&&newest.length===25?newest.at(-1)?.txid:'');
      if(cursor&&/^[0-9a-fA-F]{64}$/.test(cursor)){
        pages.push(await this.fetchPage(a.address,cursor));state.requests++;
      }
      const unique=new Map();
      for(const page of pages)for(const tx of page){
        if(/^[a-fA-F0-9]{64}$/.test(String(tx?.txid||''))&&tx.status?.confirmed)unique.set(tx.txid,tx);
      }
      const events=[...unique.values()].map(tx=>decodeBtcAddressFlow(tx,a.address,a.label)).filter(Boolean);
      // Only retain the last 35 days; old rows are part of historical coverage metadata.
      const keep=events.filter(e=>e.ts>=now-35*86400000);
      let accepted=0;
      for(let i=0;i<keep.length;i+=90){
        const batch=keep.slice(i,i+90);
        const res=await this.env.MARKET_EVENT_HUB.getByName('BTCUSDT').fetch(new Request('https://hub/ingest',{
          method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({symbol:'BTCUSDT',events:batch})}));
        if(!res.ok)throw Error('whale_hub_http_'+res.status);
        const result=await res.json();accepted+=Number(result.accepted||0);
      }
      prior.label=a.label;prior.checked_ms=now;prior.observed=(prior.observed||0)+accepted;
      // Historic pagination ends when the last page has <25 rows or older than 35 days.
      const lastPage=pages.at(-1),oldest=lastPage.at(-1);
      prior.backfill_complete=lastPage.length<25||
        (Number(oldest?.status?.block_time||0)*1000<now-35*86400000);
      prior.backfill_cursor=prior.backfill_complete?null:oldest?.txid||null;
      // There may be >25 newly confirmed transactions between polls.
      prior.gap_possible=Boolean(prior.head&&newest.length===25&&!newest.some(tx=>tx.txid===prior.head));
      prior.head=newest[0]?.txid||prior.head||null;
      prior.error=null;state.addresses[a.address]=prior;
      state.accepted+=accepted;state.last_success_ms=now;state.error=null;
      await this.ctx.storage.put('state',state);
      return {ok:true,address_suffix:a.address.slice(-8),watchlist_source:mode,
        accepted,observed_events:keep.length,backfill_complete:prior.backfill_complete,
        gap_possible:prior.gap_possible};
    }catch(error){
      state.errors++;state.error=String(error?.message||error||'unknown').replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,90);
      await this.ctx.storage.put('state',state);
      return {ok:false,error:state.error,watchlist_source:state.watchlist_source};
    }
  }
}

export class MarketLiveCollector extends DurableObject{
  constructor(ctx,env){
    super(ctx,env);
    this.ctx=ctx;this.env=env;
    this.streams=new Map();this.pending=new Map();this.flushRunning=false;
    this.lastSample=new Map();this.lastCandleSent=new Map();this.retryAt={gate:0,bybit:0,binance:0};
    this.metrics={gate:{state:'idle',last_received_ms:0,packets:0,restarts:0,error:null},
      bybit:{state:'idle',last_received_ms:0,packets:0,restarts:0,error:null},
      binance:{state:'idle',last_received_ms:0,packets:0,restarts:0,error:null},
      pending:0,accepted:0,rejected:0,flush_errors:0,last_flush_ms:0,
      preview_sent:0,preview_errors:0,last_preview_ms:0,
      coverage:'only_observed_messages;past_disconnects_not_backfilled'};
  }
  safeStatus(){
    const now=Date.now(),feeds={};
    for(const kind of ['gate','bybit','binance']){
      const m=this.metrics[kind];
      feeds[kind]={enabled:kind!=='binance'||BINANCE_LIQ_ENABLED(this.env),state:m.state,last_received_ms:m.last_received_ms,age_seconds:m.last_received_ms?Math.round((now-m.last_received_ms)/1000):null,
        packets:m.packets,restarts:m.restarts,error:m.error,
        connected:Boolean(this.streams.get(kind)?.readyState===1)};
    }
    return {ok:true,enabled:LIVE_ENABLED(this.env),feeds,buffered:this.metrics.pending,
      accepted:this.metrics.accepted,rejected:this.metrics.rejected,flush_errors:this.metrics.flush_errors,
      preview_sent:this.metrics.preview_sent,preview_errors:this.metrics.preview_errors,last_preview_ms:this.metrics.last_preview_ms,
      last_flush_ms:this.metrics.last_flush_ms,coverage:this.metrics.coverage,
      sink:'MarketEventHub_R2_archive',order_execution:false,ts:new Date(now).toISOString()};
  }
  async fetch(request){
    const path=new URL(request.url).pathname;
    if(path==='/status')return hubReply(this.safeStatus());
    if(path==='/ensure'){
      if(!LIVE_ENABLED(this.env))return hubReply({...this.safeStatus(),reason:'auto_live_stream_disabled'});
      await this.ensure();
      return hubReply(this.safeStatus());
    }
    if(path==='/stop'){
      for(const ws of this.streams.values())try{ws.close(1000,'collector disabled')}catch{}
      this.streams.clear();
      return hubReply({ok:true,stopped:true});
    }
    return hubReply({ok:false,error:'not_found'},404);
  }
  async ensure(){
    if(!LIVE_ENABLED(this.env))return;
    if(!BINANCE_LIQ_ENABLED(this.env)&&this.streams.has('binance')){
      try{this.streams.get('binance')?.close(1000,'optional source disabled')}catch{}
      this.streams.delete('binance');this.metrics.binance.state='disabled';
    }
    for(const source of ['gate','bybit',...(BINANCE_LIQ_ENABLED(this.env)?['binance']:[]) ]){
      const sock=this.streams.get(source);
      if(sock&&(sock.readyState===0||sock.readyState===1))continue;
      if(Date.now()<this.retryAt[source])continue;
      this.connect(source);
    }
    if(await this.ctx.storage.getAlarm()===null)await this.ctx.storage.setAlarm(Date.now()+5000);
  }
  connect(source){
    const url=source==='gate'?'wss://fx-ws.gateio.ws/v4/ws/usdt':
      source==='bybit'?'wss://stream.bybit.com/v5/public/linear':
      'wss://fstream.binance.com/market/ws/!forceOrder@arr';
    this.metrics[source].state='connecting';
    let ws;
    try{ws=new WebSocket(url)}catch(error){this.disconnected(source,'connect_failed');return;}
    this.streams.set(source,ws);
    ws.addEventListener('open',()=>{
      if(this.streams.get(source)!==ws)return;
      this.metrics[source].state='connected';this.metrics[source].error=null;
      try{
        if(source==='gate'){
          const time=Math.floor(Date.now()/1000);
          for(const channel of ['futures.trades','futures.tickers'])
            ws.send(JSON.stringify({time,channel,event:'subscribe',payload:LIVE_GATE_CONTRACTS}));
          // Gate publishes in-progress futures OHLCV; do not mark these candles confirmed.
          for(const tf of Object.keys(LIVE_CANDLE_INTERVALS)){
            for(const contract of LIVE_GATE_CONTRACTS){
              ws.send(JSON.stringify({time,channel:'futures.candlesticks',
                event:'subscribe',payload:[tf,contract]}));
            }
          }
        }else if(source==='bybit')
          ws.send(JSON.stringify({op:'subscribe',args:LIVE_SYMBOLS.map(s=>'allLiquidation.'+s)}));
        // Binance raw !forceOrder@arr stream is subscribed by URI; no app SUBSCRIBE/ping.
      }catch(error){this.disconnected(source,'subscribe_failed');}
    });
    ws.addEventListener('message',message=>{
      if(this.streams.get(source)!==ws||typeof message.data!=='string'||message.data.length>250000)return;
      this.metrics[source].last_received_ms=Date.now();this.metrics[source].packets++;
      try{
        const raw=JSON.parse(message.data),items=source==='gate'?decodeGatePublic(raw):source==='bybit'?decodeBybitLiquidations(raw):decodeBinanceLiquidations(raw);
        if(items.length)this.ctx.waitUntil(this.ingestItems(items));
        if(source==='gate'){
          const previews=decodeGateCandles(raw);
          if(previews.length)this.ctx.waitUntil(this.publishCandles(previews));
        }
      }catch(error){this.metrics[source].error='malformed_exchange_message';}
    });
    ws.addEventListener('close',()=>{if(this.streams.get(source)===ws)this.disconnected(source,'exchange_closed')});
    ws.addEventListener('error',()=>{if(this.streams.get(source)===ws)this.disconnected(source,'exchange_websocket_error')});
  }
  disconnected(source,reason){
    const ws=this.streams.get(source);if(ws){this.streams.delete(source);try{ws.close()}catch{}}
    const m=this.metrics[source];m.state='reconnecting';m.restarts++;m.error=reason;
    this.retryAt[source]=Date.now()+Math.min(60000,2000*Math.pow(2,Math.min(m.restarts,5)));
  }

  async publishCandles(items){
    const accepted=[],now=Date.now();
    for(const candle of items){
      const id=candle.symbol+':'+candle.interval_min;
      const prev=this.lastCandleSent.get(id);
      if(prev&&candle.open_ms<prev.open_ms)continue;
      // Limit fan-out overhead without pretending to capture every exchange tick.
      if(prev&&candle.open_ms===prev.open_ms&&now-prev.time<12000)continue;
      this.lastCandleSent.set(id,{time:now,open_ms:candle.open_ms});
      accepted.push(candle);
    }
    const groups=new Map();
    for(const item of accepted){
      if(!groups.has(item.symbol))groups.set(item.symbol,[]);
      groups.get(item.symbol).push(item);
    }
    for(const [symbol,group] of groups){
      try{
        const response=await this.env.MARKET_EVENT_HUB.getByName(symbol).fetch(
          new Request('https://hub/publish',{
            method:'POST',headers:{'content-type':'application/json'},
            body:JSON.stringify({symbol,previews:group})}));
        if(!response.ok)throw Error('preview_sink_unavailable');
        this.metrics.preview_sent+=group.length;
        this.metrics.last_preview_ms=Date.now();
      }catch(error){
        this.metrics.preview_errors++;
      }
    }
  }

  async ingestItems(items){
    for(const item of items){
      // No exchange secrets or account metadata; all events publicly observed.
      if(item.kind==='liquidation')item.id=item.source==='binance'?await binanceLiquidationId(item):await liveLiquidationId(item);
      else{
        const previous=this.lastSample.get(item.kind+':'+item.symbol)||0;
        const minDelay=item.kind==='trade'?1000:2000;
        if(item.ts-previous<minDelay)continue;
        this.lastSample.set(item.kind+':'+item.symbol,item.ts);
      }
      if(!this.pending.has(item.symbol))this.pending.set(item.symbol,[]);
      const batch=this.pending.get(item.symbol);
      if(batch.length>=1000){this.metrics.rejected++;continue;}
      batch.push(item);this.metrics.pending++;
    }
    if(this.metrics.pending>=20||items.some(x=>x.kind==='liquidation'))await this.flush();
  }
  async flush(){
    if(this.flushRunning||!this.metrics.pending)return;
    this.flushRunning=true;
    try{
      for(const [symbol,queue] of this.pending){
        if(!queue.length)continue;
        const batch=queue.splice(0,Math.min(100,queue.length));
        try{
          const reply=await this.env.MARKET_EVENT_HUB.getByName(symbol).fetch(new Request('https://hub/ingest',{
            method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({symbol,events:batch})}));
          if(!reply.ok)throw Error('sink_http_'+reply.status);
          const result=await reply.json();
          this.metrics.accepted+=Number(result.accepted||0);this.metrics.rejected+=Number(result.invalid||0);
          this.metrics.pending-=batch.length;
        }catch(error){
          queue.unshift(...batch);this.metrics.flush_errors++;
          this.metrics.last_error='event_sink_unavailable';
        }
      }
      this.metrics.last_flush_ms=Date.now();
    }finally{this.flushRunning=false;}
  }
  async alarm(){
    if(!LIVE_ENABLED(this.env))return;
    const now=Date.now();
    for(const source of ['gate','bybit',...(BINANCE_LIQ_ENABLED(this.env)?['binance']:[])]){
      const m=this.metrics[source],ws=this.streams.get(source);
      if(ws?.readyState===1){
        if(m.last_received_ms&&now-m.last_received_ms>(source==='binance'?600000:90000)){
          this.disconnected(source,'feed_stale_reconnect');continue;
        }
        // Explicit source heartbeat. Gate expects futures.ping; Bybit expects op ping.
        try{
          if(source==='gate')ws.send(JSON.stringify({time:Math.floor(now/1000),channel:'futures.ping'}));
          if(source==='bybit')ws.send('{"op":"ping"}');
          // Binance responds to WebSocket control PING internally; no text ping route.
        }
        catch{this.disconnected(source,'heartbeat_failed')}
      }
    }
    await this.flush();
    await this.ensure();
    await this.ctx.storage.setAlarm(Date.now()+10000);
  }
}

// Durable hourly rollups. Observed-only (NOT complete market activity).
// Old events still present in the 14-day SQL hot index are backfilled in
// bounded chunks. Immutable R2 batches older than the hot index require a
// separate offline import and are not silently counted.

/**
 * Cloudflare Market Hub v1.3.1: read-only bounded 6-hour continuity evidence.
 * Source observations are sparse and never represent 100% exchange coverage.
 * R2 proofs read actual JSONL objects, rather than inferring successful writes
 * from list metadata, WordPress counters or the 14-day hot index.
 */
const CONTINUITY_HOURS=6;
const CONTINUITY_KINDS=['liquidation','whale_transfer'];
function continuityTimeBucket(now,index){
  return Math.floor(now/3600000)*3600000-(CONTINUITY_HOURS-1-index)*3600000;
}
function continuityHourPath(t){
  return new Date(t).toISOString().slice(0,13).replaceAll('-','/');
}
async function continuityR2Proof(env,now=Date.now()){
  const kinds={};
  if(!env.MARKET_DATA||typeof env.MARKET_DATA.list!=='function'){
    const kinds=Object.fromEntries(CONTINUITY_KINDS.map(kind=>[kind,{
      archive_kind:kind,lookback_hours:CONTINUITY_HOURS,hours_with_object:0,
      sample_verified:false,verified_records:0,last_observed_hour_unix:null,
      reason:'r2_binding_missing'
    }]));
    return {ok:false,reason:'r2_binding_missing',lookback_hours:CONTINUITY_HOURS,
      list_checks:0,list_errors:0,kinds,completeness_proven:false};
  }
  const entries=CONTINUITY_KINDS.flatMap(kind=>Array.from({length:CONTINUITY_HOURS},(_,i)=>
    ({kind,hour_ms:continuityTimeBucket(now,i),
      prefix:'market-hub/events/'+kind+'/'+continuityHourPath(continuityTimeBucket(now,i))+'/'})));
  const listings=await Promise.all(entries.map(async entry=>{
    try{
      const list=await env.MARKET_DATA.list({prefix:entry.prefix,limit:1});
      const object=list?.objects?.[0];
      if(!object)return {...entry,object:null,error:null};
      if(typeof object.key!=='string'||!object.key.startsWith(entry.prefix)||
         !object.key.endsWith('.jsonl')||!Number.isSafeInteger(object.size)||object.size<1)
        throw Error('r2_list_invalid');
      return {...entry,object:{key:object.key,size:object.size},error:null};
    }catch{return {...entry,object:null,error:'r2_list_failed'}}
  }));
  for(const kind of CONTINUITY_KINDS){
    const entriesForKind=listings.filter(x=>x.kind===kind);
    const recent=entriesForKind.filter(x=>x.object).sort((a,b)=>b.hour_ms-a.hour_ms);
    const report={archive_kind:kind,lookback_hours:CONTINUITY_HOURS,
      hours_with_object:recent.length,sample_verified:false,
      verified_records:0,last_observed_hour_unix:recent[0]?Math.floor(recent[0].hour_ms/1000):null,
      reason:recent.length?'unverified':'no_recent_archived_observation'};
    if(recent.length){
      const selected=recent[0];
      if(selected.object.size>400000){report.reason='r2_sample_oversize';}
      else{
        try{
          const object=await env.MARKET_DATA.get(selected.object.key);
          if(!object)throw Error('r2_read_missing');
          const blob=await object.text();
          if(!blob||blob.length>400000)throw Error('r2_read_size');
          const lines=blob.trim().split('\n');
          if(lines.length<1||lines.length>300)throw Error('r2_record_count');
          for(const line of lines){
            const e=JSON.parse(line);
            if(e?.kind!==kind||!HUB_ORIGINS.includes(e?.source)||
               !HUB_SYMBOLS.includes(e?.symbol)||!Number.isSafeInteger(e?.ts)||
               e.ts<now-366*86400000||e.ts>now+120000||
               typeof e.id!=='string'||!/^[A-Za-z0-9:_-]{8,128}$/.test(e.id))
              throw Error('r2_record_schema');
          }
          report.sample_verified=true;
          report.verified_records=lines.length;
          report.reason='sample_read_and_schema_verified';
        }catch{report.reason='r2_sample_invalid_or_unreadable'}
      }
    }
    kinds[kind]=report;
  }
  return {ok:listings.every(x=>!x.error),lookback_hours:CONTINUITY_HOURS,
    list_checks:listings.length,list_errors:listings.filter(x=>x.error).length,
    kinds,completeness_proven:false};
}
function continuityFeedSummary(name,feed,enabled){
  const received=Number(feed?.last_received_ms);
  const age=feed?.age_seconds===null||feed?.age_seconds===undefined?null:Number(feed.age_seconds);
  const packets=Number(feed?.packets);
  return {source:name,enabled:enabled===true,connected:feed?.connected===true,
    last_received_unix:Number.isSafeInteger(received)&&received>0?Math.floor(received/1000):null,
    age_seconds:Number.isSafeInteger(age)&&age>=0?age:null,
    packets:Number.isSafeInteger(packets)&&packets>=0?packets:0,
    note:'No packets can be normal for sparse liquidation sources'};
}


/** LUMEX Market Hub 1.3.1: one bounded operational readiness assessment.
 * Completeness is never inferred from silent market periods. No side effects.
 */

/** 1.3.1: single PRO ticket read combining existing public-only Cloudflare data.
 * Does not manufacture risk scores, cross-provider totals or customer trade signals.
 */
const TERMINAL_SYMBOLS=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT'];
const termUnavailable=(source,reason='not_collected')=>({
  status:'unavailable',source,as_of_unix:null,reason,values:null
});
function termValidNumber(x,min=-Infinity,max=Infinity){
  if(x===null||x===undefined||x===''||typeof x==='boolean')return null;
  const n=Number(x);return Number.isFinite(n)&&n>=min&&n<=max?n:null;
}
function termSection(source,asof,ttl,values,now){
  const stamp=termValidNumber(asof,1500000000,4102444800);
  if(stamp===null||!Number.isSafeInteger(stamp)||!values||typeof values!=='object')
    return termUnavailable(source,'invalid_or_missing_source');
  const age=Math.floor(now/1000)-stamp;
  if(age<-120)return termUnavailable(source,'future_timestamp');
  return {status:age>ttl?'delayed':'fresh',source,as_of_unix:stamp,
    age_seconds:Math.max(0,age),values};
}
export async function marketTerminalSummary(env,symbol,now=Date.now()){
  if(!TERMINAL_SYMBOLS.includes(symbol))throw Error('terminal_invalid_symbol');
  const coin=symbol.slice(0,-4);
  const tasks=await Promise.allSettled([
    hubGetCandles(env,symbol,15,80),
    opsReadR2(env,PUBLIC_PULSE_KEY),
    opsReadR2(env,OI_PREFIX+'latest/'+coin+'-7.json'),
    readDerivatives(env,symbol),
    env.MARKET_EVENT_HUB?
      env.MARKET_EVENT_HUB.getByName(symbol)
        .fetch('https://hub/insights?symbol='+symbol+'&window=24h')
        .then(async r=>r.ok?await r.json():null):Promise.resolve(null)
  ]);
  const result=tasks.map(x=>x.status==='fulfilled'?x.value:null);
  const [candles,pulse,oi,gate,events]=result;
  const sections={
    candles:termUnavailable('cloudflare_r2_closed_candles'),
    pulse:termUnavailable('bybit_tickers_ratio_binance_taker_alternative_me'),
    oi:termUnavailable('bybit_or_binance_source_matched_oi'),
    gate:termUnavailable('gateio_usdt_perpetual'),
    observations:termUnavailable('source_separated_public_observed_events')
  };
  if(candles?.symbol===symbol&&candles?.data_quality==='verified'&&
     candles?.feed_mode==='cloudflare_r2_verified_closed_candles'&&
     candles?.orders_enabled===false&&Array.isArray(candles.candles)&&candles.candles.length>=51){
    const last=candles.candles.at(-1),trend=hubTrend(candles.candles),
      asof=Math.floor((last.t+900000)/1000);
    if(termValidNumber(last.c,0.00000001,1e10)!==null&&trend.status==='ok')
      sections.candles=termSection('cloudflare_r2_closed_15m',asof,45*60,
        {last_closed_price:last.c,trend:trend.trend,atr_pct:trend.atr_pct,
          last_closed_open_ms:last.t,interval_minutes:15},now);
  }
  if(pulse?.schema==='lumex_public_pulse_v1'&&pulse?.order_execution===false){
    const q=pulse.feeds?.tickers?.data?.quotes?.[symbol],
      ticker=pulse.feeds?.tickers,
      ratio=pulse.feeds?.ratios?.[coin],taker=pulse.feeds?.takers?.[coin];
    const checkedAt=Math.floor(now/1000);
    const usableTime=(v,maxAge)=>{
      const t=termValidNumber(v,1500000000,4102444800);
      return t!==null&&Number.isSafeInteger(t)&&t<=checkedAt+120&&checkedAt-t<=maxAge?t:null;
    };
    const qAt=usableTime(ticker?.sampled_unix,1800),
      rAt=usableTime(ratio?.sampled_unix,2400),
      tAt=usableTime(taker?.sampled_unix,2400);
    const price=termValidNumber(q?.last,0.00000001,1e10),
      change=termValidNumber(q?.change_24h_pct,-100,10000),
      long=termValidNumber(ratio?.data?.long_pct,0,100),
      short=termValidNumber(ratio?.data?.short_pct,0,100),
      buy=termValidNumber(taker?.data?.buy_pct,0,100),
      sell=termValidNumber(taker?.data?.sell_pct,0,100);
    const tickerOk=qAt!==null&&ticker?.source==='bybit_v5_linear'&&
      price!==null&&change!==null;
    const ratioOk=rAt!==null&&ratio?.symbol===symbol&&
      ratio?.source==='bybit_v5_account_ratio'&&long!==null&&short!==null&&
      Math.abs(long+short-100)<=2;
    const takerBaseOk=tAt!==null&&taker?.symbol===symbol&&buy!==null&&sell!==null&&
      Math.abs(buy+sell-100)<=2;
    const binanceTakerOk=takerBaseOk&&taker?.source==='binance_futures_taker_volume';
    const gateTakerOk=takerBaseOk&&
      taker?.source==='gateio_futures_contract_stats_taker_size'&&
      taker?.data?.exchange==='Gate'&&
      taker?.data?.scope==='gateio_futures_contract_stats_closed_5m'&&
      taker?.data?.volume_unit==='gate_futures_contracts';
    const takerOk=binanceTakerOk||gateTakerOk;
    const sourceTimes=[tickerOk?qAt:null,ratioOk?rAt:null,takerOk?tAt:null]
      .filter(x=>x!==null);
    if(sourceTimes.length){
      sections.pulse=termSection('bybit_tickers_accounts_and_optional_binance_taker',
        Math.max(...sourceTimes),900,{
          bybit_price:tickerOk?price:null,
          change_24h_pct:tickerOk?change:null,
          bybit_accounts_long_pct:ratioOk?long:null,
          bybit_accounts_short_pct:ratioOk?short:null,
          binance_taker_buy_pct:binanceTakerOk?buy:null,
          binance_taker_sell_pct:binanceTakerOk?sell:null,
          gate_taker_buy_pct:gateTakerOk?buy:null,
          gate_taker_sell_pct:gateTakerOk?sell:null,
          gate_liquidation_long_usdt:gateTakerOk?
            termValidNumber(taker?.data?.liquidation?.long_usdt,0,1e18):null,
          gate_liquidation_short_usdt:gateTakerOk?
            termValidNumber(taker?.data?.liquidation?.short_usdt,0,1e18):null,
          gate_liquidation_window_minutes:gateTakerOk?
            termValidNumber(taker?.data?.liquidation?.period_minutes,5,60):null,
          taker_exchange:binanceTakerOk?'Binance':gateTakerOk?'Gate':null,
          taker_source_window_minutes:takerOk?
            termValidNumber(taker?.data?.period_minutes,5,60):null,
          source_status:{bybit_ticker:tickerOk?'available':'unavailable',
            bybit_account_ratio:ratioOk?'available':'unavailable',
            binance_taker:binanceTakerOk?'available':'unavailable',
            gate_taker:gateTakerOk?'available':'unavailable'},
          fng_value:(usableTime(pulse.feeds?.sentiment?.sampled_unix,86400)!==null&&
            pulse.feeds?.sentiment?.source==='alternative_me_fng')
            ?termValidNumber(pulse.feeds?.sentiment?.data?.value,0,100):null,
          sentiment_source:'alternative_me_daily'
        },now);
    }
  }

  if(oi?.schema==='lumex_oi_mirror_v1'&&oi?.pair===symbol&&oi?.days===7&&
     ['Bybit','Binance','Gate'].includes(oi.exchange)&&oi?.order_execution===false&&
     oi?.source_scope==='single_exchange_public_oi_only'&&
     Array.isArray(oi.history)&&oi.history.length>=48){
    const latest=termValidNumber(oi.oi_usd,0,1e18),mark=termValidNumber(oi.price,0,1e10);
    if(latest!==null&&mark!==null)
      sections.oi=termSection(oi.exchange.toLowerCase()+'_single_exchange_open_interest',
        oi.sample_unix,7200,{notional_usdt:latest,mark_price:mark,
          exchange:oi.exchange,history_points:oi.history.length},now);
  }
  if(gate?.schema==='lumex_derivatives_v1'&&gate?.symbol===symbol&&
     gate?.scope==='single_public_exchange_not_global'&&
     gate?.order_execution===false){
    const snapshot=termValidNumber(gate.snapshot_ms,1500000000000,4102444800000);
    const mark=termValidNumber(gate.price?.mark_price,0.00000001,1e10);
    if(mark!==null&&snapshot!==null)
      sections.gate=termSection('gateio_perpetual_derivatives',
        Math.floor(snapshot/1000),900,{
          mark_price:mark,
          funding_rate_pct:termValidNumber(gate.price?.funding_rate_pct,-100,100),
          open_interest_usdt:termValidNumber(gate.open_interest?.open_interest_usdt,0,1e18),
          oi_change_1h_pct:termValidNumber(gate.oi_change_1h_pct,-1000,1000),
          next_funding_ms:termValidNumber(gate.funding_schedule?.next_funding_ms,0,4102444800000)
        },now);
  }
  if(events?.ok===true&&events.symbol===symbol&&events.window==='24h'&&
     events.scope==='observed_public_events_only'&&events.market_total_estimate===false&&
     events.rollup?.up_to_date===true&&events.rollup?.pending_hot_events===0){
    const liq=termValidNumber(events.captures?.liquidations?.events,0,10000000),
      bin=termValidNumber(events.captures?.binance_liquidation_snapshots?.events,0,10000000),
      whale=termValidNumber(events.captures?.btc_address_net?.events,0,10000000);
    const last=termValidNumber(events.last_observed_ms,1500000000000,4102444800000);
    if(liq!==null&&bin!==null&&whale!==null){
      // Section freshness is the rollup generation time, not last trade/event
      // time. Quiet market periods must never be labelled a stream outage.
      const generatedMs=Date.parse(String(events.generated_at||''));
      if(Number.isSafeInteger(generatedMs)&&generatedMs>0)
      sections.observations=termSection('bybit_liquidation_vs_binance_sampled_plus_btc_watchlist',
        Math.floor(generatedMs/1000),300,{
          bybit_liquidation_events_24h:liq,
          binance_liquidation_snapshots_24h:env.AUTO_BINANCE_LIQUIDATIONS==='true'?bin:null,
          binance_stream_enabled:env.AUTO_BINANCE_LIQUIDATIONS==='true',
          btc_watchlist_address_flows_24h:symbol==='BTCUSDT'?whale:null,
          observations_partial:true,source_gap_possible:true,
          last_observed_ms:last,
          zero_means_no_observation:true
        },now);
    }
  }
  const available=Object.values(sections).filter(x=>x.status!=='unavailable').length;
  const fresh=Object.values(sections).filter(x=>x.status==='fresh').length;
  return {ok:true,schema:'lumex_pro_market_terminal_v1',symbol,
    generated_unix:Math.floor(now/1000),
    scope:'source_separated_public_market_observations_only',
    trading_enabled:false,orders_enabled:false,market_total_estimate:false,
    sections,quality:{available,fresh,total:5,all_sources_fresh:available===5&&fresh===5},
    disclaimer:'Bybit 계정비율, Binance 체결비율, Gate OI, 거래소별 청산 표본은 각기 다른 모집단입니다. 값의 합산이나 자동매매 신호 생성에 사용하지 않습니다.'};
}

const OPS_PREFIX='market-hub/ops/v1/';
const OPS_COINS=['BTC','ETH','SOL','XRP'];
function opsVerdict(id,enabled,healthy,ageSeconds=null,detail=''){
  return {id,enabled:enabled===true,healthy:healthy===true,
    age_seconds:Number.isSafeInteger(ageSeconds)&&ageSeconds>=0?ageSeconds:null,
    reason:String(detail).replace(/[^A-Za-z0-9_-]/g,'_').slice(0,70)};
}
async function opsReadR2(env,key){
  if(!env.MARKET_DATA)return null;
  try{const object=await env.MARKET_DATA.get(key);
      if(!object)return null;
      return await object.json();}catch{return null}
}
export async function marketOpsReadiness(env,now=Date.now()){
  const seconds=Math.floor(now/1000);
  const liveJob=env.MARKET_LIVE_COLLECTOR?
    env.MARKET_LIVE_COLLECTOR.getByName('public-linear').fetch('https://collector/status')
      .then(r=>r.ok?r.json():null).catch(()=>null):Promise.resolve(null);
  const whalesJob=env.BTC_RESERVE_COLLECTOR?
    env.BTC_RESERVE_COLLECTOR.getByName('reserve-btc').fetch('https://whales/status')
      .then(r=>r.ok?r.json():null).catch(()=>null):Promise.resolve(null);
  const candlesJob=Promise.all(OPS_COINS.map(async coin=>{
    try{
      const payload=await hubGetCandles(env,coin+'USDT',15,50);
      return {coin,ok:payload?.data_quality==='verified'&&payload?.stale===false};
    }catch{return {coin,ok:false};}
  }));
  const oiJob=Promise.all(OPS_COINS.flatMap(coin=>[7,30].map(async days=>{
    const x=await opsReadR2(env,'market-hub/oi/v1/latest/'+coin+'-'+days+'.json');
    const at=Number(x?.sample_unix);
    return {coin,days,ok:x?.schema==='lumex_oi_mirror_v1'&&
      x?.pair===coin+'USDT'&&x?.days===days&&
      ['Bybit','Binance','Gate'].includes(x?.exchange)&&Array.isArray(x?.history)&&
      x.history.length>=40&&Number.isSafeInteger(at)&&at<=seconds+120&&seconds-at<7200};
  })));
  const [pulse,derivative,live,whale,oi,candles,continuity]=await Promise.all([
    opsReadR2(env,'market-hub/public-pulse/v1/latest.json'),
    opsReadR2(env,'market-hub/derivatives/v1/status.json'),
    liveJob,whalesJob,oiJob,candlesJob,continuityR2Proof(env,now)]);
  const pulseAt=pulse?.collected_at_unix===undefined?null:Number(pulse.collected_at_unix),
    derAt=derivative?.collected_ms===undefined?null:Number(derivative.collected_ms);
  const enabled={
    candles:true,
    pulse:env.AUTO_PUBLIC_PULSE_FETCH==='true',
    oi:env.AUTO_OI_MIRROR_FETCH==='true',
    derivatives:env.AUTO_DERIVATIVES_FETCH==='true',
    live:env.AUTO_LIVE_STREAM==='true',
    binance:env.AUTO_LIVE_STREAM==='true'&&env.AUTO_BINANCE_LIQUIDATIONS==='true',
    whales:env.AUTO_WHALE_FETCH==='true',
    archives:!!env.MARKET_DATA
  };
  const pulseReady=pulse?.schema==='lumex_public_pulse_v1'&&
    Number.isSafeInteger(pulseAt)&&pulseAt<=seconds+120&&seconds-pulseAt<1200&&
    OPS_COINS.every(c=>pulse?.feeds?.tickers?.data?.quotes?.[c+'USDT']&&
      pulse?.feeds?.ratios?.[c]&&pulse?.feeds?.takers?.[c])&&
      pulse?.feeds?.sentiment;
  const derivReady=Number.isSafeInteger(derAt)&&derAt<=now+120000&&
    now-derAt<1200000&&Array.isArray(derivative?.items)&&
    OPS_COINS.every(c=>derivative.items.some(x=>x.symbol===c+'USDT'&&x.ok===true));
  const whaleAt=Number(whale?.last_success_ms),whaleReady=whale?.enabled===true&&
    whale?.source==='wordpress_configured'&&Number.isSafeInteger(whaleAt)&&
    whaleAt<=now+120000&&now-whaleAt<7200000&&
    Array.isArray(whale.watchlist)&&!whale.watchlist.some(x=>x.gap_possible===true);
  const check=[
    opsVerdict('r2_verified_candles_4',true,candles.every(x=>x.ok),null,
      candles.every(x=>x.ok)?'verified_four_assets':'missing_or_stale_candle'),
    opsVerdict('public_pulse_10_sources',enabled.pulse,Boolean(pulseReady),
      Number.isSafeInteger(pulseAt)&&pulseAt>0?Math.max(0,seconds-pulseAt):null,
      pulseReady?'source_attributed':'pulse_missing_or_stale'),
    opsVerdict('source_matched_oi_8',enabled.oi,oi.every(x=>x.ok),null,
      oi.every(x=>x.ok)?'eight_slots_verified':'oi_history_missing_or_stale'),
    opsVerdict('gate_derivatives_4',enabled.derivatives,Boolean(derivReady),
      Number.isSafeInteger(derAt)&&derAt>0?Math.max(0,Math.floor((now-derAt)/1000)):null,
      derivReady?'observed_gate_funding_oi':'derivatives_missing_or_stale'),
    opsVerdict('live_bybit_gate',enabled.live,
      live?.enabled===true&&live?.feeds?.bybit?.connected===true&&
        live?.feeds?.gate?.connected===true,null,
      live?.enabled===true?'connection_state_checked':'stream_disabled'),
    opsVerdict('binance_liquidation_snapshots',enabled.binance,
      enabled.binance&&live?.feeds?.binance?.connected===true,null,
      'sampled_1s_not_complete_capture'),
    opsVerdict('btc_confirmed_watchlist',enabled.whales,Boolean(whaleReady),
      Number.isSafeInteger(whaleAt)&&whaleAt>0?Math.max(0,Math.floor((now-whaleAt)/1000)):null,
      whaleReady?'wordpress_addresses_confirmed':'watchlist_stale_gap_or_disabled'),
    opsVerdict('r2_public_event_readback',enabled.archives,
      continuity.ok===true&&continuity.list_errors===0&&
      continuity.kinds?.liquidation?.sample_verified===true,null,
      continuity.kinds?.liquidation?.sample_verified===true?
        'bounded_liquidation_jsonl_verified':'no_recent_r2_readback_proof')
  ];
  const enabledChecks=check.filter(x=>x.enabled);
  const good=enabledChecks.filter(x=>x.healthy).length;
  return {ok:true,schema:'lumex_market_ops_readiness_v1',worker_version:'1.3.1',
    checked_unix:seconds,scope:'public_market_only',trading_enabled:false,
    checks:check,passed:good,enabled_checks:enabledChecks.length,
    missing_or_unready:check.filter(x=>!x.enabled||!x.healthy).map(x=>x.id),
    r2_summary:{list_checks:continuity.list_checks,list_errors:continuity.list_errors,
      liquidation_sample_verified:continuity.kinds?.liquidation?.sample_verified===true,
      whale_sample_verified:continuity.kinds?.whale_transfer?.sample_verified===true},
    release_ready:check.every(x=>x.enabled&&x.healthy),
    complete_market_capture:false,archive_merged:false,
    safe_to_disable_wordpress_crons:false,
    manual_rollout_required:true};
}
export async function marketOpsDaily(env,now=Date.now()){
  if(env.AUTO_MARKET_QA_DAILY!=='true'||!env.MARKET_DATA)
    return {ok:false,disabled:true};
  const date=new Date(now).toISOString().slice(0,10);
  const key=OPS_PREFIX+'daily/'+date.replaceAll('-','')+'.json';
  const existing=await env.MARKET_DATA.head(key);
  if(existing)return {ok:true,already_saved:true,date};
  const readiness=await marketOpsReadiness(env,now);
  const doc={schema:'lumex_ops_daily_v1',date,observed_at_unix:readiness.checked_unix,
    passed:readiness.passed,enabled_checks:readiness.enabled_checks,
    ready:readiness.release_ready,
    check_status:readiness.checks.map(x=>({id:x.id,enabled:x.enabled,healthy:x.healthy})),
    r2_list_errors:readiness.r2_summary.list_errors,
    liquidation_r2_sample_verified:readiness.r2_summary.liquidation_sample_verified,
    complete_market_capture:false,archive_merged:false,
    safe_to_disable_wordpress_crons:false};
  const serialized=JSON.stringify(doc);
  if(serialized.length>20000)throw Error('ops_daily_record_oversize');
  await env.MARKET_DATA.put(key,serialized,{httpMetadata:{contentType:'application/json'}});
  const proof=await env.MARKET_DATA.get(key);
  if(!proof||await proof.text()!==serialized)throw Error('ops_daily_r2_readback_failed');
  await env.MARKET_DATA.put(OPS_PREFIX+'latest.json',serialized,
    {httpMetadata:{contentType:'application/json'}});
  return {ok:true,saved:true,date};
}
export async function marketOpsHistory(env,now=Date.now()){
  const dates=Array.from({length:7},(_,i)=>{
    const d=new Date(now-(6-i)*86400000);
    return d.toISOString().slice(0,10);
  });
  const results=await Promise.all(dates.map(async date=>{
    const x=await opsReadR2(env,OPS_PREFIX+'daily/'+date.replaceAll('-','')+'.json');
    if(x?.schema!=='lumex_ops_daily_v1'||x?.date!==date||
       !Number.isSafeInteger(x.passed)||!Number.isSafeInteger(x.enabled_checks)||
       typeof x.ready!=='boolean'||typeof x.liquidation_r2_sample_verified!=='boolean')
      return {date,status:'missing'};
    return {date,status:'recorded',passed:x.passed,enabled_checks:x.enabled_checks,
      ready:x.ready,r2_liquidation_verified:x.liquidation_r2_sample_verified,
      r2_list_errors:Number.isSafeInteger(x.r2_list_errors)?x.r2_list_errors:null};
  }));
  return {ok:true,schema:'lumex_market_ops_history_v1',days:7,items:results,
    incomplete_days:results.filter(x=>x.status==='missing').length,
    safe_to_disable_wordpress_crons:false};
}

const HUB_HOUR_MS=3600000;
const HUB_WINDOWS=Object.freeze({'1h':1,'24h':24,'7d':168,'14d':336,'30d':720});
function insightWindow(name){return HUB_WINDOWS[name]||null}
export function summarizeObservedRollups(rows,symbol,windowName='24h',now=Date.now()){
  const hours=insightWindow(windowName);
  if(!hours)throw Error('unsupported_insight_window');
  const start=Math.floor((now-hours*HUB_HOUR_MS)/HUB_HOUR_MS)*HUB_HOUR_MS;
  const buckets=new Map(),groups=new Map();
  let count=0,liquidation=0,binanceLiquidation=0,trade=0,whale=0,ticker=0,inBtc=0,outBtc=0;
  let lastObserved=0,firstObserved=Infinity;
  for(const row of rows){
    const bucket=Number(row.bucket),n=Number(row.events),qty=Number(row.quantity);
    if(!Number.isSafeInteger(bucket)||bucket<start||bucket>now||
      !Number.isSafeInteger(n)||n<0||!Number.isFinite(qty)||qty<0)continue;
    const kind=String(row.kind),source=String(row.source),side=String(row.side);
    if(!HUB_KINDS.includes(kind)||!HUB_ORIGINS.includes(source))continue;
    count+=n;lastObserved=Math.max(lastObserved,Number(row.last_ts)||bucket);
    firstObserved=Math.min(firstObserved,Number(row.first_ts)||bucket);
    if(kind==='liquidation'){
      if(source==='binance')binanceLiquidation+=n;
      else if(source==='bybit')liquidation+=n;
    }
    if(kind==='trade')trade+=n;
    if(kind==='whale_transfer'){
      whale+=n;
      if(side==='in')inBtc+=qty;
      if(side==='out')outBtc+=qty;
    }
    if(kind==='ticker')ticker+=n;
    const key=kind+':'+source+':'+side;
    const g=groups.get(key)||{kind,source,side,events:0,native_quantity:0};
    g.events+=n;g.native_quantity+=qty;groups.set(key,g);
    const b=buckets.get(bucket)||{hour_ms:bucket,liquidation:0,binance_liquidation_sampled:0,whale_transfer:0,trade_sample:0,ticker_sample:0};
    const k=kind==='trade'?'trade_sample':kind==='ticker'?'ticker_sample':kind;
    if(kind==='liquidation'&&source==='binance')b.binance_liquidation_sampled+=n;
    else b[k]+=n;buckets.set(bucket,b);
  }
  const round=v=>Number(v.toFixed(8));
  return {
    ok:true,symbol,window:windowName,scope:'observed_public_events_only',
    coverage:'partial_public_sources;no_backfill_for_disconnects',
    market_total_estimate:false,source_filters:['bybit_liquidations','binance_sampled_1s_liquidation_snapshots','gate_sampled_futures','btc_confirmed_watchlist'],
    captures:{liquidations:{events:liquidation,source:'bybit_public_allLiquidation',price_type:'bankruptcy_price',order_side_not_position_side:true},
      binance_liquidation_snapshots:{events:binanceLiquidation,sampling:'latest_per_symbol_per_1000ms',
        source:'binance_usdm_forceOrder',price_type:'avg_execution_price',scope:'incomplete_snapshots_not_market_total'},
      trades:{events:trade,sampling:'per_symbol_1s_max',source:'gateio_futures'},
      tickers:{events:ticker,sampling:'per_symbol_2s_max'},
      btc_address_net:{events:whale,in_btc:round(inBtc),out_btc:round(outBtc),
        net_btc:round(inBtc-outBtc),source:'confirmed_public_btc_watchlist_only'}},
    observed_events:count,first_observed_ms:firstObserved===Infinity?null:firstObserved,
    last_observed_ms:lastObserved||null,
    by_source:Array.from(groups.values()).map(v=>({...v,native_quantity:round(v.native_quantity)}))
      .sort((a,b)=>b.events-a.events),
    hourly:Array.from(buckets.values()).sort((a,b)=>a.hour_ms-b.hour_ms),
    generated_at:new Date(now).toISOString(),trading_enabled:false,
    note:'기존 Bybit 청산 지표는 Bybit만 집계. Binance는 1초 스냅샷 표본을 별도 보관하며 전체 체결/청산액이 아닙니다. 고래는 공개 BTC 관측 주소만입니다.'
  };
}

export class MarketEventHub extends DurableObject{
  constructor(ctx,env){
    super(ctx,env);
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS hub_events(id TEXT PRIMARY KEY,kind TEXT NOT NULL,source TEXT NOT NULL,ts INTEGER NOT NULL,payload TEXT NOT NULL,archived INTEGER NOT NULL DEFAULT 0)");
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS hub_events_time ON hub_events(ts DESC)");
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS hub_events_kind_time ON hub_events(kind,ts DESC)");
    const columns=this.ctx.storage.sql.exec("PRAGMA table_info(hub_events)").toArray();
    if(!columns.some(col=>col.name==='rollup_done'))
      this.ctx.storage.sql.exec("ALTER TABLE hub_events ADD COLUMN rollup_done INTEGER NOT NULL DEFAULT 0");
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS hub_events_rollup_pending ON hub_events(rollup_done,ts)");
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS hub_hourly(bucket INTEGER NOT NULL,kind TEXT NOT NULL,source TEXT NOT NULL,side TEXT NOT NULL,events INTEGER NOT NULL,quantity REAL NOT NULL,first_ts INTEGER NOT NULL,last_ts INTEGER NOT NULL,PRIMARY KEY(bucket,kind,source,side))");
  }
  async fetch(request){
    const u=new URL(request.url);
    if(u.pathname==='/ws'){
      if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return hubReply({ok:false,error:'websocket_required'},426);
      const pair=new WebSocketPair();const [client,server]=Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({started:Date.now()});
      server.send(JSON.stringify({type:'hello',scope:'observed_market_events_and_provisional_candles',as_of_utc:new Date().toISOString()}));
      return new Response(null,{status:101,webSocket:client});
    }

    // In-progress exchange candles are broadcast to entitled subscribers only.
    // They MUST NOT enter the research-grade R2 ledger or historical SQL index.
    if(u.pathname==='/publish'&&request.method==='POST'){
      let body;try{body=await request.json()}catch{return hubReply({ok:false,error:'bad_json'},400)}
      const symbol=body?.symbol,previews=body?.previews;
      if(!HUB_SYMBOLS.includes(symbol)||!Array.isArray(previews)||previews.length>30)
        return hubReply({ok:false,error:'invalid_preview_batch'},400);
      const now=Date.now();let sent=0;
      const peers=this.ctx.getWebSockets();
      for(const ev of previews){
        const [t,o,h,l,c,v]=[ev?.open_ms,ev?.o,ev?.h,ev?.l,ev?.c,ev?.v].map(Number);
        const frame=Number(ev?.interval_min);
        if(ev?.kind!=='provisional_kline'||ev.symbol!==symbol||
           ev.source!=='gateio'||ev.confirmed!==false||!HUB_FRAMES.includes(frame)||
           !Number.isSafeInteger(t)||t<now-3*86400000||t>now+frame*60000||
           t%(frame*60000)!==0||![o,h,l,c,v].every(Number.isFinite)||
           o<=0||c<=0||l<=0||h<Math.max(o,c,l)||l>Math.min(o,c)||v<0)continue;
        const safe={kind:'provisional_kline',symbol,interval_min:frame,open_ms:t,
          o,h,l,c,v,source:'gateio',confirmed:false,received_ms:now,
          price_type:'gateio_futures_candle',capture:'public_stream_provisional'};
        const packet=JSON.stringify({type:'provisional_kline',data:safe});
        for(const ws of peers){try{ws.send(packet)}catch{}}
        sent++;
      }
      return hubReply({ok:true,broadcast:sent,clients:peers.length,
        stored:false,scope:'provisional_only'});
    }

    if(u.pathname==='/ingest'&&request.method==='POST'){
      const body=await request.json(),now=Date.now(),accepted=[],invalid=[];
      if(!Array.isArray(body.events)||body.events.length>100||body.events.length<1)return hubReply({ok:false,error:'invalid_batch'},400);
      for(const item of body.events){
        const event=hubValidateEvent(item,body.symbol,now);
        if(!event){invalid.push('invalid_event');continue;}
        const found=this.ctx.storage.sql.exec('SELECT id FROM hub_events WHERE id=?',event.id).toArray();
        if(found.length)continue;
        this.ctx.storage.sql.exec('INSERT INTO hub_events(id,kind,source,ts,payload,archived) VALUES (?,?,?,?,?,0)',
          event.id,event.kind,event.source,event.ts,JSON.stringify(event));
        accepted.push(event);
      }
      if(accepted.length){
        const peers=this.ctx.getWebSockets();
        for(const ev of accepted){
          const frame=JSON.stringify({type:'observation',data:ev});
          for(const ws of peers){try{ws.send(frame);}catch{}}
        }
        const scheduled=await this.ctx.storage.getAlarm();
        if(scheduled===null)await this.ctx.storage.setAlarm(Date.now()+15000);
      }
      return hubReply({ok:true,accepted:accepted.length,invalid:invalid.length,
        archive:'pending_r2_flush',observed_at_utc:new Date().toISOString()});
    }

    // Read-only, hot-index-only samples. These are PUBLIC provider packets,
    // not native exchange IDs or evidence of full capture / no gaps.
    if(u.pathname==='/source-continuity'&&request.method==='GET'){
      const now=Date.now(),start=continuityTimeBucket(now,0),end=continuityTimeBucket(now,5);
      const symbol=String(u.searchParams.get('symbol')||'');
      if(!HUB_SYMBOLS.includes(symbol))return hubReply({ok:false,error:'invalid_symbol'},400);
      const records=this.ctx.storage.sql.exec(
        'SELECT bucket,kind,source,events FROM hub_hourly WHERE bucket>=? AND bucket<=? ORDER BY bucket ASC LIMIT 251',
        start,end).toArray();
      if(records.length>250)return hubReply({ok:false,error:'continuity_rollup_overflow'},503);
      const pending=this.ctx.storage.sql.exec(
        'SELECT COUNT(*) AS n FROM hub_events WHERE rollup_done=0').toArray();
      const awaiting=this.ctx.storage.sql.exec(
        'SELECT COUNT(*) AS n FROM hub_events WHERE archived=0 AND ts>=?',start).toArray();
      const pendingRollup=Number(pending?.[0]?.n||0),pendingArchive=Number(awaiting?.[0]?.n||0);
      if(!Number.isSafeInteger(pendingRollup)||pendingRollup<0||
         !Number.isSafeInteger(pendingArchive)||pendingArchive<0)
        return hubReply({ok:false,error:'continuity_pending_invalid'},503);
      const hourly=Array.from({length:CONTINUITY_HOURS},(_,i)=>({
        hour_ms:continuityTimeBucket(now,i),bybit_liquidation:0,
        binance_liquidation_sampled:0,gate_trade_sampled:0,btc_watchlist_flow:0}));
      for(const r of records){
        const hour=Number(r.bucket),n=Number(r.events),i=hourly.findIndex(x=>x.hour_ms===hour);
        if(i<0||!Number.isSafeInteger(n)||n<0||n>10000000)continue;
        if(r.kind==='liquidation'&&r.source==='bybit')hourly[i].bybit_liquidation+=n;
        if(r.kind==='liquidation'&&r.source==='binance')hourly[i].binance_liquidation_sampled+=n;
        if(r.kind==='trade'&&r.source==='gateio')hourly[i].gate_trade_sampled+=n;
        if(symbol==='BTCUSDT'&&r.kind==='whale_transfer'&&r.source==='blockstream')
          hourly[i].btc_watchlist_flow+=n;
      }
      return hubReply({ok:true,schema:'lumex_source_continuity_v1',symbol,
        window_hours:CONTINUITY_HOURS,hourly,pending_rollup:pendingRollup,
        pending_archive:pendingArchive,observed_only:true,complete_market_capture:false});
    }
    if(u.pathname==='/audit-identities'&&request.method==='GET'){
      const cutoff=Date.now()-86400000,limit=101;
      const liq=this.ctx.storage.sql.exec(
        "SELECT payload FROM hub_events WHERE kind='liquidation' AND source='bybit' AND ts>=? ORDER BY ts DESC LIMIT ?",cutoff,limit).toArray();
      const symbol=String(u.searchParams.get('symbol')||'');
      const valid=liq.slice(0,100).map(r=>{
        const e=JSON.parse(r.payload);
        return {id:e.id,ts:e.ts,price:e.price,quantity:e.quantity,
          position_side:e.position_side,price_type:e.price_type,capture:e.capture};
      }).filter(e=>typeof e.id==='string'&&e.id.startsWith('bybit:liq:'+symbol+':')&&
        Number.isSafeInteger(e.ts)&&Number.isFinite(e.price)&&Number.isFinite(e.quantity)&&
        e.price>0&&e.quantity>0&&['long','short'].includes(e.position_side)&&
        e.price_type==='bankruptcy_price'&&e.capture==='public_stream');
      let whales=[],whaleTruncated=false;
      if(symbol==='BTCUSDT'){
        const rows=this.ctx.storage.sql.exec(
          "SELECT payload FROM hub_events WHERE kind='whale_transfer' AND source='blockstream' AND ts>=? ORDER BY ts DESC LIMIT ?",cutoff,limit).toArray();
        whaleTruncated=rows.length>100;
        whales=rows.slice(0,100).map(row=>{
          const e=JSON.parse(row.payload);
          return {txhash:e.txhash,ts:e.ts,side:e.side,quantity:e.quantity};
        }).filter(e=>/^[a-f0-9]{64}$/.test(e.txhash)&&['in','out'].includes(e.side)&&
          Number.isSafeInteger(e.ts)&&Number.isFinite(e.quantity)&&e.quantity>0);
      }
      return hubReply({ok:true,schema:'lumex_identity_sample_v1',symbol,window_seconds:86400,
        liquidations:valid,liquidations_truncated:liq.length>100,
        whales,whales_truncated:whaleTruncated,live_source:'hot_durable_object_index',
        historical_r2_reimported:false,order_execution:false});
    }

    if(u.pathname==='/insights'&&request.method==='GET'){
      const windowName=String(u.searchParams.get('window')||'24h');
      const hours=insightWindow(windowName);
      if(!hours)return hubReply({ok:false,error:'invalid_window'},400);
      const now=Date.now(),start=Math.floor((now-hours*HUB_HOUR_MS)/HUB_HOUR_MS)*HUB_HOUR_MS;
      const rows=this.ctx.storage.sql.exec(
        'SELECT bucket,kind,source,side,events,quantity,first_ts,last_ts FROM hub_hourly WHERE bucket>=? ORDER BY bucket ASC LIMIT 16000',start).toArray();
      const remaining=this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM hub_events WHERE rollup_done=0').toArray();
      const pending=Number(remaining[0]?.n||0);
      const symbol=String(u.searchParams.get('symbol')||'');
      const out=summarizeObservedRollups(rows,symbol,windowName,now);
      out.rollup={up_to_date:pending===0,pending_hot_events:pending,
        source:'durable_object_sqlite_hourly',older_r2_archive_reimported:false};
      out.history_restriction='only_available_hot_index_backfill_plus_new_events';
      return hubReply(out);
    }

    if(u.pathname==='/events'){
      const limit=Math.max(1,Math.min(100,Number(u.searchParams.get('limit')||40))),
        kind=String(u.searchParams.get('kind')||'');
      if(kind&&!HUB_KINDS.includes(kind))return hubReply({ok:false,error:'invalid_kind'},400);
      const cutoff=Date.now()-14*86400000;
      const rows=kind?
        this.ctx.storage.sql.exec('SELECT payload FROM hub_events WHERE kind=? AND ts>=? ORDER BY ts DESC LIMIT ?',kind,cutoff,limit).toArray():
        this.ctx.storage.sql.exec('SELECT payload FROM hub_events WHERE ts>=? ORDER BY ts DESC LIMIT ?',cutoff,limit).toArray();
      return hubReply({ok:true,events:rows.map(r=>JSON.parse(r.payload)),scope:'observed_only',
        hot_retention_days:14,archive:'R2_immutable_batches'});
    }
    return hubReply({ok:false,error:'not_found'},404);
  }
  async alarm(){
    const moreRollup=this.rollupPending();
    const rows=this.ctx.storage.sql.exec('SELECT id,kind,source,ts,payload FROM hub_events WHERE archived=0 ORDER BY ts ASC LIMIT 300').toArray();
    if(rows.length){
      const group=new Map();
      for(const r of rows){
        const date=new Date(r.ts),key=r.kind+'/'+date.toISOString().slice(0,13).replaceAll('-','/');
        if(!group.has(key))group.set(key,[]);
        group.get(key).push(r);
      }
      try{
        for(const [prefix,batch] of group){
          const key='market-hub/events/'+prefix+'/'+Date.now()+'-'+crypto.randomUUID()+'.jsonl';
          await this.env.MARKET_DATA.put(key,batch.map(r=>r.payload).join('\n')+'\n',{
            httpMetadata:{contentType:'application/x-ndjson'}});
          for(const r of batch)this.ctx.storage.sql.exec('UPDATE hub_events SET archived=1 WHERE id=?',r.id);
        }
        // Only hot index expires; immutable R2 event batches retain historical evidence.
        this.ctx.storage.sql.exec('DELETE FROM hub_events WHERE archived=1 AND rollup_done=1 AND ts<?',Date.now()-14*86400000);
      }catch(e){console.error('market_hub_archive_error',safeError(e));}
    }
    const pending=this.ctx.storage.sql.exec('SELECT id FROM hub_events WHERE archived=0 OR rollup_done=0 LIMIT 1').toArray();
    if(pending.length||moreRollup)await this.ctx.storage.setAlarm(Date.now()+30000);
  }

  rollupPending(){
    const rows=this.ctx.storage.sql.exec(
      'SELECT id,ts,kind,source,payload FROM hub_events WHERE rollup_done=0 ORDER BY ts ASC LIMIT 500').toArray();
    if(!rows.length)return false;
    const groups=new Map();
    for(const row of rows){
      let payload;
      try{payload=JSON.parse(row.payload)}catch{payload={}}
      const bucket=Math.floor(Number(row.ts)/HUB_HOUR_MS)*HUB_HOUR_MS;
      const side=['buy','sell','in','out'].includes(payload.side)?payload.side:'unknown';
      const key=[bucket,row.kind,row.source,side].join('|');
      const group=groups.get(key)||{bucket,kind:row.kind,source:row.source,side,
        count:0,quantity:0,first_ts:Number(row.ts),last_ts:Number(row.ts)};
      group.count++;
      const quantity=Number(payload.quantity);
      if(Number.isFinite(quantity)&&quantity>=0)group.quantity+=quantity;
      group.first_ts=Math.min(group.first_ts,Number(row.ts));
      group.last_ts=Math.max(group.last_ts,Number(row.ts));
      groups.set(key,group);
    }
    const persist=()=>{
      for(const g of groups.values()){
        this.ctx.storage.sql.exec(
          'INSERT INTO hub_hourly(bucket,kind,source,side,events,quantity,first_ts,last_ts) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(bucket,kind,source,side) DO UPDATE SET events=events+excluded.events,quantity=quantity+excluded.quantity,first_ts=MIN(first_ts,excluded.first_ts),last_ts=MAX(last_ts,excluded.last_ts)',
          g.bucket,g.kind,g.source,g.side,g.count,g.quantity,g.first_ts,g.last_ts);
      }
      for(const row of rows)this.ctx.storage.sql.exec('UPDATE hub_events SET rollup_done=1 WHERE id=?',row.id);
    };
    if(typeof this.ctx.storage.transactionSync==='function')
      this.ctx.storage.transactionSync(persist);
    else persist();
    return rows.length===500;
  }

  webSocketMessage(ws,data){
    if(data==='ping')ws.send('pong');
  }
}
async function hubRoute(request,env){
  const u=new URL(request.url),path=u.pathname,method=request.method;
  if(path==='/market-hub/v1/oi-health'&&method==='GET'){
    try{const obj=await env.MARKET_DATA?.get(OI_PREFIX+'health.json');
      return hubReply({ok:true,enabled:env.AUTO_OI_MIRROR_FETCH==='true',report:obj?await obj.json():null});
    }catch{return hubReply({ok:false,error:'oi_health_unavailable'},503)}
  }
  if(path==='/market-hub/v1/oi-preflight'&&method==='GET'){
    if(!hubAuthorized(request,env))return hubReply({ok:false,error:'unauthorized'},401);
    const slots=[];
    try{
      for(const coin of OI_COINS)for(const days of OI_INTERVALS){
        const object=await env.MARKET_DATA?.get(OI_PREFIX+'latest/'+coin+'-'+days+'.json');
        if(!object){slots.push({coin,days,ok:false,error:'missing'});continue;}
        const record=await object.json();
        if(record?.schema!=='lumex_oi_mirror_v1'||record?.coin!==coin||
          record?.days!==days||record?.order_execution!==false){
          slots.push({coin,days,ok:false,error:'invalid_schema'});continue;
        }
        slots.push({coin,days,ok:true,record});
      }
      return hubReply({ok:slots.every(x=>x.ok),schema:'lumex_oi_preflight_v1',
        slots,order_execution:false});
    }catch{return hubReply({ok:false,error:'oi_preflight_unavailable'},503)}
  }
  if(path==='/market-hub/v1/oi-history'&&method==='GET'){
    if(!hubAuthorized(request,env))return hubReply({ok:false,error:'unauthorized'},401);
    const symbol=u.searchParams.get('symbol'),days=u.searchParams.get('days');
    if(!OI_COINS.some(c=>symbol===c+'USDT')||!['7','30'].includes(days))
      return hubReply({ok:false,error:'invalid_oi_query'},400);
    try{const key=OI_PREFIX+'latest/'+symbol.slice(0,-4)+'-'+days+'.json';
      const obj=await env.MARKET_DATA?.get(key);
      if(!obj)return hubReply({ok:false,error:'oi_snapshot_unavailable'},503);
      const x=await obj.json();
      if(x?.schema!=='lumex_oi_mirror_v1'||x?.pair!==symbol||String(x.days)!==days||
        x?.order_execution!==false||x?.source_scope!=='single_exchange_public_oi_only')
        return hubReply({ok:false,error:'oi_snapshot_invalid'},503);
      return hubReply(x);
    }catch{return hubReply({ok:false,error:'oi_history_unavailable'},503)}
  }
  if(path==='/market-hub/v1/public-pulse-health'&&method==='GET'){
    try{const x=await env.MARKET_DATA?.get(PUBLIC_PULSE_HEALTH);
      return hubReply({ok:true,enabled:env.AUTO_PUBLIC_PULSE_FETCH==='true',report:x?await x.json():null,order_execution:false});}
    catch{return hubReply({ok:false,error:'public_pulse_health_unavailable'},503)}
  }
  if(path==='/market-hub/v1/public-pulse'&&method==='GET'){
    if(!hubAuthorized(request,env))return hubReply({ok:false,error:'unauthorized'},401);
    try{const x=await env.MARKET_DATA?.get(PUBLIC_PULSE_KEY);
      if(!x)return hubReply({ok:false,error:'snapshot_unavailable'},503);
      const data=await x.json();
      if(data?.schema!=='lumex_public_pulse_v1'||data?.order_execution!==false)return hubReply({ok:false,error:'invalid_snapshot'},503);
      return hubReply(data);
    }catch{return hubReply({ok:false,error:'pulse_read_unavailable'},503)}
  }
  // Strictly admin/service Bearer, read-only. No cross-exchange ledger merge.
  if(path==='/market-hub/v1/watchlist-parity'&&method==='GET'){
    if(!hubAuthorized(request,env))return hubReply({ok:false,error:'unauthorized'},401);
    if(!env.BTC_RESERVE_COLLECTOR)return hubReply({ok:false,error:'whale_binding_missing'},503);
    try{return await env.BTC_RESERVE_COLLECTOR.getByName('reserve-btc').fetch('https://whales/watchlist-parity')}
    catch{return hubReply({ok:false,error:'whale_watchlist_unavailable'},503)}
  }
    if(path==='/market-hub/v1/release-readiness'&&method==='GET'){
    if(!hubAuthorized(request,env))return hubReply({ok:false,error:'unauthorized'},401);
    try{return hubReply(await marketOpsReadiness(env));}
    catch{return hubReply({ok:false,error:'release_readiness_unavailable'},503);}
  }
  if(path==='/market-hub/v1/quality-history'&&method==='GET'){
    if(!hubAuthorized(request,env))return hubReply({ok:false,error:'unauthorized'},401);
    try{return hubReply(await marketOpsHistory(env));}
    catch{return hubReply({ok:false,error:'quality_history_unavailable'},503);}
  }
  if(path==='/market-hub/v1/terminal'&&method==='GET'){
    const symbol=hubName(u.searchParams.get('symbol'));
    if(!symbol)return hubReply({ok:false,error:'unsupported_symbol'},400);
    if(!hubAuthorized(request,env)&&!(await hubCheckTicket(request,env,symbol)))
      return hubReply({ok:false,error:'unauthorized'},401);
    try{
      const result=await marketTerminalSummary(env,symbol);
      return new Response(JSON.stringify(result),{status:200,headers:{
        'content-type':'application/json; charset=utf-8','cache-control':'no-store',
        'access-control-allow-origin':'https://lumexbot.com','vary':'Origin',
        'x-content-type-options':'nosniff'}});
    }catch{return hubReply({ok:false,error:'terminal_unavailable'},503);}
  }
  if(path==='/market-hub/v1/continuity-audit'&&method==='GET'){
    if(!hubAuthorized(request,env))return hubReply({ok:false,error:'unauthorized'},401);
    const now=Date.now(),symbols=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT'];
    if(!env.MARKET_EVENT_HUB)return hubReply({ok:false,error:'hub_binding_missing'},503);
    const requests=symbols.map(async symbol=>{
      try{
        const response=await env.MARKET_EVENT_HUB.getByName(symbol).fetch(
          new Request('https://hub/source-continuity?symbol='+symbol));
        if(!response.ok)throw Error('hot_index_http_'+response.status);
        const value=await response.json();
        if(value?.ok!==true||value?.schema!=='lumex_source_continuity_v1'||
           value?.symbol!==symbol||!Array.isArray(value.hourly)||value.hourly.length!==6)
          throw Error('hot_index_schema');
        return value;
      }catch{return {ok:false,symbol,reason:'hot_index_unavailable'};}
    });
    const [symbolsData,r2,live,whale]=await Promise.all([
      Promise.all(requests),continuityR2Proof(env,now),
      env.MARKET_LIVE_COLLECTOR?.getByName('public-linear').fetch('https://collector/status')
        .then(r=>r.ok?r.json():null).catch(()=>null)??Promise.resolve(null),
      env.BTC_RESERVE_COLLECTOR?.getByName('reserve-btc').fetch('https://whales/status')
        .then(r=>r.ok?r.json():null).catch(()=>null)??Promise.resolve(null)]);
    const feeds={};
    for(const name of ['gate','bybit','binance']){
      feeds[name]=continuityFeedSummary(name,live?.feeds?.[name],
        name==='binance'?live?.feeds?.binance?.enabled===true:live?.enabled===true);
    }
    const success=Number(whale?.last_success_ms),age=Number.isSafeInteger(success)&&success>0?
      Math.max(0,Math.floor((now-success)/1000)):null;
    return hubReply({ok:true,schema:'lumex_continuity_audit_v1',
      as_of_unix:Math.floor(now/1000),window_hours:CONTINUITY_HOURS,
      observed_only:true,complete_market_capture:false,
      archive_merged:false,safe_to_disable_wordpress_crons:false,
      symbols:symbolsData,r2,feeds,
      whale:{enabled:whale?.enabled===true,watchlist_source:whale?.source||'unknown',
        last_success_age_seconds:age,gap_possible:Array.isArray(whale?.watchlist)?
        whale.watchlist.some(x=>x.gap_possible===true):null},
      source_disclaimer:'Missing hour means no verified observed packet, not a proven market-data outage. R2 proofs only validate one bounded stored JSONL sample per event kind, not whole-day completeness.'});
  }
  if(path==='/market-hub/v1/collector-audit'&&method==='GET'){
    if(!hubAuthorized(request,env))return hubReply({ok:false,error:'unauthorized'},401);
    if(!env.MARKET_EVENT_HUB)return hubReply({ok:false,error:'hub_binding_missing'},503);
    const names=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT'];
    const output=await Promise.all(names.map(async symbol=>{
      try{
        const response=await env.MARKET_EVENT_HUB.getByName(symbol).fetch(
          new Request('https://hub/insights?symbol='+symbol+'&window=24h'));
        if(!response.ok)throw Error('rollup_http_'+response.status);
        const json=await response.json();
        if(json?.ok!==true||json?.symbol!==symbol||json?.window!=='24h'||
           json?.scope!=='observed_public_events_only'||json?.market_total_estimate!==false||
           !Array.isArray(json?.by_source)||!json?.rollup)
          throw Error('invalid_rollup');
        const count=(kind,origin)=>json.by_source
          .filter(x=>x?.kind===kind&&x?.source===origin)
          .reduce((n,x)=>{
            const v=Number(x.events);
            return n+(Number.isSafeInteger(v)&&v>=0&&v<=10000000?v:0);
          },0);
        const pending=Number(json.rollup.pending_hot_events);
        if(!Number.isSafeInteger(pending)||pending<0||pending>10000000)
          throw Error('invalid_rollup_pending');
        return {symbol,ok:true,
          bybit_liquidations_24h:count('liquidation','bybit'),
          btc_watchlist_flows_24h:symbol==='BTCUSDT'?count('whale_transfer','blockstream'):0,
          rollup_up_to_date:json.rollup.up_to_date===true&&pending===0,
          pending_hot_events:pending};
      }catch(error){
        return {symbol,ok:false,bybit_liquidations_24h:0,btc_watchlist_flows_24h:0,
          rollup_up_to_date:false,pending_hot_events:0,
          error:String(error?.message||'unavailable').replace(/[^A-Za-z0-9_-]/g,'_').slice(0,55)};
      }
    }));
    return hubReply({ok:output.every(x=>x.ok),schema:'lumex_collector_audit_v1',
      coverage:'bybit_liquidations_and_confirmed_btc_watchlist_only',
      observed_only:true,archive_merged:false,safe_to_disable_wordpress_crons:false,
      as_of_unix:Math.floor(Date.now()/1000),items:output,
      caution:'WP Binance liquidation and WP whale fingerprints have different capture scope. Do not add, dedupe, or decommission based on counts alone.'});
  }
  // Administrative, Bearer-only bounded samples for WordPress SHA256/TXID audit.
  // No customer/order records and no ledger writes. Four DO hot-index queries max.
  if(path==='/market-hub/v1/identity-audit'&&method==='GET'){
    if(!hubAuthorized(request,env))return hubReply({ok:false,error:'unauthorized'},401);
    if(!env.MARKET_EVENT_HUB)return hubReply({ok:false,error:'hub_binding_missing'},503);
    const symbols=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT'];
    const items=await Promise.all(symbols.map(async symbol=>{
      try{
        const result=await env.MARKET_EVENT_HUB.getByName(symbol).fetch(
          new Request('https://hub/audit-identities?symbol='+symbol));
        if(!result.ok)throw Error('sample_http_'+result.status);
        const body=await result.text();
        if(body.length>75000||body.length<2)throw Error('sample_size');
        const x=JSON.parse(body);
        if(x?.ok!==true||x?.schema!=='lumex_identity_sample_v1'||x?.symbol!==symbol||
           x?.window_seconds!==86400||!Array.isArray(x.liquidations)||
           x.liquidations.length>100||!Array.isArray(x.whales)||x.whales.length>100||
           typeof x.liquidations_truncated!=='boolean'||typeof x.whales_truncated!=='boolean')
          throw Error('sample_schema');
        return {symbol,ok:true,liquidations:x.liquidations,
          liquidations_truncated:x.liquidations_truncated,
          whales:symbol==='BTCUSDT'?x.whales:[],
          whales_truncated:symbol==='BTCUSDT'?x.whales_truncated:false};
      }catch(e){
        return {symbol,ok:false,liquidations:[],liquidations_truncated:false,
          whales:[],whales_truncated:false,
          error:String(e?.message||'sample_unavailable').replace(/[^A-Za-z0-9_-]/g,'_').slice(0,55)};
      }
    }));
    return hubReply({ok:items.every(x=>x.ok),schema:'lumex_identity_audit_v1',
      as_of_unix:Math.floor(Date.now()/1000),window_seconds:86400,
      native_bybit_event_id_available:false,
      wp_liquidation_match_method:'v089_payload_sha256_from_raw_public_packet',
      btc_whale_match_method:'txid_overlap_only_not_flow_equivalence',
      archive_merged:false,safe_to_disable_wordpress_crons:false,
      source_coverage:'Bybit_liquidations_and_confirmed_BTC_address_only',
      items});
  }
  if(path==='/market-hub/v1/health'&&method==='GET')return hubReply({ok:true,service:'LUMEX Market Hub',
    version:'1.3.1',capabilities:['verified_candles','radar','observed_event_journal','authorized_websocket','public_stream_observer','btc_confirmed_address_flows','provisional_gate_futures_candles','observed_hourly_insights','funding_open_interest_snapshots','legacy_wp_public_market_backfill','public_source_attributed_pulse_r2','source_matched_oi_r2_mirror','read_only_source_coverage_audit','bounded_identity_match_audit','binance_usdm_forceOrder_sampled','btc_watchlist_set_parity','bounded_r2_readback_continuity_audit','market_ops_release_readiness','r2_daily_quality_history','pro_source_separated_terminal'],
    market_data_scope:'verified_closed_candles',live_exchange_ingestor:LIVE_ENABLED(env)?'enabled_check_live_health':'disabled',
    trade_capture:'sampled',liquidation_capture:'public_bybit_only',order_execution:false});
  if(path==='/market-hub/v1/legacy-backfill-health'&&method==='GET'){
    if(!env.BTC_RESERVE_COLLECTOR)return hubReply({ok:false,error:'backfill_binding_missing'},503);
    try{return await env.BTC_RESERVE_COLLECTOR.getByName('reserve-btc').fetch('https://whales/backfill-status')}
    catch{return hubReply({ok:false,error:'backfill_status_unavailable'},503)}
  }
  if(path==='/market-hub/v1/derivatives-health'&&method==='GET'){
    try{
      const record=await env.MARKET_DATA.get(DERIV_PREFIX+'status.json');
      const report=record?await record.json():null;
      return hubReply({ok:true,enabled:env.AUTO_DERIVATIVES_FETCH==='true',
        report,scope:'gateio_public_derivatives',orders_enabled:false});
    }catch{return hubReply({ok:false,error:'derivatives_health_unavailable'},503)}
  }
  if((path==='/market-hub/v1/derivatives'||path==='/market-hub/v1/derivatives-history')&&method==='GET'){
    const symbol=hubName(u.searchParams.get('symbol'));
    if(!symbol)return hubReply({ok:false,error:'unsupported_symbol'},400);
    if(!hubAuthorized(request,env)&&!(await hubCheckTicket(request,env,symbol)))
      return hubReply({ok:false,error:'unauthorized'},401);
    const period=u.searchParams.get('window')||'24h';
    if(path.endsWith('-history')&&!DERIV_WINDOWS[period])return hubReply({ok:false,error:'invalid_window'},400);
    try{
      const value=path.endsWith('-history')?await derivativesHistory(env,symbol,period):await readDerivatives(env,symbol);
      if(!value)return hubReply({ok:false,error:'snapshot_unavailable'},503);
      return new Response(JSON.stringify(value),{status:200,headers:{
        'content-type':'application/json','cache-control':'no-store',
        'access-control-allow-origin':'https://lumexbot.com','vary':'Origin'}});
    }catch{return hubReply({ok:false,error:'derivatives_read_unavailable'},503)}
  }
  if(path==='/market-hub/v1/live-health'&&method==='GET'){
    if(!LIVE_ENABLED(env))return hubReply({ok:true,enabled:false,reason:'collector_disabled',order_execution:false});
    if(!env.MARKET_LIVE_COLLECTOR)return hubReply({ok:false,error:'live_collector_binding_missing'},503);
    try{return await env.MARKET_LIVE_COLLECTOR.getByName('public-linear').fetch('https://collector/status')}
    catch(error){return hubReply({ok:false,error:'live_collector_status_unavailable'},503)}
  }
  if(path==='/market-hub/v1/whale-health'&&method==='GET'){
    if(!env.BTC_RESERVE_COLLECTOR)return hubReply({ok:false,error:'whale_collector_binding_missing'},503);
    try{return await env.BTC_RESERVE_COLLECTOR.getByName('reserve-btc').fetch('https://whales/status')}
    catch(error){return hubReply({ok:false,error:'whale_collector_unavailable'},503)}
  }
  if(path==='/market-hub/v1/archive-health'&&method==='GET'){
    try{
      const rows=await env.MARKET_DATA.list({prefix:'market-hub/events/',limit:25});
      const objects=(rows?.objects||[]);
      return hubReply({ok:true,objects_sampled:objects.length,truncated:!!rows?.truncated,
        most_recent_modified_ms:objects.reduce((v,x)=>Math.max(v,Date.parse(x.uploaded)||0),0),
        archive:'immutable_r2_jsonl',sample_not_total:true,order_execution:false});
    }catch(error){return hubReply({ok:false,error:'archive_unavailable'},503)}
  }
  if(path==='/market-hub/v1/radar'&&method==='GET'){
    if(!hubAuthorized(request,env))return hubReply({ok:false,error:'unauthorized'},401);
    try{return hubReply(await hubRadar(env))}
    catch(e){return hubReply({ok:false,error:safeError(e)},503)}
  }
  const symbol=hubName(u.searchParams.get('symbol'));
  if(!symbol)return hubReply({ok:false,error:'unsupported_symbol'},400);
  if(path==='/market-hub/v1/ws'&&method==='GET'){
    if(!(await hubCheckTicket(request,env,symbol)))return hubReply({ok:false,error:'invalid_session_ticket'},401);
    if(!env.MARKET_EVENT_HUB)return hubReply({ok:false,error:'hub_binding_missing'},503);
    return env.MARKET_EVENT_HUB.getByName(symbol).fetch(new Request('https://hub/ws',{
      headers:{Upgrade:'websocket'}}));
  }
  // PRO browser reads the hourly rollup directly using the existing 90s
  // WordPress HMAC ticket. No PHP or MySQL work on each insights refresh.
  if(path==='/market-hub/v1/insights'&&method==='GET'){
    if(!hubAuthorized(request,env)&&!(await hubCheckTicket(request,env,symbol)))
      return hubReply({ok:false,error:'unauthorized'},401);
    const windowName=u.searchParams.get('window')||'24h';
    if(!insightWindow(windowName))return hubReply({ok:false,error:'invalid_window'},400);
    if(!env.MARKET_EVENT_HUB)return hubReply({ok:false,error:'hub_binding_missing'},503);
    const upstream=await env.MARKET_EVENT_HUB.getByName(symbol).fetch(
      new Request('https://hub/insights?symbol='+symbol+'&window='+windowName));
    // Fixed origin and no credentials. Ticket cannot authorize other endpoints.
    const headers=new Headers(upstream.headers);
    headers.set('access-control-allow-origin','https://lumexbot.com');
    headers.set('vary','Origin');
    headers.set('cache-control','no-store');
    return new Response(upstream.body,{status:upstream.status,headers});
  }
  if(path==='/market-hub/v1/ingest'&&method==='POST'){
    if(!hubIngestAuthorized(request,env))return hubReply({ok:false,error:'unauthorized'},401);
    const body=await request.text();
    if(body.length>120000)return hubReply({ok:false,error:'payload_too_large'},413);
    let json;try{json=JSON.parse(body)}catch{return hubReply({ok:false,error:'bad_json'},400)}
    if(!Array.isArray(json.events)||json.events.some(ev=>ev?.symbol!==symbol))return hubReply({ok:false,error:'symbol_mismatch'},400);
    if(!env.MARKET_EVENT_HUB)return hubReply({ok:false,error:'hub_binding_missing'},503);
    return env.MARKET_EVENT_HUB.getByName(symbol).fetch(new Request('https://hub/ingest',{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({symbol,events:json.events})}));
  }
  if(!hubAuthorized(request,env))return hubReply({ok:false,error:'unauthorized'},401);
  if(path==='/market-hub/v1/candles'&&method==='GET'){
    const interval=hubFrame(u.searchParams.get('interval'));
    if(!interval)return hubReply({ok:false,error:'unsupported_interval'},400);
    try{return hubReply(await hubGetCandles(env,symbol,interval,500))}
    catch(e){return hubReply({ok:false,error:safeError(e),symbol,interval},503)}
  }
  if(path==='/market-hub/v1/events'&&method==='GET'){
    if(!env.MARKET_EVENT_HUB)return hubReply({ok:false,error:'hub_binding_missing'},503);
    const kind=u.searchParams.get('kind')||'';
    return env.MARKET_EVENT_HUB.getByName(symbol).fetch(new Request('https://hub/events?kind='+encodeURIComponent(kind)+
      '&limit='+encodeURIComponent(u.searchParams.get('limit')||'40')));
  }
  return hubReply({ok:false,error:'not_found'},404);
}

export class ResearchContainer extends DurableObject{
  constructor(ctx,env){super(ctx,env);this.starting=null;
    if(ctx.container?.running)void ctx.blockConcurrencyWhile(()=>ctx.container.setInactivityTimeout(120000));
  }
  async fetch(request){
    const container=this.ctx.container;if(!container)throw Error('container_binding_missing');
    this.starting??=this.startAndReady().finally(()=>{this.starting=null;});await this.starting;
    const url=new URL(request.url);url.protocol='http:';url.host='container';
    const headers=new Headers(request.headers);headers.delete('host');headers.set('X-Lumex-Internal-Key',this.env.LUMEX_CONTAINER_KEY||'');
    const forwarded=new Request(url,{method:request.method,headers,body:request.body});
    return container.getTcpPort(PORT).fetch(forwarded);
  }
  async startAndReady(){
    const container=this.ctx.container;
    if(!container.running){container.start({image:container.images.base,instance:'lite',enableInternet:true,env:{
      LUMEX_SITE_URL:'https://lumexbot.com',LUMEX_AI_LAB_WORKER_TOKEN:this.env.LUMEX_AI_LAB_WORKER_TOKEN||'',
      LUMEX_CONTAINER_KEY:this.env.LUMEX_CONTAINER_KEY||''
    }});}
    await container.setInactivityTimeout(120000);
    const port=container.getTcpPort(PORT);
    for(let i=0;i<100;i++){
      try{const r=await port.fetch('http://container/health',{signal:AbortSignal.timeout(1000)});await r.body?.cancel();if(r.ok)return;}catch{}
      await scheduler.wait(300);
    }
    throw Error('container_start_timeout');
  }
}
export default{
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname.startsWith('/market-hub/v1/'))return hubRoute(request,env);
    if(url.pathname==='/health' && request.method==='GET')return respond({ok:true,service:'LUMEX Research',version:'1.3.1',auto_research:enabled(env,'AUTO_RESEARCH'),auto_fetch:enabled(env,'AUTO_FETCH'),auto_ai:enabled(env,'AUTO_AI'),trading_enabled:false});
    if(!auth(request,env.LUMEX_ADMIN_API_TOKEN))return respond({ok:false,error:'unauthorized'},401);
    if(url.pathname==='/status' && request.method==='GET'){
      const out={ok:true,version:'1.3.1',auto_research:enabled(env,'AUTO_RESEARCH'),auto_fetch:enabled(env,'AUTO_FETCH'),auto_ai:enabled(env,'AUTO_AI'),trading_enabled:false,has_wordpress_token:Boolean(env.LUMEX_AI_LAB_WORKER_TOKEN),has_container_key:Boolean(env.LUMEX_CONTAINER_KEY),has_openai_key:Boolean(env.OPENAI_API_KEY)};
      try{const state=await readScheduler(env);out.scheduler={lastRun:state.lastRun,lastSummary:state.lastSummary,aiLastResult:state.aiLastResult||null,aiLastExecution:state.aiLastExecution||null,errors:state.errors};out.markets=(await getMarketInventory(env,Date.now())).map(({symbol,interval_min,head,ready})=>({symbol,interval_min,ready,lastCandleMs:Number(head?.customMetadata?.lastCandleMs||0),source:head?.customMetadata?.source||null,quality:head?.customMetadata?.quality||'unverified',schema:head?.customMetadata?.schema||'unknown',rows:Number(head?.customMetadata?.rows||0),bytes:Number(head?.size||0)}));}catch(e){out.storage_error=safeError(e);}
      try{out.core=await callWP(env,'status');}catch(e){out.core_error=safeError(e);}
      return respond(out);
    }
    if(url.pathname==='/enqueue' && request.method==='POST'){
      let job;try{job=await request.json();}catch{return respond({ok:false,error:'bad_json'},400);}
      if(!['fetch','research','ai','orchestrate'].includes(job?.kind))return respond({ok:false,error:'bad_kind'},400);
      if(job.kind==='fetch'&&!validMarket(job.symbol,job.interval_min))return respond({ok:false,error:'bad_market'},400);
      if(job.kind==='ai' && !validMarket(job.symbol,Number(job.interval_min||15)))return respond({ok:false,error:'bad_market'},400);
      await env.RESEARCH_QUEUE.send({kind:job.kind,symbol:job.symbol||null,interval_min:Number(job.interval_min||0)});
      return respond({ok:true,queued:true,kind:job.kind},202);
    }
    return respond({ok:false,error:'not_found'},404);
  },
  async scheduled(controller,env,ctx){
    // Once per UTC day, bounded read-only evidence -> write-only daily R2 summary.
    if(controller.cron==='*/5 * * * *'&&env.AUTO_MARKET_QA_DAILY==='true'){
      const utc=new Date(controller.scheduledTime||Date.now());if(utc.getUTCHours()===0&&utc.getUTCMinutes()===15)
        ctx.waitUntil(marketOpsDaily(env).catch(()=>console.error('market_ops_daily_failed')));
    }
    if(controller.cron==='*/5 * * * *'&&env.AUTO_OI_MIRROR_FETCH==='true')
      ctx.waitUntil(collectOiMirror(env).catch(()=>console.error('oi_mirror_collect_failed')));
    if(controller.cron==='*/5 * * * *'&&env.AUTO_PUBLIC_PULSE_FETCH==='true')
      ctx.waitUntil(collectPublicPulse(env).catch(()=>console.error('public_pulse_collect_failed')));
    const live=LIVE_ENABLED(env)&&Boolean(env.MARKET_LIVE_COLLECTOR);
    if(controller.cron==='*/5 * * * *'&&env.AUTO_DERIVATIVES_FETCH==='true')
      ctx.waitUntil(collectGateDerivatives(env).catch(()=>console.error('derivatives_collect_failed')));
    if(controller.cron==='*/5 * * * *'&&env.AUTO_LEGACY_BACKFILL==='true'&&env.BTC_RESERVE_COLLECTOR){
      ctx.waitUntil(env.BTC_RESERVE_COLLECTOR.getByName('reserve-btc')
        .fetch('https://whales/backfill').catch(e=>console.error('legacy_backfill_failed',String(e?.message||e||'unknown').replace(/[^A-Za-z0-9_-]/g,'_').slice(0,80))));
    }
    if(controller.cron==='*/5 * * * *'&&env.AUTO_WHALE_FETCH==='true'&&env.BTC_RESERVE_COLLECTOR){
      ctx.waitUntil(env.BTC_RESERVE_COLLECTOR.getByName('reserve-btc')
        .fetch('https://whales/poll').catch(()=>console.error('btc_whale_poll_failed')));
    }
    if(live && controller.cron==='* * * * *'){
      // Independent from market research Queue; a stream outage never blocks orders or research.
      ctx.waitUntil(env.MARKET_LIVE_COLLECTOR.getByName('public-linear').fetch('https://collector/ensure')
        .catch(()=>console.error('live_stream_ensure_failed')));
    }
    if(!enabled(env,'AUTO_RESEARCH') && !enabled(env,'AUTO_FETCH') && !enabled(env,'AUTO_AI')){
      if(!live)console.info('lumex_scheduler_disabled');return;
    }
    // Every-minute: market freshness only; every five minutes: bounded research + AI.
    // At overlapping minutes, the single queue consumer serializes the jobs.
    if(enabled(env,'AUTO_RESEARCH')||enabled(env,'AUTO_FETCH')||enabled(env,'AUTO_AI')){
      const kind=controller.cron==='* * * * *'?'market_tick':'orchestrate';
      ctx.waitUntil(env.RESEARCH_QUEUE.send({kind}));
    }
  },
  async queue(batch,env){
    for(const message of batch.messages){
      try{const result=await processJob(env,message.body);console.info('lumex_queue_result',JSON.stringify({kind:message.body?.kind,result}));message.ack();}
      catch(error){const reason=safeError(error);console.error('lumex_queue_error',reason);message.retry({delaySeconds:Math.min(600,60*(Number(message.attempts)||1))});}
    }
  }
};
