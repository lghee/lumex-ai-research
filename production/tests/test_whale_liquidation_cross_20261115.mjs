import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const raw=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
 .replace("import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}');
const {whaleLiqCrossTimestamps,whaleLiqCrossQuery}=
 await import('data:text/javascript;base64,'+Buffer.from(raw).toString('base64'));
const now=Date.UTC(2026,10,15,6,0,0),recent=Math.floor((now-5400000)/1000),older=Math.floor((now-16*86400000)/1000);
assert.deepEqual(whaleLiqCrossTimestamps(String(recent),now),[recent]);
for(const v of ["","wrong",String(recent)+','+String(recent),"99",
 Array.from({length:13},(_,i)=>recent-i*60).join(',')])
 assert.equal(whaleLiqCrossTimestamps(v,now),null);
let queries=0;
const sql={exec(q,first,second,start,end){
 queries++;assert.match(q,/kind='liquidation'/);
 assert.match(q,/source IN \('bybit','binance'\)/);
 assert.equal(first,recent*1000+3600000);assert.equal(second,first);
 assert.equal(start,recent*1000);assert.equal(end,now);
 return {toArray:()=>[
  {source:'bybit',side:'long',count_1h:1,count_4h:3,usd_1h:1500.1,usd_4h:2800.5},
  {source:'binance',side:'short',count_1h:2,count_4h:5,usd_1h:2100,usd_4h:4300}]};
}};
const r=whaleLiqCrossQuery(sql,[recent,older],now);
assert.equal(queries,1);
assert.deepEqual(r.uncovered_indices,[1]);
assert.equal(r.rows.length,2);
assert.equal(r.market_total_estimate,false);
assert.equal(r.legacy_sql_read,false);
assert.equal(r.rows[0].usd_4h,2800.5);
assert.equal(r.rows[0].exchange,'Bybit');
assert.equal(r.rows[1].exchange,'Binance');
assert.equal(r.rows[1].side,'short');
assert.equal(r.order_execution,false);
assert.equal(r.provider_comparability,'not_comparable');
assert.throws(()=>whaleLiqCrossQuery({exec(){return {toArray(){return [
 {source:'bybit',side:'long',count_1h:3,count_4h:1,usd_1h:4,usd_4h:2}
]}}}},[recent],now),/aggregation_invalid/);
console.log('PASS whale liquidity 1h/4h cross and 14d retention');
