import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const raw=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
 .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}');
const {default:worker}=await import('data:text/javascript;base64,'+Buffer.from(raw).toString('base64'));
let calls=0;
const env={AUTO_WHALE_FETCH:'true',AUTO_LEGACY_BACKFILL:'false',AUTO_LIVE_STREAM:'false',
 AUTO_RESEARCH:'false',AUTO_AI:'false',AUTO_FETCH:'false',
 AUTO_MARKET_QA_DAILY:'false',AUTO_DERIVATIVES_FETCH:'false',
 AUTO_PUBLIC_PULSE_FETCH:'false',AUTO_OI_MIRROR_FETCH:'false',
 BTC_RESERVE_COLLECTOR:{getByName(name){
   assert.equal(name,'reserve-btc');
   return {fetch:async url=>{assert.equal(url,'https://whales/poll');calls++;return new Response('{"ok":true}')}}
 }}};
async function scheduled(cron){
 const pending=[];await worker.scheduled({cron,scheduledTime:Date.now()},env,{waitUntil:p=>pending.push(p)});
 await Promise.all(pending);
}
await scheduled('* * * * *');
assert.equal(calls,1,'one Cloudflare minute tick triggers one BTC poll');
await scheduled('*/5 * * * *');
assert.equal(calls,1,'five-minute tick must not duplicate BTC poll');
assert(raw.includes('for(let i=0;i<16;i++)'),'bounded 1600 row legacy archive migration cap');
assert(raw.includes("prefix:PREFIX+'liquidations/',limit:32"),'archive indexing must keep pace');
console.log('PASS 1-minute Cloudflare BTC poll with no 5m duplicate, bounded legacy migration');
