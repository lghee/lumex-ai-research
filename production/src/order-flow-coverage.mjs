/**
 * Phase 34: source-isolated observed-minute continuity evidence.
 * Missing minutes do not imply zero trades; a complete observation window
 * does NOT certify total venue executions or authorize UID/PRO launch.
 */
const MINUTE=60000,HOUR=60*MINUTE;
const SYMBOLS=['BTC','ETH','SOL','XRP'];
const MARKETS=['spot','um-futures'];
const SOURCES=MARKETS.flatMap(m=>SYMBOLS.map(s=>m+':'+s));
const ROOT='market-hub/order-flow/v1/live/gate/';
const PROOFS=ROOT+'coverage/v1/';
const positive=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
const exact=x=>Number.isSafeInteger(x)&&x>=0;
const day=ms=>new Date(ms).toISOString().slice(0,10);
export const observedMinuteKey=ms=>ROOT+day(ms)+'/'+ms+'.json';
export const hourlyProofKey=ms=>PROOFS+'hourly/'+day(ms)+'/'+ms+'.json';
export const rollingProofKey=PROOFS+'rolling-latest.json';
export function readObservedMinute(doc,ms){
 if(doc?.schema!=='lumex_gate_ws_observed_minute_v1'||doc.source!=='gateio'||
  doc.observed_minute_ms!==ms||doc.complete_trades_verified!==false||
  doc.synthetic_values!==false||doc.customer_launch_ready!==false||
  doc.historical_binance_archive_combined!==false||
  !Array.isArray(doc.rows)||doc.rows.length>8)return null;
 const names=new Set();
 for(const row of doc.rows){
  const k=row?.market+':'+row?.symbol;
  if(!SOURCES.includes(k)||names.has(k)||row.source!=='gateio'||
   !exact(row.observed_trades)||row.observed_trades===0||
   !positive(row.buy_quote_usdt)||!positive(row.sell_quote_usdt)||
   row.buy_quote_usdt+row.sell_quote_usdt<=0||
   !Number.isSafeInteger(row.last_trade_ms)||row.last_trade_ms<ms||
   row.last_trade_ms>=ms+MINUTE)return null;
  names.add(k);
 }
 return {present:[...names],had_gap:doc.gaps_observed===true};
}
export function buildHourlyObservedProof(hourStart,objects,checkedAt=Date.now()){
 if(!Number.isSafeInteger(hourStart)||hourStart%HOUR!==0||
  !Array.isArray(objects)||objects.length!==60)throw Error('invalid_60_minute_window');
 const presence=Object.fromEntries(SOURCES.map(x=>[x,0]));
 const gaps=[],invalid=[];
 for(let i=0;i<60;i++){
  const ms=hourStart+i*MINUTE;
  if(objects[i]==null){gaps.push(ms);continue;}
  const obs=readObservedMinute(objects[i],ms);
  if(!obs){invalid.push(ms);continue;}
  if(obs.had_gap)gaps.push(ms);
  for(const name of obs.present)presence[name]++;
 }
 const marketProofs=SOURCES.map(source=>({source,observed_minutes:presence[source],
  expected_minutes:60,observed_minute_continuity:presence[source]===60&&gaps.length===0&&invalid.length===0}));
 const pass=marketProofs.every(x=>x.observed_minute_continuity);
 return {schema:'lumex_gate_observed_hour_v1',source:'gateio_websocket_observed',
   hour_start_ms:hourStart,checked_at_ms:checkedAt,expected_minutes:60,
   present_objects:60-new Set([...gaps,...invalid]).size,
   missing_or_gap_minutes:gaps,invalid_minutes:invalid,markets:marketProofs,
   observed_minute_continuity:pass,exchange_full_trade_completeness:false,
   live_verified:false,customer_launch_ready:false,history_join_allowed:false};
}
export function buildRollingObservedProof(now,proofs){
 const closedHour=Math.floor(now/HOUR)*HOUR-HOUR;
 if(!Array.isArray(proofs)||proofs.length!==168)throw Error('invalid_7d_evidence');
 const accepted=proofs.map((p,i)=>p?.schema==='lumex_gate_observed_hour_v1'&&
   p.hour_start_ms===closedHour-(167-i)*HOUR&&
   p.observed_minute_continuity===true&&
   p.exchange_full_trade_completeness===false&&
   p.customer_launch_ready===false);
 const last24=accepted.slice(-24).filter(Boolean).length;
 const all7=accepted.filter(Boolean).length;
 return {schema:'lumex_gate_observed_rolling_v1',calculated_at_ms:now,
  hour_end_ms:closedHour+HOUR,expected_hours_24h:24,accepted_hours_24h:last24,
  expected_hours_7d:168,accepted_hours_7d:all7,
  observed_minutes_continuous_24h:last24===24,
  observed_minutes_continuous_7d:all7===168,
  // Even full coverage of minute aggregates cannot prove no missing individual trades.
  exchange_full_trade_completeness:false,missing_trades_backfilled:false,
  live_verified:false,customer_launch_ready:false,history_join_allowed:false,
  market_count:8,source:'Gate observed messages only; Binance archive separate'};
}
async function batchGet(r2,keys,concurrency=6){
 const out=[];
 for(let i=0;i<keys.length;i+=concurrency){
  const group=await Promise.all(keys.slice(i,i+concurrency).map(async k=>{
   try{const o=await r2.get(k);return o?await o.json():null;}
   catch{return {schema:'invalid_or_unavailable'};}
  }));
  out.push(...group);
 }
 return out;
}
export async function collectGateObservedCoverage(env,now=Date.now()){
 if(!env?.MARKET_DATA)throw Error('r2_not_bound');
 const end=Math.floor(now/HOUR)*HOUR;
 const hourStart=end-HOUR;
 const minuteKeys=Array.from({length:60},(_,i)=>observedMinuteKey(hourStart+i*MINUTE));
 const observed=await batchGet(env.MARKET_DATA,minuteKeys,6);
 const hourly=buildHourlyObservedProof(hourStart,observed,now);
 await env.MARKET_DATA.put(hourlyProofKey(hourStart),JSON.stringify(hourly),
  {httpMetadata:{contentType:'application/json'}});
 const hours=Array.from({length:168},(_,i)=>hourlyProofKey(end-(168-i)*HOUR));
 const proofs=await batchGet(env.MARKET_DATA,hours,8);
 const rolling=buildRollingObservedProof(now,proofs);
 await env.MARKET_DATA.put(rollingProofKey,JSON.stringify(rolling),
  {httpMetadata:{contentType:'application/json'}});
 return {ok:true,hourly_observed:hourly.observed_minute_continuity,
   accepted_hours_24h:rolling.accepted_hours_24h,
   accepted_hours_7d:rolling.accepted_hours_7d,
   customer_launch_ready:false};
}
export async function serveGateObservedCoverage(env){
 try{
  if(!env?.MARKET_DATA)return new Response(JSON.stringify({ok:false,error:'r2_not_bound'}),
   {status:503,headers:{'content-type':'application/json','cache-control':'no-store'}});
  const obj=await env.MARKET_DATA.get(rollingProofKey);
  if(!obj)return new Response(JSON.stringify({ok:false,error:'no_coverage_proof_yet',customer_launch_ready:false}),
   {status:503,headers:{'content-type':'application/json','cache-control':'no-store'}});
  const doc=await obj.json();
  if(doc?.schema!=='lumex_gate_observed_rolling_v1'||doc.customer_launch_ready!==false)
   throw Error('invalid_coverage_proof');
  return new Response(JSON.stringify({...doc,ok:true,stale:Date.now()-doc.calculated_at_ms>2*HOUR}),
   {headers:{'content-type':'application/json','cache-control':'private,no-store'}});
 }catch{return new Response(JSON.stringify({ok:false,error:'coverage_unavailable',customer_launch_ready:false}),
  {status:503,headers:{'content-type':'application/json','cache-control':'no-store'}});}
}
