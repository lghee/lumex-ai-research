/** LUMEX 주식 고래 (Phase 116, 2026-11-27) — Hyperliquid "xyz" builder perp DEX (trade.xyz), stock section only.
 *
 * Public Hyperliquid info API, read-only. No keys, no orders, no signatures.
 *   - metaAndAssetCtxs (dex xyz): markets, mark/oracle price, open interest, 24h volume, funding.
 *     Only tickers that are also in the LUMEX stock universe (US stock/ETF, Bybit) are kept — commodities, FX,
 *     indices and non-US shares on xyz are left out so every row links to a /stocks/{ticker}/ page.
 *   - recentTrades (most traded stock markets): the two addresses on each trade of at least TRADE_MIN_USD become
 *     candidates. The coin whale list (Hyperliquid leaderboard accounts) is added as candidates too.
 *   - clearinghouseState (dex xyz), a few candidates per run: their stock positions.
 * A "new entry" is a position of at least ENTRY_MIN_USD that was not there (or was on the other side) at that
 * address's previous check, or grew by half or more. Its price is the xyz mark at detection, and its result after
 * 1/4/24 hours is read from xyz 5-minute candles at those times (side-adjusted). Detection lags by up to one check
 * cycle, and the screen says so. Nothing is estimated: a missing value stays null.
 */
const ROOT='stock-hub/v1/whales/';
const INFO='https://api.hyperliquid.xyz/info';
const DEX='xyz';
export const TRADE_MIN_USD=10000,WHALE_MIN_USD=100000,ENTRY_MIN_USD=100000;
const CANDIDATES_MAX=500,CHECKS_PER_RUN=20,TRADE_MARKETS=12,EVENTS_KEEP=400;
const HORIZONS=[['r1h',3600000],['r4h',4*3600000],['r24h',24*3600000]];
const fin=Number.isFinite;
const num=v=>{if(v===null||v===undefined||v===''||typeof v==='boolean')return null;const x=Number(v);return fin(x)?x:null;};
const isAddr=a=>typeof a==='string'&&/^0x[0-9a-f]{40}$/i.test(a);
async function rget(bucket,key){try{const o=await bucket.get(key);return o?await o.json():null;}catch{return null;}}
const rput=(bucket,key,v)=>bucket.put(key,JSON.stringify(v),{httpMetadata:{contentType:'application/json'}});
async function info(fetchImpl,body){
  const r=await fetchImpl(INFO,{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw Error('http_'+r.status);const t=await r.text();if(t.length>3000000)throw Error('size');return JSON.parse(t);
}
export const tickerOf=coin=>typeof coin==='string'&&coin.startsWith(DEX+':')?coin.slice(DEX.length+1).toUpperCase():null;

/** xyz markets that map to a stock in the LUMEX universe. Pure. */
export function buildMarkets(meta,universe){
  const uni=Array.isArray(meta?.[0]?.universe)?meta[0].universe:[],ctx=Array.isArray(meta?.[1])?meta[1]:[];
  const stocks=new Map((universe?.stocks||[]).map(s=>[s.ticker.replace(/\./g,'').toUpperCase(),s]));
  const out=[];
  uni.forEach((u,i)=>{
    const t=tickerOf(u?.name),c=ctx[i];if(!t||!c||u.isDelisted)return;
    const s=stocks.get(t.replace(/\./g,''));if(!s)return;
    const mark=num(c.markPx),oi=num(c.openInterest),vol=num(c.dayNtlVlm),prev=num(c.prevDayPx);
    if(!(mark>0))return;
    out.push({coin:u.name,ticker:s.ticker,slug:s.slug,name:s.name,type:s.type,mark,oracle:num(c.oraclePx),
      oi_usd:oi!==null?oi*mark:null,volume_24h_usd:vol,change_24h_pct:prev>0?Number(((mark/prev-1)*100).toFixed(3)):null,
      funding_pct:num(c.funding)===null?null:Number((Number(c.funding)*100).toFixed(5)),max_leverage:num(u.maxLeverage)});
  });
  return out.sort((a,b)=>(b.volume_24h_usd??-1)-(a.volume_24h_usd??-1));
}
/** Stock positions from a clearinghouseState (xyz). Pure. */
export function stockPositions(state,markets){
  if(!Array.isArray(state?.assetPositions))throw Error('positions_schema');
  const by=new Map(markets.map(m=>[m.coin,m]));const rows=[];
  for(const a of state.assetPositions){
    const p=a?.position,m=by.get(p?.coin);if(!m)continue;
    const szi=num(p.szi),entry=num(p.entryPx),value=num(p.positionValue);
    if(!szi||!(entry>0)||value===null||value<0)continue;
    rows.push({coin:m.coin,ticker:m.ticker,slug:m.slug,side:szi>0?'long':'short',size:Math.abs(szi),entry_price:entry,value_usd:value,
      unrealized_usd:num(p.unrealizedPnl),leverage:num(p.leverage?.value),liquidation_price:num(p.liquidationPx)});
  }
  return rows.sort((a,b)=>b.value_usd-a.value_usd);
}
/** New entries between two checks of one address. Pure. */
export function diffEntries(address,before,after,markets,now){
  const prev=new Map((before||[]).map(p=>[p.coin,p])),by=new Map(markets.map(m=>[m.coin,m]));const ev=[];
  for(const p of after){
    if(p.value_usd<ENTRY_MIN_USD)continue;
    const o=prev.get(p.coin);let kind=null;
    if(!o||o.side!==p.side)kind=o?'flip':'new';
    else if(p.size>=o.size*1.5&&(p.size-o.size)*(by.get(p.coin)?.mark||p.entry_price)>=ENTRY_MIN_USD/2)kind='add';
    if(!kind)continue;
    const mark=by.get(p.coin)?.mark??null;
    ev.push({id:`${address.slice(2,10)}-${p.coin}-${now}`,address,coin:p.coin,ticker:p.ticker,slug:p.slug,side:p.side,kind,value_usd:p.value_usd,
      entry_price:p.entry_price,detected_ms:now,detected_price:mark,prev_checked_ms:null,r1h:null,r4h:null,r24h:null});
  }
  return ev;
}
const sidePct=(side,from,to)=>from>0&&to>0?Number((((to/from)-1)*100*(side==='long'?1:-1)).toFixed(3)):null;

export async function collectStockWhales(env,{now=Date.now(),fetchImpl=fetch}={}){
  const bucket=env?.MARKET_DATA;if(!bucket)return {ok:false,reason:'r2_missing'};
  const universe=await rget(bucket,'stock-hub/v1/universe.json');if(!universe?.ok)return {ok:false,reason:'no_universe'};
  let meta;try{meta=await info(fetchImpl,{type:'metaAndAssetCtxs',dex:DEX});}catch(e){return {ok:false,reason:'meta_'+String(e?.message||e).slice(0,30)};}
  const markets=buildMarkets(meta,universe);if(!markets.length)return {ok:false,reason:'no_markets'};
  const st=(await rget(bucket,ROOT+'state.json'))||{candidates:{},positions:{},events:[],cursor:0};
  const errors={};const err=k=>{errors[k]=(errors[k]||0)+1;};
  // 1) candidates from large recent trades
  await Promise.all(markets.slice(0,TRADE_MARKETS).map(async m=>{
    try{const t=await info(fetchImpl,{type:'recentTrades',coin:m.coin});
      for(const x of Array.isArray(t)?t:[]){const v=num(x?.px)*num(x?.sz);if(!(v>=TRADE_MIN_USD))continue;
        for(const a of Array.isArray(x.users)?x.users:[])if(isAddr(a)){const k=a.toLowerCase();st.candidates[k]={seen_ms:now,src:st.candidates[k]?.src==='leaderboard'?'leaderboard':'trade'};}}
    }catch{err('trades');}
  }));
  // 2) coin whale list (leaderboard accounts) once an hour
  if(now-(st.leaderboard_ms||0)>=3600000){
    const lb=await rget(bucket,'market-hub/hyperliquid-whales/v1/latest.json');
    for(const r of lb?.rows||[])if(isAddr(r?.address)){const k=r.address.toLowerCase();st.candidates[k]={seen_ms:st.candidates[k]?.seen_ms||now,src:'leaderboard'};}
    st.leaderboard_ms=now;
  }
  // keep the most recent candidates; addresses holding stock positions are never dropped
  const keys=Object.keys(st.candidates);
  if(keys.length>CANDIDATES_MAX){
    keys.filter(k=>!st.positions[k]?.rows?.length).sort((a,b)=>st.candidates[a].seen_ms-st.candidates[b].seen_ms)
      .slice(0,keys.length-CANDIDATES_MAX).forEach(k=>{delete st.candidates[k];delete st.positions[k];});
  }
  // 3) check: half the slots for holders (oldest check first), half for addresses never or least recently checked
  const holders=Object.keys(st.positions).filter(k=>st.positions[k]?.rows?.some(p=>p.value_usd>=WHALE_MIN_USD)&&st.candidates[k])
    .sort((a,b)=>st.positions[a].at_ms-st.positions[b].at_ms).slice(0,CHECKS_PER_RUN/2);
  const others=Object.keys(st.candidates).filter(k=>!holders.includes(k))
    .sort((a,b)=>(st.positions[a]?.at_ms||0)-(st.positions[b]?.at_ms||0)||st.candidates[b].seen_ms-st.candidates[a].seen_ms)
    .slice(0,CHECKS_PER_RUN-holders.length);
  let checked=0,found=0;
  for(let i=0,list=[...holders,...others];i<list.length;i+=5){
    await Promise.all(list.slice(i,i+5).map(async a=>{
      try{
        const rows=stockPositions(await info(fetchImpl,{type:'clearinghouseState',user:a,dex:DEX}),markets);
        const old=st.positions[a];
        if(old?.at_ms){const ev=diffEntries(a,old.rows,rows,markets,now);ev.forEach(e=>e.prev_checked_ms=old.at_ms);st.events.unshift(...ev);found+=ev.length;}
        st.positions[a]={at_ms:now,rows:rows.filter(p=>p.value_usd>=10000).slice(0,20)};checked++;
      }catch{err('positions');}
    }));
  }
  // 4) results after 1/4/24h from xyz 5-minute candles (one request per due event)
  const due=[];for(const e of st.events)for(const [k,ms] of HORIZONS)if(e[k]===null&&e.detected_price>0&&now>=e.detected_ms+ms)due.push([e,k,ms]);
  for(const [e,k,ms] of due.slice(0,20)){
    const at=e.detected_ms+ms;
    try{const c=await info(fetchImpl,{type:'candleSnapshot',req:{coin:e.coin,interval:'5m',startTime:at,endTime:at+15*60000}});
      const bar=(Array.isArray(c)?c:[]).find(b=>num(b?.t)>=at-300000);const px=num(bar?.o);
      if(px>0)e[k]=sidePct(e.side,e.detected_price,px);else if(now-at>6*3600000)e[k]=false;   // false = not available (shown as —)
    }catch{err('candles');}
  }
  st.events=st.events.slice(0,EVENTS_KEEP);
  st.cursor=0;
  await rput(bucket,ROOT+'state.json',st);
  const holdersNow=Object.values(st.positions).filter(p=>p.rows?.some(r=>r.value_usd>=WHALE_MIN_USD)).length;
  await rput(bucket,ROOT+'markets.json',{updated_ms:now,markets});
  const out={ok:Object.keys(errors).length===0,updated_ms:now,markets:markets.length,candidates:Object.keys(st.candidates).length,checked,new_entries:found,holders:holdersNow,errors};
  await rput(bucket,ROOT+'health.json',out);
  return out;
}

export async function whalesPayload(env,{now=Date.now()}={}){
  const bucket=env.MARKET_DATA;
  const [st,mk,health]=await Promise.all([rget(bucket,ROOT+'state.json'),rget(bucket,ROOT+'markets.json'),rget(bucket,ROOT+'health.json')]);
  if(!st||!mk)return {ok:false,error:'not_collected'};
  const short=a=>a.slice(0,6)+'…'+a.slice(-4);
  const positions=[];
  for(const [a,p] of Object.entries(st.positions||{}))for(const r of p.rows||[])if(r.value_usd>=WHALE_MIN_USD)
    positions.push({...r,address:a,address_short:short(a),checked_ms:p.at_ms,stale:now-p.at_ms>6*3600000});
  positions.sort((x,y)=>y.value_usd-x.value_usd);
  const bySym={};for(const p of positions){const s=bySym[p.ticker]||(bySym[p.ticker]={ticker:p.ticker,slug:p.slug,long_usd:0,short_usd:0,whales:0});s[p.side+'_usd']+=p.value_usd;s.whales++;}
  const markets=(mk.markets||[]).map(m=>({...m,whale_long_usd:bySym[m.ticker]?.long_usd||0,whale_short_usd:bySym[m.ticker]?.short_usd||0,whales:bySym[m.ticker]?.whales||0}));
  const events=(st.events||[]).slice(0,150).map(e=>({...e,address_short:short(e.address),r1h:e.r1h===false?null:e.r1h,r4h:e.r4h===false?null:e.r4h,r24h:e.r24h===false?null:e.r24h}));
  return {ok:true,schema:'lumex_stock_whales_v1',source:'Hyperliquid xyz (trade.xyz) 공개 정보',updated_ms:mk.updated_ms,
    thresholds:{whale_usd:WHALE_MIN_USD,entry_usd:ENTRY_MIN_USD,trade_usd:TRADE_MIN_USD},
    coverage:{candidates:health?.candidates??null,holders:health?.holders??null,checks_per_run:CHECKS_PER_RUN,
      note:'큰 체결에 나온 주소와 Hyperliquid 리더보드 주소만 확인합니다. 전체 계좌가 아닙니다.'},
    markets,positions:positions.slice(0,100),events,order_execution:false};
}
