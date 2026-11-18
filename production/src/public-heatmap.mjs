/** Public top-50 Gate futures heatmap, strict observed-only market data.
 * Independent read-only collector, no WordPress cron, member data or trading keys.
 */
const PREFIX='market-hub/free-heatmap/v1/';
const SOURCE='Gate USDT perpetual public 24h ticker';
const SCHEMA='lumex_public_heatmap_v1';
const CORS={'access-control-allow-origin':'*','access-control-allow-methods':'GET, HEAD, OPTIONS',
  'access-control-allow-headers':'content-type','x-content-type-options':'nosniff'};
const json=(v,status=200,cache=0)=>new Response(JSON.stringify(v),{status,headers:{
  ...CORS,'content-type':'application/json; charset=utf-8',
  'cache-control':cache?'public, max-age='+cache:'no-store'}});
const num=(v,min,max)=>{
 if(typeof v!=='number'&&typeof v!=='string')return null;
 if(typeof v==='string'&&!v.trim())return null;
 const n=Number(v);return Number.isFinite(n)&&n>=min&&n<=max?n:null;
};
const round=(n,d=3)=>Number(n.toFixed(d));
export function normalizeTickers(source,ms){
 if(!Array.isArray(source)||source.length<50||source.length>5000)throw Error('gate_ticker_rows_invalid');
 if(!Number.isFinite(ms)||ms<1500000000000)throw Error('time_unverified');
 const candidates=[],seen=new Set();
 for(const t of source){
  const contract=typeof t?.contract==='string'?t.contract:'';
  const match=/^([A-Z0-9]{2,16})_USDT$/.exec(contract);
  if(!match)continue;
  if(seen.has(contract))continue;
  const price=num(t.last,0.00000001,1e9),delta=num(t.change_percentage,-100,10000),
      volume=num(t.volume_24h_quote??t.volume_24h_settle,1000,1e16),
      funding=num(t.funding_rate,-1,1);
  if(price===null||delta===null||volume===null)continue;
  seen.add(contract);
  candidates.push({coin:match[1],symbol:contract,price_usdt:price,
    change_24h_pct:round(delta),turnover_24h_usdt:round(volume,2),
    funding_rate_pct:funding===null?null:round(funding*100,5)});
 }
 if(candidates.length<50)throw Error('fewer_than_50_valid_futures');
 candidates.sort((a,b)=>b.turnover_24h_usdt-a.turnover_24h_usdt||a.symbol.localeCompare(b.symbol));
 const top=candidates.slice(0,50);
 const up=top.filter(x=>x.change_24h_pct>0).length,down=top.filter(x=>x.change_24h_pct<0).length,
   flat=50-up-down, movers=top.filter(x=>Math.abs(x.change_24h_pct)>=5).length;
 const weighted=top.reduce((s,x)=>s+x.change_24h_pct*x.turnover_24h_usdt,0)/
       top.reduce((s,x)=>s+x.turnover_24h_usdt,0);
 const mood=down>=35?'하락 우세':up>=35?'상승 우세':'혼조',
       volatility=movers>=15?'급변 종목 많음':movers>=7?'변동 확대':'비교적 안정';
 return {ok:true,schema:SCHEMA,source:SOURCE,data_kind:'observed_public_market_only',
   collected_ms:ms,observed_at_utc:new Date(ms).toISOString(),
   selection:'same_exchange_top50_by_24h_quote_turnover',
   universe:'Gate 거래소 USDT 무기한 선물 중 24시간 거래대금 상위 50개 계약',
   price_unit:'USDT',change_period:'24h',not_spot_market:true,
   coverage:{selected:top.length,valid_candidate_count:candidates.length,
      does_not_include_all_exchanges:true},
   breadth:{up,down,flat,total:50,movers_ge_5pct:movers},
   interpretation:{mood,volatility,weighted_change_pct:round(weighted),
     note:'50개 선물 계약의 24시간 등락률 분포를 설명합니다. 전체 암호화폐 시장이나 향후 가격을 예측하지 않습니다.'},
   coins:top};
}
function safe(e){return String(e?.message||e||'failed').replace(/[^A-Za-z0-9_-]/g,'_').slice(0,65);}
async function fetchTickers(){
 const url='https://api.gateio.ws/api/v4/futures/usdt/tickers';
 const res=await fetch(url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(12000)});
 if(!res.ok)throw Error('provider_http_'+res.status);
 const size=Number(res.headers.get('content-length')||0);
 if(size>5500000)throw Error('provider_content_length');
 const payload=await res.text();
 if(payload.length<1000||payload.length>5500000)throw Error('provider_payload_size');
 try{return JSON.parse(payload)}catch{throw Error('provider_json_invalid')}
}
async function store(bucket,name,data){await bucket.put(PREFIX+name,JSON.stringify(data),{httpMetadata:{contentType:'application/json'}})}
export async function collectPublicHeatmap(env,ms=Date.now()){
 if(!env?.MARKET_DATA)return {ok:false,reason:'market_storage_unavailable'};
 const hour=new Date(ms).toISOString();
 try{
  const rows=await fetchTickers(),result=normalizeTickers(rows,ms);
  // Write immutable first, latest second: failed collections preserve last valid.
  const key='snapshots/'+hour.slice(0,10)+'/'+hour.slice(11,16).replace(':','-')+'.json';
  await store(env.MARKET_DATA,key,result);
  await store(env.MARKET_DATA,'latest.json',result);
  await store(env.MARKET_DATA,'health.json',{ok:true,collected_ms:ms,selected:50,schema:SCHEMA});
  return {ok:true,selected:50,collected_ms:ms};
 }catch(e){
  await store(env.MARKET_DATA,'last-attempt.json',{ok:false,attempted_ms:ms,error:safe(e)}).catch(()=>{});
  return {ok:false,reason:safe(e),previous_snapshot_preserved:true};
 }
}
export async function heatmapPublicRoute(request,env,ms=Date.now()){
 const method=request.method;
 if(method==='OPTIONS')return new Response(null,{status:204,headers:CORS});
 if(method!=='GET'&&method!=='HEAD')return json({ok:false,error:'method_not_allowed'},405);
 if(!env.MARKET_DATA)return json({ok:false,error:'market_storage_unavailable'},503);
 let source;
 try{
  const obj=await env.MARKET_DATA.get(PREFIX+'latest.json');
  if(!obj)return json({ok:false,status:'collecting',reason:'first_collection_pending'},503);
  source=await obj.json();
 }catch{return json({ok:false,error:'market_data_unavailable'},503);}
 if(source?.schema!==SCHEMA||!Array.isArray(source.coins)||source.coins.length!==50 ||
    !Number.isSafeInteger(source.collected_ms))return json({ok:false,error:'saved_data_invalid'},503);
 const age=Math.max(0,ms-source.collected_ms),stale=age>20*60000;
 const result={...source,status:stale?'stale':'current',stale,age_seconds:Math.floor(age/1000),
    generated_at_utc:new Date(ms).toISOString()};
 const response=json(result,200,stale?0:45);
 return method==='HEAD'?new Response(null,{status:200,headers:response.headers}):response;
}
