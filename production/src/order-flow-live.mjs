/**
 * Phase 33 isolated, preliminary Gate executed-trade stream.
 * Does NOT certify uninterrupted history, full market print coverage,
 * authentic footprint, Binance historical CVD continuity, or launch readiness.
 * Trading/payment/automated strategies are not touched.
 */
import {FLOW_SYMBOLS,parseGatePacket,orderIdAfter} from './order-flow-live-contract.mjs';
const ROOT='market-hub/order-flow/v1/live/gate/';
const MS_MIN=60000;
const pair=s=>s+'_USDT';
const fresh=(time,now=Date.now())=>Number.isFinite(time)&&time>0&&now-time<45000;
const cleanState=()=>({
 schema:'lumex_gate_live_collector_v1',first_started_ms:Date.now(),last_tick_ms:0,
 last_r2_write_ms:0,last_r2_key:null,counts:{},last_ids:{},last_event_ms:{},
 buckets:{},gaps:[],bad_events:0,duplicate_events:0,connection_failures:0,
 reconnects:0,multipliers:{},contracts_verified_ms:0,
 rest_replay_pending:[],rest_replay_checks:[],last_rest_replay_attempt_ms:0,
 futures_decimal_header_requested:false,
 filtered_internal_trades:0,filtered_other_quote_trades:0,
 rejected_trade_rows:0,malformed_ws_frames:0,subscription_failures:0
});
function recordGap(st,reason,source,at=Date.now()){
 const last=st.gaps.at(-1);
 if(last&&last.reason===reason&&last.source===source&&at-last.at_ms<10000)return;
 st.gaps.push({at_ms:at,reason,source});
 st.gaps=st.gaps.slice(-100);
}
const response=(body,status=200)=>new Response(JSON.stringify(body),{
 status,headers:{'content-type':'application/json','cache-control':'private,no-store','x-content-type-options':'nosniff'}});
export class OrderFlowLiveLogic{
 constructor(ctx,env){
  this.ctx=ctx;this.env=env;
  this.sockets=new Map();this.connecting=new Set();this.connectionStarted={};
  this.state=cleanState();
  this.ready=ctx.storage.get('phase33:checkpoint').then(previous=>{
   if(previous?.schema==='lumex_gate_live_collector_v1'){
    this.state=previous;
    recordGap(this.state,'collector_restarted_without_ws_continuity','all');
   }
  });
 }
 async fetch(request){
  const p=new URL(request.url).pathname;
  if(p==='/status')return response(this.health());
  if(!['/ensure','/tick'].includes(p)||request.method!=='POST')return response({ok:false,error:'not_found'},404);
  try{
   await this.ensure();
   if(p==='/tick')await this.persist();
   await this.ctx.storage.setAlarm(Date.now()+15000);
   return response(this.health());
  }catch(e){
   recordGap(this.state,'ensure_or_persist_failed','all');
   try{await this.ctx.storage.put('phase33:checkpoint',this.state);}catch{}

   await this.ctx.storage.setAlarm(Date.now()+30000).catch(()=>{});
   return response({ok:false,reason:'live_source_or_r2_unavailable',customer_launch_ready:false},503);
  }
 }
 health(){
  const now=Date.now();const markets=['spot','um-futures'];
  const sources=[];
  for(const market of markets)for(const symbol of FLOW_SYMBOLS){
   const key=market+':'+symbol;
   sources.push({market,symbol,source:'gateio',last_observed_ms:this.state.last_event_ms[key]||null,
    last_trade_id:this.state.last_ids[key]||null,observed_fresh:fresh(this.state.last_event_ms[key],now),
    observed_count:this.state.counts[key]||0});
  }
  const connected=[...this.sockets.keys()].filter(x=>this.sockets.get(x)?.readyState===1);
  return {ok:true,schema:'lumex_gate_live_observation_health_v1',scope:'gateio_only',
   phase:'collection_proof',sampling:'gate_public_websocket_messages',
   runtime_revision:'phase34.1_precision_20261121',
   websocket_connections:connected,source_count:sources.length,sources,
   multiplier_check_ms:this.state.contracts_verified_ms||null,
   last_archive_ms:this.state.last_r2_write_ms||null,
   last_archive_key:this.state.last_r2_key||null,
   futures_decimal_header_requested:!!this.state.futures_decimal_header_requested,
   rest_replay_pending:this.state.rest_replay_pending?.length||0,
   recent_rest_replay_checks:(this.state.rest_replay_checks||[]).slice(-12),
   invalid_messages:this.state.bad_events,duplicates:this.state.duplicate_events,
   message_diagnostics:{
     rejected_trade_rows:this.state.rejected_trade_rows||0,
     filtered_internal_trades:this.state.filtered_internal_trades||0,
     filtered_other_quote_trades:this.state.filtered_other_quote_trades||0,
     malformed_ws_frames:this.state.malformed_ws_frames||0,
     subscription_failures:this.state.subscription_failures||0
   },
   connection_failures:this.state.connection_failures,reconnects:this.state.reconnects,
   unresolved_gaps:this.state.gaps.slice(-15),
   continuity_proven_24h:false,continuity_proven_7d:false,
   missing_trades_backfilled:false,live_verified:false,
   customer_launch_ready:false,history_join_allowed:false,
   historical_source:'Binance official archives are separate, never joined'};
 }
 async multipliers(){
  if(this.state.contracts_verified_ms&&Date.now()-this.state.contracts_verified_ms<21600000&&
   FLOW_SYMBOLS.every(s=>Number(this.state.multipliers[pair(s)])>0))return true;
  const result={};
  const probes=await Promise.all(FLOW_SYMBOLS.map(async symbol=>{
   const c=pair(symbol);
   try{
    const r=await fetch('https://api.gateio.ws/api/v4/futures/usdt/contracts/'+c,{
     headers:{accept:'application/json'},signal:AbortSignal.timeout(8000)});
    if(!r.ok)return null;
    const data=await r.json();
    if(data?.name!==c||!(Number(data?.quanto_multiplier)>0)||
     !Number.isFinite(Number(data.quanto_multiplier)))return null;
    return [c,Number(data.quanto_multiplier)];
   }catch{return null;}
  }));
  if(probes.some(x=>!x)){
   recordGap(this.state,'futures_contract_multiplier_unverified','um-futures');
   return false;
  }
  for(const [name,mult] of probes)result[name]=mult;
  this.state.multipliers=result;this.state.contracts_verified_ms=Date.now();
  return true;
 }
 queueRestGap(market,at=Date.now()){
  if(this.env.AUTO_ORDER_FLOW_REST_REPLAY!=='true')return;
  const queue=this.state.rest_replay_pending||(this.state.rest_replay_pending=[]);
  const minute=Math.floor((at-3*MS_MIN)/MS_MIN)*MS_MIN;
  for(const symbol of FLOW_SYMBOLS){
   const key=market+':'+symbol+':'+minute;
   if(!queue.some(x=>x.key===key)&&queue.length<48)
    queue.push({key,market,symbol,minute,queued_at_ms:at});
  }
  if(queue.length>=48)recordGap(this.state,'rest_replay_queue_bounded','all');
 }
 async runOneRestReplay(now=Date.now()){
  if(this.env.AUTO_ORDER_FLOW_REST_REPLAY!=='true')return;
  const queue=this.state.rest_replay_pending||[];
  if(!queue.length||now-(this.state.last_rest_replay_attempt_ms||0)<MS_MIN)return;
  this.state.last_rest_replay_attempt_ms=now;
  const task=queue.shift();
  const result={market:task.market,symbol:task.symbol,minute_ms:task.minute};
  try{
   const mod=await import('./order-flow-rest-replay.mjs');
   const proof=await mod.boundedGateRestReplay(task.market,task.symbol,task.minute,
     this.state.multipliers,{now,limit:1000,maxPages:3});
   result.status=proof.status;result.pages=proof.pages;result.rows=proof.rows;
   if(this.env.MARKET_DATA){
    await this.env.MARKET_DATA.put(mod.recoveryKey(task.market,task.symbol,task.minute),
     JSON.stringify(proof),{httpMetadata:{contentType:'application/json'}});
   }else result.status='r2_unavailable';
   if(proof.status!=='bounded_rest_pages_exhausted')
    recordGap(this.state,'rest_replay_'+String(proof.status).slice(0,50),
      task.market+':'+task.symbol);
  }catch{
   result.status='rest_replay_unavailable';
   recordGap(this.state,'rest_replay_exception',task.market+':'+task.symbol);
  }
  const checks=this.state.rest_replay_checks||(this.state.rest_replay_checks=[]);
  checks.push({...result,attempt_at_ms:now});this.state.rest_replay_checks=checks.slice(-40);
 }
 async ensure(){
  // Runtime upgrades cannot reuse a futures socket created without exact
  // decimal sizing. Reconnect with an explicit header, never integer fallback.
  if(this.sockets.has('um-futures')&&!this.state.futures_decimal_header_requested){
   try{this.sockets.get('um-futures').close(1000,'refresh_size_precision');}catch{}
   this.sockets.delete('um-futures');
   recordGap(this.state,'precision_upgrade_reconnect','um-futures');
   this.queueRestGap('um-futures');
  }
  // A websocket that connected previously but silently stopped emitting is untrusted.
  for(const [market,ws] of this.sockets){
   if(ws.readyState===3||ws.readyState===2){
    this.sockets.delete(market);recordGap(this.state,'websocket_closed',market);
    this.queueRestGap(market);
   }else if(this.connectionStarted[market]&&Date.now()-this.connectionStarted[market]>90000&&
    !FLOW_SYMBOLS.some(s=>fresh(this.state.last_event_ms[market+':'+s]))){
    try{ws.close(1000,'reconnect_stale');}catch{}
    this.sockets.delete(market);recordGap(this.state,'websocket_stale',market);
    this.queueRestGap(market);
   }
  }
  const valid=await this.multipliers();
  if(!valid){
   // Spot may be collected independently. Futures is suppressed without contract conversion.
   await this.connect('spot');return;
  }
  await Promise.all([this.connect('spot'),this.connect('um-futures')]);
 }
 async connect(market){
  if(this.sockets.has(market)||this.connecting.has(market))return;
  this.connecting.add(market);
  const url=market==='spot'?'wss://api.gateio.ws/ws/v4/':'wss://fx-ws.gateio.ws/v4/ws/usdt';
  const channel=market==='spot'?'spot.trades':'futures.trades';
  try{
   let ws;
   if(market==='um-futures'){
    // Gate futures truncates fractional sizes unless decimal mode is requested.
    const upgraded=await fetch('https://fx-ws.gateio.ws/v4/ws/usdt',{
      headers:{Upgrade:'websocket','X-Gate-Size-Decimal':'1'},
      signal:AbortSignal.timeout(10000)});
    if(upgraded.status!==101||!upgraded.webSocket){
     recordGap(this.state,'futures_decimal_upgrade_unavailable',market);
     this.state.connection_failures++;return;
    }
    ws=upgraded.webSocket;ws.accept();
    this.state.futures_decimal_header_requested=true;
   }else ws=new WebSocket(url);
   this.sockets.set(market,ws);this.connectionStarted[market]=Date.now();
   let didSubscribe=false;
   const subscribe=()=>{
    if(didSubscribe)return;
    didSubscribe=true;
    this.state.reconnects++;
    try{ws.send(JSON.stringify({time:Math.floor(Date.now()/1000),
      channel,event:'subscribe',payload:FLOW_SYMBOLS.map(pair)}));}
    catch{recordGap(this.state,'subscribe_failed',market);}
   };
   ws.addEventListener('open',subscribe);
   if(ws.readyState===1)subscribe();
   ws.addEventListener('message',event=>{
    try{
     if(typeof event.data!=='string'||event.data.length>1200000){this.state.bad_events++;this.state.malformed_ws_frames=(this.state.malformed_ws_frames||0)+1;return;}
     const doc=JSON.parse(event.data);
     if(doc.channel!==channel)return;
     if(doc.event==='subscribe'&&doc.result?.status!=='success'){
      this.state.subscription_failures=(this.state.subscription_failures||0)+1;
      recordGap(this.state,'subscription_rejected',market);try{ws.close();}catch{}return;
     }
     if(doc.event==='update')this.consume(market,doc);
    }catch{this.state.bad_events++;this.state.malformed_ws_frames=(this.state.malformed_ws_frames||0)+1;}
   });
   ws.addEventListener('close',()=>{
    if(this.sockets.get(market)===ws)this.sockets.delete(market);
    recordGap(this.state,'websocket_disconnected',market);
    this.queueRestGap(market);
   });
   ws.addEventListener('error',()=>{this.state.connection_failures++;
    recordGap(this.state,'websocket_error',market);
   });
  }catch{
   this.state.connection_failures++;
   recordGap(this.state,'websocket_connect_failed',market);
  }finally{this.connecting.delete(market);}
 }
 consume(market,doc){
  const now=Date.now(),trades=parseGatePacket(market,doc,this.state.multipliers,now);
  const raw=Array.isArray(doc.result)?doc.result:[doc.result];
  const internal=raw.filter(r=>r?.is_internal===true).length;
  const otherQuote=market==='spot'?raw.filter(r=>r?.is_internal!==true&&
    ((r?.money&&r.money!=='USDT')||(r?.trade_quote&&r.trade_quote!=='USDT'))).length:0;
  const rejected=Math.max(0,raw.length-trades.length-internal-otherQuote);
  this.state.filtered_internal_trades=(this.state.filtered_internal_trades||0)+internal;
  this.state.filtered_other_quote_trades=(this.state.filtered_other_quote_trades||0)+otherQuote;
  this.state.rejected_trade_rows=(this.state.rejected_trade_rows||0)+rejected;
  if(rejected>0)this.state.bad_events++;
  // Normal internal liquidation takeovers are deliberately excluded, not malformed.
  if(trades.length===0)return;
  for(const x of trades){
   const k=market+':'+x.symbol;
   if(!orderIdAfter(x.id,this.state.last_ids[k])){
    this.state.duplicate_events++;continue;
   }
   // Trade ID is scoped to one market. A numeric ID jump is NOT evidence of a lost trade.
   if(this.state.last_event_ms[k]&&x.ts+10000<this.state.last_event_ms[k]){
    recordGap(this.state,'out_of_order_trade',k);continue;
   }
   this.state.last_ids[k]=x.id;
   this.state.last_event_ms[k]=x.ts;
   this.state.counts[k]=(this.state.counts[k]||0)+1;
   const minute=Math.floor(x.ts/MS_MIN)*MS_MIN;
   const age=now-minute;
   if(age>180000||minute>now+MS_MIN){
    recordGap(this.state,'late_or_future_trade',k);continue;
   }
   const bucket=this.state.buckets[minute]||(this.state.buckets[minute]={});
   const a=bucket[k]||(bucket[k]={symbol:x.symbol,market,source:'gateio',
     observed_trades:0,buy_quote_usdt:0,sell_quote_usdt:0,last_trade_ms:0});
   a.observed_trades++;
   a[x.taker+'_quote_usdt']+=x.quote_usdt;
   a.last_trade_ms=Math.max(a.last_trade_ms,x.ts);
  }
 }
 async persist(){
  const now=Date.now(),closeBefore=Math.floor(now/MS_MIN)*MS_MIN;
  const minutes=Object.keys(this.state.buckets).map(Number).filter(n=>n<closeBefore).sort((a,b)=>a-b);
  for(const minute of minutes.slice(0,8)){
   if(!this.env.MARKET_DATA){
    recordGap(this.state,'r2_unavailable','all');throw Error('r2_missing');
   }
   const rows=Object.values(this.state.buckets[minute]);
   const key=ROOT+new Date(minute).toISOString().slice(0,10)+'/'+minute+'.json';
   const body={schema:'lumex_gate_ws_observed_minute_v1',source:'gateio',
    observed_minute_ms:minute,closed_at_ms:now,rows,
    complete_trades_verified:false,synthetic_values:false,
    gaps_observed:this.state.gaps.some(x=>x.at_ms>=minute&&x.at_ms<minute+MS_MIN),
    scope:'observed_websocket_messages_only_not_exchange_complete',
    historical_binance_archive_combined:false,customer_launch_ready:false};
   await this.env.MARKET_DATA.put(key,JSON.stringify(body),{httpMetadata:{contentType:'application/json'}});
   delete this.state.buckets[minute];
   this.state.last_r2_write_ms=now;this.state.last_r2_key=key;
  }
  const remaining=Object.keys(this.state.buckets);
  if(remaining.length>12){
   recordGap(this.state,'buffer_overflow','all');
   for(const minute of remaining.map(Number).sort((a,b)=>a-b).slice(0,-12))delete this.state.buckets[minute];
  }
  await this.runOneRestReplay(now);
  this.state.last_tick_ms=now;
  await this.ctx.storage.put('phase33:checkpoint',this.state);
  // Private diagnostic heartbeat. Does NOT create synthetic trade rows.
  // Bounded to one R2 write per minute.
  if(this.env.MARKET_DATA && (!this.lastStatusWrite || now-this.lastStatusWrite>=60000)){
   const status={...this.health(),status_written_at_ms:now,
     websocket_details:Object.fromEntries(['spot','um-futures'].map(m=>[m,{
       ready_state:this.sockets.get(m)?.readyState??null,
       connecting:this.connecting.has(m),
       connected_at_ms:this.connectionStarted[m]||null
     }]))};
   await this.env.MARKET_DATA.put(ROOT+'status.json',JSON.stringify(status),{
     httpMetadata:{contentType:'application/json'}});
   this.lastStatusWrite=now;
  }
 }
 async alarm(){
  try{
   await this.ensure();await this.persist();
  }catch{recordGap(this.state,'alarm_failure','all');}
  finally{await this.ctx.storage.setAlarm(Date.now()+15000).catch(()=>{});}
 }
}
