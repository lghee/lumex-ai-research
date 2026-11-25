import assert from 'node:assert/strict';
import {CRYPTO_BASES,normalizeTickers,parseGateHourlyStats,collectHeatmapStats,attachStats,heatmapPublicRoute} from '../src/public-heatmap.mjs';
const H=3600,NOW=Date.parse('2026-11-25T08:20:00Z'),nowSec=NOW/1000;
const hour=Math.floor(nowSec/H)*H; // 08:00 — still open
// 26 hourly rows: 06:00 the day before .. 07:00 today closed, 08:00 open
const rows=[];for(let i=26;i>=0;i--){const t=hour-i*H;rows.push({time:t,open_interest_usd:1e6*(i===25?100:i===1?125:110),long_liq_usd:i===0?999999:1000,short_liq_usd:i===0?999999:500});}
const s=parseGateHourlyStats(rows,nowSec);
assert.equal(s.sample_unix,hour,'latest closed hour (07:00 row) ends at 08:00');
assert.equal(s.oi_change_24h_pct,25,'OI 125M vs 100M 24h earlier');
assert.deepEqual(s.liq_24h,{long_usdt:24000,short_usdt:12000,hours:24},'24 closed hours, open hour excluded');
// gaps: fewer than 22 hours → no liquidation total; missing 24h-ago point → no OI change
const gappy=rows.filter((r,i)=>i%5!==0);const g=parseGateHourlyStats(gappy,nowSec);
assert.equal(g.liq_24h,null);
const noAgo=rows.filter(r=>r.time!==hour-25*H);assert.equal(parseGateHourlyStats(noAgo,nowSec).oi_change_24h_pct,null);
assert.throws(()=>parseGateHourlyStats(rows.map(r=>({...r,time:r.time-10*H})),nowSec),/stale/);
assert.throws(()=>parseGateHourlyStats({},nowSec),/schema/);
// collector: 10 per run, stalest first, failures recorded and retried later
const tick=i=>({contract:CRYPTO_BASES[i]+'_USDT',last:String(100+i),change_percentage:'1',volume_24h_quote:String(1e9-i*1e6),funding_rate:'0.0001'});
const board=normalizeTickers(Array.from({length:60},(_,i)=>tick(i)),NOW-60000);
const saved=new Map([['market-hub/free-heatmap/v1/latest.json',JSON.stringify(board)]]);
const bucket={get:async k=>saved.has(k)?{json:async()=>JSON.parse(saved.get(k))}:null,put:async(k,v)=>saved.set(k,String(v))};
const env={MARKET_DATA:bucket};const asked=[];
const fetchFn=async url=>{const c=/contract=([A-Z0-9]+)_USDT/.exec(url)[1];asked.push(c);
  if(c==='ETH')return new Response('x',{status:500});return new Response(JSON.stringify(rows),{status:200});};
let r=await collectHeatmapStats(env,NOW,{batch:10,fetchFn});
assert.equal(asked.length,10);assert.equal(r.refreshed,9);assert.equal(r.failed,1);
const st=JSON.parse(saved.get('market-hub/free-heatmap/v1/stats.json'));
assert.equal(st.schema,'lumex_public_heatmap_stats_v1');assert.equal(st.coins.BTC.oi_change_24h_pct,25);assert.ok(st.coins.ETH.attempted_ms&&!st.coins.ETH.fetched_ms);
asked.length=0;await collectHeatmapStats(env,NOW+300000,{batch:10,fetchFn});
assert.ok(!asked.includes('BTC')&&asked.length===10,'second run takes the next 10 (stalest first)');
for(let k=2;k<6;k++)await collectHeatmapStats(env,NOW+k*300000,{batch:10,fetchFn});
// route: stats merged into rows, fresh only
const res=await heatmapPublicRoute(new Request('https://x/market-hub/v1/public-heatmap'),env,NOW+30*60000);
const out=await res.json();
assert.equal(out.stats.available,true);assert.equal(out.stats.exchange,'Gate');assert.equal(out.stats.window_hours,24);
const btc=out.coins.find(c=>c.coin==='BTC');assert.equal(btc.oi_change_24h_pct,25);assert.equal(btc.liq_24h_long_usdt,24000);assert.equal(btc.liq_24h_short_usdt,12000);
assert.equal(out.stats.coins_with_oi_change,49,'ETH keeps failing → no value, never filled in');
assert.equal(out.coins.find(c=>c.coin==='ETH').oi_change_24h_pct,undefined);
const old=attachStats(board,JSON.parse(saved.get('market-hub/free-heatmap/v1/stats.json')),NOW+3*3600000);
assert.equal(old.stats.available,false,'stats older than 75 min are dropped');assert.equal(old.coins[0].oi_change_24h_pct,undefined);
assert.equal(attachStats(board,null,NOW).stats.available,false);
// no stats file yet: board still served
saved.delete('market-hub/free-heatmap/v1/stats.json');
const r2=await (await heatmapPublicRoute(new Request('https://x/'),env,NOW)).json();assert.equal(r2.coins.length,50);assert.equal(r2.stats.available,false);
console.log('PASS heatmap stats 20261125: Gate 1h contract_stats → 24h OI change and long/short liquidations, closed hours only, rotating 10/run, fresh-only merge');
