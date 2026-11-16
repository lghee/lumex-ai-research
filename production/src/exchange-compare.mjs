/** LUMEX public five-exchange comparison v1, never place orders or access private accounts.
 * Cloudflare worker module. Calls only official public derivatives market endpoints.
 * No exchange API keys, no symbol in path except BTC/ETH/SOL/XRP USDT perpetual.
 * Account counts, OI notional, and funding are independent metrics; never sum account ratios.
 */
export const EX_COINS = Object.freeze(['BTC','ETH','SOL','XRP']);
export const EX_NAMES = Object.freeze(['Binance','Bybit','OKX','Bitget','Gate']);
export const EX_PREFIX = 'market-hub/exchange-compare/v1/';
const schema='lumex_exchange_compare_v1';
const validCoin = c => EX_COINS.includes(c);
const num = (v,min=0,max=1e18) => {
  if(v===null||v===undefined||v===''||typeof v==='boolean') return null;
  const n=Number(v);return Number.isFinite(n)&&n>=min&&n<=max?n:null;
};
const r4 = n => n===null?null:Number(n.toFixed(4));
const safeTime = (v,now,allowNow=false) => {
  const n=num(v,1500000000,4102444800000);
  if(n===null)return allowNow?now:null;
  const ms=n<1e11?n*1000:n;
  return ms<now-24*3600000||ms>now+120000?null:ms;
};
const nval = (x,now) => x===null?null:Number(x.toFixed(8));
function account(long,short,ts,now,source,method='direct_account_share'){
  const a=num(long,0,1),b=num(short,0,1),stamp=safeTime(ts,now);
  if(a===null||b===null||stamp===null||Math.abs(a+b-1)>.04) return null;
  return {long_pct:r4(a*100),short_pct:r4(b*100),asof_ms:stamp,source,
    denominator:'exchange_long_short_accounts',method};
}
function accountFromRatio(raw,ts,now,source){
  const r=num(raw,0.00001,100000),stamp=safeTime(ts,now);
  if(r===null||stamp===null)return null;
  return account(r/(1+r),1/(1+r),stamp,now,source,'derived_from_account_long_short_ratio');
}
function oi(value,unit,ts,now,source,method='exchange_reported_quote_notional'){
  const v=num(value,0.0001,1e16),stamp=safeTime(ts,now,true);
  if(v===null||stamp===null)return null;
  return {value:r4(v),unit,asof_ms:stamp,source,method};
}
function funding(rate,interval,ts,now,source){
  const v=num(rate,-0.2,0.2),stamp=safeTime(ts,now,true);
  if(v===null||stamp===null)return null;
  const hours=num(interval,1,24);
  return {rate_pct:Number((v*100).toFixed(6)),interval_hours:hours===null?null:hours,
    asof_ms:stamp,source,rate_kind:'latest_or_next_exchange_indicated'};
}
async function fetchJson(url,fetchImpl){
  const response=await fetchImpl(url,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(7200)});
  if(!response.ok)throw Error('http_'+response.status);
  const text=await response.text();
  if(text.length<2||text.length>420000)throw Error('invalid_size');
  let payload;try{payload=JSON.parse(text);}catch{throw Error('invalid_json');}
  // Some exchanges return HTTP 200 even when their API refuses a location.
  // Never silently classify this as a valid zero/empty market observation.
  if(payload&&typeof payload==='object'&&!Array.isArray(payload)){
    const msg=String(payload.msg||payload.message||'').toLowerCase();
    if(/restricted location|restricted region|not available in your region|not eligible/.test(msg))
      throw Error('provider_region_restricted');
    if(payload.code!==undefined&&!['0','00000',0].includes(payload.code))
      throw Error('provider_business_error');
    if(payload.retCode!==undefined&&payload.retCode!==0)
      throw Error('provider_business_error');
  }
  return payload;
}
async function safeFetch(url,fetchImpl){try{return {ok:true,body:await fetchJson(url,fetchImpl)};}catch(e){return {ok:false,error:String(e?.message||e).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,35)};}}
function row(name,now){return {exchange:name,symbol:null,observed_at_ms:now,status:'unavailable',
  account:null,open_interest:null,funding:null,missing:[],errors:[],market_scope:'usdt_perpetual_public'};}
function finish(x,now){
  for(const k of ['account','open_interest','funding']){
    const v=x[k];
    if(v && (!Number.isFinite(v.asof_ms)||v.asof_ms>now+120000||now-v.asof_ms>25*60000)){
      x[k]=null;x.errors.push(k+':source_stale');
    }
  }
  x.missing=['account','open_interest','funding'].filter(k=>x[k]===null);
  // A 200 response with a wrong schema is NOT evidence of a current metric.
  for(const k of x.missing)if(!x.errors.some(e=>e.startsWith(k+':')))
    x.errors.push(k+':missing_or_invalid');
  x.status=x.missing.length===0?'ok':x.missing.length===3?'unavailable':'partial';
  return x;
}
function rerr(x,prefix,s){if(!s.ok)x.errors.push(prefix+':'+s.error);}
function stampLatest(list,now,field){if(!Array.isArray(list))return null;return [...list].filter(x=>x&&x[field]).sort((a,b)=>Number(b[field])-Number(a[field]))[0]||null;}
export async function readBinance(coin,fetchImpl=fetch,now=Date.now()){
  const x=row('Binance',now),sym=coin+'USDT',base='https://fapi.binance.com';x.symbol=sym;
  const urls=[base+'/futures/data/globalLongShortAccountRatio?symbol='+sym+'&period=5m&limit=2',
    base+'/futures/data/openInterestHist?symbol='+sym+'&period=5m&limit=2',
    base+'/fapi/v1/premiumIndex?symbol='+sym];
  const [a,b,c]=await Promise.all(urls.map(u=>safeFetch(u,fetchImpl)));
  rerr(x,'accounts',a);rerr(x,'oi',b);rerr(x,'funding',c);
  if(a.ok){const v=stampLatest(a.body,now,'timestamp');if(v)x.account=account(v.longAccount,v.shortAccount,v.timestamp,now,'binance_global_long_short_accounts_5m');}
  if(b.ok){const v=stampLatest(b.body,now,'timestamp');if(v)x.open_interest=oi(v.sumOpenInterestValue,'USDT',v.timestamp,now,'binance_futures_open_interest_hist_5m');}
  if(c.ok && !Array.isArray(c.body)){const v=c.body;x.funding=funding(v.lastFundingRate,null,v.time||now,now,'binance_premium_index_last_funding_rate');}
  return finish(x,now);
}
/** Both mainnet API domains are officially documented by Bybit. No private APIs.
 * The second domain is a supported mainnet host, not a substitute exchange.
 * True IP/region restrictions remain failures; never conceal them with Gate data.
 */
async function bybitPublic(path,fetchImpl){
  const primary=await safeFetch('https://api.bybit.com/v5/market/'+path,fetchImpl);
  if(primary.ok)return primary;
  // Do not turn geographic restriction into fake values; an allowed official
  // hostname may be more reliable during ordinary DNS, routing or CDN incidents.
  const secondary=await safeFetch('https://api.bytick.com/v5/market/'+path,fetchImpl);
  return secondary.ok?{...secondary,source_host:'api.bytick.com'}:
    {ok:false,error:primary.error,secondary_error:secondary.error};
}
export async function readBybit(coin,fetchImpl=fetch,now=Date.now()){
  const x=row('Bybit',now),sym=coin+'USDT';x.symbol=sym;
  const [a,b]=await Promise.all([
    bybitPublic('account-ratio?category=linear&symbol='+sym+'&period=5min&limit=2',fetchImpl),
    bybitPublic('tickers?category=linear&symbol='+sym,fetchImpl)]);
  if(a.source_host)x.source_hosts={...(x.source_hosts||{}),account:a.source_host};
  if(b.source_host)x.source_hosts={...(x.source_hosts||{}),ticker:b.source_host};
  rerr(x,'accounts',a);rerr(x,'ticker',b);
  if(!a.ok&&a.secondary_error)x.errors.push('accounts_secondary:'+a.secondary_error);
  if(!b.ok&&b.secondary_error)x.errors.push('ticker_secondary:'+b.secondary_error);
  if(a.ok&&a.body?.retCode===0){const v=stampLatest(a.body?.result?.list,now,'timestamp');if(v)x.account=account(v.buyRatio,v.sellRatio,v.timestamp,now,'bybit_long_short_account_ratio_5min');}
  if(b.ok&&b.body?.retCode===0){const v=b.body?.result?.list?.find(z=>z.symbol===sym);if(v){
    x.open_interest=oi(v.openInterestValue,'USDT',now,now,'bybit_linear_ticker_open_interest_value');
    x.funding=funding(v.fundingRate,null,now,now,'bybit_linear_ticker_current_funding_rate');
  }}
  return finish(x,now);
}
export async function readOKX(coin,fetchImpl=fetch,now=Date.now()){
  const x=row('OKX',now),sym=coin+'-USDT-SWAP',base='https://www.okx.com';x.symbol=sym;
  const [a,b,c]=await Promise.all([
    safeFetch(base+'/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy='+coin+'&period=5m',fetchImpl),
    safeFetch(base+'/api/v5/public/open-interest?instType=SWAP&instId='+sym,fetchImpl),
    safeFetch(base+'/api/v5/public/funding-rate?instId='+sym,fetchImpl)]);
  rerr(x,'accounts',a);rerr(x,'oi',b);rerr(x,'funding',c);
  if(a.ok&&a.body?.code==='0'){
    const d=Array.isArray(a.body.data)?a.body.data:[];
    const v=d.find(z=>Array.isArray(z)&&z.length>=2)||d[0];
    if(Array.isArray(v))x.account=accountFromRatio(v[1],v[0],now,'okx_rubik_contract_account_ratio_5m');
    else if(v&&typeof v==='object')x.account=accountFromRatio(v.ratio||v.longShortRatio,v.ts,now,'okx_rubik_contract_account_ratio_5m');
  }
  if(b.ok&&b.body?.code==='0'){
    const v=b.body?.data?.find(z=>z.instId===sym);if(v)x.open_interest=oi(v.oiUsd,'USD',v.ts,now,'okx_public_open_interest_usd');
  }
  if(c.ok&&c.body?.code==='0'){
    const v=c.body?.data?.find(z=>z.instId===sym);if(v)x.funding=funding(v.fundingRate,null,v.ts||now,now,'okx_public_current_funding_rate');
  }
  return finish(x,now);
}
export async function readBitget(coin,fetchImpl=fetch,now=Date.now()){
  const x=row('Bitget',now),sym=coin+'USDT',base='https://api.bitget.com/api/v3/market/';x.symbol=sym;
  const [a,b,c]=await Promise.all([
    safeFetch(base+'futures-account-long-short?symbol='+sym+'&period=5m',fetchImpl),
    safeFetch(base+'open-interest-history?symbol='+sym+'&period=5m',fetchImpl),
    safeFetch(base+'current-fund-rate?category=USDT-FUTURES&symbol='+sym,fetchImpl)]);
  rerr(x,'accounts',a);rerr(x,'oi',b);rerr(x,'funding',c);
  if(a.ok&&a.body?.code==='00000'){
    const d=Array.isArray(a.body?.data)?a.body.data:[];
    const v=stampLatest(d,now,'ts');if(v)x.account=account(v.longAccountRatio,v.shortAccountRatio,v.ts,now,'bitget_futures_account_long_short_5m');
  }
  // Bitget's Classic futures public v2 API publishes the exact same
  // account-holder ratios. Use only when v3 is missing or rejected.
  // Never substitute futures-position ratio or taker-volume ratio.
  if(!x.account&&a.error!=='provider_region_restricted'&&a.error!=='http_451'){
    await new Promise(resolve=>setTimeout(resolve,1100)); // 1 public account statistics request / second / IP.
    const alt=await safeFetch('https://api.bitget.com/api/v2/mix/market/account-long-short?symbol='+
      sym+'&productType=USDT-FUTURES&period=5m',fetchImpl);
    if(alt.ok&&alt.body?.code==='00000'){
      const d=Array.isArray(alt.body?.data)?alt.body.data:[];
      const v=stampLatest(d,now,'ts');
      if(v)x.account=account(v.longAccountRatio,v.shortAccountRatio,v.ts,now,
        'bitget_v2_public_account_long_short_5m');
    }
    if(!alt.ok)x.errors.push('accounts_secondary:'+alt.error);
    if(alt.ok&&!x.account)x.errors.push('accounts_secondary:stale_or_invalid');
  }
  if(b.ok&&b.body?.code==='00000'){
    const d=Array.isArray(b.body?.data?.list)?b.body.data.list:[];
    const v=stampLatest(d.filter(z=>z.symbol===sym),now,'timestamp');if(v)x.open_interest=oi(v.openInterestValue,'USDT',v.timestamp,now,'bitget_open_interest_hist_5m_quote');
  }
  if(c.ok&&c.body?.code==='00000'){
    const v=c.body?.data?.find(z=>z.symbol===sym);if(v)x.funding=funding(v.fundingRate,v.fundingRateInterval,now,now,'bitget_current_funding_rate');
  }
  return finish(x,now);
}
export async function readGate(coin,fetchImpl=fetch,now=Date.now()){
  const x=row('Gate',now),sym=coin+'_USDT',base='https://api.gateio.ws/api/v4/futures/usdt/';x.symbol=sym;
  const [a,b]=await Promise.all([
    safeFetch(base+'contract_stats?contract='+sym+'&interval=5m&limit=4',fetchImpl),
    safeFetch(base+'tickers?contract='+sym,fetchImpl)]);
  rerr(x,'stats',a);rerr(x,'ticker',b);
  if(a.ok&&Array.isArray(a.body)){
    const rows=a.body.filter(v=>v.contract===sym||v.contract===undefined);
    const v=stampLatest(rows,now,'time');if(v){
      const lo=num(v.long_users,0,1e12),sh=num(v.short_users,0,1e12);
      if(lo!==null&&sh!==null&&lo+sh>0)x.account=account(lo/(lo+sh),sh/(lo+sh),v.time,now,'gate_public_contract_stats_long_short_users_5m','derived_from_reported_long_short_user_counts');
      x.open_interest=oi(v.open_interest_usd,'USD',v.time,now,'gate_public_contract_stats_open_interest_usd');
    }
  }
  if(b.ok&&Array.isArray(b.body)){
    const v=b.body.find(z=>z.contract===sym);if(v)x.funding=funding(v.funding_rate,null,now,now,'gate_usdt_futures_ticker_funding_rate');
  }
  return finish(x,now);
}
const readers=[readBinance,readBybit,readOKX,readBitget,readGate];
export function buildExchangeComparison(coin,rows,now=Date.now()){
  if(!validCoin(coin))throw Error('invalid_symbol');
  if(rows.length!==5||rows.some((r,i)=>r.exchange!==EX_NAMES[i]))throw Error('exchange_rows_invalid');
  const up=rows.filter(r=>r.account!==null&&r.account.long_pct>r.account.short_pct).length;
  const down=rows.filter(r=>r.account!==null&&r.account.long_pct<r.account.short_pct).length;
  const ties=rows.filter(r=>r.account!==null&&r.account.long_pct===r.account.short_pct).length;
  const counts={account:rows.filter(r=>r.account).length,open_interest:rows.filter(r=>r.open_interest).length,
    funding:rows.filter(r=>r.funding).length};
  return {ok:true,schema,symbol:coin+'USDT',generated_at_ms:now,exchanges:rows,
    coverage:{...counts,total_exchanges:5,long_dominant:up,short_dominant:down,balanced:ties,
      unavailable_account:5-counts.account},
    aggregation:'none',missing_as_zero:false,
    interpretation:'계정 수 비율, 미결제약정 거래소별 규모, 펀딩비는 서로 독립된 관측 지표입니다.',
    order_execution:false,private_api_used:false};
}
export async function collectExchangeCompare(env,{now=Date.now(),fetchImpl=fetch,coins=null}={}){
  if(!env?.MARKET_DATA)throw Error('r2_binding_missing');
  const selection=coins||EX_COINS.filter((c,i)=>Math.floor(i/2)===Math.floor(now/300000)%2);
  if(selection.length<1||selection.length>2||selection.some(c=>!validCoin(c)))throw Error('invalid_batch');
  const results=[];
  for(let slot=0;slot<selection.length;slot++){
    if(slot>0)await new Promise(resolve=>setTimeout(resolve,1150)); // Bitget account-ratio: 1 request/second/IP.
    const c=selection[slot];
    // 2 coins / 5-minute Cron => up to 28 HTTP subrequests/run, conservative free-tier budget.
    const exchanges=await Promise.all(readers.map(fn=>fn(c,fetchImpl,now).catch(()=>null)));
    const rows=exchanges.map((r,i)=>r||row(EX_NAMES[i],now));
    rows.forEach((r,i)=>r.symbol||=(EX_NAMES[i]==='Gate'?c+'_USDT':EX_NAMES[i]==='OKX'?c+'-USDT-SWAP':c+'USDT'));
    // Explicitly licensed Coinalyze provider: independently verifies the real
    // Binance USDT perpetual before accepting source-attributed account/OI.
    // Missing secret or commercial-display permission => never fetch.
    if(rows[0] && (rows[0].account===null||rows[0].open_interest===null||
       rows[0].funding===null) && env.COINALYZE_API_KEY &&
       env.COINALYZE_COMMERCIAL_USE_APPROVED==='true'){
      try{
        const mod=await import('./coinalyze-binance.mjs');
        const backup=await mod.coinalyzeBinanceBackup(c,env,{now,fetchImpl});
        if(backup?.enabled){
          let attached=0;
          for(const kind of ['account','open_interest','funding']){
            if(rows[0][kind]===null&&backup[kind]){
              rows[0][kind]=backup[kind];attached++;
            }
          }
          rows[0].errors.push(...(backup.errors||[]).map(e=>
            'coinalyze:'+String(e).replace(/[^A-Za-z0-9_-]/g,'_').slice(0,85)));
          if(attached){
            rows[0].backup_provider='Coinalyze';
            rows[0].backup_venue='Binance';
            rows[0].attribution='Data by Coinalyze · Binance';
            rows[0].attribution_url='https://coinalyze.net/';
            finish(rows[0],now);
          }
        }
      }catch(e){rows[0].errors.push('coinalyze:collector_error');}
    }
    const snapshot=buildExchangeComparison(c,rows,now);
    // Last verified values are strictly historical and NEVER counted in current coverage.
    // Preserve them only for an explicitly labeled 'previous reading' UI.
    try{
      const previous=await env.MARKET_DATA.get(EX_PREFIX+'latest/'+c+'.json');
      const old=previous?await previous.json():null;
      if(old?.schema===schema&&old.symbol===c+'USDT'&&Array.isArray(old.exchanges)){
        for(let i=0;i<rows.length;i++){
          const prior=old.exchanges.find(r=>r.exchange===rows[i].exchange);
          if(!prior)continue;
          for(const kind of ['account','open_interest','funding']){
            if(rows[i][kind]!==null)continue;
            const v=prior[kind]||prior.last_verified?.[kind];
            if(!v||!Number.isFinite(v.asof_ms)||v.asof_ms>now||now-v.asof_ms>2*3600000)continue;
            rows[i].last_verified??={};rows[i].last_verified[kind]=v;
          }
        }
      }
    }catch{/* Previous readings are best effort; never block current sampling. */}
    const date=new Date(now).toISOString().slice(0,10).replace(/-/g,'/');
    await env.MARKET_DATA.put(EX_PREFIX+'latest/'+c+'.json',JSON.stringify(snapshot),{httpMetadata:{contentType:'application/json'}});
    await env.MARKET_DATA.put(EX_PREFIX+'history/'+date+'/'+c+'-'+now+'.json',JSON.stringify(snapshot),{httpMetadata:{contentType:'application/json'}});
    results.push({symbol:c+'USDT',coverage:snapshot.coverage,errors:rows.map(r=>({exchange:r.exchange,codes:r.errors||[]}))});
  }
  await env.MARKET_DATA.put(EX_PREFIX+'health.json',JSON.stringify({ok:true,schema:'lumex_exchange_compare_health_v2',last_run_ms:now,coins:selection,results,
    // Aggregated source diagnostics; no secret keys or full provider responses.
    error_codes:Object.fromEntries(selection.map(c=>[c,results.find(r=>r.symbol===c+'USDT')?.errors||[]])),
    cron_step_minutes:5,coin_update_target_minutes:10,order_execution:false}));
  return {ok:true,results};
}
export async function serveExchangeCompare(request,env){
  const u=new URL(request.url),coin=String(u.searchParams.get('symbol')||'').replace(/USDT$/,'').toUpperCase();
  if(!validCoin(coin))return new Response(JSON.stringify({ok:false,error:'invalid_symbol'}),{status:400,headers:{'content-type':'application/json'}});
  try{
    const object=await env.MARKET_DATA?.get(EX_PREFIX+'latest/'+coin+'.json');
    if(!object)return new Response(JSON.stringify({ok:false,error:'not_yet_collected'}),{status:503,headers:{'content-type':'application/json'}});
    const data=await object.json();
    if(data?.schema!==schema||data.symbol!==coin+'USDT'||data.order_execution!==false||!Array.isArray(data.exchanges)||data.exchanges.length!==5)
      throw Error('schema');
    const age=Date.now()-data.generated_at_ms;
    const safeAge=Number.isFinite(age)&&age>=-120000&&age<=30*60000;
    if(!safeAge)return new Response(JSON.stringify({ok:false,error:'snapshot_stale',generated_at_ms:data.generated_at_ms}),{status:503,headers:{'content-type':'application/json','cache-control':'no-store'}});
    return new Response(JSON.stringify({...data,age_ms:Math.max(0,age),collection_delayed:age>12*60000}),{headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}});
  }catch{return new Response(JSON.stringify({ok:false,error:'snapshot_read_error'}),{status:503,headers:{'content-type':'application/json'}});}
}

/** Bearer-protected diagnostics. Never return auth keys, IPs or provider bodies. */
export async function serveExchangeCompareHealth(env){
  try{
    const item=await env.MARKET_DATA?.get(EX_PREFIX+'health.json');
    if(!item)return new Response(JSON.stringify({ok:false,error:'collector_not_started'}),{status:503,headers:{'content-type':'application/json','cache-control':'no-store'}});
    const health=await item.json();
    if(health?.schema!=='lumex_exchange_compare_health_v2')throw Error('invalid_health');
    return new Response(JSON.stringify(health),{headers:{'content-type':'application/json','cache-control':'no-store'}});
  }catch{return new Response(JSON.stringify({ok:false,error:'collector_health_unavailable'}),{status:503,headers:{'content-type':'application/json'}});}
}
