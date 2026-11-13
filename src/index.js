/** LUMEX AI Research 1.1.7 — autonomous research-only scheduler.
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
const QUALITY_SCHEMA = 'ohlcv_v2';
const MIN_CANDLES = interval => Math.ceil(90*1440/interval)+250;
const MIN_INGEST_CANDLES = interval => Math.ceil((interval===5?14:90)*1440/interval)+250;
// Worker-side independent validation. Container output is untrusted input;
// R2 v1 data is not eligible for research until revalidated/replaced.
function inspectCsv(text, interval, now=Date.now()){
  const lines=text.trimEnd().split(/\r?\n/);
  if(lines[0]!=='timestamp,open,high,low,close,volume')throw Error('market_csv_header_invalid');
  if(lines.length-1<MIN_INGEST_CANDLES(interval))throw Error('market_insufficient_history');
  const step=interval*60000;const currentOpen=Math.floor(now/step)*step;
  let prior=-1,first=0,last=0;
  for(let i=1;i<lines.length;i++){
    const fields=lines[i].split(',');
    if(fields.length!==6)throw Error('market_csv_row_invalid');
    const v=fields.map(Number);
    const [ts,o,h,l,c,vol]=v;
    if(!v.every(Number.isFinite)||!Number.isSafeInteger(ts)||ts<=0||ts%step||
       o<=0||l<=0||c<=0||vol<0||h<Math.max(o,l,c)||l>Math.min(o,c))throw Error('market_ohlcv_invalid');
    if(vol===0&&o===h&&h===l&&l===c)throw Error('market_unverified_zero_flat_candle');
    if(prior>=0&&ts-prior!==step)throw Error('market_gap_or_duplicate');
    if(ts>=currentOpen)throw Error('market_unfinished_candle');
    if(i===1)first=ts;
    last=ts;prior=ts;
  }
  if(last>now||now-last>Math.max(3600000,interval*180000))throw Error('market_stale');
  return {rows:lines.length-1,firstCandleMs:first,lastCandleMs:last,quality:(lines.length-1>=MIN_CANDLES(interval)?'verified':'collecting')};
}
function auditCrossFrame(newCsv,otherCsv,newInterval,otherInterval){
  // Only compare Gate/Binance/Bybit candles WITHIN the SAME named provider.
  // A full hour needs four 15m bars. Small rounding differences are tolerated;
  // material price/volume disagreements quarantine the new candidate.
  const csv15=newInterval===15?newCsv:otherCsv;
  const csv60=newInterval===60?newCsv:otherCsv;
  const quarter=new Map();
  for(const line of csv15.trimEnd().split(/\r?\n/).slice(1)){
    const [ts,o,h,l,c,v]=line.split(',').map(Number);
    const hour=Math.floor(ts/3600000)*3600000;
    if(!quarter.has(hour))quarter.set(hour,[]);
    quarter.get(hour).push([ts,o,h,l,c,v]);
  }
  let matched=0;
  for(const line of csv60.trimEnd().split(/\r?\n/).slice(1)){
    const [ts,o,h,l,c,v]=line.split(',').map(Number);
    const bars=quarter.get(ts);
    if(!bars||bars.length!==4||bars[0][0]!==ts||bars[3][0]!==ts+2700000)continue;
    matched++;
    const aggregated=[bars[0][1],Math.max(...bars.map(a=>a[2])),Math.min(...bars.map(a=>a[3])),bars[3][4],bars.reduce((s,a)=>s+a[5],0)];
    const expected=[o,h,l,c,v];
    if(aggregated.some((x,j)=>Math.abs(x-expected[j])>(j===4?Math.max(1,expected[j]*0.03):Math.max(0.5,expected[j]*0.0005)))){
      throw Error('cross_frame_15m_60m_mismatch_'+ts);
    }
  }
  // Only enforce if sufficient overlap exists to be meaningful.
  if(matched<24*7)throw Error('cross_frame_insufficient_overlap');
  return matched;
}
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
  return Boolean(head && head.customMetadata?.schema===QUALITY_SCHEMA && head.customMetadata?.quality==='verified' &&
    Number(head.customMetadata?.rows||0)>=MIN_CANDLES(interval) &&
    head.size>=20000 && last>0 && last<=now && now-last<=Math.max(3600000,interval*180000));
};
const dueForFetch = (head,interval,now) => {
  if (!head) return true;
  const fetched = Number(head.customMetadata?.fetchedAtMs || 0);
  // A 5m collecting-only cache is refreshed once a closed candle can exist;
  // never mark it research-ready until the full 90d plus warm-up is available.
  if (interval===5 && head.customMetadata?.quality==='collecting')
    return !fetched || now-fetched >= 5*60000;
  if (!isFresh(head,interval,now)) return !fetched || now-fetched >= 5*60000;
  return !fetched || now-fetched >= interval*60000;
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
  const now=Date.now();
  const audit=inspectCsv(csv,interval,now);
  // 15m and 1h same-provider series must not have material disagreement.
  if(interval===15||interval===60){
    const other=interval===15?60:15;
    const sibling=await env.MARKET_DATA.get(marketKey(sym,other));
    if(sibling && sibling.size<=MAX_CSV_BYTES && sibling.customMetadata?.source===source &&
       sibling.customMetadata?.schema===QUALITY_SCHEMA && sibling.customMetadata?.quality==='verified'){
      auditCrossFrame(csv,await sibling.text(),interval,other);
    }
  }
  // Only validated and (when possible) cross-checked data may replace R2.
  await env.MARKET_DATA.put(key,bytes,{httpMetadata:{contentType:'text/csv'},customMetadata:{source,
    lastCandleMs:String(audit.lastCandleMs),firstCandleMs:String(audit.firstCandleMs),
    rows:String(audit.rows),quality:audit.quality,fetchedAtMs:String(now),schema:QUALITY_SCHEMA}});
  await writeFetchDiagnostic(env,sym,interval,{ok:true,source,bytes:bytes.byteLength,
    lastCandleMs:audit.lastCandleMs,firstCandleMs:audit.firstCandleMs,rows:audit.rows,quality:audit.quality});
  return {market:marketId(sym,interval),source,bytes:bytes.byteLength,lastCandleMs:audit.lastCandleMs,rows:audit.rows,quality:audit.quality};
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
// Safe paper-forward bridge: only candidate_review strategies, verified closed bars,
// authenticated WP observation journal. Never writes the public signal ledger.
async function runForward(env,readyMarkets){
  const eligible=readyMarkets.filter(p=>p.interval_min===15||p.interval_min===60);
  if(!eligible.length)return {candidates:0,recorded:0,reason:'no_verified_forward_market'};
  const pairs=eligible.map(p=>marketId(p.symbol,p.interval_min)).join(',');
  const response=await callWP(env,`forward/jobs?markets=${encodeURIComponent(pairs)}`);
  const jobs=Array.isArray(response.jobs)?response.jobs.slice(0,8):[];
  if(!jobs.length)return {candidates:0,recorded:0,reason:'no_candidate_review_strategy'};
  let recorded=0,seen=0;
  const groups=new Map();
  const allowed=new Set(eligible.map(p=>marketId(p.symbol,p.interval_min)));
  for(const job of jobs){
    const key=marketId(job.symbol,Number(job.interval_min));
    if(!allowed.has(key))continue;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(job);
  }
  for(const [market,group] of groups){
    const [symbol,frame]=market.split(':');const interval=Number(frame);
    const csv=await env.MARKET_DATA.get(marketKey(symbol,interval));
    if(!csv||csv.size>MAX_CSV_BYTES)continue;
    const rr=await invokeContainer(env,'/observe',{csv:await csv.text(),jobs:group,interval_min:interval,
      market_source:csv.customMetadata?.source||''});
    const data=await rr.json();
    if(!Array.isArray(data.reports))throw Error('invalid_paper_observation_result');
    const mapped=new Map(data.reports.map(r=>[Number(r.id),r]));
    for(const job of group){
      const evidence=mapped.get(Number(job.id));
      if(!evidence || evidence.error || evidence.job_hash!==job.job_hash)continue;
      seen++;
      const result=await callWP(env,'forward/records','POST',evidence);
      if(result.ok===true && result.state==='paper_observation_recorded')recorded++;
    }
  }
  return {candidates:jobs.length,seen,recorded,mode:'paper_only'};
}

async function orchestrate(env,fetchOnly=false){
  const now=Date.now();const state=await readScheduler(env);
  const summary={kind:'orchestrate',market_fetches:[],research:null,forward:null,ai:null,errors:[],timestamp:new Date(now).toISOString()};
  const active=enabled(env,'AUTO_FETCH')||(!fetchOnly&&(enabled(env,'AUTO_RESEARCH')||enabled(env,'AUTO_AI')));
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
    const fresh=await getMarketInventory(env,Date.now());
    const ready=fresh.filter(x=>x.ready);
    summary.ready_markets=ready.length;
    if(!fetchOnly)summary.markets=fresh.map(x=>({symbol:x.symbol,interval_min:x.interval_min,
      quality:x.head?.customMetadata?.quality||'absent',source:x.head?.customMetadata?.source||'',
      rows:Number(x.head?.customMetadata?.rows||0),
      firstCandleMs:Number(x.head?.customMetadata?.firstCandleMs||0),
      lastCandleMs:Number(x.head?.customMetadata?.lastCandleMs||0),
      fetchedAtMs:Number(x.head?.customMetadata?.fetchedAtMs||0),ready:x.ready}));
    if(!fetchOnly && enabled(env,'AUTO_RESEARCH')){
      if(ready.length){
        try{
          const tick=await callWP(env,'tick','POST',{});
          summary.tick={state:tick.state,enqueued:tick.enqueued||0,cursor:tick.cursor||0};
          if(tick.state!=='disabled')summary.research=await runJobs(env,ready);
        }catch(error){summary.errors.push(`research_${safeError(error)}`);console.error('research_orchestration_error',safeError(error));}
      }else summary.research={processed:0,reason:'no_fresh_market_data'};
    }
    if(!fetchOnly && enabled(env,'AUTO_RESEARCH') && ready.length){
      try{summary.forward=await runForward(env,ready);}
      catch(error){summary.forward={recorded:0,error:safeError(error)};
        summary.errors.push(`forward_${safeError(error)}`);console.error('forward_observation_error',safeError(error));}
    }
    // Never let an AI skip silently. Record explicit, non-secret, bounded states.
    // Only a verified, recently updated 15-minute R2 market is eligible for AI
    // research, and AI results are ALWAYS unapproved DSL hypotheses.
    if(!fetchOnly){
      if(!enabled(env,'AUTO_AI'))summary.ai={state:'disabled_in_cloudflare',ok:false};
      else if(!env.OPENAI_API_KEY)summary.ai={state:'openai_key_missing',ok:false};
      else {
        const ready15=ready.filter(p=>p.interval_min===15);
        if(!ready15.length)summary.ai={state:'no_verified_15m_market',ok:false};
        else if(now-Number(state.aiAttempts||0)<(state.aiLastOk?6*3600000:30*60000)){
          summary.ai={state:'cooldown',ok:false,nextAttemptAt:Number(state.aiAttempts||0)+(state.aiLastOk?6*3600000:30*60000),
            lastAttempt:state.aiLastExecution||null};
          if(state.aiLastExecution?.error)summary.ai.error=state.aiLastExecution.error;
        }else{
          const p=ready15[(Number(state.aiCursor)||0)%ready15.length];
          const symbol=p.symbol;
          state.aiAttempts=now;state.aiCursor=(Number(state.aiCursor)||0)+1;
          try{
            const res=await invokeContainer(env,'/ai',{symbol,interval_min:15});
            const data=await res.json();
            if(!data.ok)throw Error(safeError(data.error||'ai_not_accepted'));
            const accepted=Number(data.accepted||0);
            if(!Number.isSafeInteger(accepted)||accepted<1)throw Error('ai_zero_candidates_accepted');
            summary.ai={symbol,accepted,state:'completed',ok:true};state.aiLastOk=true;
          }catch(error){summary.ai={symbol,state:'failed',ok:false,error:safeError(error)};
            summary.errors.push(`ai_${safeError(error)}`);state.aiLastOk=false;}
          state.aiLastExecution={...summary.ai,attemptedAt:now};
        }
      }
      state.aiLastResult=summary.ai;
    }

  }catch(error){summary.errors.push(`orchestrator_${safeError(error)}`);console.error('orchestrator_error',safeError(error));}
  state.lastRun=now;state.lastSummary=summary;state.errors.push(...summary.errors);
  await writeScheduler(env,state);
  // Optional site-side observability; a failing telemetry request must not lose completed research.
  if(!fetchOnly && env.LUMEX_AI_LAB_WORKER_TOKEN){
    try{await callWP(env,'telemetry','POST',{timestamp:Math.floor(now/1000),ready_markets:summary.ready_markets||0,summary:summary.research||{},fetches:summary.market_fetches,markets:summary.markets||[],forward:summary.forward,ai:summary.ai,errors:summary.errors});}
    catch(error){console.error('telemetry_failed',safeError(error));}
  }
  console.info('lumex_scheduler',JSON.stringify(summary));
  return summary;
}
async function processJob(env,job){
  if(!job || typeof job!=='object')throw Error('invalid_queue_message');
  if(job.kind==='orchestrate')return orchestrate(env);
  if(job.kind==='market_tick')return enabled(env,'AUTO_FETCH')?orchestrate(env,true):{skipped:'auto_fetch_off'};
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
    if(url.pathname==='/health' && request.method==='GET')return respond({ok:true,service:'LUMEX Research',version:'1.1.7',auto_research:enabled(env,'AUTO_RESEARCH'),auto_fetch:enabled(env,'AUTO_FETCH'),auto_ai:enabled(env,'AUTO_AI'),trading_enabled:false});
    if(!auth(request,env.LUMEX_ADMIN_API_TOKEN))return respond({ok:false,error:'unauthorized'},401);
    if(url.pathname==='/status' && request.method==='GET'){
      const out={ok:true,version:'1.1.7',auto_research:enabled(env,'AUTO_RESEARCH'),auto_fetch:enabled(env,'AUTO_FETCH'),auto_ai:enabled(env,'AUTO_AI'),trading_enabled:false,has_wordpress_token:Boolean(env.LUMEX_AI_LAB_WORKER_TOKEN),has_container_key:Boolean(env.LUMEX_CONTAINER_KEY),has_openai_key:Boolean(env.OPENAI_API_KEY)};
      try{const state=await readScheduler(env);out.scheduler={lastRun:state.lastRun,lastSummary:state.lastSummary,aiLastResult:state.aiLastResult||null,errors:state.errors};out.markets=(await getMarketInventory(env,Date.now())).map(({symbol,interval_min,head,ready})=>({symbol,interval_min,ready,lastCandleMs:Number(head?.customMetadata?.lastCandleMs||0),source:head?.customMetadata?.source||null,quality:head?.customMetadata?.quality||'unverified',schema:head?.customMetadata?.schema||'unknown',rows:Number(head?.customMetadata?.rows||0),bytes:Number(head?.size||0)}));}catch(e){out.storage_error=safeError(e);}
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
    // Every-minute: market freshness only; every five minutes: bounded research + AI.
    // At overlapping minutes, the single queue consumer serializes the jobs.
    const kind=controller.cron==='* * * * *'?'market_tick':'orchestrate';
    ctx.waitUntil(env.RESEARCH_QUEUE.send({kind}));
  },
  async queue(batch,env){
    for(const message of batch.messages){
      try{const result=await processJob(env,message.body);console.info('lumex_queue_result',JSON.stringify({kind:message.body?.kind,result}));message.ack();}
      catch(error){const reason=safeError(error);console.error('lumex_queue_error',reason);message.retry({delaySeconds:Math.min(600,60*(Number(message.attempts)||1))});}
    }
  }
};
