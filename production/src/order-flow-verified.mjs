/**
 * LUMEX UID/PRO verified spot/futures executed-flow foundation.
 * OFFLINE ARCHIVES ONLY. No candle is a substitute for live trades.
 * Inputs are Binance OFFICIAL 1h spot and USD-M futures public data, source isolated.
 * No trading, synthetic fills, pooled cross-venue deltas or false "real-time".
 */
const ROOT='market-hub/order-flow/v1/hourly/';
const ASSETS=new Set(['BTC','ETH','SOL','XRP']);
const VENUES=['spot','um-futures'];
const HOUR=3600000, MIN_HOURS=90*24, MAX_HOURS=94*24;
const safe=(x,min,max)=>typeof x!=='boolean'&&x!==null&&x!==''&&Number.isFinite(Number(x))&&Number(x)>=min&&Number(x)<=max?Number(x):null;
const err=(error,status=503)=>new Response(JSON.stringify({ok:false,schema:'lumex_order_flow_error_v1',error,ready:false}),{status,
 headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}});
const ok=doc=>new Response(JSON.stringify(doc),{headers:{'content-type':'application/json','cache-control':'private, no-store','x-content-type-options':'nosniff'}});
const POINTER='market-hub/order-flow/v1/current.json';
const releaseKey=(release,symbol,market)=>ROOT+'releases/'+release+'/'+symbol+'-'+market+'.json';
function checkedPointer(p,now){
 if(p?.schema!=='lumex_flow_archive_pointer_v1'||p?.complete!==true||
    !/^[0-9]{6,16}-[0-9]{1,5}$/.test(p.release_id||'')||
    p.source!=='official_binance_public_1h_klines'||
    p.market_count!==8||!Number.isSafeInteger(p.created_at_ms)||
    p.created_at_ms>now+120000||now-p.created_at_ms>48*HOUR||
    !Array.isArray(p.symbols)||p.symbols.join(',')!=='BTC,ETH,SOL,XRP'||
    !Array.isArray(p.markets)||p.markets.join(',')!=='spot,um-futures')return null;
 return p;
}
export function validateHourlyArchive(doc,symbol,market,now=Date.now()){
 if(!ASSETS.has(symbol)||!VENUES.includes(market)||doc?.schema!=='lumex_flow_hourly_v1'||
  doc?.symbol!==symbol+'USDT'||doc?.market!==market||
  doc?.origin!=='official_binance_public_1h_klines'||doc?.unit!=='USDT_quote'||
  doc?.bar_ms!==HOUR||doc?.filled_missing_hours!==false||doc?.synthetic_values!==false||
  !Array.isArray(doc?.rows)||doc.rows.length<MIN_HOURS||doc.rows.length>MAX_HOURS||
  !Number.isSafeInteger(doc.created_at_ms)||doc.created_at_ms>now+120000||
  !/^[a-f0-9]{64}$/.test(doc.sha256_csv||''))return null;
 let prev=-1,rows=[];
 for(const r of doc.rows){
  if(!Array.isArray(r)||r.length!==5)return null;
  const [t,p,quote,trades,buy]=r;
  if(!Number.isSafeInteger(t)||t%HOUR!==0||t<=prev||
   (prev>0&&t-prev!==HOUR)||t>now-HOUR||
   safe(p,1e-10,1e12)===null||safe(quote,0,1e24)===null||
   !Number.isSafeInteger(trades)||trades<0||trades>1e10||
   safe(buy,0,1e24)===null||buy>quote+Math.max(1e-7,quote*1e-8)||
   (trades===0&&(quote!==0||buy!==0))|| (trades>0&&quote<=0))return null;
  rows.push({t,p,quote,trades,buy,sell:Math.max(0,quote-buy),
   delta:2*buy-quote,avg:trades>0?quote/trades:null});
  prev=t;
 }
 if(doc.start_ms!==rows[0].t||doc.end_ms!==rows.at(-1).t||
  doc.count!==rows.length)return null;
 return {symbol,market,first:rows[0].t,last:prev,rows,created_at_ms:doc.created_at_ms,sha256_csv:doc.sha256_csv};
}
function contiguousTail(rows,count,end){
 const last=rows.length-1;
 if(last<0||rows[last].t<end)return null;
 const index=rows.findIndex(x=>x.t===end);
 if(index<count-1)return null;
 const slice=rows.slice(index-count+1,index+1);
 if(slice.length!==count)return null;
 for(let i=1;i<slice.length;i++)if(slice[i].t-slice[i-1].t!==HOUR)return null;
 return slice;
}
export function computeOrderFlow(spot,futures,now=Date.now(),opts={}){
 if(!spot||!futures||spot.symbol!==futures.symbol||
   spot.market!=='spot'||futures.market!=='um-futures')return null;
 const end=Math.min(spot.last,futures.last),count=MIN_HOURS;
 if(end>now-HOUR||now-end>48*HOUR)return null;
 const a=contiguousTail(spot.rows,count,end),b=contiguousTail(futures.rows,count,end);
 if(!a||!b)return null;
 const daily=[],bars=[];let spotSum=0,futuresSum=0;
 for(let i=0;i<count;i++){
  const s=a[i],f=b[i];
  if(s.t!==f.t)return null;
  spotSum+=s.delta;futuresSum+=f.delta;
  bars.push({t:s.t,close_spot:s.p,close_futures:f.p,
   spot_quote:s.quote,spot_trades:s.trades,spot_avg_quote:s.avg,spot_delta:s.delta,spot_cvd:spotSum,
   futures_quote:f.quote,futures_trades:f.trades,futures_avg_quote:f.avg,
   futures_delta:f.delta,futures_cvd:futuresSum});
 }
 // Do not imply hourly aggregated bars are individual prints or true footprint trades.
 for(let i=0;i<bars.length;i+=24){
  const chunk=bars.slice(i,i+24),last=chunk.at(-1);
  if(chunk.length!==24)return null;
  const sum=key=>chunk.reduce((n,x)=>n+x[key],0);
  daily.push({start_ms:chunk[0].t,end_ms:last.t,
   price:last.close_spot,spot_quote:sum('spot_quote'),futures_quote:sum('futures_quote'),
   spot_delta:sum('spot_delta'),futures_delta:sum('futures_delta'),
   spot_cvd:last.spot_cvd,futures_cvd:last.futures_cvd,
   spot_avg_trade_usdt:sum('spot_trades')>0?sum('spot_quote')/sum('spot_trades'):null,
   futures_avg_trade_usdt:sum('futures_trades')>0?sum('futures_quote')/sum('futures_trades'):null});
 }
 const freshnessHours=(now-end)/HOUR;
 return {ok:true,schema:'lumex_order_flow_history_v1',symbol:spot.symbol+'USDT',
  coverage_hours:count,coverage_days:90,missing_hours:0,historical_last_hour_ms:end,
  historical_age_hours:Number(freshnessHours.toFixed(2)),
  spot_source:'Binance spot 1h public archive',futures_source:'Binance USD-M 1h public archive',
  scope:'binance_market_specific_not_global',granularity:'1h',market_count:2,
  snapshot_only:false,live_verified:false,customer_launch_ready:false,
  true_trade_footprint_available:false,account_identity_available:false,
  metric_definitions:{delta:'2*taker_buy_quote-total_quote',
   average_trade:'total_quote/number_of_trades',
   cvd:'sum of hourly taker quote deltas, reset at 90d window start'},
  daily,latest:daily.at(-1),data_provenance:[
   {market:'spot',sha256_csv:spot.sha256_csv},{market:'um-futures',sha256_csv:futures.sha256_csv}
  ]};
}
/** Read-only historical data and readiness; no customer availability claim until true live stream. */
export async function serveOrderFlowHistory(request,env,{now=Date.now()}={}){
 const u=new URL(request.url),symbol=String(u.searchParams.get('symbol')||'').toUpperCase();
 if(!ASSETS.has(symbol))return err('unsupported_symbol',400);
 if(!env?.MARKET_DATA)return err('r2_not_bound');
 try{
  const pointerObj=await env.MARKET_DATA.get(POINTER);
  const pointer=pointerObj?checkedPointer(await pointerObj.json(),now):null;
  if(!pointer)return err('verified_archive_release_not_activated');
  const [so,fo]=await Promise.all(VENUES.map(v=>env.MARKET_DATA.get(releaseKey(pointer.release_id,symbol,v))));
  if(!so||!fo)return err('verified_release_market_missing');
  if(Number(so.size||0)>520000||Number(fo.size||0)>520000)return err('archive_too_large');
  const [s,f]=await Promise.all([so.json(),fo.json()]);
  const cleanS=validateHourlyArchive(s,symbol,'spot',now),cleanF=validateHourlyArchive(f,symbol,'um-futures',now);
  if(!cleanS||!cleanF)return err('archive_integrity_or_gap_failed');
  const result=computeOrderFlow(cleanS,cleanF,now);
  if(!result)return err('insufficient_contiguous_90_day_window');
  const insights=(await import('./order-flow-insights.mjs')).explainHistoricalFlow(result.daily);
  if(!insights)return err('analysis_quality_failed');
  return ok({...result,insights,archive_release_id:pointer.release_id,archive_release_created_ms:pointer.created_at_ms});
 }catch{return err('order_flow_source_unavailable')}
}
