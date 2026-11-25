/** LUMEX PRO paper-trading league — forward-only simulated accounts, NO real orders.
 *
 * Why forward-only: the goal is to learn which strategies keep earning on prices that did not
 * exist when the rules were written. Every account starts at 10,000 USDT on its own start date;
 * nothing is seeded from backtests or replays.
 *
 * Execution model (each 5-minute cron tick):
 *  - decisions only on newly CLOSED bars; the fill is the Bybit last price at the tick after the
 *    close (0–5 min later) ± slippage, plus Bybit taker fee;
 *  - stop / take-profit / time stop are checked on every 1-minute bar between ticks; a gap past
 *    the stop fills at that minute's open (worse), never at the stop price;
 *  - funding is charged or credited from Bybit's published funding history for each held symbol;
 *  - missed bars are never replayed into trades.
 * Bybit public endpoints only. Accounts, keys, LYRA, Core demo/live trading are untouched.
 */
import {STRATEGIES as BASE} from './paper-league-strategies.mjs';
import {ADVANCED} from './paper-league-advanced.mjs';
import {carryTick,fetchCore} from './paper-league-carry.mjs';
import {signalTick,SIGNALS} from './paper-league-signals.mjs';
import {trend} from './paper-league-trend.mjs';
import {chartsig} from './paper-league-chartsig.mjs';
import {trendcrowd} from './paper-league-trendcrowd.mjs';
import {dailyEma,dailyEma3x,dailyBreakout,rotation} from './paper-league-daily.mjs';
/** Active league: the 7 registered strategies (capital carried from their history) + 5 advanced + TREND (2026-11-23)
 * + SIGNAL · 차트 신호 4H (2026-11-24, partial take + break-even stop) + TREND+ · 쏠림 브레이크 (2026-11-24)
 * + DAILY · 일봉 추세 추적, BREAKOUT · 20일 돌파, ROTATION · 강약 교체 (2026-11-26, daily bars).
 * The first six simple 'new' strategies (2026-11-22 21:00 KST) are retired; their records stay in R2. */
export const STRATEGIES=[...BASE.filter(d=>d.origin==='existing'),...ADVANCED,trend,chartsig,trendcrowd,dailyEma,dailyBreakout,rotation,dailyEma3x];

const STATE='paper-league/v1/state.json';
const HIST='paper-league/v1/history/';            // + id + '.json'
const UNI='market-hub/universe/bybit-linear-top50-v1.json';
const SCAN='market-hub/pro50/scanner-v1.json';
export const START_USDT=10000,TAKER=0.00055;
export const slipFor=s=>['BTCUSDT','ETHUSDT'].includes(s)?0.0002:0.0005;
const MIN=60000,HOUR=3600000;
const FRAME={'60':HOUR,'240':4*HOUR,'D':24*HOUR};
const rd=(x,d=8)=>Number(Number(x).toFixed(d));
const fin=x=>typeof x==='number'&&Number.isFinite(x);

// ------------------------------------------------------------------ data ----
export function parseKlines(raw,frameMs,now){
  if(raw?.retCode!==0||!Array.isArray(raw?.result?.list)||raw.result.list.length>1000)return null;
  const rows=[];
  for(const x of raw.result.list){
    if(!Array.isArray(x)||x.length<6)return null;
    const [t,o,h,l,c,v]=x.slice(0,6).map(Number);
    if(![t,o,h,l,c,v].every(Number.isFinite)||o<=0||l<=0||c<=0||h<Math.max(o,c,l)||l>Math.min(o,c,h))return null;
    if(t+frameMs>now)continue; // forming bar excluded
    rows.push({t,o,h,l,c,v});
  }
  rows.sort((a,b)=>a.t-b.t);
  for(let i=1;i<rows.length;i++)if(rows[i].t-rows[i-1].t!==frameMs)return null;
  return rows;
}
async function getJson(fetchImpl,url,maxLen=1500000){
  const r=await fetchImpl(url,{method:'GET',headers:{accept:'application/json'},signal:AbortSignal.timeout(6000)});
  if(!r.ok)throw Error('status_'+r.status);
  const t=await r.text();if(t.length<10||t.length>maxLen)throw Error('size');
  return JSON.parse(t);
}
export function makeMarket(fetchImpl,now){
  const bars=new Map(),mins=new Map(),funding=new Map(),tick=new Map();
  return {
    now,
    async bars(symbol,interval,limit){
      const k=symbol+':'+interval+':'+limit;if(bars.has(k))return bars.get(k);
      let rows=null;
      try{rows=parseKlines(await getJson(fetchImpl,`https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${limit}`),FRAME[interval],now);}catch{}
      bars.set(k,rows);return rows;
    },
    async minutes(symbol,fromMs){
      const k=symbol+':'+fromMs;if(mins.has(k))return mins.get(k);
      let rows=null;const limit=Math.min(1000,Math.max(2,Math.ceil((now-fromMs)/MIN)+1));
      try{rows=parseKlines(await getJson(fetchImpl,`https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=1&start=${fromMs}&limit=${limit}`),MIN,now);
        if(rows)rows=rows.filter(b=>b.t>=fromMs);}catch{}
      mins.set(k,rows);return rows;
    },
    async funding(symbol){
      if(funding.has(symbol))return funding.get(symbol);
      let rows=null;
      try{const raw=await getJson(fetchImpl,`https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${symbol}&limit=200`,200000);
        if(raw?.retCode===0&&Array.isArray(raw.result?.list))rows=raw.result.list.map(x=>({t:Number(x.fundingRateTimestamp),rate:Number(x.fundingRate)}))
          .filter(x=>Number.isSafeInteger(x.t)&&fin(x.rate)&&Math.abs(x.rate)<=0.02).sort((a,b)=>a.t-b.t);}catch{}
      funding.set(symbol,rows);return rows;
    },
    async price(symbol){
      if(tick.has(symbol))return tick.get(symbol);
      let p=null;
      try{const raw=await getJson(fetchImpl,`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`,20000);
        const it=raw?.retCode===0?raw.result?.list?.[0]:null;const last=Number(it?.lastPrice),mark=Number(it?.markPrice);
        if(it?.symbol===symbol&&last>0&&mark>0&&Math.abs(last/mark-1)<0.03)p={last,mark};}catch{}
      tick.set(symbol,p);return p;
    },
    seedPrices(items){for(const it of items||[]){const last=Number(it.last_price),mark=Number(it.mark_price??it.last_price);
      if(/^[A-Z0-9]{2,20}USDT$/.test(it.symbol)&&last>0&&mark>0&&Math.abs(last/mark-1)<0.03)tick.set(it.symbol,{last,mark});}},
  };
}

// ------------------------------------------------------------- accounting ---
export function newAccount(def,now){
  return {id:def.id,started_ms:now,cash:START_USDT,positions:{},last_bar:0,last_tick:now,
    peak:START_USDT,mdd_pct:0,trades:0,wins:0,gross_win:0,gross_loss:0,fees:0,funding:0,realized:0,
    equity:START_USDT,exposure_pct:0,status:'observing',last_signal:'시작 · 다음 확정봉부터 판단',memo:{}};
}
export function fill(acc,{symbol,side,qty,ref,kind,reason,now,extra={}}){
  // side = position side; opening a long buys, closing a long sells.
  const buying=(kind==='open')===(side==='long');
  const px=ref*(1+(buying?1:-1)*slipFor(symbol)),fee=Math.abs(px*qty)*TAKER;
  acc.fees+=fee;
  if(kind==='open'){
    acc.cash-=fee;
    acc.positions[symbol]={symbol,side,qty,entry:px,opened_ms:now,fees:fee,funding:0,reason,...extra};
    return {type:'open',symbol,side,qty:rd(qty),price:rd(px),fee:rd(fee,4),at_ms:now,reason};
  }
  const p=acc.positions[symbol];
  const pnl=(side==='long'?1:-1)*(px-p.entry)*qty;
  acc.cash+=pnl-fee;acc.realized+=pnl-fee;
  const net=pnl-fee-p.fees+p.funding; // trade result incl. both fees and funding received(+)/paid(-)
  const t={type:'close',symbol,side,qty:rd(qty),entry_price:rd(p.entry),price:rd(px),opened_ms:p.opened_ms,at_ms:now,
    fee:rd(fee+p.fees,4),funding:rd(p.funding,4),net_pnl:rd(net,4),ret_pct:rd(net/(p.entry*qty)*100,3),reason};
  acc.trades++;if(net>0){acc.wins++;acc.gross_win+=net;}else acc.gross_loss+=-net;
  delete acc.positions[symbol];
  return t;
}
export function markEquity(acc,prices){
  let eq=acc.cash,gross=0;
  for(const p of Object.values(acc.positions)){const m=prices[p.symbol]??p.last_mark??p.entry;p.last_mark=m;
    eq+=(p.side==='long'?1:-1)*(m-p.entry)*p.qty;gross+=Math.abs(m*p.qty);}
  acc.equity=rd(eq,4);acc.exposure_pct=rd(eq>0?gross/eq*100:0,2);
  acc.peak=Math.max(acc.peak,eq);acc.mdd_pct=rd(Math.max(acc.mdd_pct,acc.peak>0?(acc.peak-eq)/acc.peak*100:0),4);
  return eq;
}
/** Walk 1-minute bars: stop has priority, a gap through the level fills at the minute's open. */
export function exitHit(p,minute){
  const long=p.side==='long';
  if(fin(p.stop)){
    if(long&&minute.o<=p.stop)return {ref:minute.o,reason:'손절(갭)'};if(!long&&minute.o>=p.stop)return {ref:minute.o,reason:'손절(갭)'};
    if(long&&minute.l<=p.stop)return {ref:p.stop,reason:'손절'};if(!long&&minute.h>=p.stop)return {ref:p.stop,reason:'손절'};
  }
  if(fin(p.take)){
    if(long&&minute.o>=p.take)return {ref:minute.o,reason:'익절'};if(!long&&minute.o<=p.take)return {ref:minute.o,reason:'익절'};
    if(long&&minute.h>=p.take)return {ref:p.take,reason:'익절'};if(!long&&minute.l<=p.take)return {ref:p.take,reason:'익절'};
  }
  if(fin(p.time_stop_ms)&&minute.t+MIN>=p.time_stop_ms)return {ref:minute.c,reason:'보유 시간 종료'};
  return null;
}
export function applyFunding(p,rows,fromMs,toMs){
  let paid=0;
  for(const f of rows||[]){if(f.t<=fromMs||f.t>toMs||f.t<p.opened_ms)continue;
    const notional=(p.last_mark??p.entry)*p.qty;const cash=(p.side==='long'?-1:1)*notional*f.rate;paid+=cash;}
  return paid;
}

/** Close part of a position: the closed part carries its share of fees and funding; the rest keeps the remainder. */
export function partialClose(acc,p,qty,ref,reason,now){
  const share=Math.min(1,qty/p.qty),keep={...p,qty:p.qty-qty,fees:p.fees*(1-share),funding:p.funding*(1-share)};
  acc.positions[p.symbol]={...p,fees:p.fees*share,funding:p.funding*share};
  const t=fill(acc,{symbol:p.symbol,side:p.side,qty,ref,kind:'close',reason,now});
  acc.positions[p.symbol]=keep;t.partial=true;return t;
}
// ------------------------------------------------------------------ tick ----
export async function runStrategy(def,acc,market,ctx){
  const now=market.now,events=[],trades=[];
  const from=Math.max(acc.last_tick,now-16*60*MIN);
  // 1) intrabar exits + funding for open positions
  for(const p0 of Object.values(acc.positions)){let p=p0;
    const mins=await market.minutes(p.symbol,Math.floor(from/MIN)*MIN);
    if(mins)for(const m of mins){if(m.t<p.opened_ms-MIN)continue;const hit=exitHit(p,m);
      // 2026-11-24 partial take (chart-signal strategy): close take_frac at the target, optionally move the stop to entry, keep walking
      if(hit&&hit.reason.startsWith('익절')&&fin(p.take_frac)&&p.take_frac>0&&p.take_frac<1){
        trades.push(partialClose(acc,p,p.qty*p.take_frac,hit.ref,'분할 익절 '+Math.round(p.take_frac*100)+'%',Math.min(now,m.t+MIN)));
        p=acc.positions[p.symbol];p.take=null;p.take_frac=null;if(p.be_after_take){p.stop=p.entry;p.be_after_take=false;}continue;}
      if(hit){trades.push(fill(acc,{symbol:p.symbol,side:p.side,qty:p.qty,ref:hit.ref,kind:'close',reason:p.stop===p.entry&&hit.reason.startsWith('손절')?'본절 청산':hit.reason,now:Math.min(now,m.t+MIN)}));break;}
      if(def.trailAtr&&fin(p.trail_atr)){const best=p.side==='long'?m.h:m.l;p.best=p.side==='long'?Math.max(p.best??best,best):Math.min(p.best??best,best);
        const t=p.side==='long'?p.best-p.trail_atr:p.best+p.trail_atr;p.stop=p.side==='long'?Math.max(p.stop??-Infinity,t):Math.min(p.stop??Infinity,t);}}
    else events.push({at_ms:now,type:'data',text:p.symbol+' 1분봉 확인 실패 · 이번 회차 손절 점검 보류'});
  }
  // Paired strategies (registered cross-asset rules): a stop/take on one leg closes every leg, as in Core.
  if(def.groupExit&&trades.some(t=>t.type==='close'&&/손절|익절/.test(t.reason))){
    for(const p of Object.values(acc.positions)){const px=await market.price(p.symbol);if(px)trades.push(fill(acc,{symbol:p.symbol,side:p.side,qty:p.qty,ref:px.last,kind:'close',reason:'짝 포지션 동시 청산',now}));}
  }
  // Funding settles on the hour (1/4/8h schedules): read the history once per new hour only.
  const lastF=acc.last_funding_check??acc.last_tick;
  if(Math.floor(now/HOUR)>Math.floor(lastF/HOUR)||!Object.keys(acc.positions).length){
    let okAll=true;
    for(const p of Object.values(acc.positions)){
      const f=await market.funding(p.symbol);
      if(f){const c=applyFunding(p,f,lastF,now);if(c){p.funding+=c;acc.cash+=c;acc.funding+=c;}}else okAll=false;
    }
    if(okAll)acc.last_funding_check=now; // on failure the same window is retried next tick, never skipped
  }
  // 2) decision on a newly closed bar of the strategy's interval
  const frame=FRAME[def.interval],latest=Math.floor(now/frame)*frame-frame;
  if(latest>acc.last_bar){
    const missed=acc.last_bar>0&&latest-acc.last_bar>frame;
    let out=null;
    try{out=await def.decide({market,acc,now,bar_ms:latest,prev_bar_ms:acc.last_bar,ctx});}catch(e){out={error:String(e?.message||e).slice(0,60)};}
    if(!out||out.error){acc.status='data_unavailable';events.push({at_ms:now,type:'data',text:'판단 보류: '+(out?.error||'자료 없음')});}
    else{
      acc.status='observing';acc.last_signal=out.note||acc.last_signal;
      if(out.diag)acc.memo.diag={...out.diag,at_ms:now};
      if(def.risk_overlay&&out.target)applyRiskOverlay(def.risk_overlay,acc,out,ctx,now,events);
      if(missed)events.push({at_ms:now,type:'gap',text:'놓친 확정봉은 거래로 재현하지 않고 최신 봉으로만 판단'});
      if(out.target){ // null target = hold
        const eq=markEquity(acc,ctx.prices);
        const want=new Map(out.target.map(l=>[l.symbol,l]));
        if(def.groupExit)want.clear(); // registered paired rules exit every leg at each rebalance, then re-enter fresh
        for(const p of Object.values(acc.positions)){const w=want.get(p.symbol);
          if(!w&&Array.isArray(out.keep_missing)&&out.keep_missing.includes(p.symbol))continue; // data gap this tick: hold, never force-exit
          if(!w||w.side!==p.side){const px=await market.price(p.symbol);if(!px){events.push({at_ms:now,type:'data',text:p.symbol+' 시세 없음 · 청산 보류'});continue;}
            trades.push(fill(acc,{symbol:p.symbol,side:p.side,qty:p.qty,ref:px.last,kind:'close',reason:out.exit_reason||'신호 전환',now}));}}
        for(const l of out.target){
          const cur=acc.positions[l.symbol];const px=await market.price(l.symbol);if(!px){events.push({at_ms:now,type:'data',text:l.symbol+' 시세 없음 · 진입 보류'});continue;}
          const notional=Math.max(0,eq)*l.weight;
          if(cur&&cur.side===l.side){
            if(def.resize&&Math.abs(cur.qty*px.last-notional)>0.2*notional&&notional>50){
              const delta=notional/px.last-cur.qty;
              if(delta<0){const part={...cur};trades.push(fill(acc,{symbol:l.symbol,side:l.side,qty:-delta,ref:px.last,kind:'close',reason:'비중 축소',now}));
                const keep=part.qty+delta;acc.positions[l.symbol]={...part,qty:keep,fees:part.fees*keep/part.qty,funding:part.funding*keep/part.qty};}
              else{const old={...cur};delete acc.positions[l.symbol];const o=fill(acc,{symbol:l.symbol,side:l.side,qty:delta,ref:px.last,kind:'open',reason:'비중 확대',now});trades.push(o);
                const added=acc.positions[l.symbol];acc.positions[l.symbol]={...old,qty:old.qty+delta,entry:(old.entry*old.qty+added.entry*delta)/(old.qty+delta),fees:old.fees+added.fees};}
            }
            Object.assign(acc.positions[l.symbol],pickRisk(l,acc.positions[l.symbol].entry,now,true));
            // 2026-11-26 daily strategies: the trailing stop moves once per closed bar, and only in the trade's favour
            if(fin(l.trail_stop)&&l.trail_stop>0){const p=acc.positions[l.symbol];p.stop=p.side==='long'?Math.max(fin(p.stop)?p.stop:-Infinity,l.trail_stop):Math.min(fin(p.stop)?p.stop:Infinity,l.trail_stop);}
            continue;}
          if(notional<50)continue;
          trades.push(fill(acc,{symbol:l.symbol,side:l.side,qty:notional/px.last,ref:px.last,kind:'open',reason:l.reason||out.note||'신호',now,extra:{}}));
          Object.assign(acc.positions[l.symbol],pickRisk(l,acc.positions[l.symbol].entry,now,false));
        }
      }
    }
    acc.last_bar=latest;
  }
  acc.last_tick=now;
  markEquity(acc,ctx.prices);
  return {events,trades};
}
/** Account-level risk brake for advanced strategies: drawdown from the rolling risk peak halves
 * exposure at ddHalf, goes flat with a cool-down at ddFlat, and caps gross exposure. */
export function applyRiskOverlay(R,acc,out,ctx,now,events){
  const eq=markEquity(acc,ctx.prices);const m=acc.memo;
  if(!fin(m.risk_peak))m.risk_peak=eq;
  if(fin(m.cooldown_until)&&now<m.cooldown_until){out.target=[];out.exit_reason='위험 관리 휴식';out.note=(out.note||'')+' · 위험 관리 휴식 중';m.risk_state='cooldown';return;}
  if(fin(m.cooldown_until)&&now>=m.cooldown_until){m.cooldown_until=null;m.risk_peak=eq;}
  m.risk_peak=Math.max(m.risk_peak,eq);const dd=(m.risk_peak-eq)/m.risk_peak;m.risk_dd_pct=Number((dd*100).toFixed(2));
  if(dd>=R.ddFlat){out.target=[];out.exit_reason='낙폭 한도 · 전량 청산';m.cooldown_until=now+R.cooldownH*HOUR;m.risk_state='flat';
    events.push({at_ms:now,type:'risk',text:`계좌 낙폭 ${(dd*100).toFixed(1)}% · 전량 청산 후 ${R.cooldownH}시간 휴식`});return;}
  let scale=1;if(dd>=R.ddHalf){scale=0.5;m.risk_state='half';}else m.risk_state='normal';
  const gross=out.target.reduce((a,l)=>a+l.weight,0)*scale;if(gross>R.maxGross)scale*=R.maxGross/gross;
  if(scale<1)out.target=out.target.map(l=>({...l,weight:Number((l.weight*scale).toFixed(4))}));
  if(m.risk_state==='half')out.note=(out.note||'')+` · 낙폭 ${(dd*100).toFixed(1)}%로 비중 절반`;
}
function pickRisk(l,entry,now,keepExisting){
  const o={};const long=l.side==='long';if(l.regime_tag)o.regime_tag=l.regime_tag;
  if(fin(l.stop_pct))o.stop=entry*(1+(long?-1:1)*l.stop_pct);
  if(fin(l.stop_price))o.stop=l.stop_price;
  if(fin(l.take_pct))o.take=entry*(1+(long?1:-1)*l.take_pct);
  if(fin(l.take_price))o.take=l.take_price;
  if(fin(l.hold_ms)&&!keepExisting)o.time_stop_ms=now+l.hold_ms;
  if(fin(l.trail_atr))o.trail_atr=l.trail_atr;
  if(!keepExisting&&fin(l.take_frac)&&l.take_frac>0&&l.take_frac<1){o.take_frac=l.take_frac;o.be_after_take=!!l.be_after_take;}
  if(keepExisting){delete o.stop;delete o.take;if(fin(l.trail_atr))o.trail_atr=l.trail_atr;} // keep the original risk levels of a held trade
  return o;
}

export function summarize(acc,def,hist,now){
  const ret=(acc.equity/START_USDT-1)*100,days=(now-acc.started_ms)/86400000;
  const pts=hist?.points||[];
  const daily=[];let lastDay=null;
  for(const p of pts){const d=Math.floor(p[0]/86400000);if(d!==lastDay){daily.push(p);lastDay=d;}else daily[daily.length-1]=p;}
  const dr=[];for(let i=1;i<daily.length;i++)dr.push(daily[i][1]/daily[i-1][1]-1);
  const mean=dr.length?dr.reduce((a,b)=>a+b,0)/dr.length:null,sd=dr.length>1?Math.sqrt(dr.reduce((a,b)=>a+(b-mean)**2,0)/(dr.length-1)):null;
  const ago=ms=>{const t=now-ms;let best=null;for(const p of pts)if(p[0]<=t)best=p;return best?rd((acc.equity/best[1]-1)*100,3):null;};
  const base=acc.carry?.seed_usdt??START_USDT;
  const extra={origin:def.origin,tier:def.tier||'registered',ai:!!def.ai,
    forward_start_usdt:rd(base,2),forward_return_pct:rd((acc.equity/base-1)*100,3),
    carry:acc.carry?{stage:acc.carry.stage,seed_usdt:rd(acc.carry.seed_usdt,2),handover_ms:acc.carry.handover_ms??acc.started_ms,backtest:acc.carry.backtest,core_paper:acc.carry.core_paper}:null,
    model:acc.memo?.diag||null,risk_state:def.risk_overlay?{state:acc.memo?.risk_state||'normal',drawdown_pct:acc.memo?.risk_dd_pct??0,cooldown_until_ms:acc.memo?.cooldown_until??null,
      rules:{half_at_pct:def.risk_overlay.ddHalf*100,flat_at_pct:def.risk_overlay.ddFlat*100,cooldown_hours:def.risk_overlay.cooldownH}}:null};
  return {...extra,id:def.id,name:def.name,family:def.family,risk:def.risk,kind:def.kind,symbols:def.symbols_label,interval:def.interval_label,summary:def.summary,rules:def.rules,
    started_ms:acc.started_ms,days:rd(days,2),equity:rd(acc.equity,2),return_pct:rd(ret,3),return_7d_pct:ago(7*86400000),return_30d_pct:ago(30*86400000),
    mdd_pct:rd(acc.mdd_pct,3),trades:acc.trades,wins:acc.wins||0,losses:Math.max(0,acc.trades-(acc.wins||0)),leverage:def.leverage||1,win_rate_pct:acc.trades?rd(acc.wins/acc.trades*100,1):null,
    profit_factor:acc.gross_loss>0?rd(acc.gross_win/acc.gross_loss,2):(acc.gross_win>0?null:null),
    fees:rd(acc.fees,2),funding:rd(acc.funding,2),exposure_pct:acc.exposure_pct,
    daily_sharpe_annualized:mean!==null&&sd>0&&dr.length>=14?rd(mean/sd*Math.sqrt(365),2):null,daily_samples:dr.length,
    status:acc.status,last_signal:acc.last_signal,last_tick_ms:acc.last_tick,
    positions:Object.values(acc.positions).map(p=>({symbol:p.symbol,side:p.side,qty:rd(p.qty),entry:rd(p.entry),mark:rd(p.last_mark??p.entry),
      unrealized:rd((p.side==='long'?1:-1)*((p.last_mark??p.entry)-p.entry)*p.qty,2),stop:fin(p.stop)?rd(p.stop):null,take:fin(p.take)?rd(p.take):null,
      time_stop_ms:p.time_stop_ms??null,opened_ms:p.opened_ms})),
    spark:daily.slice(-60).map(p=>[p[0],rd(p[1],2)])};
}

export async function paperLeagueTick(env,{now=Date.now(),fetchImpl=fetch,strategies=STRATEGIES}={}){
  if(!env?.MARKET_DATA)return {ok:false,reason:'r2_missing'};
  const read=async k=>{const o=await env.MARKET_DATA.get(k);if(!o)return null;try{return await o.json()}catch{return null}};
  const write=async(k,d)=>env.MARKET_DATA.put(k,JSON.stringify(d),{httpMetadata:{contentType:'application/json'}});
  let st=await read(STATE);
  if(st?.schema!=='lumex_paper_league_v1'||typeof st.accounts!=='object')st={schema:'lumex_paper_league_v1',order_execution:false,accounts:{},created_ms:now};
  if(st.last_tick_ms&&now-st.last_tick_ms<200000)return {ok:true,skipped:'recent_tick'};
  const market=makeMarket(fetchImpl,now);
  const uni=await read(UNI),scan=await read(SCAN);
  const freshUni=uni?.schema==='lumex_uid_top50_v1'&&now-uni.generated_at_ms<15*MIN?uni:null;
  const freshScan=scan?.schema==='lumex_pro50_scanner_v1'&&now-scan.generated_at_ms<20*MIN?scan:null;
  if(freshUni)market.seedPrices(freshUni.items);
  const ctx={universe:freshUni,scanner:freshScan,prices:{}};
  const needed=new Set();
  for(const def of strategies){const a=st.accounts[def.id];if(a)for(const p of Object.values(a.positions))needed.add(p.symbol);}
  for(const s of needed){const p=await market.price(s);if(p)ctx.prices[s]=p.mark;}
  const out={},hists={};
  for(const def of strategies){
    if(!st.accounts[def.id])st.accounts[def.id]=newAccount(def,now);
    hists[def.id]=(await read(HIST+def.id+'.json'))||{schema:'lumex_paper_league_history_v1',id:def.id,points:[],trades:[],events:[]};
  }
  // Registered strategies continue from their history: backtest ending equity, then Core paper P&L.
  const needCore=strategies.some(d=>d.origin==='existing'&&st.accounts[d.id].carry?.stage!=='core'&&(!st.accounts[d.id].carry||now-st.accounts[d.id].carry.applied_ms<7*24*HOUR));
  let coreDoc=null;
  if(needCore&&(!st.core_try_ms||now-st.core_try_ms>=30*MIN)){st.core_try_ms=now;coreDoc=await fetchCore(fetchImpl,env.LUMEX_SITE_ORIGIN||'https://lumexbot.com');}
  const carried=carryTick(st,hists,strategies,coreDoc,now);
  for(const c of carried){const [id,stage]=c.split(':');hists[id].events.push({at_ms:now,type:'carry',text:stage==='core'?'Core 모의거래 평가금(백테스트 종료금 + 이후 손익) 이관':'백테스트 종료 평가금 이관'});}
  for(const def of strategies){
    const acc=st.accounts[def.id],hist=hists[def.id];
    let r;try{r=await runStrategy(def,acc,market,ctx);}catch(e){r={events:[{at_ms:now,type:'error',text:String(e?.message||e).slice(0,80)}],trades:[]};acc.status='error';}
    for(const p of Object.values(acc.positions))if(!ctx.prices[p.symbol]){const px=await market.price(p.symbol);if(px)ctx.prices[p.symbol]=px.mark;}
    markEquity(acc,ctx.prices);
    const hour=Math.floor(now/HOUR)*HOUR;const last=hist.points.at(-1);
    if(!last||last[0]<hour||r.trades.length){if(last&&last[0]>=hour)hist.points[hist.points.length-1]=[hour,rd(acc.equity,2)];else hist.points.push([hour,rd(acc.equity,2)]);}
    hist.points=hist.points.slice(-24*120);
    hist.trades=hist.trades.concat(r.trades).slice(-500);hist.events=hist.events.concat(r.events).slice(-100);
    await write(HIST+def.id+'.json',hist);
    out[def.id]=summarize(acc,def,hist,now);
  }
  for(const id of Object.keys(st.accounts))if(!strategies.some(d=>d.id===id))st.accounts[id].status='retired';
  st.last_tick_ms=now;
  st.summary={ok:true,schema:'lumex_paper_league_summary_v1',generated_at_ms:now,order_execution:false,start_usdt:START_USDT,
    execution:{fee_taker_pct:TAKER*100,slippage_pct:{BTCUSDT:0.02,ETHUSDT:0.02,others:0.05},fills:'Bybit last price at the first 5-minute tick after a closed bar ± slippage',
      stops:'1-minute bars between ticks; gaps fill at the minute open',funding:'Bybit funding history applied to held positions',replay:'none (forward only)'},
    retired:Object.values(st.accounts).filter(a=>a.status==='retired').map(a=>a.id),
    strategies:strategies.map(d=>out[d.id])};
  // Copy-trading ledger: target holdings per strategy, new sequence only when holdings change.
  const ledger=signalTick(st,strategies,now);
  await write(STATE,st);
  await write(SIGNALS,ledger);
  return {ok:true,strategies:strategies.length};
}

const reply=(doc,status=200)=>new Response(JSON.stringify(doc),{status,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}});
export async function serveLeague(env,now=Date.now()){
  try{const o=await env.MARKET_DATA.get(STATE);const st=o?await o.json():null;const s=st?.summary;
    if(s?.schema!=='lumex_paper_league_summary_v1'||now-s.generated_at_ms>30*MIN)return reply({ok:false,error:'paper_league_unavailable_or_stale'},503);
    return reply(s);}catch{return reply({ok:false,error:'paper_league_read_failed'},503);}
}
export async function serveDetail(request,env,{strategies=STRATEGIES}={}){
  const id=String(new URL(request.url).searchParams.get('id')||'');
  if(!strategies.some(d=>d.id===id))return reply({ok:false,error:'unknown_strategy'},400);
  try{const o=await env.MARKET_DATA.get(HIST+id+'.json');const h=o?await o.json():null;
    if(h?.schema!=='lumex_paper_league_history_v1')return reply({ok:false,error:'history_unavailable'},503);
    return reply({ok:true,schema:'lumex_paper_league_detail_v1',id,order_execution:false,points:h.points.slice(-24*90),trades:h.trades.slice(-200),events:h.events.slice(-40)});}
  catch{return reply({ok:false,error:'history_read_failed'},503);}
}
