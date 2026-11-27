/** LUMEX AI 봇 주식 계좌 (Phase 120, 2026-11-28) — forward-only simulated accounts on Bybit stock·ETF perpetuals.
 * NO real orders. Stock section only: its own R2 keys (stock-league/v1/), its own routes, never listed with the coin
 * paper league.
 *
 * Engine: the coin paper league's accounting and execution model, unchanged (paper-league.mjs):
 *   decisions on newly CLOSED bars, fills at the Bybit last price at the next 5-minute tick ± slippage + taker fee,
 *   stops / partial take on 1-minute bars between ticks (gaps fill at the minute's open), Bybit funding history
 *   applied to held positions, missed bars never replayed.
 * Bybit stock perpetuals trade around the clock (1H/4H bars are continuous, checked 2026-11-28), so the rule runs on
 * every bar; bars outside the US regular session are marked on the charts, not skipped.
 *
 * Bot 1 · 차트 신호 4H: the LUMEX stock chart's 가상 매매 rule (same as the coin chart, Theme computeSignals), on
 * closed 4H bars of the 10 most traded stock perpetuals at the account's start (list kept in the state).
 * The account starts at 10,000 USDT on its own start date. No backtest number is stored or shown.
 */
import {makeMarket,newAccount,runStrategy,markEquity,summarize,START_USDT,TAKER} from './paper-league.mjs';
import {decideCoin,MIN_BARS,TP1_FRAC} from './paper-league-chartsig.mjs';

const ROOT='stock-league/v1/';
const STATE=ROOT+'state.json',HIST=ROOT+'history/',STATUS=ROOT+'status.json';
const MIN=60000,HOUR=3600000;
const rd=(x,d=8)=>Number(Number(x).toFixed(d));
export const BASKET_SIZE=10;

/** Bot definitions use the basket fixed in the state (symbols do not drift with daily turnover). */
export function stockStrategies(basket){
  const syms=Array.isArray(basket)?basket.slice(0,BASKET_SIZE):[];
  const label=syms.slice(0,3).map(s=>s.replace(/USDT$/,'')).join('·')+(syms.length>3?` 등 ${syms.length}종목`:'');
  return [{id:'stock-chart-4h',origin:'new',tier:'advanced',ai:false,name:'주식 차트 신호 4H',family:'루멕스 주식 차트 가상 매매 신호 추종(롱·숏)',risk:'균형형',kind:'trend',
    interval:'240',interval_label:'4H',symbols_label:label,symbols:syms,resize:false,
    summary:'루멕스 주식 차트의 4시간봉 가상 매매 신호를 그대로 따라갑니다. 1차 익절에서 절반을 정리하고 손절을 진입가로 올린 뒤, 나머지는 반대 신호까지 들고 갑니다.',
    rules:['진입: 4시간봉 마감 때 EMA20이 EMA50을 위로(아래로) 넘고 RSI14가 50 이상(이하)이면 다음 봉 시가에 롱(숏)','손절: 진입가에서 ATR14 1배','1차 익절: ATR14 1배 도달 시 50% 익절, 손절을 진입가로 이동','나머지 50%: 반대 신호에 청산, RSI가 맞으면 반대 방향 진입','종목별 자금 10%, 10종목 합계 1배 이하'],
    async decide({market,acc}){
      const target=[],diag={},missing=[];let ok=0,exitWhy=null;
      for(const s of syms){
        const bars=await market.bars(s,'240',1000);
        if(!bars||bars.length<MIN_BARS){diag[s]={error:'bars'};missing.push(s);continue;}
        const held=acc?.positions?.[s]?.side||null,d=decideCoin(bars.map(b=>({t:b.t,o:b.o,h:b.h,l:b.l,c:b.c})),held);
        if(d.error){diag[s]={error:d.error};missing.push(s);continue;}
        ok++;diag[s]={want:d.want,fresh:!!d.fresh};
        if(d.why&&held&&!d.want)exitWhy=d.why;
        if(!d.want)continue;
        if(d.fresh)target.push({symbol:s,side:d.want,weight:1/BASKET_SIZE,stop_pct:d.stop_pct,take_pct:d.take_pct,take_frac:TP1_FRAC,be_after_take:true,reason:d.why});
        else if(held===d.want)target.push({symbol:s,side:d.want,weight:1/BASKET_SIZE,reason:'보유 유지'});
      }
      if(ok<syms.length/2)return {error:'4시간봉 자료 부족'};
      const longs=target.filter(l=>l.side==='long').length;
      return {target,note:`롱 ${longs} · 숏 ${target.length-longs}`,diag,keep_missing:missing,exit_reason:exitWhy||'차트 신호 청산'};
    }}];
}

/** Ten most traded ranked stock·ETF perpetuals from the stock radar. Pure. */
export function pickBasket(radar){
  return (radar?.items||[]).filter(x=>x.ranked&&/^[A-Z0-9]{1,24}USDT$/.test(x.symbol)).sort((a,b)=>(b.turnover_24h_usd??0)-(a.turnover_24h_usd??0)).slice(0,BASKET_SIZE).map(x=>x.symbol);
}

export async function stockLeagueTick(env,{now=Date.now(),fetchImpl=fetch}={}){
  const bucket=env?.MARKET_DATA;if(!bucket)return {ok:false,reason:'r2_missing'};
  const read=async k=>{const o=await bucket.get(k);if(!o)return null;try{return await o.json();}catch{return null;}};
  const write=(k,d)=>bucket.put(k,JSON.stringify(d),{httpMetadata:{contentType:'application/json'}});
  let st=await read(STATE);
  if(st?.schema!=='lumex_stock_league_v1'||typeof st.accounts!=='object')st={schema:'lumex_stock_league_v1',order_execution:false,accounts:{},created_ms:now,basket:null};
  if(st.last_tick_ms&&now-st.last_tick_ms<200000)return {ok:true,skipped:'recent_tick'};
  if(!Array.isArray(st.basket)||st.basket.length<BASKET_SIZE/2){
    const radar=await read('stock-hub/v1/radar.json');const b=pickBasket(radar);
    if(b.length<BASKET_SIZE/2)return {ok:false,reason:'no_basket'};
    st.basket=b;st.basket_chosen_ms=now;
  }
  const strategies=stockStrategies(st.basket);
  const market=makeMarket(fetchImpl,now);const ctx={prices:{}};
  for(const def of strategies){const a=st.accounts[def.id];if(a)for(const p of Object.values(a.positions)){const px=await market.price(p.symbol);if(px)ctx.prices[p.symbol]=px.mark;}}
  const out={};
  for(const def of strategies){
    if(!st.accounts[def.id])st.accounts[def.id]=newAccount(def,now);
    const acc=st.accounts[def.id];
    const hist=(await read(HIST+def.id+'.json'))||{schema:'lumex_stock_league_history_v1',id:def.id,points:[],trades:[],events:[]};
    let r;try{r=await runStrategy(def,acc,market,ctx);}catch(e){r={events:[{at_ms:now,type:'error',text:String(e?.message||e).slice(0,80)}],trades:[]};acc.status='error';}
    for(const p of Object.values(acc.positions))if(!ctx.prices[p.symbol]){const px=await market.price(p.symbol);if(px)ctx.prices[p.symbol]=px.mark;}
    markEquity(acc,ctx.prices);
    const hour=Math.floor(now/HOUR)*HOUR,last=hist.points.at(-1);
    if(!last||last[0]<hour||r.trades.length){if(last&&last[0]>=hour)hist.points[hist.points.length-1]=[hour,rd(acc.equity,2)];else hist.points.push([hour,rd(acc.equity,2)]);}
    hist.points=hist.points.slice(-24*180);
    hist.trades=hist.trades.concat(r.trades).slice(-1000);hist.events=hist.events.concat(r.events).slice(-100);
    await write(HIST+def.id+'.json',hist);
    out[def.id]={...summarize(acc,def,hist,now),basket:def.symbols};
  }
  st.last_tick_ms=now;
  st.summary={ok:true,schema:'lumex_stock_league_summary_v1',generated_at_ms:now,order_execution:false,start_usdt:START_USDT,basket:st.basket,basket_chosen_ms:st.basket_chosen_ms,
    execution:{fee_taker_pct:TAKER*100,slippage_pct:0.05,fills:'Bybit last price at the first 5-minute tick after a closed bar ± slippage',
      stops:'1-minute bars between ticks; gaps fill at the minute open',funding:'Bybit funding history applied to held positions',replay:'none (forward only)'},
    strategies:strategies.map(d=>out[d.id])};
  await write(STATE,st);
  return {ok:true,strategies:strategies.length,basket:st.basket.length};
}

/** Cron entry: runs one tick and records how it ended (status.json), so a tick that never wrote state can be seen from the route. */
export async function stockLeagueRun(env,opts={}){
  const now=opts.now??Date.now();let r;
  try{r=await stockLeagueTick(env,{...opts,now});}catch(e){r={ok:false,reason:'error',error:String(e?.message||e).slice(0,120)};}
  try{await env?.MARKET_DATA?.put(STATUS,JSON.stringify({at_ms:now,...r}),{httpMetadata:{contentType:'application/json'}});}catch{}
  return r;
}

/* ───────── payloads (routes in stock-hub.mjs) ───────── */
export async function leaguePayload(env,now=Date.now()){
  const o=await env.MARKET_DATA.get(STATE);const st=o?await o.json().catch(()=>null):null;const s=st?.summary;
  if(s?.schema!=='lumex_stock_league_summary_v1'){const so=await env.MARKET_DATA.get(STATUS);const last=so?await so.json().catch(()=>null):null;
    return {status:503,body:{ok:false,error:'not_started',last_tick:last?{at_ms:last.at_ms,ok:last.ok,reason:last.reason||null,error:last.error||null}:null}};}
  if(now-s.generated_at_ms>30*MIN)return {status:503,body:{ok:false,error:'stale',generated_at_ms:s.generated_at_ms}};
  return {status:200,body:s};
}
export async function leagueDetail(env,id){
  if(!/^[a-z0-9-]{1,40}$/.test(id||''))return {status:400,body:{ok:false,error:'id'}};
  const o=await env.MARKET_DATA.get(HIST+id+'.json');const h=o?await o.json().catch(()=>null):null;
  if(h?.schema!=='lumex_stock_league_history_v1')return {status:404,body:{ok:false,error:'unknown_bot'}};
  return {status:200,body:{ok:true,schema:'lumex_stock_league_detail_v1',id,order_execution:false,points:h.points.slice(-24*120),trades:h.trades.slice(-300),events:h.events.slice(-40)}};
}
/** Every bot fill on one symbol (for the chart markers). */
export async function leagueTrades(env,symbol){
  if(!/^[A-Z0-9]{1,24}USDT$/.test(symbol||''))return {status:400,body:{ok:false,error:'symbol'}};
  const o=await env.MARKET_DATA.get(STATE);const st=o?await o.json().catch(()=>null):null;
  if(st?.schema!=='lumex_stock_league_v1')return {status:503,body:{ok:false,error:'not_started'}};
  const trades=[];
  for(const id of Object.keys(st.accounts||{})){
    const h=await (await env.MARKET_DATA.get(HIST+id+'.json'))?.json().catch(()=>null);
    for(const t of h?.trades||[])if(t.symbol===symbol)trades.push({bot:id,...t});
  }
  const pos=[];for(const [id,a] of Object.entries(st.accounts||{})){const p=a.positions?.[symbol];if(p)pos.push({bot:id,side:p.side,entry:p.entry,stop:p.stop??null,take:p.take??null,opened_ms:p.opened_ms});}
  trades.sort((a,b)=>(a.at_ms??0)-(b.at_ms??0));
  return {status:200,body:{ok:true,schema:'lumex_stock_league_trades_v1',symbol,trades:trades.slice(-200),open:pos,generated_at_ms:st.last_tick_ms||null}};
}
