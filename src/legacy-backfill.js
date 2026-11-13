/**
 * LUMEX public-market legacy archive importer.
 * Copies only the three explicitly allowlisted WordPress public-observation
 * tables to a SEPARATE immutable R2 archive. It deliberately does not ingest
 * these into the live event ledger (which would double-count old observations).
 * No user data, secrets, trading positions or exchange orders are accessed.
 */
export const LEGACY_SOURCES=Object.freeze(['liquidations','whales','market_snapshots']);
const PREFIX='market-hub/legacy/wp/';
const REQUIRED=Object.freeze({
  liquidations:['id','fingerprint','coin','exchange_name','position_side','price','quantity','notional_usd','event_ts'],
  whales:['id','fingerprint','provider','channel','asset','chain','transfer_direction','exchange_name','amount_usd','amount_coin','source_label','target_label','transaction_hash','event_ts'],
  market_snapshots:['id','coin','exchange_name','sample_ts','price','oi_usd','sample_kind']
});
const err=e=>String(e?.message||e||'unknown').replace(/[^A-Za-z0-9_-]/g,'_').slice(0,85);
const hex=bytes=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
export function validateLegacyPage(json,source,cursor,limit=100){
  if(json?.ok!==true||json?.schema!=='lumex_wp_public_market_export_v1'||
     json?.source!==source||Number(json?.cursor)!==cursor||
     !Array.isArray(json?.rows)||json.rows.length>limit||
     Number(json?.count)!==json.rows.length)return null;
  let last=cursor;
  const allowed=new Set(REQUIRED[source]);
  const out=[];
  for(const row of json.rows){
    if(!row||typeof row!=='object'||Array.isArray(row))return null;
    if(Object.keys(row).some(k=>!allowed.has(k)))return null;
    if(REQUIRED[source].some(k=>typeof row[k]!=='string'))return null;
    const id=Number(row.id);
    if(!Number.isSafeInteger(id)||id<=last)return null;
    const time=Number(row[source==='market_snapshots'?'sample_ts':'event_ts']);
    if(!Number.isSafeInteger(time)||time<1300000000||time>Date.now()/1000+120)return null;
    if(source==='liquidations'&&(!/^[a-fA-F0-9]{64}$/.test(row.fingerprint)||
       !['BTC','ETH','SOL','XRP'].includes(row.coin)||!['long','short'].includes(row.position_side.toLowerCase())))return null;
    if(source==='whales'&&(!/^[a-fA-F0-9]{64}$/.test(row.fingerprint)||
       !['in','out'].includes(row.transfer_direction)||row.asset!=='BTC'))return null;
    if(source==='market_snapshots'&&!['BTC','ETH','SOL','XRP'].includes(row.coin))return null;
    const values=source==='liquidations'?['price','quantity','notional_usd']:
      source==='whales'?['amount_usd','amount_coin']:['price','oi_usd'];
    if(values.some(k=>row[k]===''||!Number.isFinite(Number(row[k]))||Number(row[k])<0))return null;
    last=id;out.push(Object.fromEntries(REQUIRED[source].map(k=>[k,row[k]])));
  }
  if(Number(json.next_cursor)!==last)return null;
  return out;
}
export async function backfillOneLegacySource(env,storage,source){
  if(!LEGACY_SOURCES.includes(source))throw Error('unknown_source');
  if(!env.MARKET_DATA||typeof env.LUMEX_AI_LAB_WORKER_TOKEN!=='string'||
     env.LUMEX_AI_LAB_WORKER_TOKEN.length<48)throw Error('legacy_backfill_not_configured');
  const stateKey='legacy-backfill:'+source;
  const state=await storage.get(stateKey)||{
    source,cursor:0,records_archived:0,chunks_archived:0,
    first_import_ms:Date.now(),last_attempt_ms:0,last_success_ms:0,
    last_error:null,caught_up:false,source_retention_days:35,
    historical_live_ledger_merged:false
  };
  state.last_attempt_ms=Date.now();
  const cursor=Number(state.cursor)||0,limit=100;
  const url='https://lumexbot.com/wp-json/lumex/v1/market-hub/legacy-export?source='+
    encodeURIComponent(source)+'&cursor='+cursor+'&limit='+limit;
  try{
    const response=await fetch(url,{
      headers:{authorization:'Bearer '+env.LUMEX_AI_LAB_WORKER_TOKEN,accept:'application/json'},
      signal:AbortSignal.timeout(12000)});
    if(!response.ok)throw Error('wordpress_export_http_'+response.status);
    const body=await response.text();
    if(body.length>180000||body.length<2)throw Error('wordpress_export_size');
    let decoded;try{decoded=JSON.parse(body)}catch{throw Error('wordpress_export_json')}
    const rows=validateLegacyPage(decoded,source,cursor,limit);
    if(rows===null)throw Error('wordpress_export_schema_invalid');
    if(rows.length){
      const first=Number(rows[0].id),last=Number(rows.at(-1).id);
      // Source IDs and original provider fingerprints are preserved. This is a
      // lossless, source-attributed archive, not a normalized liquidation count.
      const payload={
        schema:'lumex_legacy_archive_v1',source,origin:'lumexbot_wordpress_public_market_mysql',
        source_cursor_from:cursor,source_cursor_to:last,record_count:rows.length,
        records:rows,integrity:'sha256_of_utf8_json_document',
        merged_with_live_observations:false,imported_at_ms:Date.now()
      };
      const json=JSON.stringify(payload);
      const digest=hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(json)));
      const key=PREFIX+source+'/'+first+'-'+last+'-'+digest.slice(0,24)+'.json';
      const previous=await env.MARKET_DATA.head(key);
      if(!previous)await env.MARKET_DATA.put(key,json,{
        httpMetadata:{contentType:'application/json'},
        customMetadata:{schema:'lumex_legacy_archive_v1',source,
          first_id:String(first),last_id:String(last),sha256:digest}
      });
      // Checkpoint only AFTER the object is safely present in R2.
      state.cursor=last;state.records_archived+=rows.length;state.chunks_archived++;
      state.last_archive_key=key;state.last_archive_sha256=digest;
      state.last_first_id=first;state.last_last_id=last;
      state.caught_up=!decoded.has_more_possible;
    }else state.caught_up=true;
    state.last_success_ms=Date.now();state.last_error=null;
  }catch(error){
    state.last_error=err(error);
    state.caught_up=false;state.failure_count=(state.failure_count||0)+1;
  }
  await storage.put(stateKey,state);
  return {source,cursor:state.cursor,records_archived:state.records_archived,
    chunks_archived:state.chunks_archived,last_error:state.last_error,
    caught_up:state.caught_up,success:state.last_error===null};
}
export async function runLegacyBackfill(env,storage){
  if(env.AUTO_LEGACY_BACKFILL!=='true')return {ok:true,enabled:false,archival_only:true};
  const results=[];
  // Three bounded indexed SQL reads / 5m, up to 300 rows total.
  for(const source of LEGACY_SOURCES)results.push(await backfillOneLegacySource(env,storage,source));
  return {ok:results.every(x=>x.success),enabled:true,archival_only:true,
    live_ledger_merge:false,source_rows_deleted:false,
    results,checked_at_ms:Date.now()};
}
export async function legacyBackfillHealth(env,storage){
  const sources=[];
  for(const source of LEGACY_SOURCES){
    const state=await storage.get('legacy-backfill:'+source);
    sources.push({source,cursor:state?.cursor||0,records_archived:state?.records_archived||0,
      chunks_archived:state?.chunks_archived||0,caught_up:Boolean(state?.caught_up),
      last_success_ms:state?.last_success_ms||0,
      last_attempt_ms:state?.last_attempt_ms||0,
      last_error:state?.last_error||null,
      failure_count:state?.failure_count||0});
  }
  return {ok:true,enabled:env.AUTO_LEGACY_BACKFILL==='true',
    schema:'lumex_legacy_archive_v1',source:'WordPress historical public-market tables',
    archive_prefix:PREFIX,immutable_source_records:true,live_ledger_merge:false,
    wordpress_data_deleted:false,source_rows_retention_days:35,
    disclaimer:'Original WordPress market observations are stored separately for audit. They are NOT added to live liquidation totals.',
    sources};
}
