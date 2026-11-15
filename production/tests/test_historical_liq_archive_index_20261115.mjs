import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const raw=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
 .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}');
const {validateHistoricalLiquidationArchive,archivedLiqTimeline,archivedLiqReplay,
 runLegacyLiqIndex}=await import('data:text/javascript;base64,'+Buffer.from(raw).toString('base64'));
const now=Date.now(),ts=Math.floor(now/1000)-16*86400;
const event={id:'41',fingerprint:'a'.repeat(64),coin:'BTC',exchange_name:'Bybit',
 position_side:'long',price:'100',quantity:'2.5',notional_usd:'250',event_ts:String(ts)};
const doc={schema:'lumex_legacy_archive_v1',source:'liquidations',
 origin:'lumexbot_wordpress_public_market_mysql',merged_with_live_observations:false,
 record_count:1,source_cursor_from:0,source_cursor_to:41,records:[event]};
assert.deepEqual(validateHistoricalLiquidationArchive(doc)[0].notional_usd,250);
assert.equal(validateHistoricalLiquidationArchive({...doc,source:'whales'}),null);
assert.equal(validateHistoricalLiquidationArchive({...doc,records:[event,event],record_count:2}),null);
assert.equal(validateHistoricalLiquidationArchive({...doc,records:[{...event,price:'NaN'}]}),null);
const fakeSql={exec(q,...args){
 if(q.startsWith('SELECT id'))return {toArray:()=>[{id:41,event_ts:ts,
  exchange_name:'Bybit',position_side:'long',price:100,notional_usd:250}]};
 if(q.includes('CAST(event_ts/300'))return {toArray:()=>[{bucket:Math.floor(ts/300)*300,
  exchange_name:'Bybit',position_side:'long',event_count:1,usd:250}]};
 return {toArray:()=>[{bucket:Math.floor(ts/3600),exchange_name:'Bybit',
  position_side:'long',event_count:1,total_usd:250,last_ts:ts}]};
}};
let timeline=archivedLiqTimeline(fakeSql,'BTC',30,now);
assert.equal(timeline.source,'cloudflare_r2_archived_wordpress_liquidations');
assert.equal(timeline.covered_days,30);
assert.equal(timeline.legacy_sql_read,false);
assert.equal(timeline.groups[0].total_usd,250);
const start=Math.floor(ts/3600)*3600000;
let replay=archivedLiqReplay(fakeSql,'BTC',start,start+14400000,now);
assert.equal(replay.source_scope,'archived_wordpress_public_liquidation_observations_only');
assert.equal(replay.events.length,1);assert.equal(replay.bins_5m.length,1);
assert.equal(replay.events[0].amount_usd_estimate,250);
assert.equal(replay.truncated,false);
assert.throws(()=>archivedLiqReplay(fakeSql,'BTC',start,start+5*3600000,now));
const rawDoc=JSON.stringify(doc),sha=createHash('sha256').update(rawDoc).digest('hex');
const key='market-hub/legacy/wp/liquidations/41-41-'+sha.slice(0,24)+'.json';
const keys=new Set(),rows=new Map(),saved=new Map([['legacy-backfill:liquidations',{
 caught_up:true,last_error:null,records_archived:1,chunks_archived:1,last_success_ms:now-5000}]]);
const storage={sql:{exec(q,...args){
 if(q.startsWith('SELECT key FROM legacy_liq_chunks'))return {toArray:()=>keys.has(args[0])?[{key:args[0]}]:[]};
 if(q.startsWith('INSERT OR IGNORE INTO legacy_liq_events')){rows.set(args[0],args);return {toArray:()=>[]}};
 if(q.startsWith('INSERT OR IGNORE INTO legacy_liq_chunks')){keys.add(args[0]);return {toArray:()=>[]}};
 if(q.startsWith('SELECT COUNT(*) AS chunks'))return {toArray:()=>[{chunks:keys.size,rows:rows.size}]};
 return {toArray:()=>[]};
 }},async get(k){return saved.get(k)},async put(k,v){saved.set(k,v)}};
const r2={async list(){return {objects:[{key}],truncated:false}},
 async get(){return {size:rawDoc.length,
 customMetadata:{schema:'lumex_legacy_archive_v1',source:'liquidations',sha256:sha},
 async text(){return rawDoc}}}};
const result=await runLegacyLiqIndex({MARKET_DATA:r2},storage,now);
assert.equal(result.ok,true);assert.equal(result.caught_up,true);
assert.equal(result.indexed_rows,1);assert.equal(rows.size,1);
const rerun=await runLegacyLiqIndex({MARKET_DATA:r2},storage,now+1000);
assert.equal(rerun.indexed_this_round,0,'idempotent rerun never creates another source row');
const tampered={...r2,get:async()=>({size:rawDoc.length,customMetadata:{schema:'lumex_legacy_archive_v1',
 source:'liquidations',sha256:'0'.repeat(64)},async text(){return rawDoc}})};
const empty={...storage,sql:{exec(q,...args){if(q.startsWith('SELECT key FROM'))return {toArray:()=>[]};
 return {toArray:()=>[]}}}};
await assert.rejects(()=>runLegacyLiqIndex({MARKET_DATA:tampered},empty,now),/archive_index_sha_mismatch/);
console.log('PASS historical public R2 archive: schema, immutable SHA, dedupe, 30d timeline, 16d replay and SQL-free WP consumers');