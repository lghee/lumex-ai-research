/** Public top-50 Gate futures heatmap, strict observed-only market data.
 * Independent read-only collector, no WordPress cron, member data or trading keys.
 */
const PREFIX='market-hub/free-heatmap/v1/';
const SOURCE='Gate USDT perpetual public 24h ticker';
const SCHEMA='lumex_public_heatmap_v1';
/** Bounded audited crypto base-symbol inventory: exclude tokenized shares/ETFs such as SOXL or SNDK. */
export const CRYPTO_BASES=Object.freeze('BTC ETH SOL XRP BNB DOGE ADA TRX LINK AVAX LTC BCH DOT UNI AAVE NEAR SUI TON HBAR ICP ETC XLM ATOM ARB OP PEPE SHIB BONK WIF FLOKI INJ FIL SEI FET TAO RENDER RNDR RUNE KAS JUP POL MATIC WLD APT XMR ZEC DASH XTZ EOS ALGO GRT CRV MKR COMP SNX LDO ENA ONDO PENDLE W AXS SAND MANA IMX GALA MEME POPCAT PNUT TRUMP PUMP NOT TURBO BRETT GOAT ACT PEOPLE ZK ZRO STRK PYTH TIA JTO BOME MOODENG NEIRO TOSHI FARTCOIN VIRTUAL SPX GRASS AI16Z AIXBT GIGA PENGU JASMY CHZ IOTA VET FLOW EGLD THETA KAVA MINA DYDX GMX JOE CAKE 1INCH SUSHI YFI RSR ANKR ZIL QTUM LRC KSM SSV BLUR STX CFX ROSE KDA CELO ONE AR OM AGIX OCEAN AKT CORE COTI KNC SKL SXP BNT NEO ZRX BAT ICX ZEN MASK API3 TRB WOO ORDI SATS 1000SATS 1000PEPE 1000SHIB 1000BONK DOGS CATI HMSTR RAY LAYER BERA MOVE IP HYPE KAITO MORPHO BIO ETHFI EIGEN ATH MNT OKB CRO GT LEO TWT NEXO AMP RPL PHA TNSR DRIFT SAGA MANTA DYM NTRN ALT METIS SNT KERNEL HOME GUN INIT PARTI RED NIL B3 WAL HAEDAL AERO DEEP SYRUP PLUME FXS CVX'.split(' '));
const CRYPTO_SET=new Set(CRYPTO_BASES);

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
  if(!match||!CRYPTO_SET.has(match[1]))continue;
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
   selection:'known_crypto_universe_top50_by_24h_quote_turnover',
   universe:'사전 검증한 암호화폐 종목군에서 Gate USDT 선물 24시간 거래대금 상위 50개 계약',
   price_unit:'USDT',change_period:'24h',not_spot_market:true,
   coverage:{selected:top.length,valid_candidate_count:candidates.length,
      does_not_include_all_exchanges:true,eligible_crypto_base_count:CRYPTO_SET.size,
      excludes_unclassified_contracts:true},
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
/* ---- 2026-11-25: per-contract 24h open-interest change and liquidations (Gate contract_stats, 1h) ----
 * Same exchange and contracts as the board. Rows are hourly points; a row counts once its hour has closed
 * (time + 1h <= now). 24h liquidations need at least 22 of the last 24 closed hours, OI change needs the
 * point exactly 24h before the latest one. Anything missing stays null. */
const STATS_KEY='stats.json',STATS_SCHEMA='lumex_public_heatmap_stats_v1',HOUR=3600;
export const STATS_SOURCE='Gate USDT perpetual public contract_stats 1h';
export function parseGateHourlyStats(rows,nowSec){
 if(!Array.isArray(rows)||rows.length<2||rows.length>200)throw Error('gate_stats_schema');
 const bars=new Map();
 for(const r of rows){
  const t=num(r?.time,1500000000,4102444800);
  if(t===null||!Number.isSafeInteger(t)||t%HOUR!==0||t+HOUR>nowSec)continue;
  bars.set(t,{oi:num(r?.open_interest_usd,0,1e15),long:num(r?.long_liq_usd,0,1e14),short:num(r?.short_liq_usd,0,1e14)});
 }
 const ts=[...bars.keys()].sort((a,b)=>a-b);if(!ts.length)throw Error('gate_stats_empty');
 const last=ts.at(-1);if(last+HOUR<nowSec-3*HOUR)throw Error('gate_stats_stale');
 let L=0,S=0,n=0;
 for(let t=last-23*HOUR;t<=last;t+=HOUR){const b=bars.get(t);if(b&&b.long!==null&&b.short!==null){L+=b.long;S+=b.short;n++;}}
 const oiNow=bars.get(last)?.oi??null,oiAgo=bars.get(last-24*HOUR)?.oi??null;
 const chg=oiNow!==null&&oiAgo!==null&&oiAgo>0?(oiNow/oiAgo-1)*100:null;
 return {sample_unix:last+HOUR,oi_usdt:oiNow===null?null:round(oiNow,2),
   oi_change_24h_pct:chg!==null&&chg>=-100&&chg<=10000?round(chg,2):null,
   liq_24h:n>=22?{long_usdt:round(L,2),short_usdt:round(S,2),hours:n}:null};
}
async function readJson(bucket,key){try{const o=await bucket.get(PREFIX+key);return o?await o.json():null;}catch{return null;}}
/** Refreshes the stalest `batch` board contracts per run (10 × every 5 min → all 50 within 25 min). */
export async function collectHeatmapStats(env,ms=Date.now(),{batch=10,fetchFn=fetch}={}){
 if(!env?.MARKET_DATA)return {ok:false,reason:'market_storage_unavailable'};
 const board=await readJson(env.MARKET_DATA,'latest.json');
 if(board?.schema!==SCHEMA||!Array.isArray(board.coins))return {ok:false,reason:'board_unavailable'};
 const prev=await readJson(env.MARKET_DATA,STATS_KEY);
 const coins=prev?.schema===STATS_SCHEMA&&prev.coins&&typeof prev.coins==='object'?{...prev.coins}:{};
 const listed=board.coins.map(c=>c.coin).filter(c=>CRYPTO_SET.has(c));
 const seen=c=>Math.max(coins[c]?.fetched_ms||0,coins[c]?.attempted_ms||0);
 const pick=listed.slice().sort((a,b)=>seen(a)-seen(b)).slice(0,Math.max(1,Math.min(25,batch)));
 const nowSec=Math.floor(ms/1000);let ok=0,failed=0;
 await Promise.all(pick.map(async coin=>{
  try{
   const res=await fetchFn('https://api.gateio.ws/api/v4/futures/usdt/contract_stats?contract='+coin+'_USDT&interval=1h&limit=26',
     {headers:{accept:'application/json'},signal:AbortSignal.timeout(8000)});
   if(!res.ok)throw Error('provider_http_'+res.status);
   const text=await res.text();if(text.length>200000)throw Error('provider_payload_size');
   coins[coin]={...parseGateHourlyStats(JSON.parse(text),nowSec),fetched_ms:ms};ok++;
  }catch{coins[coin]={...(coins[coin]||{}),attempted_ms:ms};failed++;}
 }));
 for(const c of Object.keys(coins))if(!listed.includes(c)&&ms-seen(c)>24*HOUR*1000)delete coins[c];
 await store(env.MARKET_DATA,STATS_KEY,{schema:STATS_SCHEMA,source:STATS_SOURCE,updated_ms:ms,coins});
 return {ok:true,refreshed:ok,failed,tracked:Object.keys(coins).length};
}
/** Attaches fresh stats to the board rows (pure). Stats older than 75 min or a sample older than 3 h are left out. */
export function attachStats(board,stats,ms){
 if(stats?.schema!==STATS_SCHEMA||!stats.coins)return {...board,stats:{available:false}};
 let oi=0,liq=0;
 const coins=board.coins.map(c=>{const s=stats.coins[c.coin];
  if(!s||!Number.isFinite(s.fetched_ms)||ms-s.fetched_ms>75*60000||!Number.isFinite(s.sample_unix)||ms/1000-s.sample_unix>3*HOUR)return c;
  const o={...c,stats_as_of_unix:s.sample_unix};
  if(s.oi_change_24h_pct!==null&&s.oi_change_24h_pct!==undefined){o.oi_change_24h_pct=s.oi_change_24h_pct;o.oi_usdt=s.oi_usdt;oi++;}
  if(s.liq_24h){o.liq_24h_long_usdt=s.liq_24h.long_usdt;o.liq_24h_short_usdt=s.liq_24h.short_usdt;liq++;}
  return o;});
 return {...board,coins,stats:{available:oi>0||liq>0,source:STATS_SOURCE,exchange:'Gate',window_hours:24,coins_with_oi_change:oi,coins_with_liquidations:liq}};
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
 source=attachStats(source,await readJson(env.MARKET_DATA,STATS_KEY),ms);
 const result={...source,status:stale?'stale':'current',stale,age_seconds:Math.floor(age/1000),
    generated_at_utc:new Date(ms).toISOString()};
 const response=json(result,200,stale?0:45);
 return method==='HEAD'?new Response(null,{status:200,headers:response.headers}):response;
}
