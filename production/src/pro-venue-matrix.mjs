/** UID/PRO top50 cross-venue public snapshot.
 * Source-isolated values, one bounded bulk call per venue each 5 minute cron.
 * No account ratios or OI fabricated from contract counts.
 */
const KEY='market-hub/universe/top50-five-venues-v1.json';
const NAMES=['Binance','Bybit','OKX','Bitget','Gate'];
const SOURCES=[
 ['Bybit','https://api.bybit.com/v5/market/tickers?category=linear'],
 ['Gate','https://api.gateio.ws/api/v4/futures/usdt/tickers'],
 ['Binance','https://fapi.binance.com/fapi/v1/premiumIndex'],
 ['OKX','https://www.okx.com/api/v5/public/open-interest?instType=SWAP'],
 ['Bitget','https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES']
];
const n=(v,low,high)=>{if(v===null||v===undefined||v===''||typeof v==='boolean')return null;const x=Number(v);return Number.isFinite(x)&&x>=low&&x<=high?x:null;};
const safe=(x)=>n(x,0.000000000001,1e10);
const pct=(x)=>{const y=n(x,-0.2,0.2);return y===null?null:Number((y*100).toFixed(7));};
function items(venue,raw){
 if(venue==='Bybit')return raw?.retCode===0?raw?.result?.list:null;
 if(venue==='Gate'||venue==='Binance')return Array.isArray(raw)?raw:null;
 if(venue==='OKX')return raw?.code==='0'&&Array.isArray(raw?.data)?raw.data:null;
 if(venue==='Bitget')return raw?.code==='00000'&&Array.isArray(raw?.data)?raw.data:null;
 return null;
}
function key(venue,item){
 if(venue==='Gate')return String(item?.contract||'').replace('_USDT','USDT');
 if(venue==='OKX')return String(item?.instId||'').replace('-USDT-SWAP','USDT');
 return String(item?.symbol||'');
}
export function parseVenueBulk(venue,raw,allowlist,now=Date.now()){
 const rows=items(venue,raw);
 if(!Array.isArray(rows)||rows.length<1||rows.length>4500)return null;
 const map=new Map();
 for(const r of rows){
  const symbol=key(venue,r);if(!allowlist.has(symbol))continue;
  if(map.has(symbol))continue;
  let price=null,oi=null,funding=null;
  if(venue==='Bybit'){price=safe(r?.markPrice||r?.lastPrice);oi=n(r?.openInterestValue,0.00001,1e20);funding=pct(r?.fundingRate);}
  if(venue==='Gate'){price=safe(r?.mark_price||r?.last);oi=n(r?.open_interest_usd,0.00001,1e20);funding=pct(r?.funding_rate);}
  if(venue==='Binance'){price=safe(r?.markPrice);funding=pct(r?.lastFundingRate);}
  if(venue==='OKX'){oi=n(r?.oiUsd,0.00001,1e20);}
  if(venue==='Bitget'){price=safe(r?.markPrice||r?.lastPr);funding=pct(r?.fundingRate);}
  if(price===null&&oi===null&&funding===null)continue;
  map.set(symbol,{symbol,exchange:venue,mark_price:price,oi_usd:oi,funding_pct:funding,
    observed_ms:now,oi_unit:oi===null?null:'USD_approx_or_reported_quote',status:'observed'});
 }
 return map;
}
export function matrix(top50,rawByVenue,now=Date.now()){
 if(top50?.schema!=='lumex_uid_top50_v1'||!Array.isArray(top50?.items)||top50.items.length<1||
   top50.items.length>50||top50?.generated_at_ms>now+120000||now-top50.generated_at_ms>15*60000)return null;
 const symbols=top50.items.map(x=>x.symbol),allowed=new Set(symbols);
 const lookup=Object.fromEntries(NAMES.map(venue=>[venue,parseVenueBulk(venue,rawByVenue[venue],allowed,now)]));
 const markets=Object.fromEntries(symbols.map(symbol=>[symbol,NAMES.map(exchange=>lookup[exchange]?.get(symbol)||{
   symbol,exchange,status:'unavailable',mark_price:null,oi_usd:null,funding_pct:null,observed_ms:null,oi_unit:null
 })]));
 return {ok:true,schema:'lumex_uid_top50_venue_matrix_v1',generated_at_ms:now,universe_generated_ms:top50.generated_at_ms,
    order_execution:false,source_scope:'public_futures_source_isolated',aggregation:'none',market_total_estimate:false,
    supported_symbols:symbols,venues:NAMES,markets,
    observed_sources:Object.fromEntries(NAMES.map(name=>[name,lookup[name]!==null]))};
}
async function json(url){
 const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),6900);
 try{
  const r=await fetch(url,{headers:{accept:'application/json'},signal:controller.signal});
  if(!r.ok)throw Error('provider_status');const size=Number(r.headers.get('content-length')||0);
  if(size>2000000)throw Error('size');const txt=await r.text();if(txt.length<2||txt.length>2000000)throw Error('size');
  return JSON.parse(txt);
 }finally{clearTimeout(timeout)}
}
export async function collectVenueMatrix(env,now=Date.now()){
 if(!env?.MARKET_DATA)return {ok:false,reason:'r2_missing'};
 const o=await env.MARKET_DATA.get('market-hub/universe/bybit-linear-top50-v1.json');
 if(!o)return {ok:false,reason:'universe_missing'};let top50;try{top50=await o.json()}catch{return {ok:false,reason:'invalid_universe'}}
 const response=await Promise.all(SOURCES.map(async ([name,url])=>[name,await json(url).catch(()=>null)]));
 const raw=Object.fromEntries(response);const result=matrix(top50,raw,now);
 if(!result)return {ok:false,reason:'invalid_universe'};
 await env.MARKET_DATA.put(KEY,JSON.stringify(result),{httpMetadata:{contentType:'application/json'}});
 const check=await env.MARKET_DATA.get(KEY);if(!check)return {ok:false,reason:'readback_missing'};
 const verified=await check.json();
 if(verified?.schema!==result.schema||verified?.generated_at_ms!==now||Object.keys(verified.markets||{}).length!==result.supported_symbols.length)
   return {ok:false,reason:'readback_bad'};
 return {ok:true,symbols:result.supported_symbols.length,sources:Object.values(result.observed_sources).filter(Boolean).length};
}
export async function serveVenueMatrix(request,env,now=Date.now()){
 const u=new URL(request.url),symbol=String(u.searchParams.get('symbol')||'');
 const reply=(obj,code=200)=>new Response(JSON.stringify(obj),{status:code,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}});
 if(!/^[A-Z0-9]{2,20}USDT$/.test(symbol))return reply({ok:false,error:'invalid_symbol'},400);
 try{
  const obj=await env?.MARKET_DATA?.get(KEY),doc=obj?await obj.json():null;
  if(doc?.schema!=='lumex_uid_top50_venue_matrix_v1'||doc.ok!==true||doc.order_execution!==false||
     !Number.isSafeInteger(doc.generated_at_ms)||doc.generated_at_ms>now+120000||now-doc.generated_at_ms>15*60000||
     !Array.isArray(doc.venues)||doc.venues.join(',')!==NAMES.join(',')||!Array.isArray(doc.markets?.[symbol]))
    return reply({ok:false,error:'market_data_unavailable'},503);
  return reply({ok:true,schema:'lumex_uid_top50_venues_v1',symbol,generated_at_ms:doc.generated_at_ms,
    venues:doc.markets[symbol],observed_sources:doc.observed_sources,order_execution:false,
    source_scope:'public_futures_source_isolated',aggregation:'none',market_total_estimate:false});
 }catch{return reply({ok:false,error:'data_unavailable'},503)}
}
