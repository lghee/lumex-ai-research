/** Public Binance forceOrder sampled observations from GitHub-hosted egress.
 * The existing Cloudflare egress is HTTP 403. Send only provider snapshots.
 * GitHub OIDC authorizes Worker ingestion without persistent secrets.
 * Scheduled windows can have gaps; NEVER claim full real-time market capture.
 */
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const API='https://lumex-ai-research2.kpiplus195.workers.dev/market-hub/v1/github-binance-ingest';
const WS='wss://fstream.binance.com/market/stream?streams=!forceOrder@arr';
const AUD='lumex-binance-public-liquidation-v1';
const SYMBOLS=new Set(['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT']);
export function publicBinanceFrame(data){
  if(typeof data!=='string'||data.length>4000)return null;
  let j;try{j=JSON.parse(data)}catch{return null}
  const v=j?.data||j;
  if(v?.e!=='forceOrder'||!SYMBOLS.has(v?.o?.s)||!['BUY','SELL'].includes(v?.o?.S))
    return null;
  if(j?.stream&&j.stream!=='!forceOrder@arr')return null;
  if(v.st!==undefined&&v.st!==1)return null;
  if(!Number.isSafeInteger(Number(v.E))||!Number.isSafeInteger(Number(v.o?.T)))return null;
  if(!['FILLED','PARTIALLY_FILLED'].includes(v.o?.X))return null;
  // Only necessary public market observation fields leave the runner.
  return {stream:'!forceOrder@arr',data:{e:'forceOrder',E:Number(v.E),
    st:1,o:{s:v.o.s,S:v.o.S,X:v.o.X,T:Number(v.o.T),
      ap:String(v.o.ap||''),z:String(v.o.z||'')}}};
}
/** Validate expected public/non-secret OIDC claims locally for incident diagnosis.
 * Never log the signed JWT, its signature, or request bearer tokens. */
export function oidcClaimChecks(token,runId,now=Date.now()){
  const [a,b]=String(token||'').split('.');
  let h,c;try{
    h=JSON.parse(Buffer.from(a,'base64url').toString('utf8'));
    c=JSON.parse(Buffer.from(b,'base64url').toString('utf8'));
  }catch{throw Error('oidc_claim_parse_failed')}
  const t=Math.floor(now/1000);
  return {
    alg:h?.alg==='RS256',
    kid:typeof h?.kid==='string'&&h.kid.length>0,
    issuer:c?.iss==='https://token.actions.githubusercontent.com',
    audience:c?.aud===AUD,
    repository:c?.repository==='lghee/lumex-ai-research',
    repository_id:String(c?.repository_id)==='1455460180',
    owner_id:String(c?.repository_owner_id)==='123610810',
    subject:c?.sub==='repo:lghee/lumex-ai-research:ref:refs/heads/main',
    ref:c?.ref==='refs/heads/main',
    workflow_ref:c?.workflow_ref==='lghee/lumex-ai-research/.github/workflows/lumex-binance-public-sidecar.yml@refs/heads/main',
    event:['schedule','workflow_dispatch'].includes(c?.event_name),
    runner:c?.runner_environment==='github-hosted',
    run:String(c?.run_id)===String(runId),
    issued:Number.isSafeInteger(c?.iat)&&c.iat<=t+30&&t-c.iat<=480,
    expires:Number.isSafeInteger(c?.exp)&&c.exp>t&&c.exp<=t+900,
    not_before:c?.nbf===undefined||(Number.isSafeInteger(c.nbf)&&c.nbf<=t+30)
  };
}
async function getGithubOidc(){
  const endpoint=process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const auth=process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if(!endpoint||!auth)throw Error('oidc_permission_missing');
  const u=new URL(endpoint);u.searchParams.set('audience',AUD);
  const response=await fetch(u,{headers:{authorization:'Bearer '+auth},
    signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error('github_oidc_http_'+response.status);
  const data=await response.json();
  if(typeof data?.value!=='string'||data.value.split('.').length!==3)
    throw Error('github_oidc_invalid');
  return data.value;
}
export async function runSidecar(){
  const runId=process.env.GITHUB_RUN_ID||'';
  if(!/^\d{5,16}$/.test(runId))throw Error('github_run_id_missing');
  if(typeof WebSocket!=='function')throw Error('node22_websocket_unavailable');
  const duration=205000;
  let opened=false,closed=false,failed=false,messages=0,batches=0,accepted=0;
  let frames=[],pumping=false,sendErrors=0,token=null,fatalAuth=false;
  const started=Date.now();
  const socket=new WebSocket(WS);
  const openedPromise=new Promise((resolveOpen,rejectOpen)=>{
    const timer=setTimeout(()=>rejectOpen(Error('binance_ws_open_timeout')),16000);
    socket.addEventListener('open',()=>{clearTimeout(timer);opened=true;resolveOpen()},{once:true});
    socket.addEventListener('error',()=>{clearTimeout(timer);failed=true;
      rejectOpen(Error('binance_ws_error'))},{once:true});
    socket.addEventListener('close',()=>{closed=true;if(!opened){clearTimeout(timer);
      rejectOpen(Error('binance_ws_closed_before_open'))}},{once:true});
  });
  socket.addEventListener('message',message=>{
    const data=typeof message.data==='string'?message.data:'';
    const clean=publicBinanceFrame(data);
    if(clean){
      messages++;
      if(frames.length<500)frames.push(clean);
      else failed=true; // bounded memory and visible evidence of truncation
    }
  });
  async function pump(){
    if(pumping||!token)return;
    pumping=true;
    const sending=frames.splice(0,30);
    try{
      const payload={schema:'lumex_binance_public_sidecar_v1',
        run_id:runId,route:'binance_usdm_forceorder_ws',started_ms:started,
        provider_messages:messages,connected:opened&&!closed,frames:sending};
      const response=await fetch(API,{method:'POST',
        headers:{authorization:'Bearer '+token,'content-type':'application/json'},
        body:JSON.stringify(payload),signal:AbortSignal.timeout(13000)});
      if(!response.ok){
        let reason='unknown';
        try{const data=await response.json();
          const text=String(data?.error||'');
          if(/^[a-z0-9_-]{1,80}$/.test(text))reason=text;
        }catch{}
        if(response.status===401||response.status===403)fatalAuth=true;
        throw Error('sidecar_ingest_http_'+response.status+'_'+reason);
      }
      const out=await response.json();
      if(out?.ok!==true||out.run_id!==runId||!Number.isSafeInteger(out.accepted)||
        out.accepted<0||out.accepted>sending.length)throw Error('sidecar_ingest_invalid_ack');
      batches++;accepted+=out.accepted;
    }catch(error){
      sendErrors++;
      // A failed batch must not be reported as accepted; replay is idempotent
      // via the verified SHA256 Binance snapshot ID in Cloudflare EventHub.
      frames.unshift(...sending);
      console.error('ingest_retry_required',String(error.message||'unknown').slice(0,75));
    }finally{pumping=false}
  }
  let timer;
  try{
    await openedPromise;
    token=await getGithubOidc();
    const checks=oidcClaimChecks(token,runId);
    console.log('sidecar_oidc_claim_checks',JSON.stringify(checks));
    if(Object.values(checks).some(ok=>ok!==true))
      throw Error('oidc_claim_mismatch_'+Object.keys(checks).filter(k=>!checks[k]).join('_').slice(0,90));
    await pump(); // authenticated connection evidence (may contain 0 frames)
    if(fatalAuth)throw Error('sidecar_ingress_rejected_authentication');
    timer=setInterval(()=>{void pump()},20000);
    await new Promise(resolveDone=>setTimeout(resolveDone,duration));
    for(let i=0;i<5&&(frames.length>0||i===0);i++){
      await pump();if(frames.length)await new Promise(r=>setTimeout(r,1000));
    }
  }finally{
    clearInterval(timer);
    try{socket.close()}catch{}
    // Source status is not proof of full capture. Print no auth token or payload.
    console.log(JSON.stringify({source:'binance_usdm_forceorder_public',
      connected:opened,provider_messages:messages,ingested:accepted,
      batches,delivery_errors:sendErrors,connection_error:failed,
      window_seconds:Math.round((Date.now()-started)/1000),
      complete_market_capture:false,orders_enabled:false}));
  }
  if(!opened||sendErrors||frames.length||failed&&!closed)
    throw Error('public_observation_incomplete_or_delivery_failed');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
  runSidecar().catch(error=>{console.error('sidecar_failed',String(error.message||'unknown').slice(0,75));process.exitCode=1});
