/** LUMEX AI Research 1.1.3 — autonomous research-only scheduler.
 * The ONLY external side effects are public market reads, private R2 writes,
 * bounded OpenAI hypothesis calls and authenticated research-lab REST calls.
 * No exchange credentials, trading endpoints or customer portfolios.
 */
import { DurableObject } from 'cloudflare:workers';

const PORT = 8080;
const SYMBOLS = Object.freeze(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT']);
const INTERVALS = Object.freeze([5, 15, 60]);
const MARKETS = SYMBOLS.flatMap(symbol => INTERVALS.map(interval_min => ({symbol, interval_min})));
const HEADERS = {'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', 'x-content-type-options':'nosniff'};
const CONTROL_KEY = 'control/research-scheduler-v1.json';
const FETCH_DIAGNOSTIC_KEY = 'control/last-market-fetch.json';
const MAX_CSV_BYTES = 12_000_000;
const respond = (value,status=200) => new Response(JSON.stringify(value),{status,headers:HEADERS});
const enabled = (env,key) => env[key] === 'true';
const marketId = (sym,interval) => `${sym}:${interval}`;
const marketKey = (sym,interval) => `market/${sym}_${interval}.csv`;
const validMarket = (sym,interval) => SYMBOLS.includes(sym) && INTERVALS.includes(Number(interval));
const safeError = error => String(error?.message || error || 'unknown_error').replace(/[^a-z0-9_\-]/gi,'_').slice(0,160);
const auth = (request,secret) => Boolean(secret && secret.length >= 32 && request.headers.get('authorization') === `Bearer ${secret}`);
const fetchLimit = env => Math.min(2,Math.max(1,Number(env.MAX_FETCH_PER_TICK)||1));
const jobLimit = env => Math.min(24,Math.max(1,Number(env.RESEARCH_BATCH_SIZE)||12));
const isFresh = (head,interval,now) => {
  const last = Number(head?.customMetadata?.lastCandleMs || 0);
  return Boolean(head && head.size>=20000 && last>0 && last<=now && now-last<=Math.max(3600000,interval*180000));
};
const dueForFetch = (head,interval,now) => {
  if (!head || !isFresh(head,interval,now)) return true;
  const fetched = Number(head.customMetadata?.fetchedAtMs || 0);
  return !fetched || now-fetched >= interval*60000*(interval===5 ? 2 : 1);
};

async function callWP(env,endpoint,method='GET',body){
  if (!env.LUMEX_AI_LAB_WORKER_TOKEN || env.LUMEX_AI_LAB_WORKER_TOKEN.length<48) throw Error('research_token_not_configured');
  const base = env.LUMEX_SITE_URL || 'https://lumexbot.com';
  if (base !== 'https://lumexbot.com') throw Error('wordpress_origin_not_allowlisted');
  const url = `${base}/wp-json/lumex/v1/research-lab/${endpoint}`;
  const r = await fetch(url,{method,headers:{'authorization':`Bearer ${env.LUMEX_AI_LAB_WORKER_TOKEN}`,'content-type':'application/json','accept':'application/json'},body:method==='POST'?JSON.stringify(body||{}):undefined,signal:AbortSignal.timeout(20000)});
  if(!r.ok) throw Error(`wordpress_${endpoint.split('?')[0]}_${r.status}`);
  const value=await r.json();
  if(value?.ok===false) throw Error(`wordpress_${endpoint.split('?')[0]}_${safeError(value.state||value.error)}`);
  return value;
}
async function invokeContainer(env,path,payload){
  if(!env.LUMEX_CONTAINER_KEY || env.LUMEX_CONTAINER_KEY.length<32)throw Error('container_key_not_configured');
  const stub=env.RESEARCH_CONTAINER.getByName('primary-research');
  const res=await stub.fetch('https://internal.lumex'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
  if(!res.ok){
    let code='';try{const v=await res.json();code=safeError(v.detail||v.error_code||'');}catch{}
    throw Error(`container_${path.slice(1)}_${res.status}_${code}`);
  }
  return res;
}
async function writeFetchDiagnostic(env,sym,interval,detail){
  const info={market:marketId(sym,interval),timestamp:new Date().toISOString(),...detail};
  // Private R2 control file. No keys, tokens or raw provider payloads.
  try{
    const body=JSON.stringify(info);
    const options={httpMetadata:{contentType:'application/json'}};
    await env.MARKET_DATA.put(FETCH_DIAGNOSTIC_KEY,body,options);
    await env.MARKET_DATA.put(`control/fetch-${sym}-${interval}.json`,body,options);
  }catch(e){console.error('fetch_diagnostic_write_failed',safeError(e));}
}
async function fetchPair(env,sym,interval){
  if(!validMarket(sym,interval))throw Error('selection_not_supported');
  try{
  const key=marketKey(sym,interval);
  const old=await env.MARKET_DATA.get(key);
  const prior=old && old.size<MAX_CSV_BYTES ? await old.text() : '';
  const existingSource=old?.customMetadata?.source || (old?'bybit_public_linear':'');
  const response=await invokeContainer(env,'/fetch',{symbol:sym,interval_min:interval,existing_csv:prior,existing_source:existingSource});
  const source=response.headers.get('X-Lumex-Market-Source');
  if(!['bybit_public_linear','binance_usdm_perpetual','gateio_usdt_perpetual'].includes(source))throw Error('market_source_unverified');
  const bytes=await response.arrayBuffer();
  if(bytes.byteLength<20000 || bytes.byteLength>MAX_CSV_BYTES)throw Error('market_data_size_invalid');
  const csv=new TextDecoder().decode(bytes);
  const last=csv.trimEnd().split('\n').at(-1);
  const lastCandleMs=Number(last?.split(',')[0]);
  const now=Date.now();
  if(!Number.isSafeInteger(lastCandleMs) || lastCandleMs<=0 || lastCandleMs>now || now-lastCandleMs>Math.max(3600000,interval*180000))throw Error('fetched_market_stale_or_invalid');
  // The Container validated every candle, chronological continuity and minimum history.
  // Do not overwrite an existing R2 object when this validation fails.
  await env.MARKET_DATA.put(key,bytes,{httpMetadata:{contentType:'text/csv'},customMetadata:{source,lastCandleMs:String(lastCandleMs),fetchedAtMs:String(now),schema:'ohlcv_v1'}});
  await writeFetchDiagnostic(env,sym,interval,{ok:true,source,bytes:bytes.byteLength,lastCandleMs});
  return {market:marketId(sym,interval),source,bytes:bytes.byteLength,lastCandleMs};
  }catch(error){
    await writeFetchDiagnostic(env,sym,interval,{ok:false,error:safeError(error)});
    throw error;
  }
}
async function getMarketInventory(env,now){
  const result=[];
  for(const p of MARKETS){
    const head=await env.MARKET_DATA.head(marketKey(p.symbol,p.interval_min));
    result.push({...p,head,ready:isFresh(head,p.interval_min,now),due:dueForFetch(head,p.interval_min,now)});
  }
  return result;
}
async function readScheduler(env){
  const stored=await env.MARKET_DATA.get(CONTROL_KEY);
  if(!stored)return {lastRun:0,fetchAttempts:{},aiAttempts:0,aiCursor:0,successes:0,failures:0,errors:[]};
  const parsed=await stored.json();
  return {...{lastRun:0,fetchAttempts:{},aiAttempts:0,aiCursor:0,successes:0,failures:0,errors:[]},...parsed};
}
async function writeScheduler(env,state){
  state.errors=(state.errors||[]).slice(-10);
  await env.MARKET_DATA.put(CONTROL_KEY,JSON.stringify(state),{httpMetadata:{contentType:'application/json'}});
}
async function releaseJobs(env,jobs,reason){
  for(const job of jobs){
    // Release a failed lease for retry instead of publishing an invalid backtest as 'insufficient'.
    try{await callWP(env,'release','POST',{id:job.id,job_hash:job.job_hash,claim_token:job.claim_token,error_code:safeError(reason)});}
    catch(e){console.error('release_failed',job.id,safeError(e));throw e;}
  }
}
async function runJobs(env,readyMarkets){
  if(!readyMarkets.length)return {processed:0,reason:'no_fresh_market_data'};
  const allowed=new Set(readyMarkets.map(p=>marketId(p.symbol,p.interval_min)));
  const markets=readyMarkets.map(p=>marketId(p.symbol,p.interval_min)).join(',');
  let processed=0,released=0;
  const maxBatches=Math.min(2,Math.max(1,Number(env.RESEARCH_BATCHES_PER_TICK)||2));
  for(let batch=0;batch<maxBatches;batch++){
    const received=await callWP(env,`jobs?limit=${jobLimit(env)}&markets=${encodeURIComponent(markets)}`);
    const jobs=Array.isArray(received.jobs)?received.jobs:[];
    if(!jobs.length)break;
    const groups=new Map();
    for(const j of jobs){
      const k=marketId(j.symbol,Number(j.interval_min));
      if(!allowed.has(k)){await releaseJobs(env,[j],'market_not_ready');released++;continue;}
      if(!groups.has(k))groups.set(k,[]);
      groups.get(k).push(j);
    }
    for(const [market,group] of groups){
      try{
        const [sym,intervalText]=market.split(':');const interval=Number(intervalText);
        const obj=await env.MARKET_DATA.get(marketKey(sym,interval));
        if(!obj || obj.size>MAX_CSV_BYTES)throw Error('r2_market_missing_or_large');
        const rr=await invokeContainer(env,'/evaluate',{csv:await obj.text(),jobs:group,interval_min:interval,market_source:obj.customMetadata?.source||'bybit_public_linear'});
        const data=await rr.json();
        if(!Array.isArray(data.reports) || data.reports.length!==group.length)throw Error('invalid_container_result');
        const byId=new Map(data.reports.map(x=>[Number(x.id),x]));
        for(const job of group){
          const report=byId.get(Number(job.id));
          if(!report || report.error || report.claim_token!==job.claim_token || report.job_hash!==job.job_hash){
            await releaseJobs(env,[job],safeError(report?.error_code||'invalid_evaluation'));
            released++;continue;
          }
          const result=await callWP(env,'results','POST',report);
          if(result.state==='already_recorded' || result.ok===true)processed++;
          else throw Error('wordpress_result_not_accepted');
        }
      }catch(error){
        // Avoid converting temporary data/container/network errors into false research results.
        const reason=safeError(error);console.error('research_market_error',market,reason);
        // releaseJobs is idempotent for already recorded jobs. Site checks lease token.
        for(const j of group){
          try{await releaseJobs(env,[j],reason);released++;}catch(e){console.error('research_release_error',j.id,safeError(e));}
        }
        if(reason.startsWith('wordpress_'))throw error;
      }
    }
    if(jobs.length<jobLimit(env))break;
  }
  return {processed,released};
}
async function orchestrate(env){
  const now=Date.now();const state=await readScheduler(env);
  const summary={kind:'orchestrate',market_fetches:[],research:null,ai:null,errors:[],timestamp:new Date(now).toISOString()};
  const active=enabled(env,'AUTO_FETCH')||enabled(env,'AUTO_RESEARCH')||enabled(env,'AUTO_AI');
  if(!active)return {...summary,skipped:'all_automation_disabled'};
  try{
    const inventory=await getMarketInventory(env,now);
    if(enabled(env,'AUTO_FETCH')){
      // Oldest attempt first: repeated API 403 on one pair never starves all other pairs.
      const due=inventory.filter(p=>p.due).sort((a,b)=>(Number(state.fetchAttempts?.[marketId(a.symbol,a.interval_min)]||0)-Number(state.fetchAttempts?.[marketId(b.symbol,b.interval_min)]||0)));
      for(const p of due.slice(0,fetchLimit(env))){
        const id=marketId(p.symbol,p.interval_min);
        state.fetchAttempts[id]=now;
        try{
          const result=await fetchPair(env,p.symbol,p.interval_min);
          summary.market_fetches.push({...result,ok:true});
          state.successes=(state.successes||0)+1;
        }catch(error){
          const reason=safeError(error);summary.market_fetches.push({market:id,ok:false,error:reason});
          summary.errors.push(`fetch_${id}_${reason}`);state.failures=(state.failures||0)+1;
          console.error('market_fetch_failure',id,reason);
        }
      }
    }
    if(enabled(env,'AUTO_RESEARCH')){
      const fresh=await getMarketInventory(env,Date.now());
      const ready=fresh.filter(x=>x.ready);
      summary.ready_markets=ready.length;
      if(ready.length){
        try{
          const tick=await callWP(env,'tick','POST',{});
          summary.tick={state:tick.state,enqueued:tick.enqueued||0,cursor:tick.cursor||0};
          if(tick.state!=='disabled')summary.research=await runJobs(env,ready);
        }catch(error){summary.errors.push(`research_${safeError(error)}`);console.error('research_orchestration_error',safeError(error));}
      }else summary.research={processed:0,reason:'no_fresh_market_data'};
    }
    // At most one AI request every six hours (or a 30-minute failure cooldown).
    if(enabled(env,'AUTO_AI') && env.OPENAI_API_KEY && now-Number(state.aiAttempts||0)>=(state.aiLastOk?6*3600000:30*60000)){
      const symbol=SYMBOLS[(Number(state.aiCursor)||0)%SYMBOLS.length];
      state.aiAttempts=now;state.aiCursor=(Number(state.aiCursor)||0)+1;
      try{
        const res=await invokeContainer(env,'/ai',{symbol,interval_min:15});
        const data=await res.json();
        if(!data.ok)throw Error(safeError(data.error||'ai_not_accepted'));
        summary.ai={symbol,accepted:Number(data.accepted||0),ok:true};state.aiLastOk=true;
      }catch(error){summary.ai={symbol,ok:false,error:safeError(error)};summary.errors.push(`ai_${safeError(error)}`);state.aiLastOk=false;}
    }
  }catch(error){summary.errors.push(`orchestrator_${safeError(error)}`);console.error('orchestrator_error',safeError(error));}
  state.lastRun=now;state.lastSummary=summary;state.errors.push(...summary.errors);
  await writeScheduler(env,state);
  // Optional site-side observability; a failing telemetry request must not lose completed research.
  if(env.LUMEX_AI_LAB_WORKER_TOKEN){
    try{await callWP(env,'telemetry','POST',{timestamp:Math.floor(now/1000),ready_markets:summary.ready_markets||0,summary:summary.research||{},fetches:summary.market_fetches,ai:summary.ai,errors:summary.errors});}
    catch(error){console.error('telemetry_failed',safeError(error));}
  }
  console.info('lumex_scheduler',JSON.stringify(summary));
  return summary;
}
async function processJob(env,job){
  if(!job || typeof job!=='object')throw Error('invalid_queue_message');
  if(job.kind==='orchestrate')return orchestrate(env);
  if(job.kind==='fetch'){
    if(!enabled(env,'AUTO_FETCH'))return {skipped:'auto_fetch_off'};
    return fetchPair(env,job.symbol,Number(job.interval_min));
  }
  if(job.kind==='research'){
    if(!enabled(env,'AUTO_RESEARCH'))return {skipped:'auto_research_off'};
    const ready=(await getMarketInventory(env,Date.now())).filter(x=>x.ready);
    if(!ready.length)return {processed:0,reason:'no_fresh_market_data'};
    const tick=await callWP(env,'tick','POST',{});
    return tick.state==='disabled'?{skipped:'wordpress_disabled'}:runJobs(env,ready);
  }
  if(job.kind==='ai'){
    if(!enabled(env,'AUTO_AI'))return {skipped:'auto_ai_off'};
    const res=await invokeContainer(env,'/ai',{symbol:job.symbol||'BTCUSDT',interval_min:Number(job.interval_min||15)});
    const data=await res.json();if(!data.ok)throw Error(safeError(data.error));return data;
  }
  throw Error('unknown_action');
}
export class ResearchContainer extends DurableObject{
  constructor(ctx,env){super(ctx,env);this.starting=null;
    if(ctx.container?.running)void ctx.blockConcurrencyWhile(()=>ctx.container.setInactivityTimeout(120000));
  }
  async fetch(request){
    const container=this.ctx.container;if(!container)throw Error('container_binding_missing');
    this.starting??=this.startAndReady().finally(()=>{this.starting=null;});await this.starting;
    const url=new URL(request.url);url.protocol='http:';url.host='container';
    const headers=new Headers(request.headers);headers.delete('host');headers.set('X-Lumex-Internal-Key',this.env.LUMEX_CONTAINER_KEY||'');
    const forwarded=new Request(url,{method:request.method,headers,body:request.body});
    return container.getTcpPort(PORT).fetch(forwarded);
  }
  async startAndReady(){
    const container=this.ctx.container;
    if(!container.running){container.start({image:container.images.base,instance:'lite',enableInternet:true,env:{
      LUMEX_SITE_URL:'https://lumexbot.com',LUMEX_AI_LAB_WORKER_TOKEN:this.env.LUMEX_AI_LAB_WORKER_TOKEN||'',
      OPENAI_API_KEY:this.env.OPENAI_API_KEY||'',LUMEX_CONTAINER_KEY:this.env.LUMEX_CONTAINER_KEY||''
    }});}
    await container.setInactivityTimeout(120000);
    const port=container.getTcpPort(PORT);
    for(let i=0;i<100;i++){
      try{const r=await port.fetch('http://container/health',{signal:AbortSignal.timeout(1000)});await r.body?.cancel();if(r.ok)return;}catch{}
      await scheduler.wait(300);
    }
    throw Error('container_start_timeout');
  }
}
export default{
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname==='/health' && request.method==='GET')return respond({ok:true,service:'LUMEX Research',version:'1.1.3',auto_research:enabled(env,'AUTO_RESEARCH'),auto_fetch:enabled(env,'AUTO_FETCH'),auto_ai:enabled(env,'AUTO_AI'),trading_enabled:false});
    if(!auth(request,env.LUMEX_ADMIN_API_TOKEN))return respond({ok:false,error:'unauthorized'},401);
    if(url.pathname==='/status' && request.method==='GET'){
      const out={ok:true,version:'1.1.3',auto_research:enabled(env,'AUTO_RESEARCH'),auto_fetch:enabled(env,'AUTO_FETCH'),auto_ai:enabled(env,'AUTO_AI'),trading_enabled:false,has_wordpress_token:Boolean(env.LUMEX_AI_LAB_WORKER_TOKEN),has_container_key:Boolean(env.LUMEX_CONTAINER_KEY),has_openai_key:Boolean(env.OPENAI_API_KEY)};
      try{const state=await readScheduler(env);out.scheduler={lastRun:state.lastRun,lastSummary:state.lastSummary,errors:state.errors};out.markets=(await getMarketInventory(env,Date.now())).map(({symbol,interval_min,head,ready})=>({symbol,interval_min,ready,lastCandleMs:Number(head?.customMetadata?.lastCandleMs||0),source:head?.customMetadata?.source||null,bytes:Number(head?.size||0)}));}catch(e){out.storage_error=safeError(e);}
      try{out.core=await callWP(env,'status');}catch(e){out.core_error=safeError(e);}
      return respond(out);
    }
    if(url.pathname==='/enqueue' && request.method==='POST'){
      let job;try{job=await request.json();}catch{return respond({ok:false,error:'bad_json'},400);}
      if(!['fetch','research','ai','orchestrate'].includes(job?.kind))return respond({ok:false,error:'bad_kind'},400);
      if(job.kind==='fetch'&&!validMarket(job.symbol,job.interval_min))return respond({ok:false,error:'bad_market'},400);
      if(job.kind==='ai' && !validMarket(job.symbol,Number(job.interval_min||15)))return respond({ok:false,error:'bad_market'},400);
      await env.RESEARCH_QUEUE.send({kind:job.kind,symbol:job.symbol||null,interval_min:Number(job.interval_min||0)});
      return respond({ok:true,queued:true,kind:job.kind},202);
    }
    return respond({ok:false,error:'not_found'},404);
  },
  async scheduled(controller,env,ctx){
    if(!enabled(env,'AUTO_RESEARCH') && !enabled(env,'AUTO_FETCH') && !enabled(env,'AUTO_AI')){
      console.info('lumex_scheduler_disabled');return;
    }
    ctx.waitUntil(env.RESEARCH_QUEUE.send({kind:'orchestrate'}));
  },
  async queue(batch,env){
    for(const message of batch.messages){
      try{const result=await processJob(env,message.body);console.info('lumex_queue_result',JSON.stringify({kind:message.body?.kind,result}));message.ack();}
      catch(error){const reason=safeError(error);console.error('lumex_queue_error',reason);message.retry({delaySeconds:Math.min(600,60*(Number(message.attempts)||1))});}
    }
  }
};
