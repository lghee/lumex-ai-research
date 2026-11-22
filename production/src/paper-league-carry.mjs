/** Capital carry for the seven registered strategies.
 *
 * The registered strategies already have a history: a research backtest (archived in Core,
 * frozen catalog 0.4.74 / legacy locked-365d) whose ending equity Core carried into its own
 * continuous paper account (provenance continuous_paper_carry_v3). This module hands that
 * capital over to the paper league so the account keeps one continuous line:
 *   10,000 → backtest ending equity → Core paper P&L since → league paper P&L from handover.
 * Each segment is labelled. The backtest segment has no curve (Core never stored one) and is
 * never drawn as if it were traded. Core paper points are imported as-is, never resampled.
 */
export const ARCHIVE={
  'btc-trend':{return_pct:26.82,ending_usdt:12682,mdd_pct:null,period:'과거 365일 고정 검증',model_id:'btc-trend-legacy-locked365'},
  'eth-asym':{return_pct:7.98,ending_usdt:10798,mdd_pct:null,period:'과거 365일 고정 검증',model_id:'eth-asym-legacy-locked365'},
  'rs28-core':{return_pct:18.7939,ending_usdt:11879.39,mdd_pct:6.6369,period:'과거 1년 백테스트',model_id:'LX_RS28_3D_CORE_085'},
  'rs28-alt':{return_pct:21.4917,ending_usdt:12149.17,mdd_pct:6.8921,period:'과거 1년 백테스트',model_id:'LX_RS28_7D_ALT_150'},
  'beta-residual':{return_pct:10.4769,ending_usdt:11047.69,mdd_pct:7.1005,period:'과거 1년 백테스트',model_id:'LX_BETA_RESIDUAL_28D'},
  'vol-normal':{return_pct:6.5547,ending_usdt:10655.47,mdd_pct:3.942,period:'과거 1년 백테스트',model_id:'LX_VOL_NORMALIZED_28D'},
  'funding-contrarian':{return_pct:0.0651,ending_usdt:10006.51,mdd_pct:3.4369,period:'과거 1년 백테스트',model_id:'LX_FUNDING_CONTRARIAN_7D'},
};
const H=3600000;
const fin=x=>typeof x==='number'&&Number.isFinite(x);

/** Validated Core continuous-paper snapshots keyed by strategy id (null on any doubt). */
export function parseCoreBots(doc,now){
  if(doc?.schema!=='lumex_public_ai_bots_v1'||!Array.isArray(doc.bots))return null;
  const out={};
  for(const b of doc.bots){
    const a=ARCHIVE[b?.key],p=b?.performance;
    if(!a||p?.provenance!=='continuous_paper_carry_v3')continue;
    const eq=Number(p.equity_usdt),seed=Number(p.carry_seed_usdt);
    if(!fin(eq)||eq<1||eq>1e9||!fin(seed)||Math.abs(seed-a.ending_usdt)>1)continue; // must descend from the archived backtest
    const points=[];let prev=-1;
    for(const x of Array.isArray(p.points)?p.points:[]){
      const t=Number(x?.at),v=Number(x?.equity);
      if(!Number.isSafeInteger(t)||t<1.5e12||t>now+H||!fin(v)||v<0||v>1e9||t<=prev)continue;prev=t;points.push([t,v,x.phase==='replay'?'replay':'forward']);
    }
    out[b.key]={equity:eq,seed,mdd_pct:fin(Number(p.mdd_pct))?Number(p.mdd_pct):null,trades:Number.isSafeInteger(p.closed_trades)?p.closed_trades:0,
      since_carry_return_pct:fin(Number(p.since_carry_return_pct))?Number(p.since_carry_return_pct):null,points,last_bar_ms:Number(p.last_bar_ms)||null};
  }
  return Object.keys(out).length?out:null;
}
export async function fetchCore(fetchImpl,origin){
  try{
    const r=await fetchImpl(`${origin.replace(/\/$/,'')}/wp-json/lumex/v1/public/ai-bots`,{headers:{accept:'application/json','user-agent':'lumex-paper-league/1'},signal:AbortSignal.timeout(7000)});
    if(!r.ok)return null;const t=await r.text();if(t.length>3000000)return null;return JSON.parse(t);
  }catch{return null;}
}
/** Rebase an account (and its stored curve) by delta without inventing fills. */
function rebase(acc,hist,delta){
  acc.cash+=delta;acc.equity+=delta;acc.peak+=delta;
  hist.points=hist.points.map(p=>[p[0],Math.round((p[1]+delta)*100)/100]);
}
/** Stage 1: archived backtest ending equity (always available, static). */
export function applyArchive(acc,hist,id,now){
  const a=ARCHIVE[id];if(!a||acc.carry)return false;
  const delta=a.ending_usdt-10000;rebase(acc,hist,delta);
  acc.carry={stage:'archive',seed_usdt:a.ending_usdt,applied_ms:now,overlap_trades:acc.trades,
    backtest:{return_pct:a.return_pct,ending_usdt:a.ending_usdt,mdd_pct:a.mdd_pct,period:a.period,model_id:a.model_id,curve_available:false},core_paper:null};
  return true;
}
/** Stage 2: add the Core continuous-paper P&L earned after the backtest, import its curve. */
export function applyCore(acc,hist,id,core,now){
  if(!acc.carry||acc.carry.stage!=='archive'||!core)return false;
  // Handover value = Core equity at the league start (last Core point at or before it), so the
  // overlap after the league started is never counted twice.
  let hand=null;for(const [t,v] of core.points)if(t<=acc.started_ms)hand=[t,v];
  if(!hand&&fin(core.last_bar_ms)&&core.last_bar_ms<=acc.started_ms)hand=[core.last_bar_ms,core.equity];
  if(!hand)return false;
  const delta=hand[1]-acc.carry.seed_usdt;rebase(acc,hist,delta);
  const first=hist.points[0]?.[0]??Infinity;
  const imported=[];const seen=new Set();
  for(const [t,v] of core.points){const h=Math.floor(t/H)*H;if(h>=first||t>hand[0])continue;if(seen.has(h))imported[imported.length-1]=[h,Math.round(v*100)/100];else{seen.add(h);imported.push([h,Math.round(v*100)/100]);}}
  hist.points=imported.concat(hist.points).slice(-24*120);
  if(fin(core.mdd_pct))acc.mdd_pct=Math.max(acc.mdd_pct,core.mdd_pct);
  acc.peak=Math.max(acc.peak,...imported.map(p=>p[1]),acc.equity);
  acc.carry={...acc.carry,stage:'core',seed_usdt:hand[1],core_applied_ms:now,handover_ms:hand[0],
    core_paper:{start_usdt:core.seed,equity_usdt:hand[1],return_pct:Math.round((hand[1]/core.seed-1)*1e5)/1e3,mdd_pct:core.mdd_pct,
      closed_trades:core.trades,points_imported:imported.length,first_point_ms:imported[0]?.[0]??null,last_bar_ms:core.last_bar_ms}};
  return true;
}
export function carryTick(st,hists,strategies,coreDoc,now){
  const core=coreDoc?parseCoreBots(coreDoc,now):null;const done=[];
  for(const def of strategies){
    if(def.origin!=='existing')continue;const acc=st.accounts[def.id],hist=hists[def.id];if(!acc||!hist)continue;
    if(!acc.carry&&applyArchive(acc,hist,def.id,now))done.push(def.id+':archive');
    // Core segment accepted for 7 days after the archive step (handover value is taken at league start).
    if(acc.carry?.stage==='archive'&&core?.[def.id]&&now-acc.carry.applied_ms<7*24*H&&applyCore(acc,hist,def.id,core[def.id],now))done.push(def.id+':core');
  }
  return done;
}
