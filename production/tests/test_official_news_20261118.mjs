import assert from 'node:assert/strict';
import {parseOfficialFeed,collectOfficialNews,officialNewsPublicRoute} from '../src/official-news.mjs';
const now=Date.parse('2026-11-18T14:01:00Z');
const feed={id:'fed',label:'미국 연방준비제도',host:'www.federalreserve.gov',
 url:'https://www.federalreserve.gov/feeds/press_monetary.xml',kind:'monetary_policy'};
const xml='<?xml version="1.0"?><rss version="2.0"><channel><title>Fed</title><item>'+
 '<title><![CDATA[Federal Reserve issues monetary policy statement]]></title>'+
 '<link>https://www.federalreserve.gov/newsevents/pressreleases/monetary20261118a.htm</link>'+
 '<pubDate>Wed, 18 Nov 2026 12:00:00 GMT</pubDate></item></channel></rss>';
const parsed=parseOfficialFeed(xml,feed,now);
assert.equal(parsed.length,1);
assert.equal(parsed[0].title_original,'Federal Reserve issues monetary policy statement');
assert.equal(parsed[0].official_source_verified,true);
assert.equal(parsed[0].published_ms,Date.parse('2026-11-18T12:00:00Z'));
assert.throws(()=>parseOfficialFeed(xml.replace('https://www.federalreserve.gov/','https://bad.example/'),feed,now),/official_articles_unverified/);
assert.throws(()=>parseOfficialFeed(xml.replace('Federal Reserve issues monetary policy statement','bad'),feed,now),/official_articles_unverified/);
assert.throws(()=>parseOfficialFeed(xml.replace('18 Nov 2026','18 Nov 2046'),feed,now),/official_articles_unverified/);
assert.throws(()=>parseOfficialFeed('<html>404</html>',feed,now),/feed_size_invalid|official_feed_items_missing/);
const saved=new Map();
const env={MARKET_DATA:{put:async(k,v)=>saved.set(k,String(v)),get:async k=>saved.has(k)?{json:async()=>JSON.parse(saved.get(k))}:null}};
const fetchOriginal=globalThis.fetch;
try{
 globalThis.fetch=async()=>new Response(xml,{status:200,headers:{'content-type':'application/xml'}});
 const r=await collectOfficialNews(env,now);assert.equal(r.ok,true);
 assert.ok(saved.has('market-hub/official-news/v1/latest.json'));
 const res=await officialNewsPublicRoute(new Request('https://worker/market-hub/v1/official-news'),env,now);
 assert.equal(res.status,200);
 const d=await res.json();
 assert.equal(d.items[0].agency,'미국 연방준비제도');
 assert.equal(d.no_news_inference,true);assert.equal(d.no_order_execution,true);
 assert.equal(d.coverage.attempted_feeds,4);
 assert.equal((await collectOfficialNews(env,now+60000)).skipped,'recent_attempt');
 assert.equal((await officialNewsPublicRoute(new Request('https://worker/market-hub/v1/official-news',{method:'POST'}),env,now)).status,405);
 assert.equal((await officialNewsPublicRoute(new Request('https://worker/market-hub/v1/official-news'),env,now+25*3600000)).json instanceof Function,true);
 const stale=await (await officialNewsPublicRoute(new Request('https://worker/market-hub/v1/official-news'),env,now+25*3600000)).json();
 assert.equal(stale.stale,true);
 const old=saved.get('market-hub/official-news/v1/latest.json');
 globalThis.fetch=async()=>new Response('Forbidden',{status:403});
 const failed=await collectOfficialNews(env,now+3*3600000);
 assert.equal(failed.ok,false);
 assert.equal(saved.get('market-hub/official-news/v1/latest.json'),old);
}finally{globalThis.fetch=fetchOriginal}
console.log('PASS official headlines: authenticated source URLs, dates, no hallucinations, cached R2 and fail closed');
