/**
 * Phase 34 source-isolated, bounded Gate REST replay after a WS outage.
 * Never merge REST aggregate with WS aggregate: their row-ID namespaces and
 * completeness guarantees are not interchangeable. REST cannot prove all
 * exchange executions if time filters/pagination are unreliable or saturated.
 */
import {parseGateExecution,FLOW_SYMBOLS,FLOW_MARKETS} from './order-flow-live-contract.mjs';
const M=60000,ROOT='market-hub/order-flow/v1/live/gate/recovery/v1/';
const DAY=x=>new Date(x).toISOString().slice(0,10);
export const recoveryKey=(market,symbol,minute)=>ROOT+DAY(minute)+'/'+market+'/'+symbol+'/'+minute+'.json';
export function gateRestUrl(market,symbol,minute,page,limit){
 if(!FLOW_MARKETS.includes(market)||!FLOW_SYMBOLS.includes(symbol)||
  !Number.isSafeInteger(minute)||minute%M!==0||
  !Number.isInteger(page)||page<0||page>24||!Number.isInteger(limit)||limit<1||limit>1000)
  throw Error('invalid_rest_replay_request');
 const contract=symbol+'_USDT';
 const base=market==='spot'?'https://api.gateio.ws/api/v4/spot/trades':
   'https://api.gateio.ws/api/v4/futures/usdt/trades';
 const q=new URLSearchParams();
 q.set(market==='spot'?'currency_pair':'contract',contract);
 q.set('from',String(minute/1000));q.set('to',String(minute/1000+59));
 q.set('limit',String(limit));
 if(market==='spot')q.set('page',String(page+1));
 else q.set('offset',String(page*limit));
 return base+'?'+q.toString();
}
export async function boundedGateRestReplay(market,symbol,minute,multipliers={},options={}){
 const now=Number(options.now??Date.now()),limit=Number(options.limit??1000);
 const cap=Number(options.maxPages??3),fetchFn=options.fetchFn||fetch;
 const base={schema:'lumex_gate_rest_replay_v1',source:'gateio_rest',market,symbol,
  minute_ms:minute,checked_at_ms:now,
  history_join_allowed:false,exchange_complete_verified:false,
  live_verified:false,customer_launch_ready:false,
  no_ws_merge:true,synthetic_values:false};
 if(!FLOW_MARKETS.includes(market)||!FLOW_SYMBOLS.includes(symbol)||
  !Number.isSafeInteger(minute)||minute%M!==0||minute>now-2*M||
  now-minute>30*M||!Number.isSafeInteger(limit)||limit<1||limit>1000||
  !Number.isSafeInteger(cap)||cap<1||cap>6)
  return {...base,status:'invalid_or_unsettled_window',pages:0,rows:0};
 if(market==='um-futures'&&!(Number(multipliers[symbol+'_USDT'])>0))
  return {...base,status:'futures_contract_units_unverified',pages:0,rows:0};
 const seen=new Set();let buys=0,sells=0,rows=0,pages=0,
  minMs=null,maxMs=null,firstId=null,lastId=null,exhausted=false;
 for(let i=0;i<cap;i++){
  let body;
  const url=gateRestUrl(market,symbol,minute,i,limit);
  try{
   const response=await fetchFn(url,{headers:{accept:'application/json',
     ...(market==='um-futures'?{'X-Gate-Size-Decimal':'1'}:{})},
     signal:AbortSignal.timeout(8000)});
   if(!response.ok)return {...base,status:'rest_http_'+response.status,pages,rows};
   const text=await response.text();
   if(text.length>1500000)return {...base,status:'rest_payload_too_large',pages,rows};
   body=JSON.parse(text);
  }catch{return {...base,status:'rest_transport_or_json_failed',pages,rows};}
  if(!Array.isArray(body)||body.length>limit)
   return {...base,status:'rest_invalid_page',pages,rows};
  pages++;
  for(const item of body){
   if(market==='spot'&&item.trade_quote&&item.trade_quote!=='USDT')
    return {...base,status:'rest_wrong_quote',pages,rows};
   const itemId=market==='spot'?item.sequence_id??item.id:item.id;
   // A REST spot sequence_id is not assumed to equal a WS id_market.
   const trade=parseGateExecution(market,
     market==='spot'?{...item,id_market:itemId}:item,multipliers,now);
   if(!trade||trade.ts<minute||trade.ts>=minute+M)
    return {...base,status:'rest_time_or_schema_mismatch',pages,rows};
   if(seen.has(trade.id))return {...base,status:'rest_duplicate_or_unstable_page',pages,rows};
   seen.add(trade.id);
   if(firstId===null)firstId=trade.id;
   lastId=trade.id;minMs=minMs===null?trade.ts:Math.min(minMs,trade.ts);
   maxMs=maxMs===null?trade.ts:Math.max(maxMs,trade.ts);
   if(trade.taker==='buy')buys+=trade.quote_usdt;
   else sells+=trade.quote_usdt;
   rows++;
  }
  if(body.length<limit){exhausted=true;break;}
 }
 if(!rows)return {...base,status:'empty_unverified',pages,rows};
 if(!exhausted)return {...base,status:'pagination_cap_reached',pages,rows};
 if(!Number.isFinite(buys)||!Number.isFinite(sells))
  return {...base,status:'replay_arithmetic_overflow',pages,rows};
 return {...base,status:'bounded_rest_pages_exhausted',pages,rows,
   id_provenance:market==='spot'?'rest_sequence_id_or_global_id':'rest_contract_trade_id',
   first_id:firstId,last_id:lastId,first_trade_ms:minMs,last_trade_ms:maxMs,
   observed_buy_quote_usdt:buys,observed_sell_quote_usdt:sells,
   rest_page_window_exhausted:true,
   // No guarantee of endpoint's time-range behavior under market load.
   restored_to_customer_series:false};
}
