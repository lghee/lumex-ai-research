import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const raw=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
  .replace("import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}');
const {observedLegacySummary,observedTimelineSummary}=
 await import('data:text/javascript;base64,'+Buffer.from(raw).toString('base64'));
const now=Date.UTC(2026,10,15,7,0,0);
const rows=[
 {ts:now-120000,source:'bybit',payload:JSON.stringify({id:'b1',position_side:'long',price:100,quantity:2,capture:'public_stream'})},
 {ts:now-420000,source:'binance',payload:JSON.stringify({id:'n1',position_side:'short',price:90,quantity:3,capture:'sampled_1s'})}
];
const fake={exec(sql,...args){
 assert.match(sql,/kind='liquidation'/);
 if(sql.includes('SELECT ts'))return {toArray:()=>rows};
 return {toArray:()=>[
 {hour_ms:now-3600000,source:'bybit',side:'long',event_count:3,amount:500,last_ms:now-1800000},
 {hour_ms:now-3600000,source:'binance',side:'short',event_count:2,amount:200,last_ms:now-1800000}
 ]};
}};
const s=observedLegacySummary(fake,1,now);
assert.equal(s.legacy_sql_read,false);
assert.equal(s.market_total_estimate,false);
assert.equal(s.events.length,2);
assert.equal(s.sums.length,2);
assert.equal(s.sums[0].value,200);
assert.equal(s.sums[1].value,270);
assert.equal(s.events[0].exchange,'Bybit');
assert.equal(s.events[1].exchange,'Binance');
assert.equal(s.bin_seconds,300);
for(const wrong of [0,2,365])assert.throws(()=>observedLegacySummary(fake,wrong,now));
const t=observedTimelineSummary(fake,30,now);
assert.equal(t.covered_days,14);
assert.equal(t.coverage_complete,false);
assert.equal(t.groups.length,2);
assert.equal(t.groups[0].exchange_name,'Bybit');
assert.equal(t.groups[1].exchange_name,'Binance');
assert.equal(observedTimelineSummary(fake,7,now).coverage_complete,true);
assert.throws(()=>observedTimelineSummary({exec(){return {toArray(){return [
 {hour_ms:now-3600000,source:'bybit',side:'long',event_count:1,amount:0,last_ms:now-1800000}
]}}}},7,now),/timeline_hourly_invalid/);
console.log('PASS Cloudflare legacy observed consumers: source isolation, 1h 5-minute bins, 30d honest 14d limit');