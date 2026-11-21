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

/** Source-truthful replacement when public Bybit ticker/account endpoints 403.
 * Gate futures contract stats "long_users"/"short_users" refer to Gate users,
 * not Bybit participants. Never map Gate fields into Bybit-labelled JSON.
 */
export function pulseGateTickerQuote(raw,coin){
  const q=Array.isArray(raw)?raw.find(x=>x?.contract===coin+'_USDT'):null;
  if(!q)throw Error('gate_quote_missing');
  const price=pulseN(q.last,0.00000001,1e10),
    change=pulseN(q.change_percentage,-100,10000),
    funding=pulseN(q.funding_rate,-1,1);
  if(price===null||change===null)throw Error('gate_quote_invalid');
  return {last:price,change_24h_pct:Number(change.toFixed(3)),
    funding_rate_pct:funding===null?null:Number((funding*100).toFixed(6)),
    open_interest_usdt:null,
    turnover_24h_usdt:pulseN(q.volume_24h_quote,0,1e18)};
}
async function pulseGatePublicTickers(){
  const coins=await Promise.all(PUBLIC_PULSE_COINS.map(async coin=>{
    const path='/api/v4/futures/usdt/tickers?contract='+coin+'_USDT';
    let err='';
    for(const host of ['https://api.gateio.ws','https://fx-api.gateio.ws']){
      try{return [coin,pulseGateTickerQuote(await pulseJson(host+path,50000),coin)]}
      catch(e){err=String(e?.message||e).slice(0,50)}
    }
    throw Error('gate_ticker_unavailable_'+err);
  }));
  const quotes=Object.fromEntries(coins.map(([c,q])=>[c+'USDT',q]));
  const breadth={up:0,down:0,flat:0,total:4};
  for(const q of Object.values(quotes))
    q.change_24h_pct>0?breadth.up++:q.change_24h_pct<0?breadth.down++:breadth.flat++;
  return {quotes,breadth,scope:'Gate USDT perpetual, four symbols; not Bybit prices'};
}
export function pulseGateUserRatio(rows,coin,now){
  if(!Array.isArray(rows)||rows.length<1||rows.length>100)throw Error('gate_accounts_schema');
  const frame=300;
  const clean=rows.map(x=>{
    const t=pulseN(x?.time,1500000000,4102444800),
      long=pulseN(x?.long_users,0,1e12),short=pulseN(x?.short_users,0,1e12);
    if(t===null||!Number.isSafeInteger(t)||t%frame!==0||
      long===null||short===null||long+short<=0||
      t+frame>now-5||t+frame<now-1800)return null;
    return {end:t+frame,long,short};
  }).filter(Boolean).sort((a,b)=>b.end-a.end);
  if(!clean.length||now-clean[0].end>900)throw Error('gate_accounts_stale');
  const ratio=Number((100*clean[0].long/(clean[0].long+clean[0].short)).toFixed(2));
  return {long_pct:ratio,short_pct:Number((100-ratio).toFixed(2)),
    sample_unix:clean[0].end,collected_unix:now,
    exchange:'Gate',scope:coin+'USDT Gate contract_stats long_users / short_users'};
}
async function pulseGateAccountRatio(coin,now){
  const path='/api/v4/futures/usdt/contract_stats?contract='+coin+'_USDT&interval=5m&limit=6';
  let err='';
  for(const host of ['https://api.gateio.ws','https://fx-api.gateio.ws']){
    try{return pulseGateUserRatio(await pulseJson(host+path,120000),coin,now)}
    catch(e){err=String(e?.message||e).slice(0,50)}
  }
  throw Error('gate_accounts_unavailable_'+err);
}
async function pulseTickerBySource(){
  try{
    return {source:'bybit_v5_linear',data:pulseTickers(
      await pulseJson('https://api.bybit.com/v5/market/tickers?category=linear',2500000))};
  }catch{
    return {source:'gateio_usdt_perpetual_tickers',data:await pulseGatePublicTickers(),
      fallback_reason:'bybit_public_unavailable'};
  }
}
async function pulseRatioBySource(coin,now){
  try{
    return {source:'bybit_v5_account_ratio',data:pulseRatio(
      await pulseJson('https://api.bybit.com/v5/market/account-ratio?category=linear&symbol='+
        coin+'USDT&period=5min&limit=2',70000),coin,now)};
  }catch{
    return {source:'gateio_futures_contract_stats_user_ratio',
      data:await pulseGateAccountRatio(coin,now),
      fallback_reason:'bybit_public_unavailable'};
  }
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
    ['tickers','source_separated_ticker',null,()=>pulseTickerBySource(),0],
    ...PUBLIC_PULSE_COINS.map(c=>['ratio_'+c,'source_separated_user_ratio',
      null,()=>pulseRatioBySource(c,now),0]),
    ...PUBLIC_PULSE_COINS.map(c=>['taker_'+c,'source_separated_taker_volume',
      null,()=>pulseTakerByAllowedSource(c,now,env),0]),
    ['sentiment','alternative_me_fng','https://api.alternative.me/fng/?limit=1',
      x=>pulseSentiment(x,now),50000]
  ];
  const results=await Promise.allSettled(jobs.map(async j=>j[0]==='tickers'||j[0].startsWith('ratio_')||j[0].startsWith('taker_')?j[3]():j[3](await pulseJson(j[2],j[4]))));
  for(let i=0;i<jobs.length;i++){
    const [key,source]=jobs[i],r=results[i];
    if(r.status==='rejected'){
      const error=String(r.reason?.message||'provider_error').replace(/[^A-Za-z0-9_-]/g,'_').slice(0,60);
      reports[key]={ok:false,error};continue;
    }
    const direct=key==='tickers'||key.startsWith('ratio_')||key.startsWith('taker_');
    const resolvedSource=direct?r.value.source:source;
    const data=direct?r.value.data:r.value;
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
      ...(direct&&r.value.fallback_reason?{fallback_reason:r.value.fallback_reason}:{})};
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
  const ret=closed.slice(-Math.min(850,Math.max(40,limit)));
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

export function hubRsi14(closedCandles){
  if(!Array.isArray(closedCandles)||closedCandles.length<15)return null;
  const tail=closedCandles.slice(-15),close=tail.map(x=>Number(x?.c));
  if(close.some(x=>!Number.isFinite(x)||x<=0))return null;
  let gains=0,losses=0;
  for(let i=1;i<15;i++){const delta=close[i]-close[i-1];
    gains+=Math.max(0,delta);losses+=Math.max(0,-delta);}
  const rsi=losses===0?(gains===0?50:100):100-100/(1+gains/losses);
  return Number(rsi.toFixed(1));
}
/** Strict, source-preserving hourly reconstruction from R2 verified 15m closes.
 * Never invent missing hours or align bars across a timestamp gap.
 */
export function verifiedHourlyFromQuarter(bars,now=Date.now()){
  if(!Array.isArray(bars)||bars.length<4)return [];
  const groups=new Map();
  for(const bar of bars){
    const t=Number(bar?.t),o=Number(bar?.o),h=Number(bar?.h),
      l=Number(bar?.l),c=Number(bar?.c),v=Number(bar?.v);
    if(!Number.isSafeInteger(t)||t<1500000000000||t%900000!==0||
       t+900000>now||!(o>0)||!(h>0)||!(l>0)||!(c>0)||
       h<Math.max(o,c,l)||l>Math.min(o,c,h)||
       !Number.isFinite(v)||v<0)continue;
    const hour=Math.floor(t/3600000)*3600000;
    const bucket=groups.get(hour)||[];
    bucket.push({t,o,h,l,c,v});groups.set(hour,bucket);
  }
  const completed=[];
  for(const [hour,segment] of groups){
    segment.sort((a,b)=>a.t-b.t);
    if(segment.length!==4||segment[0].t!==hour||
       segment[1].t!==hour+900000||segment[2].t!==hour+1800000||
       segment[3].t!==hour+2700000||hour+3600000>now)continue;
    completed.push({t:hour,o:segment[0].o,c:segment[3].c,
      h:Math.max(...segment.map(x=>x.h)),
      l:Math.min(...segment.map(x=>x.l)),
      v:segment.reduce((sum,x)=>sum+x.v,0)});
  }
  completed.sort((a,b)=>a.t-b.t);
  if(!completed.length)return [];
  const out=[completed.at(-1)];
  for(let i=completed.length-2;i>=0;i--){
    if(completed[i].t!==out[0].t-3600000)break;
    out.unshift(completed[i]);
  }
  return out.slice(-160);
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
        r[name].last_candle_open_ms=v.last_candle_open_ms;
        r[name].source_scope=v.source_scope||'cloudflare_r2_verified_closed_candles';
        if(frame===60&&(v.stale===true||r[name].status!=='ok'))
          throw Error('hourly_r2_stale_or_insufficient');
        if(frame===15)r[name].rsi=hubRsi14(v.candles);
        if(frame===15&&v.candles.length>=97){
          const c=v.candles,rtn=(c.at(-1).c/c.at(-97).c-1)*100;
          r.change_24h_pct=Number(rtn.toFixed(3));
        }
      }catch(e){
        // An hourly R2 object can be missing while the exact same market's
        // verified 15-minute R2 closes are healthy. Do not return a blank
        // 1-hour technical card if >=51 *consecutive* verified hours exist.
        if(frame===60){
          try{
            const base=await hubGetCandles(env,symbol,15,850);
            if(base.stale===true||base.data_quality!=='verified'||
               base.feed_mode!=='cloudflare_r2_verified_closed_candles')
              throw Error('quarter_source_unverified');
            const hourly=verifiedHourlyFromQuarter(base.candles);
            if(hourly.length<51)throw Error('verified_hourly_history_insufficient');
            const last=hourly.at(-1).t;
            const age=Math.max(0,Date.now()-last-3600000);
            r[name]={...hubTrend(hourly),
              age_seconds:Math.floor(age/1000),stale:age>7200000,
              last_candle_open_ms:last,
              source_scope:'cloudflare_r2_verified_closed_candles',
              derivation:'four_consecutive_verified_15m_closed_bars'};
          }catch(derivedError){
            r[name]={status:'unavailable',trend:null,atr_pct:null,
              error:'hourly_and_verified_15m_projection_unavailable'};
          }
        } else r[name]={status:'unavailable',trend:null,atr_pct:null,
          error:'verified_closed_candles_unavailable'};
      }
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

/** Independent Gate USDT-futures PUBLIC liquidation stream.
 * Gate's size is contracts; only a verified contract_info quanto_multiplier
 * allows normalization to coin quantity. Never treat a missing multiplier as
 * 1 coin/contract, and never label an order price as a fill price.
 */
export function decodeGateContractInfo(raw){
  if(raw?.channel!=='futures.contract_info'||
     !['all','update'].includes(raw?.event))return [];
  const out=[];
  for(const item of Array.isArray(raw?.result)?raw.result:[raw?.result]){
    const symbol=liveSymbolFromGate(item?.contract);
    const multiplier=Number(item?.quanto_multiplier);
    if(symbol&&item?.quanto_multiplier!==null&&item?.quanto_multiplier!==undefined&&
       item?.quanto_multiplier!==''&&Number.isFinite(multiplier)&&multiplier>0&&multiplier<=100)
      out.push({symbol,multiplier});
  }
  return out;
}
export function decodeGateLiquidations(raw,multipliers,now=Date.now()){
  if(raw?.channel!=='futures.public_liquidates'||raw?.event!=='update'||
     !Array.isArray(raw?.result))return [];
  const out=[];
  for(const item of raw.result.slice(0,200)){
    const symbol=liveSymbolFromGate(item?.contract);
    const multiplier=Number(multipliers?.[symbol]??NaN),price=Number(item?.price);
    const contracts=Number(item?.size),ts=Number(item?.time_ms??item?.time);
    if(!symbol||!Number.isFinite(multiplier)||multiplier<=0||multiplier>100||
       !Number.isSafeInteger(ts)||ts<now-600000||ts>now+120000||
       !Number.isFinite(price)||price<=0||price>1000000000||
       !Number.isFinite(contracts)||contracts===0||Math.abs(contracts)>1000000000)continue;
    const quantity=Math.abs(contracts)*multiplier;
    if(!(quantity>0)||!Number.isFinite(quantity)||quantity>1000000000)continue;
    out.push({kind:'liquidation',source:'gateio',symbol,ts,price,quantity,
      side:contracts>0?'buy':'sell',position_side:contracts>0?'short':'long',
      capture:'public_stream',price_type:'unspecified',
      gate_contract_size:Math.abs(contracts)});
  }
  return out;
}
export async function gatePublicLiquidationId(e){
  const tuple=['gateio_public_liquidates_v1',e.symbol,e.ts,e.side,
    Number(e.price).toPrecision(14),Number(e.quantity).toPrecision(14),
    Number(e.gate_contract_size).toPrecision(14)].join('|');
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(tuple));
  return 'gateio:liq:'+e.symbol+':'+Array.from(new Uint8Array(digest).slice(0,16),
    b=>b.toString(16).padStart(2,'0')).join('');
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
  if(addresses.length<1||addresses.length>150||addresses.some(x=>!btcAddress(x)))
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
export function decodeBtcTrackedNet(tx,items){
  if(!tx||typeof tx!=='object'||!tx.status?.confirmed||
     !/^[a-fA-F0-9]{64}$/.test(String(tx.txid||'')))return null;
  const ts=Number(tx.status.block_time)*1000;
  if(!Number.isSafeInteger(ts)||ts<1500000000000||ts>Date.now()+120000)return null;
  const known=new Map();
  for(const i of items||[])if(btcAddress(i?.address)&&typeof i?.label==='string')
    known.set(i.address,String(i.label).slice(0,80));
  const nets=new Map(),touches=new Map();
  let untrackedInput=false;
  function record(address,satoshis,sign=1){
    if(!known.has(address))return;
    const val=sats(satoshis);if(val===null)throw Error('btc_invalid_satoshis');
    const ex=known.get(address);nets.set(ex,(nets.get(ex)||0)+sign*val);
    if(!touches.has(ex))touches.set(ex,new Set());touches.get(ex).add(address);
  }
  try{
    for(const out of Array.isArray(tx.vout)?tx.vout:[])
      record(out?.scriptpubkey_address,out?.value);
    for(const input of Array.isArray(tx.vin)?tx.vin:[]){
      const p=input?.prevout;
      if(!p||!known.has(p.scriptpubkey_address)){
        untrackedInput=true;continue;
      }
      const val=sats(p.value);if(val===null)return null;
      record(p.scriptpubkey_address,val,-1);
    }
  }catch{return null;}
  if(nets.size!==1)return null;
  const [exchange,net]=nets.entries().next().value;
  if(!Number.isSafeInteger(net)||net===0||(net<0&&untrackedInput))return null;
  const address=[...(touches.get(exchange)||[])].sort()[0];
  if(!address)return null;
  const quantity=Math.abs(net)/100000000;
  if(!Number.isFinite(quantity)||quantity<=0)return null;
  return {kind:'whale_transfer',source:'blockstream',symbol:'BTCUSDT',
    id:'btc:exchangeflow:'+tx.txid.toLowerCase()+':'+exchange.replace(/[^A-Za-z0-9_-]/g,'_').slice(0,40),
    ts,price:0,quantity,side:net>0?'in':'out',
    txhash:tx.txid.toLowerCase(),capture:'confirmed_chain_poll',
    watched_address:address,watch_label:exchange};
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
  // Bounded one-time historical migration: at most 16 x 100 public records
  // every five minutes. Stop after eight pages if 30 s has elapsed.
  // Never read customer accounts, orders, payments or private keys.
  const started=Date.now();
  for(let i=0;i<16;i++){
    if(i>=8&&Date.now()-started>30000)break;
    const liq=await backfillOneLegacySource(env,storage,'liquidations');
    results.push(liq);
    if(!liq.success||liq.caught_up)break;
  }
  for(const source of ['whales','market_snapshots'])
    results.push(await backfillOneLegacySource(env,storage,source));
  let liq_index={ok:false,code:'not_run'};
  if(storage?.sql)try{liq_index=await runLegacyLiqIndex(env,storage)}catch(e){
    liq_index={ok:false,code:'index_error',error:err(e)};
    const old=await storage.get(LIQ_INDEX_KEY)||{};
    await storage.put(LIQ_INDEX_KEY,{...old,caught_up:false,error:err(e)});
  }
  return {ok:results.every(x=>x.success),enabled:true,archival_only:true,
    live_ledger_merge:false,source_rows_deleted:false,
    results,liquidation_history_index:liq_index,checked_at_ms:Date.now()};
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


/** R2 public WordPress liquidation archive index.
 * The R2 immutable SHA256 objects are authoritative; DO SQLite is an
 * idempotent bounded read index. Never merges source events into live totals.
 */
const LIQ_INDEX_KEY='legacy-public-liq-index-v1';
function liqIndexSchema(store){
  store.sql.exec("CREATE TABLE IF NOT EXISTS legacy_liq_chunks(key TEXT PRIMARY KEY, count INTEGER NOT NULL)");
  store.sql.exec("CREATE TABLE IF NOT EXISTS legacy_liq_events(id INTEGER PRIMARY KEY,coin TEXT NOT NULL, exchange_name TEXT NOT NULL, position_side TEXT NOT NULL, event_ts INTEGER NOT NULL, price REAL NOT NULL, notional_usd REAL NOT NULL)");
  store.sql.exec("CREATE INDEX IF NOT EXISTS legacy_liq_coin_time ON legacy_liq_events(coin,event_ts)");
}
export function validateHistoricalLiquidationArchive(doc){
  if(doc?.schema!=='lumex_legacy_archive_v1'||doc?.source!=='liquidations'||
     doc?.origin!=='lumexbot_wordpress_public_market_mysql'||
     doc?.merged_with_live_observations!==false||
     !Array.isArray(doc?.records)||doc.records.length<1||doc.records.length>100||
     doc.record_count!==doc.records.length)return null;
  const result=[],ids=new Set();
  for(const r of doc.records){
    const id=Number(r?.id),ts=Number(r?.event_ts),p=Number(r?.price),usd=Number(r?.notional_usd);
    if(!Number.isSafeInteger(id)||id<=0||ids.has(id)||!Number.isSafeInteger(ts)||
       ts<1450000000||ts>Math.floor(Date.now()/1000)+120||
       !HUB_SYMBOLS.some(x=>x===r.coin+'USDT')||
       !['Bybit','Binance'].includes(r.exchange_name)||
       !['long','short'].includes(r.position_side)||
       !(p>0)||!(usd>0)||!Number.isFinite(p)||!Number.isFinite(usd)||usd>1e16||
       !/^[a-f0-9]{64}$/i.test(String(r.fingerprint||'')))return null;
    ids.add(id);result.push({id,coin:r.coin,exchange_name:r.exchange_name,
      position_side:r.position_side,event_ts:ts,price:p,notional_usd:usd});
  }
  return result;
}
export async function runLegacyLiqIndex(env,storage,now=Date.now()){
  if(!storage?.sql||!env.MARKET_DATA?.list)return {ok:false,code:'index_unavailable'};
  liqIndexSchema(storage);
  const prev=await storage.get(LIQ_INDEX_KEY)||{cursor:null,cycles:0};
  const opts={prefix:PREFIX+'liquidations/',limit:32};
  if(prev.cursor)opts.cursor=prev.cursor;
  const list=await env.MARKET_DATA.list(opts);
  let indexed=0,rowsAdded=0;
  for(const item of list.objects||[]){
    const key=String(item.key||'');
    if(!/^market-hub\/legacy\/wp\/liquidations\/[0-9]+-[0-9]+-[a-f0-9]{24}\.json$/.test(key))
      throw Error('archive_index_key_invalid');
    if(storage.sql.exec('SELECT key FROM legacy_liq_chunks WHERE key=?',key).toArray().length)continue;
    const obj=await env.MARKET_DATA.get(key);
    if(!obj||obj.size>180000||obj.size<2||obj.customMetadata?.schema!=='lumex_legacy_archive_v1'||
       obj.customMetadata?.source!=='liquidations')throw Error('archive_index_object_invalid');
    const raw=await obj.text();
    const sha=hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw)));
    if(obj.customMetadata.sha256!==sha||!key.endsWith('-'+sha.slice(0,24)+'.json'))
       throw Error('archive_index_sha_mismatch');
    const doc=JSON.parse(raw),rows=validateHistoricalLiquidationArchive(doc);
    if(!rows||Number(doc.source_cursor_to)!==rows.at(-1).id||
       rows[0].id<=Number(doc.source_cursor_from)||rows.length!==doc.record_count)
       throw Error('archive_index_row_invalid');
    // If interrupted before marking the chunk, INSERT OR IGNORE is retry-safe.
    // Only this Cloudflare DO SQL is written; no WordPress database mutation.
    for(const r of rows){
      storage.sql.exec('INSERT OR IGNORE INTO legacy_liq_events(id,coin,exchange_name,position_side,event_ts,price,notional_usd) VALUES (?,?,?,?,?,?,?)',
        r.id,r.coin,r.exchange_name,r.position_side,r.event_ts,r.price,r.notional_usd);
    }
    storage.sql.exec('INSERT OR IGNORE INTO legacy_liq_chunks(key,count) VALUES (?,?)',key,rows.length);
    indexed++;rowsAdded+=rows.length;
  }
  const source=await storage.get('legacy-backfill:liquidations')||{};
  const stats=storage.sql.exec('SELECT COUNT(*) AS chunks, COALESCE(SUM(count),0) AS rows FROM legacy_liq_chunks').toArray()[0]||{};
  const count=Number(stats.chunks||0),sum=Number(stats.rows||0);
  const fullyScanned=list.truncated!==true;
  const caughtUp=fullyScanned&&source.caught_up===true&&source.last_error===null&&
    count===source.chunks_archived&&sum===source.records_archived;
  const next={cursor:list.truncated===true?String(list.cursor||''):null,
    cycles:Number(prev.cycles||0)+(fullyScanned?1:0),
    indexed_chunks:count,indexed_rows:sum,source_chunks:Number(source.chunks_archived||0),
    source_rows:Number(source.records_archived||0),caught_up:caughtUp,
    last_indexed_at_ms:now,final_scan_at_ms:fullyScanned?now:Number(prev.final_scan_at_ms||0),
    source_last_success_ms:Number(source.last_success_ms||0),error:null};
  await storage.put(LIQ_INDEX_KEY,next);
  return {ok:true,code:caughtUp?'indexed_and_caught_up':'indexing',
    indexed_this_round:indexed,rows_this_round:rowsAdded,...next};
}
async function legacyLiqReadiness(storage,now=Date.now()){
  const s=await storage.get(LIQ_INDEX_KEY)||{},source=await storage.get('legacy-backfill:liquidations')||{};
  return {ok:s.caught_up===true&&source.caught_up===true&&source.last_error===null&&
      s.indexed_chunks===source.chunks_archived&&s.indexed_rows===source.records_archived&&
      now-Number(s.last_indexed_at_ms||0)<1200000&&now-Number(source.last_success_ms||0)<1200000,
    index_chunks:Number(s.indexed_chunks||0),source_chunks:Number(source.chunks_archived||0),
    index_rows:Number(s.indexed_rows||0),source_rows:Number(source.records_archived||0),
    archive_only:true,legacy_wp_sql_read:false,source_caught_up:source.caught_up===true,
    generated_ms:now};
}
export function archivedLiqTimeline(sql,coin,days,now=Date.now()){
  if(!['BTC','ETH','SOL','XRP'].includes(coin)||days!==30)throw Error('historical_timeline_filter');
  const lower=Math.floor(now/1000)-30*86400;
  const rows=sql.exec(
    'SELECT CAST(event_ts/3600 AS INTEGER) AS bucket,exchange_name,position_side,COUNT(*) AS event_count,SUM(notional_usd) AS total_usd,MAX(event_ts) AS last_ts FROM legacy_liq_events WHERE coin=? AND event_ts>=? AND event_ts<=? GROUP BY bucket,exchange_name,position_side ORDER BY last_ts DESC LIMIT 161',
    coin,lower,Math.floor(now/1000)).toArray();
  const groups=[];
  for(const r of rows){
    const n=Number(r.event_count),usd=Number(r.total_usd),last=Number(r.last_ts),hour=Number(r.bucket);
    if(!['Bybit','Binance'].includes(r.exchange_name)||!['long','short'].includes(r.position_side)||
       !Number.isSafeInteger(n)||n<=0||!Number.isFinite(usd)||usd<=0||
       !Number.isSafeInteger(last)||last<lower||last>now/1000+120||
       !Number.isSafeInteger(hour)||hour*3600>last)
        throw Error('historical_timeline_invalid_group');
    groups.push({exchange_name:r.exchange_name,position_side:r.position_side,
      bucket:hour,total_usd:Number(usd.toFixed(2)),event_count:n,last_ts:last});
  }
  return {ok:true,schema:'lumex_cf_liquidation_timeline_v1',symbol:coin+'USDT',
    source:'cloudflare_r2_archived_wordpress_liquidations',legacy_sql_read:false,
    order_execution:false,observed_only:true,market_total_estimate:false,provider_comparability:'not_comparable',
    requested_days:30,covered_days:30,coverage_complete:true,backfill_older_than_hot_index:true,
    generated_ms:now,truncated:groups.length>160,groups:groups.slice(0,160),
    coverage:'WordPress public liquidation history archived into immutable R2 and indexed in Cloudflare DO; not live native event stream'};
}
export function archivedLiqReplay(sql,coin,start,end,now=Date.now()){
  if(!['BTC','ETH','SOL','XRP'].includes(coin)||!Number.isSafeInteger(start)||
    !Number.isSafeInteger(end)||start>=end||end-start>14400000||
    start<now-35*86400000||end>now+60000)throw Error('historical_replay_filter');
  const a=Math.floor(start/1000),b=Math.ceil(end/1000);
  const rows=sql.exec('SELECT id,event_ts,exchange_name,position_side,price,notional_usd FROM legacy_liq_events WHERE coin=? AND event_ts>=? AND event_ts<? ORDER BY event_ts ASC,id ASC LIMIT 2001',coin,a,b).toArray();
  const binsRaw=sql.exec(
    'SELECT CAST(event_ts/300 AS INTEGER)*300 AS bucket,exchange_name,position_side,COUNT(*) AS event_count,SUM(notional_usd) AS usd FROM legacy_liq_events WHERE coin=? AND event_ts>=? AND event_ts<? GROUP BY bucket,exchange_name,position_side ORDER BY bucket ASC LIMIT 400',
    coin,a,b).toArray();
  if(binsRaw.length>=400)throw Error('archive_replay_bins_overflow');
  const bins=new Map();
  for(const r of binsRaw){
    const src=r.exchange_name,side=r.position_side,ts=Number(r.bucket)*1000,usd=Number(r.usd),count=Number(r.event_count);
    if(!['Bybit','Binance'].includes(src)||!['long','short'].includes(side)||ts<start-300000||ts>end||
      !Number.isFinite(usd)||usd<=0||!Number.isSafeInteger(count)||count<1)
      throw Error('archive_replay_bin_invalid');
    const key=ts+'|'+src;
    const v=bins.get(key)||{bucket_ms:ts,exchange:src,long_usd_estimate:0,short_usd_estimate:0,long_count:0,short_count:0};
    v[side+'_usd_estimate']+=usd;v[side+'_count']+=count;bins.set(key,v);
  }
  const events=[];
  for(const r of rows.slice(0,2000)){
    if(!['Bybit','Binance'].includes(r.exchange_name)||!['long','short'].includes(r.position_side)||
      !(Number(r.price)>0)||!(Number(r.notional_usd)>0)||!Number.isSafeInteger(Number(r.event_ts)))
      throw Error('archive_replay_event_invalid');
    events.push({id:'archive:'+r.id,ts:Number(r.event_ts)*1000,exchange:r.exchange_name,
      side:r.position_side,price:Number(r.price),quantity:0,
      amount_usd_estimate:Number(Number(r.notional_usd).toFixed(2)),
      price_type:'legacy_observed_price',capture:'archived_public_record'});
  }
  return {ok:true,schema:'lumex_observed_replay_v1',source_scope:'archived_wordpress_public_liquidation_observations_only',
    legacy_sql_read:false,market_total_estimate:false,provider_comparability:'not_comparable',
    order_execution:false,coverage:'verified_immutable_r2_archive_index_only',
    from_ms:start,to_ms:end,query_generated_ms:now,hot_retention_days:35,
    event_limit:2000,events_total_in_hot_window:rows.length,truncated:rows.length>2000,
    bins_5m:[...bins.values()].sort((x,y)=>x.bucket_ms-y.bucket_ms),
    summary_estimate:{source:'public_archive_only'},events,market_samples:[],market_samples_status:'not_included'};
}

/** Preserve four bounded public reads/minute while giving one incomplete
 * 35-day reserve backfill a fair priority. No extra provider budget.
 */
export function chooseWhalePollAddresses(items,records,nextIndex=0,now=Date.now()){
  if(!Array.isArray(items)||items.length===0)return {selected:[],nextIndex:0};
  const take=Math.min(4,items.length),from=Number(nextIndex||0)%items.length;
  const selected=Array.from({length:take},(_,i)=>items[(from+i)%items.length]);
  if(take>1){
    const incomplete=items.filter(item=>{
      const v=records?.[item.address]||{};
      if(v.backfill_complete===true&&!v.gap_possible&&!v.error)return false;
      // Explicit provider failures get at least five minutes of backoff.
      if(v.error&&Number(v.last_attempt_ms)>now-300000)return false;
      return true;
    }).sort((a,b)=>
      Number(records?.[a.address]?.checked_ms||0)-
      Number(records?.[b.address]?.checked_ms||0));
    if(incomplete.length&&!selected.some(v=>v.address===incomplete[0].address))
      selected[take-1]=incomplete[0];
  }
  return {selected,nextIndex:(from+take)%items.length};
}

export class BtcReserveCollector extends DurableObject{
  constructor(ctx,env){super(ctx,env);this.ctx=ctx;this.env=env;this.legacyBackfillRun=null;this.pollRun=null;}
  async state(){
    return await this.ctx.storage.get('state')||{
      nextIndex:0,watchlist_source:'uninitialized',last_run_ms:0,last_success_ms:0,
      accepted:0,requests:0,errors:0,addresses:{},error:null,
      coverage:'confirmed BTC address net changes only;not exchange-wide flows'};
  }
  async fetch(request){
    const path=new URL(request.url).pathname;
    if(path==='/status'){
      const state=await this.state(),active=new Set(state.active_addresses||Object.keys(state.addresses||{})),
        watch=Object.entries(state.addresses||{}).filter(([address])=>active.has(address))
        .map(([address,v])=>({address_suffix:address.slice(-8),label:v.label||'',
          last_checked_ms:v.checked_ms||0,backfill_complete:!!v.backfill_complete,
          observed_confirmed:v.observed||0,gap_possible:!!v.gap_possible,error:v.error||null}));
      return hubReply({ok:true,enabled:this.env.AUTO_WHALE_FETCH==='true',source:state.watchlist_source,
        last_run_ms:state.last_run_ms,last_success_ms:state.last_success_ms,
        watchlist_count:Number(state.watchlist_count||0),
        accepted:state.accepted,requests:state.requests,errors:state.errors,
        active_error_count:watch.filter(w=>w.error).length,
        pending_backfill_count:watch.filter(w=>!w.backfill_complete||w.error||w.gap_possible).length,
        last_error:state.error||((watch.some(w=>w.error))?'active_address_failures':''),
        watchlist:watch,coverage:state.coverage,orders_enabled:false});
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
    if(path==='/historical-liquidation-health'){
      const d=await legacyLiqReadiness(this.ctx.storage);
      return hubReply({...d,schema:'lumex_r2_historical_liquidation_ready_v1',cron_retirement_allowed:false});
    }
    if(path==='/historical-liquidation-timeline'||path==='/historical-liquidation-replay'){
      const now=Date.now(),ready=await legacyLiqReadiness(this.ctx.storage,now);
      if(!ready.ok)return hubReply({ok:false,error:'historical_liquidation_index_not_ready',
        index_rows:ready.index_rows,source_rows:ready.source_rows},503);
      const u=new URL(request.url),coin=String(u.searchParams.get('coin')||'');
      try{
        return hubReply(path.endsWith('timeline')?
          archivedLiqTimeline(this.ctx.storage.sql,coin,Number(u.searchParams.get('days')),now):
          archivedLiqReplay(this.ctx.storage.sql,coin,
            Number(u.searchParams.get('start_ms')),Number(u.searchParams.get('end_ms')),now));
      }catch(error){return hubReply({ok:false,error:'historical_liquidation_query_invalid'},503)}
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
      if(!this.pollRun)this.pollRun=this.poll().finally(()=>{this.pollRun=null;});
      return hubReply(await this.pollRun);
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
          if(data.length<1||data.length>150||data.some(v=>!btcAddress(v?.address)||typeof v?.exchange!=='string'||!v.exchange.trim())||new Set(data.map(v=>v.address)).size!==data.length)throw Error('wordpress_watchlist_invalid');
          const valid=data.map(v=>({
            address:v.address,label:String(v.exchange).trim().slice(0,80)}));
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
    if(text.length>10000000)throw Error('esplora_response_oversize');
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
      state.active_addresses=items.map(x=>x.address);
      // Keep the same four bounded public reads/minute; prioritize one
      // unfinished 35-day address without starving the rotating watchlist.
      const {selected,nextIndex}=chooseWhalePollAddresses(items,state.addresses,state.nextIndex,now);
      const take=selected.length;
      state.nextIndex=nextIndex;
      const seenInPoll=new Set();
      const results=await Promise.all(selected.map(async a=>{
        const prior=state.addresses[a.address]||{label:a.label,backfill_complete:false,observed:0};
        try{
          const newest=await this.fetchPage(a.address);state.requests++;
          const pages=[newest];
          const gap=Boolean(prior.head&&newest.length===25&&!newest.some(tx=>tx.txid===prior.head));
          const wasComplete=prior.backfill_complete===true&&!gap;
          let cursor=prior.backfill_cursor||(!wasComplete&&newest.length===25?newest.at(-1)?.txid:'');
          for(let step=0;step<3&&cursor&&/^[0-9a-fA-F]{64}$/.test(cursor);step++){
            const page=await this.fetchPage(a.address,cursor);
            state.requests++;pages.push(page);
            const oldest=page.at(-1),next=oldest?.txid;
            if(page.length<25||Number(oldest?.status?.block_time||0)*1000<now-35*86400000||
               !next||next===cursor)break;
            cursor=next;
          }
          const unique=new Map();
          for(const page of pages)for(const tx of page){
            if(/^[a-fA-F0-9]{64}$/.test(String(tx?.txid||''))&&tx.status?.confirmed)unique.set(tx.txid,tx);
          }
          const events=[...unique.values()].map(tx=>decodeBtcTrackedNet(tx,items)).filter(Boolean);
          const keep=events.filter(e=>{if(e.ts<now-35*86400000||seenInPoll.has(e.id))return false;seenInPoll.add(e.id);return true;});
          let accepted=0;
          for(let i=0;i<keep.length;i+=90){
            const batch=keep.slice(i,i+90);
            const res=await this.env.MARKET_EVENT_HUB.getByName('BTCUSDT').fetch(new Request('https://hub/ingest',{
              method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({symbol:'BTCUSDT',events:batch})}));
            if(!res.ok)throw Error('whale_hub_http_'+res.status);
            const result=await res.json();accepted+=Number(result.accepted||0);
          }
          prior.label=a.label;prior.checked_ms=now;prior.observed=(prior.observed||0)+accepted;
          const lastPage=pages.at(-1),oldest=lastPage.at(-1);
          prior.backfill_complete=wasComplete||lastPage.length<25||
            (Number(oldest?.status?.block_time||0)*1000<now-35*86400000);
          prior.backfill_cursor=prior.backfill_complete?null:oldest?.txid||null;
          prior.gap_possible=Boolean((prior.gap_possible||gap)&&!prior.backfill_complete);
          prior.head=newest[0]?.txid||prior.head||null;
          prior.error=null;state.addresses[a.address]=prior;
          return {ok:true,accepted,events:keep.length,gap:prior.gap_possible,backfill_complete:prior.backfill_complete};
        }catch(e){
          const code=String(e?.message||e||'unknown').replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,90);
          prior.error=code;prior.last_attempt_ms=now;state.addresses[a.address]=prior;
          return {ok:false,error:code};
        }
      }));
      const successes=results.filter(r=>r.ok),failures=results.filter(r=>!r.ok);
      state.accepted+=successes.reduce((n,r)=>n+r.accepted,0);
      state.errors+=failures.length;
      if(successes.length)state.last_success_ms=now;
      state.error=failures.length?('partial_'+failures.length+'_of_'+take+'_'+failures[0].error):null;
      await this.ctx.storage.put('state',state);
      return {ok:successes.length>0,watchlist_source:mode,address_count:items.length,
        checked:take,successful:successes.length,failed:failures.length,
        accepted:successes.reduce((n,r)=>n+r.accepted,0),
        observed_events:successes.reduce((n,r)=>n+r.events,0),
        gap_possible:successes.some(r=>r.gap),
        backfill_complete:successes.length===take&&successes.every(r=>r.backfill_complete),
        error:state.error};
    }catch(error){
      state.errors++;state.error=String(error?.message||error||'unknown').replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,90);
      await this.ctx.storage.put('state',state);
      return {ok:false,error:state.error,watchlist_source:state.watchlist_source};
    }
  }
}

/** Documented public Binance USD-M and merged UM/CM liquidation sources.
 * The decoder accepts only st=1 USD-M samples; trading is never enabled. */
export function binancePublicLiqEndpoint(restarts=0){
  const urls=[
    'wss://fstream.binance.com/market/ws/!forceOrder@arr',
    'wss://fstream.binance.com/market/stream?streams=!forceOrder@arr',
    'wss://dstream.binance.com/ws/!forceOrder@arr'
  ];
  const idx=Number.isSafeInteger(restarts)&&restarts>=0?restarts%urls.length:0;
  return {url:urls[idx],route:['usd_market_raw','usd_market_combined','merged_coin_raw'][idx]};
}
export class MarketLiveCollector extends DurableObject{
  constructor(ctx,env){
    super(ctx,env);
    this.ctx=ctx;this.env=env;
    this.streams=new Map();this.pending=new Map();this.flushRunning=false;
    this.lastSample=new Map();this.lastCandleSent=new Map();this.gateMultipliers={};this.lastGateMultiplierFetch=0;this.gateMultiplierRefreshPromise=null;this.retryAt={gate:0,bybit:0,binance:0};
    this.metrics={gate:{state:'idle',last_received_ms:0,packets:0,restarts:0,error:null},
      bybit:{state:'idle',last_received_ms:0,packets:0,restarts:0,error:null},
      binance:{state:'idle',last_received_ms:0,packets:0,restarts:0,error:null},
      pending:0,accepted:0,rejected:0,flush_errors:0,last_flush_ms:0,
      preview_sent:0,preview_errors:0,last_preview_ms:0,
      gate_public_liquidations:{subscription_ack:false,contracts_ready:0,updates_received:0,events_decoded:0,last_update_ms:0,last_event_ms:0,metadata_attempt_ms:0,metadata_success_count:0,metadata_error_count:0,metadata_last_error:null,collector_revision:'rest-repair-20261116'},
      coverage:'only_observed_messages;past_disconnects_not_backfilled'};
  }
  safeStatus(){
    const now=Date.now(),feeds={};
    for(const kind of ['gate','bybit','binance']){
      const m=this.metrics[kind];
      feeds[kind]={enabled:kind!=='binance'||BINANCE_LIQ_ENABLED(this.env),state:m.state,last_received_ms:m.last_received_ms,age_seconds:m.last_received_ms?Math.round((now-m.last_received_ms)/1000):null,
        packets:m.packets,restarts:m.restarts,error:m.error,
         retry_after_seconds:Math.max(0,Math.ceil(((this.retryAt[kind]||0)-now)/1000)),
         route:kind==='binance'?(m.route||'not_attempted'):undefined,
        connected:Boolean(this.streams.get(kind)?.readyState===1)};
    }
    return {ok:true,enabled:LIVE_ENABLED(this.env),feeds,buffered:this.metrics.pending,
      accepted:this.metrics.accepted,rejected:this.metrics.rejected,flush_errors:this.metrics.flush_errors,
      preview_sent:this.metrics.preview_sent,preview_errors:this.metrics.preview_errors,last_preview_ms:this.metrics.last_preview_ms,
      last_flush_ms:this.metrics.last_flush_ms,
      gate_public_liquidations:{...this.metrics.gate_public_liquidations,
        contracts_ready:Object.keys(this.gateMultipliers).length},
      coverage:this.metrics.coverage,
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
    if(this.streams.get('gate')?.readyState===1 &&
       Object.keys(this.gateMultipliers).length<4 &&
       Date.now()-this.lastGateMultiplierFetch>300000)
      this.ctx.waitUntil(this.refreshGateMultipliers());
    if(await this.ctx.storage.getAlarm()===null)await this.ctx.storage.setAlarm(Date.now()+5000);
  }
  /** Gate public REST contract specification, no keys. A contract count is
   * never converted into coins without official, matched quanto_multiplier.
   */
  async refreshGateMultipliers(){
    if(this.gateMultiplierRefreshPromise)return this.gateMultiplierRefreshPromise;
    this.lastGateMultiplierFetch=Date.now();
    const meta=this.metrics.gate_public_liquidations;
    meta.metadata_attempt_ms=this.lastGateMultiplierFetch;
    this.gateMultiplierRefreshPromise=Promise.allSettled(LIVE_GATE_CONTRACTS.map(async contract=>{
      const response=await fetch('https://api.gateio.ws/api/v4/futures/usdt/contracts/'+contract,{
        headers:{accept:'application/json'},signal:AbortSignal.timeout(9000)});
      if(!response.ok)throw Error('gate_contract_http_'+response.status);
      const body=await response.text();
      if(body.length>60000)throw Error('gate_contract_response_oversize');
      const json=JSON.parse(body);
      if(json?.name!==contract||json?.type!=='direct')throw Error('gate_contract_identity_mismatch');
      const rows=decodeGateContractInfo({
        channel:'futures.contract_info',event:'all',
        result:{contract:json.name,quanto_multiplier:json.quanto_multiplier}});
      if(rows.length!==1)throw Error('gate_contract_multiplier_invalid');
      this.gateMultipliers[rows[0].symbol]=rows[0].multiplier;
    })).then(results=>{
      const rejected=results.filter(r=>r.status==='rejected');
      meta.metadata_success_count=results.length-rejected.length;
      meta.metadata_error_count=rejected.length;
      meta.metadata_last_error=rejected.length?
        String(rejected[0].reason?.message||'request_error').replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,80):null;
    }).finally(()=>{this.gateMultiplierRefreshPromise=null;});
    return this.gateMultiplierRefreshPromise;
  }
  connect(source){
    const binance=source==='binance'?binancePublicLiqEndpoint(this.metrics.binance.restarts):null;
    const url=source==='gate'?'wss://fx-ws.gateio.ws/v4/ws/usdt':
      source==='bybit'?'wss://stream.bybit.com/v5/public/linear':binance.url;
    if(binance)this.metrics.binance.route=binance.route;
    this.metrics[source].state='connecting';
    // Binance works from independent hosts but the Cloudflare DO outbound
    // WebSocket constructor has repeatedly failed. Alternate with Cloudflare's
    // documented fetch Upgrade client so the handshake HTTP result is visible.
    if(source==='binance'&&this.metrics.binance.restarts%2===1){
      this.retryAt.binance=Date.now()+20000; // avoid overlapping handshakes
      this.ctx.waitUntil(this.connectBinanceViaUpgrade(url));
      return;
    }
    let ws;
    try{ws=new WebSocket(url)}catch(error){this.disconnected(source,'connect_failed');return;}
    this.registerSocket(source,ws,false);
  }
  async connectBinanceViaUpgrade(url){
    try{
      const httpsUrl=url.replace(/^wss:\/\//,'https://');
      if(!/^https:\/\/(?:fstream|dstream)\.binance\.com\//.test(httpsUrl))
        throw Error('invalid_public_binance_origin');
      const reply=await fetch(httpsUrl,{
        headers:{Upgrade:'websocket'},signal:AbortSignal.timeout(12000)});
      if(reply.status!==101||!reply.webSocket){
        this.disconnected('binance','upgrade_http_'+reply.status);return;
      }
      this.registerSocket('binance',reply.webSocket,true);
    }catch(e){
      const reason=e?.name==='TimeoutError'?'upgrade_timeout':'upgrade_fetch_error';
      this.disconnected('binance',reason);
    }
  }
  registerSocket(source,ws,needsAccept=false){
    this.streams.set(source,ws);
    ws.addEventListener('open',()=>{
      if(this.streams.get(source)!==ws)return;
      this.metrics[source].state='connected';this.metrics[source].error=null;
      try{
        if(source==='gate'){
          this.gateMultipliers={};this.lastGateMultiplierFetch=0;
          this.metrics.gate_public_liquidations.subscription_ack=false;
          this.ctx.waitUntil(this.refreshGateMultipliers());
          const time=Math.floor(Date.now()/1000);
          for(const channel of ['futures.trades','futures.tickers','futures.contract_info','futures.public_liquidates'])
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
        if(source==='gate'){
          const state=this.metrics.gate_public_liquidations;
          if(raw.channel==='futures.public_liquidates'&&raw.event==='subscribe'&&raw.result?.status==='success')
            state.subscription_ack=true;
          for(const info of decodeGateContractInfo(raw))this.gateMultipliers[info.symbol]=info.multiplier;
          if(raw.channel==='futures.public_liquidates'&&raw.event==='update'){
            state.updates_received++;
            state.last_update_ms=Date.now();
            const observed=decodeGateLiquidations(raw,this.gateMultipliers);
            if(observed.length){
              state.events_decoded+=observed.length;
              state.last_event_ms=Date.now();
              this.ctx.waitUntil(this.ingestItems(observed));
            }
          }
        }
        if(items.length)this.ctx.waitUntil(this.ingestItems(items));
        if(source==='gate'){
          const previews=decodeGateCandles(raw);
          if(previews.length)this.ctx.waitUntil(this.publishCandles(previews));
        }
      }catch(error){this.metrics[source].error='malformed_exchange_message';}
    });
    ws.addEventListener('close',()=>{if(this.streams.get(source)===ws)this.disconnected(source,'exchange_closed')});
    ws.addEventListener('error',()=>{if(this.streams.get(source)===ws)this.disconnected(source,'exchange_websocket_error')});
    if(needsAccept){
      // fetch Upgrade returns an accepted HTTP 101 socket which does not need
      // Binance SUBSCRIBE. Explicitly accept it to start the CF read loop.
      try{
        ws.accept();
        if(this.streams.get(source)===ws){
          this.metrics[source].state='connected';this.metrics[source].error=null;
        }
      }catch{this.disconnected(source,'upgrade_accept_failed')}
    }
  }
  disconnected(source,reason){
    const ws=this.streams.get(source);if(ws){this.streams.delete(source);try{ws.close()}catch{}}
    const m=this.metrics[source];m.state='reconnecting';m.restarts++;m.error=reason;
    // 403/451 are explicit HTTP access denials, not short-lived feed silence.
    // Avoid hammering Binance's WAF from a shared Cloudflare egress.
    const blocked=source==='binance'&&/^upgrade_http_(403|451)$/.test(reason);
    const denied451=source==='binance'&&reason==='upgrade_http_451';
    const repeated=source==='binance'&&m.restarts>=3;
    const delay=blocked?(denied451?3600000:1800000):
      repeated?Math.max(300000,Math.min(900000,30000*Math.pow(2,Math.min(m.restarts-3,5)))):
      Math.min(60000,2000*Math.pow(2,Math.min(m.restarts,5)));
    this.retryAt[source]=Date.now()+delay;
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
      if(item.kind==='liquidation')item.id=item.source==='binance'?await binanceLiquidationId(item):item.source==='gateio'?await gatePublicLiquidationId(item):await liveLiquidationId(item);
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
    const tickerBase=qAt!==null&&price!==null&&change!==null;
    const bybitTickerOk=tickerBase&&ticker?.source==='bybit_v5_linear';
    const gateTickerOk=tickerBase&&ticker?.source==='gateio_usdt_perpetual_tickers';
    const tickerOk=bybitTickerOk||gateTickerOk;
    const ratioBase=rAt!==null&&ratio?.symbol===symbol&&
      long!==null&&short!==null&&Math.abs(long+short-100)<=2;
    const bybitRatioOk=ratioBase&&ratio?.source==='bybit_v5_account_ratio';
    const gateRatioOk=ratioBase&&ratio?.source==='gateio_futures_contract_stats_user_ratio'&&
      ratio?.data?.exchange==='Gate';
    const ratioOk=bybitRatioOk||gateRatioOk;
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
          bybit_price:bybitTickerOk?price:null,
          gate_price:gateTickerOk?price:null,
          price_exchange:bybitTickerOk?'Bybit':gateTickerOk?'Gate':null,
          change_24h_pct:tickerOk?change:null,
          bybit_accounts_long_pct:bybitRatioOk?long:null,
          bybit_accounts_short_pct:bybitRatioOk?short:null,
          gate_accounts_long_pct:gateRatioOk?long:null,
          gate_accounts_short_pct:gateRatioOk?short:null,
          account_ratio_exchange:bybitRatioOk?'Bybit':gateRatioOk?'Gate':null,
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
          source_status:{bybit_ticker:bybitTickerOk?'available':'unavailable',
            gate_ticker:gateTickerOk?'available':'unavailable',
            bybit_account_ratio:bybitRatioOk?'available':'unavailable',
            gate_account_ratio:gateRatioOk?'available':'unavailable',
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
    const binanceObserved=env.AUTO_BINANCE_LIQUIDATIONS==='true'&&bin!==null;
    // A missing Binance snapshot or BTC-watchlist rollup must not suppress
    // valid Bybit observations (and vice versa). Never substitute zero.
    if(liq!==null||binanceObserved){
      // Section freshness is the rollup generation time, not last trade/event
      // time. Quiet market periods must never be labelled a stream outage.
      const generatedMs=Date.parse(String(events.generated_at||''));
      if(Number.isSafeInteger(generatedMs)&&generatedMs>0)
      sections.observations=termSection('bybit_liquidation_vs_binance_sampled_plus_btc_watchlist',
        Math.floor(generatedMs/1000),300,{
          bybit_liquidation_events_24h:liq,
          binance_liquidation_snapshots_24h:binanceObserved?bin:null,
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

/** Optional source-isolated GitHub Actions Binance public liquidation sampler.
 * GitHub-hosted runners previously connected to Binance while Cloudflare egress
 * was rejected (403). This captures OBSERVED windows only; not continuous feed.
 * No permanent secrets: verify GitHub OIDC RS256 signature, immutable repo ID,
 * owner ID, exact main-branch workflow ref, event type and custom audience.
 */
const GH_BINANCE_AUD='lumex-binance-public-liquidation-v1';
const GH_BINANCE_STATUS_KEY='market-hub/diagnostics/binance-github-sidecar-v1.json';
const GH_BINANCE_PROOF_PREFIX='market-hub/events-source-proof/binance/v1/';
const GH_BINANCE_FALLBACK_KEY='market-hub/diagnostics/binance-cloudflare-dispatch-v1.json';
/** Optional Cloudflare native 5-minute trigger for GitHub's unreliable cron.
 * Only use a restricted repository-scoped GitHub Actions:write token supplied
 * as a CF Worker secret. No token/response body/IP is persisted or logged.
 * Suppress duplicate dispatch if any signed GitHub-sidecar session is recent.
 */
export async function dispatchGithubBinanceIfStale(env,now=Date.now()){
  if(!env.MARKET_DATA)return {ok:false,reason:'r2_missing'};
  const last=await opsReadR2(env,GH_BINANCE_STATUS_KEY);
  const age=now-Number(last?.checked_ms||0);
  if(last?.schema==='lumex_binance_github_public_sidecar_v1'&&age>=0&&age<420000)
    return {ok:true,skipped:'signed_session_recent',age_seconds:Math.floor(age/1000)};
  const token=env.LUMEX_GITHUB_DISPATCH_TOKEN;
  if(typeof token!=='string'||token.length<30)
    return {ok:false,reason:'github_dispatch_secret_not_configured',
      scheduled_github_actions_proven:false};
  const previous=await opsReadR2(env,GH_BINANCE_FALLBACK_KEY);
  const since=now-Number(previous?.attempt_ms||0);
  if(previous?.schema==='lumex_gh_binance_dispatch_v1'&&since>=0&&since<270000)
    return {...previous,skipped:'rate_limited'};
  const body={schema:'lumex_gh_binance_dispatch_v1',attempt_ms:now,
    result:'pending',status_code:null,source:'cloudflare_5m_cron',
    target:'github_actions_public_binance_sidecar',
    no_private_exchange_access:true,cron_retirement_allowed:false};
  await env.MARKET_DATA.put(GH_BINANCE_FALLBACK_KEY,JSON.stringify(body),
    {httpMetadata:{contentType:'application/json'}});
  try{
    const res=await fetch('https://api.github.com/repos/lghee/lumex-ai-research/actions/workflows/lumex-binance-public-sidecar.yml/dispatches',{
      method:'POST',headers:{authorization:'Bearer '+token,accept:'application/vnd.github+json',
        'content-type':'application/json','user-agent':'LUMEX-Public-Collector/1.0'},
      body:JSON.stringify({ref:'main'}),signal:AbortSignal.timeout(10000)});
    body.status_code=res.status;
    body.result=res.status===204?'dispatched':'github_http_'+res.status;
  }catch{body.result='github_dispatch_transport_error'}
  await env.MARKET_DATA.put(GH_BINANCE_FALLBACK_KEY,JSON.stringify(body),
    {httpMetadata:{contentType:'application/json'}});
  return {ok:body.result==='dispatched',...body};
}

/** Persistent, source-attributed authenticated Binance raw observation backup.
 * Mirrors validated DO-accepted events to deterministic R2 object keys and
 * performs read-after-write byte equality before claiming persistence.
 * This is a separate R2 source proof, not a substitute for the EventHub archive.
 */
export async function persistGithubBinanceSourceProof(env,events,now=Date.now()){
  if(!Array.isArray(events)||events.length>30||!env.MARKET_DATA)return null;
  let latestKey=null,latestMs=0,verified=0;
  for(const ev of events){
    if(ev?.kind!=='liquidation'||ev?.source!=='binance'||
      !HUB_SYMBOLS.includes(ev?.symbol)||
      typeof ev.id!=='string'||!/^binance:liq:(BTCUSDT|ETHUSDT|SOLUSDT|XRPUSDT):[a-f0-9]{32}$/.test(ev.id)||
      !Number.isSafeInteger(ev.ts)||ev.ts>now+120000||ev.ts<now-3600000)
      throw Error('binance_source_proof_invalid_event');
    const hour=new Date(ev.ts).toISOString().slice(0,13).replaceAll('-','/').replace('T','/');
    const key=GH_BINANCE_PROOF_PREFIX+hour+'/'+ev.id.replaceAll(':','_')+'.json';
    const document={schema:'lumex_binance_public_observation_r2_v1',source:'binance',
      market:'binance_usdm_forceorder',event:ev,observed_only:true,
      full_market_coverage:false,orders_enabled:false};
    const raw=JSON.stringify(document);
    await env.MARKET_DATA.put(key,raw,{httpMetadata:{contentType:'application/json'}});
    const stored=await env.MARKET_DATA.get(key);
    if(!stored||await stored.text()!==raw)throw Error('binance_r2_readback_mismatch');
    verified++;
    if(ev.ts>=latestMs){latestMs=ev.ts;latestKey=key;}
  }
  return {verified,last_key:latestKey,last_event_ms:latestMs};
}

let ghJwksCache=null;
function ghJwtBytes(s){
  if(typeof s!=='string'||s.length<1||s.length>10000||!/^[A-Za-z0-9_-]+$/.test(s))throw Error('jwt_b64_invalid');
  const b=atob(s.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-s.length%4)%4));
  return Uint8Array.from(b,c=>c.charCodeAt(0));
}
async function ghTrustedJwks(){
  if(ghJwksCache&&ghJwksCache.until>Date.now())return ghJwksCache.keys;
  const r=await fetch('https://token.actions.githubusercontent.com/.well-known/jwks',{
    headers:{accept:'application/json'},signal:AbortSignal.timeout(6000)});
  if(!r.ok)throw Error('github_oidc_jwks_unavailable');
  const j=await r.json();
  if(!Array.isArray(j?.keys)||j.keys.length<1||j.keys.length>24)throw Error('github_oidc_jwks_invalid');
  ghJwksCache={until:Date.now()+600000,keys:j.keys};
  return j.keys;
}
export async function verifyGithubBinanceOidc(token,now=Date.now(),jwksLoader=ghTrustedJwks){
  try{
    if(typeof token!=='string'||token.length>15000||token.length<100)return null;
    const segments=token.split('.');
    if(segments.length!==3)return null;
    const h=JSON.parse(new TextDecoder().decode(ghJwtBytes(segments[0])));
    const c=JSON.parse(new TextDecoder().decode(ghJwtBytes(segments[1])));
    const t=Math.floor(now/1000);
    if(h?.alg!=='RS256'||typeof h.kid!=='string'||h.kid.length>160||
      c?.iss!=='https://token.actions.githubusercontent.com'||
      c?.aud!==GH_BINANCE_AUD||
      c?.repository!=='lghee/lumex-ai-research'||
      String(c?.repository_id)!=='1455460180'||
      String(c?.repository_owner_id)!=='123610810'||
      // GitHub allows per-repository OIDC subject templates. The signed
      // immutable repository_id + owner_id and exact main workflow/ref below
      // are the trust boundary; never rely on a particular customizable sub.
      typeof c?.sub!=='string'||c.sub.length<1||c.sub.length>1024||
      c?.ref!=='refs/heads/main'||
      c?.workflow_ref!=='lghee/lumex-ai-research/.github/workflows/lumex-binance-public-sidecar.yml@refs/heads/main'||
      !['schedule','workflow_dispatch'].includes(c?.event_name)||
      c?.runner_environment!=='github-hosted'||
      !/^\d{5,16}$/.test(String(c?.run_id||''))||
      !Number.isSafeInteger(c.iat)||!Number.isSafeInteger(c.exp)||
      c.iat>t+30||c.exp<=t||c.exp>t+900||t-c.iat>480||
      (c.nbf!==undefined&&(!Number.isSafeInteger(c.nbf)||c.nbf>t+30)))return null;
    const keys=await jwksLoader();
    const jwk=Array.isArray(keys)?keys.find(k=>k.kid===h.kid&&k.kty==='RSA'&&k.n&&k.e):null;
    if(!jwk)return null;
    const key=await crypto.subtle.importKey('jwk',{kty:'RSA',n:jwk.n,e:jwk.e},
      {name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
    const ok=await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,
      ghJwtBytes(segments[2]),new TextEncoder().encode(segments[0]+'.'+segments[1]));
    return ok?{run_id:String(c.run_id),event_name:c.event_name,issued_at:c.iat}:null;
  }catch{return null}
}
/** Separate OIDC audience and exact workflow, never authorized as Binance sidecar. */
export async function verifyGithubOfficialBlsOidc(token,now=Date.now(),jwksLoader=ghTrustedJwks){
  try{
    if(typeof token!=='string'||token.length<100||token.length>15000)return null;
    const p=token.split('.');if(p.length!==3)return null;
    const h=JSON.parse(new TextDecoder().decode(ghJwtBytes(p[0])));
    const c=JSON.parse(new TextDecoder().decode(ghJwtBytes(p[1])));
    const t=Math.floor(now/1000);
    if(h?.alg!=='RS256'||typeof h.kid!=='string'||h.kid.length>160||
      c?.iss!=='https://token.actions.githubusercontent.com'||
      c?.aud!=='lumex-official-bls-v1'||
      c?.repository!=='lghee/lumex-ai-research'||
      String(c?.repository_id)!=='1455460180'||
      String(c?.repository_owner_id)!=='123610810'||
      typeof c?.sub!=='string'||c.sub.length<1||c.sub.length>1024||
      c?.ref!=='refs/heads/main'||
      c?.workflow_ref!=='lghee/lumex-ai-research/.github/workflows/lumex-official-bls-sidecar.yml@refs/heads/main'||
      !['schedule','workflow_dispatch','push'].includes(c?.event_name)||
      c?.runner_environment!=='github-hosted'||
      !/^\d{5,16}$/.test(String(c?.run_id||''))||
      !Number.isSafeInteger(c.iat)||!Number.isSafeInteger(c.exp)||
      c.iat>t+30||c.exp<=t||c.exp>t+900||t-c.iat>480||
      (c.nbf!==undefined&&(!Number.isSafeInteger(c.nbf)||c.nbf>t+30)))return null;
    const jwks=await jwksLoader();
    const keyData=Array.isArray(jwks)?jwks.find(k=>k.kid===h.kid&&k.kty==='RSA'&&k.n&&k.e):null;
    if(!keyData)return null;
    const key=await crypto.subtle.importKey('jwk',{kty:'RSA',n:keyData.n,e:keyData.e},
      {name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
    const ok=await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,
      ghJwtBytes(p[2]),new TextEncoder().encode(p[0]+'.'+p[1]));
    return ok?{run_id:String(c.run_id),event_name:c.event_name,issued_at:c.iat}:null;
  }catch{return null}
}

export async function normalizeGithubBinanceFrames(frames,now=Date.now()){
  if(!Array.isArray(frames)||frames.length>30)return null;
  const results=[],ids=new Set();
  for(const f of frames){
    if(!f||typeof f!=='object'||Array.isArray(f)||JSON.stringify(f).length>4000)return null;
    for(const e of decodeBinanceLiquidations(f,now)){
      const id=await binanceLiquidationId(e);
      if(ids.has(id))continue;
      ids.add(id);results.push({...e,id});
    }
  }
  return results;
}

const EXT_BINANCE_RELAY_HEALTH='market-hub/diagnostics/binance-external-relay-v1.json';
async function externalBinanceAuthorized(request,env){
  const expected=env.LUMEX_BINANCE_RELAY_SECRET;
  if(typeof expected!=='string'||expected.length<48||expected.length>200)return false;
  const provided=request.headers.get('authorization')||'';
  if(!provided.startsWith('Bearer ')||provided.length>256)return false;
  const enc=new TextEncoder();
  const digest=await Promise.all([provided.slice(7),expected].map(async str=>
    new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(str)))));
  let diff=0;
  for(let i=0;i<32;i++)diff|=digest[0][i]^digest[1][i];
  return diff===0;
}
/** Strict 24/7 external egress for *public* Binance forceOrder events.
 * No WordPress execution, no credentials/trading, no fabricated backfill.
 * Deploying this endpoint does NOT itself retire any cPanel cron.
 */
export async function externalBinanceRelayRoute(request,env,now=Date.now()){
  if(!env.MARKET_EVENT_HUB||!env.MARKET_DATA||typeof env.LUMEX_BINANCE_RELAY_SECRET!=='string'||
     env.LUMEX_BINANCE_RELAY_SECRET.length<48)
    return hubReply({ok:false,error:'binance_relay_not_configured'},503);
  if(!(await externalBinanceAuthorized(request,env)))
    return hubReply({ok:false,error:'unauthorized'},401);
  const raw=await request.text();
  if(raw.length>56000)return hubReply({ok:false,error:'body_oversize'},413);
  let body;try{body=JSON.parse(raw)}catch{return hubReply({ok:false,error:'bad_json'},400)}
  if(body?.schema!=='lumex_binance_public_relay_v1'||
     !/^[a-f0-9-]{30,50}$/.test(String(body.session_id||''))||
     !Number.isSafeInteger(body.observed_ms)||Math.abs(now-body.observed_ms)>90000||
     typeof body.connected!=='boolean'||
     !Number.isSafeInteger(body.provider_messages)||body.provider_messages<0||
     !Number.isSafeInteger(body.dropped_events)||body.dropped_events<0||
     !Array.isArray(body.frames)||body.frames.length>30)
    return hubReply({ok:false,error:'bad_relay_envelope'},400);
  const events=await normalizeGithubBinanceFrames(body.frames,now);
  if(events===null)return hubReply({ok:false,error:'bad_source_frames'},400);
  let accepted=0,invalid=0;
  for(const symbol of HUB_SYMBOLS){
    const items=events.filter(e=>e.symbol===symbol);
    if(!items.length)continue;
    const r=await env.MARKET_EVENT_HUB.getByName(symbol).fetch(
      new Request('https://hub/ingest',{method:'POST',
        headers:{'content-type':'application/json'},body:JSON.stringify({symbol,events:items})}));
    if(!r.ok)return hubReply({ok:false,error:'relay_hub_ingest_failed',retry_allowed:true},503);
    const x=await r.json();
    accepted+=Number(x.accepted||0);invalid+=Number(x.invalid||0);
  }
  let proof;
  try{proof=await persistGithubBinanceSourceProof(env,events,now);}
  catch{return hubReply({ok:false,error:'relay_r2_readback_failed',retry_allowed:true},503)}
  const old=await opsReadR2(env,EXT_BINANCE_RELAY_HEALTH);
  const contiguous=body.connected&&body.dropped_events===0&&
    old?.schema==='lumex_binance_external_relay_status_v1'&&
    old.connected===true&&old.dropped_events===0&&
    old.session_id===body.session_id&&now-Number(old.received_ms||0)<=90000;
  const since=contiguous?Number(old.continuous_since_ms||now):now;
  const health={schema:'lumex_binance_external_relay_status_v1',
    ok:true,source:'external_public_binance_ws_relay',received_ms:now,
    session_id:body.session_id,connected:body.connected,
    provider_messages:body.provider_messages,dropped_events:body.dropped_events,
    accepted_this_batch:accepted,invalid_this_batch:invalid,
    total_accepted:Number(old?.total_accepted||0)+accepted,
    last_event_ms:proof.last_event_ms||Number(old?.last_event_ms||0),
    last_source_proof_key:proof.last_key||String(old?.last_source_proof_key||''),
    source_r2_readback_verified:proof.verified>0||old?.source_r2_readback_verified===true,
    continuous_since_ms:since,
    observed_only:true,complete_market_capture:false,
    cron_retirement_allowed:false};
  await env.MARKET_DATA.put(EXT_BINANCE_RELAY_HEALTH,JSON.stringify(health),
    {httpMetadata:{contentType:'application/json'}});
  return hubReply({ok:true,accepted,invalid,
    source_r2_readback_verified:proof.verified,
    source:'binance_usdm_public_forceorder',cron_retirement_allowed:false});
}
export async function externalBinanceRelayHealth(env,now=Date.now()){
  const status=await opsReadR2(env,EXT_BINANCE_RELAY_HEALTH);
  if(status?.schema!=='lumex_binance_external_relay_status_v1')
    return {ok:false,reason:'relay_never_connected',configured:typeof env.LUMEX_BINANCE_RELAY_SECRET==='string'&&
      env.LUMEX_BINANCE_RELAY_SECRET.length>=48,cron_retirement_allowed:false};
  return {...status,stale:now-Number(status.received_ms||0)>90000,
    verified_contiguous_seconds:status.connected===true&&status.dropped_events===0&&
      now-Number(status.received_ms||0)<=90000?
      Math.max(0,Math.floor((now-Number(status.continuous_since_ms||now))/1000)):0,
    cron_retirement_allowed:false};
}

async function githubBinanceSidecarRoute(request,env){
  const bearer=request.headers.get('authorization')||'';
  if(!bearer.startsWith('Bearer ')||!env.MARKET_EVENT_HUB||!env.MARKET_DATA)
    return hubReply({ok:false,error:'unauthorized_or_bindings_missing'},401);
  const claim=await verifyGithubBinanceOidc(bearer.slice(7));
  if(!claim)return hubReply({ok:false,error:'github_oidc_not_authorized'},401);
  const bodyText=await request.text();
  if(bodyText.length>56000)return hubReply({ok:false,error:'oversize'},413);
  let body;try{body=JSON.parse(bodyText)}catch{return hubReply({ok:false,error:'invalid_json'},400)}
  if(body?.schema!=='lumex_binance_public_sidecar_v1'||
    String(body.run_id)!==claim.run_id||body.route!=='binance_usdm_forceorder_ws'||
    typeof body.connected!=='boolean'||!Number.isSafeInteger(body.started_ms)||
    body.started_ms>Date.now()+120000||body.started_ms<Date.now()-3600000)
    return hubReply({ok:false,error:'bad_sidecar_envelope'},400);
  const acceptedRows=await normalizeGithubBinanceFrames(body.frames,Date.now());
  if(acceptedRows===null)return hubReply({ok:false,error:'invalid_frames'},400);
  let accepted=0,invalid=0;
  for(const symbol of HUB_SYMBOLS){
    const events=acceptedRows.filter(x=>x.symbol===symbol);
    if(!events.length)continue;
    const response=await env.MARKET_EVENT_HUB.getByName(symbol).fetch(new Request('https://hub/ingest',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({symbol,events})}));
    if(!response.ok)return hubReply({ok:false,error:'hub_ingest_failed'},503);
    const out=await response.json();accepted+=Number(out.accepted||0);invalid+=Number(out.invalid||0);
  }
  // Persist every normalized Binance public event in a source-isolated R2
  // backup and read back exact bytes. The main EventHub's JSONL archive stays
  // independent and is verified by its own continuity audit.
  let r2Proof;
  try{r2Proof=await persistGithubBinanceSourceProof(env,acceptedRows);}
  catch{return hubReply({ok:false,error:'binance_source_r2_persistence_failed',
    retry_allowed:true,cron_retirement_allowed:false},503)}
  // This status records observed session attempts; only R2 JSONL readback
  // proves durable historical event capture.
  const old=await opsReadR2(env,GH_BINANCE_STATUS_KEY);
  const current=Date.now();
  const health={schema:'lumex_binance_github_public_sidecar_v1',
    ok:true,source:'github_actions_public_ws_observation',checked_ms:current,
    run_id:claim.run_id,connected:body.connected,
    provider_messages_accepted:Number.isSafeInteger(body.provider_messages)&&body.provider_messages>=0?
      Math.min(body.provider_messages,100000):0,
    last_accepted_ms:accepted>0?current:Number(old?.last_accepted_ms||0),
    accepted_this_request:accepted,invalid_this_request:invalid,
    total_accepted:Number(old?.total_accepted||0)+accepted,
    session_event:claim.event_name,
    last_scheduled_ms:claim.event_name==='schedule'?current:Number(old?.last_scheduled_ms||0),
    r2_source_proof_verified:r2Proof.verified,
    r2_source_proof_key:r2Proof.last_key||String(old?.r2_source_proof_key||''),
    r2_source_proof_last_event_ms:r2Proof.last_event_ms||Number(old?.r2_source_proof_last_event_ms||0),
    r2_source_proof_last_run_ms:r2Proof.verified?current:Number(old?.r2_source_proof_last_run_ms||0),
    coverage:'scheduled_observation_windows_only_not_continuous',
    remote_egress:true,complete_market_capture:false,
    r2_archive:'pending_hub_alarm',cron_retirement_allowed:false,
    trading_enabled:false};
  await env.MARKET_DATA.put(GH_BINANCE_STATUS_KEY,JSON.stringify(health),
    {httpMetadata:{contentType:'application/json'}});
  return hubReply({ok:true,accepted,invalid,archive:'pending_r2_flush',
    source_r2_verified:r2Proof.verified,source_r2_readback:true,
    observed_window_only:true,run_id:claim.run_id},200);
}

const BINANCE_EGRESS_PROOF_KEY='market-hub/diagnostics/binance-container-egress-v1.json';
/** Once-per-30min container egress handshake proof. Never executes trades or
 * polls private Binance endpoints, never treats HTTP 403 as empty market data.
 * This is a capability diagnostic, NOT a data source or Cron retirement proof. */
export async function probeBinanceContainerEgress(env,now=Date.now()){
  if(env.AUTO_BINANCE_CONTAINER_EGRESS_PROBE!=='true'||
    !env.MARKET_DATA||!env.RESEARCH_CONTAINER||!env.LUMEX_CONTAINER_KEY)
    return {ok:false,enabled:false,reason:'probe_disabled_or_bindings_missing'};
  const previous=await opsReadR2(env,BINANCE_EGRESS_PROOF_KEY);
  if(previous?.schema==='lumex_binance_egress_proof_v1'&&
     Number.isSafeInteger(previous.checked_ms)&&previous.checked_ms<=now+60000&&
     now-previous.checked_ms<1800000)return {...previous,cached:true};
  let proof={schema:'lumex_binance_egress_proof_v1',ok:false,checked_ms:now,
    source:'cloudflare_existing_research_container',scope:'handshake_only',
    status:'unavailable',handshake_http_status:null,trading_enabled:false,
    does_not_prove_feed_capture:true};
  try{
    const response=await invokeContainer(env,'/binance-egress-probe',{scope:'public_usdm_forceOrder'});
    const body=await response.json();
    const code=Number(body?.handshake_http_status);
    proof={...proof,ok:body?.ok===true,handshake_http_status:
        Number.isSafeInteger(code)&&code>=100&&code<=599?code:null,
      status:body?.ok===true&&code===101?'upgrade_accepted':
        body?.error_code==='upstream_http_forbidden'?'upstream_403':
        body?.error_code==='upstream_unavailable'?'upstream_unavailable':'handshake_rejected'};
  }catch(error){
    const code=safeError(error);
    if(code.includes('container_image_contract_mismatch'))proof.status='container_image_contract_mismatch';
    else if(code.includes('container_image_health_unavailable'))proof.status='container_image_health_unavailable';
    else if(code.includes('container_image_rotation_failed'))proof.status='container_image_rotation_failed';
    else if(code.includes('container_inspection_failed'))proof.status='container_inspection_failed';
    else if(code.includes('container_start_timeout'))proof.status='container_start_timeout';
    else if(code.includes('container_binance-egress-probe_404'))proof.status='container_endpoint_missing';
    console.warn('binance_container_proof_unavailable',code.slice(0,75));
  }
  await env.MARKET_DATA.put(BINANCE_EGRESS_PROOF_KEY,JSON.stringify(proof),
    {httpMetadata:{contentType:'application/json'}});
  return proof;
}


/** Phase 9: Binance read-only source inside the EXISTING Cloudflare ResearchContainer.
 * Does not allocate a VPS, proxy forbidden origins, or claim unsampled events.
 * A recent successful Cloudflare-container HTTP Upgrade probe is REQUIRED.
 * The container may be suspended/restarted; every session, cursor gap and lost
 * buffered message invalidates continuous coverage. Cron is never auto-deleted.
 */
const CF_BINANCE_CAPTURE_KEY='market-hub/diagnostics/binance-cloudflare-capture-v1.json';
export async function pollCloudflareBinanceCapture(env,now=Date.now()){
  if(env.AUTO_BINANCE_CLOUDFLARE_CAPTURE!=='true')
    return {ok:false,reason:'disabled'};
  if(!env.MARKET_DATA||!env.MARKET_EVENT_HUB||!env.RESEARCH_CONTAINER||
      typeof env.LUMEX_CONTAINER_KEY!=='string'||env.LUMEX_CONTAINER_KEY.length<32)
    return {ok:false,reason:'required_cloudflare_binding_missing'};
  const probe=await opsReadR2(env,BINANCE_EGRESS_PROOF_KEY);
  if(probe?.schema!=='lumex_binance_egress_proof_v1'||
      probe.ok!==true||probe.status!=='upgrade_accepted'||
      probe.handshake_http_status!==101||
      !Number.isSafeInteger(probe.checked_ms)||probe.checked_ms>now+60000||
      now-probe.checked_ms>3600000)
    return {ok:false,reason:'cloudflare_egress_not_authorized',
      proof_checked:probe?.schema==='lumex_binance_egress_proof_v1',
      proof_status:probe?.status||'not_tested',source:'existing_cloudflare_research_container',
      continuous_capture_verified:false};
  let prev=await opsReadR2(env,CF_BINANCE_CAPTURE_KEY);
  if(prev?.schema!=='lumex_binance_cloudflare_status_v1')prev=null;
  let cursorSession=String(prev?.session_id||''),afterSeq=Number(prev?.checkpoint_seq||0);
  if(!Number.isSafeInteger(afterSeq)||afterSeq<0)return {ok:false,reason:'invalid_previous_checkpoint'};
  let totalAccepted=0,totalFrames=0,totalReadback=0,gap=false,sessionChanged=false;
  let sourceState=null,finished=false;
  try{
    for(let batch=0;batch<4;batch++){
      const response=await invokeContainer(env,'/binance-cloudflare-capture',{
        scope:'public_usdm_forceOrder',cursor_session:cursorSession,
        after_seq:afterSeq,limit:25});
      const payload=await response.json();
      if(payload?.schema!=='lumex_cloudflare_binance_container_v1'||
         typeof payload.session_id!=='string'||
         !/^[a-f0-9-]{32,40}$/.test(payload.session_id)||
         typeof payload.connected!=='boolean'||
         !Number.isSafeInteger(payload.dropped_events)||payload.dropped_events<0||
         !Number.isSafeInteger(payload.latest_seq)||payload.latest_seq<0||
         !Array.isArray(payload.frames)||payload.frames.length>25||
         typeof payload.cursor_gap!=='boolean'||typeof payload.session_changed!=='boolean')
        throw Error('cloudflare_container_schema_invalid');
      sourceState=payload;
      if(cursorSession&&cursorSession!==payload.session_id)sessionChanged=true;
      if(payload.session_changed&&cursorSession)sessionChanged=true;
      if(payload.cursor_gap||payload.dropped_events>0)gap=true;
      if(cursorSession!==payload.session_id){
        cursorSession=payload.session_id;
        afterSeq=0;
      }
      let nextSeq=afterSeq,items=[];
      for(const item of payload.frames){
        if(!Number.isSafeInteger(item?.seq)||item.seq<=nextSeq||
           item.seq>payload.latest_seq||decodeBinanceLiquidations(item.frame,now).length!==1)
          throw Error('cloudflare_container_frame_invalid');
        nextSeq=item.seq;
        items.push(item.frame);
      }
      if(items.length){
        const events=await normalizeGithubBinanceFrames(items,now);
        if(events===null)throw Error('cloudflare_container_source_invalid');
        for(const symbol of HUB_SYMBOLS){
          const chosen=events.filter(e=>e.symbol===symbol);
          if(!chosen.length)continue;
          const reply=await env.MARKET_EVENT_HUB.getByName(symbol).fetch(
            new Request('https://hub/ingest',{method:'POST',
              headers:{'content-type':'application/json'},
              body:JSON.stringify({symbol,events:chosen})}));
          if(!reply.ok)throw Error('cloudflare_capture_hub_ingest_failed');
          const result=await reply.json();
          totalAccepted+=Number(result.accepted||0);
        }
        const proof=await persistGithubBinanceSourceProof(env,events,now);
        if(!proof||proof.verified!==events.length)
          throw Error('cloudflare_capture_r2_proof_invalid');
        totalReadback+=proof.verified;
      }
      totalFrames+=items.length;
      afterSeq=nextSeq;
      const priorFresh=prev&&prev.connected===true&&!prev.stale&&
        now-Number(prev.checked_ms||0)<=120000;
      const sameSession=prev?.session_id===cursorSession;
      const uninterrupted=Boolean(priorFresh&&sameSession&&!gap&&!sessionChanged&&
        Number(prev.dropped_events||0)===payload.dropped_events&&payload.connected);
      const since=uninterrupted?Number(prev.continuous_since_ms||now):now;
      const status={schema:'lumex_binance_cloudflare_status_v1',
        ok:true,source:'cloudflare_existing_research_container_binance_public_ws',
        checked_ms:now,session_id:cursorSession,checkpoint_seq:afterSeq,
        connected:payload.connected,source_last_frame_ms:Number(payload.last_frame_ms||0),
        dropped_events:payload.dropped_events,
        error_code:String(payload.error_code||'').slice(0,75),
        retry_at_ms:Number(payload.next_retry_ms||0),
        gap_detected:gap||sessionChanged||!payload.connected,
        continuous_since_ms:since,
        accepted_this_poll:totalAccepted,frames_this_poll:totalFrames,
        total_accepted:Number(prev?.total_accepted||0)+totalAccepted,
        r2_readback_this_poll:totalReadback,
        source_r2_readback_verified:totalReadback>0||
          prev?.source_r2_readback_verified===true,
        observed_only:true,complete_market_capture:false,
        cron_retirement_allowed:false,orders_enabled:false};
      // Only checkpoint AFTER EventHub ingest and source R2 read-after-write.
      await env.MARKET_DATA.put(CF_BINANCE_CAPTURE_KEY,JSON.stringify(status),
        {httpMetadata:{contentType:'application/json'}});
      prev={...status,stale:false};
      if(payload.frames.length<25||afterSeq>=payload.latest_seq){
        finished=true;break;
      }
    }
    return {ok:true,source:'cloudflare_existing_research_container',
      connected:sourceState?.connected===true,frames:totalFrames,accepted:totalAccepted,
      readback:totalReadback,gap_detected:gap||sessionChanged,
      caught_up:finished,continuous_market_capture_proven:false,
      cron_retirement_allowed:false};
  }catch(error){
    // Preserve the last fully verified checkpoint; never mark a failed poll as
    // healthy or advance its cursor. Retries are deduplicated by event ID.
    return {ok:false,reason:String(error?.message||'cloudflare_capture_failed')
      .replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,75),
      frames_verified:totalReadback,cron_retirement_allowed:false};
  }
}
export async function cloudflareBinanceHealth(env,now=Date.now()){
  const status=await opsReadR2(env,CF_BINANCE_CAPTURE_KEY);
  const proof=await opsReadR2(env,BINANCE_EGRESS_PROOF_KEY);
  if(status?.schema!=='lumex_binance_cloudflare_status_v1'){
    return {ok:false,source:'cloudflare_existing_research_container',
      reason:'no_verified_container_capture',
      probe_status:proof?.schema==='lumex_binance_egress_proof_v1'?
        proof.status:'not_tested',connected:false,stale:true,
      continuous_seconds:0,source_r2_readback_verified:false,
      complete_market_capture:false,cron_retirement_allowed:false};
  }
  const stale=now-Number(status.checked_ms||0)>120000;
  return {...status,stale,connected:status.connected===true&&!stale,
    continuous_seconds:status.connected===true&&!stale&&!status.gap_detected?
      Math.max(0,Math.floor((now-Number(status.continuous_since_ms||now))/1000)):0,
    probe_status:proof?.status||'unknown',complete_market_capture:false,
    cron_retirement_allowed:false};
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
  const existing=await opsReadR2(env,key);
  if(existing?.schema==='lumex_ops_daily_v1'&&existing.date===date&&
     Number.isSafeInteger(existing.passed)&&Number.isSafeInteger(existing.enabled_checks)&&
     typeof existing.ready==='boolean'&&
     typeof existing.liquidation_r2_sample_verified==='boolean')
    return {ok:true,already_saved:true,date};
  // A partial or malformed R2 object must not block the daily retry.
  // Only replace the current UTC date; never fabricate historical proof.
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
      return {date,status:'missing',reason:x?'invalid_record':'absent_record'};
    return {date,status:'recorded',passed:x.passed,enabled_checks:x.enabled_checks,
      ready:x.ready,r2_liquidation_verified:x.liquidation_r2_sample_verified,
      r2_list_errors:Number.isSafeInteger(x.r2_list_errors)?x.r2_list_errors:null};
  }));
  return {ok:true,schema:'lumex_market_ops_history_v1',days:7,items:results,
    incomplete_days:results.filter(x=>x.status!=='recorded').length,
    qa_daily_enabled:env.AUTO_MARKET_QA_DAILY==='true',
    r2_binding_present:!!env.MARKET_DATA,
    current_utc_date:new Date(now).toISOString().slice(0,10),
    safe_to_disable_wordpress_crons:false};
}

const HUB_HOUR_MS=3600000;
const HUB_LONG_RETENTION_DAYS=35;
const HUB_SHORT_RETENTION_DAYS=14;
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


/** Source-separated, bounded observed-only analytics from the hot DO event ledger.
 * Never substitutes legacy WordPress archives or reports market-wide totals.
 */
export function observedAnalyticView(sql, u, now=Date.now(),longSince=now) {
  const view=u.pathname==='/observed-pressure'?'pressure':u.pathname==='/observed-replay'?'replay':null;
  if(!view)return hubReply({ok:false,error:'unknown_observed_view'},404);
  const start=view==='pressure'?now-195*60000:Number(u.searchParams.get('start_ms'));
  const end=view==='pressure'?now+1:Number(u.searchParams.get('end_ms'));
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=end||
     start<now-HUB_LONG_RETENTION_DAYS*86400000||
     (view==='replay' && start<now-HUB_SHORT_RETENTION_DAYS*86400000 && start<longSince)||
     end>now+60000||
     (view==='replay'&&end-start>14400000))
    return hubReply({ok:false,error:'observed_window_out_of_hot_retention'},422);
  // The limit prevents an unbounded customer query; overflow is explicitly reported.
  const rows=sql.exec(
    "SELECT ts,source,payload FROM hub_events WHERE kind='liquidation' AND source IN ('bybit','binance') AND ts>=? AND ts<? ORDER BY ts ASC LIMIT 20001",
    start,end).toArray();
  if(rows.length>20000)return hubReply({ok:false,error:'observed_event_count_exceeds_safe_limit',coverage:'partial'},503);
  const bins=new Map(),events=[],bySource={Bybit:0,Binance:0};let invalid=0;
  // Exact rolling windows are calculated before any detail-list truncation or minute bucketing.
  const blank=()=>({usd:0,count:0,long:0,short:0});
  const exact=Object.fromEntries(['Bybit','Binance'].map(source=>[source,{
    windows:Object.fromEntries([5,15,60].map(m=>[m+'m',blank()])),
    reference:Array.from({length:12},blank)
  }]));
  const accumulate=(cell,amount,side)=>{cell.usd+=amount;cell.count++;cell[side]+=amount;};
  for(const row of rows){
    const source=row.source==='bybit'?'Bybit':row.source==='binance'?'Binance':null;
    if(!source){invalid++;continue}
    let e;try{e=JSON.parse(String(row.payload))}catch{invalid++;continue}
    const ts=Number(row.ts),price=Number(e?.price),qty=Number(e?.quantity),side=e?.position_side;
    if(!Number.isSafeInteger(ts)||ts<start||ts>=end||
      !Number.isFinite(price)||price<=0||!Number.isFinite(qty)||qty<=0||
      !['long','short'].includes(side)){invalid++;continue}
    const amount=price*qty;
    if(!Number.isFinite(amount)||amount<=0||amount>1e15){invalid++;continue}
    bySource[source]++;
    if(view==='pressure'){
      const age=now-ts;
      for(const m of [5,15,60])if(age<m*60000)accumulate(exact[source].windows[m+'m'],amount,side);
      if(age>=900000&&age<11700000){
        const i=Math.floor((age-900000)/900000);
        accumulate(exact[source].reference[i],amount,side);
      }
      const bucket=Math.floor(ts/60000)*60000,key=bucket+'|'+source+'|'+side;
      const acc=bins.get(key)||{bucket_ms:bucket,exchange:source,side,events:0,notional_estimate_usd:0};
      acc.events++;acc.notional_estimate_usd+=amount;bins.set(key,acc);
    }else{
      events.push({id:String(e.id||'').slice(0,180),ts,exchange:source,side,price,quantity:qty,
        amount_usd_estimate:Number(amount.toFixed(2)),price_type:String(e.price_type||'unspecified'),
        capture:source==='Bybit'?'public_stream':'sampled_1s'});
    }
  }
  if(invalid>0)return hubReply({ok:false,error:'observed_invalid_rows',invalid_rows:invalid},503);
  const common={ok:true,order_execution:false,market_total_estimate:false,
    source_scope:'hot_public_liquidation_observations_only',
    coverage:'observed_only_no_gap_backfill',from_ms:start,to_ms:end,
    query_generated_ms:now,exchange_counts:bySource,
    notional_basis:'observed_price_times_native_quantity_estimate_not_market_total',
    provider_comparability:'not_comparable'};
  if(view==='pressure'){
    return hubReply({...common,schema:'lumex_observed_pressure_v1',window_minutes:195,
      exact_windows:exact,bins:[...bins.values()].sort((a,b)=>a.bucket_ms-b.bucket_ms)});
  }
  // Calculate the complete four-hour pressure distribution BEFORE limiting
  // the detailed list. Never present a truncated list sum as an entire session.
  const buckets=new Map();
  const summary={long_usd_estimate:0,short_usd_estimate:0,long_count:0,short_count:0};
  for(const e of events){
    const step=Math.floor((e.ts-start)/300000),k=step+'|'+e.exchange;
    const b=buckets.get(k)||{bucket_ms:start+step*300000,exchange:e.exchange,
      long_usd_estimate:0,short_usd_estimate:0,long_count:0,short_count:0};
    b[e.side+'_usd_estimate']+=e.amount_usd_estimate;
    b[e.side+'_count']++;
    summary[e.side+'_usd_estimate']+=e.amount_usd_estimate;
    summary[e.side+'_count']++;
    buckets.set(k,b);
  }
  const max=2000,limited=events.length>max;
  return hubReply({...common,schema:'lumex_observed_replay_v1',
    events:events.slice(0,max),events_total_in_hot_window:events.length,
    bins_5m:[...buckets.values()].sort((a,b)=>a.bucket_ms-b.bucket_ms),
    summary_estimate:summary,truncated:limited,event_limit:max,hot_retention_days:HUB_LONG_RETENTION_DAYS,
    market_samples:[],market_samples_status:'not_included_use_verified_R2_candles_separately'});
}


/** Authenticated BTC reserve-movement × public-liquidation cross-window query.
 * Each provider is isolated; no WordPress SQL is read or compared here.
 * Hot DO records are at most 14 days; older windows are marked uncovered.
 */
export function whaleLiqCrossTimestamps(input, now=Date.now()) {
  if(typeof input!=='string'||input.length>200||!/^([0-9]{10})(,[0-9]{10}){0,11}$/.test(input))
    return null;
  const values=input.split(',').map(Number);
  if(values.length>12||new Set(values).size!==values.length||
     values.some(t=>!Number.isSafeInteger(t)||t<1500000000||t>Math.floor(now/1000)+120))
    return null;
  return values;
}
export function whaleLiqCrossQuery(sql,timestamps,now=Date.now()){
  const retentionStart=now-14*86400000;
  const rows=[],uncovered=[];
  for(let index=0;index<timestamps.length;index++){
    const ts=timestamps[index]*1000;
    if(ts<retentionStart){uncovered.push(index);continue}
    const end=Math.min(now,ts+14400000);
    if(end<=ts)continue;
    const first=Math.min(now,ts+3600000);
    // SQLite json_extract operates only on validated normalized public observations.
    // Bounded, parameterized 4-hour range per movement. No fetch of private orders.
    const matches=sql.exec(
      "SELECT source, json_extract(payload,'$.position_side') AS side, " +
      "COUNT(*) AS count_4h, " +
      "SUM(CASE WHEN ts<? THEN 1 ELSE 0 END) AS count_1h, " +
      "SUM(CAST(json_extract(payload,'$.price') AS REAL)*CAST(json_extract(payload,'$.quantity') AS REAL)) AS usd_4h, " +
      "SUM(CASE WHEN ts<? THEN CAST(json_extract(payload,'$.price') AS REAL)*CAST(json_extract(payload,'$.quantity') AS REAL) ELSE 0 END) AS usd_1h " +
      "FROM hub_events WHERE kind='liquidation' AND ts>=? AND ts<? " +
      "AND source IN ('bybit','binance') AND json_extract(payload,'$.position_side') IN ('long','short') " +
      "GROUP BY source,side LIMIT 5", first,first,ts,end).toArray();
    if(matches.length>4)throw Error('whale_liq_provider_overflow');
    for(const x of matches){
      const exchange=x.source==='bybit'?'Bybit':x.source==='binance'?'Binance':null;
      if(!exchange||!['long','short'].includes(x.side))throw Error('whale_liq_provider_invalid');
      const n1=Number(x.count_1h),n4=Number(x.count_4h),v1=Number(x.usd_1h),v4=Number(x.usd_4h);
      if(!Number.isSafeInteger(n1)||!Number.isSafeInteger(n4)||n1<0||n4<n1||
         !Number.isFinite(v1)||!Number.isFinite(v4)||v1<0||v4<v1-1e-4||v4>1e16)
        throw Error('whale_liq_aggregation_invalid');
      rows.push({movement_idx:index,exchange,side:x.side,count_1h:n1,count_4h:n4,
        usd_1h:Number(v1.toFixed(2)),usd_4h:Number(v4.toFixed(2))});
    }
  }
  return {ok:true,schema:'lumex_whale_liquidation_cross_v1',
    source_scope:'cloudflare_hot_public_liquidation_ledger',
    legacy_sql_read:false,market_total_estimate:false,provider_comparability:'not_comparable',
    order_execution:false,generated_ms:now,hot_retention_days:14,
    window_hours:[1,4],movement_timestamps:timestamps,uncovered_indices:uncovered,
    rows,coverage:'recorded_bybit_and_binance_public_only_no_backfill',orders_enabled:false};
}


/** Source-isolated bounded public-observation adapters for legacy WP analytics.
 * These summaries are not market-wide liquidation totals; Binance is sampled.
 */
export function observedLegacySummary(sql,hours,now=Date.now()){
  if(![1,4,12,24].includes(hours))throw Error('summary_hours_invalid');
  const since=now-hours*3600000,step=hours===1?300000:hours===4?900000:hours===12?1800000:3600000;
  const input=sql.exec(
    "SELECT ts,source,payload FROM hub_events WHERE kind='liquidation' AND ts>=? AND ts<=? AND source IN ('bybit','binance') ORDER BY ts DESC LIMIT 25001",
    since,now).toArray();
  if(input.length>25000)throw Error('observed_summary_event_limit');
  const sum=new Map(),bins=new Map(),events=[];
  for(const row of input){
    let e;try{e=JSON.parse(row.payload)}catch{throw Error('summary_event_json')}
    const source=row.source==='bybit'?'Bybit':row.source==='binance'?'Binance':null;
    const side=e?.position_side,ts=Number(row.ts),p=Number(e?.price),q=Number(e?.quantity);
    if(!source||!['long','short'].includes(side)||!Number.isSafeInteger(ts)||ts<since||ts>now||
       !(p>0)||!(q>0)||!Number.isFinite(p)||!Number.isFinite(q)||
       !['public_stream','sampled_1s'].includes(e.capture))
      throw Error('summary_invalid_observation');
    const amount=p*q;
    if(!Number.isFinite(amount)||amount<=0||amount>1e15)throw Error('summary_amount_invalid');
    const key=source+'|'+side,bucket=Math.floor(ts/step)*step,key2=bucket+'|'+key;
    let s=sum.get(key);if(!s){s={exchange_name:source,position_side:side,value:0,n:0};sum.set(key,s)}
    s.value+=amount;s.n++;
    let b=bins.get(key2);if(!b){b={time_bucket:Math.floor(bucket/1000),exchange_name:source,position_side:side,value:0};bins.set(key2,b)}
    b.value+=amount;
    if(events.length<120)
      events.push({id:String(e.id||'').slice(0,180),exchange:source,side,price:p,
        amount:Number(amount.toFixed(2)),ts});
  }
  return {ok:true,schema:'lumex_cf_observed_sql_replacement_v1',
    source:'cloudflare_hot_public_liquidations',legacy_sql_read:false,order_execution:false,
    observed_only:true,market_total_estimate:false,provider_comparability:'not_comparable',
    hours,bin_seconds:step/1000,generated_ms:now,retention_days:14,
    truncated:false,observations_scanned:input.length,
    sums:[...sum.values()].map(x=>({...x,value:Number(x.value.toFixed(2))})),
    bins:[...bins.values()].map(x=>({...x,value:Number(x.value.toFixed(2))})).sort((a,b)=>a.time_bucket-b.time_bucket),
    events,coverage:'hot_index_no_disconnection_backfill'};
}

/** A recent and complete scan of EVERY configured BTC address can prove
 * historic coverage earlier than a 30-day waiting period. This is NOT
 * exchange-wide BTC flow coverage or a complete market transaction history. */
export function nativeWhaleWatchlistBackfillProof(status,now=Date.now()){
  const count=Number(status?.watchlist_count),watch=status?.watchlist;
  const latest=Number(status?.last_success_ms);
  if(status?.enabled!==true||status?.source!=='wordpress_configured'||
     !Number.isSafeInteger(count)||count<1||count>150||
     !Array.isArray(watch)||watch.length!==count||
     !Number.isSafeInteger(latest)||latest>now+120000||now-latest>1200000)
    return false;
  const maxAge=Math.max(1800000,Math.ceil(count/4)*60000+600000);
  return watch.every(entry=>entry?.backfill_complete===true&&
    entry?.gap_possible===false&&!entry?.error&&
    Number.isSafeInteger(Number(entry.last_checked_ms))&&
    Number(entry.last_checked_ms)<=now+120000&&
    now-Number(entry.last_checked_ms)<=maxAge);
}

/** Native confirmed BTC reserve observation adapter.
 * Uses the existing 35-day public event hot ledger plus 60-minute verified
 * BTC futures close solely to estimate USD, not to infer exchange balances.
 */
export function nativeWhales30d(rows,candles,now=Date.now()){
  if(!Array.isArray(rows)||rows.length>5000||!Array.isArray(candles)||candles.length<720)
    throw Error('native_whale_input_limit');
  const priceByHour=new Map();
  for(const bar of candles){
    const ts=Number(bar?.t),close=Number(bar?.c);
    if(!Number.isSafeInteger(ts)||ts%3600000!==0||!(close>0)||!Number.isFinite(close))
      throw Error('native_whale_candle_invalid');
    priceByHour.set(ts,close);
  }
  const dailyPrice={};
  for(const bar of candles){
    const dt=new Date(Number(bar.t)).toISOString().slice(0,10);
    dailyPrice[dt]=Number(bar.c);
  }
  const latestClose=Number(candles.at(-1)?.c||0);
  const from=now-30*86400000,out=[],ids=new Set();
  for(const row of rows){
    let e;try{e=JSON.parse(row.payload)}catch{throw Error('native_whale_payload_invalid')}
    const ts=Number(row.ts),qty=Number(e.quantity),side=e.side;
    const id=String(e.id||''),hash=String(e.txhash||''),label=String(e.watch_label||'').trim();
    if(row.source!=='blockstream'||!Number.isSafeInteger(ts)||ts<from||ts>now+120000||
       !['in','out'].includes(side)||!Number.isFinite(qty)||qty<=0||qty>21000000||
       !/^[0-9a-f]{64}$/i.test(hash)||!(id.startsWith('btc:addressflow:')||id.startsWith('btc:exchangeflow:'))||
       !label||label.length>90||ids.has(id)||e.capture!=='confirmed_chain_poll'||
       !e.watched_address||e.unit!=='BTC')throw Error('native_whale_event_invalid');
    ids.add(id);
    const h=Math.floor(ts/3600000)*3600000,price=priceByHour.get(h)||
      priceByHour.get(h-3600000)||null;
    if(price===null)throw Error('native_whale_price_candle_unavailable');
    out.push({asset:'BTC',chain:'bitcoin',provider:'esplora',event_id:id,
      transfer_direction:side,exchange_name:label.slice(0,90),
      transaction_hash:hash.toLowerCase(),event_ts:Math.floor(ts/1000),
      amount_coin:Number(qty.toFixed(8)),amount_usd:Number((qty*price).toFixed(4))});
  }
  return {rows:out,source:'cloudflare_native_confirmed_btc_watchlist',
    schema:'lumex_cf_native_whales_30d_v1',source_scope:'tracked_public_btc_reserve_address_net_changes_only',
    legacy_sql_read:false,live_ledger_merged:false,market_total_estimate:false,
    order_execution:false,days:30,provider:'esplora',price_method:'verified_r2_btc_usdt_60m_close_estimate',
    data_coverage:'only_confirmed_watchlist_address_net_changes',
    source_caught_up:true,read_verified_unix:Math.floor(now/1000),
    archived_last_success_unix:Math.floor(now/1000),
    archived_total:out.length,chunks_verified:0,
    price_usd:latestClose,price_updated_unix:Math.floor(now/1000),
    price_series:dailyPrice,
    cron_retirement_authorized:false};
}

export function observedTimelineSummary(sql,days,now=Date.now(),longSince=now){
  if(![1,7,30].includes(days))throw Error('timeline_days_invalid');
  const longReady=now-longSince>=30*86400000;
  const covered=days===30&&!longReady?HUB_SHORT_RETENTION_DAYS:days,
    lower=now-covered*86400000;
  // Aggregation happens inside DO SQLite, avoiding 100k public events sent to WP.
  const rows=sql.exec(
    "SELECT CAST(ts/3600000 AS INTEGER)*3600000 AS hour_ms, source, " +
      "json_extract(payload,'$.position_side') AS side, COUNT(*) AS event_count, " +
      "SUM(CAST(json_extract(payload,'$.price') AS REAL)*CAST(json_extract(payload,'$.quantity') AS REAL)) AS amount, MAX(ts) AS last_ms " +
      "FROM hub_events WHERE kind='liquidation' AND ts>=? AND ts<=? " +
      "AND source IN ('bybit','binance') AND json_extract(payload,'$.position_side') IN ('long','short') " +
      "GROUP BY hour_ms,source,side ORDER BY hour_ms DESC LIMIT 2001", lower,now).toArray();
  if(rows.length>2000)throw Error('timeline_too_many_hourly_groups');
  const groups=[];
  for(const r of rows){
    const source=r.source==='bybit'?'Bybit':r.source==='binance'?'Binance':null;
    const h=Number(r.hour_ms),last=Number(r.last_ms),n=Number(r.event_count),usd=Number(r.amount);
    if(!source||!['long','short'].includes(r.side)||!Number.isSafeInteger(h)||
       h<lower-3600000||h>now||!Number.isSafeInteger(last)||last<h||last>now||
       !Number.isSafeInteger(n)||n<1||n>1000000||!Number.isFinite(usd)||usd<=0||usd>1e16)
       throw Error('timeline_hourly_invalid');
    groups.push({exchange_name:source,position_side:r.side,bucket:Math.floor(h/3600000),
      total_usd:Number(usd.toFixed(2)),event_count:n,last_ts:Math.floor(last/1000)});
  }
  return {ok:true,schema:'lumex_cf_liquidation_timeline_v1',source:'cloudflare_hot_public_liquidations',
    legacy_sql_read:false,order_execution:false,observed_only:true,
    market_total_estimate:false,provider_comparability:'not_comparable',
    requested_days:days,covered_days:covered,coverage_complete:days<30||longReady,
    backfill_older_than_hot_index:false,generated_ms:now,groups,
    coverage:'observed_public_events_only; periods without collector evidence cannot be treated as zero'};
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
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS hub_meta(key TEXT PRIMARY KEY, value INTEGER NOT NULL)");
    // Conservative coverage watermark: do not infer a complete 30-day
    // historical index from a ledger that previously expired after 14d.

  }
  longHistoryStart(){
    const rows=this.ctx.storage.sql.exec("SELECT value FROM hub_meta WHERE key='long_history_started_ms'").toArray();
    return Number(rows[0]?.value||Date.now());
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
        if(event.kind==='whale_transfer'&&event.source==='blockstream'&&/^[a-f0-9]{64}$/.test(event.txhash||'')&&event.id.startsWith('btc:exchangeflow:')){
          const prefix='btc:addressflow:'+event.txhash+':';
          // Durable Object SQLite may reject 64-byte wildcard LIKE scans.
          // The primary-key B-tree prefix range is exact and index-backed.
          const old=this.ctx.storage.sql.exec(
            "SELECT id FROM hub_events WHERE kind='whale_transfer' AND id>=? AND id<? LIMIT 1",
            prefix,prefix+'~').toArray();
          if(old.length)continue;
        }
        this.ctx.storage.sql.exec('INSERT INTO hub_events(id,kind,source,ts,payload,archived) VALUES (?,?,?,?,?,0)',
          event.id,event.kind,event.source,event.ts,JSON.stringify(event));
        accepted.push(event);
      }
      if(accepted.length){
        // The retention clock starts on the first REAL normalized event,
        // never on an unverified provisional candlestick or idle status fetch.
        this.ctx.storage.sql.exec("INSERT OR IGNORE INTO hub_meta(key,value) VALUES ('long_history_started_ms',?)",Date.now());
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

    if((u.pathname==='/observed-pressure'||u.pathname==='/observed-replay')&&request.method==='GET') {
      try{return observedAnalyticView(this.ctx.storage.sql,u,Date.now(),this.longHistoryStart())}
      catch(e){return hubReply({ok:false,error:'observed_analytics_unavailable'},503)}
    }
    if(u.pathname==='/whale-liquidation-cross'&&request.method==='GET'){
      const timestamps=whaleLiqCrossTimestamps(u.searchParams.get('ts'));
      if(timestamps===null)return hubReply({ok:false,error:'invalid_movement_timestamps'},400);
      try{return hubReply(whaleLiqCrossQuery(this.ctx.storage.sql,timestamps))}
      catch(error){return hubReply({ok:false,error:'whale_liquidation_cross_unavailable'},503)}
    }
    if(u.pathname==='/native-whales-30d'&&request.method==='GET'){
      const now=Date.now(),since=this.longHistoryStart();
      if(now-since<30*86400000){
        // Trust only a full, fresh per-address Esplora history scan, never
        // the existence or age of any single event.
        if(!this.env.BTC_RESERVE_COLLECTOR)
          return hubReply({ok:false,error:'native_whale_watchlist_binding_missing'},503);
        let verified=false;
        try{
          const response=await this.env.BTC_RESERVE_COLLECTOR
            .getByName('reserve-btc').fetch('https://whales/status');
          verified=response.ok&&nativeWhaleWatchlistBackfillProof(await response.json(),now);
        }catch{}
        if(!verified)return hubReply({ok:false,error:'native_whale_30d_backfill_not_ready'},503);
      }
      try{
        const rows=this.ctx.storage.sql.exec(
          "SELECT ts,source,payload FROM hub_events WHERE kind='whale_transfer' AND source='blockstream' AND ts>=? ORDER BY ts DESC LIMIT 5001",
          now-30*86400000).toArray();
        if(rows.length>5000)return hubReply({ok:false,error:'native_whale_30d_overflow'},503);
        const candles=await hubGetCandles(this.env,'BTCUSDT',60,850);
        if(candles.stale===true||candles.data_quality!=='verified')return hubReply({ok:false,error:'native_whale_price_data_stale'},503);
        return hubReply({...nativeWhales30d(rows,candles.candles,now),symbol:'BTCUSDT',events_total:rows.length});
      }catch{return hubReply({ok:false,error:'native_whale_30d_unavailable'},503)}
    }
    if(u.pathname==='/long-history-readiness'&&request.method==='GET'){
      const now=Date.now(),started=this.longHistoryStart(),days=(now-started)/86400000;
      const old=this.ctx.storage.sql.exec("SELECT MIN(ts) AS oldest_ms, MAX(ts) AS latest_ms, COUNT(*) AS rows FROM hub_events WHERE kind='liquidation'").toArray()[0]||{};
      return hubReply({ok:true,schema:'lumex_long_history_readiness_v1',
        generated_ms:now,watermark_ms:started,retention_days:HUB_LONG_RETENTION_DAYS,
        minimum_days_for_30d:30,watermark_age_days:Number(days.toFixed(3)),
        thirty_day_ledger_warm:days>=30,oldest_observed_ms:old.oldest_ms||null,
        latest_observed_ms:old.latest_ms||null,observations:Number(old.rows||0),
        continuous_provider_capture_not_proven:true,
        safe_to_disable_wordpress_crons:false,orders_enabled:false});
    }
    if(u.pathname==='/observed-summary'&&request.method==='GET'){
      const hours=Number(u.searchParams.get('hours'));
      try{return hubReply({...observedLegacySummary(this.ctx.storage.sql,hours),symbol:u.searchParams.get('symbol')})}
      catch{return hubReply({ok:false,error:'observed_summary_unavailable'},503)}
    }
    if(u.pathname==='/observed-timeline'&&request.method==='GET'){
      const days=Number(u.searchParams.get('days'));
      try{return hubReply({...observedTimelineSummary(this.ctx.storage.sql,days,Date.now(),this.longHistoryStart()),symbol:u.searchParams.get('symbol')})}
      catch{return hubReply({ok:false,error:'observed_timeline_unavailable'},503)}
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
        hot_retention_days:HUB_LONG_RETENTION_DAYS,archive:'R2_immutable_batches'});
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
        const clock=Date.now();
        this.ctx.storage.sql.exec("DELETE FROM hub_events WHERE archived=1 AND rollup_done=1 AND kind NOT IN ('liquidation','whale_transfer') AND ts<?",clock-HUB_SHORT_RETENTION_DAYS*86400000);
        this.ctx.storage.sql.exec("DELETE FROM hub_events WHERE archived=1 AND rollup_done=1 AND kind IN ('liquidation','whale_transfer') AND ts<?",clock-HUB_LONG_RETENTION_DAYS*86400000);
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

/** Immutable WordPress public whale archive -> 30-day chart source.
 * Deliberately excludes live DO ledger to prevent duplicate reserve-address observations.
 * Read-only, bounded and denied on incomplete/stale backfill.
 */
export function normalizeArchivedWhales30d(documents,now=Date.now()){
  if(!Array.isArray(documents)||documents.length<1||documents.length>100)throw Error('whale_archive_document_count');
  const lower=Math.floor(now/1000)-30*86400,upper=Math.floor(now/1000)+120;
  const seen=new Set(),result=[];
  let allCount=0,maxId=0,validEsplora=0;
  for(const doc of documents){
    if(doc?.schema!=='lumex_legacy_archive_v1'||doc?.source!=='whales'||
       doc?.origin!=='lumexbot_wordpress_public_market_mysql'||
       doc?.merged_with_live_observations!==false||!Array.isArray(doc?.records)||
       doc.records.length<1||doc.records.length>100||
       doc.record_count!==doc.records.length)throw Error('whale_archive_schema');
    for(const v of doc.records){
      const id=Number(v?.id),ts=Number(v?.event_ts),coin=Number(v?.amount_coin),usd=Number(v?.amount_usd);
      if(!Number.isSafeInteger(id)||id<=0||seen.has(id)||
         !Number.isSafeInteger(ts)||ts<1450000000||ts>upper||
         !Number.isFinite(coin)||coin<0||coin>21e6||
         !Number.isFinite(usd)||usd<0||usd>1e15||
         !/^[a-fA-F0-9]{64}$/.test(String(v?.fingerprint||''))||
         !/^[a-fA-F0-9]{64}$/.test(String(v?.transaction_hash||''))||
         typeof v?.exchange_name!=='string'||v.exchange_name.length>90||
         !['in','out'].includes(v?.transfer_direction)||
         v.asset!=='BTC'||v.chain!=='bitcoin')throw Error('whale_archive_record_invalid');
      seen.add(id);allCount++;maxId=Math.max(maxId,id);
      if(v.provider!=='esplora')continue; // other providers remain separately audited
      validEsplora++;
      if(ts<lower||coin<=0)continue;
      result.push({asset:'BTC',chain:'bitcoin',provider:'esplora',
        transfer_direction:v.transfer_direction,
        exchange_name:v.exchange_name,amount_usd:Number(usd.toFixed(4)),
        amount_coin:Number(coin.toFixed(8)),transaction_hash:v.transaction_hash.toLowerCase(),
        event_ts:ts});
    }
  }
  if(allCount>6000||result.length>5000)throw Error('whale_archive_over_limit');
  result.sort((a,b)=>b.event_ts-a.event_ts||a.transaction_hash.localeCompare(b.transaction_hash));
  return {rows:result,archived_total:allCount,highest_id:maxId,provider_rows:validEsplora};
}
export async function hubWhales30dArchive(env,now=Date.now()){
  if(!env.MARKET_DATA||!env.BTC_RESERVE_COLLECTOR)
    return hubReply({ok:false,error:'whale_archive_bindings_missing'},503);
  const endpoint=env.BTC_RESERVE_COLLECTOR.getByName('reserve-btc');
  const statusResp=await endpoint.fetch('https://whales/backfill-status');
  if(!statusResp.ok)return hubReply({ok:false,error:'whale_archive_status_unavailable'},503);
  const status=await statusResp.json();
  const state=Array.isArray(status?.sources)?status.sources.find(x=>x.source==='whales'):null;
  if(status?.enabled!==true||!state||state.caught_up!==true||state.last_error!==null||
     !Number.isSafeInteger(state.last_success_ms)||Math.abs(now-state.last_success_ms)>1200000||
     !Number.isSafeInteger(state.records_archived)||state.records_archived<1||
     !Number.isSafeInteger(state.chunks_archived)||state.chunks_archived<1||
     state.chunks_archived>100||!Number.isSafeInteger(state.cursor)||state.cursor<=0)
    return hubReply({ok:false,error:'whale_archive_backfill_not_ready'},503);
  const listing=await env.MARKET_DATA.list({prefix:PREFIX+'whales/',limit:101});
  if(listing.truncated||listing.objects.length!==state.chunks_archived||listing.objects.length>100)
    return hubReply({ok:false,error:'whale_archive_chunk_count_mismatch'},503);
  const documents=[];
  for(const item of listing.objects){
    if(!item.key.startsWith(PREFIX+'whales/')||!/^market-hub\/legacy\/wp\/whales\/[0-9]+-[0-9]+-[a-f0-9]{24}\.json$/.test(item.key))
      return hubReply({ok:false,error:'whale_archive_key_invalid'},503);
    const obj=await env.MARKET_DATA.get(item.key);
    if(!obj||obj.size>180000||obj.size<2||
       obj.customMetadata?.schema!=='lumex_legacy_archive_v1'||
       obj.customMetadata?.source!=='whales')
      return hubReply({ok:false,error:'whale_archive_object_invalid'},503);
    const raw=await obj.text(),digest=hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw)));
    if(digest!==obj.customMetadata.sha256||
       !item.key.endsWith('-'+digest.slice(0,24)+'.json'))
      return hubReply({ok:false,error:'whale_archive_integrity_failed'},503);
    const doc=JSON.parse(raw);
    documents.push(doc);
  }
  const parsed=normalizeArchivedWhales30d(documents,now);
  if(parsed.archived_total!==state.records_archived||parsed.highest_id!==state.cursor)
    return hubReply({ok:false,error:'whale_archive_cursor_not_verified'},503);
  return hubReply({ok:true,schema:'lumex_cf_whale_archive_30d_v1',
    source:'cloudflare_r2_immutable_wordpress_public_whale_archive',
    source_scope:'tracked_public_btc_reserve_address_net_changes_only',
    live_ledger_merged:false,market_total_estimate:false,legacy_sql_read:false,
    source_caught_up:true,provider:'esplora',days:30,
    read_verified_unix:Math.floor(now/1000),
    archived_last_success_unix:Math.floor(state.last_success_ms/1000),
    archived_total:parsed.archived_total,provider_archived_total:parsed.provider_rows,
    chunks_verified:documents.length,rows:parsed.rows,order_execution:false,
    cron_retirement_authorized:false});
}

async function hubRoute(request,env){
  const u=new URL(request.url),path=u.pathname,method=request.method;
  // PRO-only via WordPress, server-side Bearer; no public customer access to Worker R2.
  // Owner-only source health: enables diagnosing 403, stale source and schema mismatch.
  if(path==='/market-hub/v1/exchange-compare-health'&&method==='GET'){
    if(!hubAuthorized(request,env))return hubReply({ok:false,error:'unauthorized'},401);
    return (await import('./exchange-compare.mjs')).serveExchangeCompareHealth(env);
  }
  if(path==='/market-hub/v1/exchange-compare-history'&&method==='GET'){
    if(!hubAuthorized(request,env))return hubReply({ok:false,error:'unauthorized'},401);
    return (await import('./exchange-history.mjs')).serveExchangeHistory(request,env);
  }
  if(path==='/market-hub/v1/pro-regime50'&&method==='GET'){
    if(!hubAuthorized(request,env))return hubReply({ok:false,error:'unauthorized'},401);
    const symbol=String(u.searchParams.get('symbol')||'');
    try{return hubReply(await (await import('./pro50-fourhour.mjs')).regimeFourHourFallback(env,symbol,500))}
    catch{return hubReply({ok:false,error:'verified_4h_unavailable'},503)}
  }
  if(path==='/market-hub/v1/pro-top50-history'&&method==='GET'){
    if(!hubAuthorized(request,env))return hubReply({ok:false,error:'unauthorized'},401);
    return (await import('./pro-venue-matrix.mjs')).serveTop50VenueHistory(request,env);
  }
  if(path==='/market-hub/v1/pro-top50-venues'&&method==='GET'){
    if(!hubAuthorized(request,env))return hubReply({ok:false,error:'unauthorized'},401);
    return (await import('./pro-venue-matrix.mjs')).serveVenueMatrix(request,env);
  }
  if(path==='/market-hub/v1/liquidity'&&method==='GET'){
    if(!hubAuthorized(request,env))return hubReply({ok:false,error:'unauthorized'},401);
    return (await import('./liquidity-intelligence.mjs')).serveLiquidity(request,env);
  }
  if(path==='/market-hub/v1/order-flow-continuity-health'&&method==='GET'){
    if(!hubAuthorized(request,env))return hubReply({ok:false,error:'unauthorized'},401);
    return (await import('./order-flow-coverage.mjs')).serveGateObservedCoverage(env);
  }
  if(path==='/market-hub/v1/order-flow-live-health'&&method==='GET'){
    if(!hubAuthorized(request,env))return hubReply({ok:false,error:'unauthorized'},401);
    if(!env.ORDER_FLOW_LIVE_COLLECTOR)return hubReply({ok:false,error:'collector_not_bound',customer_launch_ready:false},503);
    try{
      return await env.ORDER_FLOW_LIVE_COLLECTOR.getByName('gate-live-phase33')
        .fetch('https://flow/status',{method:'GET'});
    }catch{return hubReply({ok:false,error:'collector_unavailable',customer_launch_ready:false},503);}
  }
  if(path==='/market-hub/v1/order-flow-history'&&method==='GET'){
    if(!hubAuthorized(request,env))return hubReply({ok:false,error:'unauthorized'},401);
    return (await import('./order-flow-verified.mjs')).serveOrderFlowHistory(request,env);
  }
  if(path==='/market-hub/v1/pro-top50'&&method==='GET'){
    if(!hubAuthorized(request,env))return hubReply({ok:false,error:'unauthorized'},401);
    return (await import('./pro-top50.mjs')).serveTop50(env);
  }
  if(path==='/market-hub/v1/exchange-compare'&&method==='GET'){
    if(!hubAuthorized(request,env))return hubReply({ok:false,error:'unauthorized'},401);
    return (await import('./exchange-compare.mjs')).serveExchangeCompare(request,env);
  }
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
  if(path==='/market-hub/v1/quality-proof-retry'&&method==='POST'){
    if(!hubAuthorized(request,env))return hubReply({ok:false,error:'unauthorized'},401);
    if(env.AUTO_MARKET_QA_DAILY!=='true'||!env.MARKET_DATA)
      return hubReply({ok:false,error:'qa_daily_disabled_or_r2_missing'},503);
    try{
      const result=await marketOpsDaily(env);
      return hubReply({...result,scope:'current_utc_date_only',
        safe_to_disable_wordpress_crons:false},result.ok?200:503);
    }catch(e){
      console.error('market_ops_manual_retry_failed',String(e?.message||e).slice(0,120));
      return hubReply({ok:false,error:'qa_daily_write_failed',
        safe_to_disable_wordpress_crons:false},503);
    }
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
  if(path==='/market-hub/v1/whales-archive-30d'&&method==='GET'){
    if(!hubAuthorized(request,env))return hubReply({ok:false,error:'unauthorized'},401);
    try{return await hubWhales30dArchive(env)}
    catch(error){return hubReply({ok:false,error:'whale_archive_read_failed'},503)}
  }
  if(path==='/market-hub/v1/native-whales-30d'&&method==='GET'){
    if(!hubAuthorized(request,env))return hubReply({ok:false,error:'unauthorized'},401);
    if(!env.BTC_RESERVE_COLLECTOR||!env.MARKET_EVENT_HUB)return hubReply({ok:false,error:'whale_binding_missing'},503);
    const status=await env.BTC_RESERVE_COLLECTOR.getByName('reserve-btc').fetch('https://whales/status');
    if(!status.ok)return hubReply({ok:false,error:'watchlist_health_unavailable'},503);
    const report=await status.json(),now=Date.now();
    const watch=report.watchlist||[];
    if(!nativeWhaleWatchlistBackfillProof(report,now))
       return hubReply({ok:false,error:'native_whale_watchlist_parity_not_ready'},503);
    const upstream=await env.MARKET_EVENT_HUB.getByName('BTCUSDT').fetch('https://hub/native-whales-30d');
    if(!upstream.ok)return upstream;
    const x=await upstream.json();
    return hubReply({...x,tracked_addresses:watch.length,
      backfill_complete:watch.length,backfill_total:watch.length,
      watchlist_last_success_ms:report.last_success_ms,
      watchlist_source:report.source});
  }
  if(path==='/market-hub/v1/historical-liquidation-health'&&method==='GET'){
    if(!hubAuthorized(request,env))return hubReply({ok:false,error:'unauthorized'},401);
    if(!env.BTC_RESERVE_COLLECTOR)return hubReply({ok:false,error:'archive_binding_missing'},503);
    return env.BTC_RESERVE_COLLECTOR.getByName('reserve-btc').fetch('https://whales/historical-liquidation-health');
  }
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
  if(path==='/market-hub/v1/binance-cloudflare-health'&&method==='GET')
    return hubReply(await cloudflareBinanceHealth(env));
  if(path==='/market-hub/v1/binance-container-image-health'&&method==='GET'){
    if(!env.RESEARCH_CONTAINER)return hubReply({ok:false,reason:'container_binding_missing'},503);
    try{
      const response=await env.RESEARCH_CONTAINER.getByName('primary-research')
        .fetch('https://internal.lumex/__container-image-status');
      if(!response.ok)return hubReply({ok:false,reason:'container_image_status_unavailable'},503);
      const info=await response.json();
      return hubReply({ok:info.ok===true,container_running:info.container_running===true,
        image_matches_current:info.image_matches_current,
        image_starting:info.image_starting===true,
        restart_policy:'on_binance_probe_if_image_outdated',
        orders_enabled:false});
    }catch{return hubReply({ok:false,reason:'container_image_status_unavailable'},503);}
  }
  if(path==='/market-hub/v1/binance-egress-health'&&method==='GET'){
    try{
      const x=await opsReadR2(env,BINANCE_EGRESS_PROOF_KEY);
      if(x?.schema!=='lumex_binance_egress_proof_v1')
        return hubReply({ok:false,checked:false,reason:'no_container_probe_yet',
          source:'existing_research_container',trading_enabled:false});
      return hubReply({...x,stale:Date.now()-x.checked_ms>3600000,
        usable_as_liquidation_feed:false,cron_retirement_allowed:false});
    }catch{return hubReply({ok:false,reason:'egress_proof_read_unavailable'},503)}
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
      // R2 list() is key-ordered, NOT newest-first. Global first-25 samples
      // can show yesterday's files while current-hour objects exist.
      // Inspect fixed recent UTC hour prefixes and read actual JSONL bytes.
      const now=Date.now(),proof=await continuityR2Proof(env,now);
      const kinds={};
      for(const kind of CONTINUITY_KINDS){
        const sample=proof.kinds?.[kind];
        kinds[kind]={
          sample_verified:sample?.sample_verified===true,
          verified_records:Number.isSafeInteger(sample?.verified_records)?sample.verified_records:0,
          hours_with_object:Number.isSafeInteger(sample?.hours_with_object)?sample.hours_with_object:0,
          last_observed_hour_unix:Number.isSafeInteger(sample?.last_observed_hour_unix)?
            sample.last_observed_hour_unix:null,
          reason:sample?.reason||'unavailable'
        };
      }
      return hubReply({ok:proof.ok===true,
        schema:'lumex_archive_recent_health_v2',
        window_hours:CONTINUITY_HOURS,
        as_of_unix:Math.floor(now/1000),
        list_checks:proof.list_checks,
        list_errors:proof.list_errors,
        kinds,archive:'immutable_r2_jsonl',
        recent_liquidation_sample_verified:kinds.liquidation.sample_verified,
        recent_whale_sample_verified:kinds.whale_transfer.sample_verified,
        observed_only:true,complete_market_capture:false,
        sample_not_total:true,order_execution:false,
        safe_to_disable_wordpress_crons:false});
    }catch(error){return hubReply({ok:false,error:'archive_unavailable'},503)}
  }
  if(path==='/market-hub/v1/binance-external-ingest'&&method==='POST')
    return externalBinanceRelayRoute(request,env);
  if(path==='/market-hub/v1/binance-external-health'&&method==='GET')
    return hubReply(await externalBinanceRelayHealth(env));
  if(path==='/market-hub/v1/github-binance-ingest'&&method==='POST')
    return githubBinanceSidecarRoute(request,env);
  if(path==='/market-hub/v1/github-binance-health'&&method==='GET'){
    const fallback=await opsReadR2(env,GH_BINANCE_FALLBACK_KEY);
    const dispatch={configured:env.LUMEX_GITHUB_DISPATCH_FALLBACK==='true'&&
        typeof env.LUMEX_GITHUB_DISPATCH_TOKEN==='string'&&
        env.LUMEX_GITHUB_DISPATCH_TOKEN.length>=30,
      last_attempt_ms:Number(fallback?.attempt_ms||0)||null,
      last_result:String(fallback?.result||'never_attempted'),
      github_schedule_automated_unverified:true};
    const status=await opsReadR2(env,GH_BINANCE_STATUS_KEY);
    if(status?.schema!=='lumex_binance_github_public_sidecar_v1')
      return hubReply({ok:false,reason:'no_signed_github_sidecar_session',
        capture_confirmed:false,r2_readback_verified:false,
        automatic_dispatch:dispatch,cron_retirement_allowed:false});
    const now=Date.now();
    const age=now-Number(status.checked_ms||0);
    let stored=false,proofEventMs=0;
    const key=String(status.r2_source_proof_key||'');
    // Never read user-controlled key patterns; read exactly our own source
    // namespace and SHA-derived event IDs from a signed ingress.
    if(/^market-hub\/events-source-proof\/binance\/v1\/\d{4}\/\d{2}\/\d{2}\/\d{2}\/binance_liq_(BTCUSDT|ETHUSDT|SOLUSDT|XRPUSDT)_[a-f0-9]{32}\.json$/.test(key)){
      try{
        const object=await env.MARKET_DATA.get(key);
        if(object&&object.size>0&&object.size<5000){
          const j=await object.json();
          if(j?.schema==='lumex_binance_public_observation_r2_v1'&&
            j?.source==='binance'&&j?.event?.source==='binance'&&
            j?.event?.kind==='liquidation'&&
            Number.isSafeInteger(j.event.ts)&&j.event.ts<=now+120000&&
            j.event.ts>=now-366*86400000&&
            key.endsWith(j.event.id.replaceAll(':','_')+'.json')){
            stored=true;proofEventMs=j.event.ts;
          }
        }
      }catch{}
    }
    return hubReply({...status,stale:age>900000,
      source_session_stale:age>900000,
      scheduled_session_proven:Number(status.last_scheduled_ms||0)>0&&
        now-status.last_scheduled_ms>=0&&now-status.last_scheduled_ms<900000,
      // GitHub schedule is best effort; workflow_dispatch is not proof.
      capture_confirmed:status.last_accepted_ms>0&&now-status.last_accepted_ms<1800000,
      r2_readback_verified:stored,r2_last_observed_ms:proofEventMs||null,
      source_sample_coverage:'discontinuous_observed_windows_only',
      automatic_dispatch:dispatch,cron_retirement_allowed:false});
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
    // Public-market historical candles for the read-only $10k AI paper
    // observer. Existing chart clients keep default 500; only explicit 850
    // selects the bounded R2 extended window (never grants orders).
    const requested=u.searchParams.get('limit')||'500';
    if(!['500','850'].includes(requested))return hubReply({ok:false,error:'invalid_candle_limit'},400);
    try{return hubReply(await hubGetCandles(env,symbol,interval,Number(requested)))}
    catch(e){return hubReply({ok:false,error:safeError(e),symbol,interval},503)}
  }
  if((path==='/market-hub/v1/observed-pressure'||path==='/market-hub/v1/observed-replay')&&method==='GET') {
    if(!env.MARKET_EVENT_HUB)return hubReply({ok:false,error:'hub_binding_missing'},503);
    const endpoint=path.endsWith('pressure')?'/observed-pressure':'/observed-replay';
    const q=new URLSearchParams();
    if(endpoint==='/observed-replay'){
      q.set('start_ms',u.searchParams.get('start_ms')||'');
      q.set('end_ms',u.searchParams.get('end_ms')||'');
    }
    return env.MARKET_EVENT_HUB.getByName(symbol).fetch(
      new Request('https://hub'+endpoint+'?'+q.toString()));
  }
  if(path==='/market-hub/v1/whale-liquidation-cross'&&method==='GET'){
    if(symbol!=='BTCUSDT')return hubReply({ok:false,error:'btc_only'},400);
    const timestamps=whaleLiqCrossTimestamps(u.searchParams.get('ts'));
    if(timestamps===null)return hubReply({ok:false,error:'invalid_movement_timestamps'},400);
    if(!env.MARKET_EVENT_HUB)return hubReply({ok:false,error:'hub_binding_missing'},503);
    return env.MARKET_EVENT_HUB.getByName(symbol).fetch(
      new Request('https://hub/whale-liquidation-cross?ts='+timestamps.join(',')));
  }
  if((path==='/market-hub/v1/observed-summary'||path==='/market-hub/v1/observed-timeline')&&method==='GET'){
    if(!env.MARKET_EVENT_HUB)return hubReply({ok:false,error:'hub_binding_missing'},503);
    const analytics=path.endsWith('summary')?'/observed-summary':'/observed-timeline';
    const q=new URLSearchParams();
    q.set(analytics==='/observed-summary'?'hours':'days',u.searchParams.get(analytics==='/observed-summary'?'hours':'days')||'');
    q.set('symbol',symbol);
    return env.MARKET_EVENT_HUB.getByName(symbol).fetch(new Request('https://hub'+analytics+'?'+q));
  }
  if(path==='/market-hub/v1/long-history-readiness'&&method==='GET'){
    if(!env.MARKET_EVENT_HUB)return hubReply({ok:false,error:'hub_binding_missing'},503);
    return env.MARKET_EVENT_HUB.getByName(symbol).fetch(new Request('https://hub/long-history-readiness'));
  }
  if((path==='/market-hub/v1/historical-liquidation-timeline'||path==='/market-hub/v1/historical-liquidation-replay')&&method==='GET'){
    if(!env.BTC_RESERVE_COLLECTOR)return hubReply({ok:false,error:'archive_binding_missing'},503);
    const q=new URLSearchParams({coin:symbol.replace('USDT','')});
    if(path.endsWith('timeline'))q.set('days',u.searchParams.get('days')||'');
    else for(const k of ['start_ms','end_ms'])q.set(k,u.searchParams.get(k)||'');
    const route=path.endsWith('timeline')?'/historical-liquidation-timeline':'/historical-liquidation-replay';
    return env.BTC_RESERVE_COLLECTOR.getByName('reserve-btc').fetch('https://whales'+route+'?'+q);
  }
  if(path==='/market-hub/v1/events'&&method==='GET'){
    if(!env.MARKET_EVENT_HUB)return hubReply({ok:false,error:'hub_binding_missing'},503);
    const kind=u.searchParams.get('kind')||'';
    return env.MARKET_EVENT_HUB.getByName(symbol).fetch(new Request('https://hub/events?kind='+encodeURIComponent(kind)+
      '&limit='+encodeURIComponent(u.searchParams.get('limit')||'40')));
  }
  return hubReply({ok:false,error:'not_found'},404);
}

/** Independent LYRA paper-only single-flight Durable Object. No order actions. */
export class LyraPaperRunner extends DurableObject{
  constructor(ctx,env){super(ctx,env);this.inflight=null;}
  async fetch(request){
    const path=new URL(request.url).pathname;
    if(path==='/health'&&request.method==='GET'){
      try{
        const state=await this.ctx.storage.get('lyra_paper_state_v2');
        return Response.json({ok:true,paper_only:true,orders_enabled:false,initialized:Boolean(state),
          state:state?.status||'not_started',last_observed_ms:state?.last_ms||null,
          latest_closed_4h_unix:state?.last_bar_t||null,
          measurement:'public_futures_HTTP_observed_approximately_each_minute'},
          {headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
      }catch{return Response.json({ok:false,error:'paper_health_unavailable'},{status:503});}
    }
    if(path==='/report'&&request.method==='GET'){
      try{
        const data=await import('./lyra-paper.mjs').then(m=>m.report(this.ctx.storage));
        return Response.json(data,{headers:{'cache-control':'no-store'}});
      }catch{return Response.json({ok:false,error:'paper_read_unavailable'},{status:503});}
    }
    if(path==='/tick'&&request.method==='POST'){
      if(!this.inflight)this.inflight=import('./lyra-paper.mjs')
        .then(m=>m.runPaperTick(this.ctx.storage,this.env))
        .finally(()=>{this.inflight=null});
      try{
        return Response.json(await this.inflight,{headers:{'cache-control':'no-store'}});
      }catch(e){
        console.warn('lyra_paper_tick_failed',String(e?.message||'unavailable').replace(/[^A-Za-z0-9_-]/g,'_').slice(0,64));
        return Response.json({ok:false,error:'paper_tick_unavailable',orders_enabled:false},{status:503});
      }
    }
    return Response.json({ok:false,error:'not_found'},{status:404});
  }
}

export class ResearchContainer extends DurableObject{
  constructor(ctx,env){super(ctx,env);this.starting=null;
    if(ctx.container?.running)void ctx.blockConcurrencyWhile(()=>ctx.container.setInactivityTimeout(120000));
  }
  async fetch(request){
    const container=this.ctx.container;if(!container)throw Error('container_binding_missing');
    const path=new URL(request.url).pathname;
    // Only publicly expose booleans; never leak image digests, keys or paths.
    if(path==='/__container-image-status'){
      try{
        const info=container.running?await container.inspect():null;
        return Response.json({ok:true,container_running:!!container.running,
          image_matches_current:info?.image?info.image===container.images.base:null,
          image_starting:!!container.running&&!info?.image,
          restart_policy:'on_binance_probe_if_image_outdated',
          orders_enabled:false});
      }catch{return Response.json({ok:false,error_code:'container_inspection_failed'},
        {status:503});}
    }
    const binanceRoute=path==='/binance-egress-probe'||path==='/binance-cloudflare-capture';
    // "durable_object" policy NEVER auto-rolls old running images on deploy.
    // Restart only when a Binance diagnostic discovers a digest mismatch;
    // preserve unrelated queued research paths and avoid restart loops.
    if(binanceRoute&&container.running){
      let info;
      try{info=await container.inspect();}
      catch{return Response.json({ok:false,error_code:'container_inspection_failed'},
        {status:503});}
      if(info?.image&&container.images?.base&&info.image!==container.images.base){
        console.warn('research_container_binance_image_rotation_required');
        try{await container.destroy('lumex_research_container_image_upgrade');}
        catch{return Response.json({ok:false,error_code:'container_image_rotation_failed'},
          {status:503});}
      }
    }
    this.starting??=this.startAndReady().finally(()=>{this.starting=null;});await this.starting;
    if(binanceRoute){
      // Fail closed when an old process is still serving /health.
      try{
        const res=await container.getTcpPort(PORT).fetch('http://container/health',
          {signal:AbortSignal.timeout(3500)});
        const health=await res.json();
        if(!res.ok||health?.binance_image_contract!=='lumex_binance_capture_20261119_v2')
          return Response.json({ok:false,error_code:'container_image_contract_mismatch'},
            {status:503});
      }catch{return Response.json({ok:false,error_code:'container_image_health_unavailable'},
        {status:503});}
    }
    const url=new URL(request.url);url.protocol='http:';url.host='container';
    const headers=new Headers(request.headers);headers.delete('host');headers.set('X-Lumex-Internal-Key',this.env.LUMEX_CONTAINER_KEY||'');
    const forwarded=new Request(url,{method:request.method,headers,body:request.body,duplex:'half'});
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
    if(url.pathname==='/market-hub/v1/bls-oidc-ingest')
      return import('./bls-official-sidecar.mjs').then(m=>m.ingestBlsOidc(request,env,verifyGithubOfficialBlsOidc))
        .catch(()=>respond({ok:false,error:'bls_official_ingest_unavailable'},503));
    if(url.pathname==='/market-hub/v1/official-news')
      return import('./official-news.mjs').then(m=>m.officialNewsPublicRoute(request,env))
        .catch(()=>respond({ok:false,error:'official_news_unavailable'},503));
    if(url.pathname==='/market-hub/v1/public-heatmap')
      return import('./public-heatmap.mjs').then(m=>m.heatmapPublicRoute(request,env))
        .catch(()=>respond({ok:false,error:'heatmap_unavailable'},503));
    if(url.pathname==='/market-hub/v1/btc-onchain-price')return import('./btc-onchain.mjs').then(m=>m.btcOnchainDailyRoute(request,env)).catch(()=>respond({ok:false,error:'unavailable'},503));
    if(url.pathname==='/market-hub/v1/btc-onchain')return import('./btc-onchain.mjs').then(m=>m.btcOnchainRoute(request,env)).catch(()=>respond({ok:false,error:'unavailable'},503));
    if(url.pathname==='/market-hub/v1/lyra-paper-health'){
      if(request.method!=='GET')return respond({ok:false,error:'method_not_allowed'},405);
      if(!env.LYRA_PAPER_RUNNER)return respond({ok:false,error:'paper_runner_not_bound'},503);
      try{return await env.LYRA_PAPER_RUNNER.getByName('lyra-paper-primary').fetch('https://lyra/health');}
      catch{return respond({ok:false,error:'paper_health_unavailable'},503);}
    }
    if(url.pathname==='/market-hub/v1/lyra-paper-report')
      return import('./lyra-paper.mjs').then(m=>m.privateReport(request,env))
        .catch(()=>respond({ok:false,error:'paper_report_unavailable'},503));
    if(url.pathname==='/market-hub/v1/regime-research-report')
      return import('./regime-research.mjs').then(m=>m.privateRegimeReport(request,env)).catch(()=>respond({ok:false,error:'unavailable'},503));
    if(['/market-hub/v1/hyperliquid-whale-candles','/market-hub/v1/hyperliquid-whale-portfolio'].includes(url.pathname))
      return import('./hyperliquid-whale-history.mjs').then(m=>m.whaleHistoryRoute(request,env)).catch(()=>respond({ok:false,error:'whale_history_unavailable'},503));
    if(['/market-hub/v1/hyperliquid-whales','/market-hub/v1/hyperliquid-whale-profile','/market-hub/v1/hyperliquid-whales-health'].includes(url.pathname))
      return import('./hyperliquid-whales.mjs').then(m=>m.hyperWhalesRoute(request,env)).catch(()=>respond({ok:false,error:'unavailable'},503));
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
    if(controller.cron==='*/5 * * * *'&&env.AUTO_ML_REGIME_RESEARCH==='true')
      ctx.waitUntil(import('./regime-research.mjs').then(m=>m.scheduledRegimeResearch(env)).then(x=>{
        if(x?.ok===false)console.warn('ml_regime_research_not_ready',String(x.reason||'failed').slice(0,60));
      }).catch(()=>console.error('ml_regime_research_unavailable')));
    if(controller.cron==='*/5 * * * *'&&env.AUTO_MARKET_QA_DAILY==='true'){
      // Retry throughout the UTC day. A single missed 00:15 cron must not
      // permanently lose the daily proof. marketOpsDaily is idempotent by R2 key.
      // Never synthesize historical proof: it must be observed on that date.
      const utc=new Date(controller.scheduledTime||Date.now());
      if(utc.getUTCHours()>0||(utc.getUTCHours()===0&&utc.getUTCMinutes()>=15))
        ctx.waitUntil(marketOpsDaily(env,utc.getTime()).catch(e=>console.error('market_ops_daily_failed',String(e?.message||e).slice(0,120))));
    }
    if(controller.cron==='*/5 * * * *'&&env.LUMEX_GITHUB_DISPATCH_FALLBACK==='true')
      ctx.waitUntil(dispatchGithubBinanceIfStale(env).catch(()=>
        console.warn('binance_dispatch_fallback_not_ready')));
    if(controller.cron==='* * * * *'&&env.AUTO_BINANCE_CLOUDFLARE_CAPTURE==='true')
      ctx.waitUntil(pollCloudflareBinanceCapture(env).then(result=>{
        if(result?.ok===false&&result.reason!=='cloudflare_egress_not_authorized')
          console.warn('binance_cf_capture',String(result.reason||'unready').slice(0,65));
      }).catch(()=>console.warn('binance_cf_capture_unavailable')));
    if(controller.cron==='*/5 * * * *'&&env.AUTO_BINANCE_CONTAINER_EGRESS_PROBE==='true')
      ctx.waitUntil(probeBinanceContainerEgress(env).catch(e=>
        console.warn('binance_egress_probe_failed',safeError(e).slice(0,65))));
    if(controller.cron==='*/5 * * * *'&&env.AUTO_TOP50_UNIVERSE==='true')
      ctx.waitUntil(import('./pro-top50.mjs').then(m=>m.collectTop50(env)).then(async r=>{
        if(r?.ok!==true){
          console.warn('top50_public_universe_unavailable',String(r?.reason||'unverified').slice(0,65));return;
        }
        const x=await (await import('./pro-venue-matrix.mjs')).collectVenueMatrix(env);
        if(x?.ok!==true)console.warn('top50_venue_matrix_incomplete',String(x?.reason||'unverified').slice(0,65));
      }).catch(()=>console.warn('top50_public_universe_collect_failed')));
    if(controller.cron==='*/5 * * * *'&&env.AUTO_EXCHANGE_COMPARE_FETCH==='true')
      ctx.waitUntil(import('./exchange-compare.mjs').then(m=>m.collectExchangeCompare(env)).catch(e=>
        console.error('exchange_compare_collect_failed',String(e?.message||e).slice(0,70))));
    if(controller.cron==='*/5 * * * *'&&env.AUTO_OI_MIRROR_FETCH==='true')
      ctx.waitUntil(collectOiMirror(env).catch(()=>console.error('oi_mirror_collect_failed')));
    if(controller.cron==='* * * * *'&&env.AUTO_LYRA_SHADOW_PAPER==='true'&&env.LYRA_PAPER_RUNNER){
      ctx.waitUntil(env.LYRA_PAPER_RUNNER.getByName('lyra-paper-primary')
        .fetch('https://lyra/tick',{method:'POST'})
        .then(async r=>{
          if(!r.ok)console.warn('lyra_shadow_paper_unavailable',r.status);
          await r.body?.cancel();
        }).catch(()=>console.warn('lyra_shadow_paper_observer_unavailable')));
    }
    if(controller.cron==='* * * * *'&&env.AUTO_HYPERLIQUID_WHALES==='true')
      ctx.waitUntil(import('./hyperliquid-whales.mjs').then(m=>m.collectHyperWhales(env)).catch(()=>console.error('hyperliquid_whales_collect_failed')));
    if(controller.cron==='*/5 * * * *'&&env.AUTO_OFFICIAL_NEWS==='true')
      ctx.waitUntil(import('./official-news.mjs').then(m=>m.collectOfficialNews(env))
        .then(r=>{if(r?.ok===false)console.warn('official_news_partial',String(r.reason||'unavailable').slice(0,55));})
        .catch(()=>console.warn('official_news_r2_or_feed_unavailable')));
    if(controller.cron==='*/5 * * * *'&&env.AUTO_PUBLIC_HEATMAP==='true')
      ctx.waitUntil(import('./public-heatmap.mjs').then(m=>m.collectPublicHeatmap(env))
        .then(r=>{if(r?.ok===false)console.warn('public_heatmap_collect_limited',String(r.reason||'unknown').slice(0,60));})
        .catch(()=>console.warn('public_heatmap_collect_unavailable')));
    if(controller.cron==='*/5 * * * *'&&env.AUTO_PUBLIC_PULSE_FETCH==='true')
      ctx.waitUntil(import('./btc-onchain.mjs').then(m=>m.collectBtcOnchain(env)).catch(()=>console.error('btc_onchain_collect_failed')));
    if(controller.cron==='*/5 * * * *'&&env.AUTO_PUBLIC_PULSE_FETCH==='true')
      ctx.waitUntil(import('./btc-onchain.mjs').then(m=>m.collectBtcOnchainDaily(env)).catch(()=>console.error('btc_onchain_daily_failed')));
    if(controller.cron==='*/5 * * * *'&&env.AUTO_PUBLIC_PULSE_FETCH==='true')
      ctx.waitUntil(collectPublicPulse(env).catch(()=>console.error('public_pulse_collect_failed')));
    if(controller.cron==='*/5 * * * *'&&env.AUTO_ORDER_FLOW_COVERAGE==='true'){
      const m=new Date(controller.scheduledTime||Date.now()).getUTCMinutes();
      if(m===5||m===10)
        ctx.waitUntil(import('./order-flow-coverage.mjs').then(mod=>
          mod.collectGateObservedCoverage(env,controller.scheduledTime||Date.now())
        ).catch(()=>console.warn('order_flow_hourly_evidence_failed')));
    }
    if(controller.cron==='* * * * *'&&env.AUTO_ORDER_FLOW_LIVE==='true'&&env.ORDER_FLOW_LIVE_COLLECTOR)
      ctx.waitUntil(env.ORDER_FLOW_LIVE_COLLECTOR.getByName('gate-live-phase33')
        .fetch('https://flow/tick',{method:'POST'}).then(async r=>{
          if(!r.ok)console.warn('phase33_order_flow_collector_unavailable',r.status);
          await r.body?.cancel();
        }).catch(()=>console.warn('phase33_order_flow_collector_tick_failed')));
    const live=LIVE_ENABLED(env)&&Boolean(env.MARKET_LIVE_COLLECTOR);
    if(controller.cron==='*/5 * * * *'&&env.AUTO_DERIVATIVES_FETCH==='true')
      ctx.waitUntil(collectGateDerivatives(env).catch(()=>console.error('derivatives_collect_failed')));
    if(controller.cron==='*/5 * * * *'&&env.AUTO_LEGACY_BACKFILL==='true'&&env.BTC_RESERVE_COLLECTOR){
      ctx.waitUntil(env.BTC_RESERVE_COLLECTOR.getByName('reserve-btc')
        .fetch('https://whales/backfill').catch(e=>console.error('legacy_backfill_failed',String(e?.message||e||'unknown').replace(/[^A-Za-z0-9_-]/g,'_').slice(0,80))));
    }
    // Keep the 4 BTC watchlist addresses current and progress their
    // historical cursors using existing Cloudflare minute ticks only.
    if(controller.cron==='* * * * *'&&env.AUTO_WHALE_FETCH==='true'&&env.BTC_RESERVE_COLLECTOR){
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

// Phase 33 isolated observer; lazy loading preserves legacy data-URI regression harness.
export class OrderFlowLiveCollector extends DurableObject {
  constructor(ctx,env){super(ctx,env);this.ctx=ctx;this.env=env;this.flow=null;}
  async handler(){
    if(!this.flow){
      const module=await import('./order-flow-live.mjs');
      this.flow=new module.OrderFlowLiveLogic(this.ctx,this.env);
      await this.flow.ready;
    }
    return this.flow;
  }
  async fetch(request){return (await this.handler()).fetch(request);}
  async alarm(){return (await this.handler()).alarm();}
}
