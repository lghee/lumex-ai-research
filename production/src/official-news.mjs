/** LUMEX official macro announcements — exact source headlines, never hallucinated news.
 * Public-only HTTP feeds -> verified origins -> private R2 snapshot -> public cached report.
 * This does NOT claim any announcement caused a coin price movement.
 */
const SCHEMA='lumex_public_official_news_v1';
const PREFIX='market-hub/official-news/v1/';
const FEEDS=Object.freeze([
 {id:'fed',label:'미국 연방준비제도',host:'www.federalreserve.gov',url:'https://www.federalreserve.gov/feeds/press_monetary.xml',kind:'monetary_policy'},
 {id:'bls_cpi',label:'미국 노동통계국 · 물가',host:'www.bls.gov',url:'https://www.bls.gov/feed/cpi.rss',kind:'inflation'},
 {id:'bls_jobs',label:'미국 노동통계국 · 고용',host:'www.bls.gov',url:'https://www.bls.gov/feed/empsit.rss',kind:'jobs'},
 {id:'bea',label:'미국 경제분석국',host:'www.bea.gov',url:'https://apps.bea.gov/rss/rss.xml',kind:'economic_indicators',extra_host:'apps.bea.gov'}
]);
const cors={'access-control-allow-origin':'*','access-control-allow-methods':'GET, HEAD, OPTIONS',
  'access-control-allow-headers':'content-type','x-content-type-options':'nosniff'};
const respond=(d,status=200,ttl=0)=>new Response(JSON.stringify(d),{status,headers:{
 ...cors,'content-type':'application/json; charset=utf-8','cache-control':ttl?'public, max-age='+ttl:'no-store'}});
function decode(x){
 return String(x||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1')
 .replace(/<[^>]*>/g,' ').replace(/&(?:amp|lt|gt|quot|apos|nbsp);/gi,m=>
   ({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':' '})[m.toLowerCase()]||m)
 .replace(/&#(x[0-9a-f]+|\d+);/gi,(m,x)=>{
  const n=x[0]?.toLowerCase()==='x'?parseInt(x.slice(1),16):parseInt(x,10);
  return n>=32&&n<=0x10ffff?String.fromCodePoint(n):' ';
 }).replace(/\s+/g,' ').trim().slice(0,240);
}
const tag=(block,name)=>{const match=new RegExp('<(?:[A-Za-z0-9_-]+:)?'+name+'(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_-]+:)?'+name+'>','i').exec(block);return match?match[1]:''};
function urlFrom(block,feed){
 const raw=tag(block,'link');
 const attr=/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/i.exec(block);
 const candidate=decode(raw)||attr?.[1]||'';
 let u;try{u=new URL(candidate,feed.url)}catch{return null}
 if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash||u.hostname!==feed.host&&u.hostname!==feed.extra_host)return null;
 if(!/^\/[a-zA-Z0-9_./%~-]+(?:\?.*)?$/.test(u.pathname+u.search))return null;
 return u.href;
}
export function parseOfficialFeed(xml,feed,now=Date.now()){
 if(typeof xml!=='string'||xml.length<70||xml.length>600000)throw Error('feed_size_invalid');
 const items=[...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi),
  ...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)].slice(0,60);
 if(!items.length)throw Error('official_feed_items_missing');
 const seen=new Set(),out=[];
 for(const match of items){
  const b=match[1],title=decode(tag(b,'title'));
  const link=urlFrom(b,feed);
  const date=decode(tag(b,'pubDate')||tag(b,'published')||tag(b,'updated')||tag(b,'date'));
  const ms=Date.parse(date);
  if(!link||title.length<9||title.length>230||!Number.isFinite(ms)||ms<now-31*86400000||ms>now+3600000)continue;
  if(seen.has(link))continue;seen.add(link);
  out.push({id:feed.id+':'+link,source_id:feed.id,agency:feed.label,
    kind:feed.kind,title_original:title,source_url:link,published_ms:ms,
    published_utc:new Date(ms).toISOString(),official_source_verified:true,
    description_ko:({monetary_policy:'연준의 공식 통화정책 발표입니다.',
    inflation:'미국 물가의 공식 발표 자료입니다.',
    jobs:'미국 고용시장의 공식 발표 자료입니다.',
    economic_indicators:'미국 경제지표의 공식 발표 자료입니다.'})[feed.kind],
    notes:'공식 발표 제목과 발표 시각만 표시합니다. 코인 가격 변동의 원인을 단정하지 않습니다.'});
 }
 if(!out.length)throw Error('official_articles_unverified');
 return out;
}
async function retrieve(f){
 const resp=await fetch(f.url,{headers:{accept:'application/rss+xml, application/xml, text/xml',
   'user-agent':'LUMEXOfficialMarketBrief/1.0 (public research only)'},signal:AbortSignal.timeout(11000)});
 if(!resp.ok)throw Error('provider_http_'+resp.status);
 const len=Number(resp.headers.get('content-length')||0);
 if(len>600000)throw Error('provider_payload_large');
 const body=await resp.text();
 return parseOfficialFeed(body,f);
}
function sanitizeReason(e){return String(e?.message||e||'unavailable').replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,55)}
async function put(bucket,key,data){
 await bucket.put(PREFIX+key,JSON.stringify(data),{httpMetadata:{contentType:'application/json'}});
}
export async function collectOfficialNews(env,now=Date.now()){
 const bucket=env?.MARKET_DATA;
 if(!bucket)return {ok:false,reason:'r2_not_configured'};
 const attempt=await bucket.get(PREFIX+'attempt.json').then(x=>x?.json()).catch(()=>null);
 if(attempt?.at_ms&&now-attempt.at_ms<2*3600000&&now>=attempt.at_ms)
  return {ok:true,skipped:'recent_attempt'};
 await put(bucket,'attempt.json',{at_ms:now,status:'checking'});
 const state=await Promise.allSettled(FEEDS.map(retrieve));
 const feedCoverage=[],newItems=[];
 for(let i=0;i<state.length;i++){
  const f=FEEDS[i],s=state[i];
  if(s.status==='fulfilled'){
   feedCoverage.push({id:f.id,agency:f.label,status:'verified',items:s.value.length,checked_ms:now});
   newItems.push(...s.value);
  }else{
   feedCoverage.push({id:f.id,agency:f.label,status:'unavailable',reason:sanitizeReason(s.reason),checked_ms:now});
  }
 }
 if(!newItems.length){
  await put(bucket,'attempt.json',{at_ms:now,status:'failed',sources:feedCoverage});
  return {ok:false,reason:'no_verified_official_feed',previous_snapshot_preserved:true};
 }
 const unique=new Map();
 for(const e of newItems)unique.set(e.source_url,e);
 const sorted=[...unique.values()].sort((a,b)=>b.published_ms-a.published_ms).slice(0,48);
 const record={ok:true,schema:SCHEMA,source:'official_us_agency_rss_only',collected_ms:now,
  collected_utc:new Date(now).toISOString(),
  coverage:{verified_feeds:feedCoverage.filter(x=>x.status==='verified').length,
    attempted_feeds:FEEDS.length,all_sources_verified:feedCoverage.every(x=>x.status==='verified')},
  feeds:feedCoverage,items:sorted,
  reliability:'Official source headline and date verified; not an AI generated summary or causal market claim.',
  no_news_inference:true,no_order_execution:true};
 const day=new Date(now).toISOString().slice(0,10);
 await put(bucket,'snapshots/'+day+'/'+new Date(now).toISOString().slice(11,16).replace(':','-')+'.json',record);
 await put(bucket,'latest.json',record);
 await put(bucket,'attempt.json',{at_ms:now,status:'completed',sources:feedCoverage});
 return {ok:true,articles:sorted.length,sources:record.coverage.verified_feeds};
}
export async function officialNewsPublicRoute(request,env,ms=Date.now()){
 if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
 if(!['GET','HEAD'].includes(request.method))return respond({ok:false,error:'method_not_allowed'},405);
 if(!env?.MARKET_DATA)return respond({ok:false,error:'storage_unavailable'},503);
 let record;
 try{
  const obj=await env.MARKET_DATA.get(PREFIX+'latest.json');
  if(!obj)return respond({ok:false,status:'collecting',items:[],error:'first_collection_pending'},503);
  record=await obj.json();
 }catch{return respond({ok:false,error:'storage_read_unavailable'},503)}
 if(!record||record.schema!==SCHEMA||record.no_order_execution!==true||
    !Array.isArray(record.items)||record.items.length>48||!Number.isSafeInteger(record.collected_ms))
  return respond({ok:false,error:'record_not_verified'},503);
 const age=Math.max(0,ms-record.collected_ms);
 const data={...record,stale:age>24*3600000,age_seconds:Math.floor(age/1000),
  status:age>24*3600000?'latest_official_archive':'recently_checked'};
 const res=respond(data,200,age>24*3600000?0:75);
 return request.method==='HEAD'?new Response(null,{status:200,headers:res.headers}):res;
}
