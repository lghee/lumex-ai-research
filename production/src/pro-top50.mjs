/** One public Bybit USDT-linear ticker request per 5 minutes, source-isolated.
 * No changes to LYRA, four-symbol research, exchange-compare Cron or orders. */
const KEY='market-hub/universe/bybit-linear-top50-v1.json';
const n=(x,min,max)=>{if(x===null||x===undefined||x===''||typeof x==='boolean')return null;const y=Number(x);return Number.isFinite(y)&&y>=min&&y<=max?y:null;};
export function normalizeTop50(body,now=Date.now()){
 if(body?.retCode!==0||!Array.isArray(body?.result?.list)||body.result.list.length>3000)return null;
 const unique=new Map();
 for(const r of body.result.list){
  const symbol=String(r?.symbol||'');
  if(!/^[A-Z0-9]{2,20}USDT$/.test(symbol)||symbol.length>24)continue;
  const price=n(r.lastPrice,1e-12,1e10),turnover=n(r.turnover24h,1,1e20),change=n(r.price24hPcnt,-1,1000);
  if(price===null||turnover===null||change===null)continue;
  const rate=n(r.fundingRate,-.2,.2),oi=n(r.openInterestValue,.00001,1e20);
  const item={symbol,coin:symbol.slice(0,-4),last_price:price,change_24h_pct:Number((change*100).toFixed(4)),
   turnover_24h_usdt:turnover,oi_usd:oi,funding_pct:rate===null?null:Number((rate*100).toFixed(7)),
   high_24h:n(r.highPrice24h,1e-12,1e10),low_24h:n(r.lowPrice24h,1e-12,1e10),
   mark_price:n(r.markPrice,1e-12,1e10),venue:'Bybit'};
  if(!unique.has(symbol)||turnover>unique.get(symbol).turnover_24h_usdt)unique.set(symbol,item);
 }
 const items=[...unique.values()].sort((a,b)=>b.turnover_24h_usdt-a.turnover_24h_usdt||a.symbol.localeCompare(b.symbol))
  .slice(0,50).map((x,i)=>({...x,rank:i+1}));
 if(!items.length)return null;
 return {ok:true,schema:'lumex_uid_top50_v1',source:'bybit_linear_usdt_public',
  rank_by:'single_venue_turnover_24h_usdt',generated_at_ms:now,count:items.length,target_count:50,
  items,same_exchange_only:true,order_execution:false,status:'verified_source_snapshot',
  five_exchange_comparison_scope:'BTC,ETH,SOL,XRP'};
}
export function checkTop50(data,now=Date.now()){
 if(data?.ok!==true||data.schema!=='lumex_uid_top50_v1'||data.source!=='bybit_linear_usdt_public'||
 data.rank_by!=='single_venue_turnover_24h_usdt'||data.order_execution!==false||
 !Number.isSafeInteger(data.generated_at_ms)||data.generated_at_ms>now+120000||
 now-data.generated_at_ms>15*60000||!Array.isArray(data.items)||data.items.length<1||
 data.items.length>50||data.count!==data.items.length)return false;
 const seen=new Set();let prev=Infinity;
 for(const [i,v] of data.items.entries()){
  if(!/^[A-Z0-9]{2,20}USDT$/.test(v.symbol)||v.coin!==v.symbol.slice(0,-4)||
   v.venue!=='Bybit'||v.rank!==i+1||seen.has(v.symbol)||n(v.last_price,1e-12,1e10)===null||
   n(v.change_24h_pct,-100,100000)===null||n(v.turnover_24h_usdt,1,1e20)===null||
   v.turnover_24h_usdt>prev)return false;
  for(const [key,low,high] of [['oi_usd',.00001,1e20],['funding_pct',-20,20],['mark_price',1e-12,1e10],['high_24h',1e-12,1e10],['low_24h',1e-12,1e10]]){
   if(v[key]!==null&&n(v[key],low,high)===null)return false;
  }
  seen.add(v.symbol);prev=v.turnover_24h_usdt;
 }
 return true;
}
export async function collectTop50(env,{now=Date.now(),fetchImpl=fetch}={}){
 if(!env?.MARKET_DATA)return {ok:false,reason:'r2_not_bound'};
 const r=await fetchImpl('https://api.bybit.com/v5/market/tickers?category=linear',{
  method:'GET',headers:{accept:'application/json'},signal:AbortSignal.timeout(7000)});
 if(!r.ok)return {ok:false,reason:'bybit_status_'+r.status};
 if(Number(r.headers.get('content-length')||0)>750000)return {ok:false,reason:'body_oversize'};
 const body=await r.text();if(body.length<20||body.length>750000)return {ok:false,reason:'invalid_size'};
 let raw;try{raw=JSON.parse(body)}catch{return {ok:false,reason:'json_invalid'}}
 const catalog=normalizeTop50(raw,now);
 if(!checkTop50(catalog,now))return {ok:false,reason:'data_schema_rejected'};
 await env.MARKET_DATA.put(KEY,JSON.stringify(catalog),{httpMetadata:{contentType:'application/json'}});
 const saved=await env.MARKET_DATA.get(KEY);
 if(!saved||!checkTop50(await saved.json(),now))return {ok:false,reason:'r2_readback_failed'};
 return {ok:true,count:catalog.count,verified_r2:true};
}
export async function serveTop50(env,now=Date.now()){
 try{
  const o=await env?.MARKET_DATA?.get(KEY),data=o?await o.json():null;
  if(!checkTop50(data,now))return new Response(JSON.stringify({ok:false,error:'top50_unavailable_or_stale'}),{
   status:503,headers:{'content-type':'application/json','cache-control':'no-store'}});
  return new Response(JSON.stringify(data),{headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}});
 }catch{return new Response(JSON.stringify({ok:false,error:'top50_read_failed'}),{
  status:503,headers:{'content-type':'application/json','cache-control':'no-store'}})}
}
