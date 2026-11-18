import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../src/index.js',import.meta.url),'utf8')
  .replace("import { DurableObject } from 'cloudflare:workers';",
    'class DurableObject { constructor(ctx, env) { this.ctx=ctx;this.env=env; } }');
const {pollCloudflareBinanceCapture,cloudflareBinanceHealth,default:worker}=
  await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const now=Date.now(),map=new Map(),received=[];
const probeKey='market-hub/diagnostics/binance-container-egress-v1.json';
const healthKey='market-hub/diagnostics/binance-cloudflare-capture-v1.json';
map.set(probeKey,JSON.stringify({schema:'lumex_binance_egress_proof_v1',
  ok:true,status:'upgrade_accepted',handshake_http_status:101,checked_ms:now}));
const frame={stream:'!forceOrder@arr',data:{e:'forceOrder',E:now,st:1,
  o:{s:'BTCUSDT',S:'SELL',X:'FILLED',T:now,ap:'80000.25',z:'0.09'}}};
const sessionId='11111111-1111-4111-a111-111111111111';
let counter=0,posts=0,failProof=false;
const r2={
  get:async key=>map.has(key)?{
    size:Buffer.byteLength(map.get(key)),
    json:async()=>JSON.parse(map.get(key)),
    text:async()=>map.get(key)
  }:null,
  put:async (key,value)=>{
    if(failProof&&key.includes('events-source-proof'))throw Error('mock_r2_write_denied');
    map.set(key,String(value));
  }
};
const getReply=(arg)=>{
  counter++;
  const same=arg.cursor_session===sessionId,seq=same?arg.after_seq:0;
  const frames=seq<1?[{seq:1,frame}]:[];
  return {schema:'lumex_cloudflare_binance_container_v1',
    session_id:sessionId,connected:true,last_frame_ms:now,
    next_retry_ms:0,error_code:null,dropped_events:0,
    latest_seq:1,frames,cursor_gap:false,session_changed:!same};
};
const env={AUTO_BINANCE_CLOUDFLARE_CAPTURE:'true',
  LUMEX_CONTAINER_KEY:'k'.repeat(48),
  MARKET_DATA:r2,
  RESEARCH_CONTAINER:{getByName:name=>{
    assert.equal(name,'primary-research');
    return {fetch:async(url,request)=>{
      assert.equal(url,'https://internal.lumex/binance-cloudflare-capture');
      assert.equal(request.method,'POST');
      const payload=JSON.parse(request.body);
      assert.equal(payload.scope,'public_usdm_forceOrder');
      return new Response(JSON.stringify(getReply(payload)),{status:200});
    }};
  }},
  MARKET_EVENT_HUB:{getByName:name=>{
    assert.equal(name,'BTCUSDT');
    return {fetch:async(request)=>{
      posts++;
      const payload=await request.json();
      received.push(...payload.events);
      return new Response(JSON.stringify({accepted:payload.events.length,invalid:0}),
        {status:200});
    }};
  }}};
const first=await pollCloudflareBinanceCapture(env,now);
assert.equal(first.ok,true);
assert.equal(first.frames,1);
assert.equal(first.readback,1);
assert.equal(posts,1);
assert.equal(received[0].source,'binance');
assert.equal(received[0].capture,'sampled_1s');
let status=JSON.parse(map.get(healthKey));
assert.equal(status.checkpoint_seq,1);
assert.equal(status.connected,true);
assert.equal(status.complete_market_capture,false);
assert.equal(status.cron_retirement_allowed,false);
assert.equal(status.source_r2_readback_verified,true);
assert.equal((await cloudflareBinanceHealth(env,now)).connected,true);
const repeat=await pollCloudflareBinanceCapture(env,now+60000);
assert.equal(repeat.ok,true);
assert.equal(repeat.frames,0);
assert.equal(posts,1);
assert.equal((await cloudflareBinanceHealth(env,now+60000)).continuous_seconds,60);
assert.equal((await cloudflareBinanceHealth(env,now+200000)).stale,true);
// Denied Cloudflare egress means ZERO extra container requests.
map.set(probeKey,JSON.stringify({schema:'lumex_binance_egress_proof_v1',
  ok:false,status:'upstream_403',handshake_http_status:403,checked_ms:now}));
const denied=await pollCloudflareBinanceCapture(env,now+60000);
assert.equal(denied.ok,false);
assert.equal(denied.reason,'cloudflare_egress_not_authorized');
assert.equal(counter,2);
map.set(probeKey,JSON.stringify({schema:'lumex_binance_egress_proof_v1',
  ok:true,status:'upgrade_accepted',handshake_http_status:101,checked_ms:now+60000}));
// Verified checkpoint must never move on R2 failure; no fake zero.
map.delete(healthKey);failProof=true;
const failed=await pollCloudflareBinanceCapture(env,now+65000);
assert.equal(failed.ok,false);
assert.match(failed.reason,/mock_r2_write_denied/);
assert.equal(map.has(healthKey),false);
failProof=false;
const success=await pollCloudflareBinanceCapture(env,now+67000);
assert.equal(success.ok,true);
assert.equal(JSON.parse(map.get(healthKey)).checkpoint_seq,1);
const healthResponse=await worker.fetch(
  new Request('https://worker/market-hub/v1/binance-cloudflare-health'),env);
assert.equal(healthResponse.status,200);
assert.equal((await healthResponse.json()).cron_retirement_allowed,false);
console.log('PASS no-VPS conditional Cloudflare collection: true WSS gate, EventHub+R2 checkpoint, retry and no false coverage');
