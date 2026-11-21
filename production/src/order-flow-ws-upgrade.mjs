/**
 * Gate futures WS handshake with a CANCELABLE deadline.
 *
 * DO NOT use AbortSignal.timeout(10000) here: the signal remains armed even
 * after the HTTP 101 handshake and can abort the live upgraded WebSocket ten
 * seconds into the session (seen as abnormal code 1006).
 *
 * The timeout is active only until fetch resolves; after 101 it is cleared,
 * so the upgrade signal is never aborted while the live socket is in use.
 */
export const FUTURES_WS_URL='https://fx-ws.gateio.ws/v4/ws/usdt';
export async function upgradeGateFuturesDecimalWebSocket(fetchFn=fetch,opts={}){
 const timeoutMs=Number(opts.timeoutMs??10000);
 if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>30000)
  throw Error('invalid_upgrade_timeout');
 const schedule=opts.schedule||setTimeout;
 const cancel=opts.cancel||clearTimeout;
 const abortController=new AbortController();
 const timer=schedule(()=>abortController.abort('gate_futures_ws_handshake_timeout'),timeoutMs);
 try{
  const response=await fetchFn(FUTURES_WS_URL,{
   headers:{Upgrade:'websocket','X-Gate-Size-Decimal':'1'},
   signal:abortController.signal
  });
  return response;
 }finally{
  // Clear on success AND error. This is essential to prevent late 1006.
  cancel(timer);
 }
}
