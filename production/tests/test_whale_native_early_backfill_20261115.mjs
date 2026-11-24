import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const raw=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
 .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}');
const {nativeWhaleWatchlistBackfillProof}=await import('data:text/javascript;base64,'+Buffer.from(raw).toString('base64'));
const now=Date.UTC(2026,10,15,8,40,0);
const entry=(backfill_complete=true,gap_possible=false,last_checked_ms=now-1200000)=>
 ({backfill_complete,gap_possible,error:null,last_checked_ms});
const report={enabled:true,source:'wordpress_configured',watchlist_count:4,
 last_success_ms:now-120000,watchlist:[entry(),entry(),entry(),entry()]};
assert.equal(nativeWhaleWatchlistBackfillProof(report,now),true,'all addresses historical scan completed');
assert.equal(nativeWhaleWatchlistBackfillProof({...report,enabled:false},now),false);
assert.equal(nativeWhaleWatchlistBackfillProof({...report,source:'legacy_seed_fallback'},now),false);
assert.equal(nativeWhaleWatchlistBackfillProof({...report,watchlist_count:5},now),false);
assert.equal(nativeWhaleWatchlistBackfillProof({...report,watchlist:[]},now),false);
assert.equal(nativeWhaleWatchlistBackfillProof({...report,last_success_ms:now-1200001},now),false);
assert.equal(nativeWhaleWatchlistBackfillProof({...report,watchlist:[entry(),entry(false),entry(),entry()]},now),false);
assert.equal(nativeWhaleWatchlistBackfillProof({...report,watchlist:[entry(),entry(true,true),entry(),entry()]},now),false);
// 2026-11-25: a transient error on one address no longer drops the native page
// while that address's last success is recent; stale or widespread failures still fail closed.
assert.equal(nativeWhaleWatchlistBackfillProof({...report,watchlist:[entry(),{...entry(),error:'esplora_http_429'},entry(),entry()]},now),true,'one transient 429 with recent success');
assert.equal(nativeWhaleWatchlistBackfillProof({...report,watchlist:[entry(),{...entry(true,false,now-3700000),error:'esplora_http_429'},entry(),entry()]},now),false,'errored address with stale success');
assert.equal(nativeWhaleWatchlistBackfillProof({...report,watchlist:[{...entry(),error:'x'},{...entry(),error:'x'},{...entry(),error:'x'},entry()]},now),false,'3 of 4 erroring');
assert.equal(nativeWhaleWatchlistBackfillProof({...report,watchlist:[entry(),{...entry(false),error:'x'},entry(),entry()]},now),false,'errored address without full history');
const many={...report,watchlist_count:63,watchlist:Array.from({length:63},(_,i)=>i<9?{...entry(),error:'esplora_timeout'}:entry())};
assert.equal(nativeWhaleWatchlistBackfillProof(many,now),true,'9 of 63 (<=15%) transient');
assert.equal(nativeWhaleWatchlistBackfillProof({...many,watchlist:many.watchlist.map((e,i)=>i<10?{...entry(),error:'x'}:e)},now),false,'10 of 63 erroring fails closed');
assert.equal(nativeWhaleWatchlistBackfillProof({...report,watchlist:[entry(),entry(true,false,now-4000000),entry(),entry()]},now),false);
assert.equal(nativeWhaleWatchlistBackfillProof({...report,watchlist_count:0},now),false);
const expanded={...report,watchlist_count:63,watchlist:Array.from({length:63},()=>entry())};
assert.equal(nativeWhaleWatchlistBackfillProof(expanded,now),true,'63 checked addresses can be ready');
assert.equal(nativeWhaleWatchlistBackfillProof({...expanded,watchlist_count:151,watchlist:Array.from({length:151},()=>entry())},now),false,'151 addresses fail closed');
assert(raw.includes("native_whale_30d_backfill_not_ready"),'gate must deny incomplete scan even when previously warm');
console.log('PASS full BTC watchlist history replaces only wall-clock wait, negative proofs fail closed');
