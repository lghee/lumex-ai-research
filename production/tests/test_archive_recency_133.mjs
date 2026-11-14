import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const raw=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
 .replace("import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}');
const {default:worker}=await import('data:text/javascript;base64,'+Buffer.from(raw).toString('base64'));
const now=Date.now(),hour=new Date(now).toISOString().slice(0,13).replaceAll('-','/');
let missing=false,failRead=false,listed=0,read=0;
const source={async list({prefix,limit}){
  listed++;assert.equal(limit,1);assert(prefix.startsWith('market-hub/events/'));
  if(missing||!prefix.includes(hour))return {objects:[]};
  return {objects:[{key:prefix+'newest.jsonl',size:200}]};
 },async get(key){
  read++;if(failRead)return null;
  const liq=key.includes('/liquidation/');
  const event={kind:liq?'liquidation':'whale_transfer',
    source:liq?'bybit':'blockstream',symbol:'BTCUSDT',ts:now-1000,
    id:liq?'bybit:liq:BTCUSDT:'+'a'.repeat(32):'btc:addressflow:'+'b'.repeat(64)+':abc'};
  return {text:async()=>JSON.stringify(event)+'\n'};
 }};
const env={MARKET_DATA:source};
const request=()=>worker.fetch(new Request('https://worker/market-hub/v1/archive-health'),env);
let r=await request(),j=await r.json();
assert.equal(r.status,200);assert.equal(j.ok,true);
assert.equal(j.schema,'lumex_archive_recent_health_v2');assert.equal(j.window_hours,6);
assert.equal(j.list_checks,12);assert.equal(listed,12);assert.equal(read,2);
assert.equal(j.kinds.liquidation.sample_verified,true);
assert.equal(j.kinds.whale_transfer.sample_verified,true);
assert.equal(j.recent_liquidation_sample_verified,true);
assert.equal(j.recent_whale_sample_verified,true);
assert(j.kinds.liquidation.last_observed_hour_unix>Math.floor(now/1000)-3600);
assert.equal(j.complete_market_capture,false);assert.equal(j.safe_to_disable_wordpress_crons,false);
assert.equal(j.sample_not_total,true);
assert.equal(j.most_recent_modified_ms,undefined,'never claim first 25 R2 objects show latest');
assert(!JSON.stringify(j).includes('newest.jsonl'),'do not expose R2 key names');
missing=true;r=await request();j=await r.json();
assert.equal(j.ok,true,'quiet observation period is not necessarily a read failure');
assert.equal(j.kinds.liquidation.sample_verified,false);
assert.equal(j.kinds.whale_transfer.reason,'no_recent_archived_observation');
missing=false;failRead=true;
r=await request();j=await r.json();
assert.equal(j.kinds.liquidation.sample_verified,false);
assert.equal(j.kinds.liquidation.reason,'r2_sample_invalid_or_unreadable');
r=await worker.fetch(new Request('https://worker/market-hub/v1/archive-health'),{});
j=await r.json();assert.equal(j.ok,false);assert.equal(j.kinds.liquidation.reason,'r2_binding_missing');
console.log('PASS 1.3.1 archive health: 12 bounded UTC-hour scans, 2 actual JSONL readbacks, stale-prefix bug removed, no completeness/cron claims');
