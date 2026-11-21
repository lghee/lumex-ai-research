/**
 * Phase38 isolated A/B Gate futures WebSocket transport diagnostic.
 *
 * Existing futures execution source uses fetch() with X-Gate-Size-Decimal: 1.
 * This probe uses the native Worker outbound WebSocket API without custom headers.
 * Gate documents that fractional contract sizes can be rounded without the
 * explicit decimal header. Therefore NEVER calculate or persist trade notional
 * from this socket, and NEVER use it as a customer feed or continuity proof.
 */
export const NATIVE_PROBE_URL='wss://fx-ws.gateio.ws/v4/ws/usdt';
export const PROBE_MIN_INTERVAL_MS=180000;
export const PROBE_SAMPLE_MS=420000;
export function nativeProbeState(st={},now=Date.now()){
 const active=st.state==='connected'&&Number.isFinite(st.connected_at_ms);
 return {
  schema:'lumex_gate_futures_ws_native_transport_probe_v1',
  transport:'cloudflare_native_WebSocket',
  market:'um-futures',source:'gateio_websocket_rounded_quantity_diagnostic',
  precision_header_requested:false,
  trade_amounts_stored:false,trade_notional_usable:false,
  customer_launch_ready:false,source_join_allowed:false,
  state:st.state||'not_started',attempts:st.attempts||0,
  last_attempt_at_ms:st.last_attempt_at_ms||null,
  last_open_at_ms:st.connected_at_ms||null,
  uptime_ms:active?Math.max(0,now-st.connected_at_ms):st.last_uptime_ms||0,
  last_close_code:st.last_close_code??null,
  last_close_reason:st.last_close_reason??null,
  last_close_at_ms:st.last_close_at_ms||null,
  last_error_at_ms:st.last_error_at_ms||null,
  subscriptions_ok:st.subscriptions_ok||0,
  subscriptions_rejected:st.subscriptions_rejected||0,
  observed_trade_frames:st.observed_trade_frames||0,
  last_trade_frame_ms:st.last_trade_frame_ms||null,
  pong_count:st.pong_count||0,last_pong_at_ms:st.last_pong_at_ms||null
 };
}
export function shouldRunNativeProbe(st={},now=Date.now()){
 const last=Number(st.last_attempt_at_ms||0);
 return st.state!=='connected'&&st.state!=='connecting'&&
  (last===0||now-last>=PROBE_MIN_INTERVAL_MS);
}
export function nativeProbeSubscription(now=Date.now()){
 return JSON.stringify({
  time:Math.floor(now/1000),channel:'futures.trades',event:'subscribe',
  payload:['BTC_USDT','ETH_USDT','SOL_USDT','XRP_USDT']
 });
}
export function processNativeProbeFrame(st,data,now=Date.now()){
 // Deliberately extract only channel/event metadata, never trade amount/id.
 if(typeof data!=='string'||data.length>1_500_000)return false;
 let doc;
 try{doc=JSON.parse(data);}catch{return false;}
 if(doc.channel==='futures.pong'){
  st.pong_count=(st.pong_count||0)+1;st.last_pong_at_ms=now;return true;
 }
 if(doc.channel!=='futures.trades')return false;
 if(doc.event==='subscribe'){
  if(doc.error||doc.result?.status!=='success')
   st.subscriptions_rejected=(st.subscriptions_rejected||0)+1;
  else st.subscriptions_ok=(st.subscriptions_ok||0)+1;
  return true;
 }
 if(doc.event==='update'){
  st.observed_trade_frames=(st.observed_trade_frames||0)+1;
  st.last_trade_frame_ms=now;return true;
 }
 return false;
}
export function nativeProbeClose(st,code,reason,now=Date.now()){
 const start=Number(st.connected_at_ms||st.last_attempt_at_ms||now);
 st.last_uptime_ms=Math.max(0,now-start);
 st.last_close_code=Number.isSafeInteger(code)?code:0;
 st.last_close_reason=String(reason??'').slice(0,80);
 st.last_close_at_ms=now;
 st.state='closed';
 return st;
}
