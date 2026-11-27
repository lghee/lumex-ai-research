// Phase 113 주식 선물: universe split by symbolType, radar, US sessions (NYSE 2026–2028), close capture,
// candles route, and the coin top-50 never containing a TradFi contract. Mocked Bybit (QA 예시 prices).
import assert from 'node:assert/strict';
import {usSession,lastClosedSession,regularSessions,etToMs,tradingDay,buildUniverse,buildRadar,closeDue,collectStockHub,
  stockHubRoute,candlesFor,isTradfi,MIN_TURNOVER_USD} from '../src/stock-hub.mjs';
import {normalizeTop50} from '../src/pro-top50.mjs';

// 1) sessions (ET): early close 2026-11-27 13:00, Thanksgiving, weekend, DST, unknown years fail closed
const S=s=>usSession(Date.parse(s)).state;
assert.equal(S('2026-11-26T15:00:00Z'),'closed','Thanksgiving');
assert.equal(S('2026-11-27T14:00:00Z'),'pre');assert.equal(S('2026-11-27T15:00:00Z'),'regular');
assert.equal(S('2026-11-27T18:30:00Z'),'post','early close 13:00 ET');assert.equal(S('2026-11-27T22:30:00Z'),'closed','post ends 17:00 on early close days');
assert.equal(S('2026-11-28T15:00:00Z'),'closed','Saturday');assert.equal(S('2026-11-30T00:30:00Z'),'closed');assert.equal(S('2026-11-30T01:30:00Z'),'overnight','Sunday 20:30 ET');
assert.equal(S('2026-11-30T14:30:00Z'),'regular','09:30 ET');assert.equal(S('2026-11-30T21:00:00Z'),'post');assert.equal(S('2026-12-01T02:00:00Z'),'overnight');
assert.equal(S('2026-07-06T13:30:00Z'),'regular','EDT: 09:30 = 13:30Z');assert.equal(S('2026-07-03T15:00:00Z'),'closed','Independence Day observed');
assert.equal(S('2029-01-03T15:00:00Z'),'unknown','outside the verified calendar');
assert.equal(new Date(etToMs('2026-11-30',570)).toISOString(),'2026-11-30T14:30:00.000Z');
assert.equal(lastClosedSession(Date.parse('2026-11-28T15:00:00Z')),'2026-11-27');assert.equal(lastClosedSession(Date.parse('2026-11-30T15:00:00Z')),'2026-11-27');
assert.equal(lastClosedSession(Date.parse('2026-11-30T21:30:00Z')),'2026-11-30');
const rs=regularSessions(Date.parse('2026-11-25T00:00:00Z'),Date.parse('2026-11-30T23:00:00Z'));
assert.deepEqual(rs.map(([a,b])=>[new Date(a).toISOString(),new Date(b).toISOString()]),[
  ['2026-11-24T14:30:00.000Z','2026-11-24T21:00:00.000Z'],['2026-11-25T14:30:00.000Z','2026-11-25T21:00:00.000Z'],['2026-11-27T14:30:00.000Z','2026-11-27T18:00:00.000Z'],['2026-11-30T14:30:00.000Z','2026-11-30T21:00:00.000Z']]);
assert.equal(tradingDay('2028-01-03'),true);assert.equal(tradingDay('2027-12-24'),false);

// 2) universe: crypto (symbolType '') never enters; only US stock/ETF USDT perpetuals in Trading
const inst=[
  {symbol:'BTCUSDT',symbolType:'',status:'Trading',contractType:'LinearPerpetual',quoteCoin:'USDT',settleCoin:'USDT',baseCoin:'BTC'},
  {symbol:'NVDAUSDT',symbolType:'stock',marketRegion:'US',underlyingTicker:'NVDA',status:'Trading',contractType:'LinearPerpetual',quoteCoin:'USDT',settleCoin:'USDT',baseCoin:'NVDA',priceFilter:{tickSize:'0.01'},lotSizeFilter:{qtyStep:'0.01'},leverageFilter:{maxLeverage:'10'}},
  {symbol:'QQQUSDT',symbolType:'ETF',marketRegion:'US',underlyingTicker:'QQQ',status:'Trading',contractType:'LinearPerpetual',quoteCoin:'USDT',settleCoin:'USDT',baseCoin:'QQQ'},
  {symbol:'XAUTUSDT',symbolType:'commodity',marketRegion:'',status:'Trading',contractType:'LinearPerpetual',quoteCoin:'USDT',settleCoin:'USDT'},
  {symbol:'SAMSUNGUSDT',symbolType:'stock',marketRegion:'KR',underlyingTicker:'005930',status:'Trading',contractType:'LinearPerpetual',quoteCoin:'USDT',settleCoin:'USDT'},
  {symbol:'SPCXUSDT',symbolType:'stock',marketRegion:'US',underlyingTicker:'SPCX',status:'PreLaunch',contractType:'LinearPerpetual',quoteCoin:'USDT',settleCoin:'USDT'}];
const u=buildUniverse(inst,[{symbol:'NVDAUSDT',fullName:'NVIDIA Corporation'},{symbol:'QQQUSDT',fullName:'Invesco QQQ Trust'}],1);
assert.deepEqual(u.tradfi,['NVDAUSDT','QQQUSDT','SAMSUNGUSDT','SPCXUSDT','XAUTUSDT'],'every TradFi type is published for the coin filter');
assert.deepEqual(u.stocks.map(s=>[s.symbol,s.ticker,s.slug,s.type,s.name]),[['NVDAUSDT','NVDA','nvda','주식','NVIDIA Corporation'],['QQQUSDT','QQQ','qqq','ETF','Invesco QQQ Trust']]);
assert.equal(isTradfi({symbolType:''}),false);assert.equal(isTradfi({symbolType:'ETF'}),true);

// 3) coin top-50 drops TradFi contracts
const tick=(symbol,turn,last=100,extra={})=>({symbol,lastPrice:String(last),turnover24h:String(turn),price24hPcnt:'0.01',fundingRate:'0.0001',openInterestValue:'1000',highPrice24h:String(last*1.02),lowPrice24h:String(last*.98),markPrice:String(last),indexPrice:String(last*0.999),...extra});
const body={retCode:0,result:{category:'linear',list:[tick('BTCUSDT',9e9),tick('NVDAUSDT',8e9),tick('ETHUSDT',7e9),tick('QQQUSDT',50000)]}};
const top=normalizeTop50(body,Date.now(),new Set(u.tradfi));assert.deepEqual(top.items.map(x=>x.symbol),['BTCUSDT','ETHUSDT'],'no stock in the coin top-50');
assert.deepEqual(normalizeTop50(body,Date.now()).items.map(x=>x.symbol).slice(0,2),['BTCUSDT','NVDAUSDT'],'without the set the old behaviour stays (filter is the only change)');

// 4) radar: premium only in regular session; since-close outside it; thin contracts listed but not ranked
const tickers=[tick('NVDAUSDT',8e9,180,{indexPrice:'179.1',price24hPcnt:'0.025'}),tick('QQQUSDT',50000,500,{price24hPcnt:'-0.01'}),tick('BTCUSDT',9e9)];
const reg=buildRadar(u,tickers,{state:'regular'},null,5);
const nv=reg.items.find(x=>x.ticker==='NVDA');assert.equal(nv.premium_pct,Number(((180/179.1-1)*100).toFixed(3)));assert.equal(nv.since_close_pct,null);assert.equal(nv.change_24h_pct,2.5);
assert.equal(reg.items.length,2,'BTC never appears');assert.equal(reg.items.find(x=>x.ticker==='QQQ').ranked,false,'below '+MIN_TURNOVER_USD+' USD');
assert.deepEqual(reg.breadth,{up:1,down:0,flat:0,total:1});
const post=buildRadar(u,tickers,{state:'post'},{date:'2026-11-27',captured_ms:1,prices:{NVDAUSDT:{last:176,index:176.2}}},6);
assert.equal(post.items.find(x=>x.ticker==='NVDA').premium_pct,null);assert.equal(post.items.find(x=>x.ticker==='NVDA').since_close_pct,Number(((180/176-1)*100).toFixed(3)));
assert.equal(post.items.find(x=>x.ticker==='QQQ').since_close_pct,null,'no stored close → null, never a guess');

// 5) close capture window: first 30 minutes after the close, once
assert.equal(closeDue(Date.parse('2026-11-30T21:03:00Z'),null),'2026-11-30');assert.equal(closeDue(Date.parse('2026-11-30T21:03:00Z'),'2026-11-30'),null);
assert.equal(closeDue(Date.parse('2026-11-30T21:40:00Z'),null),null,'late → skipped, not mislabelled as the close');
assert.equal(closeDue(Date.parse('2026-11-27T18:05:00Z'),'2026-11-25'),'2026-11-27','early close day 13:00');
assert.equal(closeDue(Date.parse('2026-11-28T21:05:00Z'),null),null,'Saturday');

// 6) collector + routes with mocked Bybit and R2
const store=new Map();const bucket={get:async k=>store.has(k)?{json:async()=>JSON.parse(store.get(k))}:null,put:async(k,v)=>{store.set(k,String(v));}};
const calls=[];
const fx=async(url)=>{calls.push(url);const U=new URL(url);const ok=b=>({ok:true,status:200,text:async()=>JSON.stringify(b)});
  if(U.pathname==='/v5/market/instruments-info')return ok({retCode:0,result:{list:inst,nextPageCursor:''}});
  if(U.pathname==='/v5/market/instrument-summary')return ok({retCode:0,result:{list:[{symbol:'NVDAUSDT',fullName:'NVIDIA Corporation'}],nextPageCursor:''}});
  if(U.pathname==='/v5/market/tickers')return ok({retCode:0,result:{list:tickers}});
  if(U.pathname==='/v5/market/kline'){const end=Date.parse('2026-11-30T21:00:00Z'),list=[];for(let i=0;i<60;i++){const t=end-i*3600000,c=170+i*0.1;list.push([String(t),String(c),String(c+1),String(c-1),String(c+0.2),'1000','0']);}return ok({retCode:0,result:{list}});}
  return {ok:false,status:404,text:async()=>''};};
const env={MARKET_DATA:bucket};
let r=await collectStockHub(env,{now:Date.parse('2026-11-30T21:04:00Z'),fetchImpl:fx});
assert.deepEqual([r.ok,r.count,r.close_captured],[true,2,true]);
const latest=JSON.parse(store.get('stock-hub/v1/close-latest.json'));assert.equal(latest.date,'2026-11-30');assert.equal(latest.prices.NVDAUSDT.last,180);
r=await collectStockHub(env,{now:Date.parse('2026-11-30T21:09:00Z'),fetchImpl:fx});assert.equal(r.close_captured,false,'captured once');
assert.equal(calls.filter(c=>c.includes('instruments-info')).length,1,'universe refreshed hourly, not every 5 minutes');
const radar=JSON.parse(store.get('stock-hub/v1/radar.json'));assert.equal(radar.session.state,'post');assert.equal(radar.close_ref.date,'2026-11-30');assert.equal(radar.items.find(x=>x.ticker==='NVDA').since_close_pct,0);
const get=async(path,now=Date.parse('2026-11-30T21:10:00Z'))=>{const res=await stockHubRoute(new Request('https://w.dev/stock-hub/v1/'+path),env,{fetchImpl:fx,now});return [res.status,await res.json(),res.headers];};
let [st,j,h]=await get('radar');assert.equal(st,200);assert.equal(j.items.length,2);assert.equal(h.get('access-control-allow-origin'),'*');
[st,j]=await get('tradfi-symbols');assert.equal(st,200);assert.ok(j.symbols.includes('NVDAUSDT')&&!j.symbols.includes('BTCUSDT'));
[st,j]=await get('universe');assert.equal(j.count,2);
[st,j]=await get('session');assert.equal(j.session.state,'post');
[st,j]=await get('candles?symbol=BTCUSDT&interval=60');assert.equal(st,404,'coin symbols are not served by the stock chart');
[st,j]=await get('candles?symbol=NVDAUSDT&interval=7');assert.equal(st,400);
const c=await candlesFor(env,'NVDAUSDT','60',{fetchImpl:fx,now:Date.parse('2026-11-30T22:30:00Z')});
assert.equal(c.status,200);assert.equal(c.body.bars.length,60);assert.ok(c.body.bars.every((b,i,a)=>!i||b.t>a[i-1].t),'ascending');
assert.equal(c.body.bars.at(-1).closed,true);assert.deepEqual(c.body.regular_sessions,[[Date.parse('2026-11-30T14:30:00Z'),Date.parse('2026-11-30T21:00:00Z')]],'60 hourly bars from Saturday: one regular session (Mon)');
[st,j]=await get('nope');assert.equal(st,404);
console.log('stock hub 20261127: all checks passed');
