/**
 * LUMEX Binance market data backup via explicitly-authorized Coinalyze API.
 * No geofence circumvention. The provider, not this Worker, obtains public
 * venue snapshots and must license display by LUMEX's paying customers.
 *
 * Disabled unless COINALYZE_API_KEY (secret) AND
 * COINALYZE_COMMERCIAL_USE_APPROVED=true (owner attestation) are both set.
 *
 * Provider docs: https://api.coinalyze.net/v1/doc/
 * - future-markets: exchange + symbol_on_exchange + contract identity
 * - long-short-ratio-history: t Unix seconds, l/s account percentages
 * - open-interest?convert_to_usd=true: value USD, update seconds
 * - funding-rate value's raw percent/fraction units MUST be verified before
 *   setting COINALYZE_FUNDING_UNIT=percent|fraction. No default guessing.
 */
const ORIGIN='https://api.coinalyze.net/v1';
const KEY='market-hub/exchange-compare/v1/coinalyze-market-map.json';
const COINS=new Set(['BTC','ETH','SOL','XRP']);
const sane=(v,min,max)=>{
  if(v===null||v===undefined||v===''||typeof v==='boolean')return null;
  const n=Number(v);return Number.isFinite(n)&&n>=min&&n<=max?n:null;
};
const toMs=(raw,now)=>{
  const v=sane(raw,1500000000,4102444800000);
  if(v===null)return null;
  const ms=v<1e11?v*1000:v;
  return ms>now+120000||now-ms>25*60000?null:ms;
};
const r4=n=>Number(n.toFixed(4));
async function request(path,secret,fetchImpl,{maxBytes=3000000}={}){
  if(!path.startsWith('/')||path.includes('://'))throw Error('invalid_path');
  const resp=await fetchImpl(ORIGIN+path,{headers:{accept:'application/json',api_key:secret},
    signal:AbortSignal.timeout(11000)});
  if(!resp.ok)throw Error('coinalyze_http_'+resp.status);
  const text=await resp.text();
  if(!text||text.length>maxBytes)throw Error('coinalyze_response_size');
  let value;try{value=JSON.parse(text)}catch{throw Error('coinalyze_response_json')}
  return value;
}
const enabled=env=>Boolean(env?.COINALYZE_API_KEY)&&env?.COINALYZE_COMMERCIAL_USE_APPROVED==='true';
function marketsToMap(exchanges,markets){
  if(!Array.isArray(exchanges)||!Array.isArray(markets)||
    markets.length>250000||exchanges.length>300)throw Error('coinalyze_catalog_schema');
  const code=new Set(exchanges.filter(x=>String(x?.name||'').toLowerCase()==='binance')
    .map(x=>String(x.code||'')));
  if(!code.size)throw Error('coinalyze_binance_not_in_catalog');
  const map={};
  for(const coin of COINS){
    const pair=coin+'USDT';
    const matches=markets.filter(x=>(code.has(String(x.exchange||''))||
      String(x.exchange||'').toLowerCase()==='binance') &&
      x.base_asset===coin&&x.quote_asset==='USDT'&&x.symbol_on_exchange===pair&&
      x.is_perpetual===true&&x.margined==='STABLE'&&
      x.has_long_short_ratio_data===true &&
      typeof x.symbol==='string'&&/^[A-Za-z0-9_.-]{5,50}$/.test(x.symbol));
    if(matches.length===1)map[coin]=matches[0].symbol;
  }
  return map;
}
async function mapFor(env,now,fetchImpl){
  const cached=await env.MARKET_DATA.get(KEY).catch(()=>null);
  if(cached){
    try{
      const d=await cached.json();
      if(d?.schema==='lumex_coinalyze_binance_market_map_v1' &&
         sane(d.validated_at_ms,1500000000000,4102444800000)!==null &&
         now>=d.validated_at_ms&&now-d.validated_at_ms<23*3600000 &&
         d.markets&&typeof d.markets==='object')
        return d.markets;
    }catch{}
  }
  const [exchanges,markets]=await Promise.all([
    request('/exchanges',env.COINALYZE_API_KEY,fetchImpl,{maxBytes:200000}),
    request('/future-markets',env.COINALYZE_API_KEY,fetchImpl,{maxBytes:18000000})
  ]);
  const map=marketsToMap(exchanges,markets);
  if(!Object.keys(map).length)throw Error('coinalyze_binance_matching_missing');
  await env.MARKET_DATA.put(KEY,JSON.stringify({
    schema:'lumex_coinalyze_binance_market_map_v1',validated_at_ms:now,markets:map,
    classification:'verified_binance_usdt_stable_margin_perpetual',order_execution:false}),
    {httpMetadata:{contentType:'application/json'}});
  return map;
}
function readAccount(body,market,now){
  const rows=Array.isArray(body)?body:[];
  const object=rows.find(x=>x?.symbol===market);
  if(!object||!Array.isArray(object.history))return null;
  const matches=[];
  for(const record of object.history){
    const t=toMs(record?.t,now),l=sane(record?.l,0,100),s=sane(record?.s,0,100);
    if(t===null||l===null||s===null||Math.abs(l+s-100)>1.1)continue;
    const r=sane(record?.r,0,100000);
    if(r!==null&&s>0&&Math.abs(r-l/s)>Math.max(.1,l/s*.05))continue;
    matches.push({time:t,long:l,short:s});
  }
  matches.sort((a,b)=>b.time-a.time);
  const x=matches[0];if(!x)return null;
  return {long_pct:r4(x.long),short_pct:r4(x.short),asof_ms:x.time,
    source:'coinalyze_verified_binance_global_long_short_accounts_5min',
    denominator:'exchange_long_short_accounts',method:'venue_reported_account_percentage',
    vendor:'Coinalyze',venue:'Binance',attribution_url:'https://coinalyze.net/'};
}
function readOI(body,market,now){
  const item=Array.isArray(body)?body.find(x=>x?.symbol===market):null;
  const value=sane(item?.value,0.0001,1e16),time=toMs(item?.update,now);
  if(value===null||time===null)return null;
  return {value:r4(value),unit:'USD',asof_ms:time,
    source:'coinalyze_binance_usdt_perpetual_open_interest',
    method:'venue_reported_quote_notional_usd',
    vendor:'Coinalyze',venue:'Binance',attribution_url:'https://coinalyze.net/'};
}
function readFunding(body,market,now,unit){
  if(!['percent','fraction'].includes(unit))return null;
  const item=Array.isArray(body)?body.find(x=>x?.symbol===market):null;
  const raw=sane(item?.value,-0.2,0.2),time=toMs(item?.update,now);
  if(raw===null||time===null)return null;
  const rate=unit==='fraction'?raw*100:raw;
  if(Math.abs(rate)>20)return null;
  return {rate_pct:Number(rate.toFixed(6)),interval_hours:null,
    asof_ms:time,source:'coinalyze_binance_latest_funding',
    rate_kind:'observed_provider_rate',vendor:'Coinalyze',venue:'Binance',
    source_unit_verified:unit,attribution_url:'https://coinalyze.net/'};
}
/** Publicly testable parser; no network unless explicit flags and valid API secret. */
export async function coinalyzeBinanceBackup(coin,env,{now=Date.now(),fetchImpl=fetch}={}){
  if(!COINS.has(coin))throw Error('unsupported_coin');
  if(!enabled(env))return {enabled:false,account:null,open_interest:null,
    funding:null,errors:['coinalyze_not_configured_or_license_not_approved']};
  if(!env.MARKET_DATA)throw Error('r2_binding_required');
  const result={enabled:true,account:null,open_interest:null,funding:null,errors:[]};
  let market;
  try{market=(await mapFor(env,now,fetchImpl))[coin];}
  catch(e){result.errors.push(String(e?.message||'market_map_failure').slice(0,65));return result;}
  if(!market){result.errors.push('binance_market_not_verified');return result;}
  const secret=env.COINALYZE_API_KEY;
  const start=Math.floor((now-30*60000)/1000),end=Math.floor(now/1000);
  const tasks=[
    ['account','/long-short-ratio-history?symbols='+encodeURIComponent(market)+'&interval=5min&from='+start+'&to='+end,readAccount],
    ['open_interest','/open-interest?symbols='+encodeURIComponent(market)+'&convert_to_usd=true',readOI]
  ];
  // Provider documentation has not established the funding value unit.
  // Better to display missing than an invented 100x-scaled funding rate.
  if(['percent','fraction'].includes(env.COINALYZE_FUNDING_UNIT))
    tasks.push(['funding','/funding-rate?symbols='+encodeURIComponent(market),readFunding]);
  else result.errors.push('funding_unit_not_confirmed');
  await Promise.all(tasks.map(async ([field,path,parser])=>{
    try{
      const body=await request(path,secret,fetchImpl,{maxBytes:160000});
      const value=parser(body,market,now,env.COINALYZE_FUNDING_UNIT);
      if(value)result[field]=value;else result.errors.push(field+'_missing_stale_or_schema_invalid');
    }catch(e){result.errors.push(field+'_'+String(e?.message||'provider_error').slice(0,65));}
  }));
  return result;
}
