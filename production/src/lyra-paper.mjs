/** LYRA V2: independent observational paper account, Gate public data ONLY.
 * Minute HTTP quotes approximate mark-to-market; NOT websocket/tick-execution.
 * 4h CLOSED bars for LYRA; no real orders, accounts, legacy bot balances or PnL seeding.
 */
export const COINS=['BTC','ETH','SOL','XRP'], BAR=14400;
const DAY=86400000,FEE=.0009,FUNDING=.00015,PREFIX='research/lyra-shadow/v2/';
const zero=()=>Object.fromEntries(COINS.map(c=>[c,0]));
const gross=w=>COINS.reduce((a,c)=>a+Math.abs(w[c]||0),0);
const rd=(n,k=8)=>Number(n.toFixed(k));
const sum=a=>a.reduce((x,y)=>x+y,0);
const clamp=(w,n)=>{const f=Math.min(1,n/Math.max(gross(w),1e-15));return Object.fromEntries(COINS.map(c=>[c,rd((w[c]||0)*f)]));};
const diff=(a,b)=>COINS.reduce((s,c)=>s+Math.abs((a[c]||0)-(b[c]||0)),0);
const num=x=>typeof x==='number'||typeof x==='string'?Number(x):NaN;
const valid=x=>Number.isFinite(x)&&x>0&&x<1e9;
const std=a=>{const m=sum(a)/a.length;return Math.sqrt(sum(a.map(x=>(x-m)**2))/a.length)};
function ema(a,k){let v=a[0];return a.map((p,i)=>v=i?p*2/(k+1)+v*(1-2/(k+1)):p)}
function event(s,ms,type,detail={}){const e={id:++s.seq,observed_ms:ms,type,nav_usdt:rd(s.nav,4),...detail};s.events.push(e);s.events=s.events.slice(-100);return e;}
function checkWeights(w){if(!w||COINS.some(c=>!Number.isFinite(w[c])||Math.abs(w[c])>1)||gross(w)>1.0000001)throw Error('position_invalid');}
export function parseQuote(arr,c){
 if(!Array.isArray(arr)||arr.length!==1||arr[0]?.contract!==c+'_USDT')throw Error('quote_schema_'+c);
 const last=num(arr[0].last),mark=num(arr[0].mark_price);
 if(!valid(last)||!valid(mark)||Math.abs(last/mark-1)>.03)throw Error('quote_disagreement_'+c);
 return last;
}
export function closedBars(raw,ms){
 if(!Array.isArray(raw)||raw.length<380||raw.length>560)throw Error('bars_count');
 const cutoff=Math.floor(ms/1000/BAR)*BAR;const by=new Map();
 for(const z of raw){
  const t=num(z?.t),o=num(z?.o),h=num(z?.h),l=num(z?.l),c=num(z?.c),v=num(z?.v);
  if(!Number.isSafeInteger(t)||t%BAR||t<1500000000)throw Error('bar_timestamp');
  if(t>=cutoff)continue;
  if(o===h&&h===l&&l===c&&v===0)continue;
  if(![o,h,l,c].every(valid)||!Number.isFinite(v)||v<=0||h<Math.max(o,c,l)||l>Math.min(o,c))throw Error('bad_ohlcv');
  const item={t,o,h,l,c,v};
  if(by.has(t)&&JSON.stringify(by.get(t))!==JSON.stringify(item))throw Error('conflicting_bar');
  by.set(t,item);
 }
 const out=[...by.values()].sort((a,b)=>a.t-b.t);
 if(out.length<380||out.at(-1).t!==cutoff-BAR)throw Error('closed_bars_lagging');
 for(let i=1;i<out.length;i++)if(out[i].t-out[i-1].t!==BAR)throw Error('history_gap');
 return out;
}
export function marketFromBars(bars){
 const t=bars.BTC?.at(-1)?.t;
 if(!Number.isSafeInteger(t)||COINS.some(c=>!Array.isArray(bars[c])||bars[c].length<380||bars[c].at(-1).t!==t))throw Error('market_not_aligned');
 const r={},momentum=zero(),rank=[],cross=zero();
 for(const c of COINS){
  const b=bars[c],p=b.map(z=>z.c),n=p.length-1,rets=[];
  for(let j=n-59;j<=n;j++)rets.push(Math.log(p[j]/p[j-1]));
  const vol=Math.max(.01,std(rets)*Math.sqrt(6));
  const e20=ema(p,20),e80=ema(p,80),e200=ema(p,200);
  const m14=p[n]/p[n-84]-1,m60=p[n]/p[n-360]-1;
  const magnitude=.25*Math.min(1.35,.025/vol);
  const side=m14>0&&m60>0?1:m14<0&&m60<0?-1:0;
  momentum[c]=magnitude*side;rank.push({c,magnitude,return:p[n]/p[n-168]-1});
  r[c]={latest:p[n],prior:p[n-1],dayAgo:p[n-6],vol,m14,
    e20:e20[n],e80:e80[n],e200:e200[n],
    threeBelow:b.slice(-3).every((z,j)=>z.c<e80[e80.length-3+j])};
 }
 rank.sort((a,b)=>a.return-b.return);
 if(rank.at(-1).return-rank[0].return>=.05){cross[rank[0].c]=-rank[0].magnitude;cross[rank.at(-1).c]=rank.at(-1).magnitude;}
 const raw=Object.fromEntries(COINS.map(c=>[c,.5*(momentum[c]+cross[c])]));
 const b=r.BTC,bear=b.latest<b.e200&&b.e20<b.e80&&b.threeBelow&&b.m14<0,
   bull=b.latest>b.e200&&b.e20>b.e80&&b.m14>0;
 return {t,raw:clamp(raw,1),reference:r,bull,bear};
}
export function initial(quotes,m,ms){
 if(COINS.some(c=>!valid(quotes[c])))throw Error('initial_prices_invalid');
 const s={schema:'lumex_lyra_paper_v2',version:2,orders_enabled:false,live_approved:false,
  mode:'independent_paper_only',source:'Gate_public_USDT_perpetual',
  started_ms:ms,last_ms:ms,last_bar_t:m.t,last_rebalance_t:m.t-18*BAR,
  nav:10000,nav_2x:10000,peak:10000,dd:0,weights:zero(),raw:zero(),
  last_prices:{...quotes},market:m,regime:'BOOTSTRAP',status:'observing',
  risk:{shock_until_ms:0,shock_bar_t:0,calm:0},ticks:1,bars:0,changes:0,
  data_gaps:0,archive_gaps:0,events:[],seq:0,points:[],last_error:null,short_enabled:false};
 if(m.reference.BTC.latest/m.reference.BTC.prior-1<=-.045||
     m.reference.BTC.latest/m.reference.BTC.dayAgo-1<=-.09){
  s.risk.shock_until_ms=ms+48*3600000;s.risk.shock_bar_t=m.t;s.regime='COOLDOWN';
 }
 event(s,ms,'initial_observation_no_backdated_profit',{start_usdt:10000});
 return s;
}
export function advance(old,quotes,newMarket,ms){
 if(old?.schema!=='lumex_lyra_paper_v2'||old.orders_enabled!==false||old.short_enabled!==false)throw Error('paper_state_not_safe');
 const s=structuredClone(old);
 if(ms===s.last_ms)return {state:s,events:[]};
 if(ms<s.last_ms)throw Error('clock_reversed');
 if(COINS.some(c=>!valid(quotes[c])))throw Error('invalid_quote');
 checkWeights(s.weights);
 const out=[],elapsed=ms-s.last_ms,prior=s.weights;
 if(elapsed>6*60000&&gross(prior)>.000001&&s.status==='observing'){
  s.status='halted_data_gap';s.data_gaps++;
  out.push(event(s,ms,'halt_unobserved_quote_gap',{minutes:rd(elapsed/60000,2)}));
  return {state:s,events:out};
 }
 if(s.status!=='observing')return {state:s,events:[]};
 const profit=COINS.reduce((v,c)=>v+prior[c]*(quotes[c]/s.last_prices[c]-1),0);
 const carry=gross(prior)*FUNDING*elapsed/DAY;
 s.nav=Math.max(.01,s.nav*(1+profit-carry));s.nav_2x=Math.max(.01,s.nav_2x*(1+profit-2*carry));
 s.peak=Math.max(s.peak,s.nav);s.dd=Math.max(s.dd,100*(1-s.nav/s.peak));
 s.last_ms=ms;s.last_prices={...quotes};s.ticks++;
 let newBar=false;
 if(newMarket&&newMarket.t!==s.last_bar_t){
  if(newMarket.t-s.last_bar_t!==BAR){
   s.status='halted_data_gap';s.data_gaps++;
   out.push(event(s,ms,'halt_missing_4h_candle',{from:s.last_bar_t,to:newMarket.t}));
   return {state:s,events:out};
  }
  s.last_bar_t=newMarket.t;s.market=newMarket;s.bars++;newBar=true;
  const b=newMarket.reference.BTC;
  const calm=b.latest/b.prior-1>-.02&&b.latest/b.dayAgo-1>-.045&&b.vol<.09;
  s.risk.calm=calm?s.risk.calm+1:0;
  if(s.last_bar_t-s.last_rebalance_t>=18*BAR){s.raw=newMarket.raw;s.last_rebalance_t=s.last_bar_t;}
 }
 const m=s.market,btc=m.reference.BTC;
 const btc4=quotes.BTC/btc.latest-1,btc24=quotes.BTC/btc.dayAgo-1;
 const cross=COINS.filter(c=>quotes[c]/m.reference[c].latest-1<=-.065).length;
 const completedShock=newBar&&(btc.latest/btc.prior-1<=-.045||btc.latest/btc.dayAgo-1<=-.09||
    COINS.filter(c=>m.reference[c].latest/m.reference[c].prior-1<=-.065).length>=3);
 const shock=completedShock||btc4<=-.045||btc24<=-.09||cross>=3;
 if(shock&&s.risk.shock_bar_t!==s.last_bar_t){
  s.risk.shock_bar_t=s.last_bar_t;s.risk.shock_until_ms=ms+48*3600000;s.risk.calm=0;
  out.push(event(s,ms,'shock_observed_at_minute_quote',{btc_4h_pct:rd(btc4*100,3),btc_24h_pct:rd(btc24*100,3),cross_assets:cross}));
 }
 let target=prior,regime=s.regime;
 if(s.dd>=12){target=zero();regime='HALTED';s.status='halted_drawdown';}
 else if(s.risk.shock_until_ms>ms||
       s.risk.shock_until_ms>0&&s.risk.calm<3){target=zero();regime='COOLDOWN';}
 else if(newBar){
  if(m.bear){target=zero();regime='BEAR_PAUSE';}
  else if(m.bull){target=clamp(s.raw,s.dd>=8?.35:1);regime=s.dd>=8?'CAUTION_DRAWDOWN':'NORMAL';}
  else {target=clamp(s.raw,.35);regime='CAUTION';if(btc24<-.04)
    target=Object.fromEntries(COINS.map(c=>[c,Math.min(0,target[c])]));}
 }
 if(shock||s.risk.shock_until_ms>ms){target=zero();regime='COOLDOWN';}
 checkWeights(target);
 const turnover=diff(target,prior);
 if(turnover>1e-8){
  const cost=turnover*FEE;
  s.nav=Math.max(.01,s.nav*(1-cost));s.nav_2x=Math.max(.01,s.nav_2x*(1-2*cost));
  s.weights=clamp(target,1);s.changes++;
  out.push(event(s,ms,'paper_exposure_changed_at_observed_quote',{from:prior,to:s.weights,
   turnover:rd(turnover,6),slippage_and_fee_model:0.0009,real_exchange_fill:false}));
 }
 if(regime!==s.regime){out.push(event(s,ms,'regime_changed',{from:s.regime,to:regime}));s.regime=regime;}
 s.peak=Math.max(s.peak,s.nav);s.dd=Math.max(s.dd,100*(1-s.nav/s.peak));
 if(s.dd>=12&&s.status==='observing'){
  const fee=gross(s.weights)*FEE;
  s.nav*=1-fee;s.nav_2x*=1-2*fee;s.weights=zero();
  s.status='halted_drawdown';s.regime='HALTED';
  out.push(event(s,ms,'portfolio_drawdown_halted',{drawdown_pct:rd(s.dd,3)}));
 }
 if(Math.floor(ms/300000)!==Math.floor((ms-elapsed)/300000)){
  s.points.push({ms,nav:rd(s.nav,4),nav_2x:rd(s.nav_2x,4),regime:s.regime});
  s.points=s.points.slice(-360);
 }
 if(newBar)out.push(event(s,ms,'confirmed_4h_observed',{bar_unix:s.last_bar_t}));
 return {state:s,events:out};
}
export function evaluateForward(s){
 const reasons=[];
 if(!s)return {screen_passed:false,reasons:['not_initialized'],live_approved:false,orders_enabled:false};
 if(s.last_ms-s.started_ms<60*DAY)reasons.push('under_60_forward_days');
 if(s.bars<360)reasons.push('under_360_consecutive_4h_bars');
 if(s.changes<8)reasons.push('under_8_paper_position_changes');
 if(s.nav<=10000||s.nav_2x<=10000)reasons.push('net_or_2x_cost_not_positive');
 if(s.dd>10)reasons.push('paper_drawdown_over_10pct');
 if(s.data_gaps||s.archive_gaps||s.status!=='observing')reasons.push('data_reliability_or_risk_halt');
 return {screen_passed:reasons.length===0,reasons,live_approved:false,orders_enabled:false,
   real_orders_require_manual_approval_and_execution_audit:true};
}
const cleanError=x=>String(x?.message||x||'failed').replace(/[^A-Za-z0-9_-]/g,'_').slice(0,64);
async function publicGet(url,max){
 const r=await fetch(url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(8500)});
 if(!r.ok)throw Error('gate_http_'+r.status);
 const body=await r.text();if(body.length<2||body.length>max)throw Error('public_payload_size');
 try{return JSON.parse(body)}catch{throw Error('public_json_invalid')}
}
async function publicQuotes(){
 const arr=await Promise.all(COINS.map(c=>publicGet('https://api.gateio.ws/api/v4/futures/usdt/tickers?contract='+c+'_USDT',15000)));
 return Object.fromEntries(COINS.map((c,i)=>[c,parseQuote(arr[i],c)]));
}
async function publicClosedMarket(ms){
 const arr=await Promise.all(COINS.map(c=>publicGet('https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract='+c+'_USDT&interval=4h&limit=510',180000)));
 return marketFromBars(Object.fromEntries(COINS.map((c,i)=>[c,closedBars(arr[i],ms)])));
}
export async function runPaperTick(storage,env,ms=Date.now()){
 if(!env.MARKET_DATA)throw Error('r2_missing');
 const previous=await storage.get('lyra_paper_state_v2');
 if(previous?.status==='halted_drawdown'||previous?.status==='halted_data_gap')
   return {ok:true,status:previous.status,orders_enabled:false,halt_requires_review:true};
 const quotes=await publicQuotes();
 const expected=Math.floor(ms/1000/BAR)*BAR-BAR;
 let market=null;
 if(!previous||expected>previous.last_bar_t){
  try{market=await publicClosedMarket(ms)}catch(e){
   if(!previous)throw e;
   const s=structuredClone(previous);s.last_error=cleanError(e);
   if(ms-(expected+BAR)*1000>15*60000){
     s.status='halted_data_gap';s.data_gaps++;
     event(s,ms,'halt_missing_confirmed_bar_after_15min',{error:s.last_error});
   }
   await storage.put('lyra_paper_state_v2',s);
   return {ok:false,status:s.status,reason:s.last_error,orders_enabled:false};
  }
 }
 const result=previous?advance(previous,quotes,market,ms):{state:initial(quotes,market,ms),events:[]};
 const s=result.state;
 await storage.put('lyra_paper_state_v2',s);
 try{
  const put=(key,value)=>env.MARKET_DATA.put(PREFIX+key,JSON.stringify(value),
    {httpMetadata:{contentType:'application/json'}});
  const writes=[];
  if(!previous||Math.floor(ms/300000)!==Math.floor(previous.last_ms/300000))
   writes.push(put('snapshots/'+new Date(ms).toISOString().slice(0,10)+'/'+ms+'.json',
    {at_ms:ms,nav_usdt:s.nav,nav_cost2x_usdt:s.nav_2x,weights:s.weights,regime:s.regime,status:s.status,orders_enabled:false}));
  if(result.events.length||!previous){
   writes.push(put('latest.json',s));
   for(const e of result.events)writes.push(put('events/'+String(e.id).padStart(10,'0')+'.json',e));
  }
  await Promise.all(writes);
 }catch(e){
  console.warn('lyra_r2_archive_lagging',cleanError(e));
  s.archive_gaps++;s.last_error='r2_archive_lagging';
  await storage.put('lyra_paper_state_v2',s);
 }
 return {ok:true,status:s.status,observed_ms:ms,nav_usdt:rd(s.nav,4),events:result.events.length,orders_enabled:false};
}
export async function report(storage){
 const s=await storage.get('lyra_paper_state_v2');
 if(!s)return {ok:true,status:'not_started',paper_only:true,live_approved:false,orders_enabled:false};
 return {ok:true,status:s.status,paper_only:true,live_approved:false,orders_enabled:false,
  source:s.source,observation:'Gate HTTP ticker sampled at ~1-minute cron (not tick-by-tick)',
  started_ms:s.started_ms,last_observed_ms:s.last_ms,last_closed_4h_unix:s.last_bar_t,
  nav_usdt:rd(s.nav,4),nav_cost2x_usdt:rd(s.nav_2x,4),return_pct:rd((s.nav/10000-1)*100,3),
  max_drawdown_pct:rd(s.dd,3),regime:s.regime,weights:s.weights,
  closed_bars:s.bars,ticker_observations:s.ticks,position_changes:s.changes,
  missed_data:s.data_gaps,archive_errors:s.archive_gaps,last_error:s.last_error,
  recent_events:s.events.slice(-30),equity_points:s.points.slice(-150),gate:evaluateForward(s)};
}
export async function privateReport(request,env){
 if(request.method!=='GET')return Response.json({ok:false,error:'method_not_allowed'},{status:405});
 const token=env.LUMEX_AI_LAB_WORKER_TOKEN;
 if(typeof token!=='string'||token.length<48||!env.LYRA_PAPER_RUNNER)
   return Response.json({ok:false,error:'not_configured'},{status:503});
 const got=request.headers.get('authorization')||'';
 if(!got.startsWith('Bearer ')||got.length>256)return Response.json({ok:false,error:'unauthorized'},{status:401});
 const hashes=await Promise.all([got.slice(7),token].map(async x=>new Uint8Array(
   await crypto.subtle.digest('SHA-256',new TextEncoder().encode(x)))));
 let mismatch=0;for(let i=0;i<32;i++)mismatch|=hashes[0][i]^hashes[1][i];
 if(mismatch)return Response.json({ok:false,error:'unauthorized'},{status:401});
 return env.LYRA_PAPER_RUNNER.getByName('lyra-paper-primary').fetch('https://lyra/report');
}
