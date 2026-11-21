/**
 * Observation-first LUMEX executed-flow interpretation.
 * Historical Binance spot vs Binance futures ONLY; no AI confidence scoring,
 * no unrelated OI/liquidation/whale/wall duplication and no "taker whales".
 */
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const round=(x,n=2)=>finite(x)?Number(x.toFixed(n)):null;
const median=xs=>{const a=xs.filter(finite).sort((x,y)=>x-y);if(!a.length)return null;return a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2};
const share=(n,d)=>finite(n)&&finite(d)&&d>0?100*n/d:null;
export function explainHistoricalFlow(daily){
 if(!Array.isArray(daily)||daily.length!==90)return null;
 const events=[];
 const interpreted=daily.map((day,i)=>{
  const prev=daily[i-1],price=finite(day.price)&&finite(prev?.price)&&prev.price>0?
   (day.price/prev.price-1)*100:null;
  const s=share(day.spot_delta,day.spot_quote),f=share(day.futures_delta,day.futures_quote);
  const prior=daily.slice(Math.max(0,i-30),i),haveBaseline=prior.length>=14;
  const volMedian=haveBaseline?median(prior.map(v=>v.futures_quote)):null;
  const avgSpotMedian=prior.length>=7?median(prior.slice(-7).map(v=>v.spot_avg_trade_usdt)):null;
  const avgFutMedian=prior.length>=7?median(prior.slice(-7).map(v=>v.futures_avg_trade_usdt)):null;
  const volRatio=volMedian>0?day.futures_quote/volMedian:null;
  const spotPrintRatio=avgSpotMedian>0?day.spot_avg_trade_usdt/avgSpotMedian:null;
  const futuresPrintRatio=avgFutMedian>0?day.futures_avg_trade_usdt/avgFutMedian:null;
  const state=volRatio===null?'baseline_insufficient':volRatio>=3?'exceptional':
   volRatio>=1.75?'heating':volRatio<=0.6?'cooling':'neutral';
  const opposing=s!==null&&f!==null&&Math.abs(s)>=3&&Math.abs(f)>=3&&Math.sign(s)!==Math.sign(f);
  const saleAbsorptionCandidate=price!==null&&price>=-0.7&&price<=0.7&&
   s!==null&&s<=-15;
  const buyAbsorptionCandidate=price!==null&&price>=-0.7&&price<=0.7&&
   s!==null&&s>=15;
  const record={start_ms:day.start_ms,end_ms:day.end_ms,
   price_change_pct:round(price,3),spot_taker_delta_share_pct:round(s,2),
   futures_taker_delta_share_pct:round(f,2),
   futures_volume_vs_prior_30_period_median:round(volRatio,3),
   volume_bubble_state:state,
   spot_average_fill_vs_prior7:round(spotPrintRatio,3),
   futures_average_fill_vs_prior7:round(futuresPrintRatio,3),
   spot_futures_taker_disagreement:opposing,
   spot_sell_absorption_candidate:saleAbsorptionCandidate,
   spot_buy_absorption_candidate:buyAbsorptionCandidate,
   trading_signal:false,
   interpretation_scope:'historical_observations_heuristic_not_proven_predictive'};
  if(opposing)events.push({at_ms:day.end_ms,kind:'opposed_taker_pressure',
   evidence:{spot_delta_share_pct:record.spot_taker_delta_share_pct,
    futures_delta_share_pct:record.futures_taker_delta_share_pct}});
  if(state==='exceptional')events.push({at_ms:day.end_ms,kind:'futures_volume_exceptional',
   evidence:{vs_prior_median:record.futures_volume_vs_prior_30_period_median}});
  if(saleAbsorptionCandidate||buyAbsorptionCandidate)
   events.push({at_ms:day.end_ms,kind:saleAbsorptionCandidate?'spot_sell_absorption_candidate':'spot_buy_absorption_candidate',
     evidence:{price_change_pct:record.price_change_pct,spot_delta_share_pct:record.spot_taker_delta_share_pct}});
  return record;
 });
 return {schema:'lumex_order_flow_historical_interpretation_v1',
  classification:'descriptive_heuristics_unvalidated_for_future_predictions',
  window_periods:90,period_hours:24,
  diagnostics:interpreted,events:events.slice(-120),latest:interpreted.at(-1),
  explanations:{
   bubble:'24-hour futures quote turnover vs median of prior 14-30 complete 24-hour periods',
   disagreement:'opposite spot/futures signed taker quote delta shares, both >= 3 percentage points in magnitude',
   absorption:'spot taker delta share >=15% magnitude while 24h close return within ±0.7% (candidate only)',
   average_fill:'quote turnover divided by reported trade count; not original order size',
  }};
}
