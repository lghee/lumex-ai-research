import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../src/index.js',import.meta.url),'utf8')
  .replace("import { DurableObject } from 'cloudflare:workers';",
    'class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}');
const {ResearchContainer,default:worker}=
  await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));

function makeContainer(oldImage='sha256:old',goodContract=true){
  let current=oldImage,active=true,restarts=0,destroyed=0,healthReads=0,posts=0;
  const desired='sha256:cloudflare-binance-v2';
  const container={
    images:{base:desired},
    get running(){return active},
    inspect:async()=>active?{image:current}:null,
    destroy:async()=>{destroyed++;active=false;},
    start:(options)=>{
      assert.equal(options.image,desired);
      assert.equal(options.enableInternet,true);
      active=true;current=desired;restarts++;
    },
    setInactivityTimeout:async()=>{},
    getTcpPort:()=>{
      return {fetch:async(url,opts={})=>{
        const target=typeof url==='string'?url:url.url;
        const req=url instanceof Request?url:null;
        if(target==='http://container/health'){
          healthReads++;
          return Response.json({ok:true,binance_image_contract:goodContract?
            'lumex_binance_capture_20261119_v2':'missing'});
        }
        if(target.endsWith('/binance-egress-probe')){
          posts++;
          assert.equal(req?.method,'POST');
          assert.equal(req?.headers.get('X-Lumex-Internal-Key'),'secret'.repeat(8));
          return Response.json({ok:false,handshake_http_status:403,
            error_code:'upstream_http_forbidden'});
        }
        if(target.endsWith('/fetch')){
          posts++;
          return Response.json({ok:true,legacy:true});
        }
        throw Error('unexpected_container_route_'+url);
      }};
    }
  };
  const ctx={container,blockConcurrencyWhile:async cb=>await cb(),waitUntil:()=>{}};
  const env={LUMEX_CONTAINER_KEY:'secret'.repeat(8)};
  return {container,ctx,env,stats:()=>({restarts,destroyed,posts,healthReads})};
}
{
  const x=makeContainer();
  const doObj=new ResearchContainer(x.ctx,x.env);
  const readOnly=await doObj.fetch(new Request('https://internal.lumex/__container-image-status'));
  const report=await readOnly.json();
  assert.equal(report.ok,true);
  assert.equal(report.container_running,true);
  assert.equal(report.image_matches_current,false);
  assert.equal(x.stats().destroyed,0,'read-only health must not restart container');
  const res=await doObj.fetch(new Request('https://internal.lumex/binance-egress-probe',{
    method:'POST',body:JSON.stringify({scope:'public_usdm_forceOrder'})}));
  assert.equal(res.status,200);
  const answer=await res.json();
  assert.equal(answer.handshake_http_status,403,'403 from Binance must remain upstream denial');
  assert.equal(x.stats().restarts,1,'stale image must rotate once');
  assert.equal(x.stats().destroyed,1);
  assert.equal(x.stats().posts,1);
  const again=await doObj.fetch(new Request('https://internal.lumex/binance-egress-probe',{
    method:'POST',body:'{}'}));
  assert.equal(again.status,200);
  assert.equal(x.stats().restarts,1,'current image must not restart repeatedly');
  const current=(await doObj.fetch(new Request(
    'https://internal.lumex/__container-image-status'))).json();
  assert.equal((await current).image_matches_current,true);
}
{
  const x=makeContainer('sha256:cloudflare-binance-v2',false);
  const doObj=new ResearchContainer(x.ctx,x.env);
  const res=await doObj.fetch(new Request('https://internal.lumex/binance-egress-probe',{
    method:'POST',body:'{}'}));
  assert.equal(res.status,503);
  assert.equal((await res.json()).error_code,'container_image_contract_mismatch');
  assert.equal(x.stats().posts,0,'incompatible container must not receive Binance probe');
  assert.equal(x.stats().destroyed,0);
}
{
  const x=makeContainer('sha256:old');
  const doObj=new ResearchContainer(x.ctx,x.env);
  const res=await doObj.fetch(new Request('https://internal.lumex/fetch',{
    method:'POST',body:'{}'}));
  assert.equal(res.status,200);
  assert.equal(x.stats().destroyed,0,'unrelated market fetch must not rotate image');
}
{
  const x=makeContainer('sha256:old');
  const env={RESEARCH_CONTAINER:{getByName:()=>({fetch:async url=>{
    assert.equal(url,'https://internal.lumex/__container-image-status');
    return new Response(JSON.stringify({ok:true,container_running:true,
      image_matches_current:false,image_starting:false}),{status:200});
  }})}};
  const res=await worker.fetch(new Request('https://worker/market-hub/v1/binance-container-image-health'),env);
  assert.equal(res.status,200);
  const data=await res.json();
  assert.equal(data.image_matches_current,false);
  assert.equal(data.container_running,true);
}
console.log('PASS Phase10 Durable Object image digests, one-time rotation, health contract and unaffected research');
