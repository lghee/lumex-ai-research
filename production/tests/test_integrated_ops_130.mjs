import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const raw=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
  .replace("import { DurableObject } from 'cloudflare:workers';",
    'class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}');
const {default:worker,marketOpsDaily,marketOpsHistory,marketOpsReadiness}=
 await import('data:text/javascript;base64,'+Buffer.from(raw).toString('base64'));
const token='p'.repeat(64),store=new Map(),writes=[];
let reads=0;
const r2={
 async head(key){reads++;return store.has(key)?{size:store.get(key).length}:null;},
 async get(key){reads++;return store.has(key)?{json:async()=>JSON.parse(store.get(key)),text:async()=>store.get(key)}:null;},
 async put(key,value){writes.push(key);store.set(key,String(value));},
 async list({prefix,limit}){reads++;assert.equal(limit,1);return {objects:[]}}
};
const env={MARKET_DATA:r2,LUMEX_AI_LAB_WORKER_TOKEN:token,
 AUTO_MARKET_QA_DAILY:'false',AUTO_PUBLIC_PULSE_FETCH:'false',
 AUTO_OI_MIRROR_FETCH:'false',AUTO_DERIVATIVES_FETCH:'false',
 AUTO_LIVE_STREAM:'false',AUTO_BINANCE_LIQUIDATIONS:'false',
 AUTO_WHALE_FETCH:'false',AUTO_LEGACY_BACKFILL:'false'};
const before=await worker.fetch(new Request('https://worker/market-hub/v1/release-readiness'),env);
assert.equal(before.status,401,'Bearer must block all readiness reads');
assert.equal(reads,0);
const noAuthHistory=await worker.fetch(new Request('https://worker/market-hub/v1/quality-history'),env);
assert.equal(noAuthHistory.status,401);
const readiness=await (await worker.fetch(new Request('https://worker/market-hub/v1/release-readiness',
 {headers:{authorization:'Bearer '+token}}),env)).json();
assert.equal(readiness.schema,'lumex_market_ops_readiness_v1');
assert.equal(readiness.worker_version,'1.3.1');
assert.equal(readiness.checks.length,8);
assert.equal(readiness.release_ready,false);
assert.equal(readiness.safe_to_disable_wordpress_crons,false);
assert.equal(readiness.complete_market_capture,false);
assert.equal(readiness.archive_merged,false);
assert.equal(readiness.manual_rollout_required,true);
assert.equal(readiness.r2_summary.list_checks,12);
assert.equal(writes.length,0,'readiness is read-only');
const disabled=await marketOpsDaily(env);
assert.equal(disabled.disabled,true);
assert.equal(writes.length,0,'daily job is explicitly OFF by default');
env.AUTO_MARKET_QA_DAILY='true';
const now=Date.now(),date=new Date(now).toISOString().slice(0,10);
const first=await marketOpsDaily(env,now);
assert.deepEqual(first,{ok:true,saved:true,date});
const archive='market-hub/ops/v1/daily/'+date.replaceAll('-','')+'.json';
assert(store.has(archive));
assert(store.has('market-hub/ops/v1/latest.json'));
assert.equal(writes.length,2,'immutable daily then latest after readback');
const daily=JSON.parse(store.get(archive));
assert.equal(daily.schema,'lumex_ops_daily_v1');
assert.equal(daily.check_status.length,8);
assert.equal(daily.complete_market_capture,false);
assert.equal(daily.safe_to_disable_wordpress_crons,false);
const second=await marketOpsDaily(env,now+1000);
assert.equal(second.already_saved,true);
assert.equal(writes.length,2,'second Cron must not duplicate R2');
const history=await marketOpsHistory(env,now);
assert.equal(history.schema,'lumex_market_ops_history_v1');
assert.equal(history.items.length,7);
assert.equal(history.items.at(-1).date,date);
assert.equal(history.items.at(-1).status,'recorded');
assert.equal(history.incomplete_days,6);
const viaHttp=await (await worker.fetch(new Request('https://worker/market-hub/v1/quality-history',
 {headers:{authorization:'Bearer '+token}}),env)).json();
assert.equal(viaHttp.items.length,7);
assert.equal(viaHttp.safe_to_disable_wordpress_crons,false);
const original=store.get(archive);
store.set(archive,JSON.stringify({schema:'wrong',date}));
const tainted=await marketOpsHistory(env,now);
assert.equal(tainted.items.at(-1).status,'missing','corrupt/mismatched history is never healthy');
store.set(archive,original);
const health=await (await worker.fetch(new Request('https://worker/market-hub/v1/health'),env)).json();
assert.equal(health.version,'1.3.1');
console.log('PASS 1.3.1 integrated ops: 8 gates, Bearer-protected one-call readiness, disabled-by-default daily R2, readback + idempotent archive, 7day history and tamper refusal');
