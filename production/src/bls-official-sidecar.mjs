/** LUMEX BLS official news GitHub Actions OIDC sidecar.
 * The official Atom feeds are fetched by repository-controlled GitHub Actions
 * if Cloudflare egress is blocked by BLS. An OIDC-signed, pinned workflow can
 * send only verified public CPI & employment release headlines to private R2.
 * No WordPress credentials, no private market data and no trading endpoints.
 */
export const BLS_PREFIX='market-hub/official-news/bls-oidc/v1/';
const HEADLINE_PREFIX='market-hub/official-news/v1/';
const SOURCE={
  bls_cpi:{label:'미국 노동통계국 · 물가',kind:'inflation',pattern:/^\/news\.release\/archives\/cpi_\d{8}\.htm$/},
  bls_jobs:{label:'미국 노동통계국 · 고용',kind:'jobs',pattern:/^\/news\.release\/archives\/empsit_\d{8}\.htm$/}
};
const reply=(value,status=200)=>Response.json(value,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
export function parseVerifiedBlsSidecar(body,now=Date.now()){
  if(!body||typeof body!=='object'||Array.isArray(body)||
    body.schema!=='lumex_bls_official_atom_oidc_v1'||
    !/^\d{5,16}$/.test(String(body.run_id||''))||
    !Number.isSafeInteger(body.checked_ms)||body.checked_ms>now+60000||
    now-body.checked_ms>300000||
    !Array.isArray(body.feeds)||body.feeds.length!==2||
    !Array.isArray(body.items)||body.items.length>30||body.items.length<1)
      throw Error('bls_sidecar_schema_invalid');
  const feedIds=new Set();
  for(const f of body.feeds){
    if(!f||!Object.hasOwn(SOURCE,f.id)||feedIds.has(f.id)||
      !['verified','unavailable'].includes(f.status))throw Error('bls_feed_state_invalid');
    feedIds.add(f.id);
  }
  if(feedIds.size!==2)throw Error('bls_feed_coverage_missing');
  const out=[],urls=new Set();
  for(const row of body.items){
    if(!row||typeof row!=='object'||!Object.hasOwn(SOURCE,row.source_id)||
      typeof row.title!=='string'||row.title.length<9||row.title.length>230||
      /[<>\u0000-\u001f]/.test(row.title)||
      !Number.isSafeInteger(row.published_ms)||
      row.published_ms>now+3600000||row.published_ms<now-90*86400000)
      throw Error('bls_item_schema_invalid');
    let u;try{u=new URL(row.source_url)}catch{throw Error('bls_url_invalid')}
    const rule=SOURCE[row.source_id];
    if(u.protocol!=='https:'||u.hostname!=='www.bls.gov'||
       u.username||u.password||u.port||u.search||u.hash||!rule.pattern.test(u.pathname))
       throw Error('bls_official_url_unverified');
    if(urls.has(u.href))continue;
    urls.add(u.href);
    out.push({id:row.source_id+':'+u.href,source_id:row.source_id,agency:rule.label,
      kind:rule.kind,title_original:row.title,source_url:u.href,
      published_ms:row.published_ms,published_utc:new Date(row.published_ms).toISOString(),
      official_source_verified:true,
      description_ko:row.source_id==='bls_cpi'?'미국 물가 공식 발표입니다.':'미국 고용 공식 발표입니다.',
      notes:'미 노동통계국의 발표 제목과 게시 시각입니다. 이후 코인 가격 변동의 원인을 단정하지 않습니다.'});
  }
  if(!out.length)throw Error('bls_no_verified_articles');
  const successful=new Set(out.map(x=>x.source_id));
  for(const f of body.feeds)if(f.status==='verified'&&!successful.has(f.id))
    throw Error('bls_verified_source_without_articles');
  return {schema:body.schema,checked_ms:body.checked_ms,run_id:body.run_id,
    source:'github_oidc_official_bls_atom',items:out,
    feeds:body.feeds.map(f=>({id:f.id,agency:SOURCE[f.id].label,status:f.status==='verified'?'verified_via_github':'unavailable',
      items:out.filter(x=>x.source_id===f.id).length,checked_ms:body.checked_ms}))};
}
export async function loadBlsSidecar(bucket,now=Date.now()){
  const obj=await bucket.get(BLS_PREFIX+'latest.json').catch(()=>null);
  if(!obj)return null;
  const data=await obj.json().catch(()=>null);
  if(!data||data.schema!=='lumex_bls_official_atom_oidc_v1'||!Number.isSafeInteger(data.checked_ms)||
    now-data.checked_ms<0||now-data.checked_ms>36*3600000||!Array.isArray(data.items)||!Array.isArray(data.feeds))return null;
  return data;
}
export function mergeVerifiedBls(base,sidecar,now=Date.now()){
  if(!sidecar||!base||base.schema!=='lumex_public_official_news_v1'||
    !Array.isArray(base.items)||!Array.isArray(base.feeds))throw Error('merge_invalid_snapshot');
  const directVerified=new Set(base.feeds.filter(x=>x.status==='verified').map(x=>x.id));
  const fromSidecar=sidecar.items.filter(x=>x.official_source_verified===true &&
    (x.source_id==='bls_cpi'||x.source_id==='bls_jobs')&&!directVerified.has(x.source_id));
  const keep=base.items.filter(x=>!['bls_cpi','bls_jobs'].includes(x.source_id)||directVerified.has(x.source_id));
  const items=[...keep,...fromSidecar].sort((a,b)=>b.published_ms-a.published_ms).slice(0,48);
  const feeds=base.feeds.map(f=>{
    if(!['bls_cpi','bls_jobs'].includes(f.id))return f;
    const replacement=sidecar.feeds.find(x=>x.id===f.id);
    return f.status!=='verified'&&replacement?.status==='verified_via_github'?replacement:f;
  });
  return {...base,items,feeds,source:'official_us_agency_rss_plus_github_oidc',
    collected_ms:Math.max(base.collected_ms,now),collected_utc:new Date(now).toISOString(),
    coverage:{verified_feeds:feeds.filter(x=>['verified','verified_via_github'].includes(x.status)).length,
      attempted_feeds:4,all_sources_verified:feeds.every(x=>['verified','verified_via_github'].includes(x.status))},
    b_ls_sidecar_last_checked_ms:sidecar.checked_ms,
    no_news_inference:true,no_order_execution:true};
}
export async function ingestBlsOidc(request,env,verifyOidc,now=Date.now()){
  if(request.method!=='POST')return reply({ok:false,error:'method_not_allowed'},405);
  if(!env.MARKET_DATA)return reply({ok:false,error:'r2_unavailable'},503);
  const auth=request.headers.get('authorization')||'';
  if(!auth.startsWith('Bearer ')||auth.length>16000)return reply({ok:false,error:'unauthorized'},401);
  const claim=await verifyOidc(auth.slice(7),now);
  if(!claim)return reply({ok:false,error:'github_oidc_not_authorized'},401);
  const bytes=await request.text();
  if(bytes.length>36000)return reply({ok:false,error:'request_oversize'},413);
  let body;try{body=JSON.parse(bytes)}catch{return reply({ok:false,error:'bad_json'},400)}
  if(String(body?.run_id)!==claim.run_id)return reply({ok:false,error:'oidc_run_mismatch'},401);
  let clean;try{clean=parseVerifiedBlsSidecar(body,now)}catch(e){
    return reply({ok:false,error:String(e?.message||'bls_payload_invalid').slice(0,55)},400);
  }
  const bucket=env.MARKET_DATA;
  const existing=await loadBlsSidecar(bucket,now);
  if(existing&&existing.checked_ms>clean.checked_ms)
    return reply({ok:true,ignored:'older_replay',received:0});
  const day=new Date(now).toISOString().slice(0,10);
  try{
    await bucket.put(BLS_PREFIX+'runs/'+day+'/'+clean.run_id+'.json',JSON.stringify(clean),
      {httpMetadata:{contentType:'application/json'}});
    await bucket.put(BLS_PREFIX+'latest.json',JSON.stringify(clean),
      {httpMetadata:{contentType:'application/json'}});
    const main=await bucket.get(HEADLINE_PREFIX+'latest.json');
    if(main){
      const old=await main.json();
      if(old?.schema==='lumex_public_official_news_v1'){
        const combined=mergeVerifiedBls(old,clean,now);
        await bucket.put(HEADLINE_PREFIX+'latest.json',JSON.stringify(combined),
          {httpMetadata:{contentType:'application/json'}});
      }
    }
    return reply({ok:true,source:'BLS_official_Atom_via_GitHub_OIDC',received:clean.items.length,
      feeds:clean.feeds,orders_enabled:false});
  }catch{return reply({ok:false,error:'r2_write_or_readback_unavailable'},503)}
}
