/** LUMEX 공개 기록 (Phase 111, 2026-11-27) — read-only records for the customer-acquisition pages.
 *
 * 1) LUMEX 신호 기록: the chart's 4H signal rule (paper-league-chartsig.mjs replay, same code as the chart and the
 *    SIGNAL paper account) replayed over the last 1,000 closed Bybit 4H bars of BTC·ETH·SOL·XRP. Every finished
 *    trade is listed, losses included. Results are per trade on 1x notional, entry at the next bar's open,
 *    Bybit taker fee 0.055 % per side (0.11 % round trip) deducted. A trade still open is shown only as
 *    "진행 중" with its start time (direction and prices stay PRO).
 *    Recomputed only when a new 4H bar has closed (5-minute cron); page visits never call Bybit.
 *
 * 2) 고래 진입 사례: positions of US$1M+ opened by the tracked Hyperliquid leaderboard accounts (hyperliquid-whales
 *    collector profiles, public userFills), with the Bybit price 1 h · 4 h · 24 h later. Every case is kept,
 *    including the ones where price went against the whale. Observation only — no orders, no keys.
 */
import {makeMarket} from './paper-league.mjs';
import {replay} from './paper-league-chartsig.mjs';

export const ROOT='market-hub/growth/v1/';
export const RECORD_COINS=['BTC','ETH','SOL','XRP'];
export const FEE_ROUND_PCT=0.11;
export const WHALE_MIN_USD=1000000;
const H4=4*3600000,HOUR=3600000,MIN=60000,KST=9*HOUR,DAY=24*HOUR;
const fin=x=>typeof x==='number'&&Number.isFinite(x);
const r2=x=>fin(x)?Math.round(x*100)/100:null;
const r4=x=>fin(x)?Math.round(x*1e4)/1e4:null;
const json=(body,status=200,age=60)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'public, max-age='+age,'x-content-type-options':'nosniff'}});
async function rget(bucket,key){const o=await bucket.get(ROOT+key);return o?await o.json():null;}
async function rput(bucket,key,x){await bucket.put(ROOT+key,JSON.stringify(x),{httpMetadata:{contentType:'application/json'}});}

/* ───────────────────────────── 1) signal record ───────────────────────────── */
/** KST id for a trade: btc-20261125-17 (coin, KST date and hour of the entry bar). */
export function tradeId(coin,entryT){const d=new Date(entryT+KST);
  return coin.toLowerCase()+'-'+d.toISOString().slice(0,10).replace(/-/g,'')+'-'+String(d.getUTCHours()).padStart(2,'0');}

/** Pure: finished trades + the open one from replay events. bars ascending {t,o,h,l,c}. */
export function tradesFromBars(coin,bars){
  const rp=replay(bars),trades=[];let cur=null,lastSignal=null;
  for(const e of rp.events){
    if(e.type==='signal'){lastSignal=e;continue;}
    if(e.type==='entry'){
      const sig=lastSignal&&lastSignal.side===e.side&&e.t-lastSignal.t===H4?lastSignal:null;
      cur={id:tradeId(coin,e.t),coin,side:e.side,signal_t:sig?sig.t:e.t-H4,signal_close:sig?sig.price:null,reversal:!sig,
        entry_t:e.t,entry:e.price,stop:r4(e.sl),tp1:r4(e.tp1),tp1_t:null,events:[{t:e.t,type:'entry',price:e.price}]};
      lastSignal=null;continue;
    }
    if(!cur)continue;
    if(e.type==='tp1'){cur.tp1_t=e.t;cur.events.push({t:e.t,type:'tp1',price:r4(e.price),frac:e.frac});continue;}
    if(['stop','breakeven','exit'].includes(e.type)){
      cur.events.push({t:e.t,type:e.type,price:r4(e.price),frac:e.frac});
      const gross=e.result_pct,net=gross-FEE_ROUND_PCT;
      Object.assign(cur,{exit_t:e.t,exit:r4(e.price),outcome:e.type,gross_pct:r4(gross),net_pct:r4(net),
        result:net>0?'win':'loss',hours:Math.round((e.t-cur.entry_t)/HOUR)});
      trades.push(cur);cur=null;
    }
  }
  const open=rp.open?{coin,since_t:rp.open.entry_t}:null;
  return {trades,open};
}
/** Pure: summary over finished trades (net of fees). */
export function recordStats(trades){
  const n=trades.length,w=trades.filter(t=>t.net_pct>0),l=trades.filter(t=>t.net_pct<=0);
  const avg=a=>a.length?r2(a.reduce((s,t)=>s+t.net_pct,0)/a.length):null;
  const sum=r2(trades.reduce((s,t)=>s+t.net_pct,0));
  return {trades:n,wins:w.length,losses:l.length,win_rate_pct:n?r2(w.length/n*100):null,avg_win_pct:avg(w),avg_loss_pct:avg(l),avg_pct:avg(trades),
    sum_pct:n?sum:null,best_pct:n?r2(Math.max(...trades.map(t=>t.net_pct))):null,worst_pct:n?r2(Math.min(...trades.map(t=>t.net_pct))):null,
    avg_hours:n?Math.round(trades.reduce((s,t)=>s+t.hours,0)/n):null};
}
/** Pure: the whole record from bars by coin. */
export function buildRecord(barsBy,now){
  const all=[],open=[],coins={};let lastBar=0,first=Infinity;
  for(const coin of RECORD_COINS){
    const bars=barsBy[coin];if(!Array.isArray(bars)||bars.length<200)continue;
    const r=tradesFromBars(coin,bars);all.push(...r.trades);if(r.open)open.push(r.open);
    coins[coin]={bars:bars.length,from_t:bars[0].t,last_bar_t:bars.at(-1).t,stats:recordStats(r.trades),open:Boolean(r.open)};
    lastBar=Math.max(lastBar,bars.at(-1).t);first=Math.min(first,bars[51]?.t??bars[0].t);
  }
  all.sort((a,b)=>b.exit_t-a.exit_t);
  const since=d=>all.filter(t=>t.exit_t>=now-d*DAY);
  return {ok:Object.keys(coins).length===RECORD_COINS.length,schema:'lumex_signal_record_v1',updated_ms:now,last_bar_t:lastBar,from_t:fin(first)?first:null,
    rule:'EMA20·EMA50 교차 + RSI14 확인, 다음 봉 시가 진입, 손절 ATR14 1배, ATR 1배에서 절반 익절 후 손절을 진입가로, 나머지는 반대 신호에 청산',
    fee_round_pct:FEE_ROUND_PCT,interval:'240',source:'Bybit USDT 무기한 4시간봉(마감된 봉)',
    stats:{d30:recordStats(since(30)),d90:recordStats(since(90)),all:recordStats(all)},coins,open,trades:all};
}
async function fetchBars(fetchImpl,now){
  const m=makeMarket(fetchImpl,now),out={};
  await Promise.all(RECORD_COINS.map(async c=>{out[c]=await m.bars(c+'USDT','240',1000);}));
  return out;
}
/** 5-minute cron: recompute once per closed 4H bar. */
export async function collectSignalRecord(env,{now=Date.now(),fetchImpl=fetch}={}){
  const bucket=env?.MARKET_DATA;if(!bucket)return {ok:false,reason:'r2_missing'};
  const old=await rget(bucket,'signal-record.json').catch(()=>null);
  if(old?.ok&&old.last_bar_t&&now<old.last_bar_t+2*H4+60000)return {ok:true,stage:'fresh'};
  const barsBy=await fetchBars(fetchImpl,now);
  const rec=buildRecord(barsBy,now);
  if(!rec.ok)return {ok:false,reason:'bars_incomplete'};
  for(const c of RECORD_COINS)await rput(bucket,'signal-bars/'+c+'.json',{coin:c,bars:barsBy[c].map(b=>[b.t,b.o,b.h,b.l,b.c])});
  await rput(bucket,'signal-record.json',rec);
  return {ok:true,stage:'computed',trades:rec.trades.length};
}
/** One trade with the candles around it (up to 30 bars before entry, 8 after exit, max 110). */
export function tradeWindow(trade,bars){
  const i0=bars.findIndex(b=>b[0]===trade.entry_t),i1=bars.findIndex(b=>b[0]===trade.exit_t);
  if(i0<0||i1<0)return null;
  let a=Math.max(0,i0-30),b=Math.min(bars.length,i1+9);if(b-a>110)a=Math.max(0,b-110);
  return bars.slice(a,b);
}

/* ───────────────────────────── 2) whale cases ───────────────────────────── */
const OPEN_DIR={'Open Long':'long','Open Short':'short','Short > Long':'long','Long > Short':'short'};
/** Hyperliquid coin → Bybit linear symbol (kPEPE → 1000PEPEUSDT). null for spot/HIP-3 names. */
export function bybitSymbol(coin){
  if(typeof coin!=='string'||!/^k?[A-Z0-9]{2,15}$/.test(coin))return null;
  return coin.startsWith('k')?'1000'+coin.slice(1)+'USDT':coin+'USDT';
}
/** Pure: new cases from one tracked profile. */
export function casesFromProfile(profile,row,now,seen){
  const out=[];
  for(const f of Array.isArray(profile?.fills)?profile.fills:[]){
    const side=OPEN_DIR[f?.direction];if(!side||seen.has(String(f.id)))continue;
    const value=Number(f.value_usd),ts=Number(f.ts),px=Number(f.price);
    if(!(value>=WHALE_MIN_USD)||!Number.isSafeInteger(ts)||ts>now+120000||ts<now-7*DAY||!(px>0))continue;
    const symbol=bybitSymbol(f.coin);if(!symbol)continue;
    out.push({id:String(f.id),address:profile.address,coin:f.coin,symbol,side,direction:f.direction,ts,price:px,size:Number(f.size),value_usd:Math.round(value),
      equity_usd:fin(row?.equity_usd)?Math.round(row.equity_usd):null,month_pnl_usd:fin(row?.windows?.month?.pnl_usd)?Math.round(row.windows.month.pnl_usd):null,
      base:null,after:{h1:null,h4:null,h24:null},tries:0,status:'pending'});
  }
  return out;
}
export const CHECKS={h1:HOUR,h4:4*HOUR,h24:DAY};
/** Bybit 1-minute open at minute T. Returns number, null (no bar yet/missing) or false (no such market). */
export async function priceAt(fetchImpl,symbol,T){
  const t=Math.floor(T/MIN)*MIN;
  const r=await fetchImpl(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=1&start=${t}&end=${t}&limit=1`,{headers:{accept:'application/json'},signal:AbortSignal.timeout(6000)});
  if(!r.ok)return null;const j=await r.json();
  if(j?.retCode!==0)return j?.retCode===10001?false:null;
  const row=(j.result?.list||[]).find(x=>Number(x?.[0])===t);const o=Number(row?.[1]);
  return o>0?o:null;
}
/** Pure: fill one checkpoint. */
export function applyCheck(c,key,price){
  if(!(c.base>0)||!(price>0))return c;
  const move=(price/c.base-1)*100;
  c.after[key]={price,move_pct:r2(move),with_whale_pct:r2(c.side==='long'?move:-move)};
  return c;
}
export function caseStats(items){
  const done=items.filter(c=>c.after?.h24),h1=items.filter(c=>c.after?.h1);
  const avg=(a,k)=>a.length?r2(a.reduce((s,c)=>s+c.after[k].with_whale_pct,0)/a.length):null;
  const w24=done.filter(c=>c.after.h24.with_whale_pct>0).length,w1=h1.filter(c=>c.after.h1.with_whale_pct>0).length;
  return {cases:items.length,checked_24h:done.length,with_whale_24h:w24,with_whale_24h_pct:done.length?r2(w24/done.length*100):null,avg_24h_pct:avg(done,'h24'),
    checked_1h:h1.length,with_whale_1h:w1,with_whale_1h_pct:h1.length?r2(w1/h1.length*100):null,avg_1h_pct:avg(h1,'h1')};
}
/** 5-minute cron: scan 8 tracked profiles, open new cases, fill up to 8 due price checks. */
export async function collectWhaleCases(env,{now=Date.now(),fetchImpl=fetch}={}){
  const bucket=env?.MARKET_DATA;if(!bucket)return {ok:false,reason:'r2_missing'};
  const st=(await rget(bucket,'whale-cases.json').catch(()=>null))||{items:[],cursor:0};
  const board=await bucket.get('market-hub/hyperliquid-whales/v1/latest.json').then(o=>o?o.json():null).catch(()=>null);
  const rows=Array.isArray(board?.rows)?board.rows:[];const seen=new Set(st.items.map(c=>c.id));let added=0;
  for(let k=0;k<Math.min(8,rows.length);k++){
    const row=rows[(Number(st.cursor||0)+k)%rows.length];
    const prof=await bucket.get('market-hub/hyperliquid-whales/v1/profiles/'+row.address+'.json').then(o=>o?o.json():null).catch(()=>null);
    for(const c of casesFromProfile(prof,row,now,seen)){st.items.push(c);seen.add(c.id);added++;}
  }
  st.cursor=rows.length?(Number(st.cursor||0)+8)%rows.length:0;
  let calls=0;
  for(const c of st.items.filter(x=>x.status==='pending').sort((a,b)=>a.ts-b.ts)){
    if(calls>=8)break;
    if(!(c.base>0)){calls++;const p=await priceAt(fetchImpl,c.symbol,c.ts).catch(()=>null);
      if(p===false){c.status='no_market';continue;}
      if(p>0)c.base=p;else if(++c.tries>=4){c.status='missing';continue;}else continue;}
    for(const [k,ms] of Object.entries(CHECKS)){
      if(c.after[k]||now<c.ts+ms+2*MIN||calls>=8)continue;
      calls++;const p=await priceAt(fetchImpl,c.symbol,c.ts+ms).catch(()=>null);
      if(p>0)applyCheck(c,k,p);else if(now>c.ts+ms+3*HOUR)c.after[k]={missing:true};
    }
    if(c.after.h24)c.status=c.after.h24.missing?'missing':'done';
  }
  st.items=st.items.filter(c=>c.status!=='no_market'&&!(c.status!=='pending'&&c.ts<now-120*DAY))
    .sort((a,b)=>b.ts-a.ts).slice(0,400);
  st.updated_ms=now;
  await rput(bucket,'whale-cases.json',st);
  return {ok:true,added,calls};
}

/* ───────────────────────────── public routes ───────────────────────────── */
const publicCase=c=>({id:c.id,address:c.address,coin:c.coin,side:c.side,ts:c.ts,price:c.price,value_usd:c.value_usd,equity_usd:c.equity_usd,
  month_pnl_usd:c.month_pnl_usd,base:c.base,after:{h1:c.after.h1?.missing?null:c.after.h1,h4:c.after.h4?.missing?null:c.after.h4,h24:c.after.h24?.missing?null:c.after.h24},status:c.status});
export async function growthRoute(request,env){
  const u=new URL(request.url),bucket=env?.MARKET_DATA;
  if(request.method!=='GET'||!bucket)return json({ok:false,error:'invalid_request'},400);
  if(u.pathname==='/market-hub/v1/chart-signals/record'){
    const rec=await rget(bucket,'signal-record.json');if(!rec?.ok)return json({ok:false,error:'not_collected'},503,30);
    return json(rec,200,300);
  }
  if(u.pathname==='/market-hub/v1/chart-signals/trade'){
    const id=u.searchParams.get('id')||'';if(!/^[a-z]{2,6}-\d{8}-\d{2}$/.test(id))return json({ok:false,error:'invalid_id'},400);
    const rec=await rget(bucket,'signal-record.json');if(!rec?.ok)return json({ok:false,error:'not_collected'},503,30);
    const t=rec.trades.find(x=>x.id===id);if(!t)return json({ok:false,error:'not_found'},404,300);
    const b=await rget(bucket,'signal-bars/'+t.coin+'.json');const w=b?tradeWindow(t,b.bars):null;
    const same=rec.trades.filter(x=>x.coin===t.coin&&x.id!==id).slice(0,6);
    return json({ok:true,schema:'lumex_signal_trade_v1',trade:t,bars:w,same_coin:same,source:rec.source,fee_round_pct:rec.fee_round_pct,rule:rec.rule},200,600);
  }
  if(u.pathname==='/market-hub/v1/whale-cases'){
    const st=await rget(bucket,'whale-cases.json');if(!st?.items)return json({ok:false,error:'not_collected'},503,30);
    const items=st.items.filter(c=>c.status==='done'||c.status==='pending');
    return json({ok:true,schema:'lumex_whale_cases_v1',updated_ms:st.updated_ms,min_usd:WHALE_MIN_USD,source:'Hyperliquid 상위 계정 체결 · Bybit 1분봉 가격',
      stats:caseStats(items),items:items.slice(0,200).map(publicCase)},200,120);
  }
  return json({ok:false,error:'not_found'},404);
}
