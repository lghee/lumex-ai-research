/** LUMEX research-only regime lab: Cloudflare cron -> authenticated Container -> private R2.
 * Status is restricted to the existing WordPress worker token. No order routes.
 */
const ROOT='research/regime-meta/v1/';
const SCHEMA='lumex_regime_meta_research_v1';
const json=(d,status=200)=>new Response(JSON.stringify(d),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});
const safe=x=>String(x?.message||x||'unknown').replace(/[^a-z0-9_-]/gi,'_').slice(0,80);
const dayOf=now=>new Date(now).toISOString().slice(0,10);
const hourUtc=now=>new Date(now).getUTCHours();
async function read(bucket,key){try{const x=await bucket.get(ROOT+key);return x?await x.json():null}catch{return null}}
async function save(bucket,key,data){await bucket.put(ROOT+key,JSON.stringify(data),{httpMetadata:{contentType:'application/json'}})}
export async function scheduledRegimeResearch(env,now=Date.now()){
 if(!env.MARKET_DATA||!env.RESEARCH_CONTAINER||typeof env.LUMEX_CONTAINER_KEY!=='string'||env.LUMEX_CONTAINER_KEY.length<32)
   return {ok:false,reason:'research_bindings_missing'};
 if(hourUtc(now)<4)return {ok:true,skipped:'before_daily_research_window'};
 const today=dayOf(now);
 const last=await read(env.MARKET_DATA,'latest.json');
 if(last?.research_day_utc===today)return {ok:true,skipped:'already_completed'};
 const attempt=await read(env.MARKET_DATA,'attempt.json');
 if(attempt?.day===today&&now-attempt.at_ms>=0&&now-attempt.at_ms<5400000)
   return {ok:true,skipped:'cooldown'};
 await save(env.MARKET_DATA,'attempt.json',{day:today,at_ms:now,state:'starting'});
 try{
  const stub=env.RESEARCH_CONTAINER.getByName('primary-research');
  const resp=await stub.fetch('https://internal.lumex/regime-research',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'daily_research_only'})});
  if(!resp.ok)throw Error('container_http_'+resp.status);
  const raw=await resp.text();if(raw.length>85000||raw.length<100)throw Error('container_payload_limit');
  const result=JSON.parse(raw);
  if(result?.ok!==true||result.schema!==SCHEMA||result.live_approved!==false||result.order_execution!==false||
     !/^[a-f0-9]{64}$/.test(String(result.data_sha256||''))||
     !Number.isSafeInteger(result.aligned_bars_per_symbol)||result.aligned_bars_per_symbol<2400||
     result.promotion!=='PROHIBITED_UNTIL_INDEPENDENT_FORWARD_AND_ADMIN_APPROVAL')throw Error('unverified_research_schema');
  const saved={...result,research_day_utc:today,stored_ms:now,storage:'cloudflare_r2_research_only'};
  await save(env.MARKET_DATA,'history/'+today+'.json',saved);
  await save(env.MARKET_DATA,'latest.json',saved);
  await save(env.MARKET_DATA,'attempt.json',{day:today,at_ms:now,state:'completed'});
  return {ok:true,day:today,retrospective_gate_passed:saved.retrospective_gate_passed,live_approved:false};
 }catch(error){
  const reason=safe(error);
  await save(env.MARKET_DATA,'attempt.json',{day:today,at_ms:now,state:'failed',reason}).catch(()=>{});
  return {ok:false,reason,old_result_preserved:true};
 }
}
export async function privateRegimeReport(request,env){
 if(request.method!=='GET')return json({ok:false,error:'method_not_allowed'},405);
 const expected=env.LUMEX_AI_LAB_WORKER_TOKEN;
 if(typeof expected!=='string'||expected.length<48)return json({ok:false,error:'research_access_not_configured'},503);
 const provided=request.headers.get('authorization')||'';
 if(!provided.startsWith('Bearer ')||provided.length>256)return json({ok:false,error:'unauthorized'},401);
 const parts=await Promise.all([provided.slice(7),expected].map(async x=>
   new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(x)))));
 let diff=0;for(let i=0;i<32;i++)diff|=parts[0][i]^parts[1][i];
 if(diff!==0)return json({ok:false,error:'unauthorized'},401);
 if(!env.MARKET_DATA)return json({ok:false,error:'r2_unavailable'},503);
 const result=await read(env.MARKET_DATA,'latest.json');
 const attempt=await read(env.MARKET_DATA,'attempt.json');
 if(!result)return json({ok:true,status:'collecting',latest:null,attempt:attempt||null});
 if(result.schema!==SCHEMA||result.live_approved!==false)return json({ok:false,error:'invalid_saved_report'},503);
 const age=Math.max(0,Date.now()-Number(result.stored_ms||0));
 return json({ok:true,status:age>72*3600000?'stale':'ready',age_seconds:Math.floor(age/1000),latest:result,attempt:attempt||null});
}