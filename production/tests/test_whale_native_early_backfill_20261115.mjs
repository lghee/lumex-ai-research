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
assert.equal(nativeWhaleWatchlistBackfillProof({...report,watchlist:[entry(),{...entry(),error:'esplora_http_429'},entry(),entry()]},now),false);
assert.equal(nativeWhaleWatchlistBackfillProof({...report,watchlist:[entry(),entry(true,false,now-4000000),entry(),entry()]},now),false);
assert.equal(nativeWhaleWatchlistBackfillProof({...report,watchlist_count:0},now),false);
assert(raw.includes("native_whale_30d_backfill_not_ready"),'gate must deny incomplete scan even when previously warm');
console.log('PASS full BTC watchlist history replaces only wall-clock wait, negative proofs fail closed');
