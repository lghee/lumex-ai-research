// Stock chart candles (2026-11-27 fix): Bybit refuses visitor requests from some Cloudflare locations, so candles come
// from R2 kept by the 5-minute collector. QA 예시 prices only.
import assert from 'node:assert/strict';
import {collectCandles,candlesFor,fetchKline,stockHubRoute} from '../src/stock-hub.mjs';
const store=new Map();const bucket={get:async k=>store.has(k)?{json:async()=>JSON.parse(store.get(k))}:null,put:async(k,v)=>{store.set(k,String(v));}};
store.set('stock-hub/v1/universe.json',JSON.stringify({ok:true,stocks:[{symbol:'NVDAUSDT',ticker:'NVDA',name:'NVIDIA'},{symbol:'TSLAUSDT',ticker:'TSLA',name:'Tesla'}]}));
const env={MARKET_DATA:bucket};
const T0=Date.parse('2026-11-30T15:02:00Z');
const kl=(end,frame=3600000)=>{const list=[];for(let i=0;i<80;i++){const t=end-i*frame,c=170+i*0.1;list.push([String(t),String(c),String(c+1),String(c-1),String(c+0.2),'1000','0']);}return list;};
let mode='blocked';const calls=[];
const fx=async url=>{calls.push(url);const U=new URL(url);
  const ok=b=>({ok:true,status:200,text:async()=>JSON.stringify(b)});
  if(mode==='blocked')return {ok:false,status:403,text:async()=>'<html>403 ERROR</html>'};
  if(mode==='alt'&&U.host==='api.bybit.com')return {ok:false,status:403,text:async()=>''};
  const frame={'5':300000,'15':900000,'60':3600000,'240':14400000,'D':86400000}[U.searchParams.get('interval')];
  return ok({retCode:0,result:{list:kl(Math.floor(T0/frame)*frame,frame)}});};
const W=k=>JSON.parse(store.get('stock-hub/v1/'+k)||'null');

// 1) blocked + nothing stored → 503 warming (no made-up bars), request queued for the collector
let c=await candlesFor(env,'NVDAUSDT','60',{fetchImpl:fx,now:T0});
assert.equal(c.status,503);assert.equal(c.body.error,'warming');assert.equal(c.body.source_error,'http_403');
assert.equal(calls.filter(u=>u.includes('api.bybit.com')).length,1);assert.equal(calls.filter(u=>u.includes('api.bytick.com')).length,1,'second official host tried');
assert.ok(W('candles/wanted.json')['NVDAUSDT|60']);
// 2) collector (where Bybit answers) stores wanted + top traded
mode='ok';
const radar={items:[{symbol:'TSLAUSDT',ranked:true},{symbol:'NVDAUSDT',ranked:true},{symbol:'QQQUSDT',ranked:false}]};
let r=await collectCandles(env,radar,{fetchImpl:fx,now:T0+60000});
assert.equal(r.stored,2,'NVDA|60 (wanted) + TSLA|60 (top); NVDA|60 not fetched twice');assert.ok(W('candles/TSLAUSDT/60.json'));assert.ok(!W('candles/QQQUSDT/60.json'),'unranked not collected');
// 3) visitor while Bybit is blocked → stored copy with its own time
mode='blocked';calls.length=0;
c=await candlesFor(env,'NVDAUSDT','60',{fetchImpl:fx,now:T0+120000});
assert.equal(c.status,200);assert.equal(c.body.origin,'store');assert.equal(c.body.as_of_ms,T0+60000);assert.equal(calls.length,0,'fresh copy → Bybit not asked');
assert.equal(c.body.bars.length,80);assert.equal(c.body.bars.at(-1).closed,false,'bar still open at collection time');
c=await candlesFor(env,'NVDAUSDT','60',{fetchImpl:fx,now:T0+60000+20*60000});
assert.equal(c.body.origin,'store');assert.equal(calls.length,2,'not fresh → live tried first, then stored copy');
c=await candlesFor(env,'NVDAUSDT','60',{fetchImpl:fx,now:T0+60000+4*3600000});
assert.equal(c.status,503,'older than 3h for 1h bars → not shown');
// 4) live through the second host; stored for the next visitor
mode='alt';c=await candlesFor(env,'TSLAUSDT','15',{fetchImpl:fx,now:T0});
assert.equal(c.status,200);assert.equal(c.body.origin,'live');assert.equal(W('candles/TSLAUSDT/15.json').host,'api.bytick.com');
// 5) parsing keeps only valid ascending unique bars
const k=await fetchKline(async()=>({ok:true,status:200,text:async()=>JSON.stringify({retCode:0,result:{list:[['3600000','1','2','0.5','1.5','1'],['0','1','2','0.5','1.5','1'],['0','1','2','0.5','1.5','1'],['7200000','1','0.5','0.4','1','1']]}})}),'NVDAUSDT','60',T0);
assert.deepEqual(k.bars.map(b=>b.t),[0,3600000],'high below open dropped, duplicate dropped');
// 6) wanted entries expire after 2 hours
mode='ok';r=await collectCandles(env,{items:[]},{fetchImpl:fx,now:T0+7*3600000});assert.equal(r.tasks,0);assert.deepEqual(W('candles/wanted.json'),{});
// 7) status route
store.set('stock-hub/v1/status.json',JSON.stringify({updated_ms:T0,candles:{stored:2}}));
const res=await stockHubRoute(new Request('https://w.dev/stock-hub/v1/status'),env,{now:T0});assert.equal((await res.json()).candles.stored,2);
console.log('stock candles 20261127: all checks passed');
