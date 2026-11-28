/** LUMEX 주식 신호 스캐너 (2026-11-28) — every ranked stock·ETF perpetual on CLOSED 4H and 1H Bybit bars.
 * Stock section only (own R2 key stock-scan/v1/, own route). No orders.
 *
 * Per symbol and interval:
 *   trend     EMA20 vs EMA50 and the close against EMA20 (up / down / mixed)
 *   rsi       RSI14 (Wilder), atr_pct = ATR14 / close
 *   vol_ratio newest closed bar volume / average of the 20 before it
 *   breakout  close above the highest high (below the lowest low) of the 20 bars before it
 *   vtrade    the LUMEX chart's 가상 매매 rule replayed exactly as the stock chart and the AI 봇 주식 계좌 run it
 *             (paper-league-chartsig.mjs replay): a signal on the newest closed bar, the position it holds now
 *             (entry, stop, 1R target, whether the 50 % take is done) and the last closed trades with their prices.
 * Batches of BATCH symbols per run (the minute cron at :01 :03 :04 :06 … ), so one invocation stays small; a full pass
 * over ~170 symbols takes about 20 minutes. A symbol whose bars could not be read keeps its last result with its time;
 * results older than 6 hours are dropped from the payload. Nothing is estimated.
 * The route is read by Core with the Worker bearer (PRO content is served by the site, not by a public URL). */
import {makeMarket} from './paper-league.mjs';
import {replay,ema,rsi,atr,MIN_BARS} from './paper-league-chartsig.mjs';

const KEY='stock-scan/v1/state.json';
export const BATCH=16,INTERVALS=['240','60'],LIMIT=300,KEEP_MS=6*3600000;
const fin=x=>typeof x==='number'&&Number.isFinite(x);
const r=(x,d=4)=>fin(x)?Number(x.toFixed(d)):null;

/** Indicators + 가상 매매 state for one closed-bar series. Pure. */
export function analyse(bars){
  if(!Array.isArray(bars)||bars.length<MIN_BARS)return null;
  const c=bars.map(b=>b.c),n=bars.length-1,last=bars[n];
  const e20=ema(c,20),e50=ema(c,50),rs=rsi(c),at=atr(bars);
  const close=last.c,a=e20[n],b=e50[n];
  const trend=fin(a)&&fin(b)?(a>b&&close>a?'up':a<b&&close<a?'down':'mixed'):'mixed';
  const prev=bars.slice(n-20,n),avgV=prev.reduce((s,x)=>s+x.v,0)/prev.length;
  const hi=Math.max(...prev.map(x=>x.h)),lo=Math.min(...prev.map(x=>x.l));
  const rp=replay(bars);
  // closed trades with their prices (entry → optional 50 % take → exit)
  const trades=[];let cur=null;
  for(const e of rp.events){
    if(e.type==='entry'){cur={side:e.side,entry:r(e.price),entry_t:e.t,stop:r(e.sl),target:r(e.tp1),tp1:null,exit:null};continue;}
    if(!cur)continue;
    if(e.type==='tp1'){cur.tp1={price:r(e.price),t:e.t};continue;}
    if(e.type==='exit'||e.type==='stop'||e.type==='breakeven'){
      const gain=(cur.side==='long'?1:-1)*(e.price-cur.entry)>0;
      cur.exit={type:e.type==='stop'?'stop':e.type==='breakeven'?'breakeven':(gain?'take':'cut'),price:r(e.price),t:e.t,reason:e.type==='exit'?'opposite_signal':e.type==='stop'?'atr_stop':'entry_after_tp1'};
      cur.result_pct=r(e.result_pct,2);trades.push(cur);cur=null;}
  }
  const closed=trades.slice(-30),wins=closed.filter(t=>t.result_pct>0).length;
  const open=rp.open?{side:rp.open.side,entry:r(rp.open.entry),entry_t:rp.open.entry_t,stop:r(rp.open.stop),target:r(rp.open.tp1),tp1_done:rp.open.tp1_done,
    tp1:cur?.tp1||null,move_pct:r((rp.open.side==='long'?1:-1)*(close/rp.open.entry-1)*100,2)}:null;
  const nx=rp.next?{action:rp.next.action,side:rp.next.side||null,signal_t:rp.next.signal_t}:null;
  return {bar_t:last.t,close:r(close,6),chg20_pct:r((close/c[n-20]-1)*100,2),trend,ema20:r(a,6),ema50:r(b,6),rsi:r(rs[n],1),atr_pct:r(at[n]/close*100,2),
    vol_ratio:avgV>0?r(last.v/avgV,2):null,breakout:close>hi?'up':close<lo?'down':null,
    signal:nx,open,recent:closed.slice(-6).reverse(),stats:{trades:closed.length,wins,win_rate_pct:closed.length?r(wins/closed.length*100,1):null,
      sum_pct:closed.length?r(closed.reduce((s,t)=>s+t.result_pct,0),2):null}};
}

/** One batch. Ranked symbols by 24h turnover from the stored radar; cursor kept in the state. */
export async function stockScanTick(env,{now=Date.now(),fetchImpl=fetch}={}){
  const bucket=env?.MARKET_DATA;if(!bucket)return {ok:false,reason:'r2_missing'};
  const read=async k=>{const o=await bucket.get(k);if(!o)return null;try{return await o.json();}catch{return null;}};
  const radar=await read('stock-hub/v1/radar.json');
  const list=(radar?.items||[]).filter(x=>x.ranked&&/^[A-Z0-9]{1,24}USDT$/.test(x.symbol)).sort((a,b)=>(b.turnover_24h_usd??0)-(a.turnover_24h_usd??0));
  if(!list.length)return {ok:false,reason:'no_radar'};
  let st=await read(KEY);if(st?.schema!=='lumex_stock_scan_state_v1')st={schema:'lumex_stock_scan_state_v1',cursor:0,syms:{}};
  const start=st.cursor%list.length,batch=[];for(let i=0;i<Math.min(BATCH,list.length);i++)batch.push(list[(start+i)%list.length]);
  const m=makeMarket(fetchImpl,now);let done=0,failed=0;
  for(const it of batch){
    const row=st.syms[it.symbol]||{};let any=false;
    for(const iv of INTERVALS){
      const bars=await m.bars(it.symbol,iv,LIMIT);const a=bars?analyse(bars):null;
      if(a){row['h'+(iv==='240'?4:1)]=a;any=true;}
    }
    if(any){row.at_ms=now;done++;}else failed++;
    row.ticker=it.ticker;row.slug=it.slug;row.name=it.name;row.type=it.type;row.turnover_24h_usd=it.turnover_24h_usd??null;row.last=it.last??null;row.change_24h_pct=it.change_24h_pct??null;
    st.syms[it.symbol]=row;
  }
  st.cursor=(start+batch.length)%list.length;st.updated_ms=now;st.last_batch={at_ms:now,done,failed,from:batch[0]?.symbol||null};
  for(const [k,v] of Object.entries(st.syms))if(!v.at_ms||now-v.at_ms>KEEP_MS*4)delete st.syms[k];
  await bucket.put(KEY,JSON.stringify(st),{httpMetadata:{contentType:'application/json'}});
  return {ok:true,done,failed,cursor:st.cursor,total:list.length};
}

/** Route body (bearer-checked by the caller). Fresh rows only, turnover order. */
export async function scanPayload(env,now=Date.now()){
  const o=await env.MARKET_DATA.get(KEY);const st=o?await o.json().catch(()=>null):null;
  if(st?.schema!=='lumex_stock_scan_state_v1')return {status:503,body:{ok:false,error:'not_started'}};
  const items=Object.entries(st.syms).filter(([,v])=>v.at_ms&&now-v.at_ms<=KEEP_MS&&(v.h4||v.h1)).map(([symbol,v])=>({symbol,...v}))
    .sort((a,b)=>(b.turnover_24h_usd??0)-(a.turnover_24h_usd??0));
  return {status:200,body:{ok:true,schema:'lumex_stock_scan_v1',updated_ms:st.updated_ms,last_batch:st.last_batch||null,intervals:{h4:'240',h1:'60'},
    rule:'EMA20·50 교차 + RSI14 동의로 다음 봉 시가 진입, ATR14 1R 손절, 1R에서 50% 익절 후 손절을 진입가로, 나머지는 반대 교차에서 정리 (마감된 봉만)',
    count:items.length,items,order_execution:false}};
}
/** Constant-time bearer check against the shared Worker token. */
export function bearerOk(request,env){
  const tok=typeof env?.LUMEX_AI_LAB_WORKER_TOKEN==='string'&&env.LUMEX_AI_LAB_WORKER_TOKEN.length>=48?env.LUMEX_AI_LAB_WORKER_TOKEN:'';
  const h=request.headers.get('authorization')||'',want='Bearer '+tok;
  if(!tok||h.length!==want.length)return false;let d=0;for(let i=0;i<h.length;i++)d|=h.charCodeAt(i)^want.charCodeAt(i);return d===0;
}
