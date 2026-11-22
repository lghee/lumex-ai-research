import assert from 'node:assert/strict';
import {parseKlines,classify,percentileRank,quadrant,mergePoint,emptyRolling,validRolling,pruneRolling,
  pointFromArchive,buildScanner,emptyRegimes,updatePro50,serveScanner,serveSeries,validScanner} from '../src/pro50-scanner.mjs';

const H=3600000,now=Date.UTC(2026,10,22,9,7),hour=Math.floor(now/H)*H;
// ---- klines: forming bar dropped, gaps rejected, bad OHLC rejected
const mk=(n,frame,startClose=100,drift=0.2,end=hour)=>{const list=[];let c=startClose;
  for(let i=0;i<n;i++){const t=end-(n-1-i)*frame;const o=c;c=Math.max(1,c+drift+Math.sin(i/3)*0.6);list.push([String(t),String(o),String(Math.max(o,c)+0.3),String(Math.min(o,c)-0.3),String(c),'10']);}
  return {retCode:0,result:{list:list.reverse()}};};
const raw=mk(201,H);
const rows=parseKlines(raw,H,now);
assert.equal(rows.length,200,'forming bar excluded');
assert.ok(rows.every((x,i)=>!i||x.t-rows[i-1].t===H));
const gap=structuredClone(raw);gap.result.list.splice(20,1);
assert.equal(parseKlines(gap,H,now),null,'gap rejected');
const bad=structuredClone(raw);bad.result.list[5][2]='0.0001';
assert.equal(parseKlines(bad,H,now),null,'high below close rejected');
assert.equal(parseKlines({retCode:10001},H,now),null);
// ---- classify: rising series = up, falling = down, short history = insufficient, stale = stale
const up=classify(rows,H,now);assert.equal(up.status,'ok');assert.equal(up.direction,'up');assert.ok(up.rsi>=54);
assert.equal(up.closed_ms,hour);
const down=classify(parseKlines(mk(201,H,400,-0.6),H,now),H,now);assert.equal(down.direction,'down');
assert.equal(classify(rows.slice(-80),H,now).status,'insufficient');
assert.equal(classify(rows,H,now+5*H).status,'stale');
// ---- percentile needs ≥72 samples; quadrant labels
assert.equal(percentileRank([1,2,3],2),null);
const xs=Array.from({length:100},(_,i)=>i);
assert.equal(percentileRank(xs,99),99.5);assert.equal(percentileRank(xs,-5),0);
assert.equal(quadrant(2,5),'price_up_oi_up');assert.equal(quadrant(-2,5),'price_down_oi_up');
assert.equal(quadrant(2,-5),'price_up_oi_down');assert.equal(quadrant(-2,-5),'price_down_oi_down');
assert.equal(quadrant(3,0.4),'oi_flat');assert.equal(quadrant(null,4),null);
// ---- rolling merge keeps order, fills only missing fields, prunes old hours
const roll=emptyRolling();
mergePoint(roll,'BTCUSDT',[hour,100,5,0.01,0.012,null]);
mergePoint(roll,'BTCUSDT',[hour-2*H,98,4,0.01,null,null]);
mergePoint(roll,'BTCUSDT',[hour,999,999,999,999,7e9]);
assert.deepEqual(roll.points.BTCUSDT.map(p=>p[0]),[hour-2*H,hour]);
assert.deepEqual(roll.points.BTCUSDT[1],[hour,100,5,0.01,0.012,7e9],'archive/current values kept, only null filled');
assert.ok(validRolling(roll));
mergePoint(roll,'BTCUSDT',[hour-800*H,1,1,1,1,null]);pruneRolling(roll,now,new Set(['BTCUSDT']));
assert.equal(roll.points.BTCUSDT[0][0],hour-2*H,'older than 30d pruned');
// ---- archive point: wrong hour or schema yields nothing (no guessing)
const arch={schema:'lumex_uid_top50_venue_matrix_v1',order_execution:false,snapshot_hour_ms:hour-H,markets:{BTCUSDT:[
  {exchange:'Binance',status:'observed',funding_pct:0.02},{exchange:'Bybit',status:'observed',mark_price:99,oi_usd:4.5,funding_pct:0.015},
  {exchange:'OKX',status:'unavailable'},{exchange:'Bitget',status:'unavailable'},{exchange:'Gate',status:'unavailable'}]}};
assert.deepEqual(pointFromArchive(arch,'BTCUSDT',hour-H),[hour-H,99,4.5,0.015,0.02,null]);
assert.equal(pointFromArchive(arch,'BTCUSDT',hour),null);
assert.equal(pointFromArchive(arch,'ETHUSDT',hour-H),null);

// ---- end to end with in-memory R2 + mocked Bybit klines
const universe={ok:true,schema:'lumex_uid_top50_v1',order_execution:false,generated_at_ms:now-60000,count:2,items:[
  {symbol:'BTCUSDT',coin:'BTC',rank:1,venue:'Bybit',last_price:102,change_24h_pct:2,turnover_24h_usdt:9e9,oi_usd:5.5e9,funding_pct:0.03},
  {symbol:'NEWUSDT',coin:'NEW',rank:2,venue:'Bybit',last_price:1.5,change_24h_pct:-3,turnover_24h_usdt:4e8,oi_usd:null,funding_pct:-0.01}]};
const venue={schema:'lumex_uid_top50_venue_matrix_v1',ok:true,order_execution:false,generated_at_ms:now-30000,markets:{
  BTCUSDT:[{exchange:'Binance',status:'observed',funding_pct:0.025},{exchange:'Bybit',status:'observed',funding_pct:0.03,oi_usd:5.5e9},
    {exchange:'OKX',status:'observed',oi_usd:2e9},{exchange:'Bitget',status:'observed',funding_pct:0.01},{exchange:'Gate',status:'unavailable'}]}};
const store=new Map([['market-hub/universe/bybit-linear-top50-v1.json',universe],['market-hub/universe/top50-five-venues-v1.json',venue]]);
// 100 archived hours for BTC (OI 5.0e9 24h ago, funding 0.000..0.0099)
for(let k=1;k<=100;k++){const h=hour-k*H;store.set('market-hub/universe/venue-history/v1/'+h+'.json',{schema:'lumex_uid_top50_venue_matrix_v1',order_execution:false,snapshot_hour_ms:h,
  markets:{BTCUSDT:[{exchange:'Binance',status:'observed',funding_pct:0.01},{exchange:'Bybit',status:'observed',mark_price:100,oi_usd:k===24?5e9:4.8e9,funding_pct:(k%100)*0.0001},
  {exchange:'OKX',status:'unavailable'},{exchange:'Bitget',status:'unavailable'},{exchange:'Gate',status:'unavailable'}]}});}
const env={MARKET_DATA:{get:async k=>store.has(k)?{size:JSON.stringify(store.get(k)).length,json:async()=>structuredClone(store.get(k))}:null,
  put:async(k,v)=>{store.set(k,JSON.parse(v))}}};
const calls=[];
const fetchImpl=async url=>{calls.push(url);const u=new URL(url);const iv=u.searchParams.get('interval');const sym=u.searchParams.get('symbol');
  const frame=iv==='60'?H:iv==='240'?4*H:24*H;const end=Math.floor(now/frame)*frame;
  if(sym==='NEWUSDT')return new Response(JSON.stringify(mk(40,frame,1,0.01,end)),{status:200});
  return new Response(JSON.stringify(mk(201,frame,100,0.2,end)),{status:200});};
let res;
for(let i=0;i<6;i++)res=await updatePro50(env,{now,fetchImpl});
assert.equal(res.ok,true,JSON.stringify(res));
assert.ok(calls.every(u=>u.startsWith('https://api.bybit.com/v5/market/kline?category=linear&symbol=')),'only official Bybit klines');
const scan=store.get('market-hub/pro50/scanner-v1.json');assert.ok(validScanner(scan,now));
const btc=scan.items.find(x=>x.symbol==='BTCUSDT'),nw=scan.items.find(x=>x.symbol==='NEWUSDT');
assert.equal(btc.oi_change_24h_pct,10,'5.5e9 vs archived 5e9 24h ago');
assert.equal(btc.flow_quadrant,'price_up_oi_up');
assert.ok(btc.funding_samples>=72&&btc.funding_percentile_30d!==null&&btc.funding_percentile_30d>99,'current funding above own history');
assert.equal(btc.funding_venue_spread_pct,0.02);
assert.equal(btc.turnover_vs_7d,null,'turnover history needs 72 samples; archive has none');
assert.equal(btc.regimes['1h'].status,'ok');assert.equal(btc.regimes['4h'].direction,'up');assert.equal(btc.regimes['1d'].status,'ok');
assert.equal(nw.regimes['1h'].status,'insufficient','new listing: no regime invented');
assert.equal(nw.oi_change_24h_pct,null);assert.equal(nw.funding_percentile_30d,null);assert.equal(nw.flow_quadrant,null);
assert.equal(store.get('market-hub/pro50/rolling-v1.json').points.BTCUSDT.length,101);
// stale universe stops the run
assert.equal((await updatePro50(env,{now:now+20*60000,fetchImpl})).ok,false);
// serving
assert.equal((await serveScanner(env,now)).status,200);
assert.equal((await serveScanner(env,now+20*60000)).status,503);
const series=await (await serveSeries(new Request('https://x/market-hub/v1/pro50-series?symbol=BTCUSDT'),env,now)).json();
assert.equal(series.ok,true);assert.equal(series.points.length,101);assert.equal(series.interpolated,false);
assert.equal((await serveSeries(new Request('https://x/?symbol=DOGEUSDT'),env,now)).status,400,'outside verified universe');
assert.equal((await serveSeries(new Request('https://x/?symbol=bad'),env,now)).status,400);
console.log('PASS pro50 scanner: klines, regime rules, percentile, quadrant, rolling seed, e2e, serving');
