/**
 * Gate USDT futures REST standby for unstable outgoing WebSockets.
 * Exact 10-second windows are adaptively partitioned down to 1-second
 * windows if an API response hits its 1000-row cap.
 *
 * Mandatory caveat: even 1-second results do not prove exchange-wide
 * completeness. One-second saturation always fails closed. Never merge
 * these observations with WS minutes or Binance archives.
 */
import {parseGateExecution,FLOW_SYMBOLS} from './order-flow-live-contract.mjs';
const SLICE_MS=10000,SECOND_MS=1000,RESPONSE_LIMIT=1000,MAX_REQUESTS=19;
export const STANDBY_ROOT='market-hub/order-flow/v1/live/gate/futures-rest-standby/v1/';
export const lastClosedSlice=(now=Date.now())=>Math.floor(now/SLICE_MS)*SLICE_MS-SLICE_MS;
export function standbyR2Key(symbol,at){
 if(!FLOW_SYMBOLS.includes(symbol)||!Number.isSafeInteger(at)||at%SLICE_MS!==0)
  throw Error('invalid_standby_key');
 return STANDBY_ROOT+new Date(at).toISOString().slice(0,10)+'/'+symbol+'/'+at+'.json';
}
export function standbyRangeUrl(symbol,startMs,endMs){
 if(!FLOW_SYMBOLS.includes(symbol)||!Number.isSafeInteger(startMs)||
  !Number.isSafeInteger(endMs)||startMs%SECOND_MS!==0||
  endMs%SECOND_MS!==0||endMs-startMs<SECOND_MS||
  endMs-startMs>SLICE_MS)throw Error('invalid_standby_range');
 const q=new URLSearchParams({contract:symbol+'_USDT',
  from:String(startMs/SECOND_MS),to:String(endMs/SECOND_MS-1),
  limit:String(RESPONSE_LIMIT)});
 return 'https://api.gateio.ws/api/v4/futures/usdt/trades?'+q;
}
export function standbyUrl(symbol,slice){
 if(!FLOW_SYMBOLS.includes(symbol)||!Number.isSafeInteger(slice)||slice%SLICE_MS!==0)
  throw Error('invalid_standby_query');
 return standbyRangeUrl(symbol,slice,slice+SLICE_MS);
}
export async function collectStandbySlice(symbol,slice,multipliers,options={}){
 const now=Number(options.now??Date.now());
 const base={schema:'lumex_gate_futures_rest_standby_v1',symbol,market:'um-futures',
  source:'gateio_rest',slice_start_ms:slice,checked_at_ms:now,
  websocket_merged:false,binance_archive_merged:false,
  exchange_trade_completeness_verified:false,customer_launch_ready:false,
  synthetic_values:false,full_page_reused:false,source_join_allowed:false};
 if(!FLOW_SYMBOLS.includes(symbol)||!Number.isSafeInteger(slice)||
  slice%SLICE_MS!==0||slice+SLICE_MS>now||now-slice>30*60000)
  return {...base,ok:false,status:'out_of_range'};
 if(!(Number(multipliers?.[symbol+'_USDT'])>0))
  return {...base,ok:false,status:'contract_unit_unverified'};
 const fetchFn=options.fetchFn||fetch;
 const limit=Number(options.maxRequests??MAX_REQUESTS);
 if(!Number.isInteger(limit)||limit<1||limit>MAX_REQUESTS)
  return {...base,ok:false,status:'invalid_request_budget'};
 const deadline=Date.now()+Math.min(18000,Math.max(1000,Number(options.maxElapsedMs??15000)));
 let requests=0,adaptive=false,buy=0,sell=0,lastTs=null,rows=0;
 const ids=new Set(),parts=[];
 let failure=null;
 async function visit(start,end){
  if(failure)return;
  if(requests>=limit){failure='request_cap_reached';return;}
  if(Date.now()>=deadline){failure='time_budget_exceeded';return;}
  requests++;
  let raw;
  try{
   const resp=await fetchFn(standbyRangeUrl(symbol,start,end),{
    headers:{accept:'application/json','X-Gate-Size-Decimal':'1'},
    signal:AbortSignal.timeout(Math.max(1,Math.min(8000,deadline-Date.now())))});
   if(!resp.ok){failure='http_'+resp.status;return;}
   const body=await resp.text();
   if(body.length>1500000){failure='body_too_large';return;}
   raw=JSON.parse(body);
  }catch{failure='transport_or_json_error';return;}
  if(!Array.isArray(raw)||raw.length>RESPONSE_LIMIT){
   failure='invalid_response';return;
  }
  if(raw.length===RESPONSE_LIMIT){
   adaptive=true;
   const span=(end-start)/SECOND_MS;
   if(span<=1){failure='one_second_saturated';return;}
   // Bisection strictly partitions integer-second time windows:
   // e.g. 10 seconds -> 5+5 -> 2+3 -> 1+1/1+2.
   // A full 1000-row response is never included in a proven subtotal.
   const mid=start+Math.floor(span/2)*SECOND_MS;
   await visit(start,mid);
   await visit(mid,end);
   return;
  }
  let localBuy=0,localSell=0,localMax=null;
  const newIds=[];
  for(const item of raw){
   // Gate REST may omit contract in public trade records. Validate returned
   // symbol when provided and use requested contract only if omitted.
   const record=item?.contract?item:{...item,contract:symbol+'_USDT'};
   const trade=parseGateExecution('um-futures',record,multipliers,now);
   if(!trade||trade.symbol!==symbol||trade.ts<start||trade.ts>=end){
    failure='wrong_source_or_time';return;
   }
   if(ids.has(trade.id)||newIds.includes(trade.id)){
    failure='duplicate_trade_id';return;
   }
   newIds.push(trade.id);
   if(trade.taker==='buy')localBuy+=trade.quote_usdt;
   else localSell+=trade.quote_usdt;
   localMax=Math.max(localMax||0,trade.ts);
  }
  if(!Number.isFinite(localBuy)||!Number.isFinite(localSell)){
   failure='arithmetic_overflow';return;
  }
  for(const id of newIds)ids.add(id);
  buy+=localBuy;sell+=localSell;rows+=raw.length;
  if(localMax!==null)lastTs=Math.max(lastTs||0,localMax);
  parts.push({from_ms:start,to_ms:end,observed_trades:raw.length,
   api_limit:RESPONSE_LIMIT,source:'gateio_rest'});
 }
 await visit(slice,slice+SLICE_MS);
 const details={request_count:requests,adaptive_time_partitioned:adaptive,
  min_partition_seconds:parts.length?Math.min(...parts.map(p=>(p.to_ms-p.from_ms)/1000)):null,
  segment_proofs:parts.sort((a,b)=>a.from_ms-b.from_ms)};
 if(failure)return {...base,...details,ok:false,status:failure};
 // Reject incomplete, overlapping, or missing partitions even if every
 // API response was < 1000 items. No synthetic empty intervals.
 let next=slice,sum=0;
 for(const part of details.segment_proofs){
  if(part.from_ms!==next||part.to_ms<=next||
    part.observed_trades>=RESPONSE_LIMIT){
   return {...base,...details,ok:false,status:'range_partition_inconsistent'};
  }
  next=part.to_ms;sum+=part.observed_trades;
 }
 if(next!==slice+SLICE_MS||sum!==rows||!Number.isFinite(buy)||!Number.isFinite(sell))
  return {...base,...details,ok:false,status:'range_partition_inconsistent'};
 return {...base,...details,ok:true,status:rows?'observed_rest_trades':'empty_rest_response',
  observed_trades:rows,buy_quote_usdt:buy,sell_quote_usdt:sell,
  last_trade_ms:lastTs,observed_slice_end_ms:slice+SLICE_MS,
  // Source and provider limits prevent claims of complete market history.
  exchange_trade_completeness_verified:false,customer_launch_ready:false};
}
export function decideRestStandby(status,now=Date.now()){
 const closes=(status?.futures_1006_recent_ms||[]).filter(t=>Number.isFinite(t)&&now-t<180000);
 const circuit=Number(status?.futures_ws_circuit_until||0)>now;
 return {use_rest_standby:circuit||closes.length>=3,
   circuit_until:circuit?status.futures_ws_circuit_until:null,
   closes_3min:closes.length,origin:'gate_futures_unstable_ws'};
}
