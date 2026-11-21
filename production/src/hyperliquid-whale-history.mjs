/* LUMEX: Hyperliquid public tracked-wallet candle and PnL bridge. No orders or private keys. */
const ROOT='market-hub/hyperliquid-whales/v1/';
const INFO='https://api.hyperliquid.xyz/info';
const INTERVALS={'5m':[300000,86400000],'15m':[900000,259200000],'1h':[3600000,1209600000],'4h':[14400000,5184000000],'1d':[86400000,15552000000]};
const N=v=>v!==null&&v!==undefined&&v!==''&&typeof v!=='boolean'&&Number.isFinite(Number(v))?Number(v):null;
const addr=x=>/^0x[0-9a-f]{40}$/.test(x);
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'public, max-age=30','x-content-type-options':'nosniff'}});
async function get(bucket,key){const o=await bucket.get(ROOT+key);return o?await o.json():null}
async function save(bucket,key,body){await bucket.put(ROOT+key,JSON.stringify(body),{httpMetadata:{contentType:'application/json'}})}
export function normalizeWhaleCandles(raw,coin,interval,now=Date.now()){
 const span=INTERVALS[interval]?.[0];if(!span||!Array.isArray(raw)||raw.length>2200)return null;
 const out=[];let prev=-1;
 for(const row of raw){
  if(row?.s!==coin||row?.i!==interval)continue;
  const t=N(row.t),T=N(row.T),o=N(row.o),h=N(row.h),l=N(row.l),c=N(row.c),v=N(row.v);
  if([t,T,o,h,l,c,v].some(x=>x===null)||t<=prev||T<t||T-t>=span||T>=now||
    ![o,h,l,c].every(x=>x>0)||l>Math.min(o,c)||h<Math.max(o,c)||h<l||v<0)continue;
  out.push({t,o,h,l,c,v});prev=t;
 }
 if(out.length<2)return null;
 return {ok:true,schema:'lumex_whale_candles_v1',source:'Hyperliquid',coin,interval,asof_ms:now,
   candles:out.slice(-500),verified_closed_only:true,synthetic_candles:false,
   provenance:'official_hyperliquid_candleSnapshot',trading_enabled:false};
}
export function normalizeWhalePortfolio(raw,address,now=Date.now()){
 if(!Array.isArray(raw)||raw.length>16)return null;
 const lookup=new Map(raw.filter(x=>Array.isArray(x)&&typeof x[0]==='string'&&x[1]&&typeof x[1]==='object'));
 const series={},scope={};
 for(const [key,perp,general] of [['week','perpWeek','week'],['month','perpMonth','month'],['allTime','perpAllTime','allTime']]){
  for(const label of [perp,general]){
   const h=lookup.get(label)?.pnlHistory;if(!Array.isArray(h)||h.length<2||h.length>15000)continue;
   let points=[],last=-1;
   for(const row of h){
    const t=N(row?.[0]),v=N(row?.[1]);
    if(t===null||v===null||!Number.isSafeInteger(t)||t<1450000000000||t>now+120000||t<=last||Math.abs(v)>1e14)continue;
    last=t;points.push([t,v]);
   }
   if(points.length>=2){series[key]=points.slice(-500);scope[key]=label;break}
  }
 }
 if(!Object.keys(series).length)return null;
 return {ok:true,schema:'lumex_whale_portfolio_v1',source:'Hyperliquid',address,asof_ms:now,
   pnl_history:series,pnl_scope:scope,curve_type:'exchange_reported_pnl_not_equity',trading_enabled:false};
}
async function official(payload,fetchImpl){
 const r=await fetchImpl(INFO,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},
   body:JSON.stringify(payload),signal:AbortSignal.timeout(12500)});
 if(!r.ok)throw Error('info_http_'+r.status);
 if(Number(r.headers.get('content-length')||0)>2600000)throw Error('too_large');
 const s=await r.text();if(s.length<2||s.length>2600000)throw Error('too_large');
 return JSON.parse(s);
}
export async function whaleHistoryRoute(request,env,{now=Date.now(),fetchImpl=fetch}={}){
 const url=new URL(request.url),kind=url.pathname.endsWith('/hyperliquid-whale-candles')?'candles':
  url.pathname.endsWith('/hyperliquid-whale-portfolio')?'portfolio':null;
 if(request.method!=='GET'||!kind||!env?.MARKET_DATA)return response({ok:false,error:'invalid_request'},400);
 const address=(url.searchParams.get('address')||'').toLowerCase(),coin=(url.searchParams.get('coin')||'').toUpperCase(),interval=url.searchParams.get('interval')||'';
 if(!addr(address))return response({ok:false,error:'invalid_wallet'},400);
 if(kind==='candles'&&(!/^[A-Z0-9]{2,18}$/.test(coin)||!INTERVALS[interval]))return response({ok:false,error:'invalid_market'},400);
 try{
  const board=await get(env.MARKET_DATA,'latest.json');
  if(!board?.ok||!Array.isArray(board?.rows)||board.rows.length>80||!board.rows.some(r=>r.address===address))
    return response({ok:false,error:'wallet_not_tracked'},404);
  if(kind==='candles'){
   const profile=await get(env.MARKET_DATA,'profiles/'+address+'.json');
   const coins=new Set([...(profile?.positions||[]),...(profile?.fills||[])].map(x=>x?.coin).filter(Boolean));
   if(!coins.has(coin))return response({ok:false,error:'market_not_observed_for_wallet'},404);
  }
  const key='history-v2/'+kind+'/'+address+(kind==='candles'?'/'+coin+'-'+interval:'')+'.json';
  let old=await get(env.MARKET_DATA,key);
  const ttl=kind==='candles'?120000:600000;
  if(old?.ok===true&&old.source==='Hyperliquid'&&old.asof_ms<=now&&now-old.asof_ms<ttl)return response(old);
  const payload=kind==='portfolio'?{type:'portfolio',user:address}:
   {type:'candleSnapshot',req:{coin,interval,startTime:now-INTERVALS[interval][1],endTime:now}};
  const raw=await official(payload,fetchImpl);
  const doc=kind==='portfolio'?normalizeWhalePortfolio(raw,address,now):normalizeWhaleCandles(raw,coin,interval,now);
  if(!doc)return response({ok:false,error:'source_response_has_no_verified_series'},503);
  await save(env.MARKET_DATA,key,doc);return response(doc);
 }catch{return response({ok:false,error:'official_source_unavailable'},503)}
}
