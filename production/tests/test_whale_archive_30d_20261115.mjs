import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const raw=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
  .replace("import { DurableObject } from 'cloudflare:workers';",
    'class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env} }');
const {normalizeArchivedWhales30d}=await import('data:text/javascript;base64,'+Buffer.from(raw).toString('base64'));
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