/**
 * Phase 33 isolated, preliminary Gate executed-trade stream.
 * Does NOT certify uninterrupted history, full market print coverage,
 * authentic footprint, Binance historical CVD continuity, or launch readiness.
 * Trading/payment/automated strategies are not touched.
 */
import {FLOW_SYMBOLS,parseGatePacket,orderIdAfter} from './order-flow-live-contract.mjs';
import {collectStandbySlice,standbyR2Key,decideRestStandby,lastClosedSlice} from './order-flow-futures-rest-standby.mjs';
import {NATIVE_PROBE_URL,PROBE_SAMPLE_MS,nativeProbeState,shouldRunNativeProbe,
 nativeProbeSubscription,processNativeProbeFrame,nativeProbeClose} from './order-flow-native-transport-probe.mjs';
import {upgradeGateFuturesDecimalWebSocket} from './order-flow-ws-upgrade.mjs';
const ROOT='market-hub/order-flow/v1/live/gate/';
const MS_MIN=60000;
export const gateReplayOptions=(market,now=Date.now())=>({now,limit:1000,maxPages:market==='um-futures'?6:3});
const pair=s=>s+'_USDT';
const fresh=(time,now=Date.now())=>Number.isFinite(time)&&time>0&&now-time<45000;
const cleanState=()=>({
 schema:'lumex_gate_live_collector_v1',first_started_ms:Date.now(),last_tick_ms:0,
 last_r2_write_ms:0,last_r2_key:null,counts:{},last_ids:{},last_event_ms:{},
 buckets:{},gaps:[],bad_events:0,duplicate_events:0,connection_failures:0,
 reconnects:0,multipliers:{},contracts_verified_ms:0,
 rest_replay_pending:[],rest_replay_checks:[],last_rest_replay_attempt_ms:0,
 futures_decimal_header_requested:false,
 futures_1006_recent_ms:[],futures_ws_circuit_until:0,
 futures_rest_cursor:{},futures_rest_pending_slice:{},futures_rest_last_ok_ms:{},futures_rest_last_trade_ms:{},
 futures_rest_last_saved_ms:{},futures_rest_last_error:{},futures_rest_requests:0,
 futures_native_probe:{},
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
  this.retryUntil={};this.failureStreak={};this.lastPingMs={};
  this.nativeProbeSocket=null;
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
   runtime_revision:'phase38_1_ws_handshake_deadline_fixed_20261121',
   websocket_connections:connected,source_count:sources.length,sources,
   multiplier_check_ms:this.state.contracts_verified_ms||null,
   last_archive_ms:this.state.last_r2_write_ms||null,
   last_archive_key:this.state.last_r2_key||null,
   futures_decimal_header_requested:!!this.state.futures_decimal_header_requested,
   websocket_retry_after_ms:this.retryUntil,
   websocket_close_details:(this.state.websocket_close_details||[]).slice(-8),
   futures_last_pong_ms:this.state.futures_last_pong_ms||null,
   futures_native_transport_probe:nativeProbeState(this.state.futures_native_probe,now),
   futures_ws_circuit_until:this.state.futures_ws_circuit_until||0,
   futures_ws_circuit_trips:this.state.futures_ws_circuit_trips||0,
   futures_1006_last_3m:(this.state.futures_1006_recent_ms||[])
     .filter(t=>now-t<180000).length,
   futures_rest_standby:{
     active:decideRestStandby(this.state,now).use_rest_standby||
       this.sockets.get('um-futures')?.readyState!==1||
       !FLOW_SYMBOLS.every(symbol=>fresh(this.state.last_event_ms['um-futures:'+symbol],now)),
     last_http_ok_ms:this.state.futures_rest_last_ok_ms||{},
     last_trade_ms:this.state.futures_rest_last_trade_ms||{},
     last_saved_ms:this.state.futures_rest_last_saved_ms||{},
     last_error:this.state.futures_rest_last_error||{},
     cursor:this.state.futures_rest_cursor||{},
     pending_slice:this.state.futures_rest_pending_slice||{},
     requests:this.state.futures_rest_requests||0,
     skipped_windows:this.state.futures_rest_skipped_windows||0,
     contiguous_success_cursor:true,
     source:'gateio_rest',websocket_merged:false,customer_launch_ready:false
   },
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
  // At most one outstanding REST candidate per market/symbol. A persistent
  // disconnect cannot enqueue 4 probes every minute while only 1/min drains.
  for(let i=queue.length-1;i>=0;i--)
   if(at-queue[i].minute>25*MS_MIN)queue.splice(i,1);
  const minute=Math.floor((at-3*MS_MIN)/MS_MIN)*MS_MIN;
  for(const symbol of FLOW_SYMBOLS){
   const key=market+':'+symbol+':'+minute;
   if(!queue.some(x=>x.market===market&&x.symbol===symbol)&&queue.length<8)
    queue.push({key,market,symbol,minute,queued_at_ms:at});
  }
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
     this.state.multipliers,gateReplayOptions(task.market,now));
   result.status=proof.status;result.pages=proof.pages;result.rows=proof.rows;
   if(this.env.MARKET_DATA){
    await this.env.MARKET_DATA.put(mod.recoveryKey(task.market,task.symbol,task.minute),
     JSON.stringify(proof),{httpMetadata:{contentType:'application/json'}});
   }else result.status='r2_unavailable';
   if(!['bounded_rest_pages_exhausted','bounded_futures_time_slices_observed'].includes(proof.status))
    recordGap(this.state,'rest_replay_'+String(proof.status).slice(0,50),
      task.market+':'+task.symbol);
  }catch{
   result.status='rest_replay_unavailable';
   recordGap(this.state,'rest_replay_exception',task.market+':'+task.symbol);
  }
  const checks=this.state.rest_replay_checks||(this.state.rest_replay_checks=[]);
  checks.push({...result,attempt_at_ms:now});this.state.rest_replay_checks=checks.slice(-40);
 }
 ensureNativeProbe(now=Date.now()){
  // Never connect native WS if the experiment is disabled. Native WS cannot
  // send the mandatory decimal precision header, so metadata only is recorded.
  if(this.env.AUTO_GATE_NATIVE_TRANSPORT_PROBE!=='true')return;
  const st=this.state.futures_native_probe||(this.state.futures_native_probe={});
  if(this.nativeProbeSocket&&this.nativeProbeSocket.readyState===1){
   if(now-(st.connected_at_ms||now)>PROBE_SAMPLE_MS){
    try{this.nativeProbeSocket.close(1000,'phase38_sample_complete');}catch{}
    return;
   }
   if(now-(st.last_ping_at_ms||0)>20000){
    try{
     this.nativeProbeSocket.send(JSON.stringify({time:Math.floor(now/1000),channel:'futures.ping'}));
     st.last_ping_at_ms=now;
    }catch{st.last_error_at_ms=now;}
   }
   return;
  }
  if(this.nativeProbeSocket&&this.nativeProbeSocket.readyState===0 &&
     now-(st.last_attempt_at_ms||0)<20000)return;
  if(this.nativeProbeSocket&&this.nativeProbeSocket.readyState!==1){
   try{this.nativeProbeSocket.close(1000,'phase38_recover_stalled_handshake');}catch{}
   this.nativeProbeSocket=null;
   st.state='closed';
  }
  if(st.state==='connected'&&!this.nativeProbeSocket)
   st.state='interrupted_by_DO_restart';
  const recent=(this.state.futures_1006_recent_ms||[]).filter(t=>now-t<180000);
  const gateDegraded=(this.state.futures_ws_circuit_until||0)>now||
    recent.length>0||this.state.websocket_close_details?.some(x=>
      x.market==='um-futures'&&x.code===1006&&now-x.at_ms<180000);
  if(!gateDegraded||!shouldRunNativeProbe(st,now))return;
  st.state='connecting';st.last_attempt_at_ms=now;
  st.attempts=(st.attempts||0)+1;
  try{
   const ws=new WebSocket(NATIVE_PROBE_URL);
   this.nativeProbeSocket=ws;
   ws.addEventListener('open',()=>{
    st.state='connected';st.connected_at_ms=Date.now();
    try{ws.send(nativeProbeSubscription());}catch{
     st.last_error_at_ms=Date.now();try{ws.close(1011,'subscribe_send_failed');}catch{}
    }
   });
   ws.addEventListener('message',event=>{
    processNativeProbeFrame(st,event.data,Date.now());
   });
   ws.addEventListener('close',event=>{
    if(this.nativeProbeSocket===ws)this.nativeProbeSocket=null;
    nativeProbeClose(st,Number(event.code||0),event.reason,Date.now());
   });
   ws.addEventListener('error',()=>{st.last_error_at_ms=Date.now();});
  }catch{
   this.nativeProbeSocket=null;
   st.state='connect_failed';st.last_error_at_ms=Date.now();
  }
 }
 async ensure(){
  this.ensureNativeProbe();
  // Gate protocol ping/pong is automatic at WebSocket layer. Add an
  // application-level liveness probe to distinguish silent futures sockets.
  const future=this.sockets.get('um-futures');
  if(future?.readyState===1&&Date.now()-(this.lastPingMs['um-futures']||0)>20000){
   try{
    future.send(JSON.stringify({time:Math.floor(Date.now()/1000),channel:'futures.ping'}));
    this.lastPingMs['um-futures']=Date.now();
   }catch{recordGap(this.state,'futures_application_ping_send_failed','um-futures');}
  }
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
  if(Date.now()<(this.retryUntil[market]||0))return;
  if(market==='um-futures'&&Date.now()<(this.state.futures_ws_circuit_until||0))return;
  this.connecting.add(market);
  const url=market==='spot'?'wss://api.gateio.ws/ws/v4/':'wss://fx-ws.gateio.ws/v4/ws/usdt';
  const channel=market==='spot'?'spot.trades':'futures.trades';
  try{
   let ws;
   if(market==='um-futures'){
    // Gate futures truncates fractional sizes unless decimal mode is requested.
    // Handshake-only deadline: unlike AbortSignal.timeout(10000), this
    // timer is CANCELLED once the 101 upgrade succeeds. Otherwise the
    // active WebSocket can be aborted ten seconds later with code 1006.
    const upgraded=await upgradeGateFuturesDecimalWebSocket();
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
    this.retryUntil[market]=0; // reset failure streak only after a sustained session
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
     if(market==='um-futures'&&doc.channel==='futures.pong'){
      this.state.futures_last_pong_ms=Date.now();return;
     }
     if(doc.channel==='futures.system'&&doc.result?.type==='upgrade'){
      recordGap(this.state,'futures_provider_upgrade',market);
      try{ws.close(1000,'provider_upgrade');}catch{}
      return;
     }
     if(doc.channel!==channel)return;
     if(doc.event==='subscribe'&&(doc.error||doc.result?.status!=='success')){
      this.state.subscription_failures=(this.state.subscription_failures||0)+1;
      recordGap(this.state,'subscription_rejected',market);try{ws.close();}catch{}return;
     }
     if(doc.event==='update')this.consume(market,doc);
    }catch{this.state.bad_events++;this.state.malformed_ws_frames=(this.state.malformed_ws_frames||0)+1;}
   });
   ws.addEventListener('close',event=>{
    if(this.sockets.get(market)===ws)this.sockets.delete(market);
    const details=this.state.websocket_close_details||(this.state.websocket_close_details=[]);
    details.push({market,at_ms:Date.now(),code:Number(event?.code||0),
     clean:Boolean(event?.wasClean),reason:String(event?.reason||'').slice(0,55)});
    this.state.websocket_close_details=details.slice(-24);
    if(market==='um-futures'&&Number(event?.code)===1006){
     const at=Date.now();
     const recent=(this.state.futures_1006_recent_ms||[]).filter(t=>at-t<180000);
     recent.push(at);
     this.state.futures_1006_recent_ms=recent.slice(-16);
     if(recent.length>=3){
      const trips=(this.state.futures_ws_circuit_trips||0)+1;
      this.state.futures_ws_circuit_trips=trips;
      // If the provider/egress repeatedly drops connections, keep the
      // proven separate REST standby instead of a reconnect storm.
      const pauseMin=Math.min(30,5*2**Math.min(trips-1,3));
      this.state.futures_ws_circuit_until=at+pauseMin*60000;
      recordGap(this.state,'futures_ws_circuit_rest_standby','um-futures');
     }
    }
    const duration=Date.now()-(this.connectionStarted[market]||Date.now());
    if(market==='um-futures'&&duration>120000){
     this.state.futures_ws_circuit_trips=0;
     this.state.futures_1006_recent_ms=[];
    }
    this.failureStreak[market]=duration>120000?0:Math.min(4,(this.failureStreak[market]||0)+1);
    this.retryUntil[market]=Date.now()+Math.min(45000,2000*2**this.failureStreak[market]);
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
   const minute=Math.floor(x.ts/MS_MIN)*MS_MIN;
   const age=now-minute;
   if(age>180000||minute>now+MS_MIN){
    recordGap(this.state,'late_or_future_trade',k);continue;
   }
   // Only advance the last accepted ID after its timestamp and source pass.
   this.state.last_ids[k]=x.id;
   this.state.last_event_ms[k]=x.ts;
   this.state.counts[k]=(this.state.counts[k]||0)+1;
   const bucket=this.state.buckets[minute]||(this.state.buckets[minute]={});
   const a=bucket[k]||(bucket[k]={symbol:x.symbol,market,source:'gateio',
     observed_trades:0,buy_quote_usdt:0,sell_quote_usdt:0,last_trade_ms:0});
   a.observed_trades++;
   a[x.taker+'_quote_usdt']+=x.quote_usdt;
   a.last_trade_ms=Math.max(a.last_trade_ms,x.ts);
  }
 }
 async runFuturesRestStandby(now=Date.now(),collector=collectStandbySlice){
  if(this.env.AUTO_GATE_FUTURES_REST_STANDBY!=='true')return;
  const active=this.sockets.get('um-futures')?.readyState===1;
  const allFresh=FLOW_SYMBOLS.every(symbol=>
   fresh(this.state.last_event_ms['um-futures:'+symbol],now));
  // An OPEN socket with no current executions is not a healthy feed.
  if(active&&allFresh&&!decideRestStandby(this.state,now).use_rest_standby)return;
  if(!this.env.MARKET_DATA){
   recordGap(this.state,'futures_rest_standby_r2_unavailable','um-futures');return;
  }
  const end=lastClosedSlice(now);
  const cursor=this.state.futures_rest_cursor||(this.state.futures_rest_cursor={});
  const pending=this.state.futures_rest_pending_slice||(this.state.futures_rest_pending_slice={});
  const ok=this.state.futures_rest_last_ok_ms||(this.state.futures_rest_last_ok_ms={});
  const tradeTs=this.state.futures_rest_last_trade_ms||(this.state.futures_rest_last_trade_ms={});
  const saved=this.state.futures_rest_last_saved_ms||(this.state.futures_rest_last_saved_ms={});
  const errors=this.state.futures_rest_last_error||(this.state.futures_rest_last_error={});
  // Process each symbol in strict time order, at most two 10-second slots per
  // alarm. Different symbols can proceed in parallel, not adjacent slots.
  await Promise.all(FLOW_SYMBOLS.map(async symbol=>{
   let last=Number(cursor[symbol]);
   const queued=Number(pending[symbol]);
   // On the very first failed slot there is no successful cursor yet.
   // Keep the failed slot explicitly instead of recomputing from a later end.
   if(!Number.isSafeInteger(last)&&Number.isSafeInteger(queued)&&
      queued<=end&&end-queued<=120000)last=queued-10000;
   if(!Number.isSafeInteger(last)||last>end||end-last>120000){
    if(Number.isSafeInteger(last)&&last>0&&end-last>120000){
     recordGap(this.state,'futures_rest_standby_cursor_skipped','um-futures:'+symbol);
     this.state.futures_rest_skipped_windows=(this.state.futures_rest_skipped_windows||0)+1;
    }
    last=end-20000;
    delete pending[symbol];
   }
   for(let step=0;step<2;step++){
    const at=last+10000;
    if(at>end)break;
    try{
     const proof=await collector(symbol,at,this.state.multipliers,{now});
     // A negative or incomplete result is preserved as explicit evidence;
     // it must not move the successful contiguous cursor.
     await this.env.MARKET_DATA.put(standbyR2Key(symbol,at),JSON.stringify(proof),
      {httpMetadata:{contentType:'application/json'}});
     saved[symbol]=now;
     this.state.futures_rest_requests=(this.state.futures_rest_requests||0)+1;
     if(!proof.ok){
      pending[symbol]=at;
      errors[symbol]={at_ms:now,slice_start_ms:at,reason:proof.status};
      recordGap(this.state,'futures_rest_standby_'+String(proof.status).slice(0,55),
       'um-futures:'+symbol);
      break;
     }
     cursor[symbol]=at;
     delete pending[symbol];
     last=at;
     ok[symbol]=now;
     if(proof.last_trade_ms)tradeTs[symbol]=proof.last_trade_ms;
     delete errors[symbol];
    }catch{
     pending[symbol]=at;
     errors[symbol]={at_ms:now,slice_start_ms:at,reason:'rest_or_r2_failed'};
     recordGap(this.state,'futures_rest_standby_io_failed','um-futures:'+symbol);
     // Retry the same slice on the next alarm, never jump over a failed R2 write.
     this.state.futures_rest_requests=(this.state.futures_rest_requests||0)+1;
     break;
    }
   }
  }));
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
  // Current 10-second futures observations take priority over historical
  // REST replay, which can consume up to 12 seconds per tick. Never let a
  // lower-priority repair cause current source gaps during WS outages.
  await this.runFuturesRestStandby(now);
  const futuresConnection=this.sockets.get('um-futures')?.readyState===1;
  const futuresCurrent=FLOW_SYMBOLS.every(symbol=>fresh(
   this.state.last_event_ms['um-futures:'+symbol],now));
  if(futuresConnection&&futuresCurrent)
   await this.runOneRestReplay(now);
  this.state.last_tick_ms=now;
  await this.ctx.storage.put('phase33:checkpoint',this.state);
  // Private diagnostic heartbeat. Does NOT create synthetic trade rows.
  // Independent private heartbeat every 20s for bounded rollout attestation.
  if(this.env.MARKET_DATA && (!this.lastStatusWrite || now-this.lastStatusWrite>=20000)){
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
