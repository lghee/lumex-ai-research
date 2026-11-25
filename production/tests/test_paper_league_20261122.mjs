import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import {fill,markEquity,exitHit,applyFunding,newAccount,paperLeagueTick,serveLeague,serveDetail,START_USDT,TAKER,slipFor,runStrategy,makeMarket,STRATEGIES,applyRiskOverlay} from '../src/paper-league.mjs';
import {evaluateSingle,crossScores,rebalanceDue,regimeAt,emaSeeded} from '../src/paper-league-strategies.mjs';

const H=3600000,M=60000,D=86400000;
// ---------- accounting: fees + slippage on both sides, funding sign ----------
{const acc=newAccount({id:'t'},0);
 const o=fill(acc,{symbol:'BTCUSDT',side:'long',qty:0.1,ref:100000,kind:'open',reason:'x',now:1});
 assert.equal(o.price,100000*(1+slipFor('BTCUSDT')));
 const c=fill(acc,{symbol:'BTCUSDT',side:'long',qty:0.1,ref:101000,kind:'close',reason:'y',now:2});
 const entry=100020,exit=101000*(1-0.0002),fees=(entry*0.1+exit*0.1)*TAKER,net=(exit-entry)*0.1-fees;
 assert.ok(Math.abs(c.net_pnl-net)<1e-3,'net pnl includes both fees and slippage');
 assert.ok(Math.abs(acc.cash-(START_USDT+net))<1e-6);assert.equal(acc.trades,1);assert.equal(acc.wins,1);
 const s=newAccount({id:'s'},0);fill(s,{symbol:'SOLUSDT',side:'short',qty:10,ref:100,kind:'open',reason:'x',now:1});
 const p=s.positions.SOLUSDT;assert.equal(p.entry,100*(1-0.0005),'short sells below ref');
 p.last_mark=100;assert.equal(applyFunding(p,[{t:5,rate:0.0001},{t:0,rate:0.5}],2,10),10*100*0.0001,'short receives positive funding; pre-open rows ignored');
 const l={...p,side:'long'};assert.equal(applyFunding(l,[{t:5,rate:0.0001}],2,10),-0.1,'long pays positive funding');
 markEquity(s,{SOLUSDT:90});assert.ok(s.equity>START_USDT,'short gains when price falls');}
// ---------- intrabar exits: stop priority, gap fills at open ----------
{const p={side:'long',stop:95,take:110};
 assert.deepEqual(exitHit(p,{t:0,o:100,h:111,l:94,c:100}),{ref:95,reason:'손절'},'stop wins when both touched');
 assert.deepEqual(exitHit(p,{t:0,o:90,h:91,l:89,c:90}),{ref:90,reason:'손절(갭)'},'gap fills worse, at open');
 assert.deepEqual(exitHit(p,{t:0,o:100,h:112,l:99,c:111}),{ref:110,reason:'익절'});
 const s={side:'short',stop:105,take:90};assert.deepEqual(exitHit(s,{t:0,o:100,h:106,l:99,c:100}),{ref:105,reason:'손절'});
 assert.equal(exitHit({side:'long',time_stop_ms:10*M},{t:5*M,o:1,h:1,l:1,c:1}),null);
 assert.equal(exitHit({side:'long',time_stop_ms:10*M},{t:9*M,o:1,h:1,l:1,c:1.5}).reason,'보유 시간 종료');}
// ---------- parity with the registered PHP rules (Core) ----------
const mkBars=(n,frame,start,seed=1,end=Date.UTC(2026,10,22))=>{let x=seed,c=start;const out=[];
  for(let i=0;i<n;i++){x=(x*16807)%2147483647;const r=(x/2147483647-0.5)*0.03;const o=c;c=Math.max(0.01,c*(1+r+0.0004*Math.sin(i/40)));
    out.push({t:end-(n-i)*frame,o,h:Math.max(o,c)*1.004,l:Math.min(o,c)*0.996,c,v:100});}return out;};
const CORE=process.env.LUMEX_CORE_DIR;
if(CORE&&fs.existsSync(CORE)){
  const php=(code,input)=>execFileSync('php',['-r',code],{input:JSON.stringify(input)}).toString();
  for(const [kind,strategy] of [['btc','btc-trend-v037'],['eth','eth-asym-v037']])for(const seed of [3,7,11,19]){
    const bars=mkBars(300,4*H,30000,seed);
    const js=evaluateSingle(kind,bars);
    const out=JSON.parse(php(`define('ABSPATH','/');require '${CORE}/includes/class-lumex-demo-autotrade.php';$b=json_decode(stream_get_contents(STDIN),true);$r=Lumex_Demo_Autotrade::evaluate('${strategy}',$b);echo json_encode([$r['signal'],$r['exit_long'],$r['exit_short']]);`,bars));
    assert.deepEqual([js.signal,js.exit_long,js.exit_short],out,`${strategy} seed ${seed} identical to Core`);
  }
  for(const key of ['rs28-core','rs28-alt','beta-residual','vol-normal'])for(const seed of [2,5]){
    const close={};['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT'].forEach((s,i)=>close[s]=mkBars(673,H,100*(i+1),seed+i*13).map(b=>b.c));
    const js=crossScores(key,close,null);
    const out=JSON.parse(php(`define('ABSPATH','/');require '${CORE}/includes/class-lumex-cross-asset-signals.php';$c=json_decode(stream_get_contents(STDIN),true);$last=(int)(504000*3600000-3600000);
      $r=Lumex_Cross_Asset_Signals::evaluate('${key}',['ok'=>true,'close'=>$c,'last_bar_ms'=>$last]);$legs=$r['legs'];echo json_encode([$r['code'],round($r['score_gap'],10),$legs?$legs[0]['symbol']:null,$legs?$legs[1]['symbol']:null]);`,close));
    assert.deepEqual([js.signal?'signal':'flat',Number(js.gap.toFixed(10)),js.signal?js.weak:null,js.signal?js.strong:null],out,`${key} seed ${seed} identical to Core`);
  }
  console.log('  parity with Core PHP rules: OK');
}else console.log('  (LUMEX_CORE_DIR not set: PHP parity skipped)');
// rebalance calendar: slot % (days*24) at UTC bar close
assert.equal(rebalanceDue(0,3*D-H,3),false,'never on the first observed bar');
assert.equal(rebalanceDue(3*D-2*H,3*D-H,3),true);assert.equal(rebalanceDue(3*D-H,3*D,3),false);
assert.equal(regimeAt(mkBars(80,4*H,100)),null,'short history: no regime');

// ---------- end-to-end: mocked Bybit, several ticks, forward-only ----------
const t0=Date.UTC(2026,10,22,9,1);
const base={BTCUSDT:90000,ETHUSDT:3200,SOLUSDT:140,XRPUSDT:2.1,DOGEUSDT:0.38};
const frames={'1':M,'60':H,'240':4*H,'D':D};
const price=(s,t)=>{const b=base[s]||5;return b*Math.exp((t-t0)/(80*D))*(1+0.03*Math.sin(t/(9*H))+0.01*Math.sin(t/(37*M)));};
let calls=[];
const coreDoc={schema:'lumex_public_ai_bots_v1',bots:[{key:'btc-trend',performance:{provenance:'continuous_paper_carry_v3',carry_seed_usdt:12682,equity_usdt:13400,mdd_pct:4.2,closed_trades:5,since_carry_return_pct:5.66,last_bar_ms:t0+4*H,
  points:[{at:t0-48*H,equity:12682,phase:'replay'},{at:t0-20*H,equity:12950,phase:'forward'},{at:t0-4*H,equity:13010,phase:'forward'},{at:t0+4*H,equity:13400,phase:'forward'}]}},
  {key:'eth-asym',performance:{provenance:'continuous_paper_carry_v3',carry_seed_usdt:99999,equity_usdt:5,points:[]}}]};
const fetchImpl=async url=>{calls.push(url);const u=new URL(url);const s=u.searchParams.get('symbol');
  if(u.hostname==='lumexbot.com')return new Response(JSON.stringify(coreDoc));
  if(u.pathname.endsWith('/tickers')){const p=price(s,fetchImpl.now);return new Response(JSON.stringify({retCode:0,result:{list:[{symbol:s,lastPrice:String(p),markPrice:String(p)}]}}));}
  if(u.pathname.endsWith('/funding/history')){const list=[];for(let k=0;k<60;k++){const t=Math.floor(fetchImpl.now/(8*H))*8*H-k*8*H;list.push({symbol:s,fundingRate:'0.0001',fundingRateTimestamp:String(t)});}return new Response(JSON.stringify({retCode:0,result:{list}}));}
  const iv=u.searchParams.get('interval'),f=frames[iv],lim=Number(u.searchParams.get('limit'));const end=Math.floor(fetchImpl.now/f)*f;const list=[];
  const startQ=u.searchParams.get('start');const first=startQ?Math.max(Number(startQ),end-(lim-1)*f):end-(lim-1)*f;
  for(let t=first;t<=end;t+=f){const o=price(s,t),c=price(s,t+f-1),h=Math.max(o,c)*1.002,l=Math.min(o,c)*0.998;list.push([String(t),String(o),String(h),String(l),String(c),'10']);}
  return new Response(JSON.stringify({retCode:0,result:{list:list.reverse()}}));};
const store=new Map();
const env={MARKET_DATA:{get:async k=>store.has(k)?{json:async()=>JSON.parse(store.get(k))}:null,put:async(k,v)=>{store.set(k,v)}}};
const scan={schema:'lumex_pro50_scanner_v1',items:Object.keys(base).map((s,i)=>({symbol:s,coin:s.slice(0,-4),rank:i+1,funding_pct:i===2?0.05:0.01,funding_percentile_30d:i===2?99:50,regimes:{'4h':{status:'ok',state:'up'}}}))};
let now=t0;
for(let k=0;k<40;k++){ // ~3h20m of 5-minute ticks, then a daily boundary
  fetchImpl.now=now;store.set('market-hub/pro50/scanner-v1.json',JSON.stringify({...scan,generated_at_ms:now-60000}));
  const r=await paperLeagueTick(env,{now,fetchImpl});assert.equal(r.ok,true);now+=5*M;
}
assert.equal((await paperLeagueTick(env,{now:now-5*M+60000,fetchImpl})).skipped,'recent_tick','no double tick within ~3 minutes');
const st=JSON.parse(store.get('paper-league/v1/state.json'));
assert.equal(Object.keys(st.accounts).length,STRATEGIES.length);assert.equal(STRATEGIES.length,19);
for(const a of Object.values(st.accounts)){assert.equal(a.started_ms,t0,'league start');assert.ok(Number.isFinite(a.equity)&&a.equity>0);}
const sum=st.summary;assert.equal(sum.schema,'lumex_paper_league_summary_v1');assert.equal(sum.order_execution,false);
assert.equal(sum.strategies.length,19);assert.ok(sum.strategies.every(x=>x.id&&x.name&&Array.isArray(x.rules)&&x.rules.length>=3));
assert.equal(sum.strategies.filter(x=>STRATEGIES.find(d=>d.id===x.id).origin==='existing').length,7);
assert.ok(calls.every(u=>u.startsWith('https://api.bybit.com/v5/market/')||u==='https://lumexbot.com/wp-json/lumex/v1/public/ai-bots'),'public Bybit market + Core public bots only');
// ---- carry: backtest ending equity, then Core paper value AT league start (no overlap double count)
{const b=st.accounts['btc-trend'],e=st.accounts['eth-asym'],v=st.accounts['vol-normal'],n=st.accounts['nexus-ml-ensemble'];
 assert.equal(b.carry.stage,'core');assert.equal(b.carry.seed_usdt,13010,'handover = last Core point at or before league start (not the later 13,400)');
 assert.equal(b.carry.backtest.ending_usdt,12682);assert.equal(b.carry.core_paper.points_imported,3);
 assert.equal(e.carry.stage,'archive','Core row not descending from the archived backtest is rejected');assert.equal(e.carry.seed_usdt,10798);
 assert.equal(v.carry.stage,'archive');assert.equal(v.carry.seed_usdt,10655.47);
 assert.equal(n.carry,undefined,'new strategies start at 10,000');
 const bs=sum.strategies.find(x=>x.id==='btc-trend');assert.ok(Math.abs(bs.equity-(13010+(b.equity-13010)))<0.01);
 assert.equal(bs.forward_start_usdt,13010);assert.ok(bs.return_pct>29,'cumulative return vs 10,000 includes backtest + Core paper');
 const hb=JSON.parse(store.get('paper-league/v1/history/btc-trend.json'));assert.equal(hb.points[0][0],Math.floor((t0-48*H)/H)*H,'Core curve imported before league points');
 assert.ok(hb.points.every((p,i)=>!i||p[0]>=hb.points[i-1][0]));
 assert.equal(sum.retired.length,0);}
// every recorded trade carries fees; closes carry pnl
let trades=0;
for(const d of STRATEGIES){const h=JSON.parse(store.get('paper-league/v1/history/'+d.id+'.json'));trades+=h.trades.length;
  for(const t of h.trades){assert.ok(t.fee>0);if(t.type==='close')assert.ok(Number.isFinite(t.net_pnl));}
  assert.ok(h.points.length>=1&&h.points.every(p=>p[0]%H===0));}
globalThis.__E2E_TRADES=trades;
// serving
const ok=await serveLeague(env,now);assert.equal(ok.status,200);
assert.equal((await serveLeague(env,now+3*H)).status,503,'stale summary not served');
assert.equal((await serveDetail(new Request('https://x/?id=btc-trend'),env)).status,200);
assert.equal((await serveDetail(new Request('https://x/?id=nope'),env)).status,400);
// data outage: no price → no fills, account flagged, nothing invented
{const acc=newAccount({id:'o'},t0);const def={id:'o',interval:'60',decide:async()=>({target:[{symbol:'BTCUSDT',side:'long',weight:0.5}]})};
 const dead=async()=>new Response('x',{status:503});const m=makeMarket(dead,t0+2*H);acc.last_bar=t0-H;
 const r=await runStrategy(def,acc,m,{prices:{}});assert.equal(Object.keys(acc.positions).length,0);assert.ok(r.events.some(e=>/시세 없음/.test(e.text)));}
// ---- risk overlay: half at 8%, flat + cooldown at 15%, gross cap
{const acc=newAccount({id:'r'},0);acc.memo={risk_peak:10000};acc.cash=9100;const R={ddHalf:0.08,ddFlat:0.15,cooldownH:48,maxGross:1.5};
 const o={target:[{symbol:'BTCUSDT',side:'long',weight:0.6},{symbol:'ETHUSDT',side:'long',weight:0.6}]};applyRiskOverlay(R,acc,o,{prices:{}},1000,[]);
 assert.equal(acc.memo.risk_state,'half');assert.equal(o.target[0].weight,0.3);
 acc.cash=8400;const o2={target:[{symbol:'BTCUSDT',side:'long',weight:0.5}]};const ev=[];applyRiskOverlay(R,acc,o2,{prices:{}},2000,ev);
 assert.deepEqual(o2.target,[]);assert.equal(acc.memo.risk_state,'flat');assert.ok(acc.memo.cooldown_until===2000+48*H);
 const o3={target:[{symbol:'BTCUSDT',side:'long',weight:0.5}]};applyRiskOverlay(R,acc,o3,{prices:{}},3000,[]);assert.deepEqual(o3.target,[],'cool-down holds');
 const o4={target:[{symbol:'BTCUSDT',side:'long',weight:1},{symbol:'ETHUSDT',side:'short',weight:1}]};applyRiskOverlay(R,acc,o4,{prices:{}},2000+49*H,[]);
 assert.equal(acc.memo.risk_state,'normal','fresh risk peak after cool-down');assert.equal(o4.target[0].weight+o4.target[1].weight,1.5,'gross capped at 150%');}
console.log(`PASS paper league: accounting, intrabar exits, funding, Core-rule parity, forward-only e2e (${trades} trades), serving, outage`);
