import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
const crypto=webcrypto;
const textBuffer=Buffer.from;
const b64=x=>Buffer.from(x).toString('base64url');
const raw=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
 .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}');
const {verifyGithubBinanceOidc,normalizeGithubBinanceFrames,default:worker}=
 await import('data:text/javascript;base64,'+Buffer.from(raw).toString('base64'));
const {publicBinanceFrame,oidcClaimChecks}=await import('../scripts/binance-public-sidecar.mjs');
const now=Date.now(),epoch=Math.floor(now/1000);
const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,
 publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const jwk=await crypto.subtle.exportKey('jwk',pair.publicKey);jwk.kid='test-kid';
const claims={iss:'https://token.actions.githubusercontent.com',aud:'lumex-binance-public-liquidation-v1',
 sub:'repo:lghee/lumex-ai-research:ref:refs/heads/main',
 repository:'lghee/lumex-ai-research',repository_id:'1455460180',
 repository_owner_id:'123610810',ref:'refs/heads/main',
 workflow_ref:'lghee/lumex-ai-research/.github/workflows/lumex-binance-public-sidecar.yml@refs/heads/main',
 runner_environment:'github-hosted',event_name:'schedule',run_id:'43700012345',
 iat:epoch-30,nbf:epoch-30,exp:epoch+240};
async function sign(data){
 const head=b64(JSON.stringify({alg:'RS256',typ:'JWT',kid:'test-kid'}));
 const payload=b64(JSON.stringify(data));const token=head+'.'+payload;
 const signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(token));
 return token+'.'+b64(signature);
}
const token=await sign(claims);
const verifiedChecks=oidcClaimChecks(token,claims.run_id,now);
assert(Object.values(verifiedChecks).every(x=>x===true),'valid signed GitHub token claims must all match');
const wrongChecks=oidcClaimChecks(await sign({...claims,workflow_ref:'wrong'}),claims.run_id,now);
assert.equal(wrongChecks.workflow_ref,false,'workflow ref mismatch must be surfaced');
assert.equal(oidcClaimChecks(token,'111',now).run,false,'run id mismatch must be surfaced');
assert.equal((await verifyGithubBinanceOidc(token,now,async()=>[jwk]))?.run_id,claims.run_id);
const customizedSub=await sign({...claims,sub:'repository_id:1455460180:ref:refs/heads/main'});
assert.equal((await verifyGithubBinanceOidc(customizedSub,now,async()=>[jwk]))?.run_id,claims.run_id,
  'custom GitHub OIDC subject remains valid with signed immutable repo/owner/ref/workflow identity');
assert.equal(oidcClaimChecks(customizedSub,claims.run_id,now).subject,true);
assert.equal(await verifyGithubBinanceOidc(await sign({...claims,sub:''}),now,async()=>[jwk]),null);
assert.equal(await verifyGithubBinanceOidc(await sign({...claims,sub:'x'.repeat(1025)}),now,async()=>[jwk]),null);
for(const changed of [
 {ref:'refs/heads/dev'},{repository_id:'1'},{repository_owner_id:'2'},{event_name:'pull_request'},
 {runner_environment:'self-hosted'},{aud:'not-our-audience'},
 {workflow_ref:'lghee/lumex-ai-research/.github/workflows/evil.yml@refs/heads/main'},
 {exp:epoch-1},{iat:epoch+600}
]) assert.equal(await verifyGithubBinanceOidc(await sign({...claims,...changed}),now,async()=>[jwk]),null,
    'untrusted token must fail closed');
assert.equal(await verifyGithubBinanceOidc(token.slice(0,-4)+'abcd',now,async()=>[jwk]),null);
const frame={stream:'!forceOrder@arr',data:{e:'forceOrder',E:now,st:1,
 o:{s:'BTCUSDT',S:'SELL',X:'FILLED',T:now,ap:'70000',z:'0.12'}}};
assert.deepEqual(publicBinanceFrame(JSON.stringify(frame)),frame);
assert.equal(publicBinanceFrame(JSON.stringify({...frame,stream:'account'})),null);
assert.equal(publicBinanceFrame(JSON.stringify({...frame,data:{...frame.data,st:2}})),null);
assert.equal(publicBinanceFrame('not-json'),null);
const clean=await normalizeGithubBinanceFrames([frame,frame],now);
assert.equal(clean.length,1);assert.equal(clean[0].source,'binance');
assert.equal(clean[0].capture,'sampled_1s');assert(clean[0].id.startsWith('binance:liq:BTCUSDT:'));
assert.equal((await normalizeGithubBinanceFrames([{...frame,data:{...frame.data,o:{...frame.data.o,s:'ADAUSDT'}}}],now)).length,0);
assert.equal(await normalizeGithubBinanceFrames(Array(31).fill(frame),now),null);
const store=new Map(),saved=[];
const env={MARKET_EVENT_HUB:{getByName(name){return{fetch:async(req)=>{
 const body=await req.json();saved.push({name,...body});return new Response(JSON.stringify({ok:true,accepted:body.events.length,invalid:0}))
}}}},MARKET_DATA:{get:async(key)=>store.has(key)?{json:async()=>store.get(key)}:null,
 put:async(key,body)=>store.set(key,JSON.parse(body))}};
const original=globalThis.fetch;
try{
 globalThis.fetch=async(url)=>{
   assert.equal(url,'https://token.actions.githubusercontent.com/.well-known/jwks');
   return new Response(JSON.stringify({keys:[jwk]}),{status:200});
 };
 const request=new Request('https://worker/market-hub/v1/github-binance-ingest',{method:'POST',
  headers:{authorization:'Bearer '+token,'content-type':'application/json'},
  body:JSON.stringify({schema:'lumex_binance_public_sidecar_v1',
   run_id:claims.run_id,route:'binance_usdm_forceorder_ws',started_ms:now,
   provider_messages:1,connected:true,frames:[frame]})});
 const response=await worker.fetch(request,env);
 const out=await response.json();
 assert.equal(response.status,200,JSON.stringify(out));
 assert.equal(out.accepted,1);assert.equal(saved.length,1);
 assert.equal(saved[0].name,'BTCUSDT');
 assert.equal(saved[0].events[0].source,'binance');
 const status=await(await worker.fetch(new Request('https://worker/market-hub/v1/github-binance-health'),env)).json();
 assert.equal(status.capture_confirmed,true);
 assert.equal(status.cron_retirement_allowed,false);
 const unauthorized=await worker.fetch(new Request('https://worker/market-hub/v1/github-binance-ingest',{
  method:'POST',body:'{}'}),env);
 assert.equal(unauthorized.status,401);
}finally{globalThis.fetch=original}
console.log('PASS GitHub OIDC RS256 scoped live Binance sample ingress + duplicate ID + source archive pending + fail closed');
