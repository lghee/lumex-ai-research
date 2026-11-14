import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const raw=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
 .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}');
const {BtcReserveCollector,validateLegacyPage,default:worker}=
 await import('data:text/javascript;base64,'+Buffer.from(raw).toString('base64'));
const ts=String(Math.floor(Date.now()/1000)-600);
const rows={
 liquidations:[{id:'11',fingerprint:'a'.repeat(64),coin:'BTC',exchange_name:'Bybit',
  position_side:'long',price:'45000.00000000',quantity:'0.5',notional_usd:'22500.0000',event_ts:ts}],
 whales:[{id:'15',fingerprint:'b'.repeat(64),provider:'esplora',channel:'btc_reserve_net',
  asset:'BTC',chain:'bitcoin',transfer_direction:'in',exchange_name:'Binance',
  amount_usd:'90000.00',amount_coin:'2.00000000',source_label:'observed',
  target_label:'reserve',transaction_hash:'c'.repeat(64),event_ts:ts}],
 market_snapshots:[{id:'51',coin:'ETH',exchange_name:'Bybit',sample_ts:ts,
  price:'3000.00000000',oi_usd:'12000000.0000',sample_kind:'history'}]
};
function page(source,cursor){
 const matching=rows[source].filter(row=>Number(row.id)>cursor);
 return {ok:true,schema:'lumex_wp_public_market_export_v1',source,cursor,
  next_cursor:matching.length?Number(matching.at(-1).id):cursor,
  count:matching.length,limit:100,has_more_possible:false,rows:matching};
}
assert(validateLegacyPage(page('whales',0),'whales',0));
assert.equal(validateLegacyPage({...page('whales',0),rows:[{...rows.whales[0],user_email:'secret'}]},
  'whales',0),null,'unknown user fields must not enter R2');
const objects=new Map(),store=new Map(),writeKeys=[];
const R2={
 async head(key){return objects.has(key)?{size:objects.get(key).length}:null},
 async put(key,value){writeKeys.push(key);objects.set(key,String(value))}
};
const storage={async get(k){return store.get(k)},async put(k,v){store.set(k,v)}};
const env={AUTO_LEGACY_BACKFILL:'true',AUTO_RESEARCH:'false',AUTO_FETCH:'false',
 AUTO_AI:'false',AUTO_WHALE_FETCH:'false',AUTO_LIVE_STREAM:'false',
 AUTO_DERIVATIVES_FETCH:'false',MARKET_DATA:R2,LUMEX_AI_LAB_WORKER_TOKEN:'w'.repeat(64)};
let permissionDenied=false;const calls=[];
const originalFetch=globalThis.fetch;
globalThis.fetch=async (url,opts)=>{
 const u=new URL(url);
 assert.equal(u.origin,'https://lumexbot.com');
 assert.equal(u.pathname,'/wp-json/lumex/v1/market-hub/legacy-export');
 assert.equal(opts.headers.authorization,'Bearer '+'w'.repeat(64));
 const source=u.searchParams.get('source'),cursor=Number(u.searchParams.get('cursor'));
 assert.equal(u.searchParams.get('limit'),'100');
 calls.push({source,cursor});
 if(permissionDenied)return new Response(JSON.stringify({code:'lumex_login_required'}),{status:401});
 return new Response(JSON.stringify(page(source,cursor)),{status:200});
};
const collector=new BtcReserveCollector({storage},env);
env.BTC_RESERVE_COLLECTOR={getByName:id=>{assert.equal(id,'reserve-btc');return {fetch:arg=>collector.fetch(arg instanceof Request?arg:new Request(arg))}}};
const run=async()=>{
 const pending=[];await worker.scheduled({cron:'*/5 * * * *'},env,{waitUntil:p=>pending.push(p)});
 await Promise.all(pending);
 return (await (await collector.fetch(new Request('https://whales/backfill-status'))).json());
};
permissionDenied=true;let h=await run();
assert(h.sources.every(s=>s.cursor===0 && s.last_error==='wordpress_export_http_401'),JSON.stringify(h.sources));
assert.equal(objects.size,0,'no archival write on unauthorized source');
permissionDenied=false;h=await run();
assert(h.sources.every(s=>s.records_archived===1&&s.last_error===null&&s.caught_up));
assert.equal(objects.size,3);
assert(writeKeys.every(k=>k.startsWith('market-hub/legacy/wp/')));
const archives=[...objects.values()].map(v=>JSON.parse(v));
assert(archives.every(a=>a.schema==='lumex_legacy_archive_v1'&&a.merged_with_live_observations===false));
assert.equal(archives.find(a=>a.source==='whales').records[0].amount_coin,'2.00000000');
assert.equal(archives.find(a=>a.source==='liquidations').records[0].position_side,'long');
assert.equal(archives.find(a=>a.source==='market_snapshots').records[0].oi_usd,'12000000.0000');
assert(!writeKeys.some(k=>k.startsWith('market-hub/events/')),'legacy events must not enter live ledger');
h=await run();
assert(h.sources.every(s=>s.records_archived===1),'retries cannot increment source row counters');
assert.equal(objects.size,3,'second poll has no new rows');
const status=await worker.fetch(new Request('https://worker/market-hub/v1/legacy-backfill-health'),env);
assert.equal(status.status,200);assert.equal((await status.json()).sources.length,3);
const sidefx=await worker.fetch(new Request('https://worker/market-hub/v1/health'),env);
assert.equal((await sidefx.json()).version,'1.3.1');
globalThis.fetch=originalFetch;
console.log('PASS 1.2.6 historic WordPress public-market: 401 isolation, 3 read-only cursor exports, exact R2 records, no live merge, no duplicate archive');
