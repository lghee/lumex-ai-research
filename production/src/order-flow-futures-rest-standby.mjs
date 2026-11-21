/**
 * Gate USDT futures REST standby for unstable outgoing WebSockets in a Worker.
 * STRICT PROVENANCE: never merge these observations into WS R2 minutes or
 * Binance historical archives, and never assert full venue trade coverage.
 */
import {parseGateExecution,FLOW_SYMBOLS} from './order-flow-live-contract.mjs';
import {gateRestUrl} from './order-flow-rest-replay.mjs';
const SLICE_MS=10000;
export const STANDBY_ROOT='market-hub/order-flow/v1/live/gate/futures-rest-standby/v1/';
export const lastClosedSlice=(now=Date.now())=>Math.floor(now/SLICE_MS)*SLICE_MS-SLICE_MS;
export function standbyR2Key(symbol,at){
 if(!FLOW_SYMBOLS.includes(symbol)||!Number.isSafeInteger(at)||at%SLICE_MS!==0)
  throw Error('invalid_standby_key');
 return STANDBY_ROOT+new Date(at).toISOString().slice(0,10)+'/'+symbol+'/'+at+'.json';
}
export function standbyUrl(symbol,slice){
 if(!FLOW_SYMBOLS.includes(symbol)||!Number.isSafeInteger(slice)||slice%SLICE_MS!==0)
  throw Error('invalid_standby_query');
 const minute=Math.floor(slice/60000)*60000;
 const nth=(slice-minute)/SLICE_MS;
 return gateRestUrl('um-futures',symbol,minute,nth,1000);
}
export async function collectStandbySlice(symbol,slice,multipliers,options={}){
 const now=options.now??Date.now();
 const base={schema:'lumex_gate_futures_rest_standby_v1',symbol,market:'um-futures',
  source:'gateio_rest',slice_start_ms:slice,checked_at_ms:now,
  websocket_merged:false,binance_archive_merged:false,
  exchange_trade_completeness_verified:false,customer_launch_ready:false,
  synthetic_values:false};
 if(!FLOW_SYMBOLS.includes(symbol)||!Number.isSafeInteger(slice)||
  slice%SLICE_MS!==0||slice+SLICE_MS>now||now-slice>30*60000)
  return {...base,ok:false,status:'out_of_range'};
 if(!(Number(multipliers?.[symbol+'_USDT'])>0))
  return {...base,ok:false,status:'contract_unit_unverified'};
 let raw;
 try{
  const fn=options.fetchFn||fetch;
  const reply=await fn(standbyUrl(symbol,slice),{
   headers:{accept:'application/json','X-Gate-Size-Decimal':'1'},
   signal:AbortSignal.timeout(8000)});
  if(!reply.ok)return {...base,ok:false,status:'http_'+reply.status};
  const txt=await reply.text();
  if(txt.length>1500000)return {...base,ok:false,status:'body_too_large'};
  raw=JSON.parse(txt);
 }catch{return {...base,ok:false,status:'transport_or_json_error'};}
 if(!Array.isArray(raw)||raw.length>1000)return {...base,ok:false,status:'invalid_response'};
 if(raw.length===1000)return {...base,ok:false,status:'possibly_truncated'};
 const ids=new Set();let buy=0,sell=0,lastTs=null;
 for(const record of raw){
  const row=record?.contract?record:{...record,contract:symbol+'_USDT'};
  const trade=parseGateExecution('um-futures',row,multipliers,now);
  if(!trade||trade.symbol!==symbol||trade.ts<slice||trade.ts>=slice+SLICE_MS)
   return {...base,ok:false,status:'wrong_source_or_time'};
  if(ids.has(trade.id))return {...base,ok:false,status:'duplicate_trade_id'};
  ids.add(trade.id);
  if(trade.taker==='buy')buy+=trade.quote_usdt;else sell+=trade.quote_usdt;
  lastTs=Math.max(lastTs||0,trade.ts);
 }
 if(!Number.isFinite(buy)||!Number.isFinite(sell))
  return {...base,ok:false,status:'arithmetic_overflow'};
 return {...base,ok:true,status:raw.length?'observed_rest_trades':'empty_rest_response',
  observed_trades:raw.length,buy_quote_usdt:buy,sell_quote_usdt:sell,
  last_trade_ms:lastTs,observed_slice_end_ms:slice+SLICE_MS,
  // 1000 record cap and exchange history semantics cannot prove full coverage.
  exchange_trade_completeness_verified:false,customer_launch_ready:false};
}
export function decideRestStandby(status,now=Date.now()){
 const closes=(status?.futures_1006_recent_ms||[]).filter(t=>Number.isFinite(t)&&now-t<180000);
 const circuit=Number(status?.futures_ws_circuit_until||0)>now;
 return {use_rest_standby:circuit||closes.length>=3,
   circuit_until:circuit?status.futures_ws_circuit_until:null,
   closes_3min:closes.length,origin:'gate_futures_unstable_ws'};
}
