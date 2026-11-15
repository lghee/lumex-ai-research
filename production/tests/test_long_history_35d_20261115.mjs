import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const raw=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
 .replace("import { DurableObject } from 'cloudflare:workers';",
 'class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env} }');
const {observedTimelineSummary}=await import('data:text/javascript;base64,'+Buffer.from(raw).toString('base64'));
const now=Date.UTC(2026,10,15,8),day=86400000;
const fake={exec(q,start,end){assert.match(q,/kind='liquidation'/);return {toArray:()=>[
 {hour_ms:now-3600000,source:'bybit',side:'long',event_count:3,amount:99,last_ms:now-3500000}
]}}};
const cold=observedTimelineSummary(fake,30,now,now-7*day);
assert.equal(cold.covered_days,14);
assert.equal(cold.coverage_complete,false);
assert.equal(cold.backfill_older_than_hot_index,false);
const hot=observedTimelineSummary(fake,30,now,now-31*day);
assert.equal(hot.covered_days,30);
assert.equal(hot.coverage_complete,true);
assert.equal(hot.groups.length,1);
assert.equal(hot.legacy_sql_read,false);
assert.equal(observedTimelineSummary(fake,7,now,now).coverage_complete,true);
assert.equal(observedTimelineSummary(fake,7,now,now).covered_days,7);
const workerCode=raw;
assert(workerCode.includes('HUB_LONG_RETENTION_DAYS=35'));
assert(workerCode.includes("kind NOT IN ('liquidation','whale_transfer')"));
assert(workerCode.includes("kind IN ('liquidation','whale_transfer')"));
assert(workerCode.includes("INSERT OR IGNORE INTO hub_meta(key,value) VALUES ('long_history_started_ms',?)"));
console.log('PASS long-history warm-up gate, 35d retention policy, 30d no premature cutover');