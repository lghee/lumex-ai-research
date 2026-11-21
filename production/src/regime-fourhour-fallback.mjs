/** LUMEX: read-only official-exchange 4h emergency market candles.
 * Called only if the existing verified R2 OHLCV pipeline cannot serve 4h.
 * Never substitutes old/hypothetical prices, mixed-exchange candles or orders.
 */
const COINS=new Set(['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT']);
const FRAME_MS=4*60*60*1000;
const MAX_AGE_MS=7*60*60*1000;
const PREFIX='market-hub/regime-fallback/v1/';
const CACHE_TTL_MS=6*60*1000;
const num=x=>{const n=Number(x);return x===null||x===undefined||x===''||typeof x==='boolean'||!Number.isFinite(n)?null:n;};

export function normalizedFourHour(source,raw,now=Date.now()) {
  if(!['Gate','Bybit'].includes(source))return [];
  const sourceRows=source==='Gate'?raw:(raw?.retCode===0?raw?.result?.list:null);
  if(!Array.isArray(sourceRows)||sourceRows.length<160||sourceRows.length>500)return [];
  const seen=new Map();
  for(const x of sourceRows){
    if(!x||typeof x!=='object')return [];
    const parts=source==='Gate'
      ?[num(x.t)*1000,num(x.o),num(x.h),num(x.l),num(x.c),num(x.v)]
      :Array.isArray(x)&&x.length>=6?x.slice(0,6).map(num):[];
    if(parts.length!==6||parts.some(a=>a===null))return [];
    const [t,o,h,l,c,v]=parts;
    if(!Number.isSafeInteger(t)||t<1500000000000||t%FRAME_MS!==0||o<=0||l<=0||c<=0||v<=0||
       h<Math.max(o,c,l)||l>Math.min(o,c,h))return [];
    if(t+FRAME_MS>now)continue;
    if(seen.has(t))return [];
    seen.set(t,{t,o,h,l,c,v});
  }
  const rows=[...seen.values()].sort((a,b)=>a.t-b.t).slice(-200);
  if(rows.length<160)return [];
  for(let i=1;i<rows.length;i++)if(rows[i].t-rows[i-1].t!==FRAME_MS)return [];
  const age=now-rows.at(-1).t-FRAME_MS;
  if(age< -60000||age>MAX_AGE_MS)return [];
  return rows;
}

function responseFor(source,symbol,rows,now){
  const last=rows.at(-1).t;
  return {symbol,interval:'240',category:'linear',
    candles:rows,source:source+' official futures 4h',
    source_type:'official_public_fallback',
    feed_mode:'verified_public_exchange_4h_closed_candles',
    data_quality:'verified',stale:false,
    last_candle_open_ms:last,
    as_of_utc:new Date(last+FRAME_MS).toISOString(),
    retrieved_at:new Date(now).toISOString(),
    retrieved_at_unix:Math.floor(now/1000),
    age_seconds:Math.max(0,Math.floor((now-last-FRAME_MS)/1000)),
    precision:'closed_candles_only',orders_enabled:false,
    provenance:'Official public exchange futures OHLCV, source-isolated; R2 pipeline unavailable',
  };
}

export async function regimeFourHourFallback(env,symbol,limit=500,now=Date.now()){
  if(!COINS.has(symbol)||![500,850].includes(limit)||!env?.MARKET_DATA)throw Error('invalid_regime_fallback_request');
  const key=PREFIX+symbol+'.json';
  try{
    const obj=await env.MARKET_DATA.get(key);
    if(obj){const saved=await obj.json();
      if(saved?.schema==='lumex_regime_fallback_v1'&&COINS.has(saved.symbol)&&saved.symbol===symbol&&
          ['Gate','Bybit'].includes(saved.exchange)&&Number.isSafeInteger(saved.stored_ms)&&
          saved.stored_ms<=now+60000&&now-saved.stored_ms<CACHE_TTL_MS){
        const rows=normalizedFourHour(saved.exchange,saved.raw_response,now);
        if(rows.length>=160)return responseFor(saved.exchange,symbol,rows,now);
      }
    }
  }catch{}
  for(const exchange of ['Gate','Bybit']){
    try{
      const url=exchange==='Gate'
        ?'https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract='+symbol.replace('USDT','_USDT')+'&interval=4h&limit=240'
        :'https://api.bybit.com/v5/market/kline?category=linear&symbol='+symbol+'&interval=240&limit=240';
      const response=await fetch(url,{method:'GET',signal:AbortSignal.timeout(4500),headers:{accept:'application/json'}});
      if(!response.ok)continue;
      const size=Number(response.headers.get('content-length')||0);
      if(size>250000)continue;
      const body=await response.text();
      if(body.length<100||body.length>250000)continue;
      const raw=JSON.parse(body),rows=normalizedFourHour(exchange,raw,now);
      if(rows.length<160)continue;
      const saved={schema:'lumex_regime_fallback_v1',symbol,exchange,stored_ms:now,raw_response:raw};
      const encoded=JSON.stringify(saved);
      if(encoded.length>300000)continue;
      await env.MARKET_DATA.put(key,encoded,{httpMetadata:{contentType:'application/json'}});
      const proof=await env.MARKET_DATA.get(key);
      if(!proof)continue;
      const checked=await proof.json();
      if(checked?.schema!=='lumex_regime_fallback_v1'||checked.symbol!==symbol||checked.exchange!==exchange||checked.stored_ms!==now)continue;
      return responseFor(exchange,symbol,rows,now);
    }catch{}
  }
  throw Error('official_4h_sources_unavailable');
}
