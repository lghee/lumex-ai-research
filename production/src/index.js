/** LUMEX full stack candidate (opt-in ONLY): Workers + DO Containers + R2 + Queues.
 * Research-only. Does not submit orders. Not production-tested on user's Cloudflare.
 */
import {DurableObject} from 'cloudflare:workers';
const PORT=8080;
const headers={"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"};
const resp=(body,status=200)=>new Response(JSON.stringify(body),{status,headers});
const allowedSymbols=new Set(['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT']);
const allowedIntervals=new Set([5,15,60]);
const marketKey=(sym,t)=>`market/${sym}_${t}.csv`;
function auth(request,secret){return Boolean(secret&&secret.length>=32&&request.headers.get('authorization')===`Bearer ${secret}`);}
function enabled(env,k){return env[k]==='true';}
async function callWP(env,endpoint,method='GET',body){
  if(!env.LUMEX_AI_LAB_WORKER_TOKEN||env.LUMEX_AI_LAB_WORKER_TOKEN.length<48)throw Error('research_token_not_configured');
  const u=`https://lumexbot.com/wp-json/lumex/v1/research-lab/${endpoint}`;
  const r=await fetch(u,{method,headers:{'Authorization':`Bearer ${env.LUMEX_AI_LAB_WORKER_TOKEN}`,'Content-Type':'application/json','Accept':'application/json'},body:method==='POST'?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw Error(`wordpress_${endpoint}_${r.status}`);
  return r.json();
}
async function invokeContainer(env,pathname,payload){
 const stub=env.RESEARCH_CONTAINER.getByName('primary-research');
 const res=await stub.fetch('https://internal.lumex'+pathname,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
 if(!res.ok)throw Error('container_'+pathname+'_'+res.status);
 return res;
}
async function fetchPair(env,sym,interval){
 if(!allowedSymbols.has(sym)||!allowedIntervals.has(interval))throw Error('selection_not_supported');
 const r=await invokeContainer(env,'/fetch',{symbol:sym,interval_min:interval});
 // No cache is replaced until validated response completes.
 const bytes=await r.arrayBuffer();
 if(bytes.byteLength<20000||bytes.byteLength>12000000)throw Error('market_data_size_invalid');
 const key=marketKey(sym,interval);
 await env.MARKET_DATA.put(key,bytes,{httpMetadata:{contentType:'text/csv'},customMetadata:{source:'bybit_linear_public',timestamp:new Date().toISOString()}});
 return {saved:key,bytes:bytes.byteLength};
}
async function runJobs(env){
 const response=await callWP(env,'jobs?limit=10');
 const jobs=Array.isArray(response.jobs)?response.jobs:[];
 if(!jobs.length)return {processed:0};
 const groups=new Map();for(const j of jobs){const k=`${j.symbol}_${j.interval_min}`;if(!groups.has(k))groups.set(k,[]);groups.get(k).push(j);}
 let processed=0;
 for(const [k,group] of groups){
  const sym=group[0].symbol,interval=Number(group[0].interval_min);
  let reports=[];
  try{
   if(!allowedSymbols.has(sym)||!allowedIntervals.has(interval))throw Error('unsupported_market');
   const obj=await env.MARKET_DATA.get(marketKey(sym,interval));
   if(!obj)throw Error('r2_market_not_found');
   if(obj.size>12000000)throw Error('market_too_large');
   const csv=await obj.text();
   const rr=await invokeContainer(env,'/evaluate',{csv,jobs:group,interval_min:interval});
   const data=await rr.json();if(!Array.isArray(data.reports))throw Error('invalid_container_result');
   reports=data.reports;
  }catch(error){
   reports=group.map(j=>({id:j.id,job_hash:j.job_hash,claim_token:j.claim_token,error:true,error_code:String(error.message||'data_unavailable').replace(/[^a-z0-9_]/gi,'_').slice(0,70),source:'cloudflare_research_validation'}));
  }
  for(const report of reports){await callWP(env,'results','POST',report);processed++;}
 }
 return {processed};
}
async function processJob(env,job){
 if(job.kind==='fetch'){
   if(!enabled(env,'AUTO_FETCH'))return {skipped:'auto_fetch_off'};
   return fetchPair(env,job.symbol,Number(job.interval_min));
 }
 if(job.kind==='research'){
   if(!enabled(env,'AUTO_RESEARCH'))return {skipped:'auto_research_off'};
   await callWP(env,'tick','POST',{});
   return runJobs(env);
 }
 if(job.kind==='ai'){
   if(!enabled(env,'AUTO_AI'))return {skipped:'auto_ai_off'};
   const res=await invokeContainer(env,'/ai',{symbol:job.symbol||'BTCUSDT',interval_min:15});
   return res.json();
 }
 throw Error('unknown_action');
}
export class ResearchContainer extends DurableObject{
  constructor(ctx,env){super(ctx,env);this.starting=null;}
  async fetch(request){
   const container=this.ctx.container;
   if(!container)throw Error('container_binding_missing');
   this.starting??=this.startAndReady().finally(()=>{this.starting=null;});
   await this.starting;
   const url=new URL(request.url);url.protocol='http:';url.host='container';
   const headers=new Headers(request.headers);
   headers.delete('host');headers.set('X-Lumex-Internal-Key',this.env.LUMEX_CONTAINER_KEY||'');
   const forwarded=new Request(url,{method:request.method,headers,body:request.body});
   return container.getTcpPort(PORT).fetch(forwarded);
  }
  async startAndReady(){
   const container=this.ctx.container;
   if(!container.running){
    container.start({image:container.images.base,instance:'lite',enableInternet:true,env:{
      LUMEX_SITE_URL:'https://lumexbot.com',
      LUMEX_AI_LAB_WORKER_TOKEN:this.env.LUMEX_AI_LAB_WORKER_TOKEN||'',
      OPENAI_API_KEY:this.env.OPENAI_API_KEY||'',
      LUMEX_CONTAINER_KEY:this.env.LUMEX_CONTAINER_KEY||'',
    }});
   }
   await container.setInactivityTimeout(120000);
   const port=container.getTcpPort(PORT);
   for(let i=0;i<75;i++){
    try{const r=await port.fetch('http://container/health',{signal:AbortSignal.timeout(1000)});await r.body?.cancel();if(r.ok)return;}catch{}
    await scheduler.wait(250);
   }
   throw Error('container_start_timeout');
  }
}
export default{
 async fetch(request,env){
  const u=new URL(request.url);
  if(u.pathname==='/health'&&request.method==='GET')return resp({ok:true,service:'LUMEX Research',mode:'production_candidate',auto_research:enabled(env,'AUTO_RESEARCH'),auto_fetch:enabled(env,'AUTO_FETCH'),auto_ai:enabled(env,'AUTO_AI'),trading_enabled:false});
  if(!auth(request,env.LUMEX_ADMIN_API_TOKEN))return resp({ok:false,error:'unauthorized'},401);
  if(u.pathname==='/status'&&request.method==='GET'){
    const out={ok:true,auto_research:enabled(env,'AUTO_RESEARCH'),auto_fetch:enabled(env,'AUTO_FETCH'),auto_ai:enabled(env,'AUTO_AI'),trading_enabled:false};
    try{out.core=await callWP(env,'status');}catch(e){out.core_error=String(e.message).slice(0,120);}
    return resp(out);
  }
  if(u.pathname==='/enqueue'&&request.method==='POST'){
    let job;try{job=await request.json();}catch{return resp({ok:false,error:'bad_json'},400);}
    if(!['fetch','research','ai'].includes(job?.kind))return resp({ok:false,error:'bad_kind'},400);
    if(job.kind==='fetch'&&(!allowedSymbols.has(job.symbol)||!allowedIntervals.has(Number(job.interval_min))))return resp({ok:false,error:'bad_market'},400);
    if(job.kind==='ai'&&!allowedSymbols.has(job.symbol))return resp({ok:false,error:'bad_symbol'},400);
    await env.RESEARCH_QUEUE.send({kind:job.kind,symbol:job.symbol||null,interval_min:Number(job.interval_min||0)});
    return resp({ok:true,queued:true,kind:job.kind},202);
  }
  return resp({ok:false,error:'not_found'},404);
 },
 async scheduled(controller,env,ctx){
  // Disabled by default; avoid unintentional spending.
  if(!enabled(env,'AUTO_RESEARCH'))return;
  ctx.waitUntil(env.RESEARCH_QUEUE.send({kind:'research'}));
 },
 async queue(batch,env){
  for(const message of batch.messages){
   try{await processJob(env,message.body);message.ack();}
   catch(error){console.error('research-queue-error',String(error.message).slice(0,120));message.retry({delaySeconds:90});}
  }
 }
};
