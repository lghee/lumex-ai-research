/** LUMEX signal scorecard (2026-11-24) — forward-only record of signature signals in the PRO-50 scanner.
 *
 * Every scanner run looks at the signature tags already attached to each symbol (coil breakout up/down,
 * pressure divergence bullish/bearish, 1H and 4H). A signal is recorded once, keyed by symbol·timeframe·kind·bar.
 * Only signals whose bar CLOSED after the scorecard started are recorded: no backfilled history.
 *
 * Outcome = move from the archived hourly price at the signal bar's close to the archived hourly price
 * N hours later (±1 hour tolerance, the scanner's own hourly archive), signed in the signal's direction
 * (up / bullish = price rise counts positive). Baseline = the same signed move averaged over every symbol in the
 * archive for the same two hours, so "edge" = signal move − what the whole top 50 did. No fees, no execution.
 * Missing prices → the outcome is marked missing and excluded, never estimated.
 */
export const SC_KEY='market-hub/pro50/scorecard-v1.json';
const H=3600000;
export const FRAME_MS={'1h':H,'4h':4*H};
export const HORIZONS={'1h':[6,24],'4h':[24,72]};   // hours after the signal bar's close
export const MIN_SAMPLE=20, MAX_EVENTS=6000, RECENT=40;
const fin=x=>typeof x==='number'&&Number.isFinite(x);
const r=(x,d)=>fin(x)?Number(x.toFixed(d)):null;

export function emptyScorecard(now){return {schema:'lumex_signature_scorecard_v1',started_ms:now,updated_ms:now,events:[]};}
export function validScorecard(d){return d?.schema==='lumex_signature_scorecard_v1'&&Number.isSafeInteger(d.started_ms)&&Array.isArray(d.events);}

/** Signals present in a scanner snapshot whose bar closed at/after startedMs. Pure. */
export function detectEvents(scan,startedMs){
  const out=[];
  for(const it of scan?.items||[]){
    for(const tf of Object.keys(FRAME_MS)){
      const g=it?.regimes?.[tf];if(g?.status!=='ok'||!g.signature)continue;
      const push=(kind,dir,t)=>{if(!Number.isSafeInteger(t))return;const close=t+FRAME_MS[tf];if(close<startedMs)return;
        out.push({id:`${it.symbol}|${tf}|${kind}|${dir}|${t}`,symbol:it.symbol,coin:it.coin,tf,kind,dir,bar_ms:t,signal_ms:close,outcomes:{}});};
      const b=g.signature.coil?.breakout;if(b&&(b.direction==='up'||b.direction==='down'))push('coil',b.direction,b.time_ms);
      const d=g.signature.divergence;if(d&&(d.direction==='bullish'||d.direction==='bearish'))push('div',d.direction==='bullish'?'up':'down',d.time_ms);
    }
  }
  return out;
}
/** Archived hourly price nearest to t within ±1h. points = [[hour_ms, price, …]]. Pure. */
export function priceNear(points,t){
  let best=null;for(const p of points||[]){if(!Array.isArray(p)||!fin(p[1])||p[1]<=0)continue;const d=Math.abs(p[0]-t);if(d<=H&&(!best||d<Math.abs(best[0]-t)))best=p;}
  return best?best[1]:null;
}
function baseline(roll,t0,t1,sign){
  let s=0,n=0;for(const pts of Object.values(roll?.points||{})){const a=priceNear(pts,t0),b=priceNear(pts,t1);if(a&&b){s+=(b/a-1)*100*sign;n++;}}
  return n>=10?s/n:null;
}
/** Add new signals, fill outcomes that are due. Mutates sc. Pure apart from that. */
export function updateScorecard(sc,scan,roll,now){
  const known=new Set(sc.events.map(e=>e.id));let added=0,filled=0;
  for(const e of detectEvents(scan,sc.started_ms))if(!known.has(e.id)){sc.events.push(e);known.add(e.id);added++;}
  for(const e of sc.events){
    const pts=roll?.points?.[e.symbol];const sign=e.dir==='up'?1:-1;
    if(e.entry===undefined){
      if(now>=e.signal_ms+H){const p=priceNear(pts,e.signal_ms);if(p)e.entry=p;else if(now>e.signal_ms+3*H)e.entry=null;}
      if(e.entry===undefined)continue;
    }
    for(const h of HORIZONS[e.tf]){
      if(e.outcomes[h]!==undefined)continue;
      if(e.entry===null){e.outcomes[h]=null;continue;}
      const t1=e.signal_ms+h*H;if(now<t1+H)continue;
      const x=priceNear(pts,t1);
      if(!x){if(now>t1+3*H)e.outcomes[h]=null;continue;}
      e.outcomes[h]={ret:r((x/e.entry-1)*100*sign,3),base:r(baseline(roll,e.signal_ms,t1,sign),3)};filled++;
    }
  }
  // cap: drop the oldest finished events first
  if(sc.events.length>MAX_EVENTS){
    const done=e=>HORIZONS[e.tf].every(h=>e.outcomes[h]!==undefined);
    sc.events.sort((a,b)=>a.signal_ms-b.signal_ms);
    let extra=sc.events.length-MAX_EVENTS;sc.events=sc.events.filter(e=>{if(extra>0&&done(e)){extra--;return false;}return true;});
  }
  sc.updated_ms=now;
  return {added,filled};
}
const median=a=>{if(!a.length)return null;const s=[...a].sort((x,y)=>x-y),m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2;};
/** Public summary: per timeframe × kind × direction × horizon. Rates hidden below MIN_SAMPLE. Pure. */
export function summarize(sc,now){
  const groups=[];
  for(const tf of Object.keys(FRAME_MS))for(const kind of ['coil','div'])for(const dir of ['up','down']){
    const ev=sc.events.filter(e=>e.tf===tf&&e.kind===kind&&e.dir===dir);
    const hz=HORIZONS[tf].map(h=>{
      const done=ev.map(e=>e.outcomes[h]).filter(o=>o&&fin(o.ret));
      const rets=done.map(o=>o.ret),bases=done.map(o=>o.base).filter(fin);
      const enough=rets.length>=MIN_SAMPLE;
      const avg=rets.length?rets.reduce((a,b)=>a+b,0)/rets.length:null,avgB=bases.length?bases.reduce((a,b)=>a+b,0)/bases.length:null;
      return {hours:h,n:rets.length,enough,
        hit_rate_pct:enough?r(rets.filter(x=>x>0).length/rets.length*100,1):null,
        avg_ret_pct:enough?r(avg,3):null,median_ret_pct:enough?r(median(rets),3):null,
        avg_base_pct:enough?r(avgB,3):null,edge_pct:enough&&fin(avgB)?r(avg-avgB,3):null,
        pending:ev.filter(e=>e.outcomes[h]===undefined).length};
    });
    groups.push({tf,kind,dir,signals:ev.length,horizons:hz});
  }
  const recent=[...sc.events].sort((a,b)=>b.signal_ms-a.signal_ms).slice(0,RECENT).map(e=>({coin:e.coin,symbol:e.symbol,tf:e.tf,kind:e.kind,dir:e.dir,signal_ms:e.signal_ms,
    entry:fin(e.entry)?e.entry:null,outcomes:Object.fromEntries(HORIZONS[e.tf].map(h=>[h,e.outcomes[h]===undefined?'pending':e.outcomes[h]===null?'missing':e.outcomes[h].ret]))}));
  return {ok:true,schema:'lumex_signature_scorecard_summary_v1',generated_at_ms:now,started_ms:sc.started_ms,updated_ms:sc.updated_ms,
    total_signals:sc.events.length,min_sample:MIN_SAMPLE,horizons:HORIZONS,order_execution:false,backfilled:false,
    method:'Signals from the PRO-50 scanner signature tags (closed Bybit 1H/4H bars), recorded forward from started_ms. Outcome = archived hourly price at the signal bar close → N hours later (±1h), signed by signal direction; baseline = same signed move averaged over all archived top-50 symbols. No fees or execution.',
    groups,recent};
}
async function readJson(env,key){const o=await env.MARKET_DATA.get(key);if(!o)return null;if(Number.isFinite(o.size)&&o.size>6000000)return null;try{return await o.json();}catch{return null;}}
/** Cron step, called after a verified scanner write. Never throws. */
export async function scorecardTick(env,scan,roll,now=Date.now()){
  try{
    if(!env?.MARKET_DATA)return {ok:false,reason:'r2_missing'};
    let sc=await readJson(env,SC_KEY);if(!validScorecard(sc))sc=emptyScorecard(now);
    const res=updateScorecard(sc,scan,roll,now);
    const body=JSON.stringify(sc);if(body.length>6000000)return {ok:false,reason:'too_large'};
    await env.MARKET_DATA.put(SC_KEY,body,{httpMetadata:{contentType:'application/json'}});
    return {ok:true,...res,events:sc.events.length};
  }catch{return {ok:false,reason:'exception'};}
}
const reply=(doc,status=200)=>new Response(JSON.stringify(doc),{status,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}});
export async function serveScorecard(env,now=Date.now()){
  try{const sc=await readJson(env,SC_KEY);if(!validScorecard(sc))return reply({ok:false,error:'scorecard_not_started'},503);return reply(summarize(sc,now));}
  catch{return reply({ok:false,error:'scorecard_read_failed'},503);}
}
