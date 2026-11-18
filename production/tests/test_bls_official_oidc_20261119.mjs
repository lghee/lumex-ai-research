import assert from 'node:assert/strict';
import {parseVerifiedBlsSidecar,mergeVerifiedBls,loadBlsSidecar,ingestBlsOidc} from '../src/bls-official-sidecar.mjs';
import {parseOfficialFeed} from '../src/official-news.mjs';
const NOW=Date.parse('2026-11-19T00:00:00Z');
const data={
 schema:'lumex_bls_official_atom_oidc_v1',run_id:'12345678901',checked_ms:NOW,
 feeds:[{id:'bls_cpi',status:'verified'},{id:'bls_jobs',status:'verified'}],
 items:[{source_id:'bls_cpi',title:'CPI for all items increases 0.4% in October; shelter rises',
   source_url:'https://www.bls.gov/news.release/archives/cpi_11102026.htm',
   published_ms:Date.parse('2026-11-10T12:55:47Z')},
  {source_id:'bls_jobs',title:'Payroll employment rises by 165,000 in October; unemployment rate little changed',
   source_url:'https://www.bls.gov/news.release/archives/empsit_11062026.htm',
   published_ms:Date.parse('2026-11-06T12:50:31Z')}]
};
const parsed=parseVerifiedBlsSidecar(data,NOW);
assert.equal(parsed.items.length,2);
assert.equal(parsed.feeds[0].status,'verified_via_github');
for(const field of [
 {data:{...data,run_id:'invalid'}},
 {data:{...data,checked_ms:NOW-7*60000}},
 {data:{...data,items:[{...data.items[0],source_url:'https://evil.example/news.release/archives/cpi_11102026.htm'}]}},
 {data:{...data,items:[{...data.items[0],source_id:'bls_jobs'}]}},
 {data:{...data,items:[{...data.items[0],published_ms:NOW+2*3600000}]}}
])assert.throws(()=>parseVerifiedBlsSidecar(field.data,NOW));
const main={schema:'lumex_public_official_news_v1',items:[{source_id:'fed',published_ms:NOW-60000,title_original:'Fed headline'}],
 feeds:[{id:'fed',status:'verified'},{id:'bea',status:'unavailable'},
   {id:'bls_cpi',status:'unavailable'},{id:'bls_jobs',status:'unavailable'}],
 collected_ms:NOW-3600000,no_news_inference:true,no_order_execution:true};
const combined=mergeVerifiedBls(main,parsed,NOW);
assert.equal(combined.items.length,3);
assert.equal(combined.coverage.verified_feeds,3);
assert.equal(combined.feeds.find(x=>x.id==='bls_cpi').status,'verified_via_github');
const direct={...main,items:[...main.items,{...parsed.items[0],title_original:'new direct CPI'}],
 feeds:main.feeds.map(x=>x.id==='bls_cpi'?{...x,status:'verified'}:x)};
const prefer=mergeVerifiedBls(direct,parsed,NOW);
assert.equal(prefer.items.filter(x=>x.source_id==='bls_cpi').length,1);
assert.equal(prefer.items.find(x=>x.source_id==='bls_cpi').title_original,'new direct CPI');
assert.equal(prefer.feeds.find(x=>x.id==='bls_cpi').status,'verified');
const map=new Map();
map.set('market-hub/official-news/v1/latest.json',JSON.stringify(main));
const bucket={
 get:async k=>map.has(k)?{json:async()=>JSON.parse(map.get(k))}:null,
 put:async(k,v)=>{map.set(k,String(v));}
};
const env={MARKET_DATA:bucket};
const request=body=>new Request('https://worker/market-hub/v1/bls-oidc-ingest',{method:'POST',headers:{authorization:'Bearer fictional_valid_token_for_test','content-type':'application/json'},body:JSON.stringify(body)});
const checker=async()=>({run_id:data.run_id});
assert.equal((await ingestBlsOidc(request(data),env,async()=>null,NOW)).status,401);
const r=await ingestBlsOidc(request(data),env,checker,NOW);
assert.equal(r.status,200);
assert.equal((await r.json()).received,2);
assert.equal((await loadBlsSidecar(bucket,NOW)).items.length,2);
assert.equal(JSON.parse(map.get('market-hub/official-news/v1/latest.json')).items.length,3);
const repeat={...data,checked_ms:NOW-60000};
assert.equal((await (await ingestBlsOidc(request(repeat),env,checker,NOW)).json()).ignored,'older_replay');
const tamper={...data,items:[{...data.items[0],title:'<script>Bad headline text</script>'}]};
assert.equal((await ingestBlsOidc(request(tamper),env,checker,NOW)).status,400);
const f={id:'bls_cpi',label:'BLS',host:'www.bls.gov',kind:'inflation',url:'https://www.bls.gov/feed/cpi.rss'};
const atom='<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>CPI for all items increases 0.4% in October; shelter rises</title><link href="https://www.bls.gov/news.release/archives/cpi_11102026.htm" /><published>2026-11-10T07:55:47.272-05:00</published></entry></feed>';
assert.equal(parseOfficialFeed(atom,f,NOW).length,1);
console.log('BLS OIDC: real Atom format, source domain/date, separate auth, merge/no-overwrite, R2 replay and tamper PASS');
