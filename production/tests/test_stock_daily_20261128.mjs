// 주식 데일리 기록 (2026-11-28): built once per US trading day from stored closes, the gap record and the whale day
// summary; never built without the previous close. QA 예시 prices only.
import assert from 'node:assert/strict';
import {composeDaily,maybeBuildDaily,addWhaleDay,dailyIndex,isDate} from '../src/stock-daily.mjs';
import {stockHubRoute} from '../src/stock-hub.mjs';
const store=new Map();const bucket={get:async k=>store.has(k)?{json:async()=>JSON.parse(store.get(k))}:null,put:async(k,v)=>{store.set(k,String(v));}};
const put=(k,v)=>store.set('stock-hub/v1/'+k,JSON.stringify(v));const get=k=>JSON.parse(store.get('stock-hub/v1/'+k)||'null');
const universe={ok:true,stocks:[['NVDAUSDT','NVDA','NVIDIA','주식'],['TSLAUSDT','TSLA','Tesla','주식'],['QQQUSDT','QQQ','Invesco QQQ','ETF'],['THINUSDT','THIN','Thin Co','주식'],['NEWUSDT','NEW','New Co','주식']]
  .map(([symbol,ticker,name,type])=>({symbol,ticker,slug:ticker.toLowerCase(),name,type}))};
const NOW=Date.parse('2026-11-30T21:05:00Z');
const prev={date:'2026-11-27',captured_ms:Date.parse('2026-11-27T18:05:00Z'),prices:{NVDAUSDT:{last:180,index:180},TSLAUSDT:{last:400},QQQUSDT:{last:500},THINUSDT:{last:10}}};
const close={date:'2026-11-30',captured_ms:NOW,prices:{NVDAUSDT:{last:171,index:171,turnover:9e8,funding_pct:0.01,oi:3e8},TSLAUSDT:{last:412,turnover:5e8,funding_pct:-0.002,oi:2e8},
  QQQUSDT:{last:500,turnover:2e8},THINUSDT:{last:13,turnover:5e4},NEWUSDT:{last:20,turnover:3e6},BTCUSDT:{last:90000,turnover:9e9}}};
// pure composition
let d=composeDaily({date:'2026-11-30',close,prevClose:prev,gapRec:null,whaleDay:null,universe,now:NOW});
assert.deepEqual(d.rows.map(r=>r.ticker),['NVDA','TSLA','QQQ'],'turnover order, under $100k left out, no previous close left out, coin symbol never listed');
assert.equal(d.rows[0].day_pct,-5);assert.equal(d.rows[1].day_pct,3);assert.equal(d.rows[2].day_pct,0);
assert.deepEqual(d.breadth,{total:4,up:2,down:1,flat:1},'breadth counts every stock with both closes (THIN +30% included)');
assert.deepEqual(d.movers.up.map(r=>r.ticker),['TSLA']);assert.deepEqual(d.movers.down.map(r=>r.ticker),['NVDA'],'movers from liquid rows only (THIN excluded)');
assert.equal(d.gap,null);assert.equal(d.whales,null);assert.equal(d.turnover_known,true);
// older close without turnover: every stock counts, alphabetical
const oldClose={date:'2026-11-30',captured_ms:NOW,prices:{NVDAUSDT:{last:171},THINUSDT:{last:13}}};
d=composeDaily({date:'2026-11-30',close:oldClose,prevClose:prev,universe,now:NOW});
assert.equal(d.turnover_known,false);assert.deepEqual(d.rows.map(r=>r.ticker),['NVDA','THIN']);assert.equal(d.rows[0].turnover_24h_usd,null);
// gap record + whale day
const gapRec={date:'2026-11-30',prev_date:'2026-11-27',pre_ms:1,open_ms:2,h1_ms:3,close_ms:NOW,items:{
  NVDAUSDT:{ticker:'NVDA',slug:'nvda',name:'NVIDIA',type:'주식',prev_close:180,pre:174.6,open:173,h1:172,close:171},
  TSLAUSDT:{ticker:'TSLA',slug:'tsla',name:'Tesla',type:'주식',prev_close:400,pre:410,open:398,h1:null,close:412},
  QQQUSDT:{ticker:'QQQ',slug:'qqq',name:'QQQ',type:'ETF',prev_close:500,pre:501,open:null,h1:null,close:500}}};
let wd=addWhaleDay(null,'2026-11-30',[{kind:'new',ticker:'NVDA',slug:'nvda',side:'short',value_usd:3e7,address:'0x4692aaaa164f',detected_ms:NOW-3600000},
  {kind:'close',ticker:'MU',slug:'mu',side:'long',value_usd:9e6,address:'0x1',detected_ms:NOW-60000}]);
wd=addWhaleDay(wd,'2026-11-30',[{kind:'add',ticker:'TSLA',slug:'tsla',side:'long',value_usd:2e6,address:'0xabcdef0123',detected_ms:NOW-1000}]);
assert.equal(wd.count,3);assert.deepEqual(wd.kinds,{new:1,close:1,add:1});assert.deepEqual(wd.top.map(x=>x.ticker),['NVDA','TSLA'],'top keeps new/add/flip only, largest first');
assert.equal(wd.top[0].address_short,'0x4692…164f');
assert.equal(addWhaleDay(wd,'2026-12-01',[]).count,0,'a new ET day starts from zero');
d=composeDaily({date:'2026-11-30',close,prevClose:prev,gapRec,whaleDay:wd,universe,now:NOW});
assert.equal(d.gap.count,3);assert.equal(d.gap.rows[0].ticker,'NVDA');assert.equal(d.gap.big,2,'gaps of 1% or more: NVDA −3%, TSLA +2.5%');
assert.equal(d.gap.open_known,2);assert.equal(d.gap.open_same,1,'NVDA kept its direction at open, TSLA did not');assert.equal(d.gap.close_same,2);
assert.equal(d.whales.count,3);assert.equal(d.whales.top.length,2);
assert.equal(composeDaily({date:'2026-11-30',close,prevClose:prev,whaleDay:{...wd,date:'2026-11-27'},universe,now:NOW}).whales,null,'whale summary of another day is not used');
// build once, only with the previous close
put('universe.json',universe);
let r=await maybeBuildDaily(bucket,{close,universe,now:NOW});assert.deepEqual(r,{built:false,reason:'no_prev_close_2026-11-27'},'no previous close → not built');
put('closes/2026-11-27.json',prev);put('gaps/2026-11-30.json',gapRec);put('whales/day/2026-11-30.json',wd);
r=await maybeBuildDaily(bucket,{close,universe,now:NOW});assert.deepEqual(r,{built:true,date:'2026-11-30'});
assert.equal(get('daily/2026-11-30.json').gap.big,2);assert.deepEqual(get('daily/index.json').dates,['2026-11-30']);
r=await maybeBuildDaily(bucket,{close,universe,now:NOW+300000});assert.equal(r.built,false,'built once');
assert.equal((await maybeBuildDaily(bucket,{close:{...close,date:'2026-11-26'},universe,now:NOW})).reason,'no_prev_close_2026-11-25','Thanksgiving: previous trading day is Wednesday');
// routes
let res=await stockHubRoute(new Request('https://w.dev/stock-hub/v1/daily?date=2026-11-30'),{MARKET_DATA:bucket},{now:NOW});
assert.equal(res.status,200);assert.equal((await res.json()).rows[0].ticker,'NVDA');assert.equal(res.headers.get('access-control-allow-origin'),'*');
res=await stockHubRoute(new Request('https://w.dev/stock-hub/v1/daily?date=2026-12-01'),{MARKET_DATA:bucket},{now:NOW});assert.equal(res.status,404);
res=await stockHubRoute(new Request('https://w.dev/stock-hub/v1/daily?date=../x'),{MARKET_DATA:bucket},{now:NOW});assert.equal(res.status,404);
const ix=await dailyIndex({MARKET_DATA:bucket});assert.deepEqual(ix.dates,['2026-11-30']);assert.equal(ix.days[0].top_up.ticker,'TSLA');assert.deepEqual(ix.days[0].lead.map(x=>x.ticker),['NVDA','TSLA','QQQ']);
assert.ok(isDate('2026-11-30')&&!isDate('2026-11-3')&&!isDate(null));
console.log('stock daily 20261128: all checks passed');
