import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const raw=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
  .replace("import { DurableObject } from 'cloudflare:workers';",
    'class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env} }');
const {normalizeArchivedWhales30d,hubWhales30dArchive}=await import('data:text/javascript;base64,'+Buffer.from(raw).toString('base64'));
const now=Date.now(),ts=Math.floor(now/1000)-86400;
const one=(id,side='in',value='12.50000000',timestamp=ts)=>({
 id:String(id),fingerprint:'a'.repeat(64),provider:'esplora',channel:'btc_reserve_net',
 asset:'BTC',chain:'bitcoin',transfer_direction:side,exchange_name:'Binance',
 amount_usd:'123450.00',amount_coin:value,source_label:'public reserve',
 target_label:'public reserve',transaction_hash:id.toString(16).padStart(64,'0'),event_ts:String(timestamp)
});
const doc=rows=>({schema:'lumex_legacy_archive_v1',source:'whales',origin:'lumexbot_wordpress_public_market_mysql',
 source_cursor_from:0,source_cursor_to:Number(rows.at(-1)?.id||0),record_count:rows.length,
 records:rows,merged_with_live_observations:false});
const out=normalizeArchivedWhales30d([doc([one(11),one(12,'out','8.25000000')])],now);
assert.equal(out.archived_total,2);
assert.equal(out.rows.length,2);
assert.equal(out.highest_id,12);
assert.equal(out.rows[0].amount_coin,12.5);
assert.equal(out.rows[1].transfer_direction,'out');
assert.equal(out.rows[0].exchange_name,'Binance');
assert.equal(normalizeArchivedWhales30d([doc([one(13,'in','3.0',ts-40*86400)])],now).rows.length,0);
for(const bad of [
 doc([one(11),one(11)]),
 doc([{...one(11),user_email:'secret',transaction_hash:'missing'}]),
 {...doc([one(11)]),merged_with_live_observations:true},
 {...doc([one(11)]),source:'liquidations'},
 doc([one(11,'unknown')]),
 doc([{...one(11),asset:'ETH'}])
]){
 assert.throws(()=>normalizeArchivedWhales30d([bad],now));
}
console.log('PASS immutable 30-day whale archive reducer: source isolation, timestamp bounds, duplicates, invalid inputs');

const archiveDoc=doc([one(51),one(52,'out','5.00')]);
const archiveRaw=JSON.stringify(archiveDoc);
const {createHash}=await import('node:crypto');
const sha=createHash('sha256').update(archiveRaw).digest('hex');
const archiveKey='market-hub/legacy/wp/whales/51-52-'+sha.slice(0,24)+'.json';
const health={enabled:true,sources:[{source:'whales',cursor:52,
 records_archived:2,chunks_archived:1,caught_up:true,last_success_ms:now-30000,last_error:null}]};
const env={MARKET_DATA:{
 async list({prefix}){assert.equal(prefix,'market-hub/legacy/wp/whales/');return {truncated:false,objects:[{key:archiveKey}]}},
 async get(key){assert.equal(key,archiveKey);return {size:archiveRaw.length,customMetadata:{schema:'lumex_legacy_archive_v1',source:'whales',sha256:sha},
 async text(){return archiveRaw}}}
},BTC_RESERVE_COLLECTOR:{getByName(name){assert.equal(name,'reserve-btc');return {async fetch(){
 return new Response(JSON.stringify(health),{status:200})}}}}};
const live=await (await hubWhales30dArchive(env,now)).json();
assert.equal(live.ok,true,JSON.stringify(live));
assert.equal(live.rows.length,2);
assert.equal(live.legacy_sql_read,false);
assert.equal(live.live_ledger_merged,false);
assert.equal(live.cron_retirement_authorized,false);
assert.equal(live.archived_total,2);
env.MARKET_DATA.get=async()=>({size:archiveRaw.length,customMetadata:{
 schema:'lumex_legacy_archive_v1',source:'whales',sha256:'0'.repeat(64)},
 async text(){return archiveRaw}});
const altered=await hubWhales30dArchive(env,now);
assert.equal(altered.status,503,'R2 tamper must fail closed');
health.sources[0].caught_up=false;
const pending=await hubWhales30dArchive(env,now);
assert.equal(pending.status,503,'incomplete backfill must fail closed');
console.log('PASS end-to-end R2 whale archive: 30-day schema, authenticated data provenance, SHA mismatch, backfill gap rejection');
