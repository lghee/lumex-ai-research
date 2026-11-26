/** LUMEX 코인 속보 (Phase 107). Free sources only, no AI per item.
 * - LUMEX 감지: rule-based items from public market data (Bybit klines / tickers / open interest,
 *   Gate 1h liquidation aggregates, Hyperliquid whale fills already in R2, LUMEX 4H chart signal).
 * - 공식 경제 발표: the existing official-news R2 snapshot (titles + links).
 * - 기사 (Phase 108): crypto media RSS — title, link, byline, time only (no body, no description).
 *   Every source is collected; Core decides which sources are shown (운영센터 켜기) and translates English titles.
 * Exchange announcements were dropped in Phase 108 (user decision).
 * Never copies third-party article bodies. Never claims a cause for a price move.
 * Storage: R2 market-hub/news/v1/feed.json (newest 400) + day/YYYY-MM-DD.json (KST day archive).
 */
import {makeMarket,parseKlines} from './paper-league.mjs';
import {replay as chartReplay} from './paper-league-chartsig.mjs';

export const ROOT='market-hub/news/v1/';
export const SCHEMA='lumex_news_feed_v1';
export const COINS=['BTC','ETH','SOL','XRP'];
export const DEFAULTS=Object.freeze({move_major:3,move_alt:5,funding_hi:0.05,funding_lo:-0.03,oi_1h:5,liq_mult:3,liq_min_usd:2e6,whale_usd:5e6});
const HOUR=3600000,KST=9*HOUR,FEED_MAX=400,KEY_TTL=7*86400000;
const fin=Number.isFinite;
const cors={'access-control-allow-origin':'*','access-control-allow-methods':'GET, HEAD, OPTIONS','x-content-type-options':'nosniff'};
const respond=(d,status=200,ttl=0)=>new Response(JSON.stringify(d),{status,headers:{...cors,'content-type':'application/json; charset=utf-8','cache-control':ttl?'public, max-age='+ttl:'no-store'}});

/* ───────── formatting ───────── */
export function kstDay(ms){return new Date(ms+KST).toISOString().slice(0,10);}
export function fmtPrice(p){
  if(!fin(p))return '';
  const d=p>=10000?0:p>=100?1:p>=1?2:4;
  return p.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
}
/** 15,200,000 → "1,520만", 1,240,000,000 → "12.4억" (unit 달러 added by caller) */
export function fmtKrwUnit(v){
  if(!fin(v))return '';
  const a=Math.abs(v);
  if(a>=1e8){const x=v/1e8;return (Math.abs(x)>=100?Math.round(x).toLocaleString('en-US'):x.toFixed(1).replace(/\.0$/,''))+'억';}
  if(a>=1e4)return Math.round(v/1e4).toLocaleString('en-US')+'만';
  return Math.round(v).toLocaleString('en-US');
}
export const pct=(x,d=1)=>(x>0?'+':'')+x.toFixed(d)+'%';
const clip=(s,n)=>{s=String(s||'').replace(/\s+/g,' ').trim();return s.length>n?s.slice(0,n-1)+'…':s;};

/* ───────── detectors (pure) ───────── */
/** 15m bars → rolling 1h move on the last closed bar. */
export function detectMove(coin,bars15,th=DEFAULTS){
  if(!Array.isArray(bars15)||bars15.length<5)return null;
  const last=bars15.at(-1),base=bars15.at(-5).c,chg=(last.c/base-1)*100;
  const lim=coin==='BTC'||coin==='ETH'?th.move_major:th.move_alt;
  if(!(Math.abs(chg)>=lim))return null;
  const up=chg>0,t=last.t+900000;
  return {key:`move:${coin}:${up?'up':'down'}:${Math.floor(t/(2*HOUR))}`,t,kind:'lumex',tags:['price'],coins:[coin],
    importance:Math.abs(chg)>=2*lim?3:2,
    title:`${coin} 1시간 ${pct(chg)} ${up?'상승':'하락'}`,
    summary:`${coin}가 최근 1시간 동안 ${Math.abs(chg).toFixed(1)}% ${up?'올라':'내려'} ${fmtPrice(last.c)}달러를 기록했습니다.`,
    data:{change_1h_pct:+chg.toFixed(2),price:last.c}};
}
export function detectFunding(coin,ticker,now,th=DEFAULTS){
  const r=Number(ticker?.fundingRate)*100;
  if(!fin(r))return null;
  const hi=r>=th.funding_hi,lo=r<=th.funding_lo;
  if(!hi&&!lo)return null;
  const strong=hi?r>=2*th.funding_hi:r<=2*th.funding_lo;
  return {key:`funding:${coin}:${hi?'hi':'lo'}:${Math.floor(now/(8*HOUR))}`,t:now,kind:'lumex',tags:['funding'],coins:[coin],importance:strong?3:2,
    title:`${coin} 펀딩비 ${r.toFixed(3)}%로 ${hi?'높아짐':'마이너스'}`,
    summary:hi?`Bybit 기준 ${coin} 무기한 펀딩비가 ${r.toFixed(3)}%(8시간)입니다. 롱 포지션이 숏에게 비용을 내는 구간입니다.`
      :`Bybit 기준 ${coin} 무기한 펀딩비가 ${r.toFixed(3)}%(8시간)입니다. 숏 포지션이 롱에게 비용을 내는 구간입니다.`,
    data:{funding_pct:+r.toFixed(4)}};
}
/** Bybit open-interest 5min rows (newest last) → 1h change. */
export function detectOi(coin,rows,price,now,th=DEFAULTS){
  if(!Array.isArray(rows)||rows.length<13)return null;
  const a=rows.at(-13).oi,b=rows.at(-1).oi;
  if(!(a>0&&b>0))return null;
  const chg=(b/a-1)*100;
  if(!(Math.abs(chg)>=th.oi_1h))return null;
  const usd=fin(price)?b*price:null,up=chg>0;
  return {key:`oi:${coin}:${up?'up':'down'}:${Math.floor(now/(2*HOUR))}`,t:rows.at(-1).t,kind:'lumex',tags:['oi'],coins:[coin],importance:Math.abs(chg)>=2*th.oi_1h?3:2,
    title:`${coin} 미결제약정 1시간 ${pct(chg)}`,
    summary:`Bybit ${coin} 무기한 미결제약정이 1시간 동안 ${Math.abs(chg).toFixed(1)}% ${up?'늘었':'줄었'}습니다.${usd?` 현재 약 ${fmtKrwUnit(usd)} 달러 규모입니다.`:''}`,
    data:{oi_change_1h_pct:+chg.toFixed(2),oi_usd:usd&&Math.round(usd)}};
}
/** Gate 1h contract stats (oldest first) → last closed hour vs 24h average. */
export function detectLiq(coin,rows,th=DEFAULTS){
  if(!Array.isArray(rows)||rows.length<8)return null;
  const last=rows.at(-1),prev=rows.slice(0,-1),tot=r=>r.long+r.short;
  const avg=prev.reduce((s,r)=>s+tot(r),0)/prev.length,now=tot(last);
  if(!(now>=th.liq_min_usd&&avg>0&&now>=th.liq_mult*avg))return null;
  const longShare=now?last.long/now*100:0,t=last.t+HOUR;
  return {key:`liq:${coin}:${last.t}`,t,kind:'lumex',tags:['liquidation'],coins:[coin],importance:now>=5*avg?3:2,
    title:`${coin} 1시간 청산 ${fmtKrwUnit(now)} 달러 (롱 ${Math.round(longShare)}%)`,
    summary:`Gate 기준 최근 1시간 ${coin} 청산이 ${fmtKrwUnit(now)} 달러로 24시간 평균의 ${(now/avg).toFixed(1)}배입니다. 롱 ${fmtKrwUnit(last.long)} 달러, 숏 ${fmtKrwUnit(last.short)} 달러.`,
    data:{liq_usd:Math.round(now),long_usd:Math.round(last.long),short_usd:Math.round(last.short),avg_usd:Math.round(avg)}};
}
const shortAddr=a=>String(a||'').slice(0,6)+'…'+String(a||'').slice(-4);
export function detectWhale(row,now,th=DEFAULTS){
  const f=row?.profile?.last_fill;
  if(!f||!fin(f.value_usd)||f.value_usd<th.whale_usd||!fin(f.ts)||f.ts<now-30*60000||f.ts>now+60000)return null;
  const coin=String(f.coin||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,12);if(!coin)return null;
  const dir=String(f.direction||'');
  const label=/open long/i.test(dir)?'롱 진입':/open short/i.test(dir)?'숏 진입':/close long/i.test(dir)?'롱 정리':/close short/i.test(dir)?'숏 정리':f.side==='buy'?'매수':'매도';
  return {key:`whale:${row.address}:${f.id||f.ts}`,t:f.ts,kind:'lumex',tags:['whale'],coins:[coin],importance:f.value_usd>=4*th.whale_usd?3:2,
    title:`하이퍼리퀴드 고래 ${coin} ${label} ${fmtKrwUnit(f.value_usd)} 달러`,
    summary:`하이퍼리퀴드 상위 계정(${shortAddr(row.address)})이 ${coin}를 ${fmtPrice(f.price)}달러에 ${fmtKrwUnit(f.value_usd)} 달러어치 체결했습니다(${label}).`,
    data:{value_usd:Math.round(f.value_usd),price:f.price,address:row.address}};
}
/** LUMEX 4H chart signal on the newest closed 4H bar (same rule as the chart / paper league). */
export function detectSignal(coin,bars4h){
  if(!Array.isArray(bars4h)||bars4h.length<120)return null;
  const n=chartReplay(bars4h).next;
  if(!n||!(n.action==='enter'||n.action==='reverse'))return null;
  const last=bars4h.at(-1),t=last.t+4*HOUR,long=n.side==='long';
  return {key:`signal:${coin}:${last.t}`,t,kind:'lumex',tags:['signal'],coins:[coin],importance:2,
    title:`LUMEX 4시간 신호 · ${coin} ${long?'롱':'숏'}`,
    summary:`4시간봉 마감 기준 ${coin}에 LUMEX 차트 ${long?'롱':'숏'} 신호가 나왔습니다. 신호 가격 ${fmtPrice(last.c)}달러.`,
    data:{side:n.side,price:last.c}};
}
/** Crypto media RSS. Keys are what Core stores in its on/off list — do not rename. */
export const SOURCES=Object.freeze([
  {key:'blockmedia',name:'블록미디어',lang:'ko',url:'https://www.blockmedia.co.kr/feed',host:/(^|\.)blockmedia\.co\.kr$/},
  {key:'beincrypto_kr',name:'비인크립토',lang:'ko',url:'https://kr.beincrypto.com/feed/',host:/(^|\.)beincrypto\.com$/},
  {key:'coindesk',name:'CoinDesk',lang:'en',url:'https://www.coindesk.com/arc/outboundfeeds/rss/?outputType=xml',host:/(^|\.)coindesk\.com$/},
  {key:'cointelegraph',name:'Cointelegraph',lang:'en',url:'https://cointelegraph.com/rss',host:/(^|\.)cointelegraph\.com$/},
  {key:'decrypt',name:'Decrypt',lang:'en',url:'https://decrypt.co/feed',host:/(^|\.)decrypt\.co$/},
  {key:'theblock',name:'The Block',lang:'en',url:'https://www.theblock.co/rss.xml',host:/(^|\.)theblock\.co$/},
]);
const COIN_WORDS={BTC:/\bBTC\b|비트코인|\bBitcoin\b/i,ETH:/\bETH\b|이더리움|\bEther(eum)?\b/i,SOL:/\bSOL\b|솔라나|\bSolana\b/i,XRP:/\bXRP\b|리플|\bRipple\b/i};
const ENT={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',hellip:'…',mdash:'—',ndash:'–',lsquo:'‘',rsquo:'’',ldquo:'“',rdquo:'”'};
export function xmlText(s){
  s=String(s||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]*>/g,'');
  return s.replace(/&#x([0-9a-f]+);/gi,(_,h)=>String.fromCodePoint(parseInt(h,16))).replace(/&#(\d+);/g,(_,d)=>String.fromCodePoint(+d))
    .replace(/&([a-z]+);/gi,(m,n)=>ENT[n.toLowerCase()]??m).replace(/\s+/g,' ').trim();
}
const tag=(blk,name)=>{const m=blk.match(new RegExp('<'+name+'(?:\\s[^>]*)?>([\\s\\S]*?)</'+name+'>','i'));return m?m[1]:'';};
export function coinsIn(title){return COINS.filter(c=>COIN_WORDS[c].test(title));}
/** RSS XML → article candidates (title + link + byline + time). Links must be https on the source's own host. */
export function parseRss(xml,src,now){
  const out=[];if(typeof xml!=='string')return out;
  for(const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)){
    if(out.length>=20)break;
    const blk=m[0],title=clip(xmlText(tag(blk,'title')),200);
    let link=xmlText(tag(blk,'link'));if(!link){const g=xmlText(tag(blk,'guid'));if(/^https:\/\//.test(g))link=g;}
    let url=null;try{const u=new URL(link);if(u.protocol==='https:'&&src.host.test(u.hostname)){u.hash='';url=u.href;}}catch{}
    const t=Date.parse(xmlText(tag(blk,'pubDate'))||xmlText(tag(blk,'dc:date')));
    if(!title||!url||!fin(t)||t>now+HOUR||t<now-48*HOUR)continue;
    const author=clip(xmlText(tag(blk,'dc:creator'))||xmlText(tag(blk,'author')),40);
    out.push({key:'rss:'+url,t,kind:'news',src:src.key,lang:src.lang,tags:['article'],coins:coinsIn(title),importance:1,source:src.name,
      title,summary:'',url,data:author?{author}:{}});
  }
  return out;
}
export function fromOfficial(snapshot,now){
  if(!snapshot?.ok||!Array.isArray(snapshot.items))return [];
  return snapshot.items.filter(x=>fin(x?.published_ms)&&x.published_ms>now-3*86400000&&x.source_url).slice(0,20).map(x=>({
    key:'official:'+x.source_url,t:x.published_ms,kind:'macro',tags:[String(x.kind||'macro')],coins:[],
    importance:x.kind==='monetary_policy'?3:2,source:String(x.agency||'공식 발표').slice(0,40),
    lang:'en',title:clip(x.title_original,200),summary:clip(x.description_ko,160),url:x.source_url,data:{}}));
}

/* ───────── merge (pure) ───────── */
/** New candidates into the feed: dedupe by key, assign ids YYYYMMDD-NNNN (KST day of collection), keep newest 400. */
export function mergeFeed(feed,candidates,prices,now){
  const f=feed&&feed.schema===SCHEMA?feed:{schema:SCHEMA,items:[],keys:{},seq_day:'',seq:0};
  const keys=Object.fromEntries(Object.entries(f.keys||{}).filter(([,t])=>t>now-KEY_TTL));
  const day=kstDay(now).replaceAll('-','');
  let seq=f.seq_day===day?f.seq:0;const added=[];
  for(const c of candidates.sort((a,b)=>a.t-b.t)){
    if(!c||keys[c.key])continue;
    keys[c.key]=now;seq++;
    const ref={};for(const coin of c.coins||[])if(fin(prices?.[coin]))ref[coin]=prices[coin];
    added.push({id:day+'-'+String(seq).padStart(4,'0'),key:c.key,t:Math.min(c.t,now),created_ms:now,kind:c.kind,
      source:c.source||'LUMEX 감지',src:c.src||null,lang:c.lang||'ko',tags:c.tags||[],coins:c.coins||[],importance:c.importance||1,
      title:c.title,summary:c.summary||'',url:c.url||null,ref_price:ref,after_1h:null,data:c.data||{}});
  }
  const items=[...added.reverse(),...(f.items||[])].slice(0,FEED_MAX);
  // 1시간 뒤 가격: filled once, on the first run 60~80 min after the item.
  for(const it of items){
    if(it.after_1h||!it.coins?.length)continue;
    const age=now-it.created_ms;
    if(age>=HOUR&&age<=80*60000){const a={};for(const c of it.coins)if(fin(prices?.[c]))a[c]=prices[c];if(Object.keys(a).length)it.after_1h={at_ms:now,price:a};}
  }
  return {feed:{schema:SCHEMA,updated_ms:now,seq_day:day,seq,items,keys,prices:prices||{}},added};
}

/* ───────── collection ───────── */
async function getJson(fetchImpl,url,maxLen=600000,init={}){
  const r=await fetchImpl(url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(7000),...init});
  if(!r.ok)throw Error('http_'+r.status);
  const t=await r.text();if(t.length<2||t.length>maxLen)throw Error('size');
  return JSON.parse(t);
}
async function r2json(bucket,key){try{const o=await bucket.get(key);return o?await o.json():null;}catch{return null;}}
export async function readThresholds(env){
  try{const x=JSON.parse(env?.NEWS_THRESHOLDS||'{}');return {...DEFAULTS,...Object.fromEntries(Object.entries(x).filter(([k,v])=>k in DEFAULTS&&fin(Number(v))).map(([k,v])=>[k,Number(v)]))};}
  catch{return {...DEFAULTS};}
}
export async function collectNews(env,{now=Date.now(),fetchImpl=fetch}={}){
  const bucket=env?.MARKET_DATA;if(!bucket)return {ok:false,reason:'r2_missing'};
  const th=await readThresholds(env),m=makeMarket(fetchImpl,now),cand=[],errors={};
  const prices={},note=(k,e)=>{errors[k]=String(e?.message||e).slice(0,50);};
  await Promise.all(COINS.map(async coin=>{
    const sym=coin+'USDT';
    try{const b=parseKlines(await getJson(fetchImpl,`https://api.bybit.com/v5/market/kline?category=linear&symbol=${sym}&interval=15&limit=8`,40000),900000,now);if(b?.length){prices[coin]=b.at(-1).c;const x=detectMove(coin,b,th);if(x)cand.push(x);}}catch(e){note('move_'+coin,e);}
    try{const raw=await getJson(fetchImpl,`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${sym}`,20000);
      const tk=raw?.retCode===0?raw.result?.list?.[0]:null;if(tk){const lp=Number(tk.lastPrice);if(lp>0)prices[coin]=lp;const x=detectFunding(coin,tk,now,th);if(x)cand.push(x);}}catch(e){note('funding_'+coin,e);}
    try{const raw=await getJson(fetchImpl,`https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${sym}&intervalTime=5min&limit=13`,40000);
      const rows=raw?.retCode===0?raw.result.list.map(x=>({t:Number(x.timestamp),oi:Number(x.openInterest)})).filter(x=>fin(x.t)&&x.oi>0).sort((a,b)=>a.t-b.t):null;
      const x=detectOi(coin,rows,prices[coin],now,th);if(x)cand.push(x);}catch(e){note('oi_'+coin,e);}
  }));
  for(const coin of ['BTC','ETH']){
    try{const raw=await getJson(fetchImpl,`https://api.gateio.ws/api/v4/futures/usdt/contract_stats?contract=${coin}_USDT&interval=1h&limit=26`,200000);
      const rows=(Array.isArray(raw)?raw:[]).map(r=>({t:Number(r.time)*1000,long:Number(r.long_liq_usd),short:Number(r.short_liq_usd)}))
        .filter(r=>fin(r.t)&&r.long>=0&&r.short>=0&&r.t+HOUR<=now).sort((a,b)=>a.t-b.t).slice(-25);
      const x=detectLiq(coin,rows,th);if(x)cand.push(x);}catch(e){note('liq_'+coin,e);}
    // LUMEX 4H signal: only right after a 4H close (first 15 minutes) to keep requests low.
    if(now%(4*HOUR)<15*60000){try{const b=await m.bars(coin+'USDT','240',200);const x=detectSignal(coin,b);if(x)cand.push(x);}catch(e){note('signal_'+coin,e);}}
  }
  const whales=await r2json(bucket,'market-hub/hyperliquid-whales/v1/latest.json');
  for(const row of whales?.rows||[]){const x=detectWhale(row,now,th);if(x)cand.push(x);}
  const rss={};
  if(now%(10*60000)<5*60000){ // articles: every 10 minutes
    await Promise.all(SOURCES.map(async src=>{
      try{const r=await fetchImpl(src.url,{headers:{accept:'application/rss+xml, application/xml, text/xml'},signal:AbortSignal.timeout(8000)});
        if(!r.ok)throw Error('http_'+r.status);const xml=await r.text();if(xml.length>3e6)throw Error('size');
        const list=parseRss(xml,src,now);cand.push(...list);rss[src.key]={ok:true,items:list.length};}
      catch(e){rss[src.key]={ok:false,error:String(e?.message||e).slice(0,50)};}
    }));
  }
  cand.push(...fromOfficial(await r2json(bucket,'market-hub/official-news/v1/latest.json'),now));
  const feed=await r2json(bucket,ROOT+'feed.json');
  const {feed:next,added}=mergeFeed(feed,cand,prices,now);
  await bucket.put(ROOT+'feed.json',JSON.stringify(next),{httpMetadata:{contentType:'application/json'}});
  if(added.length){
    const byDay={};for(const it of added){const d=it.id.slice(0,8);(byDay[d]||=[]).push(it);}
    for(const [d,list] of Object.entries(byDay)){
      const key=ROOT+'day/'+d+'.json',old=await r2json(bucket,key);
      await bucket.put(key,JSON.stringify({schema:SCHEMA,day:d,items:[...list,...(old?.items||[])].slice(0,2000)}),{httpMetadata:{contentType:'application/json'}});
    }
  }
  let sources=null;
  if(Object.keys(rss).length){sources=rss;await bucket.put(ROOT+'sources.json',JSON.stringify({at_ms:now,sources:rss}),{httpMetadata:{contentType:'application/json'}});}
  await bucket.put(ROOT+'health.json',JSON.stringify({ok:true,at_ms:now,added:added.length,candidates:cand.length,errors,sources}),{httpMetadata:{contentType:'application/json'}});
  return {ok:true,added:added.length,errors};
}

/* ───────── public API ───────── */
// Exchange notices collected before Phase 108 stay in R2 history but are never listed.
const TABS={all:i=>i.kind!=='exchange',news:i=>i.kind==='news',lumex:i=>i.kind==='lumex',macro:i=>i.kind==='macro'};
/** Articles are listed only for sources Core passes in src= (its 운영센터 on-list). No src= → no articles. */
export function srcFilter(raw){const on=new Set(String(raw||'').split(',').map(x=>x.trim()).filter(x=>SOURCES.some(s=>s.key===x)));return i=>i.kind!=='news'||on.has(i.src);}
export function publicItem(it,prices){
  const now_change={};
  for(const c of it.coins||[]){const a=it.ref_price?.[c],b=prices?.[c];if(fin(a)&&fin(b)&&a>0)now_change[c]=+((b/a-1)*100).toFixed(2);}
  const after={};
  if(it.after_1h)for(const c of it.coins||[]){const a=it.ref_price?.[c],b=it.after_1h.price?.[c];if(fin(a)&&fin(b)&&a>0)after[c]=+((b/a-1)*100).toFixed(2);}
  return {id:it.id,t:it.t,kind:it.kind,source:it.source,src:it.src||null,lang:it.lang||'ko',tags:it.tags,coins:it.coins,importance:it.importance,title:it.title,summary:it.summary,url:it.url,
    ref_price:it.ref_price,change_since_pct:now_change,change_1h_after_pct:Object.keys(after).length?after:null,data:it.data};
}
export function listView(feed,{tab='all',before='',limit=20,src=''}={}){
  const f=TABS[tab]||TABS.all,on=srcFilter(src);let items=(feed?.items||[]).filter(i=>f(i)&&on(i));
  if(/^\d{8}-\d{4}$/.test(before))items=items.filter(i=>i.id<before);
  const page=items.slice(0,Math.max(1,Math.min(50,limit)));
  return {ok:true,schema:'lumex_public_news_v1',updated_ms:feed?.updated_ms||null,tab,items:page.map(i=>publicItem(i,feed?.prices)),
    next:items.length>page.length?page.at(-1).id:null,prices:feed?.prices||{}};
}
export async function newsRoute(request,env){
  const url=new URL(request.url),bucket=env?.MARKET_DATA;
  if(!bucket)return respond({ok:false,error:'unavailable'},503);
  const feed=await r2json(bucket,ROOT+'feed.json');
  const m=url.pathname.match(/^\/market-hub\/v1\/news\/item\/(\d{8}-\d{4})$/);
  if(m){
    const id=m[1];let it=(feed?.items||[]).find(i=>i.id===id);
    if(!it){const day=await r2json(bucket,ROOT+'day/'+id.slice(0,8)+'.json');it=(day?.items||[]).find(i=>i.id===id);}
    if(!it)return respond({ok:false,error:'not_found'},404);
    if(it.kind==='exchange')return respond({ok:false,error:'not_found'},404);
    const on=srcFilter(url.searchParams.get('src'));
    const related=(feed?.items||[]).filter(i=>i.id!==id&&i.kind!=='exchange'&&on(i)&&i.coins?.some(c=>it.coins?.includes(c))).slice(0,3).map(i=>publicItem(i,feed?.prices));
    return respond({ok:true,schema:'lumex_public_news_item_v1',item:publicItem(it,feed?.prices),related},200,60);
  }
  if(url.pathname==='/market-hub/v1/news'){
    if(!feed)return respond({ok:true,schema:'lumex_public_news_v1',items:[],next:null,prices:{}},200,30);
    return respond(listView(feed,{tab:url.searchParams.get('tab')||'all',before:url.searchParams.get('before')||'',limit:Number(url.searchParams.get('limit')||20),src:url.searchParams.get('src')||''}),200,30);
  }
  if(url.pathname==='/market-hub/v1/news/sources'){
    const h=await r2json(bucket,ROOT+'sources.json');
    return respond({ok:true,schema:'lumex_news_sources_v1',at_ms:h?.at_ms||null,sources:SOURCES.map(s=>({key:s.key,name:s.name,lang:s.lang,feed:s.url,last:h?.sources?.[s.key]||null}))},200,60);
  }
  return respond({ok:false,error:'not_found'},404);
}
