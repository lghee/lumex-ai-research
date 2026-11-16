/** LUMEX free exchange-specific USDT-perpetual third-party backup.
 * Public Swolecharts API: https://swolecharts.com/developers
 * Published charts/data require a linked attribution. No API key.
 * Source collects Binance's public venue data independently; never label
 * aggregated BTC (all quotes) as BTCUSDT: market selector is exact.
 * Licensing: no raw-feed resale or redistribution. Display attributed
 * metrics in a dashboard only; do not expose this adapter as a bulk data API.
 */
const COINS=new Set(['BTC','ETH','SOL','XRP']);
const VENUES=Object.freeze({binance:'Binance',bybit:'Bybit',bitget:'Bitget'});
const HOST='https://swolecharts.com';
const ORIGIN='Swolecharts';
const finite=(v,lo,hi)=>{
  if(v===null||v===undefined||v===''||typeof v==='boolean')return null;
  const n=Number(v);return Number.isFinite(n)&&n>=lo&&n<=hi?n:null;
};
const rnd=(v,d=4)=>Number(v.toFixed(d));
function selectedMetric(venue,coin,kind){
  const market=venue+':perp:'+coin+'USDT';
  const q=new URLSearchParams({market,range:'2h',step:'5m'});
  if(kind==='account')q.set('kind','accounts');
  return {market,url:HOST+'/api/series/'+
    (kind==='account'?'long-short':kind==='open_interest'?'oi':'funding')+'?'+q};
}
async function publicSeries(url,fetchImpl){
  const resp=await fetchImpl(url,{
    headers:{accept:'application/json'},
    signal:AbortSignal.timeout(11000)});
  if(!resp.ok)throw Error('swole_http_'+resp.status);
  const data=await resp.text();
  if(data.length<2||data.length>200000)throw Error('swole_invalid_size');
  try{return JSON.parse(data)}catch{throw Error('swole_invalid_json')}
}
function pick(venue,coin,kind,body,now){
  const {market}=selectedMetric(venue,coin,kind);
  const expected=kind==='account'?'long-short':kind==='open_interest'?'oi':'funding';
  if(!body||body.metric!==expected||body.market!==market||
    body.db!==true||!Array.isArray(body.t)||!Array.isArray(body.v)||
    body.t.length!==body.v.length||body.t.length>400||body.t.length<1)
    return null;
  if(body.kind!==undefined&&kind==='account'&&body.kind!=='accounts')return null;
  let current=null;
  for(let i=0;i<body.t.length;i++){
    const ts=finite(body.t[i],1500000000000,4102444800000);
    const n=kind==='account'?finite(body.v[i],0,1):
      kind==='open_interest'?finite(body.v[i],0.00001,1e16):
      finite(body.v[i],-.2,.2);
    if(ts===null||n===null||ts>now+120000||now-ts>25*60000)continue;
    if(!current||current.ts<ts)current={ts,n};
  }
  if(!current)return null;
  const at={asof_ms:current.ts,vendor:ORIGIN,venue:VENUES[venue],
    attribution:'Data by Swolecharts',attribution_url:'https://swolecharts.com/developers',
    source_market:market};
  if(kind==='account'){
    return {...at,long_pct:rnd(current.n*100),short_pct:rnd((1-current.n)*100),
      source:'swolecharts_'+venue+'_usdt_perp_account_share',
      denominator:'exchange_long_short_accounts',method:'venue_published_account_long_share'};
  }
  if(kind==='open_interest'){
    return {...at,value:rnd(current.n),unit:'USD',
      source:'swolecharts_'+venue+'_usdt_perp_oi_usd',
      method:'exact_perpetual_contract_quote_notional'};
  }
  return {...at,rate_pct:Number((current.n*100).toFixed(6)),interval_hours:venue==='binance'?8:null,
    rate_kind:venue==='binance'?'8h_equivalent_perpetual_quote':'provider_current_perpetual_funding',
    source:'swolecharts_'+venue+'_usdt_perp_funding_8h_equivalent'};
}
/** Verified provider-only fallback, no key, no implicit market sums.
 * Returns no fake values if source is blocked or stale. */
export async function swolechartsVenueBackup(venue,coin,{now=Date.now(),fetchImpl=fetch}={}){
  if(!Object.hasOwn(VENUES,venue)||!COINS.has(coin))throw Error('unsupported_venue_or_coin');
  const result={account:null,open_interest:null,funding:null,errors:[],
    vendor:ORIGIN,venue:VENUES[venue],attribution:'Data by Swolecharts',
    attribution_url:'https://swolecharts.com/developers'};
  const metrics=['account','open_interest','funding'];
  const outcomes=await Promise.all(metrics.map(async kind=>{
    const {url}=selectedMetric(venue,coin,kind);
    try{return {kind,data:pick(venue,coin,kind,await publicSeries(url,fetchImpl),now)}}
    catch(e){return {kind,error:String(e?.message||e).replace(/[^A-Za-z0-9_-]/g,'_').slice(0,60)}}
  }));
  for(const o of outcomes){
    if(o.data)result[o.kind]=o.data;
    else result.errors.push('swolecharts_'+o.kind+':'+(o.error||'source_stale_or_invalid'));
  }
  return result;
}

/** Backward-compatible Binance endpoint and test contract. */
export function swolechartsBinanceBackup(coin,opts={}){
  return swolechartsVenueBackup('binance',coin,opts);
}
