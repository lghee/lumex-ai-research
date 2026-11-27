// Phase 107: 코인 속보 (free sources, rule-based LUMEX 감지) + 아침 리포트 데이터 묶음.
import assert from 'node:assert/strict';
import {detectMove,detectFunding,detectOi,detectLiq,detectWhale,detectSignal,parseRss,xmlText,coinsIn,SOURCES,srcFilter,fromOfficial,mergeFeed,listView,publicItem,
  newsRoute,collectNews,fmtKrwUnit,fmtPrice,kstDay,ROOT,DEFAULTS} from '../src/news-feed.mjs';
import {coinFacts,newsForReport,morningReportTick,buildBundle} from '../src/news-report.mjs';

const H=3600000,now=Date.UTC(2026,10,26,13,7);
const bar=(t,o,c,h=Math.max(o,c),l=Math.min(o,c))=>({t,o,h,l,c,v:1});

// formatting
assert.equal(fmtKrwUnit(15200000),'1,520만');assert.equal(fmtKrwUnit(1240000000),'12.4억');assert.equal(fmtKrwUnit(32e9),'320억');
assert.equal(fmtPrice(58342.4),'58,342');assert.equal(fmtPrice(2950.55),'2,950.6');assert.equal(fmtPrice(0.51234),'0.5123');
assert.equal(kstDay(Date.UTC(2026,10,26,15,30)),'2026-11-27','KST day');

// price move (rolling 1h on 15m)
const b15=[0,1,2,3,4].map(i=>bar(now-5*900000+i*900000,100,100));b15[4]=bar(b15[4].t,100,103.5);
let x=detectMove('BTC',b15);assert.ok(x&&x.importance===2&&x.title==='BTC 1시간 +3.5% 상승'&&x.summary.includes('3.5% 올라'),'btc +3.5%');
assert.equal(detectMove('SOL',b15),null,'alt needs 5%');
b15[4]=bar(b15[4].t,100,93);x=detectMove('ETH',b15);assert.ok(x.importance===3&&x.title.includes('-7.0% 하락'),'big drop');
assert.equal(detectMove('BTC',b15.slice(0,3)),null);

// funding
assert.equal(detectFunding('BTC',{fundingRate:'0.0001'},now),null);
x=detectFunding('BTC',{fundingRate:'0.0006'},now);assert.ok(x.title==='BTC 펀딩비 0.060%로 높아짐'&&x.importance===2);
x=detectFunding('ETH',{fundingRate:'-0.0007'},now);assert.ok(x.importance===3&&x.summary.includes('숏 포지션이 롱에게'));

// OI
const oi=Array.from({length:13},(_,i)=>({t:now-(12-i)*300000,oi:1000}));oi[12]={t:now,oi:1062};
x=detectOi('BTC',oi,60000,now);assert.ok(x&&x.title==='BTC 미결제약정 1시간 +6.2%'&&x.summary.includes('6,372만 달러'),x?.summary);
oi[12].oi=1020;assert.equal(detectOi('BTC',oi,60000,now),null);

// liquidations (Gate 1h)
const liq=Array.from({length:24},(_,i)=>({t:now-(25-i)*H,long:300000,short:200000}));liq.push({t:now-2*H,long:3400000,short:600000});
x=detectLiq('BTC',liq);assert.ok(x&&x.title==='BTC 1시간 청산 400만 달러 (롱 85%)'&&x.importance===3&&x.summary.includes('8.0배'),x?.title);
liq[24]={t:now-2*H,long:900000,short:300000};assert.equal(detectLiq('BTC',liq),null,'below min / multiple');

// whale
const row={address:'0x1234567890abcdef1234567890abcdef12345678',profile:{last_fill:{id:'9',coin:'BTC',ts:now-60000,price:63210,value_usd:15200000,direction:'Open Long',side:'buy'}}};
x=detectWhale(row,now);assert.ok(x&&x.title==='하이퍼리퀴드 고래 BTC 롱 진입 1,520만 달러'&&x.summary.includes('0x1234…5678')&&x.importance===2);
assert.equal(detectWhale({...row,profile:{last_fill:{...row.profile.last_fill,ts:now-3*H}}},now),null,'old fill');
assert.equal(detectWhale({...row,profile:{last_fill:{...row.profile.last_fill,value_usd:1e6}}},now),null,'small');

// LUMEX 4H signal: EMA20 crosses EMA50 up with RSI>50 on the last bar
const h4=[];let p=100;for(let i=0;i<150;i++){p*=i<140?0.997:1.02;h4.push(bar(now-(150-i)*4*H,p/1.001,p,p*1.003,p*0.997));}
let sig=null;for(let n=120;n<=150&&!sig;n++)sig=detectSignal('BTC',h4.slice(0,n));
assert.ok(sig&&sig.title==='LUMEX 4시간 신호 · BTC 롱'&&sig.tags[0]==='signal','4h long signal on some cut');

// RSS articles (Phase 108: exchange notices dropped)
const BM=SOURCES.find(x=>x.key==='blockmedia'),CD=SOURCES.find(x=>x.key==='coindesk');
const rssXml=`<?xml version="1.0"?><rss><channel><title>x</title>
<item><title><![CDATA[비트코인, 9만 달러 회복…ETF 순유입 &amp; 거래량 증가]]></title><link>https://www.blockmedia.co.kr/archives/1200001</link><dc:creator><![CDATA[홍길동 기자]]></dc:creator><pubDate>${new Date(now-H).toUTCString()}</pubDate><description><![CDATA[<p>본문 일부</p>]]></description></item>
<item><title>Phishing</title><link>https://evil.example.com/a</link><pubDate>${new Date(now-H).toUTCString()}</pubDate></item>
<item><title>Old story</title><link>https://www.blockmedia.co.kr/archives/1</link><pubDate>${new Date(now-72*H).toUTCString()}</pubDate></item>
<item><title>No link</title><guid isPermaLink="false">abc</guid><pubDate>${new Date(now-H).toUTCString()}</pubDate></item>
</channel></rss>`;
const arts=parseRss(rssXml,BM,now);
assert.equal(arts.length,1,'foreign host / old / no link dropped');
assert.equal(arts[0].title,'비트코인, 9만 달러 회복…ETF 순유입 & 거래량 증가');assert.deepEqual(arts[0].coins,['BTC']);
assert.ok(arts[0].kind==='news'&&arts[0].src==='blockmedia'&&arts[0].lang==='ko'&&arts[0].summary===''&&arts[0].data.author==='홍길동 기자','title + link + byline only, no body');
const cdXml=`<rss><channel><item><title>Ether Slides 5% as &#8220;Solana&#8221; ETF Odds Rise</title><link>https://www.coindesk.com/markets/2026/11/26/x/?utm=1#frag</link><pubDate>${new Date(now-2*H).toUTCString()}</pubDate></item></channel></rss>`;
const cda=parseRss(cdXml,CD,now);assert.deepEqual(cda[0].coins,['ETH','SOL']);assert.equal(cda[0].lang,'en');assert.ok(!cda[0].url.includes('#'));
assert.equal(xmlText('A &amp;&#x27;B&#39; <b>c</b>'),"A &'B' c");assert.deepEqual(coinsIn('XRP 리플 소송'),['XRP']);
assert.deepEqual(parseRss(null,BM,now),[]);
// official
const off=fromOfficial({ok:true,items:[{published_ms:now-H,source_url:'https://www.federalreserve.gov/x',title_original:'FOMC statement',agency:'미국 연방준비제도',kind:'monetary_policy',description_ko:'연준의 공식 통화정책 발표입니다.'}]},now);
assert.ok(off.length===1&&off[0].importance===3&&off[0].kind==='macro');

// merge: ids, dedupe, ref price, after_1h
const exOld={key:'bybit:https://announcements.bybit.com/x',t:now-H,kind:'exchange',coins:[],title:'Old exchange notice',url:'https://announcements.bybit.com/x'};
let r=mergeFeed(null,[detectMove('BTC',[...b15.slice(0,4),bar(b15[4].t,100,104)]),...arts,exOld,...off],{BTC:104,ETH:3000},now);
assert.equal(r.added.length,4);assert.ok(r.feed.items.every(i=>/^20261126-000\d$/.test(i.id)),'KST-day ids');
assert.equal(r.feed.items[0].id,'20261126-0004','newest first');
const btcItem=r.feed.items.find(i=>i.coins.includes('BTC')&&i.kind==='lumex');assert.deepEqual(btcItem.ref_price,{BTC:104});
let r2=mergeFeed(r.feed,[...arts],{BTC:106},now+5*60000);assert.equal(r2.added.length,0,'same keys skipped');
r2=mergeFeed(r2.feed,[],{BTC:110},now+65*60000);
assert.deepEqual(r2.feed.items.find(i=>i.id===btcItem.id).after_1h.price,{BTC:110},'1h-after price filled once');
const v=listView(r2.feed,{tab:'lumex'});assert.ok(v.items.every(i=>i.kind==='lumex'));
assert.ok(!listView(r2.feed,{}).items.some(i=>i.kind==='exchange'||i.kind==='news'),'no exchange; articles hidden without src=');
const withSrc=listView(r2.feed,{tab:'news',src:'blockmedia,nope'});assert.ok(withSrc.items.length===1&&withSrc.items[0].src==='blockmedia'&&withSrc.items[0].lang==='ko');
assert.equal(listView(r2.feed,{tab:'news',src:'coindesk'}).items.length,0,'only listed sources');
assert.equal(listView(r2.feed,{tab:'exchange'}).items.some(i=>i.kind==='exchange'),false,'unknown tab = all, still no exchange');
assert.ok(srcFilter('blockmedia')({kind:'lumex'}),'non-article kinds pass');
const pi=publicItem(r2.feed.items.find(i=>i.id===btcItem.id),{BTC:114.4});assert.equal(pi.change_since_pct.BTC,10);assert.equal(pi.change_1h_after_pct.BTC,5.77);
assert.ok(!('key' in pi),'internal key not public');
const page=listView(r2.feed,{limit:2,src:'blockmedia'});assert.equal(page.items.length,2);assert.equal(page.next,page.items[1].id);
assert.ok(listView(r2.feed,{before:page.next,src:'blockmedia'}).items.every(i=>i.id<page.next),'paging');

// next day resets the sequence
const r3=mergeFeed(r2.feed,[{...off[0],key:'official:new'}],{},Date.UTC(2026,10,26,15,10));assert.equal(r3.added[0].id,'20261127-0001');

// fake R2
function bucket(){const m=new Map();return {m,async get(k){if(!m.has(k))return null;const v=m.get(k);return {json:async()=>JSON.parse(v),size:v.length};},async put(k,v){m.set(k,String(v));},async head(k){return m.has(k)?{size:1}:null;}};}

// route
const B=bucket();await B.put(ROOT+'feed.json',JSON.stringify(r2.feed));
let res=await newsRoute(new Request('https://w/market-hub/v1/news?tab=all&limit=3'),{MARKET_DATA:B});let j=await res.json();assert.ok(j.ok&&j.items.length===2,'lumex + macro; exchange and unlisted articles hidden');
res=await newsRoute(new Request('https://w/market-hub/v1/news/item/'+btcItem.id),{MARKET_DATA:B});j=await res.json();assert.ok(j.ok&&j.item.id===btcItem.id);
res=await newsRoute(new Request('https://w/market-hub/v1/news/item/20990101-0001'),{MARKET_DATA:B});assert.equal(res.status,404);
const exId=r2.feed.items.find(i=>i.kind==='exchange').id;res=await newsRoute(new Request('https://w/market-hub/v1/news/item/'+exId),{MARKET_DATA:B});assert.equal(res.status,404,'old exchange notice not served');
res=await newsRoute(new Request('https://w/market-hub/v1/news?tab=news&src=blockmedia'),{MARKET_DATA:B});j=await res.json();assert.ok(j.items.length===1&&j.items[0].src==='blockmedia');
res=await newsRoute(new Request('https://w/market-hub/v1/news/sources'),{MARKET_DATA:B});j=await res.json();assert.ok(j.ok&&j.sources.length===SOURCES.length&&j.sources[0].last===null);

// collectNews end to end with mocked upstreams
const calls=[];
const kl=(n,f,last)=>({retCode:0,result:{list:Array.from({length:n},(_,i)=>{const t=Math.floor(now/f)*f-(i+1)*f;const c=i===0?last:100;return [String(t),'100',String(Math.max(c,100)),String(Math.min(c,100)),String(c),'1'];})}});
const fetchMock=async url=>{calls.push(url);const u=String(url);let body;
  if(u.includes('/v5/market/kline'))body=kl(8,900000,u.includes('BTCUSDT')?104:100.2);
  else if(u.includes('/v5/market/tickers'))body={retCode:0,result:{list:[{lastPrice:u.includes('BTC')?'104':'100',fundingRate:u.includes('ETH')?'0.0006':'0.0001',openInterestValue:'1000000'}]}};
  else if(u.includes('open-interest'))body={retCode:0,result:{list:Array.from({length:13},(_,i)=>({timestamp:String(now-i*300000),openInterest:'1000'}))}};
  else if(u.includes('contract_stats'))body=Array.from({length:25},(_,i)=>({time:Math.floor((now-(26-i)*H)/1000),long_liq_usd:100,short_liq_usd:100}));
  else if(u==='https://www.blockmedia.co.kr/feed')return new Response(rssXml.replace(/now-H/,''),{status:200});
  else if(u.startsWith('https://www.coindesk.com/'))return new Response(cdXml,{status:200});
  else return new Response('nope',{status:404});
  return new Response(JSON.stringify(body),{status:200});};
const C=bucket();await C.put('market-hub/hyperliquid-whales/v1/latest.json',JSON.stringify({rows:[row]}));
const cnow=Date.UTC(2026,10,26,13,12); // 10-minute article slot
const out=await collectNews({MARKET_DATA:C},{now:cnow,fetchImpl:fetchMock});
assert.ok(out.ok&&out.added>=4,'collected '+JSON.stringify(out));
const fd=JSON.parse(C.m.get(ROOT+'feed.json'));
assert.ok(fd.items.some(i=>i.title==='BTC 1시간 +4.0% 상승'),'btc move');assert.ok(fd.items.some(i=>i.title.startsWith('ETH 펀딩비')),'eth funding');
assert.ok(fd.items.some(i=>i.tags.includes('whale')),'whale');assert.ok(!fd.items.some(i=>i.kind==='exchange'),'no exchange notices collected');
assert.ok(fd.items.some(i=>i.src==='blockmedia')&&fd.items.some(i=>i.src==='coindesk'),'articles collected');
const src=JSON.parse(C.m.get(ROOT+'sources.json'));assert.ok(src.sources.blockmedia.ok&&src.sources.blockmedia.items===1&&src.sources.decrypt.ok===false,'per-source health');
assert.ok(C.m.has(ROOT+'day/20261126.json'),'day archive');
assert.ok(calls.every(u=>/^https:\/\/api\.(bybit\.com|gateio\.ws)\//.test(u)||SOURCES.some(s=>s.url===u)),'only bybit / gate / listed feeds');
assert.ok(!calls.some(u=>u.includes('announcements')),'no announcements API');
const again=await collectNews({MARKET_DATA:C},{now:cnow+60000,fetchImpl:fetchMock});assert.equal(again.added,0,'no duplicates on the next run');

// morning report facts
const h1=Array.from({length:30},(_,i)=>bar(now-(30-i)*H,100+i,101+i,102+i,99+i));
const d1=Array.from({length:60},(_,i)=>bar(now-(60-i)*24*H,100+i,101+i));
const facts=coinFacts('BTCUSDT',{h1,h4:h4,d1,ticker:{fundingRate:'0.0001',openInterestValue:'5000000000'},
  oi1h:Array.from({length:26},(_,i)=>({t:now-(26-i)*H,oi:i===25?1100:1000})),liq});
assert.equal(facts.price.close,130);assert.equal(facts.price.open,106);assert.equal(facts.price.change_24h_pct,22.64);
assert.ok(facts.daily.trend.startsWith('상승')&&facts.derivatives.oi_change_24h_pct===10&&facts.liquidations.long_usd>0&&facts.h4);
assert.equal(coinFacts('BTCUSDT',{h1:h1.slice(0,5)}),null);
const nr=newsForReport(r2.feed,now+70*60000);assert.ok(nr.length>=2&&nr.every(x=>x.at_kst.endsWith('KST')));

// tick: 07:50 KST bundle → Core, 08:00 publish, each once per day
const R=bucket();const coreCalls=[];
const bundleFetch=async(url,init)=>{const u=String(url);
  if(u.startsWith('https://lumexbot.com/wp-json/lumex/v1/ai-report/')){coreCalls.push([u.split('/').pop(),JSON.parse(init.body),init.headers.authorization]);return new Response(JSON.stringify({ok:true,state:'ready'}),{status:200});}
  if(u.includes('kline')){const iv=u.match(/interval=(\w+)/)[1],f={'60':H,'240':4*H,D:24*H}[iv],n=Number(u.match(/limit=(\d+)/)[1]);
    return new Response(JSON.stringify({retCode:0,result:{list:Array.from({length:n},(_,i)=>{const t=Math.floor(Date.UTC(2026,10,25,22,50)/f)*f-(i+1)*f;return [String(t),'100','101','99','100.5','1'];})}}),{status:200});}
  return fetchMock(url);};
const env={MARKET_DATA:R,LUMEX_AI_LAB_WORKER_TOKEN:'t'.repeat(48)};
const at=(h,m)=>Date.UTC(2026,10,25,h-9+24,m);
assert.equal((await morningReportTick(env,{now:at(7,40),fetchImpl:bundleFetch})).stage,'idle');
let t1=await morningReportTick(env,{now:at(7,50),fetchImpl:bundleFetch});assert.ok(t1.ok&&t1.stage==='bundle',JSON.stringify(t1));
assert.equal(coreCalls[0][0],'bundle');assert.ok(coreCalls[0][1].coins.BTC&&coreCalls[0][1].coins.ETH&&coreCalls[0][1].report_date==='2026-11-26');
assert.equal(coreCalls[0][2],'Bearer '+'t'.repeat(48));
assert.equal((await morningReportTick(env,{now:at(7,51),fetchImpl:bundleFetch})).stage,'idle','bundle once');
let t2=await morningReportTick(env,{now:at(8,0),fetchImpl:bundleFetch});assert.ok(t2.stage==='publish'&&coreCalls[1][0]==='publish');
assert.equal((await morningReportTick(env,{now:at(8,1),fetchImpl:bundleFetch})).stage,'idle','publish once after ok');
assert.equal(coreCalls.length,2);
const b=await buildBundle({MARKET_DATA:bucket()},{now:at(7,50),fetchImpl:bundleFetch});assert.ok(b.ok&&b.schema==='lumex_morning_bundle_v1');
const noTok=await morningReportTick({MARKET_DATA:bucket()},{now:at(7,52),fetchImpl:bundleFetch});assert.equal(noTok.ok,false);assert.equal(noTok.reason,'worker_token_missing');
// 2026-11-28: Core refused the Worker (401) → retry every 30 min until 11:59 KST, publish only after Core stored the bundle
{const R2=bucket(),calls=[];let refuse=true;
 const f=async(url,init)=>{const u=String(url);if(u.startsWith('https://lumexbot.com/wp-json/lumex/v1/ai-report/')){calls.push(u.split('/').pop());
   return refuse?new Response('{"code":"lumex_login_required"}',{status:401}):new Response(JSON.stringify({ok:true,state:u.endsWith('publish')?'published':'ready'}),{status:200});}
   return bundleFetch(url,init);};
 const e2={MARKET_DATA:R2,LUMEX_AI_LAB_WORKER_TOKEN:'t'.repeat(48)};
 let x=await morningReportTick(e2,{now:at(7,50),fetchImpl:f});assert.equal(x.ok,false);assert.equal(x.status,401);
 x=await morningReportTick(e2,{now:at(8,0),fetchImpl:f});assert.equal(x.stage,'wait_bundle','no publish ping for a bundle Core never stored');
 x=await morningReportTick(e2,{now:at(8,20),fetchImpl:f});assert.equal(x.stage,'bundle_retry');assert.equal(x.status,401);
 x=await morningReportTick(e2,{now:at(8,40),fetchImpl:f});assert.equal(x.stage,'wait_bundle','30 min between retries');
 refuse=false;x=await morningReportTick(e2,{now:at(8,50),fetchImpl:f});assert.ok(x.ok&&x.stage==='bundle_retry');
 x=await morningReportTick(e2,{now:at(8,51),fetchImpl:f});assert.ok(x.stage==='publish'&&x.state==='published');
 x=await morningReportTick(e2,{now:at(8,52),fetchImpl:f});assert.equal(x.stage,'idle');
 assert.deepEqual(calls,['bundle','bundle','bundle','publish']);
 const R3=bucket(),e3={MARKET_DATA:R3,LUMEX_AI_LAB_WORKER_TOKEN:'t'.repeat(48)};refuse=true;await morningReportTick(e3,{now:at(7,50),fetchImpl:f});
 x=await morningReportTick(e3,{now:at(12,10),fetchImpl:f});assert.equal(x.stage,'idle','after 11:59 the day is left to the backfill');}
console.log('PASS news feed: detectors (move/funding/OI/liq/whale/4H signal), RSS articles (host allowlist, title/link/byline only, src on-list, health), no exchange notices, official, merge (KST ids, dedupe, ref/after-1h prices), public list/item/paging, collect end-to-end; morning bundle facts + 07:50/08:00 Core calls once per day');
