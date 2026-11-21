/**
 * Phase 35: safe Gate public REST reconciliation probes, never customer CVD.
 * Spot supports page; futures REST supports from/to/limit but NOT offset.
 * Futures probing splits a minute into six bounded 10-second time windows.
 * Even a fully observed window is not a proof of exchange-wide trade completeness.
 */
import {parseGateExecution,FLOW_SYMBOLS,FLOW_MARKETS} from './order-flow-live-contract.mjs';
const M=60000,SLICE=10,ROOT='market-hub/order-flow/v1/live/gate/recovery/v1/';
const DAY=x=>new Date(x).toISOString().slice(0,10);
export const recoveryKey=(market,symbol,minute)=>ROOT+DAY(minute)+'/'+market+'/'+symbol+'/'+minute+'.json';
export function gateRestUrl(market,symbol,minute,page,limit){
 if(!FLOW_MARKETS.includes(market)||!FLOW_SYMBOLS.includes(symbol)||
  !Number.isSafeInteger(minute)||minute%M!==0||
  !Number.isInteger(page)||page<0||page>24||!Number.isInteger(limit)||limit<1||limit>1000)
  throw Error('invalid_rest_replay_request');
 if(market==='um-futures'&&page>=6)throw Error('invalid_futures_time_slice');
 const base=market==='spot'?'https://api.gateio.ws/api/v4/spot/trades':
   'https://api.gateio.ws/api/v4/futures/usdt/trades';
 const q=new URLSearchParams();
 q.set(market==='spot'?'currency_pair':'contract',symbol+'_USDT');
 const from=Math.floor(minute/1000)+(market==='um-futures'?page*SLICE:0);
 const to=Math.floor(minute/1000)+(market==='um-futures'?(page+1)*SLICE-1:59);
 q.set('from',String(from));q.set('to',String(to));
 q.set('limit',String(limit));
 if(market==='spot')q.set('page',String(page+1));
 return base+'?'+q.toString();
}
export async function boundedGateRestReplay(market,symbol,minute,multipliers={},options={}){
 const now=Number(options.now??Date.now()),limit=Number(options.limit??1000);
 const cap=Number(options.maxPages??(market==='um-futures'?6:3));
 const deadline=Date.now()+Math.min(15000,Math.max(1000,Number(options.maxElapsedMs??12000)));
 const fetchFn=options.fetchFn||fetch;
 const base={schema:'lumex_gate_rest_replay_v1',source:'gateio_rest',market,symbol,
  minute_ms:minute,checked_at_ms:now,
  history_join_allowed:false,exchange_complete_verified:false,
  live_verified:false,customer_launch_ready:false,
  no_ws_merge:true,synthetic_values:false,restored_to_customer_series:false};
 if(!FLOW_MARKETS.includes(market)||!FLOW_SYMBOLS.includes(symbol)||
  !Number.isSafeInteger(minute)||minute%M!==0||minute>now-2*M||
  now-minute>30*M||!Number.isSafeInteger(limit)||limit<1||limit>1000||
  !Number.isSafeInteger(cap)||cap<1||cap>(market==='um-futures'?6:6))
  return {...base,status:'invalid_or_unsettled_window',pages:0,rows:0};
 if(market==='um-futures'&&!(Number(multipliers[symbol+'_USDT'])>0))
  return {...base,status:'futures_contract_units_unverified',pages:0,rows:0};
 const seen=new Set();let buys=0,sells=0,rows=0,pages=0,
  minMs=null,maxMs=null,firstId=null,lastId=null,exhausted=false,emptySlices=0;
 for(let i=0;i<cap;i++){
  if(Date.now()>=deadline)return {...base,status:'rest_budget_exceeded',pages,rows};
  let body;
  const url=gateRestUrl(market,symbol,minute,i,limit);
  try{
   const resp=await fetchFn(url,{headers:{accept:'application/json',
     ...(market==='um-futures'?{'X-Gate-Size-Decimal':'1'}:{})},
     signal:AbortSignal.timeout(Math.max(1,Math.min(8000,deadline-Date.now())))});
   if(!resp.ok)return {...base,status:'rest_http_'+resp.status,pages,rows};
   const text=await resp.text();
   if(text.length>1500000)return {...base,status:'rest_payload_too_large',pages,rows};
   body=JSON.parse(text);
  }catch{return {...base,status:'rest_transport_or_json_failed',pages,rows};}
  if(!Array.isArray(body)||body.length>limit)return {...base,status:'rest_invalid_page',pages,rows};
  pages++;
  const sliceFrom=minute+(market==='um-futures'?i*SLICE*1000:0);
  const sliceEnd=market==='um-futures'?sliceFrom+SLICE*1000:minute+M;
  for(const item of body){
   // Public spot REST rows may omit currency_pair. The exact requested market
   // comes from this signed-off request URL; conflicting returned identity is rejected.
   const normalized=market==='spot'?
    {...item,currency_pair:item.currency_pair??symbol+'_USDT'}:item;
   const trade=parseGateExecution(market,normalized,multipliers,now);
   if(!trade||trade.ts<sliceFrom||trade.ts>=sliceEnd)
    return {...base,status:'rest_time_or_schema_mismatch',pages,rows};
   if(seen.has(trade.id))return {...base,status:'rest_duplicate_or_unstable_page',pages,rows};
   seen.add(trade.id);
   if(firstId===null)firstId=trade.id;
   lastId=trade.id;minMs=minMs===null?trade.ts:Math.min(minMs,trade.ts);
   maxMs=maxMs===null?trade.ts:Math.max(maxMs,trade.ts);
   if(trade.taker==='buy')buys+=trade.quote_usdt;else sells+=trade.quote_usdt;
   rows++;
  }
  if(market==='um-futures'){
   if(body.length===limit)return {...base,status:'futures_time_slice_saturated',pages,rows};
   if(body.length===0)emptySlices++;
  }else if(body.length<limit){exhausted=true;break;}
 }
 if(!rows)return {...base,status:'empty_unverified',pages,rows};
 if(!Number.isFinite(buys)||!Number.isFinite(sells))
  return {...base,status:'replay_arithmetic_overflow',pages,rows};
 if(market==='um-futures'&&cap<6)
  return {...base,status:'futures_time_slices_incomplete',pages,rows};
 if(market==='spot'&&!exhausted)
  return {...base,status:'pagination_cap_reached',pages,rows};
 return {...base,status:market==='spot'?'bounded_rest_pages_exhausted':'bounded_futures_time_slices_observed',
  pages,rows,empty_slices:emptySlices,
  id_provenance:market==='spot'?'rest_spot_trade_id':'rest_contract_trade_id',
  first_id:firstId,last_id:lastId,first_trade_ms:minMs,last_trade_ms:maxMs,
  observed_buy_quote_usdt:buys,observed_sell_quote_usdt:sells,
  // The futures endpoint has no offset pagination. No zero-fill or WS merge.
  rest_query_window_observed:true,exchange_complete_verified:false,
  restored_to_customer_series:false};
}
