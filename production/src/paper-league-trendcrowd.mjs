/** LUMEX TREND+ · 쏠림 브레이크 (2026-11-24) — TREND with a funding-crowding brake.
 *
 * Same targets as TREND (paper-league-trend.mjs, closed 4H bars). Checked every hour: if a coin's position sits on the
 * crowded side — long while that coin's latest funding rate is in the top 5 % of its own prior 30 days, short while in
 * the bottom 5 % — the coin is held flat until the crowding eases.
 *
 * Research (offline, 3 years 2023-11 → 2026-11, OKX 4H/1H candles + Gate funding, 0.075 % cost, funding applied):
 * TREND +58.9 % / MDD −19.5 % / Sharpe 0.81 → this +67.0 % / −16.6 % / 0.97; 3 %·7 % thresholds and 0–0.75× sizes all
 * beat TREND (not a single lucky point); 10 % hurt returns. Backtest only — forward record from 10,000 USDT.
 * Live differences, stated: Bybit funding history (last 200 settlements; coins on 1h/4h schedules cover fewer than
 * 30 days), and fewer than 20 prior settlements → no brake for that coin.
 */
import {trend,TREND_SYMBOLS} from './paper-league-trend.mjs';
export const CROWD_PCT=5,CROWD_DAYS=30,CROWD_MIN=20;
const fin=x=>typeof x==='number'&&Number.isFinite(x);

/** Percentile (0–100) of the latest funding rate within its own prior 30 days, ties counted half. null when < 20 rows. */
export function fundingPercentile(rows,nowMs){
  const r=(rows||[]).filter(x=>fin(x?.t)&&fin(x?.rate)&&x.t<=nowMs).sort((a,b)=>a.t-b.t);
  if(!r.length)return null;
  const last=r.at(-1),win=r.filter(x=>x.t>=last.t-CROWD_DAYS*86400000&&x.t<last.t);
  if(win.length<CROWD_MIN)return null;
  let below=0,eq=0;for(const x of win){if(x.rate<last.rate)below++;else if(x.rate===last.rate)eq++;}
  return (below+0.5*eq)/win.length*100;
}
export function crowded(side,pct){return pct!==null&&((side==='long'&&pct>=100-CROWD_PCT)||(side==='short'&&pct<=CROWD_PCT));}

export const trendcrowd={...trend,id:'trend-crowd-4h',name:'TREND+ · 쏠림 브레이크',family:'다중 기간 추세추종 + 펀딩 쏠림 회피(롱·숏)',
  interval:'60',interval_label:'4H·1H',
  summary:'TREND와 같은 4시간봉 추세를 따르되, 펀딩비가 한쪽으로 극단적으로 쏠린 코인은 그 쏠림이 풀릴 때까지 쉬어 갑니다.',
  rules:[...trend.rules,'쏠림 브레이크: 롱인데 펀딩비가 최근 30일 자기 기록 상위 5%, 숏인데 하위 5%면 그 코인은 보유하지 않음(매시간 확인)'],
  async decide(ctx){
    const out=await trend.decide(ctx);if(!out||out.error||!out.target)return out;
    const kept=[],braked=[],noData=[];
    for(const l of out.target){
      const rows=await ctx.market.funding(l.symbol),pct=rows?fundingPercentile(rows,ctx.market.now):null;
      if(!rows||pct===null)noData.push(l.symbol);
      if(crowded(l.side,pct)){braked.push(`${l.symbol.replace('USDT','')} ${l.side==='long'?'롱':'숏'} ${pct.toFixed(0)}%`);continue;}
      kept.push(l);
    }
    out.target=kept;
    if(braked.length){out.note+=` · 쏠림 쉬기 ${braked.length}`;out.exit_reason='펀딩 쏠림 · 쉬기';}
    out.diag={...out.diag,crowd:{braked,no_funding_history:noData}};
    return out;
  }};
export const TRENDCROWD_SYMBOLS=TREND_SYMBOLS;
