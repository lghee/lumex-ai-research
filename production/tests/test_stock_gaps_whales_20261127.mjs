// Phase 116: 장외 갭 기록 + 주식 고래 (Hyperliquid xyz). QA 예시 prices and addresses only.
import assert from 'node:assert/strict';
import {gapPhase,prevTradingDay,recordGaps,summarizeDay,gapStats,liveBoard} from '../src/stock-gaps.mjs';
import {buildMarkets,stockPositions,diffEntries,collectStockWhales,whalesPayload,tickerOf} from '../src/stock-whales.mjs';
import {stockHubRoute} from '../src/stock-hub.mjs';
const store=new Map();const bucket={get:async k=>store.has(k)?{json:async()=>JSON.parse(store.get(k))}:null,put:async(k,v)=>{store.set(k,String(v));}};
const env={MARKET_DATA:bucket};const R=k=>JSON.parse(store.get(k)||'null');
const Z=s=>Date.parse(s);
// ── gaps: windows (ET = UTC-5 in late November)
assert.deepEqual(gapPhase(Z('2026-11-30T14:25:00Z')),{date:'2026-11-30',kind:'pre'});
assert.deepEqual(gapPhase(Z('2026-11-30T14:31:00Z')),{date:'2026-11-30',kind:'open'});
assert.deepEqual(gapPhase(Z('2026-11-30T15:35:00Z')),{date:'2026-11-30',kind:'h1'});
assert.equal(gapPhase(Z('2026-11-30T16:00:00Z')),null);assert.equal(gapPhase(Z('2026-11-28T14:25:00Z')),null,'Saturday');
assert.equal(gapPhase(Z('2026-11-26T14:25:00Z')),null,'Thanksgiving');
assert.equal(prevTradingDay('2026-11-30'),'2026-11-27');assert.equal(prevTradingDay('2026-11-27'),'2026-11-25');
const universe={ok:true,stocks:[{symbol:'NVDAUSDT',ticker:'NVDA',slug:'nvda',name:'NVIDIA',type:'주식'},{symbol:'TSLAUSDT',ticker:'TSLA',slug:'tsla',name:'Tesla',type:'주식'},{symbol:'QQQUSDT',ticker:'QQQ',slug:'qqq',name:'Invesco QQQ',type:'ETF'},{symbol:'BRKBUSDT',ticker:'BRK.B',slug:'brk-b',name:'Berkshire',type:'주식'}]};
const radar={items:[{symbol:'NVDAUSDT',ranked:true},{symbol:'TSLAUSDT',ranked:true},{symbol:'QQQUSDT',ranked:false}]};
const tk=(n,t,q)=>[{symbol:'NVDAUSDT',lastPrice:String(n)},{symbol:'TSLAUSDT',lastPrice:String(t)},{symbol:'QQQUSDT',lastPrice:String(q)}];
let r=await recordGaps(bucket,{universe,tickers:tk(110,95,500),radar,now:Z('2026-11-30T14:25:00Z')});
assert.equal(r.reason,'no_close_2026-11-27','no stored close → no record');assert.equal(store.has('stock-hub/v1/gaps/2026-11-30.json'),false);
store.set('stock-hub/v1/closes/2026-11-27.json',JSON.stringify({date:'2026-11-27',captured_ms:Z('2026-11-27T18:05:00Z'),prices:{NVDAUSDT:{last:100},TSLAUSDT:{last:100},QQQUSDT:{last:500}}}));
r=await recordGaps(bucket,{universe,tickers:tk(110,95,505),radar,now:Z('2026-11-30T14:25:00Z')});assert.equal(r.written,true);
let rec=R('stock-hub/v1/gaps/2026-11-30.json');assert.deepEqual(Object.keys(rec.items).sort(),['NVDAUSDT','TSLAUSDT'],'unranked QQQ not recorded');
r=await recordGaps(bucket,{universe,tickers:tk(999,999,999),radar,now:Z('2026-11-30T14:29:00Z')});assert.equal(r.written,false,'pre captured once');
await recordGaps(bucket,{universe,tickers:tk(108,96,500),radar,now:Z('2026-11-30T14:32:00Z')});
await recordGaps(bucket,{universe,tickers:tk(104,97,500),radar,now:Z('2026-11-30T15:31:00Z')});
await recordGaps(bucket,{universe,tickers:tk(1,1,1),radar,now:Z('2026-11-30T19:00:00Z'),closeStored:{date:'2026-11-30',captured_ms:Z('2026-11-30T21:03:00Z'),prices:{NVDAUSDT:{last:99},TSLAUSDT:{last:94}}}});
rec=R('stock-hub/v1/gaps/2026-11-30.json');assert.ok(rec.open_ms&&rec.h1_ms&&rec.close_ms);
const day=summarizeDay(rec);
assert.deepEqual(day.rows.map(x=>[x.ticker,x.gap_pct,x.open_pct,x.h1_pct,x.close_pct,x.open_same,x.close_same]),
  [['NVDA',10,8,4,-1,true,false],['TSLA',-5,-4,-3,-6,true,true]]);
assert.deepEqual(gapStats([day]),{days:1,gaps:2,open_known:2,open_same:2,close_known:2,close_same:1,min_gap_pct:1});
assert.deepEqual(R('stock-hub/v1/gaps/index.json').dates,['2026-11-30']);
const lb=liveBoard({session:{state:'post'},items:[{symbol:'A',ticker:'A',ranked:true,since_close_pct:-0.5},{symbol:'B',ticker:'B',ranked:true,since_close_pct:2},{symbol:'C',ticker:'C',ranked:false,since_close_pct:9},{symbol:'D',ticker:'D',ranked:true,since_close_pct:null}]});
assert.deepEqual(lb.items.map(x=>x.ticker),['B','A'],'biggest move first, unranked and in-session rows left out');
store.set('stock-hub/v1/radar.json',JSON.stringify({ok:true,session:{state:'post'},items:[]}));
let res=await stockHubRoute(new Request('https://w.dev/stock-hub/v1/gaps'),env,{now:Z('2026-11-30T22:00:00Z')});let j=await res.json();
assert.equal(res.status,200);assert.equal(j.days.length,1);assert.equal(j.recorded_days,1);assert.equal(res.headers.get('access-control-allow-origin'),'*');

// ── whales
store.set('stock-hub/v1/universe.json',JSON.stringify(universe));
const meta=[{universe:[{name:'xyz:NVDA',maxLeverage:10},{name:'xyz:GOLD',maxLeverage:25},{name:'xyz:TSLA',maxLeverage:20},{name:'xyz:BRK.B',maxLeverage:10},{name:'xyz:SMSN',maxLeverage:10}]},
  [{markPx:'150',openInterest:'1000',dayNtlVlm:'9000000',prevDayPx:'148',funding:'0.00001',oraclePx:'150.1'},{markPx:'3600',openInterest:'10',dayNtlVlm:'99000000'},{markPx:'400',openInterest:'500',dayNtlVlm:'5000000',prevDayPx:'400'},{markPx:'480',openInterest:'1',dayNtlVlm:'1000'},{markPx:'130',openInterest:'1',dayNtlVlm:'8000000'}]];
assert.equal(tickerOf('xyz:NVDA'),'NVDA');assert.equal(tickerOf('NVDA'),null);
const mk=buildMarkets(meta,universe);assert.deepEqual(mk.map(m=>m.ticker),['NVDA','TSLA','BRK.B'],'commodities and non-universe shares left out, by volume');
assert.equal(mk[0].oi_usd,150000);
const A='0x'+'a'.repeat(40),B='0x'+'b'.repeat(40);
const pos=(coin,szi,entry,value)=>({position:{coin,szi:String(szi),entryPx:String(entry),positionValue:String(value),unrealizedPnl:'10',leverage:{value:3},liquidationPx:null}});
assert.deepEqual(stockPositions({assetPositions:[pos('xyz:NVDA',1000,140,150000),pos('xyz:GOLD',5,3500,18000)]},mk).map(p=>[p.ticker,p.side]),[['NVDA','long']]);
assert.throws(()=>stockPositions({},mk));
const before=[{coin:'xyz:NVDA',side:'long',size:1000,value_usd:150000,entry_price:140}];
assert.equal(diffEntries(A,before,[{coin:'xyz:NVDA',ticker:'NVDA',side:'long',size:1100,value_usd:165000,entry_price:140}],mk,1).length,0,'+10% is not a new entry');
assert.equal(diffEntries(A,before,[{coin:'xyz:NVDA',ticker:'NVDA',side:'long',size:2000,value_usd:300000,entry_price:145}],mk,1)[0].kind,'add');
assert.equal(diffEntries(A,before,[{coin:'xyz:NVDA',ticker:'NVDA',side:'short',size:1000,value_usd:150000,entry_price:150}],mk,1)[0].kind,'flip');
assert.equal(diffEntries(A,[],[{coin:'xyz:TSLA',ticker:'TSLA',side:'short',size:100,value_usd:40000,entry_price:400}],mk,1).length,0,'below 100k');
// collector with mocked Hyperliquid
let positionsA=[pos('xyz:NVDA',1000,140,150000)],calls=[];
const fx=async(url,opt)=>{const b=JSON.parse(opt.body);calls.push(b.type);const ok=x=>({ok:true,status:200,text:async()=>JSON.stringify(x)});
  if(b.type==='metaAndAssetCtxs')return ok(meta);
  if(b.type==='recentTrades')return ok(b.coin==='xyz:NVDA'?[{px:'150',sz:'100',users:[A,B]},{px:'150',sz:'1',users:['0x'+'c'.repeat(40),B]}]:[]);
  if(b.type==='clearinghouseState'){assert.equal(b.dex,'xyz');return ok({assetPositions:b.user===A?positionsA:[]});}
  if(b.type==='candleSnapshot')return ok([{t:b.req.startTime,o:'165'}]);
  return {ok:false,status:400,text:async()=>''};};
const T=Z('2026-11-30T15:00:00Z');
r=await collectStockWhales(env,{now:T,fetchImpl:fx});
assert.equal(r.ok,true);assert.equal(r.candidates,2,'only addresses from trades of 10k+');assert.equal(r.checked,2);assert.equal(r.new_entries,0,'first check is a baseline, not an entry');
positionsA=[pos('xyz:NVDA',1000,140,150000),pos('xyz:TSLA',-500,400,200000)];
r=await collectStockWhales(env,{now:T+300000,fetchImpl:fx});assert.equal(r.new_entries,1);
let st=R('stock-hub/v1/whales/state.json');assert.deepEqual([st.events[0].ticker,st.events[0].side,st.events[0].detected_price],['TSLA','short',400]);
r=await collectStockWhales(env,{now:T+300000+3600000,fetchImpl:fx});
st=R('stock-hub/v1/whales/state.json');assert.equal(st.events[0].r1h,58.75,'short, price 400→165: result shown from the position side');assert.equal(st.events[0].r4h,null,'4h not due yet');
res=await stockHubRoute(new Request('https://w.dev/stock-hub/v1/whales'),env,{now:T+3900000});j=await res.json();
assert.equal(res.status,200);assert.deepEqual(j.positions.map(p=>[p.ticker,p.side,p.address_short]),[['TSLA','short','0xaaaa…aaaa'],['NVDA','long','0xaaaa…aaaa']]);
assert.equal(j.markets.find(m=>m.ticker==='TSLA').whale_short_usd,200000);assert.equal(j.events.length,1);
// big result: a 24h check later than 6h with no candle → shown as —, not retried forever
const fx2=async(u,o)=>{const b=JSON.parse(o.body);if(b.type==='candleSnapshot')return {ok:true,status:200,text:async()=>'[]'};return fx(u,o);};
await collectStockWhales(env,{now:T+300000+31*3600000,fetchImpl:fx2});st=R('stock-hub/v1/whales/state.json');
assert.equal(st.events[0].r24h,false);j=await whalesPayload(env,{now:T});assert.equal(j.events[0].r24h,null);
// empty store → 503
const e2={MARKET_DATA:{get:async()=>null,put:async()=>{}}};res=await stockHubRoute(new Request('https://w.dev/stock-hub/v1/whales'),e2,{now:T});assert.equal(res.status,503);
console.log('stock gaps + whales 20261127: all checks passed');
