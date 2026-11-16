/**
 * LUMEX public Binance forceOrder relay (Node >=22).
 * Run only on an independent always-on server with documented Binance WSS egress.
 * No trading, API keys, customer data, private streams or WordPress.
 */
import {randomUUID} from 'node:crypto';
const endpoint=process.env.LUMEX_RELAY_ENDPOINT||'';
const secret=process.env.LUMEX_RELAY_SECRET||'';
if(!/^https:\/\/[A-Za-z0-9.-]+\/market-hub\/v1\/binance-external-ingest$/.test(endpoint)||
   secret.length<48||secret.length>200||typeof WebSocket!=='function'){
  process.stderr.write('LUMEX relay configuration invalid: HTTPS endpoint, >=48-char secret and Node 22 required\n');
  process.exit(2);
}
const wss=[
 'wss://fstream.binance.com/market/ws/!forceOrder@arr',
 'wss://fstream.binance.com/market/stream?streams=!forceOrder@arr'
];
const session_id=randomUUID().toLowerCase();
let socket=null,connected=false,provider_messages=0,dropped_events=0,
 buffer=[],sending=false,lastPost=0,restarts=0,shutdown=false,route=0;
const maxBuffer=300,log=(key,v='')=>console.log(new Date().toISOString(),key,String(v).slice(0,120));
const isBinanceFrame=x=>{
 const v=x?.data??x;
 return v?.e==='forceOrder'&&typeof v.o==='object'&&v.o!==null&&
  (v.st===undefined||v.st===1)&&
  ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT'].includes(String(v.o.s||''))&&
  Number.isSafeInteger(Number(v.o.T));
};
const feedStatus=()=>socket?.readyState===1&&connected;
async function sendBatch(){
 if(sending||shutdown)return;
 if(buffer.length===0&&Date.now()-lastPost<30000)return;
 sending=true;
 const frames=buffer.splice(0,Math.min(buffer.length,25));
 try{
  const body=JSON.stringify({schema:'lumex_binance_public_relay_v1',session_id,
    observed_ms:Date.now(),connected:feedStatus(),provider_messages,dropped_events,frames});
  const reply=await fetch(endpoint,{method:'POST',headers:{
    'authorization':'Bearer '+secret,'content-type':'application/json'},
    body,signal:AbortSignal.timeout(12000)});
  if(!reply.ok)throw Error('worker_http_'+reply.status);
  const result=await reply.json();
  if(result.ok!==true)throw Error('worker_rejected');
  lastPost=Date.now();
  if(frames.length)log('R2_RECEIPT',JSON.stringify({sent:frames.length,accepted:result.accepted,
    deduplicated:frames.length-Number(result.accepted||0)}));
 }catch(e){
  buffer.unshift(...frames);
  if(buffer.length>maxBuffer){dropped_events+=buffer.length-maxBuffer;buffer=buffer.slice(-maxBuffer)}
  log('RELAY_POST_FAILED',e?.message||'unknown');
 }finally{sending=false}
}
function connect(){
 if(shutdown)return;
 const index=route++%wss.length;
 log('BINANCE_CONNECT',index===0?'usd_raw':'usd_combined');
 let ws;
 try{ws=new WebSocket(wss[index])}
 catch(e){log('SOCKET_INIT_FAILED',e?.name||'error');reconnect();return}
 socket=ws;
 ws.addEventListener('open',()=>{
   if(socket!==ws)return;
   connected=true;restarts=0;log('BINANCE_CONNECTED','usd_m_forceOrder_snapshot_1s');
 });
 ws.addEventListener('message',e=>{
   if(socket!==ws||typeof e.data!=='string'||e.data.length>32000)return;
   try{
    const frame=JSON.parse(e.data);
    if(!isBinanceFrame(frame))return;
    provider_messages++;
    if(buffer.length>=maxBuffer){buffer.shift();dropped_events++}
    buffer.push(frame);
    if(buffer.length>=25)void sendBatch();
   }catch{log('MALFORMED_WS_JSON')}
 });
 ws.addEventListener('close',()=>{if(socket===ws){connected=false;socket=null;log('BINANCE_DISCONNECTED');reconnect()}});
 ws.addEventListener('error',()=>{if(socket===ws){connected=false;try{ws.close()}catch{} }});
}
function reconnect(){
 if(shutdown)return;
 const delay=Math.min(180000,Math.max(3000,3000*2**Math.min(restarts++,6)));
 setTimeout(connect,delay);
}
const timer=setInterval(()=>void sendBatch(),10000);
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{
 shutdown=true;clearInterval(timer);
 try{socket?.close()}catch{}
 log('RELAY_STOPPED',sig);process.exit(0);
});
connect();
