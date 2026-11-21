/** LUMEX UID / PRO liquidity: public USDT linear base-quantity books only. */
const KEY='market-hub/universe/bybit-linear-top50-v1.json';
const num=(v,min,max)=>{
 if(v===null||v===undefined||v===''||typeof v==='boolean')return null;
 const x=Number(v);return Number.isFinite(x)&&x>=min&&x<=max?x:null;
};
const rnd=(n,d=5)=>Number(n.toFixed(d));
export function normalizeBook(venue,payload,symbol,now=Date.now()){
 if(!['Bybit','Binance'].includes(venue)||!/^[A-Z0-9]{2,20}USDT$/.test(symbol))return null;
 let bids,asks,ts;
 if(venue==='Bybit'){
   if(payload?.retCode!==0||payload?.result?.s!==symbol)return null;
   bids=payload.result.b;asks=payload.result.a;ts=num(payload.result.ts,1500000000000,now+2000);
 }else{
   if(!Number.isSafeInteger(Number(payload?.lastUpdateId)))return null;
   bids=payload.bids;asks=payload.asks;ts=num(payload.T??payload.E,1500000000000,now+2000);
 }
 if(ts===null||now-ts>12000||!Array.isArray(bids)||!Array.isArray(asks)||
  bids.length<2||bids.length>100||asks.length<2||asks.length>100)return null;
 const normal=(rows,descending)=>{
  const out=[];let previous=descending?Infinity:0;
  for(const x of rows){
   if(!Array.isArray(x)||x.length<2)return null;
   const p=num(x[0],1e-12,1e12),q=num(x[1],1e-12,1e12);
   if(p===null||q===null||(descending?p>=previous:p<=previous))return null;
   out.push([p,q]);previous=p;
  }return out;
 };
 const b=normal(bids,true),a=normal(asks,false);if(!b||!a||b[0][0]>=a[0][0])return null;
 const mid=(b[0][0]+a[0][0])/2;
 return {exchange:venue,symbol,asof_ms:ts,price_unit:'USDT',quantity_unit:'base_asset',
  best_bid:b[0][0],best_ask:a[0][0],mid:rnd(mid,10),
  spread_bps:rnd((a[0][0]-b[0][0])/mid*10000,3),
  bids:b,asks:a,levels:{bids:b.length,asks:a.length},
  scope:'visible_orderbook_snapshot_only'};
}
export function depthStats(book,band){
 const p=book.mid,d=band/100;
 const bid=book.bids.reduce((sum,[price,quantity])=>price>=p*(1-d)?sum+price*quantity:sum,0);
 const ask=book.asks.reduce((sum,[price,quantity])=>price<=p*(1+d)?sum+price*quantity:sum,0);
 return {band_pct:band,bid_usdt:rnd(bid,2),ask_usdt:rnd(ask,2),
  imbalance_pct:rnd(100*(bid-ask)/Math.max(1,bid+ask),2)};
}
export function simulateOrder(book,side,notional){
 if(!['buy','sell'].includes(side)||num(notional,1,5e6)===null)return null;
 const levels=side==='buy'?book.asks:book.bids,reference=side==='buy'?book.best_ask:book.best_bid;
 const target=notional/reference;let filled=0,total=0;
 for(const [price,quantity] of levels){
  const qty=Math.min(quantity,Math.max(0,target-filled));if(qty<=0)break;
  filled+=qty;total+=qty*price;if(filled>=target-1e-10)break;
 }
 const covered=Math.max(0,Math.min(100,filled/target*100)),complete=covered>99.9999;
 const avg=complete?total/filled:null;
 const bps=complete?Math.max(0,(side==='buy'?avg-reference:reference-avg)/reference*10000):null;
 return {covered_pct:rnd(covered,2),fully_covered:complete,
  avg_price:complete?rnd(avg,10):null,slippage_bps:bps===null?null:rnd(bps,2),
  estimated_impact_usdt:bps===null?null:rnd(notional*bps/10000,2),
  model:'visible_orderbook_only',fees_included:false};
}
async function publicJson(url,fetchImpl){
 const response=await fetchImpl(url,{method:'GET',headers:{Accept:'application/json'},
  signal:AbortSignal.timeout(4200)});
 if(!response.ok)return null;
 if(Number(response.headers.get('content-length')||0)>120000)return null;
 const text=await response.text();if(text.length<20||text.length>120000)return null;
 try{return JSON.parse(text)}catch{return null}
}
export async function sampleLiquidity(symbol,{now=Date.now(),fetchImpl=fetch}={}){
 const sources=[
 ['Bybit','https://api.bybit.com/v5/market/orderbook?category=linear&symbol='+symbol+'&limit=100'],
 ['Binance','https://fapi.binance.com/fapi/v1/depth?symbol='+symbol+'&limit=100']
 ];
 const results=await Promise.all(sources.map(async ([venue,url])=>{
  try{return normalizeBook(venue,await publicJson(url,fetchImpl),symbol,now)}catch{return null}
 }));
 const books=results.filter(Boolean);if(!books.length)return null;
 return {ok:true,schema:'lumex_public_liquidity_v1',symbol,generated_at_ms:now,
  venues:books.map(b=>({...b,depth:[.1,.5,1].map(n=>depthStats(b,n))})),
  available_venues:books.length,venue_target:2,orders_enabled:false,snapshot_only:true,
  not_market_total:true,all_levels_base_quantity:true,
  notice:'visible_orderbook_only_no_execution_or_fee_guarantee'};
}
export async function serveLiquidity(request,env,{now=Date.now(),fetchImpl=fetch}={}){
 const symbol=String(new URL(request.url).searchParams.get('symbol')||'').toUpperCase();
 const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{
  'content-type':'application/json','cache-control':'private, no-store','x-content-type-options':'nosniff'}});
 if(!/^[A-Z0-9]{2,20}USDT$/.test(symbol))return response({ok:false,error:'invalid_symbol'},400);
 if(!env?.MARKET_DATA)return response({ok:false,error:'universe_not_ready'},503);
 try{
  const obj=await env.MARKET_DATA.get(KEY),universe=obj?await obj.json():null;
  if(universe?.schema!=='lumex_uid_top50_v1'||!Array.isArray(universe.items)||
   !Number.isSafeInteger(universe.generated_at_ms)||universe.generated_at_ms>now+120000||
   now-universe.generated_at_ms>15*60000||
   !universe.items.some(x=>x.symbol===symbol&&x.venue==='Bybit'))
   return response({ok:false,error:'symbol_not_in_current_top50'},503);
  const key='market-hub/liquidity-live/'+symbol;
  const cached=await env.MARKET_DATA.get(key);
  if(cached){
   const old=await cached.json();
   if(old?.schema==='lumex_public_liquidity_v1'&&old.symbol===symbol&&
      Number.isSafeInteger(old.generated_at_ms)&&old.generated_at_ms<=now&&
      now-old.generated_at_ms<=8000&&Array.isArray(old.venues)&&old.venues.length>0)
      return response(old);
  }
  const fresh=await sampleLiquidity(symbol,{now,fetchImpl});
  if(!fresh)return response({ok:false,error:'verified_public_books_unavailable'},503);
  await env.MARKET_DATA.put(key,JSON.stringify(fresh));
  return response(fresh);
 }catch{return response({ok:false,error:'liquidity_read_unavailable'},503)}
}
